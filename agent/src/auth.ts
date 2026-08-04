import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { CONFIRM_TOKEN_TTL_MS } from '@pcr/shared';

import type { ConfigStore } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('auth');

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison. Length is compared first and short-circuits,
 * which leaks only the length — fine here, since both operands are
 * fixed-width (6-digit PIN, 64-char hex hash).
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Pair attempt throttling
// ---------------------------------------------------------------------------

interface AttemptRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number;
  /** Number of times this IP has been locked out, drives the backoff. */
  lockouts: number;
  updatedAt: number;
}

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 15 * 60_000;
/** Cap the map so a spoofed-source flood cannot grow it without bound. */
const MAX_TRACKED_IPS = 1024;

/**
 * Per-IP throttle for /api/pair. A 6-digit PIN is only 10^6 values, so without
 * this an attacker on the LAN could walk the whole space in seconds.
 */
export class PairThrottle {
  #records = new Map<string, AttemptRecord>();

  #get(ip: string): AttemptRecord {
    let rec = this.#records.get(ip);
    if (!rec) {
      if (this.#records.size >= MAX_TRACKED_IPS) this.#evictOldest();
      rec = { failures: 0, windowStart: Date.now(), lockedUntil: 0, lockouts: 0, updatedAt: Date.now() };
      this.#records.set(ip, rec);
    }
    return rec;
  }

  #evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, rec] of this.#records) {
      if (rec.lockedUntil > Date.now()) continue; // never evict an active lockout
      if (rec.updatedAt < oldestAt) {
        oldestAt = rec.updatedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.#records.delete(oldestKey);
  }

  /** Returns the remaining lockout in ms, or 0 when the IP may attempt now. */
  check(ip: string): number {
    const rec = this.#records.get(ip);
    if (!rec) return 0;
    const now = Date.now();
    if (rec.lockedUntil > now) return rec.lockedUntil - now;
    return 0;
  }

  recordFailure(ip: string): number {
    const rec = this.#get(ip);
    const now = Date.now();
    rec.updatedAt = now;

    if (now - rec.windowStart > WINDOW_MS) {
      rec.windowStart = now;
      rec.failures = 0;
    }
    rec.failures += 1;

    if (rec.failures >= MAX_FAILURES_PER_WINDOW) {
      rec.lockouts += 1;
      // 30s, 60s, 120s, ... capped at 15 minutes.
      const lockout = Math.min(BASE_LOCKOUT_MS * 2 ** (rec.lockouts - 1), MAX_LOCKOUT_MS);
      rec.lockedUntil = now + lockout;
      rec.failures = 0;
      rec.windowStart = now;
      log.warn(`too many bad PINs from ${ip}; locked out for ${Math.round(lockout / 1000)}s`);
      return lockout;
    }
    return 0;
  }

  recordSuccess(ip: string): void {
    this.#records.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

export interface TokenVerification {
  valid: boolean;
  label?: string;
}

export class AuthService {
  #config: ConfigStore;
  #throttle = new PairThrottle();
  /** hash -> label, mirrored from config for O(1) lookups on every request. */
  #index = new Map<string, string>();
  #confirmTokens = new Map<string, { expiresAt: number; action: string }>();

  constructor(config: ConfigStore) {
    this.#config = config;
    this.#reindex();
  }

  #reindex(): void {
    this.#index.clear();
    for (const t of this.#config.current.tokens) this.#index.set(t.hash, t.label);
  }

  get throttle(): PairThrottle {
    return this.#throttle;
  }

  get pin(): string {
    return this.#config.current.pin;
  }

  verifyPin(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const trimmed = candidate.trim();
    if (!/^\d{6}$/.test(trimmed)) return false;
    return safeEqual(trimmed, this.#config.current.pin);
  }

  /**
   * Mints a new bearer token. Only the sha256 is persisted; the raw value is
   * returned once and lives in the phone's localStorage from then on.
   */
  issueToken(label: string): string {
    const raw = randomBytes(32).toString('base64url');
    const hash = sha256Hex(raw);
    const now = Date.now();
    const clean = label.replace(/[^\x20-\x7e]/g, '').slice(0, 64) || 'phone';
    this.#config.update((c) => {
      c.tokens.push({ hash, label: clean, createdAt: now, lastSeenAt: now });
      // Keep the list bounded; re-pairing the same phone after clearing site
      // data would otherwise accumulate dead entries forever.
      if (c.tokens.length > 20) c.tokens.splice(0, c.tokens.length - 20);
    });
    this.#reindex();
    log.info(`issued token for "${clean}" (${this.#index.size} paired device(s))`);
    return raw;
  }

  verifyToken(raw: unknown): TokenVerification {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return { valid: false };
    const hash = sha256Hex(raw);
    const label = this.#index.get(hash);
    if (label === undefined) return { valid: false };
    return { valid: true, label };
  }

  /** Records liveness for the paired-devices list. Debounced by ConfigStore. */
  touchToken(raw: string): void {
    const hash = sha256Hex(raw);
    if (!this.#index.has(hash)) return;
    this.#config.update((c) => {
      const entry = c.tokens.find((t) => t.hash === hash);
      if (entry) entry.lastSeenAt = Date.now();
    });
  }

  revokeAll(): void {
    this.#config.update((c) => {
      c.tokens = [];
    });
    this.#reindex();
    log.warn('revoked all paired devices');
  }

  /**
   * Short-lived token gating destructive system actions. The confirm-twice UI
   * fetches one on the first tap and echoes it back with the command, so a
   * replayed or stray WebSocket frame cannot shut the machine down.
   */
  issueConfirmToken(action: string): { token: string; expiresAt: number } {
    this.#pruneConfirmTokens();
    const token = randomUUID();
    const expiresAt = Date.now() + CONFIRM_TOKEN_TTL_MS;
    this.#confirmTokens.set(token, { expiresAt, action });
    return { token, expiresAt };
  }

  /** Single-use: a successful check consumes the token. */
  consumeConfirmToken(token: unknown, action: string): boolean {
    if (typeof token !== 'string') return false;
    const entry = this.#confirmTokens.get(token);
    if (!entry) return false;
    this.#confirmTokens.delete(token);
    if (entry.expiresAt < Date.now()) return false;
    return entry.action === action;
  }

  #pruneConfirmTokens(): void {
    const now = Date.now();
    for (const [token, entry] of this.#confirmTokens) {
      if (entry.expiresAt < now) this.#confirmTokens.delete(token);
    }
  }
}

// ---------------------------------------------------------------------------
// Token bucket, used to rate-limit inbound commands per connection
// ---------------------------------------------------------------------------

export class TokenBucket {
  #capacity: number;
  #tokens: number;
  #refillPerMs: number;
  #last: number;

  constructor(capacity: number, refillPerSecond: number) {
    this.#capacity = capacity;
    this.#tokens = capacity;
    this.#refillPerMs = refillPerSecond / 1000;
    this.#last = Date.now();
  }

  /** Consumes one token. Returns false when the caller should be throttled. */
  tryConsume(cost = 1): boolean {
    const now = Date.now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#last) * this.#refillPerMs);
    this.#last = now;
    if (this.#tokens < cost) return false;
    this.#tokens -= cost;
    return true;
  }
}
