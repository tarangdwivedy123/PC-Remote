import { readFileSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { inputLabel, parseInputs } from '../../agent/src/monitors/index.js';
import { REPO_ROOT, createChecker, startAgent, tempDataDir } from './lib.mjs';

/**
 * Monitor input switching over DDC/CI.
 *
 * Nothing here switches an input. Doing so would move a real display on the
 * machine running the suite to another device — possibly one that is not
 * connected, leaving a black screen that has to be fixed with the monitor's own
 * buttons. The write path was verified by hand instead, by writing each
 * monitor's *current* input back to itself: a genuine SetVCPFeature round trip
 * that cannot change what is on screen.
 *
 * What is checked here: the capabilities parser against real strings from two
 * different manufacturers, the guard that refuses inputs a monitor never
 * advertised, and the live read path.
 */

/** Verbatim from the ViewSonic VX3276-FHD on the development machine. */
const VIEWSONIC =
  '(prot(monitor)type(LCD)model(RTK)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 06 08 0B 0C 10 12 ' +
  '14(01 02 04 05 06 08 0B) 16 18 1A 52 60(01 03 04 0F 10 11 12) 87 AC AE B2 B6 C6 C8 CA ' +
  'CC(01 02 03 04 06 0A 0D) D6(01 04 05) DF FD FF)mswhql(1)asset_eep(40)mccs_ver(2.2))';

/** Verbatim from the Acer EK221Q E3 on the same machine. */
const ACER =
  '(prot(monitor)type(LCD)model(ACER)cmds(01 02 03 07 0C E3 F3)vcp(04 10 12 14(05 06 08 0B) ' +
  '16 18 1A 59 5A 5B 5C 5D 5E 60(01 11) 62 6C 6E 70 8D 9B 9C 9D 9E 9F A0 ' +
  'CC(01 02 03 04 05 06 07 08 09 0A 0C 0D 0E 14 16 1E 24) D6(01 02 04 05) E0(00 04 05) ' +
  'E1(00 01 02)E2(00 01 02 03 04 05 06 07 10 11 12) E3 E4 E5 E7(00 01 02) ' +
  'E8(00 01 02 03 04)) mswhql(1)asset_eep(40)mccs_ver(2.2))';

const codes = (caps: string): string => parseInputs(caps).map((i) => i.code).join(',');

export async function run() {
  const { check, results } = createChecker('Monitors — DDC/CI input switching');

  // -- capabilities parsing -------------------------------------------------

  check(
    'the ViewSonic advertises seven inputs',
    codes(VIEWSONIC) === [0x01, 0x03, 0x04, 0x0f, 0x10, 0x11, 0x12].join(','),
    codes(VIEWSONIC),
  );
  check('the Acer advertises two', codes(ACER) === [0x01, 0x11].join(','), codes(ACER));

  check('a monitor with no 60 block offers nothing', parseInputs('(vcp(02 04 10 12))').length === 0);
  check(
    'a bare 60 with no value list offers nothing',
    parseInputs('(vcp(60 10 12))').length === 0,
    'a code listed without values means "supported", not "these are the inputs"',
  );
  check('an empty capabilities string is handled', parseInputs('').length === 0);
  check('junk is handled', parseInputs('not a capabilities string at all').length === 0);

  /**
   * The Acer's string contains `E2(00 01 02 ... 10 11 12)`. A parser that looked
   * for input-ish values anywhere would pick those up and offer inputs the
   * monitor does not have.
   */
  check(
    'values belonging to another feature are not mistaken for inputs',
    codes('(vcp(E2(00 10 11 12) 60(0F)))') === String(0x0f),
    codes('(vcp(E2(00 10 11 12) 60(0F)))'),
  );
  /**
   * And a `60(...)` nested inside another feature's list must not win over the
   * real one. Real monitors do not nest today, but offering a fabricated input
   * would park a display on a dead source.
   */
  check(
    'a nested 60 does not shadow the real one',
    codes('(vcp(10 E2(00 60(99)) 60(01 11)))') === [0x01, 0x11].join(','),
    codes('(vcp(10 E2(00 60(99)) 60(01 11)))'),
  );
  check(
    'duplicate values collapse',
    codes('(vcp(60(0F 0F 11)))') === [0x0f, 0x11].join(','),
  );

  // -- labels ---------------------------------------------------------------

  check('DisplayPort is named', inputLabel(0x0f) === 'DisplayPort 1');
  check('HDMI is named', inputLabel(0x11) === 'HDMI 1' && inputLabel(0x12) === 'HDMI 2');
  check('VGA and DVI are named', inputLabel(0x01) === 'VGA 1' && inputLabel(0x03) === 'DVI 1');
  /**
   * An unknown code is still offered, labelled by its value. Vendors use
   * non-standard values (USB-C especially), and hiding an input the monitor
   * says it has would be worse than showing it as a number.
   */
  check('an unrecognised code is labelled, not dropped', inputLabel(0x42) === 'Input 0x42');

  // -- source guarantees ----------------------------------------------------

  const source = readFileSync(path.join(REPO_ROOT, 'agent/src/monitors/index.ts'), 'utf8');
  check(
    'the recurring poll does not read capabilities',
    /request<RawResult>\('monitors', \{ withCapabilities: false \}/.test(source),
    'the capabilities read costs 2-3.5s per display',
  );
  check('the capability scan runs once, not on the timer', (source.match(/withCapabilities: true/g) ?? []).length === 1);
  check('monitors are polled well below the 1 Hz tick', /POLL_INTERVAL_MS = 10_000/.test(source));
  /**
   * A monitor left on an input with nothing attached shows a black screen and
   * needs its own buttons to recover, so the agent refuses values the display
   * never said it had.
   */
  check('inputs the monitor never advertised are refused', /does not list input/.test(source));

  const hostScript = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  check('input source uses VCP code 0x60', /VCP_INPUT_SOURCE = 0x60/.test(hostScript));
  check('physical monitor handles are always released', /DestroyPhysicalMonitors/.test(hostScript));
  check(
    'the handle release is in a finally block',
    /finally \{\s*DestroyPhysicalMonitors/.test(hostScript),
    'a throw mid-loop would otherwise leak a monitor handle per poll',
  );

  // -- live agent -----------------------------------------------------------

  const dataDir = tempDataDir('m7-monitors');
  const port = 8788;
  const agent = await startAgent({ port, dataDir, entry: 'source' });

  try {
    check('agent starts with the monitor service', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm7-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}` };
    const read = async () => {
      const body = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
      return body.state?.monitors ?? null;
    };

    // The scan takes ~6s for two displays; allow generously for a slow monitor.
    let state = null;
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      state = await read();
      if (state && !state.scanning && state.monitors.length > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    check('monitor state is published', state !== null);
    if (!state) return { results };

    const withInputs = state.monitors.filter((m: { inputs: unknown[] }) => m.inputs.length > 0);
    console.log(
      `        \x1b[2m(${state.monitors.length} display(s), ${withInputs.length} switchable on this machine)\x1b[0m`,
    );

    check('every monitor has an id and a name', state.monitors.every((m: { id: string; name: string }) => m.id.length > 0 && m.name.length > 0));
    check(
      'no monitor is left with the useless "Generic PnP Monitor" label',
      state.monitors.every((m: { name: string }) => !/^generic/i.test(m.name)),
      state.monitors.map((m: { name: string }) => m.name).join(', '),
    );
    check(
      'exactly one display is marked primary',
      state.monitors.filter((m: { primary: boolean }) => m.primary).length === 1,
    );

    if (withInputs.length > 0) {
      check(
        'a switchable monitor reports its current input',
        withInputs.every((m: { currentInput?: number }) => typeof m.currentInput === 'number'),
      );
      check(
        'the current input is one of the advertised ones',
        withInputs.every((m: { currentInput?: number; inputs: { code: number }[] }) =>
          m.inputs.some((i) => i.code === m.currentInput),
        ),
        'a monitor sitting on an input it did not advertise would leave the UI with nothing selected',
      );
      check(
        'every input carries a human label',
        withInputs.every((m: { inputs: { label: string }[] }) => m.inputs.every((i) => i.label.length > 0)),
      );
    }

    // -- the guard, over the wire -------------------------------------------
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
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const ack = acks.get(id);
        if (ack) return ack;
        if (lastError !== undefined) return { ok: false, error: lastError };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { ok: false, error: 'no ack' };
    };

    const unknownMonitor = await command({ kind: 'monitor.setInput', id: 'no-such-display:0', input: 0x11 });
    check('an unknown monitor id is refused', !unknownMonitor.ok, unknownMonitor.error);

    if (withInputs.length > 0) {
      const target = withInputs[0] as { id: string; inputs: { code: number }[] };
      const absent = [...Array(256).keys()].find((c) => !target.inputs.some((i) => i.code === c)) ?? 0x42;
      const refused = await command({ kind: 'monitor.setInput', id: target.id, input: absent });
      check(
        'an input the monitor never advertised is refused before any DDC write',
        !refused.ok && /does not list input/i.test(refused.error ?? ''),
        refused.error,
      );
    }

    const outOfRange = await command({ kind: 'monitor.setInput', id: 'x:0', input: 999 });
    check('a VCP value outside one byte is rejected by zod', !outOfRange.ok, outOfRange.error);

    socket.close();
  } finally {
    await agent.stop();
  }

  return { results };
}
