import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { createLogger } from '../log.js';

/** stdin is 'ignore' (nothing is ever written to typeperf), so it types as null. */
type StreamingChild = ChildProcessByStdio<null, Readable, Readable>;

const log = createLogger('perf');

/**
 * Disk and network throughput on Windows, via a single long-lived `typeperf`.
 *
 * Why not systeminformation: on Windows 11 `si.fsStats()` and `si.disksIO()` both
 * return `null` outright, and `si.networkStats()` measured at ~240ms per call —
 * far too slow to run inside a 1 Hz tick. (For reference, `si.mem()` was 425ms
 * and `si.cpuTemperature()` 479ms on the same box, which is why neither is used
 * either.)
 *
 * `typeperf` is built into Windows and streams Performance Data Helper counters
 * to stdout on a fixed interval. One process for the lifetime of the agent
 * replaces ~60 process spawns per minute, and reading the latest parsed value
 * during a tick costs nothing.
 *
 * Requires the account to be in the Administrators or "Performance Log Users"
 * group. If it is not, typeperf exits with "No valid counters" and this degrades
 * to reporting no disk/network figures rather than failing the whole stats page.
 */

/** Counters requested, in the order they appear on the command line. */
const COUNTERS = [
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
  '\\Network Interface(*)\\Bytes Received/sec',
  '\\Network Interface(*)\\Bytes Sent/sec',
] as const;

type CounterKind = 'diskRead' | 'diskWrite' | 'netRx' | 'netTx';

/**
 * Maps a counter path's trailing name to our field. Matched on the suffix so the
 * `\\HOSTNAME\Object(instance)\` prefix that typeperf adds is irrelevant.
 *
 * These names are English. On a localised Windows install PDH counter names are
 * translated and none of them will resolve — typeperf then reports no valid
 * counters and disk/network are simply omitted. The language-neutral numeric
 * form (`\234(_Total)\220`) was tried and does not resolve on Windows 11 either,
 * so there is no better fallback to reach for.
 */
const COUNTER_SUFFIXES: [string, CounterKind][] = [
  ['\\disk read bytes/sec', 'diskRead'],
  ['\\disk write bytes/sec', 'diskWrite'],
  ['\\bytes received/sec', 'netRx'],
  ['\\bytes sent/sec', 'netTx'],
];

/**
 * Perf-counter instances that are not real traffic. The Network Interface object
 * can expose loopback and tunnel pseudo-adapters, and counting them would inflate
 * the figures.
 */
const IGNORED_INSTANCES = /loopback|pseudo|isatap|teredo|tunnel/i;

export interface ThroughputSample {
  diskReadBps: number;
  diskWriteBps: number;
  netRxBps: number;
  netTxBps: number;
}

interface Column {
  kind: CounterKind;
  instance: string;
  ignored: boolean;
}

/** Restart policy: stop trying after this many consecutive failures. */
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 5000;

/**
 * Samples to collect before typeperf exits and is restarted (1 per second, so
 * one hour).
 *
 * This bounds a leak rather than adding a feature. Windows does not terminate
 * children with their parent, and typeperf does not exit when the pipe it writes
 * to closes — verified by hard-killing the agent and watching it keep running
 * indefinitely. So if the agent is killed outright (Task Scheduler's "End task",
 * or a crash) rather than shut down cleanly, its typeperf would survive forever.
 * With a sample cap, any such orphan retires itself within the hour.
 *
 * The restart is seamless: a clean exit is not counted as a failure and respawns
 * immediately, so the gap in disk/network data is well under a second.
 */
const SAMPLE_LIMIT = 3600;

export class PerfCounterStream {
  #child: StreamingChild | undefined;
  #columns: Column[] | undefined;
  #buffer = '';
  #latest: ThroughputSample | undefined;
  #restarts = 0;
  #stopped = false;
  #restartTimer: NodeJS.Timeout | undefined;
  /**
   * The first data line of a rate counter is measured against process start
   * rather than a previous sample, which produces a meaningless spike. Skip it.
   */
  #sawFirstDataLine = false;

  /** Latest reading, or undefined if typeperf never produced a usable sample. */
  get latest(): ThroughputSample | undefined {
    return this.#latest;
  }

  get available(): boolean {
    return this.#latest !== undefined;
  }

