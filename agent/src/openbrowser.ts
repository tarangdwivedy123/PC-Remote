import { spawn } from 'node:child_process';

import { createLogger } from './log.js';

const log = createLogger('browser');

/**
 * Opens the pairing page in the PC's default browser.
 *
 * The last line of defence against the app being invisible. The tray window is
 * the nicer surface, but it lives in a separate WinForms process that can die —
 * and when it did, the agent kept running and serving with no icon and no window,
 * which from the user's side is indistinguishable from an app that will not
 * start. A browser tab always works.
 *
 * Loopback deliberately: the page carries the single-use pairing code, and the
 * route refuses anything that is not this machine.
 */
export function openPairPage(port: number): void {
  const url = `http://127.0.0.1:${port}/pair`;
  try {
    /**
     * rundll32 rather than `cmd /c start`, which parses its arguments and treats
     * the first quoted token as a window title, and rather than ShellExecute via
     * the interop host, which may not have finished starting yet.
     */
    const child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    log.debug(`opened ${url}`);
  } catch (err) {
    log.debug(`could not open a browser: ${(err as Error).message}`);
  }
}
