import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { createLogger } from '../log.js';
import { WIN_HOST_SCRIPT } from './script.js';

const log = createLogger('winhost');

type HostChild = ChildProcessByStdio<Writable, Readable, Readable>;

/** Raw shape returned by the PowerShell host's `state` command. */
export interface RawSession {
  pid: number;
  process: string;
  name: string;
  volume: number;
  muted: boolean;
  /** AudioSessionState: 0 inactive, 1 active, 2 expired. */
  state: number;
  system: boolean;
}

export interface RawState {
  master: number;
  muted: boolean;
  sessions: RawSession[];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** Long enough to cover a COM stall, short enough that the UI is not stuck. */
const REQUEST_TIMEOUT_MS = 4000;
/** Add-Type compiles the C# on startup; measured ~600ms, allow generous headroom. */
const READY_TIMEOUT_MS = 30_000;
const MAX_RESTARTS = 4;
const RESTART_DELAY_MS = 3000;

/**
 * Owns the single long-lived PowerShell process used for all Windows-native work:
 * Core Audio (volume, per-app sessions) and media-key emulation.
 *
 * One process for both, rather than one per feature. `Add-Type` compiles the C#
 * interop in ~600ms, and that cost is paid once at startup; a second host would
 * double it and add a process for no benefit. It also means a media key and a
 * volume write are serialised through the same pipe, which is fine — both are
 * single-digit milliseconds.
 */
export class WinHost {
  /**
   * Distinguishes this instance's script file and log prefix.
   *
   * A second host is spawned for work that is slow enough to block the
   * interactive one — see MonitorService. Without a distinct filename both would
   * rewrite the same script while the other was starting.
   */
  readonly #tag: string;

  constructor(tag = 'winhost') {
    this.#tag = tag;
  }

  #child: HostChild | undefined;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #ready = false;
  #readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  #restarts = 0;
  #stopped = false;
  #restartTimer: NodeJS.Timeout | undefined;
  #fatalReason: string | undefined;
  #smtc = false;

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Whether the WinRT media-session API resolved inside the host. False on a
   * machine where the projection is unavailable, in which case media control
   * falls back to blind key emulation (milestone A).
   */
  get smtcAvailable(): boolean {
    return this.#smtc;
  }

  /** Set when the host cannot work at all and retrying is pointless. */
  get fatalReason(): string | undefined {
    return this.#fatalReason;
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      this.#fatalReason = 'Windows only';
      log.debug('not Windows; volume and media control unavailable');
      return;
    }
    this.#stopped = false;
    this.#spawn();
    await this.#waitReady();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    this.#failAllPending(new Error('windows host stopped'));
    this.#teardownChild();
  }

  /**
   * Sends a command and resolves with its `data`, or rejects.
   *
   * `timeoutMs` overrides the default for the rare command that is legitimately
   * slow — reading a monitor's capabilities string takes seconds, and timing it
   * out would lose the input list entirely.
   */
  request<T = unknown>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const child = this.#child;
    if (!child || !this.#ready) {
      return Promise.reject(new Error(this.#fatalReason ?? 'windows host not ready'));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`command "${cmd}" timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  #waitReady(): Promise<void> {
    if (this.#ready) return Promise.resolve();
    if (this.#fatalReason) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#ready && !this.#fatalReason) {
          this.#fatalReason = 'the Windows helper did not start in time';
          log.warn(this.#fatalReason);
        }
        resolve();
      }, READY_TIMEOUT_MS);
      timer.unref?.();
      this.#readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        // A failed start is not an exception here: the rest of the dashboard
        // must keep working without volume control.
        reject: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  #spawn(): void {
    if (this.#stopped) return;
    this.#buffer = '';
    this.#ready = false;

    let scriptPath: string;
    try {
      /**
       * A stable filename, rewritten on every start, rather than a fresh mkdtemp
       * directory. A unique directory per run has to be cleaned up, and anything
       * that only happens on graceful shutdown leaks when the agent is killed
       * outright. One always-current file cannot accumulate.
       *
       * -File rather than -Command so stdin stays free for the command loop.
       */
      scriptPath = path.join(os.tmpdir(), `pcr-${this.#tag}.ps1`);
      writeFileSync(scriptPath, WIN_HOST_SCRIPT, 'utf8');
    } catch (err) {
      this.#fatalReason = `could not write the Windows helper script: ${(err as Error).message}`;
      log.warn(this.#fatalReason);
      this.#releaseReadyWaiters();
      return;
    }

    let child: HostChild;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // The script is one we wrote ourselves moments ago; Bypass avoids
          // failing on machines with a restrictive default execution policy.
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          // The host exits on its own if this pid disappears, so a crashed or
          // force-killed agent cannot leave a PowerShell process behind. The
          // start time goes with it because pids get recycled — without it a
          // reused pid would keep an orphan alive indefinitely.
          String(process.pid),
          String(Math.round(Date.now() - process.uptime() * 1000)),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch (err) {
      this.#fatalReason = `could not start PowerShell: ${(err as Error).message}`;
      log.warn(this.#fatalReason);
      this.#releaseReadyWaiters();
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
      log.warn(`windows host error: ${err.message}`);
    });

    child.on('exit', (code) => {
      if (this.#stopped || this.#child !== child) return;
      this.#child = undefined;
      this.#ready = false;
      this.#failAllPending(new Error('windows host exited'));

      this.#restarts += 1;
      if (this.#restarts > MAX_RESTARTS) {
        this.#fatalReason = 'the Windows helper kept exiting; volume and media control disabled';
        log.warn(`${this.#fatalReason} (last exit code ${code})`);
        if (stderr.trim()) log.debug(`windows host stderr: ${stderr.trim().slice(0, 400)}`);
        this.#releaseReadyWaiters();
        return;
      }

      log.info(`windows host exited (code ${code}); restarting in ${RESTART_DELAY_MS / 1000}s`);
      if (stderr.trim()) log.debug(`windows host stderr: ${stderr.trim().slice(0, 400)}`);
      this.#restartTimer = setTimeout(() => this.#spawn(), RESTART_DELAY_MS);
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

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // PowerShell occasionally writes progress or warning text to stdout.
        log.debug(`ignoring non-JSON line from the Windows helper: ${trimmed.slice(0, 160)}`);
        continue;
      }

      if (msg['ready'] !== undefined) {
        if (msg['ready'] === true) {
          this.#ready = true;
          this.#restarts = 0;
          this.#smtc = msg['smtc'] === true;
          log.info(
            `Windows helper ready (Core Audio, media keys${this.#smtc ? ', media sessions' : ''})`,
          );
        } else {
          this.#fatalReason = String(msg['error'] ?? 'the Windows helper failed to initialise');
          log.warn(`Windows helper unavailable: ${this.#fatalReason}`);
        }
        this.#releaseReadyWaiters();
        continue;
      }

      const id = typeof msg['id'] === 'number' ? msg['id'] : undefined;
      if (id === undefined) continue;
      const pending = this.#pending.get(id);
      if (!pending) continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);

      if (msg['ok'] === true) pending.resolve(msg['data']);
      else pending.reject(new Error(String(msg['error'] ?? 'audio command failed')));
    }
  }

  #releaseReadyWaiters(): void {
    const waiters = this.#readyWaiters;
    this.#readyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  #failAllPending(err: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  #teardownChild(): void {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    // Closing stdin lets the script's read loop end cleanly; kill is the backstop.
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    child.kill();
  }

}
