import { useCallback, useEffect, useRef, useState } from 'react';

import type { Command, MediaState } from '@pcr/shared';

import { connection } from '../lib/connection';
import { getToken } from '../lib/storage';
import { useConnectionValue } from '../lib/useConnection';
import { Section } from './Section';
import { Slider } from './Slider';

export function NowPlayingSection(): JSX.Element {
  const media = useConnectionValue((s) => s.state?.media ?? null);

  const send = useCallback((command: Command) => {
    connection.sendNoAck(command);
  }, []);

  if (!media) {
    return (
      <Section title="Now Playing">
        <p className="py-3 text-sm text-fg-faint">Media control is unavailable on this PC.</p>
      </Section>
    );
  }

  /**
   * The keys backend cannot see what is playing — it emulates the hardware media
   * buttons and Windows routes them to whoever owns playback. So there is no
   * metadata to show and no honest play/pause state to render.
   */
  const blind = media.backend === 'keys';
  const playing = media.status === 'playing';

  return (
    <Section title="Now Playing" meta={blind ? 'media keys' : media.sourceApp}>
      {blind ? null : <TrackDetails media={media} />}

      {media.canSeek && media.durationSec ? <SeekBar media={media} send={send} /> : null}

      <div className="mt-1 flex items-center justify-center">
        {/*
          Never disabled on the strength of canPrevious/canNext. Chrome reports
          both as false for a YouTube video and still responds to the keys, so
          greying them out just removed working buttons.
        */}
        <TransportButton label="Previous" onClick={() => send({ kind: 'media.previous' })}>
          <PreviousIcon />
        </TransportButton>

        {/*
          Always the toggle. Picking play or pause from the reported status meant
          sending whichever was already true whenever that status was wrong —
          which for Chrome is often. The icon still hints at the state; the
          action does not depend on it.
        */}
        <TransportButton
          label={playing ? 'Pause' : 'Play'}
          primary
          onClick={() => send({ kind: 'media.playPause' })}
        >
          {/* Without real status a dedicated play or pause glyph would be a coin
              flip, so the keys backend gets a combined "toggle" icon instead. */}
          {blind ? <PlayPauseIcon /> : playing ? <PauseIcon /> : <PlayIcon />}
        </TransportButton>

        <TransportButton label="Next" onClick={() => send({ kind: 'media.next' })}>
          <NextIcon />
        </TransportButton>

        <TransportButton label="Stop" onClick={() => send({ kind: 'media.stop' })}>
          <StopIcon />
        </TransportButton>
      </div>
    </Section>
  );
}

function TrackDetails({ media }: { media: MediaState }): JSX.Element {
  return (
    <div className="mb-2 flex items-center">
      <Artwork thumbnailId={media.thumbnailId} />
      <div className="ml-3 min-w-0 flex-1">
        <p className="truncate text-base text-fg">{media.title || 'Nothing playing'}</p>
        {media.artist ? <p className="truncate text-sm text-fg-dim">{media.artist}</p> : null}
        {media.album ? <p className="truncate text-xs text-fg-faint">{media.album}</p> : null}
        {media.status === 'paused' ? (
          <p className="mt-0.5 text-xs uppercase tracking-wider text-fg-faint">Paused</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Album art, fetched from the agent rather than inlined in the state broadcast.
 * The id changes only when the track does, so the browser caches each cover and
 * the 1 Hz frames stay tiny.
 */
function Artwork({ thumbnailId }: { thumbnailId?: string }): JSX.Element {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [thumbnailId]);

  const size = 64;
  if (!thumbnailId || failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded bg-ink-700"
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <NoteIcon />
      </div>
    );
  }

  const token = getToken();
  return (
    <img
      src={`/api/media/thumbnail?id=${encodeURIComponent(thumbnailId)}&token=${encodeURIComponent(token ?? '')}`}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded object-cover"
      style={{ width: size, height: size }}
      // The track can change between the broadcast and this request, which makes
      // the id stale and the response a 404. Fall back to the placeholder rather
      // than showing a broken image.
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Scrubber. The reported position only advances once a second, so it is
 * extrapolated locally while playing — otherwise the bar visibly steps rather
 * than moves.
 */
function SeekBar({ media, send }: { media: MediaState; send: (c: Command) => void }): JSX.Element {
  const duration = media.durationSec ?? 0;
  const reported = media.positionSec ?? 0;
  const [displayed, setDisplayed] = useState(reported);
  const anchor = useRef({ at: Date.now(), position: reported });

  // Re-anchor whenever the agent reports a position.
  useEffect(() => {
    anchor.current = { at: Date.now(), position: reported };
    setDisplayed(reported);
  }, [reported]);

  useEffect(() => {
    if (media.status !== 'playing') return;
    const timer = setInterval(() => {
      const elapsed = (Date.now() - anchor.current.at) / 1000;
      setDisplayed(Math.min(duration, anchor.current.position + elapsed));
    }, 500);
    return () => clearInterval(timer);
  }, [media.status, duration]);

  const onSeek = useCallback(
    (percent: number) => {
      send({ kind: 'media.seek', positionSec: Math.round((percent / 100) * duration) });
    },
    [send, duration],
  );

  const percent = duration > 0 ? Math.min(100, (displayed / duration) * 100) : 0;

  return (
    <div className="mb-1">
      <Slider
        value={percent}
        onChange={onSeek}
        ariaLabel="Seek"
        accent="var(--chart-mem)"
        // Seeking is expensive for the app on the other end, so send far less
        // often than a volume drag.
        throttleMs={400}
      />
      <div className="-mt-1 flex justify-between text-xs text-fg-faint numeric">
        <span>{formatTime(displayed)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 64px for the primary control and 56px for the rest — comfortably past the 48px
 * floor, because these are the buttons most likely to be pressed one-handed
 * without looking at the phone.
 */
function TransportButton({
  label,
  onClick,
  primary = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const size = primary ? 'h-16 w-16' : 'h-14 w-14';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`mx-1 flex ${size} shrink-0 items-center justify-center rounded-full border border-ink-700 active:bg-ink-700`}
      style={disabled ? { opacity: 0.35 } : undefined}
    >
      {children}
    </button>
  );
}

const STROKE = 'var(--icon)';

function PreviousIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <path d="M18 6v12l-9-6zM7 6h2v12H7z" />
    </svg>
  );
}

function NextIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <path d="M6 6v12l9-6zM15 6h2v12h-2z" />
    </svg>
  );
}

function PlayIcon(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  );
}

/** Play and pause together: this button toggles, and cannot know which way. */
function PlayPauseIcon(): JSX.Element {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <path d="M5 5v14l8-7z" />
      <path d="M15 5h2v14h-2zM19 5h2v14h-2z" />
    </svg>
  );
}

function StopIcon(): JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill={STROKE} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

function NoteIcon(): JSX.Element {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--fg-faint)" strokeWidth="1.6" aria-hidden="true">
      <path d="M9 18V5l10-2v13" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  );
}
