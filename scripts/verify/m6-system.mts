import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

import WebSocket from 'ws';

import { REPO_ROOT, createChecker, startAgent, stripComments, tempDataDir } from './lib.mjs';

/**
 * Milestone 6: system actions, PWA install, keep-awake.
 *
 * The agent under test runs with `PCR_SYSTEM_DRY_RUN=1`, so lock/sleep/shutdown
 * are logged rather than performed. Without it this suite would suspend or power
 * off the machine running it, which is not a test that can be said to pass.
 * Everything up to the final API call is exercised for real: validation, the
 * confirm-token gate, routing, and the ack.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 6 — system, PWA, keep-awake');

  // -- no shell execution surface ------------------------------------------

  const systemSource = readFileSync(path.join(REPO_ROOT, 'agent/src/system/index.ts'), 'utf8');
  /**
   * The brief asks for these five actions and "no other shell execution
   * surface". execFile with a literal argument array is the difference between
   * five fixed actions and a way to run arbitrary things.
   */
  check('shutdown uses execFile, never exec or a shell', /execFile\(/.test(systemSource) && !/\bexec\(/.test(systemSource) && !/shell:\s*true/.test(systemSource));
  check(
    'the shutdown arguments are literal constants',
    /\['\/s', '\/t', '0'\]/.test(systemSource) && /\['\/r', '\/t', '0'\]/.test(systemSource),
  );
  check(
    'nothing from a client frame reaches a command line',
    !/\$\{[^}]*command[^}]*\}/.test(systemSource) && !/args\.push/.test(systemSource),
  );
  /**
   * /f would force applications closed. A mis-tap on a phone should not be able
   * to discard someone's unsaved work.
   */
  check('shutdown does not force-close applications', !/'\/f'/.test(systemSource));

  const hostScript = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  check('lock, sleep and display-off go through the interop host', /SystemActions/.test(hostScript));
  check(
    'sleep asks to suspend, not hibernate',
    /SetSuspendState\(false, false, false\)/.test(hostScript),
    'rundll32 SetSuspendState is famous for hibernating instead',
  );
  check('the display-off broadcast is bounded by a timeout', /SMTO_ABORTIFHUNG/.test(hostScript));

  // -- PWA -----------------------------------------------------------------

  const manifestPath = path.join(REPO_ROOT, 'client/public/manifest.webmanifest');
  check('a web app manifest exists', existsSync(manifestPath));
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    check('the manifest declares a name and short name', typeof manifest.name === 'string' && typeof manifest.short_name === 'string');
    /**
     * Without display:standalone, "Add to Home screen" produces a bookmark that
     * opens in a browser tab with all the chrome, rather than an app.
     */
    /**
     * fullscreen rather than standalone: this is a dashboard propped on a desk,
     * so even the status bar is wasted space. Browsers that do not support it
     * fall back to standalone on their own.
     */
    check('the manifest asks for a fullscreen display', manifest.display === 'fullscreen', manifest.display);
    check('the manifest starts at the root', manifest.start_url === '/');
    /**
     * Never "portrait". An installed PWA obeys this, so locking it meant the app
     * physically would not rotate — which defeats the landscape layout below.
     */
    check(
      'the manifest does not lock orientation',
      manifest.orientation === undefined || manifest.orientation === 'any',
      String(manifest.orientation),
    );
    check('the manifest theme matches the AMOLED shell', manifest.theme_color === '#000000' && manifest.background_color === '#000000');

    const sizes = (manifest.icons ?? []).map((i: { sizes: string }) => i.sizes);
    check('the manifest offers 192 and 512 icons', sizes.includes('192x192') && sizes.includes('512x512'), sizes.join(', '));
    check(
      'icons are declared maskable so launchers can crop them',
      (manifest.icons ?? []).every((i: { purpose?: string }) => (i.purpose ?? '').includes('maskable')),
    );
  }

  for (const size of [192, 512]) {
    const file = path.join(REPO_ROOT, `client/public/icon-${size}.png`);
    if (!existsSync(file)) {
      check(`icon-${size}.png exists`, false);
      continue;
    }
    const bytes = readFileSync(file);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    check(
      `icon-${size}.png is a real ${size}x${size} PNG`,
      bytes.subarray(0, 8).equals(signature) && width === size && height === size,
      `${width}x${height}`,
    );
    /**
     * Decoding it proves the hand-written encoder produced something a browser
     * can actually read, rather than a file that merely starts with the right
     * magic bytes.
     */
    let decodable = false;
    try {
      const idatStart = bytes.indexOf(Buffer.from('IDAT', 'ascii'));
      const length = bytes.readUInt32BE(idatStart - 4);
      const raw = inflateSync(bytes.subarray(idatStart + 4, idatStart + 4 + length));
      // width*4 bytes per row plus one filter byte each.
      decodable = raw.length === (size * 4 + 1) * size;
    } catch {
      decodable = false;
    }
    check(`icon-${size}.png decompresses to the expected pixel count`, decodable);
  }

  const html = readFileSync(path.join(REPO_ROOT, 'client/index.html'), 'utf8');
  check('index.html links the manifest', /<link rel="manifest" href="\/manifest\.webmanifest"/.test(html));
  check('index.html provides an apple-touch-icon', /apple-touch-icon/.test(html));
  /**
   * Deliberate: a service worker would satisfy Chrome's automatic install prompt
   * but the only thing it could cache is the app shell, and a stale shell after
   * an agent upgrade is a nasty thing to debug. Manual "Add to Home screen"
   * needs only the manifest.
   */
  check('no service worker is registered', !/serviceWorker/.test(html) && !existsSync(path.join(REPO_ROOT, 'client/public/sw.js')));


  // -- fullscreen without installing ---------------------------------------

  const fullscreen = readFileSync(path.join(REPO_ROOT, 'client/src/components/FullscreenButton.tsx'), 'utf8');
  /**
   * "Add to Home screen" only helps once installed and launched from the home
   * screen. The Fullscreen API works in an ordinary tab, immediately.
   */
  check('a fullscreen control exists for use in a plain browser tab', /requestFullscreen/.test(fullscreen));
  check(
    'the webkit-prefixed names are tried too',
    /webkitRequestFullscreen/.test(fullscreen) && /webkitExitFullscreen/.test(fullscreen),
    'Chrome ~70 on Android has only the prefixed forms',
  );
  /**
   * Leaving fullscreen with the system back gesture fires no click, so the
   * button has to follow the document rather than its own state.
   */
  check('the button follows the document, not its own state', /fullscreenchange/.test(fullscreen));
  check(
    'the methods are bound before being called',
    /\.bind\(target\)/.test(fullscreen),
    'calling exitFullscreen detached throws Illegal invocation',
  );

  // -- landscape layout ----------------------------------------------------

  // Comments stripped: index.css documents the old-Chrome rules in prose, and
  // that prose names the very features being searched for.
  const css = stripComments(readFileSync(path.join(REPO_ROOT, 'client/src/index.css'), 'utf8'), 'index.css');
  /**
   * Height-based rather than orientation-based: a tablet in landscape has plenty
   * of height and should keep the roomier single column.
   */
  /**
   * Tailwind's space-y-* selector outranks `.dashboard-col > *`, so without the
   * important its margins survive and the columns misalign.
   */
  check(
    'the card margin reset beats the utility class it fights',
    /margin:\s*0[^;]*!important/.test(css),
  );
  check('the layout uses no container queries or :has()', !/@container/.test(css) && !/:has\(/.test(css));

  // -- install script ------------------------------------------------------

  const installPath = path.join(REPO_ROOT, 'scripts/install-windows.ps1');
  check('an install script exists', existsSync(installPath));
  if (existsSync(installPath)) {
    const install = readFileSync(installPath, 'utf8');
    check('it supports -WhatIf so the plan can be inspected first', /SupportsShouldProcess/.test(install));
    check('it can undo itself', /-Remove/.test(install) && /Unregister-ScheduledTask/.test(install));
    /**
     * The Private profile only. A rule on Public would open the port on café and
     * hotel Wi-Fi, which is the one thing this project must never do.
     */
    check('the firewall rule is scoped to the Private profile', /-Profile Private/.test(install) && !/-Profile Any/.test(install));
    check('the scheduled task runs unelevated', /-RunLevel Limited/.test(install));
    check('the task starts at logon', /-AtLogOn/.test(install));
  }

  // -- live agent, in dry-run mode -----------------------------------------

  const dataDir = tempDataDir('m6-system');
  const port = 8789;
  const agent = await startAgent({
    port,
    dataDir,
    entry: 'source',
    // Without this the suite would genuinely power the machine off.
    env: { PCR_SYSTEM_DRY_RUN: '1' },
  });

  try {
    check('agent starts', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }
    check('the agent announces that system actions are simulated', /dry run/i.test(agent.plainOutput));

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm6-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    /**
     * The rate limiter is a per-connection cost bucket, and power commands are
     * priced high on purpose — 20 tokens each, so a handful of rejected attempts
     * exhausts the budget. That is correct behaviour, but it means this suite has
     * to open a fresh connection before the checks that must actually succeed,
     * rather than firing eight power commands down one socket in two seconds.
     */
    const openSocket = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
      const acks = new Map<string, { ok: boolean; error?: string }>();
      let lastError: string | undefined;
      let nextId = 1;
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('ws failed')));
        setTimeout(() => reject(new Error('ws open timed out')), 5000);
      });
      socket.addEventListener('message', (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data));
        if (frame.type === 'ack') acks.set(frame.id, { ok: frame.ok, error: frame.error });
        else if (frame.type === 'error') lastError = frame.message;
      });
      const command = async (cmd: unknown): Promise<{ ok: boolean; error?: string }> => {
        const id = String(nextId++);
        lastError = undefined;
        socket.send(JSON.stringify({ type: 'command', id, command: cmd }));
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const ack = acks.get(id);
          if (ack) return ack;
          if (lastError !== undefined) return { ok: false, error: lastError };
          await new Promise((r) => setTimeout(r, 25));
        }
        return { ok: false, error: 'no ack' };
      };
      return { socket, command };
    };

    let { socket, command } = await openSocket();

    for (const kind of ['system.lock', 'system.sleep', 'system.displayOff']) {
      const ack = await command({ kind });
      check(`${kind} is accepted`, ack.ok, ack.error);
    }
    check('the dry run logged rather than acted', /would lock/i.test(agent.plainOutput) && /would sleep/i.test(agent.plainOutput));

    // -- the confirm-token gate ---------------------------------------------

    /**
     * The phone's confirm-twice UI is not a security control — it lives on the
     * client. These check the gate that does live on the agent.
     */
    const noToken = await command({ kind: 'system.shutdown' });
    check('shutdown with no confirmation is rejected by the schema', !noToken.ok, noToken.error);

    const badToken = await command({ kind: 'system.shutdown', confirm: 'not-a-real-token' });
    check('shutdown with a forged confirmation is refused', !badToken.ok, badToken.error);
    check('the machine is still up', /would shut down|would restart/i.test(agent.plainOutput) === false);

    const issue = async (action: string) =>
      (await (await fetch(`${agent.base}/api/confirm-token`, { method: 'POST', headers: authed, body: JSON.stringify({ action }) })).json()) as { token?: string };

    const bogusAction = await fetch(`${agent.base}/api/confirm-token`, {
      method: 'POST',
      headers: authed,
      body: JSON.stringify({ action: 'system.formatDrive' }),
    });
    check('confirm tokens are only issued for the two destructive actions', bogusAction.status === 400, `HTTP ${bogusAction.status}`);

    const shutdownToken = (await issue('system.shutdown')).token;
    check('a confirm token is issued', typeof shutdownToken === 'string' && shutdownToken.length >= 8);

    /**
     * A token minted for shutdown must not authorise a restart. They are
     * different actions and the user confirmed one of them.
     */
    const crossUse = await command({ kind: 'system.restart', confirm: shutdownToken });
    check('a shutdown token cannot authorise a restart', !crossUse.ok, crossUse.error);

    // Fresh connection: the rejected attempts above have spent this one's budget.
    socket.close();
    ({ socket, command } = await openSocket());

    const restartToken = (await issue('system.restart')).token;
    const good = await command({ kind: 'system.restart', confirm: restartToken });
    check('a valid confirmation is accepted', good.ok, good.error);
    check('the dry run recorded the restart', /would restart/i.test(agent.plainOutput));

    /**
     * Single use. A replayed frame — captured, or resent by a flaky client —
     * must not fire a second time.
     */
    const replay = await command({ kind: 'system.restart', confirm: restartToken });
    check('a confirmation token cannot be replayed', !replay.ok, replay.error);

    const unauthorised = await fetch(`${agent.base}/api/confirm-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'system.shutdown' }),
    });
    check('confirm tokens require authentication', unauthorised.status === 401, `HTTP ${unauthorised.status}`);

    socket.close();
  } finally {
    await agent.stop();
  }

  return { results };
}
