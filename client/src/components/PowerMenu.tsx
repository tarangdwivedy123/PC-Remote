import { useCallback, useEffect, useRef, useState } from 'react';

import { getConfirmToken } from '../lib/api';
import { connection } from '../lib/connection';

/** How long the second tap stays armed before reverting. */
const ARM_TIMEOUT_MS = 6000;

/**
 * Shutdown and restart, reached from the header.
 *
 * A power icon that expands into the two actions rather than putting them
 * permanently on screen: they are the rarest things here and the most costly to
 * hit by accident, so they get one more deliberate step than everything else.
 *
 * The confirmation is unchanged — two taps on the phone, and a single-use token
 * from the agent that expires in 30 seconds. The UI step is convenience; the
 * token is the part that actually gates it.
 */
export function PowerMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Collapsing on its own means a menu opened by accident does not sit there
  // with a live trigger in it.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => setOpen(false), 15_000);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setNote(null);
          setOpen((v) => !v);
        }}
        aria-label={open ? 'Hide power options' : 'Power options'}
        aria-expanded={open}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md active:bg-ink-700"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke={open ? 'var(--danger-bright)' : 'var(--fg-faint)'}
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M12 3v9" />
          <path d="M6.6 6.6a8 8 0 1 0 10.8 0" />
        </svg>
      </button>

      {open ? (
        <div className="absolute inset-x-0 top-full z-30 border-b border-line bg-ink-950 px-3 py-2">
          <div className="mx-auto flex max-w-md items-center">
            <PowerButton kind="system.restart" label="Restart" onNote={setNote} onDone={() => setOpen(false)} />
            <span className="w-2" />
            <PowerButton kind="system.shutdown" label="Shut down" onNote={setNote} onDone={() => setOpen(false)} />
          </div>
          {note ? <p className="mx-auto mt-1 max-w-md text-xs text-fg-faint">{note}</p> : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * One destructive action, behind two taps.
 *
 * The confirmation token is fetched *between* the taps rather than up front: it
 * is single-use and short-lived, so one that is never spent simply expires, and
 * arming does not leave the machine a frame away from powering off.
 */
function PowerButton({
  kind,
  label,
  onNote,
  onDone,
}: {
  kind: 'system.shutdown' | 'system.restart';
  label: string;
  onNote: (note: string) => void;
  onDone: () => void;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const onClick = useCallback(() => {
    if (busy) return;

    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
      return;
    }

    setArmed(false);
    if (timer.current !== undefined) clearTimeout(timer.current);
    setBusy(true);

    void (async () => {
      try {
        const { token } = await getConfirmToken(kind);
        await connection.send({ kind, confirm: token });
        onNote(`${label} confirmed. The PC is going down.`);
        onDone();
      } catch (err) {
        onNote((err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [armed, busy, kind, label, onNote, onDone]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={armed ? `Confirm ${label}` : label}
      className="flex min-h-[48px] flex-1 items-center justify-center rounded-md border px-2 text-sm active:opacity-80"
      style={{
        borderColor: armed ? 'var(--danger-bright)' : 'var(--line-bright)',
        backgroundColor: armed ? 'var(--danger-dim)' : 'transparent',
        color: armed ? 'var(--danger-bright)' : 'var(--fg-dim)',
      }}
    >
      {busy ? 'Working…' : armed ? `Tap again to ${label.toLowerCase()}` : label}
    </button>
  );
}