  start(): void {
    if (process.platform !== 'win32') {
      log.debug('not Windows; disk and network throughput unavailable');
      return;
    }
    this.#stopped = false;
    this.#spawn();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child) {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      child.kill();
    }
  }

  #spawn(): void {
    if (this.#stopped) return;

    this.#buffer = '';
    this.#columns = undefined;
    this.#sawFirstDataLine = false;

    let child: StreamingChild;
    try {
      child = spawn('typeperf', [...COUNTERS, '-si', '1', '-sc', String(SAMPLE_LIMIT)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      log.warn(`could not start typeperf: ${(err as Error).message}`);
      return;
    }
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on('error', (err) => {
      if (this.#stopped) return;
      log.warn(`typeperf failed to run (${err.message}); disk and network stats disabled`);
      this.#child = undefined;
    });

    child.on('exit', (code) => {
      if (this.#stopped || this.#child !== child) return;
      this.#child = undefined;

      // typeperf prints this when the account lacks perf-counter access. It will
      // never succeed on a retry, so say so once and stop rather than looping.
      if (/No valid counters/i.test(stderr) || /No valid counters/i.test(this.#buffer)) {
        log.warn(
          'typeperf reports no valid counters, so disk and network throughput are ' +
            'unavailable. Add your account to the "Performance Log Users" group ' +
            '(or run the agent elevated) to enable them.',
        );
        return;
      }

      // Exit code 0 means the sample cap was reached, which is expected once an
      // hour. Respawn straight away and do not hold it against the retry budget.
      if (code === 0 && this.#sawFirstDataLine) {
        log.debug('typeperf reached its sample cap; restarting');
        this.#spawn();
        return;
      }

      this.#restarts += 1;
      if (this.#restarts > MAX_RESTARTS) {
        log.warn(`typeperf exited ${this.#restarts} times; giving up on disk and network stats`);
        return;
      }
      log.info(`typeperf exited (code ${code}); restarting in ${RESTART_DELAY_MS / 1000}s`);
      this.#restartTimer = setTimeout(() => this.#spawn(), RESTART_DELAY_MS);
      this.#restartTimer.unref?.();
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    // Keep the trailing partial line in the buffer for the next chunk.
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (this.#columns === undefined) {
        // The header is the first line starting with the PDH version marker.
        if (trimmed.startsWith('"(PDH-CSV')) {
          this.#columns = parseHeader(trimmed);
          const active = this.#columns.filter((c) => !c.ignored).length;
          log.info(`streaming ${active} performance counters via typeperf`);
          // A successful header means the process is healthy; reset the counter
          // so an unrelated failure much later still gets its full retries.
          this.#restarts = 0;
        }
        continue;
      }
      this.#onDataLine(trimmed);
    }
  }

  #onDataLine(line: string): void {
    const fields = parseCsvLine(line);
    // Field 0 is the timestamp; anything shorter than that plus one value is noise
    // like typeperf's "Exiting, please wait..." message.
    if (fields.length < 2) return;
    if (!/^\d{2}\/\d{2}\/\d{4}/.test(fields[0] ?? '')) return;

    if (!this.#sawFirstDataLine) {
      this.#sawFirstDataLine = true;
      return;
    }

    const totals: ThroughputSample = {
      diskReadBps: 0,
      diskWriteBps: 0,
      netRxBps: 0,
      netTxBps: 0,
    };

    const columns = this.#columns ?? [];
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i];
      if (!column || column.ignored) continue;
      const raw = fields[i + 1];
      const value = raw === undefined || raw === '' ? NaN : Number(raw);
      if (!Number.isFinite(value) || value < 0) continue;

      switch (column.kind) {
        case 'diskRead':
          totals.diskReadBps += value;
          break;
        case 'diskWrite':
          totals.diskWriteBps += value;
          break;
        // Network Interface(*) expands to one column per adapter, so these sum
        // across every real NIC. A machine bridging traffic between two of its
        // own adapters would therefore count it twice.
        case 'netRx':
          totals.netRxBps += value;
          break;
        case 'netTx':
          totals.netTxBps += value;
          break;
      }
    }

    this.#latest = totals;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Minimal quoted-CSV splitter. typeperf quotes every field; instance names can
 * legitimately contain commas, so splitting on "," naively would misalign every
 * column after the offending one.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // A doubled quote inside a quoted field is a literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

/**
 * Maps each header column to a counter kind and instance. Column 0 is the
 * "(PDH-CSV 4.0)" marker and is dropped, so the returned array is aligned with
 * data fields 1..n.
 */
export function parseHeader(headerLine: string): Column[] {
  const fields = parseCsvLine(headerLine).slice(1);
  return fields.map((path) => {
    const lower = path.toLowerCase();
    const match = COUNTER_SUFFIXES.find(([suffix]) => lower.endsWith(suffix));
    // The instance is the last parenthesised group, e.g.
    // \\HOST\Network Interface(Intel[R] Wireless-AC 9560)\Bytes Received/sec
    const instance = /\(([^()]*)\)[^()]*$/.exec(path)?.[1] ?? '';
    return {
      kind: match?.[1] ?? 'diskRead',
      instance,
      ignored: match === undefined || IGNORED_INSTANCES.test(instance),
    };
  });
}
