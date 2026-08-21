import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { REPO_ROOT, collectFrames, createChecker, startAgent, stripComments, tempDataDir } from './lib.mjs';

/**
 * Milestone 2: stats from the agent, through the WebSocket, into the history the
 * phone charts read.
 *
 * Note on running this: the disk and network figures come from `typeperf`, which
 * needs Performance Data Helper access. Some sandboxed shells deny that to
 * grandchild processes, in which case those two report zero. The structural
 * checks below therefore do not require non-zero throughput — a separate
 * informational line reports whether the counters were actually live.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 2 — stats end to end');
  const dataDir = tempDataDir('m2-stats');
  const port = 8795;

  const agent = await startAgent({ port, dataDir, entry: 'source' });

  try {
    check('agent starts with the stats sampler', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm2-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}` };

    /**
     * The server starts listening before the first sample lands, on purpose — the
     * banner should not wait on the sampler. So poll rather than assume: a client
     * that connects in that window legitimately sees `stats: null`.
     */
    let firstSampleMs = -1;
    let historyDepth = 0;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 12_000) {
      const body = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
      if (body.state?.stats && firstSampleMs < 0) firstSampleMs = Date.now() - waitStart;
      historyDepth = body.history?.length ?? 0;
      // Wait for a few samples: the point of the replay-on-connect behaviour is
      // that the phone's charts are not empty, which one sample would not show.
      if (historyDepth >= 3) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    check('the first sample arrives promptly after startup', firstSampleMs >= 0, `${firstSampleMs}ms`);
    check('the agent accumulates a history before any client connects', historyDepth >= 3, `${historyDepth} samples`);

    check(
      'sampler reports its cadence and core count',
      /sampling every 1000ms \(\d+ logical cores\)/.test(agent.plainOutput),
      agent.plainOutput.match(/sampling every 1000ms \([^)]*\)/)?.[0],
    );

    // Give the sampler a few more ticks so the delta behaviour is visible.
    const { status, frames } = await collectFrames(
      WebSocket,
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
      {
        until: (f) => f.filter((x) => x.type === 'patch' || x.type === 'state').length >= 4,
        timeoutMs: 12_000,
      },
    );
    check('WebSocket delivers stats frames', status === 'ok', status);

    const hello = frames.find((f) => f.type === 'hello');
    const stats = hello?.state?.stats;
    check('hello carries a populated stats object', Boolean(stats));
    if (!stats) return { results };

    // -- shape ---------------------------------------------------------------
    check(
      'CPU reports total load in 0-100',
      typeof stats.cpu.loadPct === 'number' && stats.cpu.loadPct >= 0 && stats.cpu.loadPct <= 100,
      `${stats.cpu.loadPct}%`,
    );
    check(
      'CPU reports one entry per logical core',
      Array.isArray(stats.cpu.perCorePct) && stats.cpu.perCorePct.length === os.cpus().length,
      `${stats.cpu.perCorePct?.length} of ${os.cpus().length}`,
    );
    check(
      'every per-core value is in 0-100',
      stats.cpu.perCorePct.every((v) => typeof v === 'number' && v >= 0 && v <= 100),
    );
    check('CPU brand is reported', typeof stats.cpu.brand === 'string' && stats.cpu.brand.length > 0, stats.cpu.brand);

    check(
      'RAM reports used and total bytes',
      stats.mem.totalBytes > 0 && stats.mem.usedBytes > 0 && stats.mem.usedBytes <= stats.mem.totalBytes,
      `${(stats.mem.usedBytes / 1e9).toFixed(2)} / ${(stats.mem.totalBytes / 1e9).toFixed(2)} GB`,
    );
    check(
      'RAM percentage agrees with the byte counts',
      Math.abs(stats.mem.usedPct - (stats.mem.usedBytes / stats.mem.totalBytes) * 100) < 0.2,
      `${stats.mem.usedPct}%`,
    );

    check(
      'disk reports non-negative read and write rates',
      typeof stats.disk.readMBs === 'number' &&
        typeof stats.disk.writeMBs === 'number' &&
        stats.disk.readMBs >= 0 &&
        stats.disk.writeMBs >= 0,
      `R ${stats.disk.readMBs} W ${stats.disk.writeMBs} MB/s`,
    );
    check(
      'network reports non-negative up and down rates',
      typeof stats.net.upMBs === 'number' &&
        typeof stats.net.downMBs === 'number' &&
        stats.net.upMBs >= 0 &&
        stats.net.downMBs >= 0,
      `down ${stats.net.downMBs} up ${stats.net.upMBs} MB/s`,
    );
    check('uptime is reported in seconds', stats.uptimeSec > 0, `${Math.round(stats.uptimeSec / 3600)}h`);

    const countersLive = /streaming \d+ performance counters/.test(agent.plainOutput);
    console.log(
      `        \x1b[2m(typeperf counters ${countersLive ? 'are live' : 'were unavailable in this shell — disk/net will read 0'})\x1b[0m`,
    );

    // -- GPU: absent, not null ----------------------------------------------
    const gpuKeyPresent = 'gpu' in stats;
    if (gpuKeyPresent) {
      check(
        'GPU, when present, carries all four queried fields',
        typeof stats.gpu?.utilPct === 'number' &&
          typeof stats.gpu?.memUsedMB === 'number' &&
          typeof stats.gpu?.memTotalMB === 'number' &&
          typeof stats.gpu?.tempC === 'number',
        JSON.stringify(stats.gpu),
      );
    } else {
      /**
       * The brief requires the field to be *omitted* rather than nulled when
       * nvidia-smi is unavailable. A null would render as a "0%" GPU row on a
       * machine with integrated graphics, which is worse than no row.
       */
      check('GPU field is omitted entirely, not sent as null', stats.gpu === undefined && !gpuKeyPresent);
      check(
        'the agent explains the omission rather than erroring',
        !/error.*nvidia/i.test(agent.plainOutput),
      );
    }

    // -- history -------------------------------------------------------------
    check(
      'hello replays the rolling history so charts are not empty on load',
      Array.isArray(hello.history) && hello.history.length >= 3,
      `${hello.history?.length} samples replayed`,
    );
    check('history never exceeds the 120-sample cap', hello.history.length <= 120);

    const sample = hello.history[hello.history.length - 1];
    const sampleKeys = ['t', 'cpu', 'mem', 'diskR', 'diskW', 'netUp', 'netDown'];
    check(
      'each history sample has every charted field',
      sampleKeys.every((k) => typeof sample?.[k] === 'number'),
      JSON.stringify(sample),
    );
    check(
      'samples advance in time',
      hello.history.every((s, i) => i === 0 || s.t >= hello.history[i - 1].t),
    );
    check(
      'GPU series is present in samples only when a GPU is',
      gpuKeyPresent ? typeof sample.gpu === 'number' : sample.gpu === undefined,
    );

    /**
     * Values are rounded before being stored. Unrounded floats would make every
     * delta patch carry 17 significant digits per metric, for precision no chart
     * on a phone can display.
     */
    const overPrecise = hello.history.filter((s) =>
      [s.cpu, s.mem, s.diskR, s.diskW, s.netUp, s.netDown].some(
        (v) => typeof v === 'number' && String(v).replace(/^-?\d*\.?/, '').length > 3,
      ),
    );
    check('sample values are rounded to keep deltas small', overPrecise.length === 0, overPrecise.length ? JSON.stringify(overPrecise[0]) : '');

    /**
     * The same rounding has to apply to the state object, not just the history.
     * An unrounded rate is not merely verbose: a network counter reading a few
     * hundred idle bytes per second never repeats exactly, so the diff would
     * change every tick and idle traffic would never settle.
     */
    const rateFields = [
      ['disk.readMBs', stats.disk.readMBs, 2],
      ['disk.writeMBs', stats.disk.writeMBs, 2],
      ['net.upMBs', stats.net.upMBs, 3],
      ['net.downMBs', stats.net.downMBs, 3],
      ['cpu.loadPct', stats.cpu.loadPct, 1],
      ['mem.usedPct', stats.mem.usedPct, 1],
    ];
    const unrounded = rateFields.filter(
      ([, value, digits]) => String(value).replace(/^-?\d*\.?/, '').length > digits,
    );
    check(
      'state rates are rounded, not just the history samples',
      unrounded.length === 0,
      unrounded.map(([name, value]) => `${name}=${value}`).join(', '),
    );
    check(
      'uptime is whole seconds',
      Number.isInteger(stats.uptimeSec),
      String(stats.uptimeSec),
    );

    /**
     * With rounding in place an idle machine should produce at least one tick
     * where the throughput figures did not change at all, which is what keeps a
     * quiet LAN quiet. CPU and uptime still change every tick, so this looks
     * specifically at disk and net.
     */
    const throughputChanges = patchesForIdleCheck(frames);
    check(
      'idle throughput settles instead of diffing every tick',
      throughputChanges.stable > 0,
      `${throughputChanges.stable} of ${throughputChanges.total} ticks carried no disk/net change`,
    );

    // -- deltas --------------------------------------------------------------
    const patches = frames.filter((f) => f.type === 'patch');
    check('updates arrive as deltas, not full snapshots', patches.length >= 3 && !frames.some((f) => f.type === 'state'), `${patches.length} patches`);
    check(
      'deltas carry a new history sample each tick',
      patches.filter((p) => p.sample !== undefined).length >= 3,
      `${patches.filter((p) => p.sample !== undefined).length} of ${patches.length} carried a sample`,
    );
    /**
     * Asserts the diffing mechanism, using a field that provably changes.
     *
     * This used to require a changed CPU load, and failed on roughly two runs
     * in three: on an idle machine the rounded load really is identical tick
     * after tick, so no patch carries it -- that is the diff working, not
     * failing. Uptime advances every second by definition, so it tests the
     * same mechanism without depending on how busy the machine happens to be.
     */
    const withUptime = patches.filter((p) => p.patch?.stats?.uptimeSec !== undefined).length;
    check(
      'deltas carry the fields that actually changed',
      withUptime === patches.length,
      `${withUptime} of ${patches.length} patches carried the advancing uptime`,
    );
    /**
     * The delta must not resend the whole stats object every tick. Static fields
     * like the CPU brand string appearing in a patch would mean the diff is not
     * actually working.
     */
    check(
      'deltas omit unchanged static fields like the CPU brand',
      patches.every((p) => p.patch?.stats?.cpu?.brand === undefined),
    );

    // -- HTTP snapshot -------------------------------------------------------
    const httpState = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
    check('/api/state exposes the same stats for debugging', typeof httpState.state?.stats?.cpu?.loadPct === 'number');
    check('/api/state exposes the history', Array.isArray(httpState.history) && httpState.history.length >= 2);

    // -- the cost guard ------------------------------------------------------
    /**
     * The 1 Hz cadence is only affordable because nothing in the tick path shells
     * out. These calls were measured on this machine at 425ms (mem), 240ms
     * (networkStats), 479ms (cpuTemperature) and 1716ms (cpu) — using any of them
     * per tick would cost more than a second of CPU per second of wall clock.
     * fsStats and disksIO return null on Windows and are not usable at all.
     */
    const samplerSource = stripComments(
      readFileSync(path.join(REPO_ROOT, 'agent/src/stats/index.ts'), 'utf8'),
      'index.ts',
    );
    for (const banned of ['si.mem(', 'si.networkStats(', 'si.cpuTemperature(', 'si.fsStats(', 'si.disksIO(', 'si.cpu(']) {
      check(`sampler avoids the expensive ${banned})`, !samplerSource.includes(banned));
    }
    check(
      'sampler uses the free os module for memory and uptime',
      samplerSource.includes('os.totalmem()') && samplerSource.includes('os.freemem()') && samplerSource.includes('os.uptime()'),
    );
    check('sampler still uses si.currentLoad(), which is free', samplerSource.includes('si.currentLoad()'));

    // -- child process hygiene ----------------------------------------------
    check(
      'long-lived helper processes are used instead of per-tick spawns',
      /--loop-ms=/.test(readFileSync(path.join(REPO_ROOT, 'agent/src/stats/gpu.ts'), 'utf8')) &&
        /'-si', '1'/.test(readFileSync(path.join(REPO_ROOT, 'agent/src/stats/perfcounters.ts'), 'utf8')),
    );
  } finally {
    await agent.stop();
  }

  /**
   * A cleanly stopped agent kills typeperf itself. This harness terminates the
   * agent outright instead — the same thing a crash or Task Scheduler's "End
   * task" does — and Windows does not take children down with their parent.
   * typeperf also does not notice its stdout pipe closing, verified by killing an
   * agent and watching it run on indefinitely.
   *
   * So rather than assert something untrue, assert the bound: typeperf is spawned
   * with a sample cap, which retires any orphan within the hour. The audio host
   * solves the same problem properly by watching its parent pid, but that is only
   * possible because we control its code; typeperf is a Microsoft binary.
   */
  const perfSource = readFileSync(path.join(REPO_ROOT, 'agent/src/stats/perfcounters.ts'), 'utf8');
  check(
    'typeperf is spawned with a sample cap so an orphan cannot outlive the hour',
    /'-sc', String\(SAMPLE_LIMIT\)/.test(perfSource) && /const SAMPLE_LIMIT = 3600/.test(perfSource),
  );
  check(
    'reaching the sample cap restarts seamlessly rather than counting as a failure',
    /code === 0 && this\.#sawFirstDataLine/.test(perfSource),
  );

  return { results };
}

/**
 * Counts how many delta ticks carried no disk or network change at all. On an
 * otherwise idle machine some ticks should, which only happens if the rates are
 * rounded coarsely enough to repeat.
 */
function patchesForIdleCheck(frames) {
  const patches = frames.filter((f) => f.type === 'patch');
  let stable = 0;
  for (const patch of patches) {
    const s = patch.patch?.stats;
    if (s?.disk === undefined && s?.net === undefined) stable += 1;
  }
  return { stable, total: patches.length };
}


