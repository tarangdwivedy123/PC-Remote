import {
  HISTORY_LENGTH,
  PROTOCOL_VERSION,
  applyPatch,
  type AgentState,
  type ClientFrame,
  type Command,
  type HostInfo,
  type ServerFrame,
  type StatsSample,
} from '@pcr/shared';

import { ApiError, getSession } from './api';
import { clearToken, getToken } from './storage';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  /** Was connected, lost it, and is backing off before the next attempt. */
  | 'reconnecting'
  /** The stored token is no longer accepted; the app must re-pair. */
  | 'unauthorized';

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  state: AgentState | null;
  host: HostInfo | null;
  history: StatsSample[];
  /** Epoch ms of the last frame received, for the staleness indicator. */
  lastFrameAt: number | null;
  rttMs: number | null;
  /** Consecutive failed attempts; 0 while healthy. */
  attempt: number;
  /** Epoch ms of the next scheduled attempt, so the UI can count down. */
  nextRetryAt: number | null;
  /** Set when the agent speaks a different protocol version than this bundle. */
  protocolMismatch: boolean;
  lastError: string | null;
}

// -- reconnect tuning --------------------------------------------------------

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 1.7;
/**
 * Capped low on purpose. This is a LAN with a remote control on it: waiting 15s
 * after the Wi-Fi comes back would feel broken, and a retry costs nothing.
 */
const BACKOFF_MAX_MS = 15_000;
const BACKOFF_JITTER = 0.25;

/** How often the watchdog checks for a silently dead socket. */
const WATCHDOG_INTERVAL_MS = 2000;
/**
 * The agent broadcasts every 1000ms, so 6s of silence means the connection is
 * gone even though the browser still reports it OPEN. This is the normal outcome
 * of walking out of Wi-Fi range: the TCP connection has no idea yet.
 */
const STALE_AFTER_MS = 6000;

const PING_INTERVAL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 8000;

interface Pending {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

/**
 * Owns the WebSocket lifecycle outside React.
 *
 * Deliberately not a hook: React 18 StrictMode double-invokes effects in
 * development, which would open and tear down sockets in pairs, and the
 * reconnect state machine has to survive component remounts. Components read it
 * through useSyncExternalStore instead.
 */
export class AgentConnection {
  #socket: WebSocket | null = null;
  #snapshot: ConnectionSnapshot = {
    status: 'idle',
    state: null,
    host: null,
    history: [],
    lastFrameAt: null,
    rttMs: null,
    attempt: 0,
    nextRetryAt: null,
    protocolMismatch: false,
    lastError: null,
  };

  #listeners = new Set<() => void>();
  #retryTimer: number | undefined;
  #watchdog: number | undefined;
  #pingTimer: number | undefined;
  #pending = new Map<string, Pending>();
  #nextCommandId = 1;
  #started = false;
  #onUnauthorized: (() => void) | undefined;
  /** True once the current socket reached OPEN, to tell handshake failures apart. */
  #everOpened = false;

  // -- external store interface -------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): ConnectionSnapshot => this.#snapshot;

  #update(partial: Partial<ConnectionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...partial };
    for (const listener of this.#listeners) listener();
  }

  // -- lifecycle -----------------------------------------------------------

