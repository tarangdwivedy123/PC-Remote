import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { REPO_ROOT, createChecker, startAgent, stripComments, tempDataDir } from './lib.mjs';

/**
 * Brightness, microphone, sleep timer, send-to-PC, and theming.
 *
 * The agent runs with PCR_SYSTEM_DRY_RUN=1 so a sleep timer that fires cannot
 * suspend the machine running the suite. Nothing here changes a monitor's
 * brightness either: that is a visible change to the developer's desk, and the
 * write path was verified by hand instead.
 */
export async function run() {
  const { check, results } = createChecker('Extras — brightness, mic, timer, send, theme');

  // -- host interop ---------------------------------------------------------

  const host = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  check('brightness uses the luminance VCP code', /VCP_BRIGHTNESS = 0x10/.test(host));
  /**
   * Unlike input source, brightness is a continuous control, so the maximum the
   * monitor reports is meaningful — and monitors do not all use 0-100.
   */
  check(
    'brightness is scaled against the monitor’s own maximum',
    /percent \* max\) \/ 100/.test(host) && /target \* 100\) \/ max/.test(host),
  );
  check('the microphone is the capture data flow of the same API', /eCapture = 1/.test(host));
  check('clipboard and link opening exist', /Set-Clipboard/.test(host) && /OpenUrl/.test(host));
  /**
   * ShellExecute can launch anything. The agent's zod schema restricts the
   * scheme and the host checks again before the call — two independent checks on
   * the one place in this project that can start a process.
   */
  check(
    'the host re-checks the URL scheme before ShellExecute',
    /StartsWith\("http:\/\/"\)/.test(host) && /StartsWith\("https:\/\/"\)/.test(host),
  );

  const commands = readFileSync(path.join(REPO_ROOT, 'agent/src/commands.ts'), 'utf8');
  check(
    'only http and https links are accepted by the schema',
    /only http and https links can be opened/.test(commands),
  );
  check('control characters in a link are rejected', /u0000-\\u001f/.test(commands));
  check('the sleep timer is bounded', /max\(720\)/.test(commands));

  // -- audio output devices -------------------------------------------------

  /**
   * There is no supported API for changing the default playback device, and
   * which undocumented interface answers depends on the Windows build — the
   * newer IID returns E_NOINTERFACE on this Windows 11 machine while the
   * Vista-era one works. Both shapes must be declared separately: the older
   * vtable is a slot shorter, so sharing a declaration calls the wrong method.
   */
  check('both policy-config interfaces are declared', /IPolicyConfigVista/.test(host) && /interface IPolicyConfig \{/.test(host));
  check(
    'the older interface omits ResetDeviceFormat, as its vtable does',
    (() => {
      const vista = /interface IPolicyConfigVista \{([^}]*)\}/.exec(host)?.[1] ?? '';
      return !/ResetDeviceFormat/.test(vista);
    })(),
  );
  check('the COM signatures are PreserveSig', /\[PreserveSig\] int SetDefaultEndpoint/.test(host));
  /**
   * Windows keeps separate defaults for console, multimedia and communications.
   * Moving only one leaves some applications on the old device, which looks
   * exactly like the switch not working.
   */
  check('all three device roles are switched together', /eMultimedia/.test(host) && /eCommunications/.test(host));

  const volumeSource = readFileSync(path.join(REPO_ROOT, 'agent/src/volume/index.ts'), 'utf8');
  check('an unknown output device id is refused', /no longer available/.test(volumeSource));
  check('devices are enumerated far slower than the volume poll', /DEVICE_POLL_MS = 5000/.test(volumeSource));

  const mediaSrc = readFileSync(path.join(REPO_ROOT, 'agent/src/media/index.ts'), 'utf8');
  /**
   * The reported status contradicted itself on Chrome — `paused` alongside
   * `canPause: true` — which made the icon read backwards. The capability flags
   * were right, so they decide whenever they are unambiguous.
   */
  check('playback status is derived from the capability flags', /export function deriveStatus/.test(mediaSrc));
  check(
    'being able to pause but not play means playing',
    /if \(canPause && !canPlay\) return 'playing'/.test(mediaSrc),
  );

  const vol = readFileSync(path.join(REPO_ROOT, 'client/src/components/VolumeSection.tsx'), 'utf8');
  check('the microphone has a microphone icon, not a speaker', /function MicIcon/.test(vol));
  /**
   * A bare icon did not read as a control. It now has a border, a fill when
   * engaged, and the word OFF.
   */
  /**
   * Labelled with the action rather than the state, because a bare icon gave a
   * first-time user nothing to indicate it was a control at all.
   */
  check(
    'mute is an obviously tappable, self-describing control',
    /aria-pressed=\{muted\}/.test(vol) && /muted \? 'Unmute' : 'Mute'/.test(vol),
  );
  /**
   * Both states are coloured, not just the muted one. Leaving "on" uncoloured
   * made it read as the absence of a state rather than a state.
   */
  check(
    'the live state is green and the muted state red',
    /muted \? 'var\(--danger-bright\)' : 'var\(--accent-bright\)'/.test(vol),
  );

  // -- theming --------------------------------------------------------------

  const css = stripComments(readFileSync(path.join(REPO_ROOT, 'client/src/index.css'), 'utf8'), 'index.css');
  check('a dark palette is defined', /--ink-950:/.test(css) && /--accent-bright:/.test(css));
  check('a light palette is defined', /\.theme-light\s*\{/.test(css));
  /**
   * Both themes must define every variable, or switching leaves a colour
   * inherited from the other one — the kind of bug that shows up as one
   * unreadable label rather than an obvious failure.
   */
  const darkVars = new Set([...css.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const lightBlock = /\.theme-light\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const lightVars = new Set([...lightBlock.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  const missing = [...darkVars].filter((v) => !lightVars.has(v));
  check('the light theme defines every variable the dark one does', missing.length === 0, missing.join(', '));

  const tailwind = readFileSync(path.join(REPO_ROOT, 'client/tailwind.config.js'), 'utf8');
  check('Tailwind colours point at the variables', /var\(--ink-950\)/.test(tailwind) && !/#000000/.test(tailwind));

  const theme = readFileSync(path.join(REPO_ROOT, 'client/src/lib/theme.ts'), 'utf8');
  check('the choice is remembered', /localStorage/.test(theme));
  check('the OS preference seeds the first run', /prefers-color-scheme/.test(theme));
  check('the browser chrome colour follows the theme', /theme-color/.test(theme));

  const main = readFileSync(path.join(REPO_ROOT, 'client/src/main.tsx'), 'utf8');
  /**
   * Applied before the first render. Doing it in an effect would paint one frame
   * of the wrong palette, which going dark-to-light is a white flash.
   */
  check('the theme is applied before React mounts', /applyTheme\(getStoredTheme\(\)\)/.test(main));

  const spark = readFileSync(path.join(REPO_ROOT, 'client/src/components/Sparkline.tsx'), 'utf8');
  /**
   * uPlot captures the stroke into its canvas at creation, so unlike the rest of
   * the UI a chart cannot follow a class change and must be rebuilt.
   */
  check('charts rebuild when the theme changes', /pcr:themechange/.test(spark) && /themeEpoch/.test(spark));
  check('chart colours are resolved from the active theme', /themeColor\(s\.color/.test(spark));

  const remainingHex = ['MonitorsSection', 'SystemSection', 'VolumeSection', 'SendToPc', 'SleepTimer']
    .filter((name) => {
      const file = path.join(REPO_ROOT, `client/src/components/${name}.tsx`);
      if (!existsSync(file)) return false;
      const source = stripComments(readFileSync(file, 'utf8'), `${name}.tsx`);
      return /['"]#[0-9a-fA-F]{6}['"]/.test(source);
    });
  check('no themed component still hard-codes a colour', remainingHex.length === 0, remainingHex.join(', '));

  // -- live agent -----------------------------------------------------------

  const dataDir = tempDataDir('m8-extras');
  const port = 8784;
  const agent = await startAgent({ port, dataDir, entry: 'source', env: { PCR_SYSTEM_DRY_RUN: '1' } });

  try {
    check('agent starts', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm8-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}` };
    const read = async () => (await (await fetch(`${agent.base}/api/state`, { headers: authed })).json()).state;

    let state = null;
    const started = Date.now();
    while (Date.now() - started < 40_000) {
      state = await read();
      if (state?.system && state?.volume && state?.monitors && !state.monitors.scanning) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    check('the system slice is published', state?.system != null);
    check('send-to-PC reports whether it is available', typeof state?.system?.canSend === 'boolean');
    check('no sleep timer is armed at startup', state?.system?.sleepAt === undefined);

    const mic = state?.volume?.mic;
    console.log(
      `        \x1b[2m(microphone ${mic ? `present: muted=${mic.muted}` : 'not present on this machine'})\x1b[0m`,
    );
    if (mic) {
      check('the microphone reports mute and level', typeof mic.muted === 'boolean' && typeof mic.volume === 'number');
      check('the microphone level is a percentage', mic.volume >= 0 && mic.volume <= 100, String(mic.volume));
    }

    const withBrightness = (state?.monitors?.monitors ?? []).filter(
      (m: { brightness?: number }) => typeof m.brightness === 'number',
    );
    console.log(`        \x1b[2m(${withBrightness.length} display(s) report brightness)\x1b[0m`);
    check(
      'reported brightness is a percentage',
      withBrightness.every((m: { brightness: number }) => m.brightness >= 0 && m.brightness <= 100),
      withBrightness.map((m: { brightness: number }) => m.brightness).join(', '),
    );

    // -- commands ------------------------------------------------------------
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

    /**
     * Every scheme that is not http(s) must be refused. This is the only command
     * that can start a process, so the list is deliberately long.
     */
    for (const bad of [
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      'ftp://example.com/x',
      '\\\\server\\share',
      'ms-settings:',
      'C:/Windows/System32/cmd.exe',
    ]) {
      const ack = await command({ kind: 'system.openUrl', url: bad });
      check(`"${bad.slice(0, 26)}" is refused`, !ack.ok, ack.error);
    }

    /**
     * The clipboard belongs to whoever is using the machine. Testing it means
     * overwriting it, so the previous contents are read first and put back
     * afterwards — the same courtesy the volume suite extends to the speaker
     * level. Leaving "pc-remote verification" sitting there is a small thing
     * that is nonetheless the suite's mess to clean up.
     */
    const beforeClipboard = (await read())?.system?.clipboard ?? '';
    const clip = await command({ kind: 'system.sendText', text: 'pc-remote verification' });
    check('text can be sent to the clipboard', clip.ok, clip.error);
    await new Promise((r) => setTimeout(r, 600));
    check(
      'the clipboard mirror reflects what was just sent',
      (await read())?.system?.clipboard === 'pc-remote verification',
    );
    if (beforeClipboard) {
      await command({ kind: 'system.sendText', text: beforeClipboard });
      await new Promise((r) => setTimeout(r, 600));
      check(
        'the clipboard is restored to what it held before',
        (await read())?.system?.clipboard === beforeClipboard,
      );
    } else {
      // Nothing to restore, but the marker should not be left behind either.
      await command({ kind: 'system.sendText', text: ' ' });
      console.log('        \x1b[2m(clipboard was empty beforehand; cleared rather than restored)\x1b[0m');
    }
    check('an empty clipboard send is rejected', !(await command({ kind: 'system.sendText', text: '' })).ok);

    const arm = await command({ kind: 'system.sleepTimer', minutes: 45 });
    check('a sleep timer can be armed', arm.ok, arm.error);
    await new Promise((r) => setTimeout(r, 1200));
    const armed = await read();
    const minutesAway = armed?.system?.sleepAt ? (armed.system.sleepAt - Date.now()) / 60_000 : 0;
    check('the timer is published as an absolute time', minutesAway > 43 && minutesAway <= 45, `${minutesAway.toFixed(1)} min away`);

    const cancel = await command({ kind: 'system.sleepTimer', minutes: 0 });
    check('a sleep timer can be cancelled', cancel.ok, cancel.error);
    await new Promise((r) => setTimeout(r, 1200));
    check('cancelling clears the countdown', (await read())?.system?.sleepAt === undefined);

    check('an absurd sleep delay is rejected', !(await command({ kind: 'system.sleepTimer', minutes: 5000 })).ok);
    check(
      'brightness outside 0-100 is rejected',
      !(await command({ kind: 'monitor.setBrightness', id: 'x:0', brightness: 300 })).ok,
    );

    const micCmd = await command({ kind: 'volume.setMicMuted', muted: false });
    check('the microphone command is accepted', micCmd.ok || !mic, micCmd.error);

    socket.close();
  } finally {
    await agent.stop();
  }

  return { results };
}
