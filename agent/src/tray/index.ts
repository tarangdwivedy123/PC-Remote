import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';

import { createLogger } from '../log.js';
import { readAsset } from '../packaged.js';
import { qrMatrix } from '../qr.js';
import { TRAY_SCRIPT } from './script.js';

const log = createLogger('tray');

/** Icon bytes, from inside the packaged exe or from the repo during development. */
function findIcon(): Buffer | undefined {
  const embedded = readAsset('pcremote.ico');
  if (embedded) return embedded;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', '..', 'installer', 'pcremote.ico'),
    path.resolve(here, '..', '..', 'installer', 'pcremote.ico'),
    path.resolve(path.dirname(process.execPath), 'pcremote.ico'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

type TrayChild = ChildProcessByStdio<Writable, Readable, Readable>;

export interface TrayInfo {
  /** Address to show and encode, with the one-time pairing code attached. */
  pairUrl: string;
  /** Plain address, for typing by hand. */
  plainUrl: string;
  /** Wi-Fi network the PC is on, named so the user can match their phone to it. */
  network: string;
  pin: string;
}

/**
 * Tray icon and first-run window.
 *
 * The reason this exists at all: without it the agent is an invisible
 * background process. There is no way to tell whether it is running, no way to
 * get the pairing QR back once the window is closed, and no way to stop it
 * short of Task Manager. For anyone who is not going to read a console, that
 * gap is most of the difference between a script and a product.
 *
 * Entirely optional. Every failure path here leaves the agent running normally
 * with its console banner — a tray icon that will not start is a worse
 * experience, not a broken one.
 */
export class Tray {
  #child: TrayChild | undefined;
  #buffer = '';
  #nextId = 1;
  #ready = false;
  #stopped = false;
  #onQuit: (() => void) | undefined;

  get available(): boolean {
    return this.#ready;
  }

  /** @param onQuit invoked when the user picks Quit from the tray menu. */
  async start(info: TrayInfo, onQuit: () => void): Promise<void> {
    if (process.platform !== 'win32') return;
    this.#onQuit = onQuit;

    let scriptPath: string;
    try {
      scriptPath = path.join(os.tmpdir(), 'pcr-tray.ps1');
      writeFileSync(scriptPath, TRAY_SCRIPT, 'utf8');
      // The script picks this up from its own directory. Without it the tray
      // falls back to the generic application icon, which is legible but says
      // nothing about which app it belongs to.
      const icon = findIcon();
      if (icon) writeFileSync(path.join(os.tmpdir(), 'pcr-tray.ico'), icon);
    } catch (err) {
      log.debug(`could not write the tray script: ${(err as Error).message}`);
      return;
    }

    try {
      this.#child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', scriptPath, String(process.pid)],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      ) as TrayChild;
    } catch (err) {
      log.debug(`could not start the tray: ${(err as Error).message}`);
      return;
    }

    const child = this.#child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const message = chunk.trim();
      if (message) log.debug(`tray: ${message.slice(0, 200)}`);
    });
    child.on('error', () => {
      this.#ready = false;
      this.#child = undefined;
    });
    child.on('exit', () => {
      if (this.#stopped) return;
      this.#ready = false;
      this.#child = undefined;
      log.debug('tray process exited');
    });

    // -STA plus loading WinForms takes a moment; give up quietly rather than
    // delaying startup for a decoration.
    const ready = await this.#waitForReady(6000);
    if (!ready) {
      log.debug('tray did not report ready; continuing without it');
      return;
    }

    this.update(info);
    log.info('tray icon ready');
  }

  #waitForReady(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = (): void => {
        if (this.#ready) return resolve(true);
        if (!this.#child || Date.now() > deadline) return resolve(false);
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /** Pushes a fresh QR and address. Called again whenever the code rotates. */
  update(info: TrayInfo): void {
    this.#send({
      cmd: 'update',
      modules: qrMatrix(info.pairUrl).map((row) => row.map((dark) => (dark ? 1 : 0))),
      url: info.plainUrl,
      network: info.network,
      pin: info.pin,
    });
  }

  /** Opens the QR window. Used on first run and from the tray menu. */
  show(): void {
    this.#send({ cmd: 'show' });
  }

  notify(title: string, text: string): void {
    this.#send({ cmd: 'balloon', title, text });
  }

  stop(): void {
    this.#stopped = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: 'quit' })}\n`);
      child.stdin.end();
    } catch {
      // Already gone.
    }
    // Give it a moment to remove its own icon; a NotifyIcon that is not
    // disposed leaves a ghost in the tray until the user hovers over it.
    setTimeout(() => child.kill(), 400).unref?.();
  }

  #send(payload: Record<string, unknown>): void {
    const child = this.#child;
    if (!child || !this.#ready) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: this.#nextId++, ...payload })}\n`);
    } catch (err) {
      log.debug('tray write failed:', err);
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || !trimmed.startsWith('{')) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        if (msg['ready'] === true) this.#ready = true;
        if (msg['quit'] === true) {
          log.info('quit requested from the tray');
          this.#onQuit?.();
        }
      } catch {
        // Non-JSON noise from PowerShell is not worth reporting.
      }
    }
  }
}
