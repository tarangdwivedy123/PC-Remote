import {
  BROADCAST_INTERVAL_MS,
  HISTORY_LENGTH,
  computePatch,
  type AgentState,
  type DeepPartial,
  type MediaState,
  type MonitorState,
  type SystemState,
  type Stats,
  type StatsSample,
  type VolumeState,
} from '@pcr/shared';

import { createLogger } from './log.js';

const log = createLogger('state');

/**
 * What the broadcast timer produces on each tick. `patch` is the delta against
 * revision `baseRev`; a connection whose baseline is older must be sent `state`
 * in full instead. That happens only to sockets that connected mid-tick.
 */
export interface Broadcast {
  rev: number;
  baseRev: number;
  state: AgentState;
  patch: DeepPartial<AgentState> | undefined;
  sample: StatsSample | undefined;
}

export type BroadcastListener = (broadcast: Broadcast) => void;

/**
 * Single source of truth for everything the phone renders.
 *
 * Subsystems (stats sampler, volume, media) push into their own slice whenever
 * they have fresh data, each on its own cadence. The hub then flushes to all
 * clients on one shared 1 Hz timer, so client count does not multiply the
 * polling cost.
 */
export class StateHub {
  #stats: Stats | null = null;
  #volume: VolumeState | null = null;
  #media: MediaState | null = null;
  #monitors: MonitorState | null = null;
  #system: SystemState | null = null;

  #history: StatsSample[] = [];
  #pendingSample: StatsSample | undefined;

  #rev = 0;
  #lastBroadcastState: AgentState;
  #listeners = new Set<BroadcastListener>();
  #timer: NodeJS.Timeout | undefined;

  constructor() {
    this.#lastBroadcastState = this.snapshot();
  }

  // -- reads ---------------------------------------------------------------

  snapshot(): AgentState {
    return {
      t: Date.now(),
      stats: this.#stats,
      volume: this.#volume,
      media: this.#media,
      monitors: this.#monitors,
      system: this.#system,
    };
  }

  get revision(): number {
    return this.#rev;
  }

  /**
   * The state as of the last broadcast — the exact object subsequent deltas are
   * diffed against.
   *
   * New connections must be seeded with this rather than a fresh `snapshot()`.
   * Sampling happens between broadcasts, so a fresh snapshot is *newer* than the
   * diff baseline, and the next patch (computed baseline -> current) would be
   * applied to a state it was not derived from. Fields that changed between the
   * baseline and the snapshot but not between the baseline and the next tick would
   * never be corrected, leaving the client silently stale.
   *
   * It also avoids a much louder version of the same problem: connecting in the
   * window before the first stats sample, where the baseline still holds
   * `stats: null`, made the first patch a full copy of the stats object.
   */
  get broadcastBaseline(): AgentState {
    return this.#lastBroadcastState;
  }

  /** Copy of the rolling history, oldest first. Sent in the `hello` frame. */
  get history(): StatsSample[] {
    return this.#history.slice();
  }

  // -- writes --------------------------------------------------------------

  setStats(stats: Stats | null): void {
    this.#stats = stats;
  }

  setVolume(volume: VolumeState | null): void {
    this.#volume = volume;
  }

  setMedia(media: MediaState | null): void {
    this.#media = media;
  }

  setMonitors(monitors: MonitorState | null): void {
    this.#monitors = monitors;
  }

  setSystem(system: SystemState | null): void {
    this.#system = system;
  }

  /**
   * Mutate the volume slice in place-ish. Used by optimistic updates: when the
   * phone drags a slider we reflect the new value immediately rather than
   * waiting up to a second for the next poll to confirm it.
   */
  patchVolume(mutator: (volume: VolumeState) => void): void {
    if (!this.#volume) return;
    const next: VolumeState = {
      ...this.#volume,
      sessions: this.#volume.sessions.map((s) => ({ ...s })),
    };
    mutator(next);
    this.#volume = next;
  }

  patchMedia(mutator: (media: MediaState) => void): void {
    if (!this.#media) return;
    const next: MediaState = { ...this.#media };
    mutator(next);
    this.#media = next;
  }

  /**
   * Queue a history sample. It rides along with the next broadcast rather than
   * being sent immediately, so a sampler that runs slightly off-phase from the
   * broadcast timer cannot produce two frames in one tick.
   */
  pushSample(sample: StatsSample): void {
    this.#history.push(sample);
    if (this.#history.length > HISTORY_LENGTH) {
      this.#history.splice(0, this.#history.length - HISTORY_LENGTH);
    }
    this.#pendingSample = sample;
  }

  // -- broadcast loop ------------------------------------------------------

  subscribe(listener: BroadcastListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.flush(), BROADCAST_INTERVAL_MS);
    log.debug(`broadcast timer started at ${BROADCAST_INTERVAL_MS}ms`);
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Build and emit one broadcast. Also callable out-of-band so an action the
   * user just took (mute toggle, track skip) reaches the phone immediately
   * instead of on the next tick — that latency is very visible on a remote.
   */
  flush(): void {
    if (this.#listeners.size === 0) {
      // Nobody is listening, so skip the diff entirely — but still advance the
      // baseline, or the first client to connect gets a patch computed against
      // a stale state.
      this.#lastBroadcastState = this.snapshot();
      this.#pendingSample = undefined;
      return;
    }

    const baseRev = this.#rev;
    const state = this.snapshot();
    const patch = computePatch(this.#lastBroadcastState, state);
    const sample = this.#pendingSample;

    this.#pendingSample = undefined;
    this.#lastBroadcastState = state;
    this.#rev += 1;

    const broadcast: Broadcast = { rev: this.#rev, baseRev, state, patch, sample };
    for (const listener of this.#listeners) {
      try {
        listener(broadcast);
      } catch (err) {
        log.error('broadcast listener threw:', err);
      }
    }
  }
}
