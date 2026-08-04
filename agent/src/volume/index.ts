import type { AudioDevice, AudioSession, VolumeState } from '@pcr/shared';

import { createLogger } from '../log.js';
import type { StateHub } from '../state.js';
import type { RawSession, RawState } from '../winhost/host.js';
import type { WinHost } from '../winhost/host.js';

const log = createLogger('volume');

/** AudioSessionState values from the Core Audio API. */
const STATE_INACTIVE = 0;
const STATE_ACTIVE = 1;
const STATE_EXPIRED = 2;

const POLL_INTERVAL_MS = 1000;

/**
 * How often the microphone peak is sampled, and how many samples are kept.
 *
 * 150ms is fast enough to look alive and slow enough that it is a rounding error
 * next to the interop host's other work. Forty samples is six seconds of history,
 * which is the whole width of the meter on screen.
 */
const MIC_PEAK_INTERVAL_MS = 150;
const MIC_PEAK_SAMPLES = 40;

/**
 * Output devices change only when hardware is plugged in or a monitor wakes, so
 * this is far slower than the volume poll. Enumerating them opens a property
 * store per device, which is not something to do every second for a list that is
 * almost always identical.
 */
const DEVICE_POLL_MS = 5000;

/**
 * Coalescing window for inbound writes. The brief asks for ~100ms so a slider
 * drag does not spawn 50 processes; with a long-lived host there is nothing to
 * spawn, but coalescing still keeps a fast drag from queueing dozens of COM
 * round-trips behind each other.
 */
const WRITE_COALESCE_MS = 100;

interface PendingWrite {
  volume?: number;
  muted?: boolean;
}

export class VolumeService {
  #hub: StateHub;
  /** Shared with the media service; this class does not own its lifecycle. */
  #host: WinHost;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;

  /** Keyed by session id, or the literal 'master'. */
  #pendingWrites = new Map<string, PendingWrite>();
  #flushTimer: NodeJS.Timeout | undefined;

  /**
   * Values written locally but not yet confirmed by a poll.
   *
   * Without this the slider fights the user: a drag to 20% is followed a few
   * hundred milliseconds later by a poll that still reports the old value, and
   * the thumb jumps back until the next poll catches up.
   */
  #optimistic = new Map<string, { value: PendingWrite; until: number }>();

  constructor(hub: StateHub, host: WinHost) {
    this.#hub = hub;
    this.#host = host;
  }

  async start(): Promise<void> {
    // The host is started by the caller, since the media service shares it.
    if (!this.#host.ready) {
      const reason = this.#host.fatalReason ?? 'audio host unavailable';
      log.warn(`volume control disabled: ${reason}`);
      this.#hub.setVolume({ master: 0, muted: false, sessions: [], unavailable: true, reason });
      return;
    }

    await this.#poll();
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS);

    // Only started once a microphone is known to exist, so a machine without one
    // does not pay for a timer that can never produce anything.
    if (this.#mic) {
      this.#micPeakTimer = setInterval(() => void this.#samplePeak(), MIC_PEAK_INTERVAL_MS);
      this.#micPeakTimer.unref?.();
    }

    await this.#listDevices();
    this.#deviceTimer = setInterval(() => void this.#listDevices(), DEVICE_POLL_MS);
    this.#deviceTimer.unref?.();
    log.info('volume control ready');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#micPeakTimer) clearInterval(this.#micPeakTimer);
    this.#micPeakTimer = undefined;
    if (this.#deviceTimer) clearInterval(this.#deviceTimer);
    this.#deviceTimer = undefined;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    // The host is stopped by the owner in index.ts, not here.
  }

  // -- commands ------------------------------------------------------------

  setMaster(volume: number): void {
    this.#queue('master', { volume });
  }

  setMasterMuted(muted: boolean): void {
    this.#queue('master', { muted });
  }

  setApp(id: string, volume: number): void {
    this.#queue(id, { volume });
  }

  setAppMuted(id: string, muted: boolean): void {
    this.#queue(id, { muted });
  }

  /**
   * Mute or unmute the default recording device.
   *
   * Written straight through rather than coalesced: it is a single toggle, not a
   * drag, and on a call the latency between tapping and actually being muted is
   * the thing that matters.
   */
  async setMicMuted(muted: boolean): Promise<void> {
    if (!this.#host.ready) throw new Error('Audio control is unavailable');
    await this.#host.request('setMicMute', { muted });
    // Reflect it at once so the button does not appear to lag the mute itself.
    if (this.#mic) this.#mic = { ...this.#mic, muted };
    await this.#poll();
  }

  /**
   * Records a write and schedules a flush. A second write to the same target
   * inside the window replaces the first, so dragging a slider sends one COM call
   * per 100ms rather than one per pixel.
   */
  #queue(target: string, patch: PendingWrite): void {
    if (!this.#host.ready) return;

    const existing = this.#pendingWrites.get(target) ?? {};
    this.#pendingWrites.set(target, { ...existing, ...patch });

    // Reflect it immediately so the phone's slider does not snap back while the
    // write is in flight.
    this.#applyOptimistic(target, patch);

    if (this.#flushTimer === undefined) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = undefined;
        void this.#flush();
      }, WRITE_COALESCE_MS);
      this.#flushTimer.unref?.();
    }
  }

