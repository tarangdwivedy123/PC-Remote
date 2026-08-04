import os from 'node:os';

import si from 'systeminformation';

import type { CpuStats, MemStats, Stats, StatsSample } from '@pcr/shared';

import { createLogger } from '../log.js';
import type { StateHub } from '../state.js';
import { GpuMonitor } from './gpu.js';
import { PerfCounterStream } from './perfcounters.js';

const log = createLogger('stats');

const BYTES_PER_MB = 1024 * 1024;

/**
 * Samples system stats once a second and pushes them into the state hub.
 *
 * The cadence is only affordable because every source read during a tick is
 * effectively free. That is a deliberate design constraint, not an accident —
 * measured on the target machine (i3-9100T, 4 cores):
 *
 *   si.currentLoad()      0ms    pure Node, os.cpus() time deltas
 *   os.freemem()          0ms
 *   os.uptime()           0ms
 *   typeperf stream       0ms    value already parsed by a background process
 *   nvidia-smi stream     0ms    ditto
 *
 * The obvious implementations of the same feature are not viable here:
 * si.mem() measured 425ms, si.networkStats() 240ms, si.cpuTemperature() 479ms,
 * and si.cpu() 1716ms. Calling those on a 1 Hz timer would spend more than a
 * second of CPU per second of wall clock, so a monitoring tool would become the
 * thing worth monitoring. si.fsStats() and si.disksIO() are not options at all:
 * both return null on Windows.
 */
export class StatsSampler {
  #hub: StateHub;
  #timer: NodeJS.Timeout | undefined;
  #perf = new PerfCounterStream();
  #gpu = new GpuMonitor();

  /** Static CPU identity, read once from os.cpus() rather than si.cpu(). */
  #cpuBrand: string;
  #cpuCores: number;
  #sampling = false;

  constructor(hub: StateHub) {
    this.#hub = hub;
    const cpus = os.cpus();
    // os.cpus()[0].model is the same brand string si.cpu() returns, for free.
    this.#cpuBrand = (cpus[0]?.model ?? 'CPU').replace(/\s+/g, ' ').trim();
    this.#cpuCores = cpus.length;
  }

  async start(): Promise<void> {
    this.#perf.start();
    // Probing the GPU shells out once; do not block the server on it.
    void this.#gpu.start().catch((err) => log.debug('GPU probe failed:', err));

    // Prime si.currentLoad() so the first real sample is a delta against a
    // baseline rather than an average since boot.
    await si.currentLoad().catch(() => undefined);

    await this.#sample();
    this.#timer = setInterval(() => void this.#sample(), 1000);
    log.info(`sampling every 1000ms (${this.#cpuCores} logical cores)`);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#perf.stop();
    this.#gpu.stop();
  }

  async #sample(): Promise<void> {
    // Guard against overlap. si.currentLoad() is fast but not instantaneous, and
    // two concurrent calls would each compute a delta against the same baseline.
    if (this.#sampling) return;
    this.#sampling = true;

    try {
      const cpu = await this.#readCpu();
      const mem = readMemory();
      const throughput = this.#perf.latest;
      const gpu = this.#gpu.latest;

      /**
       * Everything is rounded before it reaches the state object, not just on the
       * way into the history buffer.
       *
       * Precision the phone cannot display is not free: an unrounded rate carries
       * ~17 significant digits per field, and — worse — a network counter reading
       * a few hundred idle bytes per second never repeats exactly. That
       * guarantees a diff on every single tick and defeats the whole point of
       * sending deltas. Rounded to 1 KB/s, an idle machine's disk and network
       * figures are genuinely identical between ticks and drop out of the patch.
       *
       * Resolution kept: 10 KB/s for disk, 1 KB/s for network.
       */
      const stats: Stats = {
        cpu,
        mem,
        disk: {
          readMBs: round((throughput?.diskReadBps ?? 0) / BYTES_PER_MB, 2),
          writeMBs: round((throughput?.diskWriteBps ?? 0) / BYTES_PER_MB, 2),
        },
        net: {
          upMBs: round((throughput?.netTxBps ?? 0) / BYTES_PER_MB, 3),
          downMBs: round((throughput?.netRxBps ?? 0) / BYTES_PER_MB, 3),
        },
        // Whole seconds: the fractional part is noise, and it changes every tick
        // regardless so it is always in the patch anyway.
        uptimeSec: Math.floor(os.uptime()),
        // Spread rather than `gpu: gpu` so the key is absent, not null, when
        // there is no GPU. The delta patch then removes it from client state if a
        // GPU disappears mid-session.
        ...(gpu === undefined ? {} : { gpu: roundGpu(gpu) }),
      };

      this.#hub.setStats(stats);

      // Already-rounded values, so the sample and the state cannot disagree.
      const sample: StatsSample = {
        t: Date.now(),
        cpu: cpu.loadPct,
        mem: mem.usedPct,
        diskR: stats.disk.readMBs,
        diskW: stats.disk.writeMBs,
        netUp: stats.net.upMBs,
        netDown: stats.net.downMBs,
        ...(stats.gpu === undefined
          ? {}
          : {
              gpu: stats.gpu.utilPct,
              gpuMem:
                stats.gpu.memTotalMB > 0
                  ? round((stats.gpu.memUsedMB / stats.gpu.memTotalMB) * 100, 1)
                  : 0,
            }),
      };
      this.#hub.pushSample(sample);
    } catch (err) {
      // A failed sample must not stop the timer: a transient WMI hiccup should
      // cost one data point, not the whole stats feed.
      log.debug('sample failed:', err);
    } finally {
      this.#sampling = false;
    }
  }

  async #readCpu(): Promise<CpuStats> {
    try {
      const load = await si.currentLoad();
      return {
        loadPct: clampPct(load.currentLoad),
        perCorePct: load.cpus.map((core) => clampPct(core.load)),
        brand: this.#cpuBrand,
        cores: this.#cpuCores,
      };
    } catch {
      return {
        loadPct: 0,
        perCorePct: new Array<number>(this.#cpuCores).fill(0),
        brand: this.#cpuBrand,
        cores: this.#cpuCores,
      };
    }
  }
}

/**
 * RAM from the os module rather than si.mem(), which costs 425ms on Windows for
 * no extra information: on this platform si reports `active` equal to `used` and
 * `buffcache` as 0, so os.totalmem()/os.freemem() carry the same numbers.
 */
function readMemory(): MemStats {
  const totalBytes = os.totalmem();
  const usedBytes = Math.max(0, totalBytes - os.freemem());
  return {
    usedBytes,
    totalBytes,
    usedPct: totalBytes > 0 ? clampPct((usedBytes / totalBytes) * 100) : 0,
  };
}

/**
 * nvidia-smi reports whole numbers today, but rounding here means a future driver
 * reporting fractional utilisation cannot reintroduce per-tick float churn.
 */
function roundGpu(gpu: NonNullable<Stats['gpu']>): NonNullable<Stats['gpu']> {
  return {
    ...(gpu.name === undefined ? {} : { name: gpu.name }),
    utilPct: round(gpu.utilPct, 1),
    memUsedMB: Math.round(gpu.memUsedMB),
    memTotalMB: Math.round(gpu.memTotalMB),
    tempC: Math.round(gpu.tempC),
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return round(Math.min(100, Math.max(0, value)), 1);
}

/** Rounding keeps the delta patches small: 12.3 instead of 12.299999999998. */
function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
