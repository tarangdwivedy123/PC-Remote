/**
 * Drives the client's real frame-handling path with synthetic server frames.
 *
 * This is the only coverage of `applyPatch` on the phone side. The agent's delta
 * encoding is verified against the agent, but nothing until now checked that the
 * client reassembles those deltas into the right state — a mistake there would
 * show up as numbers that freeze or drift, which is both easy to miss and exactly
 * what this project is for.
 *
 * The DOM is stubbed rather than pulled in via jsdom, to avoid a dependency for
 * one test. uPlot is imported but never constructed: React's static renderer does
 * not run effects, so the sparklines render as their accessible wrapper only —
 * which is convenient, because the aria-labels carry the values.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DELETED } from '../../shared/src/patch.js';
import { REPO_ROOT, createChecker } from './lib.mjs';

interface SocketStub {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  sent: string[];
}

const sockets: SocketStub[] = [];

function installDomStubs(storage: Record<string, string>): void {
  const noop = (): void => {};
  const localStorage = {
    getItem: (k: string) => (k in storage ? storage[k] : null),
    setItem: (k: string, v: string) => {
      storage[k] = v;
    },
    removeItem: (k: string) => {
      delete storage[k];
    },
  };

  const win = {
    localStorage,
    location: { protocol: 'http:', host: '192.168.1.42:8765' },
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    devicePixelRatio: 2,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
  };

  class WebSocketStub implements SocketStub {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    sent: string[] = [];
    constructor() {
      sockets.push(this);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
  }

  Object.assign(globalThis, {
    window: win,
    document: {
      visibilityState: 'visible',
      // The fullscreen button probes documentElement during its first render,
      // and hides itself when no request method exists — so a browser that
      // supports it has to be simulated for the button to appear at all.
      documentElement: { requestFullscreen: () => Promise.resolve() },
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => true,
      getElementById: () => null,
    },
    localStorage,
    devicePixelRatio: 2,
    matchMedia: () => ({
      matches: false,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
    }),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    cancelAnimationFrame: (id: number) => globalThis.clearTimeout(id),
    WebSocket: WebSocketStub,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Linux; Android 9; SM-G950F) Chrome/70.0.3538.110 Mobile' },
    configurable: true,
    writable: true,
  });
}

function makeSample(t: number, cpu: number, mem: number, extra: Record<string, number> = {}) {
  return { t, cpu, mem, diskR: 1.5, diskW: 0.5, netUp: 0.02, netDown: 0.4, ...extra };
}

export async function run() {
  const { check, results } = createChecker('Milestone 2 — client state assembly and Stats rendering');

  const storage: Record<string, string> = { 'pcr.token': 'token-long-enough-to-look-plausible-123456' };
  installDomStubs(storage);

  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = await import('react');
  Object.assign(globalThis, { React: (React as { default?: unknown }).default ?? React });

  const { App } = await import('../../client/src/App.tsx');
  const { connection } = await import('../../client/src/lib/connection.ts');

  const render = (): string => renderToStaticMarkup(React.createElement(App as never));

  // -- before any data ------------------------------------------------------
  const beforeConnect = render();
  check(
    'Stats shows a waiting placeholder before the first sample',
    beforeConnect.includes('Waiting for the first sample'),
  );
  check('no NaN or undefined leaks into the empty state', !/NaN|undefined/.test(beforeConnect));

  // -- open the socket ------------------------------------------------------
  connection.start();
  const socket = sockets[sockets.length - 1];
  check('the client opened a WebSocket once it had a token', socket !== undefined, `${sockets.length} socket(s)`);
  if (!socket) return { results };

  socket.readyState = 1;
  socket.onopen?.();

  const history = [
    makeSample(1000, 10, 50),
    makeSample(2000, 20, 51),
    makeSample(3000, 30, 52),
  ];

  socket.onmessage?.({
    data: JSON.stringify({
      type: 'hello',
      protocol: 1,
      host: { hostname: 'MYPC', platform: 'win32', agentVersion: '0.1.0' },
      serverTime: 3000,
      intervalMs: 1000,
      history,
      state: {
        t: 3000,
        stats: {
          cpu: { loadPct: 30, perCorePct: [25, 35, 28, 32], brand: 'Intel(R) Core(TM) i3-9100T', cores: 4 },
          mem: { usedBytes: 6_860_759_040, totalBytes: 8_361_283_584, usedPct: 82.1 },
          disk: { readMBs: 1.5, writeMBs: 0.5 },
          net: { upMBs: 0.02, downMBs: 0.4 },
          uptimeSec: 9229,
        },
        volume: {
          master: 42,
          muted: false,
          mic: { muted: true, volume: 80 },
          sessions: [
            { id: 'chrome:100', process: 'chrome', name: 'Google Chrome', volume: 70, muted: false, pid: 100, active: true },
            { id: 'spotify:200', process: 'spotify', name: 'Spotify', volume: 25, muted: true, pid: 200, active: false },
          ],
        },
        media: { backend: 'keys', status: 'unknown', canNext: true, canPrevious: true, canSeek: false },
        system: { canSend: true },
        monitors: {
          scanning: false,
          monitors: [
            {
              id: '\\.\DISPLAY1:0',
              name: 'VX3276-FHD',
              primary: true,
              currentInput: 0x0f,
              brightness: 65,
              inputs: [
                { code: 0x0f, label: 'DisplayPort 1' },
                { code: 0x11, label: 'HDMI 1' },
              ],
            },
          ],
        },
      },
    }),
  });

  const connected = render();
  check('status bar reports the connection and hostname', connected.includes('Connected') && connected.includes('MYPC'));
  check('CPU load renders as a rounded percentage', connected.includes('30%'), extract(connected, 'CPU'));
  check('RAM renders both the percentage and the byte figures', connected.includes('82%') && connected.includes('6.4 / 7.8 GB'));
  check('CPU brand is shown', connected.includes('Intel(R) Core(TM) i3-9100T'));
  check('uptime is formatted, not raw seconds', connected.includes('up 2h 33m') && !connected.includes('9229'));
  check('disk read and write both render', connected.includes('1.5') && connected.includes('0.5'));
  check(
    'per-core bars render one element per core',
    (connected.match(/Per-core load/g) ?? []).length === 1 && connected.includes('4 logical cores'),
  );
  check(
    'per-core aria-label lists every core value',
    connected.includes('Per-core load: 25%, 35%, 28%, 32%'),
    extract(connected, 'Per-core'),
  );
  check(
    'sparklines expose accessible labels instead of bare canvases',
    (connected.match(/role="img"/g) ?? []).length >= 5,
    `${(connected.match(/role="img"/g) ?? []).length} labelled graphics`,
  );

  /**
   * The brief requires the GPU field to be omitted when nvidia-smi is
   * unavailable. The client must key off absence, not render a 0% row.
   */
  check('no GPU row when the agent omitted the field', !connected.includes('GPU'));

  /**
   * Stats sits last: it is glanced at, not reached for, so the controls get the
   * top of the screen and the thumb.
   */
  const order = [...connected.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
  check(
    'section order puts the controls first and stats after them',
    // "Link" is the diagnostics card and legitimately sits below everything.
    order[0] === 'Now Playing' && order.indexOf('Stats') > order.indexOf('System'),
    order.join(' > '),
  );
  check('a fullscreen control is offered in the status bar', connected.includes('aria-label="Full screen"'));

  // -- monitors -------------------------------------------------------------
  check('the monitor and its inputs render', connected.includes('VX3276-FHD') && connected.includes('DisplayPort 1') && connected.includes('HDMI 1'));
  /**
   * The input in use must be the one the dropdown shows as chosen, or the card
   * would misreport which cable the monitor is on.
   */
  check(
    'the dropdown preselects the input actually in use',
    /<option[^>]*selected[^>]*>DisplayPort 1</.test(connected),
    extract(connected, 'DisplayPort 1'),
  );
  check('the other inputs are offered', connected.includes('>HDMI 1<'));
  /**
   * The explanatory paragraph was removed on request — the space matters more on
   * a phone than the warning, which lives in the README instead.
   */
  check('no explanatory paragraph crowds the monitor card', !connected.includes('its own buttons to come back'));

  // -- the newer controls ----------------------------------------------------
  check('a muted microphone is stated in words, not just an icon', connected.includes('MUTED'));
  check('the mute control names what it will do', connected.includes('>Unmute<') || connected.includes('>Mute<'));
  check('monitor brightness renders as a slider', connected.includes('aria-label="VX3276-FHD brightness"'));
  /**
   * A select rather than a grid of buttons: seven inputs was three rows of 48px
   * controls, making this the tallest card on the screen.
   */
  check(
    'monitor inputs are a compact dropdown',
    connected.includes('aria-label="VX3276-FHD input source"') && connected.includes('<select'),
  );
  check('the sleep timer offers presets', connected.includes('15m') && connected.includes('30m'));
  check(
    'the sleep timer accepts a custom duration',
    connected.includes('aria-label="Custom sleep delay in minutes"'),
  );
  check('send-to-PC offers a field and both actions', connected.includes('Text, or a link to open') && connected.includes('>Copy<') && connected.includes('>Open<'));
  check('a theme toggle is offered', /aria-label="Switch to (light|dark) theme"/.test(connected));

  // -- system ---------------------------------------------------------------
  check(
    'the recoverable system actions render',
    connected.includes('aria-label="Lock"') &&
      connected.includes('aria-label="Sleep"') &&
      connected.includes('aria-label="Display off"'),
  );
  /**
   * Power now lives in the header behind an expander, not on a card. Collapsed
   * by default: these are the rarest actions and the costliest to hit by
   * accident, so they get one more deliberate step than anything else.
   */
  check('a power control is offered in the header', connected.includes('aria-label="Power options"'));
  check(
    'the destructive actions are not on screen until asked for',
    !connected.includes('Shut down') && !connected.includes('>Restart<'),
  );
  /**
   * They must start unarmed. A button whose first tap powers the machine off is
   * the whole thing the confirm-twice flow exists to prevent.
   */
  check(
    'destructive buttons start unarmed',
    !connected.includes('Tap again to shut down') && !connected.includes('aria-label="Confirm Shut down"'),
  );
  check('keep-screen-on is gone', !connected.includes('Keep screen on'));


  // -- now playing ----------------------------------------------------------
  check(
    'transport controls render',
    connected.includes('aria-label="Previous"') &&
      connected.includes('aria-label="Next"') &&
      connected.includes('aria-label="Stop"') &&
      /aria-label="(Play|Pause)"/.test(connected),
  );
  /**
   * The label follows the reported status as a hint, but the *action* must not:
   * the button always sends the toggle, because a status that lies would
   * otherwise make it send whichever action was already true.
   */
  const nowPlayingSource = readFileSync(
    path.join(REPO_ROOT, 'client/src/components/NowPlayingSection.tsx'),
    'utf8',
  );
  check(
    'the play button always sends the toggle, whatever the label says',
    /onClick=\{\(\) => send\(\{ kind: 'media\.playPause' \}\)\}/.test(nowPlayingSource) &&
      !/media\.pause'/.test(nowPlayingSource),
  );
  check('the keys backend explains its limitation', connected.includes('media keys'));
  check(
    'no seek control is offered when canSeek is false',
    !connected.includes('aria-label="Seek"'),
  );

  // -- volume ---------------------------------------------------------------
  check('system volume renders as a percentage', connected.includes('42%'), extract(connected, 'System'));
  check('each audio session gets a row', connected.includes('Google Chrome') && connected.includes('Spotify'));
  check('per-app levels render', connected.includes('70%'));
  /**
   * A muted app shows "muted" instead of its level. Showing 25% next to a silent
   * app invites the obvious "why can't I hear it" confusion.
   *
   * Scoped to the Spotify row rather than the whole document: "25%" also appears
   * in the CPU per-core label, which is what made the first version of this check
   * fail against correct markup.
   */
  const spotifyRow = connected.slice(connected.indexOf('Spotify'), connected.indexOf('Spotify') + 260);
  check(
    'a muted app reads "muted" rather than its stored level',
    spotifyRow.includes('muted') && !spotifyRow.includes('25%'),
    extract(connected, 'Spotify'),
  );
  check(
    'sliders are real range inputs, not custom widgets',
    // system volume + 2 apps + the monitor brightness in the fixture.
    (connected.match(/type="range"/g) ?? []).length === 4,
    `${(connected.match(/type="range"/g) ?? []).length} sliders`,
  );
  check(
    'every slider carries an accessible label',
    connected.includes('aria-label="System volume"') && connected.includes('aria-label="Google Chrome volume"'),
  );
  check(
    'mute buttons announce the action they perform',
    connected.includes('Mute Google Chrome') && connected.includes('Unmute Spotify'),
  );
  check(
    'the session count is shown in the section header',
    connected.includes('2 apps'),
    extract(connected, 'Volume'),
  );

  // -- apply a delta --------------------------------------------------------
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'patch',
      patch: { t: 4000, stats: { cpu: { loadPct: 77, perCorePct: [70, 80, 75, 83] }, mem: { usedPct: 90.4 } } },
      sample: makeSample(4000, 77, 90.4),
    }),
  });

  const patched = render();
  check('a delta updates the CPU readout', patched.includes('77%'), extract(patched, 'CPU'));
  check('a delta updates the RAM percentage', patched.includes('90%'));
  check('a delta updates the per-core bars', patched.includes('Per-core load: 70%, 80%, 75%, 83%'));
  /**
   * The patch touched cpu.loadPct and cpu.perCorePct but not cpu.brand. If
   * applyPatch replaced the cpu object wholesale instead of merging, the brand
   * would be gone.
   */
  check(
    'fields absent from the delta are preserved, not dropped',
    patched.includes('Intel(R) Core(TM) i3-9100T') && patched.includes('4 logical cores'),
  );
  check(
    'the byte figures survive a delta that only changed the percentage',
    patched.includes('6.4 / 7.8 GB'),
  );

  socket.onmessage?.({
    data: JSON.stringify({
      type: 'patch',
      patch: { t: 4500, volume: { master: 88, sessions: [{ id: 'chrome:100', process: 'chrome', name: 'Google Chrome', volume: 15, muted: false, pid: 100, active: true }] } },
      sample: makeSample(4500, 50, 90),
    }),
  });
  const volumePatched = render();
  check('a volume delta updates the system level', volumePatched.includes('88%'));
  /**
   * The session array is replaced wholesale rather than merged per index —
   * reordering or removing entries makes an index-wise diff larger than the list.
   */
  check('a shrunken session list drops the removed app', !volumePatched.includes('Spotify'));
  check('the remaining app shows its new level', volumePatched.includes('15%'));

  // -- media: a session appearing turns the blind backend into a real one ----
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'patch',
      patch: {
        t: 4700,
        media: {
          backend: 'smtc',
          status: 'playing',
          sourceApp: 'Spotify',
          title: 'A Song Title',
          artist: 'An Artist',
          album: 'An Album',
          positionSec: 65,
          durationSec: 200,
          canSeek: true,
          canNext: true,
          canPrevious: true,
          thumbnailId: 'art1',
        },
      },
      sample: makeSample(4700, 40, 88),
    }),
  });
  const withSession = render();
  check('track metadata renders once a session exists', withSession.includes('A Song Title') && withSession.includes('An Artist'));
  check('the owning app is shown', withSession.includes('Spotify'));
  check('a real play state replaces the blind toggle', withSession.includes('aria-label="Pause"'));
  check('the seek scrubber appears when the session supports it', withSession.includes('aria-label="Seek"'));
  check('elapsed and total time render as clock values', withSession.includes('1:05') && withSession.includes('3:20'));
  /**
   * Artwork is fetched over HTTP rather than inlined, so a cover does not ride
   * along on every 1 Hz frame.
   */
  check(
    'artwork is referenced by id, not embedded as base64',
    withSession.includes('/api/media/thumbnail?id=art1') && !withSession.includes('data:image'),
  );
  check('the media-keys explanation is gone once metadata is real', !withSession.includes('media buttons'));

  // -- a GPU appearing mid-session -----------------------------------------
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'patch',
      patch: {
        t: 5000,
        stats: { gpu: { name: 'NVIDIA GeForce RTX 3070', utilPct: 64, memUsedMB: 3072, memTotalMB: 8192, tempC: 71 } },
      },
      sample: makeSample(5000, 60, 90, { gpu: 64, gpuMem: 37.5 }),
    }),
  });

  const withGpu = render();
  check('a GPU appearing in a delta adds the row', withGpu.includes('GPU') && withGpu.includes('64%'));
  check('GPU memory and temperature render', withGpu.includes('3.0 / 8.0 GB') && withGpu.includes('71°C'));
  check('GPU name renders', withGpu.includes('NVIDIA GeForce RTX 3070'));

  /**
   * The agent signals a vanished GPU with the deletion marker, since JSON cannot
   * carry `undefined`. If the client did not honour it, an unplugged or crashed
   * GPU would show its last reading forever.
   *
   * The marker is imported rather than written out by hand — duplicating it here
   * is how the previous version of this check passed a value that did not match.
   */
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'patch',
      patch: { t: 6000, stats: { gpu: DELETED } },
      sample: makeSample(6000, 55, 89),
    }),
  });

  const gpuGone = render();
  check('a deleted GPU is removed from the UI, not left stale', !gpuGone.includes('NVIDIA GeForce RTX 3070') && !gpuGone.includes('71°C'));
  check('the rest of the stats survive the deletion', gpuGone.includes('Intel(R) Core(TM) i3-9100T'));

  // -- disconnect handling --------------------------------------------------
  socket.onclose?.({ code: 1006, reason: '' });
  const dropped = render();
  check('losing the socket surfaces a reconnecting state', /Reconnecting/.test(dropped), extract(dropped, 'Reconnect'));
  check(
    'the last known stats stay on screen while reconnecting',
    dropped.includes('Intel(R) Core(TM) i3-9100T'),
  );

  connection.stop();
  return { results };
}

/** Pulls a short window of markup around a marker, for failure messages. */
function extract(html: string, marker: string): string {
  const index = html.indexOf(marker);
  if (index < 0) return `"${marker}" not found`;
  return html.slice(index, index + 90).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
