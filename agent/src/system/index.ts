import { execFile } from 'node:child_process';

import type { SystemState } from '@pcr/shared';

import { createLogger } from '../log.js';
import type { StateHub } from '../state.js';
import type { WinHost } from '../winhost/host.js';

const log = createLogger('system');

export type SystemAction = 'lock' | 'sleep' | 'displayOff' | 'shutdown' | 'restart';

/**
 * Set `PCR_SYSTEM_DRY_RUN=1` to log system actions instead of performing them.
 *
 * This exists so the verification suite can exercise the whole path — command
 * validation, the confirm-token gate, routing, the ack — without suspending or
 * powering off the machine running it. There is no way to test "shutdown works"
 * for real in an automated suite that expects to keep running afterwards.
 */
const DRY_RUN = process.env['PCR_SYSTEM_DRY_RUN'] === '1';

/** Clipboard mirror cadence, and the cap on what is mirrored. */
const CLIPBOARD_POLL_MS = 1500;
/**
 * Enough for a link, a command, or a paragraph. This rides in every state
 * broadcast the text changes on, so mirroring a whole document would be a poor
 * trade for a feature meant to move short things between screens.
 */
const CLIPBOARD_MAX_CHARS = 4000;

/**
 * Lock, sleep, display-off, shutdown, restart.
 *
 * The first three go through the interop host as direct API calls. Shutdown and
 * restart invoke Windows' own `shutdown.exe`, because doing it in-process needs
 * the SE_SHUTDOWN_NAME privilege enabled on the token — more machinery than the
 * task deserves.
 *
 * The arguments to `shutdown.exe` are fixed constants. Nothing from a client
 * frame reaches a command line anywhere in this file, which is what the brief
 * means by "no other shell execution surface": this is five specific actions,
 * not a way to run things.
 */
export class SystemService {
  #host: WinHost;
  #hub: StateHub;

  /** Armed sleep timer, if any. */
  #sleepTimer: NodeJS.Timeout | undefined;
  #sleepAt: number | undefined;

  /**
   * Mirror of the PC's clipboard, so a copy on the desk is available on the
   * phone. Polled rather than event-driven: Windows can notify on clipboard
   * change, but only to a window with a message loop, which this agent does not
   * have. A second-granularity poll of a string is cheap by comparison.
   */
  #clipboardTimer: NodeJS.Timeout | undefined;
  #clipboard: string | undefined;
  #clipboardAt: number | undefined;
  #reading = false;

  constructor(hub: StateHub, host: WinHost) {
    this.#hub = hub;
    this.#host = host;
    if (DRY_RUN) log.warn('system actions are in DRY RUN mode — they will be logged, not performed');
    this.#publish();
  }

