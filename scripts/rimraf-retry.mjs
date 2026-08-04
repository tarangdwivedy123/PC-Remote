import { rm } from 'node:fs/promises';

/**
 * Recursive delete that tolerates a file watcher holding the directory open.
 *
 * This repo lives under OneDrive, which opens handles on newly written files to
 * sync them. A rebuild that starts while a previous build's output is still
 * uploading fails with EPERM on the output directory — Vite's own `emptyOutDir`
 * has no retry, so the build dies outright. Antivirus and editor indexers cause
 * the same thing on Windows.
 *
 * Retrying with a short backoff clears it: the handle is released within a few
 * hundred milliseconds.
 */

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

export async function rimrafRetry(target, { attempts = 8, delayMs = 150 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = err?.code;
      if (!RETRYABLE.has(code) || attempt === attempts) {
        if (attempt === attempts) {
          console.warn(
            `\n[clean] could not remove ${target} after ${attempts} attempts (${code}).\n` +
              `[clean] If this keeps happening, exclude this folder from OneDrive sync\n` +
              `[clean] (right-click the folder in Explorer > "Free up space" is not enough —\n` +
              `[clean] use OneDrive settings > Sync and back up > Manage folder backup), or\n` +
              `[clean] move the project outside OneDrive.\n`,
          );
        }
        throw err;
      }
      // Exponential-ish backoff, deliberately short: the handle is usually gone
      // by the second attempt.
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  return false;
}
