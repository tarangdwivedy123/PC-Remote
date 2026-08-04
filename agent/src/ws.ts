import type { WebSocket } from 'ws';

import {
  BROADCAST_INTERVAL_MS,
  PROTOCOL_VERSION,
  type AckFrame,
  type ErrorFrame,
  type HelloFrame,
  type HostInfo,
  type ServerFrame,
} from '@pcr/shared';

import { TokenBucket, type AuthService } from './auth.js';
import { ClientFrameSchema, CommandError, CommandRouter, commandCost } from './commands.js';
import { createLogger } from './log.js';
import type { Broadcast, StateHub } from './state.js';

const log = createLogger('ws');

/** Bucket sizing: absorbs a ~40-event slider drag, refills at 20/s. */
const BUCKET_CAPACITY = 40;
const BUCKET_REFILL_PER_SEC = 20;

/** Liveness probe interval. Two missed probes closes the socket. */
const HEARTBEAT_MS = 15_000;

/**
 * If the OS send buffer backs up past this, the phone has stalled (screen off,
 * Wi-Fi roaming). Dropping patches is correct: they are superseded a second
 * later anyway, and queueing them would grow memory until the TCP timeout.
 */
const MAX_BUFFERED_BYTES = 512 * 1024;

/** Sentinel meaning "this connection's baseline is unknown, send full state". */
const NO_BASELINE = -1;

let nextConnectionId = 1;

class Connection {
  readonly id = nextConnectionId++;
  readonly socket: WebSocket;
  readonly device: string;
  readonly remoteAddress: string;
  readonly token: string;

  baselineRev = NO_BASELINE;
  bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC);
  awaitingPong = false;
  closed = false;

  constructor(socket: WebSocket, device: string, remoteAddress: string, token: string) {
    this.socket = socket;
    this.device = device;
    this.remoteAddress = remoteAddress;
    this.token = token;
  }

  send(frame: ServerFrame): boolean {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return false;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Force the next send to be a full snapshot, since this connection is
      // about to miss whatever delta we were going to hand it.
      this.baselineRev = NO_BASELINE;
      return false;
    }
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.debug(`send to #${this.id} failed:`, err);
      return false;
    }
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close(code, reason);
    } catch {
      // Already gone.
    }
  }
}

export interface WsHubOptions {
  hub: StateHub;
  auth: AuthService;
  router: CommandRouter;
  host: HostInfo;
}

export class WsHub {
  #connections = new Set<Connection>();
  #options: WsHubOptions;
  #unsubscribe: (() => void) | undefined;
  #heartbeat: NodeJS.Timeout | undefined;

  constructor(options: WsHubOptions) {
    this.#options = options;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Labels of currently connected devices, for the console log. */
  get devices(): string[] {
    return [...this.#connections].map((c) => c.device);
  }

  start(): void {
    this.#unsubscribe = this.#options.hub.subscribe((b) => this.#onBroadcast(b));
    this.#heartbeat = setInterval(() => this.#probe(), HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const conn of this.#connections) conn.close(1001, 'agent shutting down');
    this.#connections.clear();
  }

  /**
   * Adopt a freshly upgraded socket. The token has already been verified during
   * the HTTP upgrade — an unauthenticated socket never reaches this method.
   */
  add(socket: WebSocket, device: string, remoteAddress: string, token: string): void {
    const conn = new Connection(socket, device, remoteAddress, token);
    this.#connections.add(conn);
    log.info(
      `connected: ${device} from ${remoteAddress} (#${conn.id}, ${this.#connections.size} total)`,
    );

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      void this.#onMessage(conn, data, isBinary);
    });
    socket.on('pong', () => {
      conn.awaitingPong = false;
    });
    socket.on('error', (err: Error) => {
      log.debug(`socket #${conn.id} error:`, err.message);
    });
    socket.on('close', (code: number) => {
      conn.closed = true;
      this.#connections.delete(conn);
      log.info(`disconnected: ${device} (#${conn.id}, code ${code}, ${this.#connections.size} left)`);
    });

    const hello: HelloFrame = {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      host: this.#options.host,
      // The last *broadcast* state, not a fresh snapshot: this is the object the
      // next delta will be diffed against, so seeding the client with anything
      // else desynchronises it. See StateHub.broadcastBaseline.
      state: this.#options.hub.broadcastBaseline,
      history: this.#options.hub.history,
      serverTime: Date.now(),
      intervalMs: BROADCAST_INTERVAL_MS,
    };
    if (conn.send(hello)) {
      conn.baselineRev = this.#options.hub.revision;
    }
  }