  /** Called once the app has a token. Idempotent. */
  start(onUnauthorized?: () => void): void {
    if (onUnauthorized) this.#onUnauthorized = onUnauthorized;
    if (this.#started) return;
    this.#started = true;

    window.addEventListener('online', this.#onOnline);
    window.addEventListener('offline', this.#onOffline);
    document.addEventListener('visibilitychange', this.#onVisibility);
    // Some old Chrome builds fire pageshow (from the back/forward cache) without
    // a visibilitychange, leaving a socket that was torn down while frozen.
    window.addEventListener('pageshow', this.#onVisibility);

    this.#watchdog = window.setInterval(() => this.#checkStale(), WATCHDOG_INTERVAL_MS);
    this.#connect();
  }

  stop(): void {
    this.#started = false;
    window.removeEventListener('online', this.#onOnline);
    window.removeEventListener('offline', this.#onOffline);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('pageshow', this.#onVisibility);

    if (this.#watchdog !== undefined) window.clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    this.#clearRetry();
    this.#stopPing();
    this.#closeSocket();
    this.#failAllPending('Disconnected');
    this.#update({ status: 'idle', attempt: 0, nextRetryAt: null });
  }

  /** Force an immediate attempt, e.g. from a "retry now" button. */
  reconnectNow(): void {
    this.#clearRetry();
    this.#closeSocket();
    this.#update({ attempt: 0, nextRetryAt: null, lastError: null });
    this.#connect();
  }

  // -- connect / retry -----------------------------------------------------

  #connect(): void {
    if (!this.#started) return;
    const token = getToken();
    if (!token) {
      this.#update({ status: 'unauthorized' });
      return;
    }
    if (this.#socket) return;

    this.#everOpened = false;
    this.#update({
      status: this.#snapshot.attempt === 0 ? 'connecting' : 'reconnecting',
      nextRetryAt: null,
    });

    // Same origin in both dev (Vite proxies /ws) and production (the agent
    // serves this bundle), so the phone can never point at the wrong machine.
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.#scheduleRetry('Could not open a connection');
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#everOpened = true;
      this.#update({
        status: 'connected',
        attempt: 0,
        nextRetryAt: null,
        lastError: null,
        lastFrameAt: Date.now(),
      });
      this.#startPing();
    };

    socket.onmessage = (event: MessageEvent) => {
      this.#onFrame(event.data);
    };

    socket.onerror = () => {
      // The error event carries no detail by design (it would leak
      // cross-origin information); onclose does the real work.
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.#socket !== socket) return; // superseded by a newer attempt
      this.#socket = null;
      this.#stopPing();
      this.#failAllPending('Connection lost');

      if (!this.#started) return;

      // A close before ever reaching OPEN is either a rejected upgrade (bad
      // token) or an unreachable agent, and the browser gives us 1006 for both.
      if (!this.#everOpened) {
        void this.#diagnoseHandshakeFailure(event);
        return;
      }
      this.#scheduleRetry(describeClose(event));
    };
  }

  /**
   * Distinguishes "token rejected" from "agent unreachable" by asking the HTTP
   * API, which does return a real status code.
   */
  async #diagnoseHandshakeFailure(event: CloseEvent): Promise<void> {
    try {
      await getSession();
      // Token is fine, so the socket route itself failed. Retry.
      this.#scheduleRetry(describeClose(event));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        this.#clearRetry();
        this.#update({
          status: 'unauthorized',
          attempt: 0,
          nextRetryAt: null,
          lastError: 'This phone is no longer paired. Enter the PIN again.',
        });
        this.#onUnauthorized?.();
        return;
      }
      this.#scheduleRetry(
        err instanceof ApiError && err.message ? err.message : describeClose(event),
      );
    }
  }

