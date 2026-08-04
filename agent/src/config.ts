import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PORT } from '@pcr/shared';

import { createLogger } from './log.js';

const log = createLogger('config');

export interface IssuedToken {
  /** sha256 of the raw token. The raw value is only ever sent to the client once. */
  hash: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface AgentConfig {
  version: 1;
  /**
   * 6-digit pairing PIN, stored in cleartext on purpose so you can read it back
   * out of the file if you lose the console scrollback. Only 10^6 values exist,
   * so hashing it would buy nothing against an offline attacker who has the
   * file — the real defences are the rate limiter and the fact that this never
   * leaves the LAN.
   */
  pin: string;
  port: number;
  /** Bind address. 0.0.0.0 so the phone can reach it; loopback for testing. */
  host: string;
  tokens: IssuedToken[];
  createdAt: number;
}


export function dataDir(): string {
  const override = process.env['PCR_DATA_DIR'];
  if (override) return path.resolve(override);
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'pc-remote');
  }
  const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return path.join(xdg, 'pc-remote');
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

export function generatePin(): string {
  // randomInt is uniform over the range; String#padStart keeps leading zeros so
  // "000123" is a valid PIN and the printed length is always 6.
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function defaults(): AgentConfig {
  return {
    version: 1,
    pin: generatePin(),
    port: Number(process.env['PCR_PORT'] ?? DEFAULT_PORT),
    host: process.env['PCR_HOST'] ?? '0.0.0.0',
    tokens: [],
    createdAt: Date.now(),
  };
}

/** Fills in anything a hand-edited or older config file is missing. */
function normalise(raw: unknown): { config: AgentConfig; repaired: boolean } {
  const base = defaults();
  if (typeof raw !== 'object' || raw === null) return { config: base, repaired: true };
  const input = raw as Record<string, unknown>;
  let repaired = false;

  const pin =
    typeof input['pin'] === 'string' && /^\d{6}$/.test(input['pin']) ? input['pin'] : undefined;
  if (!pin) repaired = true;

  const port =
    typeof input['port'] === 'number' && input['port'] > 0 && input['port'] < 65536
      ? input['port']
      : undefined;
  if (!port) repaired = true;

  const tokens = Array.isArray(input['tokens'])
    ? input['tokens'].filter(
        (t): t is IssuedToken =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as IssuedToken).hash === 'string' &&
          (t as IssuedToken).hash.length === 64,
      )
    : [];
  if (!Array.isArray(input['tokens'])) repaired = true;



  return {
    config: {
      version: 1,
      pin: pin ?? base.pin,
      // An explicit PCR_PORT/PCR_HOST env var wins over the stored value so you
      // can move the agent off 8765 without editing the file.
      port: process.env['PCR_PORT'] ? base.port : (port ?? base.port),
      host: process.env['PCR_HOST']
        ? base.host
        : typeof input['host'] === 'string'
          ? input['host']
          : base.host,
      tokens,
      createdAt: typeof input['createdAt'] === 'number' ? input['createdAt'] : base.createdAt,
    },
    repaired,
  };
}

export class ConfigStore {
  #config: AgentConfig;
  #file: string;
  #writeTimer: NodeJS.Timeout | undefined;
  #writing = false;
  #dirty = false;

  /** True when no config file existed, i.e. this is a first run. */
  readonly isFirstRun: boolean;

  private constructor(config: AgentConfig, file: string, isFirstRun: boolean) {
    this.#config = config;
    this.#file = file;
    this.isFirstRun = isFirstRun;
  }

  static async load(): Promise<ConfigStore> {
    const file = configPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });

    let raw: string | undefined;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === undefined) {
      const config = defaults();
      const store = new ConfigStore(config, file, true);
      await store.flush();
      log.info(`created ${file}`);
      return store;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A truncated file (power loss mid-write) must not brick startup. Keep a
      // copy so nothing is silently destroyed, then start fresh.
      const backup = `${file}.corrupt-${Date.now()}`;
      await fsp.rename(file, backup).catch(() => undefined);
      log.warn(`config was not valid JSON; moved it to ${backup} and regenerated`);
      const store = new ConfigStore(defaults(), file, true);
      await store.flush();
      return store;
    }

    const { config, repaired } = normalise(parsed);
    const store = new ConfigStore(config, file, false);
    if (repaired) {
      log.warn('config was missing or had invalid fields; filled in defaults');
      await store.flush();
    }
    return store;
  }

  get current(): Readonly<AgentConfig> {
    return this.#config;
  }

  get file(): string {
    return this.#file;
  }

  /** Mutate and persist. The write is debounced; `flush()` forces it. */
  update(mutator: (config: AgentConfig) => void): void {
    mutator(this.#config);
    this.#dirty = true;
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = undefined;
      void this.flush();
    }, 250);
    this.#writeTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.#writing) {
      this.#dirty = true;
      return;
    }
    this.#writing = true;
    this.#dirty = false;
    const tmp = `${this.#file}.tmp-${process.pid}`;
    try {
      // Write-then-rename so a crash can never leave a half-written config,
      // and mode 0600 so other local accounts cannot read the PIN.
      await fsp.writeFile(tmp, `${JSON.stringify(this.#config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fsp.rename(tmp, this.#file);
    } catch (err) {
      log.error('failed to persist config:', err);
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    } finally {
      this.#writing = false;
      if (this.#dirty) await this.flush();
    }
  }

  /** Best-effort synchronous save, for the process exit path. */
  flushSync(): void {
    try {
      fs.writeFileSync(this.#file, `${JSON.stringify(this.#config, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // Nothing useful to do while exiting.
    }
  }
}
