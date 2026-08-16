import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Builds the shippable artifacts: a single self-contained PCRemote.exe, and the
 * Windows installer that wraps it.
 *
 * The exe is a Node "single executable application" — a copy of node.exe with
 * the bundled agent and the built web client injected into it. One file, no
 * runtime to install first, nothing loose to go missing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'release');
const work = path.join(out, 'build');

const step = (msg) => console.log(`\n\u001b[36m>\u001b[0m ${msg}`);
const done = (msg) => console.log(`  \u001b[32m\u2713\u001b[0m ${msg}`);

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// -- 1. bundle the agent as CommonJS ----------------------------------------

/**
 * A second bundle rather than a reuse of dist/agent.mjs, because SEA accepts
 * only a CommonJS entry point. The normal build stays ESM: that is what runs
 * during development, and changing it to suit the packager would trade a daily
 * concern for an occasional one.
 */
step('bundling the agent (CommonJS, for the packager)');
const entry = path.join(work, 'agent.cjs');
await build({
  entryPoints: [path.join(root, 'agent', 'src', 'index.ts')],
  outfile: entry,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
  define: {
    // `import.meta.url` has no meaning in CJS. The banner below supplies an
    // equivalent so the modules that use it to locate files keep working.
    'import.meta.url': '__pcrMetaUrl',
  },
  banner: {
    js: 'const __pcrMetaUrl = require("node:url").pathToFileURL(__filename).href;',
  },
});
done(`agent.cjs (${(fs.statSync(entry).size / 1024).toFixed(0)} KB)`);

// -- 2. collect the client as embedded assets -------------------------------

step('collecting the web client');
const clientDist = path.join(root, 'client', 'dist');
if (!fs.existsSync(path.join(clientDist, 'index.html'))) {
  throw new Error(`no built client at ${clientDist} — run "npm run build" first`);
}

const assets = {};
const manifest = [];
const walk = (dir, prefix = '') => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(full).isDirectory()) walk(full, key);
    else {
      assets[key] = full;
      manifest.push(key);
    }
  }
};
walk(clientDist);

const manifestPath = path.join(work, 'client-manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
assets['client-manifest.json'] = manifestPath;

// Deliberately outside the manifest: the tray reads it straight from the blob
// rather than from the unpacked client directory, which is served over HTTP.
assets['pcremote.ico'] = path.join(root, 'installer', 'pcremote.ico');
done(`${manifest.length} client files + icon embedded`);

// -- 3. build the SEA blob ---------------------------------------------------

step('building the executable');
const seaConfig = path.join(work, 'sea-config.json');
const blob = path.join(work, 'agent.blob');
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: entry,
      output: blob,
      disableExperimentalSEAWarning: true,
      // Faster startup at the cost of a larger binary, which for a background
      // app that launches at boot is the right side of that trade.
      useCodeCache: true,
      assets,
    },
    null,
    2,
  ),
  'utf8',
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exe = path.join(out, 'PCRemote.exe');
fs.copyFileSync(process.execPath, exe);

/**
 * Strips the Authenticode signature from the copied node.exe.
 *
 * The signature covers bytes the injection is about to change, so leaving it in
 * place produces a binary Windows reports as *corrupt* — which SmartScreen and
 * antivirus treat far more harshly than one that is merely unsigned.
 *
 * signtool would do this, but it only ships with the Windows SDK, and requiring
 * a multi-gigabyte SDK install to build a 90 MB exe is a poor trade. The
 * signature lives in its own PE data directory and is always the last thing in
 * the file, so removing it is: clear the directory entry, truncate.
 */
function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const peAt = buf.readUInt32LE(0x3c);
  if (buf.toString('ascii', peAt, peAt + 4) !== 'PE\0\0') return 'not a PE file';

  const optAt = peAt + 4 + 20;
  const magic = buf.readUInt16LE(optAt);
  // The data directory array sits at a different offset in the two optional
  // header layouts, because PE32+ widens several fields above it to 64 bits.
  const dirAt = optAt + (magic === 0x20b ? 112 : 96);
  const certAt = dirAt + 4 * 8; // entry 4 is IMAGE_DIRECTORY_ENTRY_SECURITY

  const offset = buf.readUInt32LE(certAt);
  const size = buf.readUInt32LE(certAt + 4);
  if (offset === 0 || size === 0) return 'already unsigned';
  if (offset + size !== buf.length) {
    // Anything else means the layout is not what is assumed here, and guessing
    // with a truncation would corrupt the binary outright.
    return `signature is not at the end of the file (${offset}+${size} vs ${buf.length}) — left alone`;
  }

  buf.writeUInt32LE(0, certAt);
  buf.writeUInt32LE(0, certAt + 4);
  fs.writeFileSync(file, buf.subarray(0, offset));
  return `removed ${(size / 1024).toFixed(0)} KB signature`;
}
done(stripSignature(exe));

const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' },
);
done(`PCRemote.exe (${(fs.statSync(exe).size / 1024 / 1024).toFixed(0)} MB)`);

// -- 4. give it its own name and icon ----------------------------------------

/**
 * Until this runs the binary is still node.exe as far as Windows is concerned.
 * That matters most at the firewall prompt, which otherwise asks the user to
 * allow "Node.js JavaScript Runtime" onto the network — a name with no
 * connection to anything they chose to install, which is exactly the shape of a
 * prompt people learn to click Cancel on.
 *
 * Runs before the subsystem patch: writing resources rewrites PE headers.
 */
step('setting the name, version and icon');
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'scripts', 'set-exe-metadata.ps1'),
    '-Exe',
    exe,
    '-IconPath',
    path.join(root, 'installer', 'pcremote.ico'),
    '-Version',
    version,
  ],
  { stdio: 'inherit' },
);

// -- 5. hide the console window ---------------------------------------------

/**
 * node.exe is a console-subsystem binary, so launching it pops a black window
 * that stays for the life of the app. There is no flag for this — the subsystem
 * is a field in the PE header, so flip it there. The app's interface is the tray
 * icon and the phone; a console would only be something to accidentally close.
 */
step('switching the executable to windowed mode');
const pe = fs.readFileSync(exe);
const peOffset = pe.readUInt32LE(0x3c);
if (pe.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
  throw new Error('not a PE executable — refusing to patch');
}
// COFF header is 20 bytes; Subsystem sits 68 bytes into the optional header.
const subsystemOffset = peOffset + 4 + 20 + 68;
const before = pe.readUInt16LE(subsystemOffset);
if (before !== 3 && before !== 2) {
  throw new Error(`unexpected PE subsystem ${before} — refusing to patch`);
}
pe.writeUInt16LE(2, subsystemOffset); // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
fs.writeFileSync(exe, pe);
done(`subsystem ${before} (console) -> 2 (windows)`);

// -- 6. the installer --------------------------------------------------------

// winget installs Inno Setup per-user by default, so Program Files is only one
// of the places it can be.
const iscc = [
  process.env['ISCC'],
  path.join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
].find((p) => p && fs.existsSync(p));

if (!iscc) {
  console.log('\n  Inno Setup not found — built the portable exe only.');
} else {
  step('building the installer');
  execFileSync(iscc, [path.join(root, 'installer', 'PCRemote.iss'), `/DAppVersion=${version}`], {
    stdio: 'inherit',
    cwd: root,
  });
  done('installer built');
}

fs.rmSync(work, { recursive: true, force: true });

console.log('\n\u001b[32mRelease artifacts:\u001b[0m');
for (const name of fs.readdirSync(out)) {
  const size = fs.statSync(path.join(out, name)).size;
  console.log(`  ${name}  (${(size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log('');
