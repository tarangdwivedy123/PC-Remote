import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { GpuStats } from '@pcr/shared';

import { createLogger } from '../log.js';

const log = createLogger('gpu');

/** stdin is 'ignore' (nvidia-smi takes no input), so it types as null. */
type StreamingChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * NVIDIA GPU stats via nvidia-smi.
 *
 * A one-shot probe runs first to find out whether nvidia-smi exists at all and to
 * read the GPU name. If it does, a second process is started with `--loop-ms` and
 * left running: nvidia-smi takes 100-300ms to start, so spawning it once per
 * second would spend a meaningful slice of a weak CPU doing nothing but process
 * creation.
 *
 * Absence is entirely normal — integrated graphics, an AMD card, a driver that
 * has not loaded yet — so every failure path here leads to `latest` staying
 * undefined and the `gpu` field being omitted from the broadcast rather than sent
 * as null. The client keys off the field's presence.
 */

/** Exactly the query from the project brief, plus the name for the UI. */
const QUERY_FIELDS = 'utilization.gpu,memory.used,memory.total,temperature.gpu';
const PROBE_ARGS = [
  `--query-gpu=name,${QUERY_FIELDS}`,
  '--format=csv,noheader,nounits',
];

/** nvidia-smi can hang for many seconds when the driver is wedged. */
const PROBE_TIMEOUT_MS = 5000;
const SAMPLE_INTERVAL_MS = 1000;
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 10_000;

export class GpuMonitor {
  #child: StreamingChild | undefined;
  #latest: GpuStats | undefined;
  #name: string | undefined;
  #buffer = '';
  #restarts = 0;
  #stopped = false;
  #restartTimer: NodeJS.Timeout | undefined;
  /** Set once we know there is no NVIDIA GPU, so nothing retries. */
  #unavailable = false;

  /**
   * Undefined when there is no usable GPU. Callers must omit the field entirely
   * rather than substituting null, so a GPU that disappears mid-session is
   * removed from client state by the delta patch.
   */
  get latest(): GpuStats | undefined {
    return this.#latest;
  }

  get available(): boolean {
    return !this.#unavailable;
  }

  async start(): Promise<void> {
    this.#stopped = false;

    const probe = await this.#probe();
    if (!probe) {
      this.#unavailable = true;
      return;
    }
    this.#name = probe.name;
    this.#latest = probe.stats;
    log.info(`monitoring ${probe.name}`);
    this.#spawnStream();
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

  /** One-shot run to establish whether nvidia-smi works and what the GPU is. */
  #probe(): Promise<{ name: string; stats: GpuStats } | undefined> {
    return new Promise((resolve) => {
      execFile(
        'nvidia-smi',
        PROBE_ARGS,
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              // Overwhelmingly the common case: no NVIDIA driver installed.
              log.debug('nvidia-smi not found; GPU stats omitted');
            } else if ((err as { killed?: boolean }).killed) {
              log.warn('nvidia-smi timed out; GPU stats omitted');
            } else {
              log.debug(`nvidia-smi failed (${err.message}); GPU stats omitted`);
            }
            resolve(undefined);
            return;
          }

          const firstLine = stdout.split(/\r?\n/).find((l) => l.trim() !== '');
          if (!firstLine) {
            log.debug('nvidia-smi returned no rows; GPU stats omitted');
            resolve(undefined);
            return;
          }
          const parsed = parseProbeLine(firstLine);
          if (!parsed) {
            log.warn(`could not parse nvidia-smi output: ${firstLine.slice(0, 120)}`);
            resolve(undefined);
            return;
          }
          resolve(parsed);
        },
      );
    });
  }

  #spawnStream(): void {
    if (this.#stopped) return;
    this.#buffer = '';

    let child: StreamingChild;
    try {
      child = spawn(
        'nvidia-smi',
        [
          `--query-gpu=${QUERY_FIELDS}`,
          '--format=csv,noheader,nounits',
          `--loop-ms=${SAMPLE_INTERVAL_MS}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (err) {
      log.warn(`could not start the nvidia-smi stream: ${(err as Error).message}`);
      return;
    }
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) log.debug(`nvidia-smi: ${message.slice(0, 200)}`);
    });

    child.on('error', (err) => {
      if (this.#stopped) return;
      log.warn(`nvidia-smi stream error: ${err.message}`);
      this.#child = undefined;
    });

    child.on('exit', (code) => {
      if (this.#stopped || this.#child !== child) return;
      this.#child = undefined;
      this.#restarts += 1;

      if (this.#restarts > MAX_RESTARTS) {
        log.warn(`nvidia-smi exited ${this.#restarts} times; dropping GPU stats`);
        // Keep the last reading rather than blanking the card: a stale number
        // with the driver gone is less confusing than the row vanishing.
        return;
      }
      log.info(`nvidia-smi exited (code ${code}); restarting in ${RESTART_DELAY_MS / 1000}s`);
      this.#restartTimer = setTimeout(() => this.#spawnStream(), RESTART_DELAY_MS);
      this.#restartTimer.unref?.();
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const stats = parseSampleLine(trimmed, this.#name);
      if (stats) {
        this.#latest = stats;
        this.#restarts = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing — exported so the verification suite can exercise it without a GPU
// ---------------------------------------------------------------------------

/**
 * nvidia-smi reports unsupported fields as the literal strings "[N/A]" or
 * "[Not Supported]", which Number() would turn into NaN and ship to the client.
 */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.startsWith('[')) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** Parses `name, util, memUsed, memTotal, temp` from the probe. */
export function parseProbeLine(line: string): { name: string; stats: GpuStats } | undefined {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 5) return undefined;
  const name = parts[0] ?? 'NVIDIA GPU';
  const stats = buildStats(parts.slice(1), name);
  return stats ? { name, stats } : undefined;
}

/** Parses `util, memUsed, memTotal, temp` from the streaming process. */
export function parseSampleLine(line: string, name: string | undefined): GpuStats | undefined {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length < 4) return undefined;
  return buildStats(parts, name);
}

function buildStats(parts: string[], name: string | undefined): GpuStats | undefined {
  const utilPct = parseNumber(parts[0]);
  const memUsedMB = parseNumber(parts[1]);
  const memTotalMB = parseNumber(parts[2]);
  const tempC = parseNumber(parts[3]);

  // Utilisation is the one field worth insisting on; without it the row has
  // nothing to show. The rest default to 0 so a card that does not report
  // temperature still renders.
  if (utilPct === undefined) return undefined;

  return {
    ...(name === undefined ? {} : { name }),
    utilPct,
    memUsedMB: memUsedMB ?? 0,
    memTotalMB: memTotalMB ?? 0,
    tempC: tempC ?? 0,
  };
}
