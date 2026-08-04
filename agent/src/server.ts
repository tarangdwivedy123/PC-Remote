import path from 'node:path';

import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import {
  PROTOCOL_VERSION,
  type HostInfo,
  type PairErrorResponse,
  type PairResponse,
} from '@pcr/shared';

import type { AuthService } from './auth.js';
import type { CommandRouter } from './commands.js';
import type { ConfigStore } from './config.js';
import { createLogger } from './log.js';
import { findClientDir } from './paths.js';
import type { StateHub } from './state.js';
import { WsHub } from './ws.js';

const log = createLogger('http');

/** Cap on request bodies. Nothing this API accepts is remotely this large. */
const MAX_BODY_BYTES = 64 * 1024;

/** Cap on WebSocket frames, same reasoning. */
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook once a bearer token has been verified. */
    pcrDevice?: string;
    pcrToken?: string;
  }
}

export interface ServerOptions {
  config: ConfigStore;
  auth: AuthService;
  hub: StateHub;
  router: CommandRouter;
  host: HostInfo;
  /**
   * Supplies the current album art. A getter rather than the bytes themselves
   * because the artwork changes with the track, and the media service is created
   * after the server is already listening.
   */
  getThumbnail?: () => { id: string; bytes: Buffer; contentType: string } | undefined;
}

export interface StartedServer {
  fastify: FastifyInstance;
  wsHub: WsHub;
  address: string;
  clientDir: string | undefined;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// LAN-only guard
// ---------------------------------------------------------------------------

function isLanAddress(ip: string): boolean {
  // Strip the IPv4-mapped-IPv6 prefix Node uses on dual-stack sockets.
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) return true;

  const v4 = addr.split('.');
  if (v4.length === 4) {
    const a = Number(v4[0]);
    const b = Number(v4[1]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  const lower = addr.toLowerCase();
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const { config, auth, hub, router, host } = options;

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    // Never trust forwarding headers: there is no reverse proxy in front of this
    // and honouring them would let a client fake its source IP past the LAN
    // guard and the pairing throttle.
    trustProxy: false,
  });

  // -- security posture ----------------------------------------------------

