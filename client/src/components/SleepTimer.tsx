import { useCallback, useEffect, useState } from 'react';

import { connection } from '../lib/connection';

const PRESETS = [15, 30, 60] as const;

/**
 * Delayed sleep.
 *
 * The agent sends the absolute time it will fire rather than a ticking number,
 * so the countdown is rendered here from the local clock. A dropped frame then
 * costs nothing — the clock keeps running instead of stalling or jumping when
 * the next broadcast lands.
 */
export function SleepTimer({ sleepAt }: { sleepAt?: number }): JSX.Element {
  const [remaining, setRemaining] = useState<number | null>(null);
  const [custom, setCustom] = useState('');

  useEffect(() => {
    if (sleepAt === undefined) {
      setRemaining(null);
      return;
    }
    const tick = (): void => setRemaining(Math.max(0, sleepAt - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sleepAt]);

  const armed = sleepAt !== undefined && remaining !== null;

  const customMinutes = Number(custom);
  // The same bound the agent enforces, so the button is never offered for a
  // value that would be rejected.
  const customValid = Number.isInteger(customMinutes) && customMinutes >= 1 && customMinutes <= 720;

  const startCustom = useCallback(() => {
    if (!customValid) return;
    connection.sendNoAck({ kind: 'system.sleepTimer', minutes: customMinutes });
    setCustom('');
  }, [customValid, customMinutes]);

  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wider text-fg-dim">Sleep timer</p>

      {armed ? (
        <button
          type="button"
          onClick={() => connection.sendNoAck({ kind: 'system.sleepTimer', minutes: 0 })}
          className="flex min-h-[48px] w-full items-center justify-between rounded-md border px-3 text-sm active:opacity-80"
          style={{ borderColor: 'var(--warn)', color: 'var(--warn-bright)' }}
        >
          <span>Sleeping in {formatRemaining(remaining ?? 0)}</span>
          <span className="text-xs text-fg-faint">Cancel</span>
        </button>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            {PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => connection.sendNoAck({ kind: 'system.sleepTimer', minutes })}
                className="flex min-h-[48px] items-center justify-center rounded-md border border-ink-700 text-sm text-fg-dim active:bg-ink-700"
              >
                {minutes}m
              </button>
            ))}
          </div>

          {/*
            Anything the presets do not cover. The agent caps this at 12 hours —
            past that it is a scheduled task, not a sleep timer — so the field
            says so rather than letting a large number be silently refused.
          */}
          <div className="mt-2 flex items-center">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={custom}
              onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              placeholder="Minutes"
              aria-label="Custom sleep delay in minutes"
              className="h-12 min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-fg"
            />
            <button
              type="button"
              onClick={startCustom}
              disabled={!customValid}
              aria-label="Start custom sleep timer"
              className="ml-2 flex h-12 shrink-0 items-center justify-center rounded-md border px-3 text-sm active:opacity-80"
              style={{
                borderColor: customValid ? 'var(--accent)' : 'var(--line-bright)',
                color: customValid ? 'var(--accent-bright)' : 'var(--fg-faint)',
                opacity: customValid ? 1 : 0.5,
              }}
            >
              Set
            </button>
          </div>
          {custom !== '' && !customValid ? (
            <p className="mt-1 text-xs text-fg-faint">Between 1 and 720 minutes.</p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** mm:ss under an hour, h:mm above — the precision you care about changes. */
function formatRemaining(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
