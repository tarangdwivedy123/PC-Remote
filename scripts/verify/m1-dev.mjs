import { spawn } from 'node:child_process';

import WebSocket from 'ws';

import { REPO_ROOT, collectFrames, createChecker, sleep, startAgent, tempDataDir } from './lib.mjs';

/**
 * Milestone 1: `npm run dev`.
 *
 * In development the phone loads the app from the Vite dev server (port 5173),
 * not from the agent, so hot reload works on the device. Vite proxies /api and
 * /ws straight through to the agent. This suite proves that path works, because
 * it is the one you will actually use while building the remaining milestones —
 * and a broken WebSocket proxy looks exactly like a broken agent.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 1 — dev mode (Vite proxy to the agent)');

  const agentPort = 8793;
  const vitePort = 5199;

  const agent = await startAgent({
    port: agentPort,
    dataDir: tempDataDir('m1-dev'),
    entry: 'source',
    env: { PCR_LAN_IP: '192.168.1.42' },
    // The banner should advertise the Vite URL, not the agent's own.
    // (startAgent passes argv through the env, so use the env form here.)
  });

  let vite;
  try {
    check('agent is up', agent.up);
    if (!agent.up) return { results };

    // Vite needs to proxy to the agent's port, which it reads from PCR_PORT.
    vite = spawn(
      process.execPath,
      [`${REPO_ROOT}/node_modules/vite/bin/vite.js`, '--port', String(vitePort), '--strictPort'],
      {
        cwd: `${REPO_ROOT}/client`,
        env: { ...process.env, PCR_PORT: String(agentPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let viteOut = '';
    vite.stdout.on('data', (d) => (viteOut += d.toString()));
    vite.stderr.on('data', (d) => (viteOut += d.toString()));

    const viteBase = `http://127.0.0.1:${vitePort}`;
    let viteUp = false;
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (vite.exitCode !== null) break;
      try {
        if ((await fetch(viteBase)).ok) {
          viteUp = true;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await sleep(300);
    }
    check('vite dev server starts', viteUp, viteUp ? `port ${vitePort}` : viteOut.slice(-200));
    if (!viteUp) return { results };

    // -- the dev server serves the unbundled app ---------------------------
    const index = await fetch(viteBase);
    const html = await index.text();
    check(
      'dev server serves index.html with the TypeScript entry',
      html.includes('/src/main.tsx'),
      `${html.length} bytes`,
    );
    check('vite injects its HMR client', html.includes('/@vite/client'));

    // -- /api proxies through to the agent ---------------------------------
    const health = await (await fetch(`${viteBase}/api/health`)).json();
    check(
      '/api proxies through Vite to the agent',
      health.name === 'pc-remote' && health.protocol === 1,
      JSON.stringify(health),
    );

    const unauth = await fetch(`${viteBase}/api/session`);
    check('auth is still enforced through the proxy', unauth.status === 401, `got ${unauth.status}`);

    // -- pair and open a WebSocket through the proxy -----------------------
    const pinMatch = agent.plainOutput.match(/Pairing PIN:\s+(\d{6})/);
    const pin = pinMatch?.[1];
    check('the PIN is readable from the agent banner', Boolean(pin), pin);

    const pairRes = await fetch(`${viteBase}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin, deviceName: 'dev-verify' }),
    });
    const { token } = await pairRes.json();
    check('pairing works through the proxy', pairRes.ok && typeof token === 'string');

    /**
     * The WebSocket proxy is the part most likely to be misconfigured — it needs
     * `ws: true` in vite.config.ts, and without it the upgrade silently returns
     * HTML instead of switching protocols.
     */
    const { status, frames } = await collectFrames(
      WebSocket,
      `ws://127.0.0.1:${vitePort}/ws?token=${encodeURIComponent(token)}`,
      {
        until: (f) => f.some((x) => x.type === 'hello') && f.some((x) => x.type === 'patch'),
        timeoutMs: 9000,
      },
    );
    check('WebSocket upgrades through the Vite proxy', status === 'ok', status);
    check('hello arrives over the proxied socket', frames.some((f) => f.type === 'hello'));
    check('1 Hz deltas arrive over the proxied socket', frames.some((f) => f.type === 'patch'));

    const rejected = await collectFrames(WebSocket, `ws://127.0.0.1:${vitePort}/ws`, {
      until: () => false,
      timeoutMs: 5000,
    });
    check(
      'an unauthenticated upgrade is still refused through the proxy',
      rejected.status === 'http 401',
      rejected.status,
    );
  } finally {
    if (vite) {
      vite.kill('SIGTERM');
      await sleep(500);
      if (vite.exitCode === null) vite.kill('SIGKILL');
    }
    await agent.stop();
  }

  return { results };
}
