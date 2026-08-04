import { existsSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, createChecker, startAgent, tempDataDir } from './lib.mjs';

/**
 * Milestone 1: the *bundled* agent serving the *built* client.
 * Deliberately runs dist/agent.mjs rather than the source, so it also proves the
 * esbuild bundle works and can still locate client/dist from its new location.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 1 — built client, served by the bundled agent');

  const clientDist = path.join(REPO_ROOT, 'client/dist/index.html');
  const agentBundle = path.join(REPO_ROOT, 'agent/dist/agent.mjs');
  if (!existsSync(clientDist) || !existsSync(agentBundle)) {
    check('client and agent are built (run `npm run build` first)', false);
    return { results };
  }

  const agent = await startAgent({ port: 8792, dataDir: tempDataDir('m1-static'), entry: 'bundle' });

  try {
    check('the bundled agent (dist/agent.mjs) starts', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }
    check(
      'the bundled agent locates the built client',
      /serving client from/.test(agent.plainOutput),
      agent.plainOutput.match(/serving client from (.*)/)?.[1]?.trim(),
    );

    // -- the shell ---------------------------------------------------------
    const index = await fetch(`${agent.base}/`);
    const html = await index.text();
    check('GET / serves index.html', index.ok && html.includes('<div id="root">'), `${index.status}, ${html.length} bytes`);
    check(
      'index.html must revalidate, so a new build is picked up',
      (index.headers.get('cache-control') ?? '').includes('no-cache'),
      index.headers.get('cache-control'),
    );
    check('theme-color is black for AMOLED', html.includes('content="#000000"'));
    check('a black background is inlined to avoid a white first paint', /background:\s*#000/.test(html));
    check(
      'the modern bundle is a module script',
      /<script[^>]*type="module"[^>]*src="\/assets\/index-[^"]+\.js"/.test(html),
    );
    check(
      'a nomodule legacy fallback is present for pre-Chrome-61',
      html.includes('nomodule') && html.includes('index-legacy-'),
    );

    // -- hashed assets -----------------------------------------------------
    const jsHref = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    const asset = await fetch(agent.base + jsHref);
    check('a hashed JS asset is served', asset.ok, `${asset.status} ${jsHref}`);
    check(
      'hashed assets are cached immutably',
      (asset.headers.get('cache-control') ?? '').includes('immutable'),
      asset.headers.get('cache-control'),
    );

    const cssHref = html.match(/href="(\/assets\/index-[^"]+\.css)"/)?.[1];
    const cssText = await (await fetch(agent.base + cssHref)).text();
    check('the stylesheet is served', cssText.length > 1000, `${cssText.length} bytes`);
    check('Tailwind emitted the near-black background', /#000/.test(cssText));
    // This is what build.cssTarget = 'chrome70' buys: no oklab()/color-mix() may
    // survive minification, or the phone silently drops the declarations.
    check('no post-Chrome-70 colour syntax survived minification', !/oklch\(|oklab\(|color-mix\(/.test(cssText));
    check('no aspect-ratio (Chrome 88) in the stylesheet', !/aspect-ratio\s*:/.test(cssText));

    // -- SPA fallback + CSP ------------------------------------------------
    const deep = await fetch(`${agent.base}/settings/feeds`);
    const deepHtml = await deep.text();
    check('an unknown client route falls back to the shell', deep.ok && deepHtml.includes('<div id="root">'), `got ${deep.status}`);

    const csp = deep.headers.get('content-security-policy') ?? '';
    check('a CSP is sent with the shell', csp.includes("default-src 'self'"));
    check(
      "CSP lists ws: explicitly, since old Chrome does not match it against 'self'",
      csp.includes('connect-src') && csp.includes('ws:'),
    );
    check(
      'CSP forbids framing, objects and form submission',
      csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && csp.includes("form-action 'none'"),
    );
    check('CSP allows data: images for album art', /img-src[^;]*data:/.test(csp));

    // -- headers -----------------------------------------------------------
    check('nosniff is set', index.headers.get('x-content-type-options') === 'nosniff');
    check('no CORS header is emitted at all', index.headers.get('access-control-allow-origin') === null);
    check('framing is denied', index.headers.get('x-frame-options') === 'DENY');

    // -- auth is still enforced with the client present --------------------
    const unauth = await fetch(`${agent.base}/api/state`);
    check('/api/state still requires a token', unauth.status === 401, `got ${unauth.status}`);
  } finally {
    await agent.stop();
  }

  return { results };
}
