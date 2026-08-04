import { useEffect, useState } from 'react';

import { connection } from '../lib/connection';
import { useConnection } from '../lib/useConnection';
import { FullscreenButton } from './FullscreenButton';
import { PowerMenu } from './PowerMenu';
import { ThemeToggle } from './ThemeToggle';

const STATUS_LABEL = {
  idle: 'Idle',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  unauthorized: 'Not paired',
} as const;

/**
 * Dot colour rather than a filled banner. A persistent coloured bar across the
 * top of an always-on AMOLED screen is exactly the static bright element to
 * avoid, so the state reads from a 8px dot plus text.
 */
const STATUS_DOT = {
  idle: 'bg-fg-faint',
  connecting: 'bg-warn-bright',
  connected: 'bg-accent-bright',
  reconnecting: 'bg-warn-bright',
  unauthorized: 'bg-danger-bright',
} as const;

/** Ticks once a second, but only while there is a countdown to render. */
function useRetryCountdown(nextRetryAt: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (nextRetryAt === null) {
      setRemaining(null);
      return;
    }
    const tick = (): void => setRemaining(Math.max(0, nextRetryAt - Date.now()));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [nextRetryAt]);

  return remaining;
}

export function StatusBar(): JSX.Element {
  const { status, host, rttMs, attempt, nextRetryAt, lastError, protocolMismatch } = useConnection();
  const countdown = useRetryCountdown(nextRetryAt);

  const showRetry = status === 'reconnecting';

  return (
    <div className="sticky top-0 z-20 border-b border-line bg-ink-950 pt-safe relative">
      <div className="flex items-center px-4 pb-2 pr-2">
        <span
          className={`mr-2 h-2 w-2 flex-shrink-0 rounded-full ${STATUS_DOT[status]}`}
          aria-hidden="true"
        />
        <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>

        {host ? (
          <span className="ml-2 truncate text-sm text-fg-dim">{host.hostname}</span>
        ) : null}

        <span className="ml-auto pl-2 text-xs text-fg-faint numeric">
          {status === 'connected' && rttMs !== null ? `${rttMs} ms` : null}
          {showRetry && countdown !== null
            ? `retry in ${(countdown / 1000).toFixed(countdown < 1000 ? 1 : 0)}s`
            : null}
        </span>

        {/* Negative margin so a 44px touch target does not deepen the bar. */}
        <span className="-my-3 ml-1 flex items-center">
          <ThemeToggle />
          <FullscreenButton />
          <PowerMenu />
        </span>
      </div>

      {/*
        The reconnect line is intentionally quiet: losing Wi-Fi and coming back
        is normal and recovers on its own, so it should not look like an error
        until it has been failing for a while.
      */}
      {showRetry ? (
        <div className="flex items-center px-4 pb-2">
          <p className="flex-1 truncate text-xs text-fg-faint">
            {lastError ?? 'Lost connection'}
            {attempt > 3 ? ` · attempt ${attempt}` : ''}
          </p>
          <button
            type="button"
            className="ml-2 h-8 rounded border border-line px-3 text-xs text-fg-dim"
            onClick={() => connection.reconnectNow()}
          >
            Retry now
          </button>
        </div>
      ) : null}

      {protocolMismatch ? (
        <div className="border-t border-warn px-4 py-2">
          <p className="text-xs text-warn-bright">
            The agent was updated. Reload this page to pick up the new version.
          </p>
        </div>
      ) : null}
    </div>
  );
}
