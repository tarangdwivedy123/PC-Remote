import type { HostInfo, PairErrorResponse, PairResponse } from '@pcr/shared';

import { getDeviceName, getToken } from './storage';

/**
 * HTTP calls to the agent. Always same-origin: in production the agent serves
 * this bundle itself, and in development Vite proxies /api through to it. That
 * means no CORS, no configurable base URL, and no way for the phone to end up
 * talking to the wrong machine.
 */

/** Requests fail fast — the agent is on the same Wi-Fi, so it is up or it isn't. */
const TIMEOUT_MS = 8000;

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  // AbortController is Chrome 66+, so it is safe on the target device, but
  // AbortSignal.timeout() (Chrome 103) is not — hence the manual timer.
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (auth) {
    const token = getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      signal: controller.signal,
      // The agent's cache headers are correct, but an intermediate proxy on a
      // hotel-style network could still serve a stale API response.
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, 'The PC did not respond. Is the agent running?');
    }
    throw new ApiError(0, 'Could not reach the PC. Check Wi-Fi.');
  } finally {
    window.clearTimeout(timer);
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const errBody = body as PairErrorResponse | undefined;
    throw new ApiError(
      response.status,
      errBody?.error ?? `Request failed (${response.status})`,
      errBody?.retryAfterMs,
    );
  }

  return body as T;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  protocol: number;
  version: string;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health', {}, false);
}

/**
 * Pairs using the single-use code carried in the QR code.
 *
 * Kept separate from the PIN call because the failure modes differ: a spent code
 * is not a wrong password, it is a stale QR, and the phone should say so rather
 * than implying the user got something wrong.
 */
export function pairWithCode(code: string): Promise<PairResponse> {
  return request<PairResponse>('/api/pair', {
    method: 'POST',
    body: JSON.stringify({ code, deviceName: getDeviceName() }),
  });
}

export function pair(pin: string): Promise<PairResponse> {
  return request<PairResponse>(
    '/api/pair',
    { method: 'POST', body: JSON.stringify({ pin, deviceName: getDeviceName() }) },
    false,
  );
}

export interface SessionResponse {
  ok: boolean;
  device: string;
  host: HostInfo;
  protocol: number;
}

/**
 * Validates the stored token. Used on boot and after a failed WebSocket
 * handshake, because the browser WebSocket API exposes no HTTP status when an
 * upgrade is rejected — every failure surfaces as close code 1006, so an
 * expired token and a downed agent look identical without this.
 */
export function getSession(): Promise<SessionResponse> {
  return request<SessionResponse>('/api/session');
}

export interface ConfirmTokenResponse {
  token: string;
  expiresAt: number;
}

export function getConfirmToken(
  action: 'system.shutdown' | 'system.restart',
): Promise<ConfirmTokenResponse> {
  return request<ConfirmTokenResponse>('/api/confirm-token', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}
