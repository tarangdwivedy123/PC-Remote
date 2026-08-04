import { useCallback } from 'react';

import type { AudioSession } from '@pcr/shared';

import { connection } from '../lib/connection';
import { useConnectionValue } from '../lib/useConnection';
import { Section } from './Section';
import { Slider } from './Slider';
import { Sparkline } from './Sparkline';

/**
 * The meter turns red while muted: a moving line that looks alive when nothing
 * is being heard would be worse than no meter at all.
 */
const MIC_METER_COLOR = '--chart-mic';

/**
 * True when something is actually flowing through the microphone.
 *
 * Windows runs the peak meter only while a capture stream is open, so an
 * all-zero buffer means no app is listening — the agent deliberately does not
 * open the device itself to force a reading, since that would switch the
 * microphone on and light the system's in-use indicator for a meter nobody
 * asked to be recorded by.
 */
function micIsLive(levels: number[]): boolean {
  return levels.some((l) => l > 0);
}

const MASTER_ACCENT = 'var(--accent-bright)';
const APP_ACCENT = 'var(--chart-mem)';

export function VolumeSection(): JSX.Element {
  /**
   * A narrow selector, not the whole snapshot: this section would otherwise
   * repaint every second because the CPU chart advanced, re-rendering every
   * slider while a finger is on one.
   */
  const volume = useConnectionValue((s) => s.state?.volume ?? null);

  const setMaster = useCallback((v: number) => {
    // sendNoAck: a slider drag produces a write every 100ms and none of them
    // need an acknowledgement — the next state broadcast is the confirmation.
    connection.sendNoAck({ kind: 'volume.setMaster', volume: v });
  }, []);
  const toggleMasterMute = useCallback(() => {
    connection.sendNoAck({ kind: 'volume.setMuted', muted: !(volume?.muted ?? false) });
  }, [volume?.muted]);

  if (!volume) {
    return (
      <Section title="Volume">
        <p className="py-3 text-sm text-fg-faint">Waiting for the agent…</p>
      </Section>
    );
  }

  if (volume.unavailable) {
    return (
      <Section title="Volume">
        <p className="py-3 text-sm text-fg-faint">
          Volume control is unavailable{volume.reason ? `: ${volume.reason}` : '.'}
        </p>
      </Section>
    );
  }

  const apps = volume.sessions;

  return (
    <Section title="Volume" meta={apps.length > 0 ? `${apps.length} app${apps.length === 1 ? '' : 's'}` : undefined}>
      {/* Master */}
      <div className="pb-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-fg-dim">System</span>
          <span className="text-stat numeric" style={{ color: volume.muted ? 'var(--fg-faint)' : undefined }}>
            {volume.muted ? 'muted' : `${volume.master}%`}
          </span>
        </div>
        <div className="flex items-center">
          <MuteButton muted={volume.muted} onClick={toggleMasterMute} label="system volume" />
          <div className="ml-2 min-w-0 flex-1">
            <Slider
              value={volume.master}
              onChange={setMaster}
              ariaLabel="System volume"
              accent={MASTER_ACCENT}
              disabled={volume.muted}
            />
          </div>
        </div>
      </div>

      {/*
        Microphone: mute, level, and a live meter.

        The meter is the point — from across the room the useful question is not
        "am I muted" in the abstract but "is this thing hearing me", and a moving
        line answers it at a glance. The samples arrive as a batch because they
        are taken six times faster than the broadcast.
      */}
      {volume.mic ? (
        <div className="mt-1 border-t border-ink-700 pt-2">
          <div className="flex items-center">
            <MuteButton
              muted={volume.mic.muted}
              onClick={() => connection.sendNoAck({ kind: 'volume.setMicMuted', muted: !volume.mic!.muted })}
              label="microphone"
              kind="mic"
            />
            <span className="ml-2 min-w-0 flex-1">
              <span className="flex items-baseline justify-between">
                <span className="text-sm text-fg">Microphone</span>
                {/*
                  Windows only meters a capture device while an app has it open,
                  so a flat line usually means nothing is listening rather than
                  silence. Saying "idle" is the difference between a feature that
                  looks broken and one that is telling you something.
                */}
                <span
                  className="text-xs numeric"
                  style={{
                    color: volume.mic.muted
                      ? 'var(--danger-bright)'
                      : micIsLive(volume.mic.levels)
                        ? 'var(--accent-bright)'
                        : 'var(--fg-faint)',
                  }}
                >
                  {volume.mic.muted
                    ? 'MUTED'
                    : micIsLive(volume.mic.levels)
                      ? `${volume.mic.volume}%`
                      : 'idle'}
                </span>
              </span>
              <span className="mt-0.5 block">
                <Sparkline
                  series={[{ values: volume.mic.levels, color: MIC_METER_COLOR, label: 'Input level' }]}
                  yMax={100}
                  height={18}
                  ariaLabel={
                    volume.mic.muted
                      ? 'Microphone muted'
                      : `Microphone input level ${volume.mic.levels[volume.mic.levels.length - 1] ?? 0} percent`
                  }
                />
              </span>
            </span>
          </div>
        </div>
      ) : null}

      {/*
        Output device. One at a time: Windows sends a playback stream to exactly
        one endpoint and has no API to fan it out, so this is a choice rather
        than a set of checkboxes pretending otherwise.
      */}
      {volume.outputs && volume.outputs.length > 1 ? (
        <div className="mt-1 border-t border-ink-700 pt-2">
          <p className="mb-1 text-xs uppercase tracking-wider text-fg-dim">Output</p>
          <div className="space-y-1">
            {volume.outputs.map((device) => {
              const active = device.isDefault;
              return (
                <button
                  key={device.id}
                  type="button"
                  onClick={() =>
                    active ? undefined : connection.sendNoAck({ kind: 'volume.setOutputDevice', id: device.id })
                  }
                  disabled={active}
                  aria-pressed={active}
                  className="flex min-h-[48px] w-full items-center rounded-md border px-2 text-left active:opacity-80"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--line-bright)',
                    backgroundColor: active ? 'var(--accent-dim)' : 'transparent',
                  }}
                >
                  {/* A filled dot rather than a tick: this is a choice of one. */}
                  <span
                    className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{ borderColor: active ? 'var(--accent-bright)' : 'var(--line-bright)' }}
                    aria-hidden="true"
                  >
                    {active ? (
                      <span
                        className="block h-2 w-2 rounded-full"
                        style={{ backgroundColor: 'var(--accent-bright)' }}
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-sm"
                      style={{ color: active ? 'var(--accent-bright)' : 'var(--fg)' }}
                    >
                      {device.name}
                    </span>
                    {device.adapter && device.adapter !== device.name ? (
                      <span className="block truncate text-xs text-fg-faint">{device.adapter}</span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Per-app */}
      <div className="mt-1 border-t border-ink-700 pt-3">
        {apps.length === 0 ? (
          <p className="text-sm text-fg-faint">
            No apps are using audio. Start something playing and it will appear here.
          </p>
        ) : (
          <ul>
            {apps.map((app) => (
              <AppRow key={app.id} app={app} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

function AppRow({ app }: { app: AudioSession }): JSX.Element {
  const setVolume = useCallback(
    (v: number) => {
      connection.sendNoAck({ kind: 'volume.setApp', id: app.id, volume: v });
    },
    [app.id],
  );
  const toggleMute = useCallback(() => {
    connection.sendNoAck({ kind: 'volume.setAppMuted', id: app.id, muted: !app.muted });
  }, [app.id, app.muted]);

  return (
    <li className="mb-1 last:mb-0">
      <div className="flex items-baseline justify-between">
        <span
          className="mr-2 min-w-0 flex-1 truncate text-sm"
          // Dim apps holding a session without currently playing, so the one
          // making noise right now is the one that stands out.
          style={{ color: app.active ? 'var(--icon)' : 'var(--fg-faint)' }}
        >
          {app.name}
        </span>
        <span className="numeric text-sm" style={{ color: app.muted ? 'var(--fg-faint)' : 'var(--fg-dim)' }}>
          {app.muted ? 'muted' : `${app.volume}%`}
        </span>
      </div>
      <div className="flex items-center">
        <MuteButton muted={app.muted} onClick={toggleMute} label={app.name} />
        <div className="ml-2 min-w-0 flex-1">
          <Slider
            value={app.volume}
            onChange={setVolume}
            ariaLabel={`${app.name} volume`}
            accent={APP_ACCENT}
            disabled={app.muted}
          />
        </div>
      </div>
    </li>
  );
}

/**
 * 48px square so it clears the minimum touch target on its own, without relying
 * on the surrounding layout for padding.
 */
/**
 * Mute toggle.
 *
 * Colour-coded both ways — green while sound is flowing, red while it is not —
 * so the state is legible from across a room without reading anything. Only the
 * muted half was coloured before, which made "on" look like the absence of a
 * state rather than a state.
 *
 * Labelled with the *action*, not the state: "Mute" when sound is on, "Unmute"
 * when it is off. A bare icon told a first-time user nothing — there was nothing
 * to distinguish it from the decorative icons elsewhere, and no hint that it did
 * anything at all.
 *
 * The state is still readable at a glance, from the colour and the struck-through
 * icon, so naming the action costs nothing and makes the control explain itself.
 */
function MuteButton({
  muted,
  onClick,
  label,
  kind = 'speaker',
}: {
  muted: boolean;
  onClick: () => void;
  label: string;
  kind?: 'speaker' | 'mic';
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={muted}
      aria-label={`${muted ? 'Unmute' : 'Mute'} ${label}`}
      className="flex h-12 shrink-0 items-center justify-center rounded-md border px-2 active:opacity-80"
      style={{
        borderColor: muted ? 'var(--danger-bright)' : 'var(--accent)',
        backgroundColor: muted ? 'var(--danger-dim)' : 'var(--accent-dim)',
      }}
    >
      {kind === 'mic' ? <MicIcon muted={muted} /> : <SpeakerIcon muted={muted} />}
      <span
        className="ml-1 text-[11px] font-semibold"
        style={{ color: muted ? 'var(--danger-bright)' : 'var(--accent-bright)' }}
      >
        {muted ? 'Unmute' : 'Mute'}
      </span>
    </button>
  );
}

/** A microphone, not a speaker — the mic row was showing the wrong thing. */
function MicIcon({ muted }: { muted: boolean }): JSX.Element {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={muted ? 'var(--danger-bright)' : 'var(--accent-bright)'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
      {muted ? <line x1="4" y1="4" x2="20" y2="20" /> : null}
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }): JSX.Element {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke={muted ? 'var(--danger-bright)' : 'var(--accent-bright)'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      {muted ? (
        <>
          <line x1="16" y1="9" x2="22" y2="15" />
          <line x1="22" y1="9" x2="16" y2="15" />
        </>
      ) : (
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      )}
    </svg>
  );
}
