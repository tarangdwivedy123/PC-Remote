import { useCallback, useEffect, useState } from 'react';

import { Dashboard } from './components/Dashboard';
import { PairScreen } from './components/PairScreen';
import { connection } from './lib/connection';
import { getToken } from './lib/storage';
import { useConnectionValue } from './lib/useConnection';

export function App(): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean>(() => getToken() !== null);
  const status = useConnectionValue((s) => s.status);
  const unauthorizedReason = useConnectionValue((s) =>
    s.status === 'unauthorized' ? s.lastError : null,
  );

  const handleUnauthorized = useCallback(() => setHasToken(false), []);

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
    return <PairScreen onPaired={handlePaired} reason={unauthorizedReason} />;
  }

  return <Dashboard />;
}
