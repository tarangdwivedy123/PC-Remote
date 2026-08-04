import { build } from 'esbuild';

import { rimrafRetry } from '../scripts/rimraf-retry.mjs';

/**
 * Bundles the agent into a single .mjs file so it can be dropped onto a PC with
 * nothing but a Node runtime — no node_modules to copy, no npm install.
 *
 * Output stays ESM rather than CJS so `import.meta.url` (used to locate the
 * built client and the vendor binaries) keeps working. The banner installs a
 * CommonJS `require` shim, which the dependencies that still resolve modules at
 * runtime — systeminformation being the notable one — need in an ESM context.
 */

// Retrying delete: OneDrive holds handles on the previous build's output.
await rimrafRetry(new URL('./dist/', import.meta.url));

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/agent.mjs',
  bundle: true,
  platform: 'node',
  // Matches the >=20 engine floor in package.json.
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false, // Readable stack traces matter more than a smaller file here.
  logLevel: 'info',
  metafile: true,
  banner: {
    js: [
      "import { createRequire as __pcrCreateRequire } from 'node:module';",
      "import { dirname as __pcrDirname } from 'node:path';",
      "import { fileURLToPath as __pcrFileURLToPath } from 'node:url';",
      'const require = __pcrCreateRequire(import.meta.url);',
      'const __filename = __pcrFileURLToPath(import.meta.url);',
      'const __dirname = __pcrDirname(__filename);',
    ].join('\n'),
  },
});

const outputs = Object.entries(result.metafile.outputs)
  .filter(([file]) => file.endsWith('.mjs'))
  .map(([file, meta]) => `${file} (${(meta.bytes / 1024).toFixed(0)} KB)`);

console.log(`\nagent bundled: ${outputs.join(', ')}`);
console.log('run it with:  node agent/dist/agent.mjs\n');