  const allowAnyIp = process.env['PCR_ALLOW_ANY_IP'] === '1';

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!allowAnyIp && !isLanAddress(request.ip)) {
      // A request from outside RFC1918 space means this port is exposed in a way
      // it should never be. Refuse rather than serve.
      log.warn(`refused non-LAN request from ${request.ip} (${request.method} ${request.url})`);
      await reply.code(403).send({ error: 'This agent only serves local network clients.' });
      return reply;
    }

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // No cross-origin callers exist: the client is served from this same origin.
    // Deliberately emitting no Access-Control-Allow-* headers at all.
    return undefined;
  });

  // -- websocket -----------------------------------------------------------

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      // Compression on a 1 KB/s JSON stream costs more CPU than it saves, and
      // permessage-deflate has a history of bugs on old mobile Chrome.
      perMessageDeflate: false,
      clientTracking: false,
    },
  });

  const wsHub = new WsHub({ hub, auth, router, host });

  // -- auth helpers --------------------------------------------------------

  function extractToken(request: FastifyRequest): string | undefined {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      return header.slice(7).trim();
    }
    // Query fallback for the two cases that cannot set request headers: the
    // browser WebSocket API, and the <img> tag that loads album art.
    //
    // A token in a URL is worse than one in a header — it lands in logs and
    // referrers. Acceptable here because this is LAN-only, same-origin, and the
    // token is revocable from the console with --revoke-all.
    const query = request.query as Record<string, unknown> | undefined;
    const q = query?.['token'];
    return typeof q === 'string' && q.length > 0 ? q : undefined;
  }

  async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const token = extractToken(request);
    const result = auth.verifyToken(token);
    if (!result.valid || token === undefined) {
      reply.header('WWW-Authenticate', 'Bearer');
      await reply.code(401).send({ error: 'Not paired. Enter the PIN shown on the PC.' });
      return false;
    }
    request.pcrDevice = result.label ?? 'phone';
    request.pcrToken = token;
    return true;
  }

  // -- public routes -------------------------------------------------------

  /** Liveness / discovery. Deliberately reveals nothing beyond the protocol. */
  app.get('/api/health', async () => ({
    ok: true,
    name: 'pc-remote',
    protocol: PROTOCOL_VERSION,
    version: host.agentVersion,
  }));

  app.post('/api/pair', async (request, reply) => {
    const ip = request.ip;

    const lockedFor = auth.throttle.check(ip);
    if (lockedFor > 0) {
      const body: PairErrorResponse = {
        error: `Too many attempts. Wait ${Math.ceil(lockedFor / 1000)}s.`,
        retryAfterMs: lockedFor,
      };
      reply.header('Retry-After', String(Math.ceil(lockedFor / 1000)));
      return reply.code(429).send(body);
    }

    const body = request.body as Record<string, unknown> | undefined;
    const pin = body?.['pin'];
    const rawName = body?.['deviceName'];

    if (!auth.verifyPin(pin)) {
      const lockout = auth.throttle.recordFailure(ip);
      log.warn(`failed pairing attempt from ${ip}`);
      const response: PairErrorResponse = lockout
        ? {
            error: `Too many attempts. Wait ${Math.ceil(lockout / 1000)}s.`,
            retryAfterMs: lockout,
          }
        : { error: 'Wrong PIN.' };
      // A uniform 401 for both "wrong PIN" and "malformed body" avoids handing
      // a brute-forcer any signal about which part it got right.
      return reply.code(lockout ? 429 : 401).send(response);
    }

    auth.throttle.recordSuccess(ip);
    const deviceName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : `phone@${ip}`;
    const token = auth.issueToken(deviceName);
    await config.flush();

    const response: PairResponse = { token, host, protocol: PROTOCOL_VERSION };
    return reply.code(200).send(response);
  });

  // -- authenticated routes ------------------------------------------------

  /** Token validity probe. The client calls this on boot before connecting. */
  app.get('/api/session', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;
    return reply.send({ ok: true, device: request.pcrDevice, host, protocol: PROTOCOL_VERSION });
  });

  /** Full snapshot over HTTP. Handy for curl-debugging without a WS client. */
  app.get('/api/state', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;
    return reply.send({ state: hub.snapshot(), history: hub.history });
  });

  /**
   * Album art, fetched separately rather than inlined in the state broadcast.
   * A base64 cover is tens of kilobytes; riding along on every 1 Hz frame would
   * dwarf the rest of the payload and re-send an unchanged image 60 times a
   * minute. The state carries only a `thumbnailId`, and the phone fetches the
   * bytes once per track.
   */
  app.get('/api/media/thumbnail', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;

    const thumbnail = options.getThumbnail?.();
    if (!thumbnail) return reply.code(404).send({ error: 'No artwork for the current track' });

    const requested = (request.query as Record<string, string | undefined>)['id'];
    // A stale id means the track changed between the broadcast and the fetch.
    // 404 rather than serving the new image under the old id, so the phone's
    // cache never holds the wrong art for a track.
    if (requested !== undefined && requested !== thumbnail.id) {
      return reply.code(404).send({ error: 'That artwork is no longer current' });
    }

    return reply
      .header('content-type', thumbnail.contentType)
      // Immutable: the id changes whenever the image does, so the phone can keep
      // it for as long as it likes.
      .header('cache-control', 'private, max-age=86400, immutable')
      .send(thumbnail.bytes);
  });

  app.post('/api/confirm-token', async (request, reply) => {
    if (!(await requireAuth(request, reply))) return reply;
    const body = request.body as Record<string, unknown> | undefined;
    const action = body?.['action'];
    if (action !== 'system.shutdown' && action !== 'system.restart') {
      return reply.code(400).send({ error: 'unsupported action' });
    }
    const issued = auth.issueConfirmToken(action);
    log.info(`issued ${action} confirm token to ${request.pcrDevice}`);
    return reply.send(issued);
  });

  app.get('/ws', { websocket: true }, (socket, request) => {
    // preValidation below has already rejected unauthenticated upgrades, so a
    // socket reaching this handler is always paired.
    wsHub.add(socket, request.pcrDevice ?? 'phone', request.ip, request.pcrToken ?? '');
  });

  // The websocket route needs its auth check during the HTTP upgrade, before any
  // frames can flow. Replying from preValidation aborts the upgrade with a real
  // HTTP status the client can read.
  app.addHook('preValidation', async (request, reply) => {
    if (request.url.split('?')[0] !== '/ws') return undefined;
    const token = extractToken(request);
    const result = auth.verifyToken(token);
    if (!result.valid || token === undefined) {
      log.warn(`rejected unauthenticated WebSocket from ${request.ip}`);
      await reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
    request.pcrDevice = result.label ?? 'phone';
    request.pcrToken = token;
    return undefined;
  });

  // -- static client -------------------------------------------------------

  const { dir: clientDir, searched } = findClientDir();

  if (clientDir) {
    /**
     * Everything Vite emits under assets/ has a content hash in its filename
     * (`index-DiJLNdS_.js`), so those are safe to pin forever — a rebuild
     * changes the name. Matching on the directory rather than the filename
     * shape matters: Vite's hashes are base64url, so a `[0-9a-f]{8}` pattern
     * silently matches nothing and every asset ends up uncached.
     */
    const assetsPrefix = path.join(clientDir, 'assets') + path.sep;

    await app.register(fastifyStatic, {
      root: clientDir,
      // The SPA fallback below owns unmatched paths.
      wildcard: false,
      index: ['index.html'],
      // Without this, @fastify/static emits `public, max-age=0` of its own and
      // overwrites whatever setHeaders below writes.
      cacheControl: false,
      // Still send ETag/Last-Modified so the no-cache resources revalidate
      // cheaply with a 304 instead of retransmitting.
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (filePath.startsWith(assetsPrefix)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          // index.html, the manifest and the service worker must revalidate, or
          // the phone will pin an old bundle against a newer agent forever.
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    });
    log.info(`serving client from ${clientDir}`);
  } else {
    log.warn('no built client found; run `npm run build:client` (searched below)');
    for (const p of searched) log.debug(`  ${p}`);
  }

  app.setNotFoundHandler(async (request, reply) => {
    // API 404s stay JSON; anything else is a client-side route and gets the shell.
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
      return reply.code(404).send({ error: 'not found' });
    }
    if (!clientDir) {
      return reply
        .code(503)
        .type('text/plain; charset=utf-8')
        .send(
          'The phone client has not been built yet.\n\n' +
            'On the PC, run:  npm run build\n' +
            'Or for development with hot reload:  npm run dev\n',
        );
    }
    reply.header('Cache-Control', 'no-cache');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        // @vitejs/plugin-legacy injects inline bootstrap scripts for the
        // nomodule path, and Tailwind's build emits a plain stylesheet plus a
        // few inline styles from React. Safe here: there is no untrusted
        // content on this origin and no external hosts are reachable.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        // data: covers the base64 album art from the media helper.
        "img-src 'self' data: blob:",
        // ws: is listed explicitly because Chrome before ~84 did not treat a
        // same-origin WebSocket as matching 'self' here.
        "connect-src 'self' ws: wss:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    return reply.sendFile('index.html');
  });

  // -- listen --------------------------------------------------------------

  const { port, host: bindHost } = config.current;
  try {
    await app.listen({ port, host: bindHost });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `Port ${port} is already in use. Another copy of the agent may be running — ` +
          `check Task Manager for node.exe, or set PCR_PORT to a different port.`,
      );
    }
    if (code === 'EACCES') {
      throw new Error(`Not allowed to bind port ${port}. Try a port above 1024.`);
    }
    throw err;
  }

  wsHub.start();
  hub.start();

  return {
    fastify: app,
    wsHub,
    address: `${bindHost}:${port}`,
    clientDir,
    async close() {
      hub.stop();
      wsHub.stop();
      await app.close();
    },
  };
}