  #scheduleRetry(reason: string): void {
    if (!this.#started) return;
    this.#clearRetry();

    const attempt = this.#snapshot.attempt + 1;
    const raw = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1), BACKOFF_MAX_MS);
    // Jitter keeps several tabs on the same phone from retrying in lockstep.
    const jittered = raw * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER);
    const delay = Math.max(BACKOFF_BASE_MS, Math.round(jittered));

    this.#update({
      status: 'reconnecting',
      attempt,
      nextRetryAt: Date.now() + delay,
      lastError: reason,
    });

    this.#retryTimer = window.setTimeout(() => {
      this.#retryTimer = undefined;
      this.#connect();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) window.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing.
    }
  }

  // -- liveness ------------------------------------------------------------

  #startPing(): void {
    this.#stopPing();
    this.#pingTimer = window.setInterval(() => {
      if (this.#socket?.readyState !== WebSocket.OPEN) return;
      this.#send({ type: 'ping', t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  #stopPing(): void {
    if (this.#pingTimer !== undefined) window.clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  /**
   * Catches the case the browser never reports: the phone left Wi-Fi range, so
   * the socket is still OPEN as far as the WebSocket API is concerned but no
   * frames are arriving. Without this the UI would show "connected" with frozen
   * numbers until the OS TCP timeout, which can be minutes.
   */
  #checkStale(): void {
    if (this.#snapshot.status !== 'connected') return;
    const last = this.#snapshot.lastFrameAt;
    if (last === null) return;
    if (Date.now() - last < STALE_AFTER_MS) return;
    this.#closeSocket();
    this.#scheduleRetry('Connection went quiet');
  }

  #onOnline = (): void => {
    // The radio is back. Skip the remaining backoff entirely.
    if (this.#snapshot.status === 'unauthorized') return;
    if (this.#snapshot.status === 'connected') return;
    this.reconnectNow();
  };

  #onOffline = (): void => {
    if (this.#snapshot.status === 'unauthorized') return;
    this.#closeSocket();
    this.#clearRetry();
    this.#update({ status: 'reconnecting', lastError: 'Phone is offline', nextRetryAt: null });
  };

  #onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (this.#snapshot.status === 'unauthorized') return;
    // Screen just came on. Anything that was suspended gets re-established now
    // rather than after the backoff timer that never fired while frozen.
    if (this.#snapshot.status !== 'connected' || this.#isStale()) this.reconnectNow();
  };

  #isStale(): boolean {
    const last = this.#snapshot.lastFrameAt;
    return last !== null && Date.now() - last > STALE_AFTER_MS;
  }

  // -- frames --------------------------------------------------------------

  #onFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    const now = Date.now();

    switch (frame.type) {
      case 'hello': {
        this.#update({
          host: frame.host,
          state: frame.state,
          // Trust the agent's replay wholesale: it is the authority on history
          // and this is a fresh connection, so anything local is stale.
          history: frame.history.slice(-HISTORY_LENGTH),
          protocolMismatch: frame.protocol !== PROTOCOL_VERSION,
          lastFrameAt: now,
        });
        break;
      }

      case 'state': {
        this.#update({
          state: frame.state,
          history: appendSample(this.#snapshot.history, frame.sample),
          lastFrameAt: now,
        });
        break;
      }

      case 'patch': {
        const base = this.#snapshot.state;
        if (base === null) {
          // A patch with no baseline cannot be applied. Only reachable if the
          // hello frame was lost, so ask for a clean handshake.
          this.#update({ lastFrameAt: now });
          this.reconnectNow();
          break;
        }
        this.#update({
          state: applyPatch(base, frame.patch),
          history: appendSample(this.#snapshot.history, frame.sample),
          lastFrameAt: now,
        });
        break;
      }

      case 'ack': {
        const pending = this.#pending.get(frame.id);
        if (pending) {
          this.#pending.delete(frame.id);
          window.clearTimeout(pending.timer);
          if (frame.ok) pending.resolve();
          else pending.reject(new Error(frame.error ?? 'Command failed'));
        }
        this.#update({ lastFrameAt: now });
        break;
      }

      case 'pong': {
        this.#update({ rttMs: Math.max(0, now - frame.t), lastFrameAt: now });
        break;
      }

      case 'error': {
        if (frame.code === 'unauthorized') {
          clearToken();
          this.#closeSocket();
          this.#clearRetry();
          this.#update({ status: 'unauthorized', lastError: frame.message });
          this.#onUnauthorized?.();
          break;
        }
        this.#update({ lastError: frame.message, lastFrameAt: now });
        break;
      }
    }
  }

  #send(frame: ClientFrame): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sends a command and resolves when the agent acks it. Rejects with the
   * agent's own message on failure, so the UI can surface "svcl.exe not found"
   * rather than a generic error.
   */
  send(command: Command): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const id = `c${this.#nextCommandId++}`;
      if (!this.#send({ type: 'command', id, command })) {
        reject(new Error('Not connected to the PC'));
        return;
      }
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('The PC did not respond'));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
  }

  /**
   * Fire-and-forget variant for high-frequency input. A dragged volume slider
   * emits a value every ~100ms and the next one supersedes the last, so waiting
   * for each ack would only queue promises nobody reads.
   */
  sendNoAck(command: Command): void {
    const id = `f${this.#nextCommandId++}`;
    this.#send({ type: 'command', id, command });
  }

  #failAllPending(reason: string): void {
    for (const [, pending] of this.#pending) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------------------

function appendSample(
  history: StatsSample[],
  sample: StatsSample | undefined,
): StatsSample[] {
  if (!sample) return history;
  const next = history.length >= HISTORY_LENGTH ? history.slice(1) : history.slice();
  next.push(sample);
  return next;
}

function describeClose(event: CloseEvent): string {
  // 1006 is by far the most common here and means "no close frame received" —
  // Wi-Fi dropped, the agent was killed, or the PC slept.
  if (event.code === 1006) return 'Lost connection to the PC';
  if (event.code === 1001) return 'The agent is shutting down';
  if (event.reason) return event.reason;
  return `Connection closed (${event.code})`;
}

/** One connection per page. */
export const connection = new AgentConnection();