  async #flush(): Promise<void> {
    const writes = [...this.#pendingWrites];
    this.#pendingWrites.clear();
    if (writes.length === 0) return;

    for (const [target, patch] of writes) {
      try {
        if (target === 'master') {
          if (patch.volume !== undefined) {
            await this.#host.request('setMaster', { volume: clamp01(patch.volume / 100) });
          }
          if (patch.muted !== undefined) {
            await this.#host.request('setMasterMute', { muted: patch.muted });
          }
          continue;
        }

        const parsed = parseSessionId(target);
        if (!parsed) {
          log.debug(`ignoring write to malformed session id "${target}"`);
          continue;
        }
        if (patch.volume !== undefined) {
          const applied = await this.#host.request<RawState>('setApp', {
            pid: parsed.pid,
            process: parsed.process,
            volume: clamp01(patch.volume / 100),
          });
          void applied;
        }
        if (patch.muted !== undefined) {
          await this.#host.request('setAppMute', {
            pid: parsed.pid,
            process: parsed.process,
            muted: patch.muted,
          });
        }
      } catch (err) {
        // A failed write is not fatal: the app may have exited mid-drag. The next
        // poll re-reads the truth and the UI corrects itself.
        log.debug(`volume write to ${target} failed:`, err);
      }
    }

    // Refresh right away rather than waiting up to a second for the next tick.
    await this.#poll();
  }

  #applyOptimistic(target: string, patch: PendingWrite): void {
    const existing = this.#optimistic.get(target)?.value ?? {};
    this.#optimistic.set(target, {
      value: { ...existing, ...patch },
      // Long enough to cover the coalesce window plus a poll; after that the
      // device is the authority again, so an external change (someone using the
      // Windows mixer) is not masked for long.
      until: Date.now() + WRITE_COALESCE_MS + POLL_INTERVAL_MS + 500,
    });
    this.#publish(this.#lastRaw, true);
  }

  // -- polling -------------------------------------------------------------

  #lastRaw: RawState | undefined;

  /**
   * Last microphone reading. Held separately from the speaker state because a
   * machine with no recording device is ordinary, and the two are read with
   * separate calls that can fail independently.
   */
  #mic: { muted: boolean; volume: number } | undefined;
  #outputs: AudioDevice[] = [];
  #deviceTimer: NodeJS.Timeout | undefined;
  #enumerating = false;
  #micLevels: number[] = [];
  #micPeakTimer: NodeJS.Timeout | undefined;
  #peaking = false;

  async #poll(): Promise<void> {
    if (this.#polling || !this.#host.ready) return;
    this.#polling = true;
    try {
      const raw = await this.#host.request<RawState>('state');
      this.#lastRaw = raw;

      try {
        const mic = await this.#host.request<{ available: boolean; muted?: boolean; volume?: number }>(
          'micState',
        );
        this.#mic = mic?.available
          ? { muted: mic.muted === true, volume: Math.round(mic.volume ?? 0) }
          : undefined;
      } catch (err) {
        log.debug('microphone poll failed:', err);
      }

      this.#publish(raw, false);
    } catch (err) {
      log.debug('volume poll failed:', err);
    } finally {
      this.#polling = false;
    }
  }

  async #listDevices(): Promise<void> {
    if (this.#enumerating || !this.#host.ready) return;
    this.#enumerating = true;
    try {
      const result = await this.#host.request<{ devices: AudioDevice[] }>('audioDevices');
      this.#outputs = result?.devices ?? [];
      this.#publish(this.#lastRaw, false);
    } catch (err) {
      log.debug('audio device enumeration failed:', err);
    } finally {
      this.#enumerating = false;
    }
  }

  /**
   * Switches the system's playback device.
   *
   * Note the singular. Windows routes a render stream to exactly one endpoint,
   * and offers no API to send the same audio to several at once — the setups
   * that appear to do it use a virtual audio driver that presents as one device
   * and fans out internally.
   */
  async setOutputDevice(id: string): Promise<void> {
    if (!this.#host.ready) throw new Error('Audio control is unavailable');
    const known = this.#outputs.find((d) => d.id === id);
    if (!known) throw new Error('That output device is no longer available');

    await this.#host.request('setAudioDevice', { device: id });
    log.info(`default output switched to ${known.name}`);

    // Reflect it at once: the device list is only re-read every few seconds, and
    // the sessions all move to the new endpoint.
    this.#outputs = this.#outputs.map((d) => ({ ...d, isDefault: d.id === id }));
    await this.#listDevices();
    await this.#poll();
  }

  /**
   * Reads the instantaneous input level into the rolling buffer.
   *
   * Deliberately does not publish: this runs six times more often than the
   * broadcast, and pushing state each time would do nothing but churn the diff.
   * The buffer is picked up by the next ordinary publish.
   */
  async #samplePeak(): Promise<void> {
    if (this.#peaking || !this.#host.ready) return;
    this.#peaking = true;
    try {
      const result = await this.#host.request<{ peak: number }>('micPeak');
      const peak = result?.peak ?? -1;
      // -1 means the endpoint went away, which is different from silence.
      if (peak < 0) return;
      this.#micLevels.push(Math.round(Math.min(1, peak) * 100));
      if (this.#micLevels.length > MIC_PEAK_SAMPLES) {
        this.#micLevels.splice(0, this.#micLevels.length - MIC_PEAK_SAMPLES);
      }
    } catch {
      // A dropped sample is a gap in a meter, not a failure worth logging.
    } finally {
      this.#peaking = false;
    }
  }

  #publish(raw: RawState | undefined, optimisticOnly: boolean): void {
    if (!raw) return;
    const state = buildVolumeState(raw, this.#takeOptimistic(optimisticOnly));
    if (this.#mic) {
      // Padded to a fixed width so the meter has a stable x axis from the first
      // frame rather than stretching as history accumulates.
      const levels = this.#micLevels.slice();
      while (levels.length < MIC_PEAK_SAMPLES) levels.unshift(0);
      state.mic = { ...this.#mic, levels };
    }
    if (this.#outputs.length > 0) state.outputs = this.#outputs;
    this.#hub.setVolume(state);
  }

  /** Drops expired optimistic entries and returns what is still in force. */
  #takeOptimistic(keepAll: boolean): Map<string, PendingWrite> {
    const now = Date.now();
    const live = new Map<string, PendingWrite>();
    for (const [key, entry] of this.#optimistic) {
      if (!keepAll && entry.until < now) {
        this.#optimistic.delete(key);
        continue;
      }
      live.set(key, entry.value);
    }
    return live;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for the verification suite, which has no audio device
// ---------------------------------------------------------------------------

export function sessionId(process: string, pid: number): string {
  return `${process}:${pid}`;
}

export function parseSessionId(id: string): { process: string; pid: number } | undefined {
  const at = id.lastIndexOf(':');
  if (at <= 0) return undefined;
  const process = id.slice(0, at);
  const pid = Number(id.slice(at + 1));
  if (!Number.isInteger(pid) || pid < 0) return undefined;
  return { process, pid };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)));
}

