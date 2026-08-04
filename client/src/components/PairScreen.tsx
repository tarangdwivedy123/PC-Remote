import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, pair } from '../lib/api';
import { setToken } from '../lib/storage';

interface PairScreenProps {
  onPaired: () => void;
  /** Message explaining why pairing is being asked for again, if it is. */
  reason?: string | null;
}

const PIN_LENGTH = 6;

export function PairScreen({ onPaired, reason }: PairScreenProps): JSX.Element {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockRemaining, setLockRemaining] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against the auto-submit effect firing twice for one PIN.
  const submittingRef = useRef(false);

  useEffect(() => {
    // Focusing on mount pops the numeric keypad straight away, which is the
    // whole interaction on a phone.
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = (): void => {
      const left = Math.max(0, lockedUntil - Date.now());
      setLockRemaining(left);
      if (left === 0) {
        setLockedUntil(null);
        setError(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const submit = useCallback(
    async (candidate: string) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const response = await pair(candidate);
        setToken(response.token);
        onPaired();
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        setError(apiError?.message ?? 'Pairing failed.');
        if (apiError?.retryAfterMs) setLockedUntil(Date.now() + apiError.retryAfterMs);
        setPin('');
        // Re-focus so the keypad stays up for another try.
        window.setTimeout(() => inputRef.current?.focus(), 0);
      } finally {
        setBusy(false);
        submittingRef.current = false;
      }
    },
    [onPaired],
  );

  const onChange = (raw: string): void => {
    const digits = raw.replace(/\D/g, '').slice(0, PIN_LENGTH);
    setPin(digits);
    setError(null);
    // Submitting on the sixth digit removes a tap; there is nothing else on
    // this screen to confirm.
    if (digits.length === PIN_LENGTH && lockedUntil === null) void submit(digits);
  };

  const locked = lockedUntil !== null && lockRemaining > 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-10">
      <h1 className="text-2xl font-semibold">PC Remote</h1>
      <p className="mt-2 text-sm text-fg-dim">
        {reason ?? 'Enter the 6-digit PIN shown in the agent window on your PC.'}
      </p>

      <form
        className="mt-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (pin.length === PIN_LENGTH && !locked) void submit(pin);
        }}
      >
        <label htmlFor="pin" className="card-title">
          Pairing PIN
        </label>
        <input
          id="pin"
          ref={inputRef}
          value={pin}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy || locked}
          /*
            type="text" with inputMode="numeric" rather than type="number":
            number inputs strip leading zeros, and "000123" is a valid PIN here.
            pattern is what actually triggers the numeric keypad on old Android.
          */
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={PIN_LENGTH}
          placeholder="······"
          aria-describedby="pin-help"
          className="mt-2 block w-full rounded-card border border-line bg-ink-800 px-4 py-4 text-center text-3xl tracking-[0.4em] text-fg numeric placeholder-fg-faint focus:border-accent-dim"
        />

        <p id="pin-help" className="mt-3 min-h-[2.5rem] text-sm" aria-live="polite">
          {error ? (
            <span className="text-danger-bright">
              {error}
              {locked ? ` (${Math.ceil(lockRemaining / 1000)}s)` : ''}
            </span>
          ) : busy ? (
            <span className="text-fg-dim">Pairing…</span>
          ) : (
            <span className="text-fg-faint">
              This is stored on this phone, so you only do it once.
            </span>
          )}
        </p>

        <button
          type="submit"
          className="btn btn-accent mt-2 w-full"
          disabled={pin.length !== PIN_LENGTH || busy || locked}
        >
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </form>

      <div className="mt-10 border-t border-line pt-4">
        <p className="text-xs text-fg-faint">
          Can&apos;t see a PIN? On the PC, run{' '}
          <code className="text-fg-dim">npm start -- --show-pin</code> in the project folder.
        </p>
      </div>
    </main>
  );
}