  start(): void {
    if (!this.#host.ready) return;
    void this.#readClipboard();
    this.#clipboardTimer = setInterval(() => void this.#readClipboard(), CLIPBOARD_POLL_MS);
    this.#clipboardTimer.unref?.();
  }

  stop(): void {
    this.#cancelSleepTimer();
    if (this.#clipboardTimer) clearInterval(this.#clipboardTimer);
    this.#clipboardTimer = undefined;
  }

  async #readClipboard(): Promise<void> {
    if (this.#reading || !this.#host.ready) return;
    this.#reading = true;
    try {
      const result = await this.#host.request<{ text: string }>('getClipboard');
      const text = (result?.text ?? '').slice(0, CLIPBOARD_MAX_CHARS);
      if (text !== this.#clipboard) {
        this.#clipboard = text;
        // Only stamped on a real change, so the phone can tell "new copy" from
        // "same text still there" without diffing the string itself.
        this.#clipboardAt = Date.now();
        this.#publish();
      }
    } catch {
      // The clipboard is frequently locked by whichever app is using it. Missing
      // one poll is invisible; the next one picks it up.
    } finally {
      this.#reading = false;
    }
  }

  #publish(): void {
    const state: SystemState = {
      canSend: this.#host.ready,
      ...(this.#sleepAt === undefined ? {} : { sleepAt: this.#sleepAt }),
      ...(this.#clipboard ? { clipboard: this.#clipboard, clipboardAt: this.#clipboardAt } : {}),
    };
    this.#hub.setSystem(state);
  }

  #cancelSleepTimer(): void {
    if (this.#sleepTimer) clearTimeout(this.#sleepTimer);
    this.#sleepTimer = undefined;
    this.#sleepAt = undefined;
  }

  /**
   * Arms or cancels a delayed sleep. `minutes` of 0 cancels.
   *
   * The phone is sent the absolute time it will fire rather than a ticking
   * number, so the countdown is rendered locally and a dropped frame cannot make
   * the clock jump or stall.
   */
  sleepTimer(minutes: number): void {
    this.#cancelSleepTimer();

    if (minutes <= 0) {
      log.info('sleep timer cancelled');
      this.#publish();
      return;
    }

    const ms = minutes * 60_000;
    this.#sleepAt = Date.now() + ms;
    this.#sleepTimer = setTimeout(() => {
      this.#sleepTimer = undefined;
      this.#sleepAt = undefined;
      this.#publish();
      log.warn('sleep timer elapsed');
      void this.run('sleep').catch((err) => log.error('scheduled sleep failed:', err));
    }, ms);
    // Deliberately NOT unref'd: an armed timer is a reason to keep running.
    log.info(`sleep timer armed for ${minutes} minute(s)`);
    this.#publish();
  }

  /** Puts text on the PC's clipboard. */
  async sendText(text: string): Promise<void> {
    if (!this.#host.ready) throw new Error('The Windows helper is not running');
    await this.#host.request('setClipboard', { text });
    log.info(`copied ${text.length} character(s) to the clipboard`);
    // Reflect it at once rather than waiting up to a second for the poll, so the
    // phone's own mirror agrees with what it just sent.
    this.#clipboard = text.slice(0, CLIPBOARD_MAX_CHARS);
    this.#clipboardAt = Date.now();
    this.#publish();
  }

  /**
   * Opens a link in the PC's default browser.
   *
   * The scheme is validated by zod before this and again inside the host before
   * ShellExecute. This is the only path in the project that can start an
   * arbitrary process, so it gets checked on both sides of the pipe.
   */
  async openUrl(url: string): Promise<void> {
    if (!this.#host.ready) throw new Error('The Windows helper is not running');
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links can be opened');
    log.info(`opening ${url.slice(0, 120)}`);
    await this.#host.request('openUrl', { url });
  }

  get dryRun(): boolean {
    return DRY_RUN;
  }

  async run(action: SystemAction): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('System actions are Windows-only');
    }

    if (DRY_RUN) {
      log.info(`[dry run] would ${action}`);
      return;
    }

    // Loud on purpose. If one of these ever fires unexpectedly, the console log
    // is the only record of who asked and when.
    log.warn(`system action: ${action}`);

    if (action === 'shutdown' || action === 'restart') {
      await this.#shutdown(action);
      return;
    }

    if (!this.#host.ready) {
      throw new Error('The Windows helper is not running');
    }
    const result = await this.#host.request<{ applied: boolean }>('system', { action });
    if (!result?.applied) {
      throw new Error(`Windows refused the ${action} request`);
    }
  }

  /**
   * `/t 0` because the phone already asked twice; a further 30-second countdown
   * would just be confusing. `/f` is deliberately omitted so an application with
   * unsaved work can still block it — losing work to a mis-tap on a phone would
   * be a bad trade for a tidier shutdown.
   */
  #shutdown(action: 'shutdown' | 'restart'): Promise<void> {
    const args = action === 'shutdown' ? ['/s', '/t', '0'] : ['/r', '/t', '0'];
    return new Promise((resolve, reject) => {
      execFile('shutdown', args, { windowsHide: true, timeout: 10_000 }, (err, _stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message || '').trim().slice(0, 200);
          reject(new Error(detail || `shutdown.exe failed for ${action}`));
          return;
        }
        resolve();
      });
    });
  }
}