  #onBroadcast(broadcast: Broadcast): void {
    for (const conn of this.#connections) {
      if (conn.closed) continue;

      const canPatch = conn.baselineRev === broadcast.baseRev && broadcast.patch !== undefined;

      let sent: boolean;
      if (canPatch) {
        sent = conn.send({ type: 'patch', patch: broadcast.patch!, sample: broadcast.sample });
      } else if (conn.baselineRev === broadcast.baseRev) {
        // Nothing changed. Still forward the sample if there is one, so charts
        // keep advancing while the numbers happen to be identical.
        sent = broadcast.sample
          ? conn.send({ type: 'patch', patch: {}, sample: broadcast.sample })
          : true;
      } else {
        sent = conn.send({ type: 'state', state: broadcast.state, sample: broadcast.sample });
      }

      if (sent) conn.baselineRev = broadcast.rev;
    }
  }

  #probe(): void {
    for (const conn of this.#connections) {
      if (conn.closed) continue;
      if (conn.awaitingPong) {
        // Missed the previous probe: the phone is gone (Wi-Fi dropped, screen
        // slept) but TCP has not noticed. terminate() skips the close handshake
        // so the slot is freed now rather than in ~2 minutes.
        log.info(`no pong from ${conn.device} (#${conn.id}); dropping`);
        conn.closed = true;
        this.#connections.delete(conn);
        try {
          conn.socket.terminate();
        } catch {
          // Nothing to do.
        }
        continue;
      }
      conn.awaitingPong = true;
      try {
        conn.socket.ping();
      } catch {
        conn.awaitingPong = false;
      }
    }
  }

  async #onMessage(
    conn: Connection,
    data: Buffer | ArrayBuffer | Buffer[],
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.#sendError(conn, 'bad_request', 'binary frames are not accepted');
      return;
    }

    let parsed: unknown;
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data.toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      this.#sendError(conn, 'bad_request', 'frame was not valid JSON');
      return;
    }

    const result = ClientFrameSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.join('.');
      this.#sendError(
        conn,
        'bad_request',
        `invalid frame${where ? ` at ${where}` : ''}: ${issue?.message ?? 'unknown'}`,
      );
      return;
    }

    const frame = result.data;

    if (frame.type === 'ping') {
      // Cheap, but still metered — a ping flood is as expensive as any other.
      if (!conn.bucket.tryConsume(1)) return;
      conn.send({ type: 'pong', t: frame.t });
      return;
    }

    const cost = commandCost(frame.command.kind);
    if (!conn.bucket.tryConsume(cost)) {
      log.warn(`rate limited ${conn.device}: ${frame.command.kind}`);
      const ack: AckFrame = {
        type: 'ack',
        id: frame.id,
        ok: false,
        error: 'Too many commands — slow down',
      };
      conn.send(ack);
      return;
    }

    this.#options.auth.touchToken(conn.token);

    try {
      await this.#options.router.dispatch(frame.command, {
        device: conn.device,
        remoteAddress: conn.remoteAddress,
      });
      conn.send({ type: 'ack', id: frame.id, ok: true });
      // Push the resulting state change out now instead of waiting for the next
      // tick; a remote control that lags a full second feels broken.
      this.#options.hub.flush();
    } catch (err) {
      const message =
        err instanceof CommandError
          ? err.message
          : `Command failed: ${(err as Error).message ?? 'unknown error'}`;
      if (!(err instanceof CommandError)) {
        log.error(`${frame.command.kind} threw:`, err);
      }
      conn.send({ type: 'ack', id: frame.id, ok: false, error: message });
    }
  }

  #sendError(conn: Connection, code: ErrorFrame['code'], message: string): void {
    conn.send({ type: 'error', code, message });
  }
}
