import { useCallback, useEffect, useState } from 'react';

import { Dashboard } from './components/Dashboard';
import { PairScreen } from './components/PairScreen';
import { connection } from './lib/connection';
import { pairWithCode } from './lib/api';
import { getToken, setToken } from './lib/storage';
import { useConnectionValue } from './lib/useConnection';

/**
 * Reads and removes the one-time pairing code the QR put in the address.
 *
 * Removed immediately, before anything else runs: the code is single-use, so
 * leaving it in the address bar would mean a refresh retrying a spent code and
 * showing a failure for something that already worked. It would also sit in the
 * phone's history and in any screenshot of the browser.
 */
function takePairingCodeFromUrl(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('p');
    if (!code) return null;
    params.delete('p');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      window.location.pathname + (query ? `?${query}` : '') + window.location.hash,
    );
    return code;
  } catch {
    return null;
  }
}

export function App(): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null);
  // Captured once on load, before the first render commits.
  const [pairingCode] = useState<string | null>(() => (getToken() ? null : takePairingCodeFromUrl()));
  const [autoPairFailed, setAutoPairFailed] = useState(false);
  const status = useConnectionValue((s) => s.status);
  const unauthorizedReason = useConnectionValue((s) =>
    s.status === 'unauthorized' ? s.lastError : null,
  );

  const handleUnauthorized = useCallback(() => setHasToken(false), []);

  /**
   * Scanning the QR should be the whole of pairing. This spends the code the
   * moment the page loads, so the PIN screen is never shown at all.
   *
   * A failure here is not an error worth alarming anyone with — the usual cause
   * is a refresh, or a QR from a previous run — so it just falls through to the
   * PIN screen with a short explanation.
   */
  useEffect(() => {
    if (hasToken || !pairingCode || autoPairFailed) return;
    let cancelled = false;
    void pairWithCode(pairingCode)
      .then((res) => {
        if (cancelled) return;
        setToken(res.token);
        setHasToken(true);
        connection.start(handleUnauthorized);
      })
      .catch(() => {
        if (!cancelled) setAutoPairFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hasToken, pairingCode, autoPairFailed, handleUnauthorized]);

  useEffect(() => {
    if (!hasToken) return;
    // start() is idempotent, so StrictMode's double-invoke in development does
    // not open two sockets.
    connection.start(handleUnauthorized);
  }, [hasToken, handleUnauthorized]);

  const handlePaired = useCallback(() => {
    setHasToken(true);
    connection.start(handleUnauthorized);
    // The connection may be sitting in the 'unauthorized' state with a cleared
    // token, so nudge it rather than waiting for a backoff timer that is not
    // running.
    connection.reconnectNow();
  }, [handleUnauthorized]);

  if (!hasToken || status === 'unauthorized') {
    /**
     * A scanned QR is mid-flight: hold the screen blank for the moment it takes
     * rather than flashing the PIN prompt at someone who will never need it.
     */
    if (pairingCode && !autoPairFailed) {
      return (
        <div className="flex min-h-screen items-center justify-center px-6">
          <p className="text-sm text-fg-dim">Connecting to your PC…</p>
        </div>
      );
    }
    return (
      <PairScreen
        onPaired={handlePaired}
        reason={
          autoPairFailed
            ? 'That QR code had already been used. Enter the PIN shown on your PC, or show the QR again.'
            : unauthorizedReason
        }
      />
    );
  }

  return <Dashboard />;
}
