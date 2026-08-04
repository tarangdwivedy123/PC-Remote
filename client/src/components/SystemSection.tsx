import { useCallback, useState } from 'react';

import { connection } from '../lib/connection';
import { useConnectionValue } from '../lib/useConnection';
import { SendToPc } from './SendToPc';
import { SleepTimer } from './SleepTimer';
import { Section } from './Section';

export function SystemSection(): JSX.Element {
  const [note, setNote] = useState<string | null>(null);
  const system = useConnectionValue((s) => s.state?.system ?? null);

  const send = useCallback((kind: 'system.lock' | 'system.sleep' | 'system.displayOff', label: string) => {
    connection
      .send({ kind })
      .then(() => setNote(`${label} sent.`))
      .catch((err: Error) => setNote(err.message));
  }, []);

  return (
    <Section title="System">
      <div className="grid grid-cols-3 gap-2">
        <ActionButton label="Lock" onClick={() => send('system.lock', 'Lock')}>
          <LockIcon />
        </ActionButton>
        <ActionButton label="Sleep" onClick={() => send('system.sleep', 'Sleep')}>
          <MoonIcon />
        </ActionButton>
        <ActionButton label="Display off" onClick={() => send('system.displayOff', 'Display off')}>
          <ScreenIcon />
        </ActionButton>
      </div>

      <div className="mt-3 border-t border-ink-700 pt-3">
        <SleepTimer sleepAt={system?.sleepAt} />
      </div>

      <div className="mt-3 border-t border-ink-700 pt-3">
        <SendToPc enabled={system?.canSend !== false} />
      </div>



      {note ? <p className="mt-2 text-xs text-fg-faint">{note}</p> : null}
    </Section>
  );
}


function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex min-h-[64px] flex-col items-center justify-center rounded-md border border-ink-700 px-1 active:bg-ink-700"
    >
      {children}
      <span className="mt-1 text-xs text-fg-dim">{label}</span>
    </button>
  );
}

const STROKE = 'var(--icon)';

function LockIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={STROKE} strokeWidth="1.8" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={STROKE} strokeWidth="1.8" aria-hidden="true">
      <path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10z" />
    </svg>
  );
}

function ScreenIcon(): JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={STROKE} strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6" />
    </svg>
  );
}
