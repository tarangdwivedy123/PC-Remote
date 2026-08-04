import type { MediaState, PlaybackStatus } from '@pcr/shared';

import { createLogger } from '../log.js';
import type { StateHub } from '../state.js';
import type { WinHost } from '../winhost/host.js';
import { friendlyAppName } from './appNames.js';

const log = createLogger('media');

/** The four keys a keyboard's media buttons send. */
export type MediaKey = 'playPause' | 'next' | 'previous' | 'stop';
export type MediaAction = MediaKey | 'play' | 'pause';

const POLL_INTERVAL_MS = 1000;

/** Raw shape returned by the host's `mediaState` command. */
export interface RawMediaState {
  available: boolean;
  hasSession?: boolean;
  app?: string;
  title?: string;
  artist?: string;
  album?: string;
  status?: PlaybackStatus;
  positionSec?: number;
  durationSec?: number;
  canPlay?: boolean;
  canPause?: boolean;
  canNext?: boolean;
  canPrevious?: boolean;
  canSeek?: boolean;
  hasThumbnail?: boolean;
}

export interface Thumbnail {
  id: string;
  bytes: Buffer;
  contentType: string;
}

/**
 * Media control, with two backends.
 *
 * **B (`smtc`)** — the Windows media-session API reports what is actually
 * playing: app, title, artist, position, duration, artwork, and which transport
 * controls the session supports. Commands go through the session directly, so
 * play and pause are distinct and seek is possible.
 *
 * **A (`keys`)** — blind media-key emulation. Used when the session API is
 * unavailable, *or* when it is available but nothing currently holds a session.
 * That second case matters: plenty of things make sound without registering with
 * SMTC, and the keys still reach them.
 *
 * The backend is therefore chosen per poll rather than once at startup, and the
 * phone is told which one is live so it can stop showing metadata and seek the
 * moment they stop being real.
 */
export class MediaService {
  #hub: StateHub;
  #host: WinHost;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;

  /**
   * Artwork is fetched only when the track changes, keyed by app+title+artist.
   * Re-reading a WinRT stream every second for an image that changes once per
   * song would be pure waste.
   */
  #thumbnail: Thumbnail | undefined;
  #thumbnailKey: string | undefined;
  #thumbnailFetching = false;

  constructor(hub: StateHub, host: WinHost) {
    this.#hub = hub;
    this.#host = host;
  }

  async start(): Promise<void> {
    if (!this.#host.ready) {
      this.#hub.setMedia(null);
      log.warn('media control unavailable: the Windows helper did not start');
      return;
    }

    await this.#poll();
    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS);

