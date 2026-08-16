import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, createChecker } from './lib.mjs';

/**
 * Checks on the shippable artifacts and the things that make them a product
 * rather than a script: the installer's firewall scope, the executable's
 * identity, and the download links on the site.
 *
 * The heavy checks only run when release/ exists, so `npm run verify` stays fast
 * for someone who has not built a release.
 */

const root = REPO_ROOT;
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

export async function run() {
  const { check, results } = createChecker('Packaging — installer, executable identity, download page');
  {
    // -- the installer -------------------------------------------------------

    const iss = read('installer/PCRemote.iss');

    /**
     * The single most important line in the installer. This app is LAN-only by
     * design, and a firewall rule that included the public profile would make it
     * reachable on café and airport Wi-Fi — quietly undoing the guarantee the
     * whole design rests on.
     */
    const rule = /profile=([a-z,]+)/.exec(iss)?.[1] ?? '';
    check(
      'the firewall rule covers private and domain networks only',
      rule === 'private,domain',
      rule,
    );
    check('the firewall rule never mentions the public profile', !/profile=[a-z,]*public/.test(iss));
    check(
      'the rule is scoped to one port rather than the whole program',
      iss.includes('localport=8765') && iss.includes('protocol=tcp'),
    );
    check('uninstalling removes the firewall rule', iss.includes('advfirewall firewall delete rule'));

    check(
      'autostart is written as the original user, not the elevating admin',
      /reg\.exe[\s\S]{0,400}?runasoriginaluser/.test(iss),
    );
    check('autostart is opt-out, offered as a task', iss.includes('Name: "startup"'));
    check('the running app is stopped before install and uninstall', iss.includes('taskkill.exe'));
    check(
      'uninstall asks before deleting pairings rather than assuming',
      iss.includes('MB_YESNO') && iss.includes('pc-remote'),
    );

    /**
     * The download button on the site points at a fixed filename via GitHub's
     * "latest" route, so a version in the installer name would break it on every
     * release.
     */
    check(
      'the installer filename carries no version',
      /OutputBaseFilename=PCRemote-Setup\s*$/m.test(iss),
    );

    // -- the build pipeline --------------------------------------------------

    const dist = read('scripts/dist.mjs');
    check('the packaged bundle is CommonJS, which is all SEA accepts', dist.includes("format: 'cjs'"));
    check('the signature is stripped before injection', dist.indexOf('stripSignature') < dist.indexOf('postject'));
    check(
      'the console window is suppressed via the PE subsystem',
      dist.includes('IMAGE_SUBSYSTEM_WINDOWS_GUI'),
    );
    check(
      'resources are rewritten before the subsystem patch',
      dist.indexOf('set-exe-metadata') < dist.indexOf('subsystemOffset'),
    );

    const meta = read('scripts/set-exe-metadata.ps1');
    check(
      'existing resources are preserved, or the injected app would be erased',
      meta.includes('BeginUpdateResource(exe, false)'),
    );
    check('the version block declares the UTF-16 codepage', meta.includes('040904B0'));

    // -- the client is reachable inside the packaged exe ---------------------

    const packaged = read('agent/src/packaged.ts');
    check('asset paths are checked for traversal before being written', packaged.includes('startsWith(dir + path.sep)'));
    check(
      'a completed extraction is marked, so a partial one is not reused',
      packaged.includes('.complete'),
    );
    check(
      'the unpack directory changes when the client changes',
      packaged.includes('createHash') && packaged.includes('AGENT_VERSION'),
    );
    check(
      'failing to unpack falls back rather than crashing',
      /return undefined;/.test(packaged) && packaged.includes('catch'),
    );

    // -- the download page ---------------------------------------------------

    const page = read('docs/index.html');
    check(
      'the main button downloads the installer from the latest release',
      page.includes('/releases/latest/download/PCRemote-Setup.exe'),
    );
    check(
      'the portable build is offered as a secondary link',
      page.includes('/releases/latest/download/PCRemote.exe'),
    );
    check('the page makes no external requests', !/(src|href)="https?:\/\/(?!github\.com)/.test(page));
    check('the SmartScreen warning is explained rather than left as a surprise', /More info/.test(page));
    check('the page states that nothing leaves the network', /nothing leaves your Wi-Fi/i.test(page));
    check('the page renders in both colour schemes', page.includes('prefers-color-scheme'));

    // -- built artifacts, when present ---------------------------------------

    const exe = path.join(root, 'release', 'PCRemote.exe');
    if (!fs.existsSync(exe)) {
      console.log('    (release/ not built — skipping artifact checks; run "npm run dist")');
      return { results };
    }

    const buf = fs.readFileSync(exe);
    const peAt = buf.readUInt32LE(0x3c);
    const optAt = peAt + 4 + 20;
    const magic = buf.readUInt16LE(optAt);
    check(
      'the executable opens no console window',
      buf.readUInt16LE(peAt + 4 + 20 + 68) === 2,
      `subsystem ${buf.readUInt16LE(peAt + 4 + 20 + 68)}`,
    );

    const certAt = optAt + (magic === 0x20b ? 112 : 96) + 4 * 8;
    check(
      'no corrupt leftover signature',
      buf.readUInt32LE(certAt) === 0 && buf.readUInt32LE(certAt + 4) === 0,
    );

    if (process.platform === 'win32') {
      const info = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$i=[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${exe.replace(/'/g, "''")}');` +
            `Write-Output ($i.FileDescription + '|' + $i.ProductName)`,
        ],
        { encoding: 'utf8' },
      ).trim();

      /**
       * The firewall prompt shows FileDescription. Left unset it reads "Node.js
       * JavaScript Runtime", asking the user to make a security decision about a
       * program they have never heard of.
       */
      check('the executable identifies itself as PC Remote', info.startsWith('PC Remote|'), info);
      check('no trace of the Node runtime in its identity', !/node/i.test(info), info);
    }

    const setup = path.join(root, 'release', 'PCRemote-Setup.exe');
    check('the installer is built alongside the portable exe', fs.existsSync(setup));
    if (fs.existsSync(setup)) {
      const mb = fs.statSync(setup).size / 1024 / 1024;
      check('the installer is a plausible size', mb > 15 && mb < 60, `${mb.toFixed(1)} MB`);
    }
  }

  return { results };
}
