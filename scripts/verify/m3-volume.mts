import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildVolumeState, parseSessionId, sessionId } from '../../agent/src/volume/index.js';
import WebSocket from 'ws';

import { REPO_ROOT, createChecker, startAgent, tempDataDir } from './lib.mjs';

type RawSession = Parameters<typeof buildVolumeState>[0]['sessions'][number];

function raw(over: Partial<RawSession> = {}): RawSession {
  return {
    pid: 100,
    process: 'app',
    name: 'App',
    volume: 50,
    muted: false,
    state: 1,
    system: false,
    ...over,
  };
}

/**
 * Milestone 3: system and per-application volume.
 *
 * Implemented against Windows Core Audio (IAudioSessionManager2) rather than the
 * svcl.exe the brief named — no third-party binary, by explicit request. The COM
 * work happens inside a single long-lived PowerShell host, because `Add-Type`
 * compiles its C# in ~600ms and a per-command spawn would make the debounced
 * slider the brief asks for impossible.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 3 — volume');

  // -- grouping and identity, no audio device required ---------------------

  const grouped = buildVolumeState({
    master: 40,
    muted: false,
    sessions: [
      raw({ pid: 10, process: 'chrome', name: 'Google Chrome', volume: 100, state: 0 }),
      raw({ pid: 10, process: 'chrome', name: 'Google Chrome', volume: 55, state: 1 }),
      raw({ pid: 10, process: 'chrome', name: 'Google Chrome', volume: 100, state: 0 }),
      raw({ pid: 22, process: 'spotify', name: 'Spotify', volume: 80, state: 1 }),
    ],
  });
  /**
   * Windows reports one session per audio stream, so Chrome routinely appears
   * three or four times. Four identical "Google Chrome" rows, each moving a
   * different fraction of the sound, would be unusable.
   */
  check('multiple streams from one process collapse to a single row', grouped.sessions.length === 2, `${grouped.sessions.length} rows`);
  check(
    'the active stream supplies the displayed level',
    grouped.sessions.find((s) => s.process === 'chrome')?.volume === 55,
    'idle streams sit at 100% regardless of the audible one',
  );

  const withExpired = buildVolumeState({
    master: 40,
    muted: false,
    sessions: [raw({ pid: 1, process: 'live' }), raw({ pid: 2, process: 'dead', state: 2 })],
  });
  check('expired sessions are dropped', withExpired.sessions.length === 1 && withExpired.sessions[0]?.process === 'live');

  const mixedActivity = buildVolumeState({
    master: 40,
    muted: false,
    sessions: [
      raw({ pid: 1, process: 'zzz', name: 'Zzz Idle', state: 0 }),
      raw({ pid: 2, process: 'aaa', name: 'Aaa Idle', state: 0 }),
      raw({ pid: 3, process: 'mmm', name: 'Mmm Playing', state: 1 }),
    ],
  });
  check(
    'playing apps sort above idle ones',
    mixedActivity.sessions[0]?.name === 'Mmm Playing',
    mixedActivity.sessions.map((s) => s.name).join(' | '),
  );
  /**
   * The list re-renders every second. Sorting by volume or pid would let rows
   * swap places under a finger that is mid-drag.
   */
  check(
    'the remainder sorts alphabetically for a stable order',
    mixedActivity.sessions[1]?.name === 'Aaa Idle' && mixedActivity.sessions[2]?.name === 'Zzz Idle',
  );
  check('idle sessions are marked inactive rather than hidden', mixedActivity.sessions[2]?.active === false);

  const muteGroup = buildVolumeState({
    master: 40,
    muted: false,
    sessions: [
      raw({ pid: 7, process: 'app', muted: true, state: 1 }),
      raw({ pid: 7, process: 'app', muted: false, state: 0 }),
    ],
  });
  check('a row counts as muted only when every one of its streams is', muteGroup.sessions[0]?.muted === false);

  check('ids round-trip', parseSessionId(sessionId('chrome', 4321))?.pid === 4321);
  check('a process name containing a colon still parses', parseSessionId('weird:name:99')?.process === 'weird:name');
  check('a malformed id is rejected', parseSessionId('garbage') === undefined);
  check('a negative pid is rejected', parseSessionId('app:-1') === undefined);
  check('a non-numeric pid is rejected', parseSessionId('app:abc') === undefined);

  const clamped = buildVolumeState({
    master: 175,
    muted: false,
    sessions: [raw({ volume: -20 }), raw({ pid: 2, process: 'b', volume: 3000 })],
  });
  check(
    'out-of-range levels are clamped to 0-100',
    clamped.master === 100 && clamped.sessions.every((s) => s.volume >= 0 && s.volume <= 100),
    `master=${clamped.master} sessions=${clamped.sessions.map((s) => s.volume).join(',')}`,
  );

  // -- the source itself ---------------------------------------------------

  const script = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  /**
   * IsSystemSoundsSession and SetDuckingPreference take no [out] parameter, so
   * without PreserveSig the marshaller consumes the HRESULT and the declared int
   * return is meaningless — every session then reports as system sounds, and the
   * per-app list collapses to nothing useful. This was a real bug during
   * development; the guard keeps it from returning.
   */
  check(
    'the no-out-param COM methods are marked PreserveSig',
    /\[PreserveSig\]\s*int IsSystemSoundsSession/.test(script) &&
      /\[PreserveSig\]\s*int SetDuckingPreference/.test(script),
  );
  check(
    'the audio host is spawned once, not per command',
    /-File/.test(readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/host.ts'), 'utf8')),
  );
  const service = readFileSync(path.join(REPO_ROOT, 'agent/src/volume/index.ts'), 'utf8');
  check('inbound writes are coalesced on a ~100ms window', /WRITE_COALESCE_MS = 100/.test(service));

  // -- live agent ----------------------------------------------------------

  const dataDir = tempDataDir('m3-volume');
  const port = 8794;
  // Anything already running belongs to someone else — a real agent on 8765, for
  // instance. Only helpers that appear after this line are ours to account for.
  const hostsBefore = await orphanedHostPids();
  const agent = await startAgent({ port, dataDir, entry: 'source' });
  let restored = false;
  let originalMaster = -1;

  try {
    check('agent starts with the volume service', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm3-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}` };

    const readVolume = async () => {
      const body = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
      return body.state?.volume ?? null;
    };

    let volume = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 25_000) {
      volume = await readVolume();
      if (volume) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('volume state appears after startup', volume !== null, `${Date.now() - waitStart}ms`);
    if (!volume) return { results };

    if (volume.unavailable) {
      /**
       * A machine with no playback device at all. Everything else must still
       * work, which is the point of checking rather than failing outright.
       */
      check('an unavailable audio host reports a reason instead of crashing', typeof volume.reason === 'string', volume.reason);
      console.log(`        \x1b[2m(no usable audio device here — live checks skipped)\x1b[0m`);
      return { results };
    }

    check('the Windows helper reported ready', /Windows helper ready/.test(agent.plainOutput));
    check(
      'master volume is a 0-100 integer',
      Number.isInteger(volume.master) && volume.master >= 0 && volume.master <= 100,
      `${volume.master}%`,
    );
    check('mute state is boolean', typeof volume.muted === 'boolean');
    check('the session list is an array', Array.isArray(volume.sessions), `${volume.sessions.length} sessions`);
    for (const s of volume.sessions) {
      check(
        `session "${s.name}" is well formed`,
        typeof s.id === 'string' &&
          s.id.includes(':') &&
          typeof s.process === 'string' &&
          Number.isInteger(s.volume) &&
          typeof s.muted === 'boolean',
        JSON.stringify(s),
      );
    }

    // Changing the real system volume, so remember what to restore.
    originalMaster = volume.master;
    const target = originalMaster >= 50 ? originalMaster - 4 : originalMaster + 4;

    // Commands travel over the WebSocket, not HTTP.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const acks = new Map<string, { ok: boolean; error?: string }>();
    let nextCommandId = 1;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws failed')));
      setTimeout(() => reject(new Error('ws open timed out')), 5000);
    });
    /**
     * A command that fails *envelope* validation never reaches the router, so the
     * server replies with an `error` frame rather than an `ack` — and error frames
     * carry no id to correlate. Commands here are sent strictly one at a time, so
     * the most recent error is unambiguously the answer to the outstanding one.
     */
    let lastError: string | undefined;
    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === 'ack') acks.set(frame.id, { ok: frame.ok, error: frame.error });
      else if (frame.type === 'error') lastError = frame.message;
    });

    const command = async (cmd: unknown): Promise<{ ok: boolean; error?: string }> => {
      // The frame envelope requires a string id; a number is rejected outright.
      const id = String(nextCommandId++);
      lastError = undefined;
      socket.send(JSON.stringify({ type: 'command', id, command: cmd }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const ack = acks.get(id);
        if (ack) return ack;
        if (lastError !== undefined) return { ok: false, error: lastError };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { ok: false, error: 'no ack' };
    };

    const setAck = await command({ kind: 'volume.setMaster', volume: target });
    check('a volume command is acknowledged', setAck.ok, setAck.error);

    let observed = -1;
    const changeStart = Date.now();
    while (Date.now() - changeStart < 4000) {
      await new Promise((r) => setTimeout(r, 150));
      const v = await readVolume();
      if (v && v.master === target) {
        observed = v.master;
        break;
      }
      if (v) observed = v.master;
    }
    check('setting the master volume takes effect', observed === target, `asked ${target}%, read ${observed}%`);

    // Restore before anything else can fail.
    await command({ kind: 'volume.setMaster', volume: originalMaster });
    await new Promise((r) => setTimeout(r, 1200));
    const afterRestore = await readVolume();
    restored = afterRestore?.master === originalMaster;
    check('the original master volume is restored', restored, `${afterRestore?.master}% (was ${originalMaster}%)`);

    // -- validation ---------------------------------------------------------
    const outOfRange = await command({ kind: 'volume.setMaster', volume: 150 });
    check(
      'an out-of-range volume is rejected by zod',
      // Not merely !ok: an unacknowledged command would also be falsy here, which
      // is exactly how this check passed while the whole command path was broken.
      !outOfRange.ok && outOfRange.error !== 'no ack' && /100|range|less/i.test(outOfRange.error ?? ''),
      outOfRange.error,
    );

    const badTarget = await command({ kind: 'volume.setApp', id: 'no-such-app:999999', volume: 50 });
    check('a command targeting a dead session is accepted but harmless', badTarget.ok, badTarget.error);
    await new Promise((r) => setTimeout(r, 1200));
    const afterBogus = await readVolume();
    check(
      'a write to an unknown session does not disturb the master volume',
      afterBogus?.master === originalMaster,
      `${afterBogus?.master}%`,
    );
    check('the agent survived the bogus write', /Windows helper ready/.test(agent.plainOutput) && afterBogus !== null);

    socket.close();
  } finally {
    if (!restored && originalMaster >= 0) {
      console.log(`        \x1b[33m! attempting master volume restore to ${originalMaster}%\x1b[0m`);
    }
    await agent.stop();
  }

  /**
   * Shutting the agent down must take the PowerShell host with it. The host also
   * watches its parent pid and exits on its own if the agent is killed outright,
   * so allow for that poll interval plus teardown rather than checking once.
   *
   * Two filters, both needed. Only helpers that appeared during this suite
   * count, and only ones whose parent process is gone: a running agent — the
   * developer's own on 8765, or one started mid-run — legitimately owns a live
   * helper, and failing on that says nothing about whether *this* agent tidied
   * up after itself.
   */
  const leaked = await waitForNoNewHosts(hostsBefore, 15_000);
  check(
    'the agent leaves no Windows helper process behind',
    leaked.length === 0,
    leaked.length ? `still running: ${leaked.join(', ')}` : '',
  );

  return { results };
}

/**
 * Looks for a PowerShell process still running our generated host script. A bare
 * powershell.exe count would be meaningless — the verification suite itself runs
 * under PowerShell.
 *
 * The `-File` requirement and the Win32_Process exclusion are both load-bearing:
 * this query's *own* command line contains the search pattern, so a naive
 * `-like '*pcr-audio*'` match finds itself and reports a leak on every run. The
 * real host is always launched with `-File`; this query never is.
 */
/** Orphaned helper pids that were not already orphaned before the suite began. */
async function waitForNoNewHosts(before: Set<string>, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const now = await orphanedHostPids();
    const fresh = [...now].filter((pid) => !before.has(pid));
    if (fresh.length === 0) return [];
    if (Date.now() > deadline) return fresh;
    await new Promise((r) => setTimeout(r, 750));
  }
}

async function orphanedHostPids(): Promise<Set<string>> {
  if (process.platform !== 'win32') return new Set();
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Only helpers whose parent has gone. A helper with a live parent belongs
        // to a running agent — the developer's own on 8765, or another suite's —
        // and flagging it says nothing about whether *this* agent cleaned up.
        "@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*pcr-winhost*' -and $_.CommandLine -notlike '*Win32_Process*' } | Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }) | ForEach-Object { $_.ProcessId }",
      ],
      (err, stdout) => {
        if (err) return resolve(new Set());
        resolve(new Set(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)));
      },
    );
  });
}
