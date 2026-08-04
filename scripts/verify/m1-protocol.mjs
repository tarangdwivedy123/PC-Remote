import { readFileSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { collectFrames, createChecker, startAgent, tempDataDir } from './lib.mjs';

/**
 * Milestone 1: pairing, auth, the WebSocket handshake, and the broadcast loop.
 * Runs against the TypeScript source via tsx.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 1 — pairing, auth, WebSocket');
  const dataDir = tempDataDir('m1-protocol');
  const port = 8791;

  const agent = await startAgent({
    port,
    dataDir,
    entry: 'source',
    // A fixed LAN IP makes the banner assertion deterministic regardless of
    // which NICs this machine happens to have.
    env: { PCR_LAN_IP: '192.168.1.42' },
  });

  try {
    check('agent starts and answers /api/health', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    // -- banner ------------------------------------------------------------
    const plain = agent.plainOutput;
    check('banner prints the LAN URL', plain.includes(`http://192.168.1.42:${port}`));
    check('banner prints a 6-digit pairing PIN', /Pairing PIN:\s+\d{6}/.test(plain));

    const qrRows = agent.output.split('\n').filter((l) => l.includes('▀'));
    const widths = new Set(qrRows.map((l) => (l.match(/▀/g) ?? []).length));
    check(
      'banner renders a QR block matrix',
      qrRows.length > 10 && widths.size === 1,
      `${qrRows.length} rows x ${[...widths][0]} cols`,
    );

    const health = await (await fetch(`${agent.base}/api/health`)).json();
    check(
      'health reports name + protocol',
      health.name === 'pc-remote' && health.protocol === 1,
      JSON.stringify(health),
    );

    // -- everything is refused without a token -----------------------------
    for (const route of ['/api/session', '/api/state']) {
      const res = await fetch(`${agent.base}${route}`);
      check(`${route} is 401 without a token`, res.status === 401, `got ${res.status}`);
    }

    const bogus = await fetch(`${agent.base}/api/session`, {
      headers: { authorization: 'Bearer not-a-real-token-at-all' },
    });
    check('a bogus bearer token is 401', bogus.status === 401, `got ${bogus.status}`);

    const wrongPin = await fetch(`${agent.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '000000' }),
    });
    check('the wrong PIN is refused', wrongPin.status === 401, `got ${wrongPin.status}`);

    const rejected = await collectFrames(WebSocket, `ws://127.0.0.1:${port}/ws`, {
      until: () => false,
      timeoutMs: 5000,
    });
    check(
      'WebSocket upgrade without a token is refused at the handshake',
      rejected.status === 'http 401',
      rejected.status,
    );

    // -- pairing -----------------------------------------------------------
    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const pairRes = await fetch(`${agent.base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin, deviceName: 'verify-script' }),
    });
    const pairBody = await pairRes.json();
    const token = pairBody.token;
    check(
      'the correct PIN returns a token',
      pairRes.ok && typeof token === 'string' && token.length > 20,
    );
    check('pairing echoes host info and protocol', pairBody.host?.hostname && pairBody.protocol === 1);

    const stored = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    check(
      'the raw token never touches disk — only its sha256',
      stored.tokens.length >= 1 &&
        stored.tokens.every((t) => /^[0-9a-f]{64}$/.test(t.hash)) &&
        !JSON.stringify(stored).includes(token),
      `${stored.tokens.length} device(s) recorded`,
    );

    const session = await fetch(`${agent.base}/api/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    check('the token authenticates /api/session', session.status === 200, `got ${session.status}`);

    // -- authenticated WebSocket -------------------------------------------
    const wsUrl = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`;
    const { status, frames } = await collectFrames(WebSocket, wsUrl, {
      onOpen(ws) {
        ws.send(JSON.stringify({ type: 'ping', t: 12345 }));
        /**
         * Deliberately harmless. Every kind now has a handler, so anything sent
         * here really happens — and this agent does not run with
         * PCR_SYSTEM_DRY_RUN, so a system action would genuinely lock or suspend
         * the machine running the suite. Muting a session id that cannot exist
         * is validated, routed, acked, and then quietly does nothing.
         */
        ws.send(
          JSON.stringify({
            type: 'command',
            id: 'c1',
            command: { kind: 'volume.setAppMuted', id: 'pcr-verify-no-such-app.exe:999999', muted: false },
          }),
        );
        // Out of range: must be rejected by zod before reaching a handler.
        ws.send(
          JSON.stringify({ type: 'command', id: 'c2', command: { kind: 'volume.setMaster', volume: 999 } }),
        );
        ws.send(JSON.stringify({ type: 'command', id: 'c3', command: { kind: 'not.a.command' } }));
        ws.send('this is not json');
      },
      // Wait for at least three broadcast ticks so the delta behaviour is visible.
      until: (f) => f.filter((x) => x.type === 'patch' || x.type === 'state').length >= 3,
      timeoutMs: 9000,
    });
    check('WebSocket upgrade with a token succeeds', status === 'ok', status);

    const hello = frames.find((f) => f.type === 'hello');
    check(
      'hello carries protocol, host, state and history',
      Boolean(hello && hello.protocol === 1 && hello.host && 'state' in hello && Array.isArray(hello.history)),
    );
    check('hello advertises the 1000ms broadcast interval', hello?.intervalMs === 1000, String(hello?.intervalMs));

    const pong = frames.find((f) => f.type === 'pong');
    check('ping is answered with a matching pong', pong?.t === 12345);

    const ack1 = frames.find((f) => f.type === 'ack' && f.id === 'c1');
    check('a handled command is acknowledged', Boolean(ack1 && ack1.ok === true), ack1?.error);

    const errors = frames.filter((f) => f.type === 'error' && f.code === 'bad_request');
    check('an out-of-range value is rejected by zod', errors.some((e) => /less than or equal to 100/.test(e.message)), errors[0]?.message);
    check('an unknown command kind is rejected', errors.length >= 2, `${errors.length} bad_request frames`);
    check('malformed JSON is rejected without killing the socket', errors.length >= 3 && status === 'ok');
    check(
      'no ack is issued for a payload that failed validation',
      !frames.some((f) => f.type === 'ack' && (f.id === 'c2' || f.id === 'c3')),
    );

    const updates = frames.filter((f) => f.type === 'patch' || f.type === 'state');
    check('the 1 Hz timer delivers periodic updates', updates.length >= 3, `${updates.length} frames`);
    check(
      'updates after hello are delta-only, never full state',
      updates.every((f) => f.type === 'patch'),
      updates.map((f) => f.type).join(','),
    );
    /**
     * The delta must be scoped to what actually changed. Each remaining slice
     * has a provider, so any of them may legitimately appear. What must never
     * appear is a key outside this set, which would mean the diff is sending
     * whole state under a different name.
     */
    const patchKeys = new Set(updates.flatMap((f) => Object.keys(f.patch ?? {})));
    check(
      'deltas contain only the slices that changed',
      patchKeys.size > 0 &&
        [...patchKeys].every((k) => ['t', 'stats', 'volume', 'media', 'monitors', 'system'].includes(k)),
      `keys seen: ${[...patchKeys].join(', ')}`,
    );

    // -- 404 behaviour -----------------------------------------------------
    const api404 = await fetch(`${agent.base}/api/nope`);
    check('an unknown /api path stays a JSON 404', api404.status === 404, `got ${api404.status}`);
  } finally {
    await agent.stop();
  }

  return { results };
}