/**
 * Collapses the raw session list into one row per process and applies any
 * in-flight optimistic values.
 *
 * Grouping matters: Windows reports one session per audio stream, so Chrome
 * routinely appears three or four times. A list with four identical "Google
 * Chrome" rows, each moving a different fraction of the sound, is unusable.
 */
export function buildVolumeState(
  raw: RawState,
  optimistic: Map<string, PendingWrite> = new Map(),
): VolumeState {
  const byProcess = new Map<string, RawSession[]>();

  for (const session of raw.sessions) {
    // Expired sessions belong to processes that have gone away.
    if (session.state === STATE_EXPIRED) continue;
    const key = sessionId(session.process, session.pid);
    const list = byProcess.get(key);
    if (list) list.push(session);
    else byProcess.set(key, [session]);
  }

  const sessions: AudioSession[] = [];
  for (const [id, group] of byProcess) {
    const active = group.some((s) => s.state === STATE_ACTIVE);
    // Prefer an active stream's level: an app's idle sessions often sit at 100%
    // regardless of what the audible one is set to.
    const representative = group.find((s) => s.state === STATE_ACTIVE) ?? group[0];
    if (!representative) continue;

    const pending = optimistic.get(id);
    sessions.push({
      id,
      process: representative.process,
      name: representative.name,
      volume: clampPct(pending?.volume ?? representative.volume),
      muted: pending?.muted ?? group.every((s) => s.muted),
      pid: representative.pid,
      active,
    });
  }

  /**
   * Active first, then alphabetically. A stable order matters more than it looks:
   * the list re-renders every second, and sorting by volume or pid would make
   * rows swap places under the user's finger mid-drag.
   */
  sessions.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const masterPending = optimistic.get('master');
  return {
    master: clampPct(masterPending?.volume ?? raw.master),
    muted: masterPending?.muted ?? raw.muted,
    sessions,
  };
}

export { STATE_ACTIVE, STATE_EXPIRED, STATE_INACTIVE };
