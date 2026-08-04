/**
 * localStorage access that cannot throw.
 *
 * Chrome refuses storage outright in some configurations (private tabs, "block
 * third-party cookies" on an origin loaded in a WebView), and it throws on
 * quota. An exception here would blank the whole app, so every path degrades to
 * in-memory instead — pairing then survives a reload but not a tab close, which
 * is a far better failure than a white screen.
 */

const TOKEN_KEY = 'pcr.token';
const DEVICE_KEY = 'pcr.deviceName';
const KEEP_AWAKE_KEY = 'pcr.keepAwake';

const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null) return value;
  } catch {
    // Fall through to the in-memory copy.
  }
  return memory.get(key) ?? null;
}

function write(key: string, value: string): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // In-memory only for this session.
  }
}

function remove(key: string): void {
  memory.delete(key);
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

export function getToken(): string | null {
  return read(TOKEN_KEY);
}

export function setToken(token: string): void {
  write(TOKEN_KEY, token);
}

export function clearToken(): void {
  remove(TOKEN_KEY);
}

export function getKeepAwake(): boolean {
  return read(KEEP_AWAKE_KEY) === '1';
}

export function setKeepAwake(on: boolean): void {
  write(KEEP_AWAKE_KEY, on ? '1' : '0');
}

/**
 * A human-readable label for this phone, shown in the agent's console when it
 * pairs and connects. Derived from the user agent because asking the user to
 * name their device is friction for a one-device setup; it is persisted so the
 * label stays stable across re-pairs.
 */
export function getDeviceName(): string {
  const existing = read(DEVICE_KEY);
  if (existing) return existing;

  const ua = navigator.userAgent;
  let name = 'phone';

  // Android puts the model in "Android 9; SM-G950F Build/..." — the segment
  // after the version is the marketing model on essentially every OEM build.
  const android = /Android\s+[\d.]+;\s*([^;)]+?)(?:\s+Build\/|[;)])/i.exec(ua);
  if (android?.[1]) {
    name = android[1].trim();
  } else if (/iPhone/i.test(ua)) {
    name = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    name = 'iPad';
  } else if (/Windows/i.test(ua)) {
    name = 'Windows browser';
  } else if (/Macintosh/i.test(ua)) {
    name = 'Mac browser';
  }

  const clean = name.replace(/[^\w .\-+]/g, '').slice(0, 40) || 'phone';
  write(DEVICE_KEY, clean);
  return clean;
}
