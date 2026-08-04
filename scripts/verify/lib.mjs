import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Shared harness for the milestone verification scripts.
 *
 * These are not unit tests. They boot the real agent and talk to it over real
 * HTTP and WebSocket, because the things most likely to break in this project —
 * auth on the upgrade path, cache headers, the QR encoding, the Chrome 70
 * feature floor — are all integration-level and invisible to a unit test.
 */

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

export function createChecker(title) {
  const results = [];
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail });
      const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      console.log(`  ${mark}  ${name}${detail ? `  \x1b[2m— ${detail}\x1b[0m` : ''}`);
    },
    // Suites return this array and the runner derives pass/fail counts from it.
    // A `failed` getter here would be a trap: callers destructure the checker
    // before running any checks, which snapshots an empty array.
    results,
  };
}

/**
 * Strips comments so a source scan matches real usage rather than prose about
 * it. Without this, a comment reading "no :has() before Chrome 105" trips the
 * very check that documents it.
 */
export function stripComments(text, file) {
  let out = text;
  // Block comments: /* ... */ in CSS/JS/TS.
  out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (/\.html?$/.test(file)) {
    out = out.replace(/<!--[\s\S]*?-->/g, ' ');
  }
  if (/\.(tsx?|mts|mjs|js)$/.test(file)) {
    // Line comments, but not the `//` in a URL — hence requiring the preceding
    // character to not be a colon.
    out = out.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }
  return out;
}

export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Boots an agent on an isolated port and data directory so a verification run
 * never touches the real config or collides with a running agent.
 */
export async function startAgent({ port, dataDir, entry = 'source', env = {}, timeoutMs = 30_000 }) {
  // Always start from an empty data directory. Otherwise a re-run inherits the
  // previous run's PIN and accumulated device tokens, and assertions about
  // first-run behaviour quietly stop meaning anything.
  await rm(dataDir, { recursive: true, force: true });

  const args =
    entry === 'source'
      ? [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO_ROOT, 'agent/src/index.ts')]
      : [path.join(REPO_ROOT, 'agent/dist/agent.mjs')];

  const child = spawn(process.execPath, args, {
    cwd: path.join(REPO_ROOT, 'agent'),
    env: {
      ...process.env,
      PCR_DATA_DIR: dataDir,
      PCR_PORT: String(port),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) {
        up = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }

  return {
    child,
    base,
    up,
    get output() {
      return output;
    },
    get plainOutput() {
      return stripAnsi(output);
    },
    async stop() {
      child.kill('SIGTERM');
      await sleep(600);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

/** Collects WebSocket frames until `until` is satisfied or the timeout expires. */
export function collectFrames(WebSocket, url, { onOpen, until, timeoutMs = 9000 }) {
  return new Promise((resolve) => {
    const frames = [];
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve({ status, frames });
    };

    ws.on('open', () => onOpen?.(ws));
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (until?.(frames)) finish('ok');
    });
    ws.on('unexpected-response', (_req, res) => finish(`http ${res.statusCode}`));
    ws.on('error', (err) => finish(`error ${err.message}`));
    setTimeout(() => finish('timeout'), timeoutMs);
  });
}

export function tempDataDir(name) {
  return path.join(REPO_ROOT, 'node_modules', '.pcr-verify', name);
}
