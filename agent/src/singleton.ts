import { createLogger } from './log.js';

const log = createLogger('singleton');

/**
 * Handles a second launch of an app that is already running.
 *
 * Before this existed, launching PC Remote from its shortcut while it was
 * already running did nothing at all: the new process failed to bind the port
 * and exited, and because the packaged executable has no console the reason went
 * nowhere. From the outside the app was simply broken.
 *
 * So a second launch is treated as what it almost always means — "show me the
 * QR code" — and handed to the copy that is already running.
 */

/**
 * @returns true when an existing instance was found and asked to show itself,
 *          meaning this process should exit quietly.
 */
export async function surfaceExistingInstance(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`;

  let identified = false;
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { name?: unknown };
    // Only ours. Something else on this port is a real conflict, and the caller
    // should report it rather than silently give up.
    identified = body.name === 'pc-remote';
  } catch {
    // Nothing listening, or not speaking HTTP: this process should carry on and
    // bind the port itself.
    return false;
  }

  if (!identified) return false;

  try {
    await fetch(`${base}/api/show`, { method: 'POST', signal: AbortSignal.timeout(2500) });
  } catch (err) {
    // The instance is there but would not show its window. Still the right call
    // to stand down — two agents cannot share the port.
    log.debug(`existing instance did not respond to show: ${(err as Error).message}`);
  }

  log.info('another copy is already running; asked it to show its QR code');
  return true;
}

/**
 * Ends this process now, without waiting for the event loop to drain.
 *
 * Returning normally can leave the launcher alive for a noticeable extra moment:
 * fetch keeps its connection pool open, and Node will not exit while a socket is
 * still held. Nothing here has state worth flushing -- the only job was to tell
 * the running copy to show itself -- and every extra moment is time the user
 * spends looking at nothing and clicking again.
 */
export function exitQuietly(): never {
  process.exit(0);
}
