import { useSyncExternalStore } from 'react';

import { connection, type ConnectionSnapshot } from './connection';

/**
 * Subscribes to the whole connection snapshot. Re-renders roughly once a second
 * while connected, which is fine for the shell but wasteful for leaf sections —
 * prefer `useConnectionValue` with a narrow selector for those.
 */
export function useConnection(): ConnectionSnapshot {
  // The third argument is the server snapshot. This app never server-renders,
  // but supplying it keeps the components renderable outside a browser, which is
  // what the render smoke test in scripts/verify relies on.
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}

/**
 * Selector variant, so a section only re-renders when the slice it displays
 * changes. The volume session list, for instance, should not repaint every second because
 * the CPU chart advanced.
 *
 * The selector MUST return a primitive or a referentially stable value:
 * useSyncExternalStore compares results with Object.is, and returning a fresh
 * object every call causes an infinite render loop. The state slices are safe
 * because the agent's patch application preserves identity for untouched
 * branches.
 */
export function useConnectionValue<T>(selector: (snapshot: ConnectionSnapshot) => T): T {
  return useSyncExternalStore(
    connection.subscribe,
    () => selector(connection.getSnapshot()),
    () => selector(connection.getSnapshot()),
  );
}
