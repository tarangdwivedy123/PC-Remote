import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO_ROOT, createChecker, startAgent, tempDataDir } from './lib.mjs';

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

    // -- launching it twice, and launching it at all -------------------------

    /**
     * The bug this covers: with a device already paired, installing and running
     * the app produced nothing on screen at all. The window only appeared when
     * no device had ever paired, and a second launch died on the port bind with
     * no console to report it. Clicking the app did nothing, for good.
     */
    const index = read('agent/src/index.ts');
    check(
      'only an autostart launch is allowed to be silent',
      /args\.startup && config\.current\.tokens\.length > 0/.test(index),
    );
    check(
      'a second launch surfaces the running copy before anything binds',
      index.indexOf('surfaceExistingInstance') < index.indexOf('startServer({'),
    );

    const single = read('agent/src/singleton.ts');
    check(
      'a stranger on the port is not mistaken for our own instance',
      single.includes("body.name === 'pc-remote'"),
    );
    check('the probe cannot hang startup', single.includes('AbortSignal.timeout'));

    const cli = read('agent/src/cli.ts');
    check('the --startup flag is parsed', cli.includes("case '--startup':"));
    check(
      'the installer passes --startup on the autostart entry',
      iss.includes('--startup'),
    );

    const fatal = read('agent/src/fatal.ts');
    check(
      'a fatal error is only shown as a dialog once packaged',
      /if \(!isPackaged\(\)[\s\S]{0,80}return;/.test(fatal),
    );
    check('the error log is capped so it cannot grow without bound', fatal.includes('256 * 1024'));

    // -- the app can never be invisible --------------------------------------

    /**
     * The failure this guards against: the tray is a separate WinForms process,
     * and when it died the agent kept running and serving with no icon and no
     * window. Reachable, working, and completely invisible — which from the
     * outside is the same as an app that will not start.
     */
    const tray = read('agent/src/tray/index.ts');
    check('a crashed tray is restarted', tray.includes('tray died unexpectedly'));
    check(
      'restarts are bounded rather than looping forever',
      /#restarts >= 3/.test(tray),
    );
    check(
      'a deliberate Quit is not treated as a crash',
      tray.includes('#userQuit'),
    );
    check(
      'show() reports whether it actually reached a tray',
      /show\(\): boolean/.test(tray),
    );
    check('tray failures are written somewhere findable', tray.includes('tray.log'));

    const idx2 = read('agent/src/index.ts');
    check(
      'a missing tray falls back to the browser instead of doing nothing',
      /!tray\.available \|\| !tray\.show\(\)/.test(idx2) && idx2.includes('openPairPage'),
    );
    check(
      'the same fallback covers a second launch',
      /trayRef\?\.show\(\) !== true/.test(idx2),
    );

    /**
     * The pairing page carries the single-use code, so serving it to the LAN
     * would let anyone who can reach the port pair themselves. Verified live
     * further down as well.
     */
    const server = read('agent/src/server.ts');
    check(
      'the pairing page is loopback-only',
      /app\.get\('\/pair'[\s\S]{0,200}isLoopback/.test(server),
    );
    const pairpage = read('agent/src/pairpage.ts');
    check('the pairing page escapes the values it interpolates', pairpage.includes('escapeHtml'));
    check('the QR is drawn as scalable SVG, not a bitmap', pairpage.includes('shape-rendering="crispEdges"'));

    // -- the public-network trap ---------------------------------------------

    /**
     * The failure that looked like a hang: Windows classifies most networks
     * Public by default, the installer's firewall rule covers Private and Domain
     * only, so the phone's packets were dropped before reaching the agent. The
     * app was healthy and completely unreachable.
     *
     * The remedy must never be to widen the firewall to Public -- being
     * unreachable on an untrusted network is the guarantee this project rests
     * on -- so these checks pin both the detection and the advice.
     */
    const net = read('agent/src/net.ts');
    check('the network category is detected', net.includes('NetworkCategory'));
    check(
      'the category is matched to the interface serving the phone',
      net.includes('Get-NetIPAddress') && net.includes('InterfaceAlias'),
    );
    check(
      'the address is validated before reaching a command line',
      net.includes('.test(lanIp) ? lanIp') && net.includes('safeIp'),
    );
    check(
      'an unknown category is not reported as blocked',
      net.includes("known.includes(category) ? category : ''"),
    );

    const pp = read('agent/src/pairpage.ts');
    check('a public network is explained rather than left as a hang', pp.includes('Windows is blocking your phone'));
    check(
      'the advice is to reclassify the network, not to open the firewall',
      pp.includes('Private network') && !/profile=.*public/i.test(pp),
    );
    check('the advice warns against doing it on an untrusted network', pp.includes('network you trust'));

    const idx3 = read('agent/src/index.ts');
    check(
      'a blocked network opens the explanation instead of an unusable QR window',
      /networkCategory === 'Public'/.test(idx3),
    );

    check('the page offers to fix it rather than only describing the fix', pp.includes('Fix this for me'));
    check(
      'fixing it raises a UAC prompt rather than acting silently',
      net.includes('-Verb RunAs'),
    );
    check(
      'the fix reclassifies the network and never touches the firewall',
      net.includes('Set-NetConnectionProfile') && !net.includes('advfirewall'),
    );
    check(
      'the fix endpoint is loopback-only',
      /app\.post\('\/api\/fix-network'[\s\S]{0,200}isLoopback/.test(server),
    );

    /**
     * A DHCP renewal hands out a new address, and the QR is generated once at
     * startup. Without this the code silently points at an address the PC no
     * longer has, which looks exactly like the app being broken.
     */
    check(
      'the QR is refreshed when the LAN address changes',
      idx3.includes('LAN address changed') && idx3.includes('tray.update'),
    );
    check(
      'a pinned address is left alone by the watcher',
      /PCR_LAN_IP'\]\) return;/.test(idx3),
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

    /**
     * /api/show puts a window on the user's screen and takes no token, so
     * loopback-only is the entire protection. Verified against a running agent
     * rather than by reading the source: this is the kind of boundary that a
     * refactor breaks quietly.
     */
    const dataDir = tempDataDir('m9-show');
    const agent = await startAgent({ port: 8829, dataDir });
    try {
      const local = await fetch('http://127.0.0.1:8829/api/show', { method: 'POST' });
      check('the show endpoint answers on loopback', local.status === 200, `HTTP ${local.status}`);

      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((a) => a && !a.internal && (a.family === 'IPv4' || (a.family as unknown as number) === 4))
        ?.address;

      const pair = await fetch('http://127.0.0.1:8829/pair');
      const html = await pair.text();
      check('the pairing page renders on loopback', pair.status === 200, `HTTP ${pair.status}`);
      check('the pairing page contains a QR', html.includes('<svg'));

      if (lan) {
        const remote = await fetch(`http://${lan}:8829/api/show`, { method: 'POST' });
        check(
          'the show endpoint refuses a request from the network',
          remote.status === 403,
          `${lan} -> HTTP ${remote.status}`,
        );
        const remotePair = await fetch(`http://${lan}:8829/pair`);
        check(
          'the pairing page refuses the network, since it holds the pairing code',
          remotePair.status === 403,
          `${lan} -> HTTP ${remotePair.status}`,
        );
      }
    } finally {
      await agent.stop();
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
