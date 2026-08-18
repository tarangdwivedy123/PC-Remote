import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isPackaged } from './packaged.js';

/**
 * Makes a fatal startup failure visible.
 *
 * The packaged executable has no console — that is deliberate, since its
 * interface is a tray icon and a phone — but it means an error printed to stdout
 * is an error nobody will ever read. Any failure that stops the app therefore
 * has to announce itself some other way, or the app just appears not to start.
 */

function logFile(): string {
  return path.join(process.env['LOCALAPPDATA'] ?? os.tmpdir(), 'PCRemote', 'error.log');
}

/** Appends to a log the user can be pointed at, capped so it cannot grow forever. */
function record(message: string): string | undefined {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 256 * 1024) fs.rmSync(file);
    } catch {
      // No existing log, which is the normal case.
    }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Shows a dialog, best-effort and fire-and-forget.
 *
 * PowerShell is slow to start, which does not matter on a path that ends in
 * process exit, and it avoids adding a GUI dependency for the one case that
 * needs one.
 */
function showDialog(text: string): void {
  try {
    const script =
      'Add-Type -AssemblyName System.Windows.Forms;' +
      `[System.Windows.Forms.MessageBox]::Show(${quote(text)}, 'PC Remote', 'OK', 'Error')`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
  } catch {
    // Nothing further to try; the log file is the fallback.
  }
}

/** Single-quoted PowerShell literal: no expansion, and '' escapes a quote. */
function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Reports a failure that prevents startup, then leaves it to the caller to exit.
 *
 * @param hint plain-language next step, shown above the technical detail
 */
export function reportFatal(message: string, hint?: string): void {
  const file = record(hint ? `${message} | hint: ${hint}` : message);

  // A developer running from source has a console, and a dialog would be an
  // interruption rather than a help.
  if (!isPackaged() || process.platform !== 'win32') return;

  const parts = [hint ?? 'PC Remote could not start.', '', message];
  if (file) parts.push('', `Details were saved to:\n${file}`);
  showDialog(parts.join('\n'));
}