    if (this.#host.smtcAvailable) {
      log.info('media ready (milestone B: session metadata and seek)');
    } else {
      log.info('media ready (milestone A: media keys only, no session API)');
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Current artwork, served over HTTP rather than inlined in the broadcast. */
  get thumbnail(): Thumbnail | undefined {
    return this.#thumbnail;
  }

  // -- commands ------------------------------------------------------------

  /**
   * Runs a transport action, escalating until something works.
   *
   * **Play and pause are always sent as a toggle**, never as the discrete
   * action. That is not a shortcut, it is the fix for the thing that made this
   * card feel broken: the status a session reports is not reliable. Measured
   * against Chrome, the session simultaneously claimed `status: paused` and
   * `canPause: true` — mutually exclusive — and answered a discrete "pause" with
   * success while starting playback.
   *
   * Choosing between play and pause from a status that lies means routinely
   * sending the action that is already true, which the app accepts and ignores.
   * A toggle cannot be wrong that way: it does not care what the state is
   * believed to be, only that it should change. In the same measurements it
   * flipped state correctly every time, in both directions.
   *
   * Everything else escalates: the session's own action first, then the hardware
   * media key, which reaches apps that publish no session at all.
   */
  async control(action: MediaAction): Promise<void> {
    if (!this.#host.ready) throw new Error('media control is unavailable on this machine');

    const current = this.#hub.snapshot().media;
    const haveSession = this.#host.smtcAvailable && current?.backend === 'smtc';

    // play, pause and playPause all mean the same thing to this code.
    const wanted: MediaAction | 'toggle' =
      action === 'play' || action === 'pause' || action === 'playPause' ? 'toggle' : action;

    if (!haveSession) {
      await this.#host.request('mediaKey', { key: toKey(action) });
      await this.#poll();
      return;
    }

    if (await this.#trySession(wanted)) return;

    // The session did nothing. The hardware key is a separate route into the
    // same app and sometimes lands when the session call does not.
    log.debug(`session declined "${wanted}"; falling back to the media key`);
    await this.#host.request('mediaKey', { key: toKey(action) });
    await this.#poll();
  }

  /** Returns true when the session reported it acted on the request. */
  async #trySession(action: MediaAction | 'toggle'): Promise<boolean> {
    try {
      const result = await this.#host.request<{ applied: boolean }>('mediaControl', { action });
      if (!result?.applied) return false;
      await this.#poll();
      return true;
    } catch (err) {
      log.debug(`session action "${action}" failed:`, err);
      return false;
    }
  }

  async seek(positionSec: number): Promise<void> {
    if (!this.#host.ready || !this.#host.smtcAvailable) {
      throw new Error('Seeking needs the Windows media session API, which is unavailable');
    }
    const result = await this.#host.request<{ applied: boolean }>('mediaSeek', { positionSec });
    if (!result?.applied) {
      throw new Error('The current app refused the seek');
    }
    await this.#poll();
  }

  // -- polling -------------------------------------------------------------

  async #poll(): Promise<void> {
    if (this.#polling || !this.#host.ready) return;
    this.#polling = true;
    try {
      if (!this.#host.smtcAvailable) {
        this.#hub.setMedia(keysOnlyState());
        return;
      }

      const raw = await this.#host.request<RawMediaState>('mediaState');
      if (!raw?.available || !raw.hasSession) {
        // Nothing holds a media session, so there is nothing to report — but the
        // keys still work, so offer those rather than an empty section.
        this.#hub.setMedia(keysOnlyState());
        this.#thumbnail = undefined;
        this.#thumbnailKey = undefined;
        return;
      }

      const key = `${raw.app ?? ''}|${raw.title ?? ''}|${raw.artist ?? ''}`;
      if (raw.hasThumbnail && key !== this.#thumbnailKey) {
        void this.#fetchThumbnail(key);
      } else if (!raw.hasThumbnail && this.#thumbnailKey !== undefined) {
        this.#thumbnail = undefined;
        this.#thumbnailKey = undefined;
      }

      this.#hub.setMedia(buildMediaState(raw, this.#thumbnail?.id));
    } catch (err) {
      log.debug('media poll failed:', err);
    } finally {
      this.#polling = false;
    }
  }

  async #fetchThumbnail(key: string): Promise<void> {
    if (this.#thumbnailFetching) return;
    this.#thumbnailFetching = true;
    try {
      const data = await this.#host.request<{ base64: string; contentType: string } | null>(
        'mediaThumbnail',
      );
      if (!data?.base64) {
        this.#thumbnail = undefined;
        this.#thumbnailKey = key;
        return;
      }
      const bytes = Buffer.from(data.base64, 'base64');
      this.#thumbnail = {
        // Content-addressed so the phone's cache invalidates on a new track but
        // reuses the image if the same one comes round again.
        id: hashKey(key, bytes.length),
        bytes,
        contentType: normaliseContentType(data.contentType),
      };
      this.#thumbnailKey = key;
      log.debug(`fetched artwork: ${bytes.length} bytes (${this.#thumbnail.contentType})`);
    } catch (err) {
      log.debug('artwork fetch failed:', err);
      this.#thumbnailKey = key; // Do not retry every second for a track with none.
    } finally {
      this.#thumbnailFetching = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the suite can exercise them without a media session
// ---------------------------------------------------------------------------

/** No keyboard has discrete play and pause keys; both collapse onto the toggle. */
function toKey(action: MediaAction): MediaKey {
  if (action === 'play' || action === 'pause') return 'playPause';
  return action;
}

/**
 * Milestone A state. Reports `unknown` rather than guessing: media keys report
 * nothing back, and a play/pause button that silently inverts the first time
 * playback changes on the PC is worse than one that admits it does not know.
 */
export function keysOnlyState(): MediaState {
  return {
    backend: 'keys',
    status: 'unknown',
    canNext: true,
    canPrevious: true,
    canSeek: false,
  };
}

/**
 * Works out what is really happening, because the reported status cannot be
 * trusted.
 *
 * Measured against Chrome: `status: paused` alongside `canPause: true` and
 * `canPlay: false` — a combination that cannot be true, since a paused session
 * is the one you can *play*. The capability flags were right and the status was
 * wrong, which is why the icon read backwards.
 *
 * So the flags decide whenever they are unambiguous: being able to pause but not
 * play means it is playing, and the reverse means it is paused. The reported
 * status is used only when the flags say nothing useful.
 */
export function deriveStatus(raw: RawMediaState): PlaybackStatus {
  const canPlay = raw.canPlay === true;
  const canPause = raw.canPause === true;
  if (canPause && !canPlay) return 'playing';
  if (canPlay && !canPause) return 'paused';
  return raw.status ?? 'unknown';
}

export function buildMediaState(raw: RawMediaState, thumbnailId?: string): MediaState {
  const state: MediaState = {
    backend: 'smtc',
    status: deriveStatus(raw),
    canNext: raw.canNext ?? false,
    canPrevious: raw.canPrevious ?? false,
    // Only offer seek when the session supports it *and* a duration is known —
    // a scrubber with no end to scrub towards is not usable.
    canSeek: (raw.canSeek ?? false) && (raw.durationSec ?? 0) > 0,
  };

  const app = friendlyAppName(raw.app ?? '');
  if (app) state.sourceApp = app;
  // Empty strings are common for artist/album; omit rather than render a blank.
  if (raw.title) state.title = raw.title;
  if (raw.artist) state.artist = raw.artist;
  if (raw.album) state.album = raw.album;
  if (typeof raw.positionSec === 'number') state.positionSec = Math.max(0, raw.positionSec);
  if (typeof raw.durationSec === 'number' && raw.durationSec > 0) {
    state.durationSec = raw.durationSec;
  }
  if (thumbnailId) state.thumbnailId = thumbnailId;

  return state;
}

/** Small, stable, and enough to detect a track change. */
function hashKey(key: string, length: number): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}${length.toString(36)}`;
}

function normaliseContentType(raw: string): string {
  const value = (raw || '').trim().toLowerCase();
  // WinRT sometimes reports an empty or odd type; browsers sniff PNG and JPEG
  // fine, but an explicit type avoids a download prompt on old Chrome.
  if (value.startsWith('image/')) return value;
  return 'image/jpeg';
}
