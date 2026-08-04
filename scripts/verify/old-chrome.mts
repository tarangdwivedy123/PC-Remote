import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import QRCode from 'qrcode';

import { renderQr } from '../../agent/src/qr.js';
import { REPO_ROOT, createChecker, stripComments } from './lib.mjs';

/**
 * Two properties that cannot be eyeballed or unit-tested from the outside:
 *
 *   1. The console QR really encodes the URL — i.e. a phone camera will scan it.
 *      Rendering "something square" is not the same as rendering a valid symbol,
 *      and a colour inversion bug would look perfectly fine in a screenshot.
 *   2. The client source stays inside the Chrome 70 feature floor. Every item on
 *      this list fails *silently* on the target device: no console error, just a
 *      collapsed layout or an undefined method.
 */

const QUIET_ZONE = 4;
const BLACK_FG = '\x1b[30m';
const WHITE_FG = '\x1b[97m';
const BLACK_BG = '\x1b[40m';
const WHITE_BG = '\x1b[107m';

/** Parses rendered ANSI back into a module matrix, two module rows per text row. */
function parseRendered(rendered: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of rendered.split('\n')) {
    const upper: boolean[] = [];
    const lower: boolean[] = [];
    let fgDark = false;
    let bgDark = false;
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\x1b') {
        const end = line.indexOf('m', i);
        if (end === -1) break;
        const code = line.slice(i, end + 1);
        if (code === BLACK_FG) fgDark = true;
        else if (code === WHITE_FG) fgDark = false;
        else if (code === BLACK_BG) bgDark = true;
        else if (code === WHITE_BG) bgDark = false;
        i = end + 1;
        continue;
      }
      if (line[i] === '▀') {
        upper.push(fgDark);
        lower.push(bgDark);
      }
      i++;
    }
    if (upper.length > 0) {
      rows.push(upper, lower);
    }
  }
  return rows;
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (/\.(tsx?|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

export async function run() {
  const { check, results } = createChecker('Old-Chrome floor — QR encoding and client feature use');

  // -- 1. QR round-trip ----------------------------------------------------

  const urls = ['http://192.168.1.42:8765', 'http://10.0.0.7:8765', 'http://192.168.100.200:9000'];
  for (const url of urls) {
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + QUIET_ZONE * 2;
    const parsed = parseRendered(renderQr(url));

    let wrong = 0;
    for (let y = 0; y < total; y++) {
      for (let x = 0; x < total; x++) {
        const mx = x - QUIET_ZONE;
        const my = y - QUIET_ZONE;
        const inside = mx >= 0 && my >= 0 && mx < size && my < size;
        const expected = inside ? data[my * size + mx] === 1 : false;
        if (expected !== (parsed[y]?.[x] ?? false)) wrong++;
      }
    }
    check(
      `QR encodes ${url} module-for-module`,
      wrong === 0,
      wrong === 0 ? `${size}x${size} symbol, ${total}x${total} with quiet zone` : `${wrong} wrong modules`,
    );
  }

  const sample = renderQr(urls[0] as string);
  check(
    'QR sets black/white explicitly rather than relying on terminal colours',
    [BLACK_FG, WHITE_FG, BLACK_BG, WHITE_BG].every((code) => sample.includes(code)),
  );
  check(
    'QR surrounds the symbol with a light quiet zone',
    parseRendered(sample)[0]?.every((dark) => !dark) === true,
  );

  const blocks = renderQr(urls[0] as string, { blocks: true });
  check(
    'QR block-mode fallback avoids half-block glyphs entirely',
    !blocks.includes('▀') && blocks.includes(BLACK_BG) && blocks.includes(WHITE_BG),
  );

  // -- 2. Chrome 70 feature floor ------------------------------------------

  const files = [...walkSources(path.join(REPO_ROOT, 'client/src')), path.join(REPO_ROOT, 'client/index.html')];
  const sources = files.map((file) => {
    const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    // Comments are stripped so the bans below match real usage. index.css
    // documents most of this list in prose, which would otherwise flag itself.
    return { file: relative, text: stripComments(readFileSync(file, 'utf8'), relative) };
  });

  /**
   * Flexbox `gap` shipped in Chrome 84 and collapses to zero spacing before
   * that, with no error. Grid `gap` is fine (Chrome 57), so this looks for the
   * two appearing together rather than banning `gap-` outright.
   */
  const flexGap: string[] = [];
  for (const { file, text } of sources) {
    for (const attr of text.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) ?? []) {
      const isFlex = /\bflex\b/.test(attr) && !/\bgrid\b/.test(attr);
      if (isFlex && /\bgap(-[xy])?-\d/.test(attr)) flexGap.push(`${file}: ${attr.slice(0, 60)}`);
    }
  }
  check('no flexbox gap in any className (Chrome 84)', flexGap.length === 0, flexGap.join(' | '));

  const banned: [RegExp, string][] = [
    [/backdrop-filter|backdrop-blur/, 'backdrop-filter (Chrome 76)'],
    [/:has\(/, ':has() (Chrome 105)'],
    [/@container|\bcontainer-type\b/, 'container queries (Chrome 105)'],
    [/aspect-ratio\s*:|\baspect-(square|video)\b/, 'aspect-ratio (Chrome 88)'],
    [/\b\d+dvh\b|\b\d+svh\b|h-dvh|min-h-dvh/, 'dvh/svh units (Chrome 108)'],
    [/\binset:\s/, 'the inset shorthand (Chrome 87)'],
    [/\.at\(-?\d/, 'Array.prototype.at (Chrome 92)'],
    [/structuredClone/, 'structuredClone (Chrome 98)'],
    [/AbortSignal\.timeout/, 'AbortSignal.timeout (Chrome 103)'],
    [/Object\.hasOwn/, 'Object.hasOwn (Chrome 93)'],
    [/\.replaceAll\(/, 'String.replaceAll (Chrome 85, unpolyfilled in source)'],
    [/requestIdleCallback/, 'requestIdleCallback (not on Safari, flaky on old Android)'],
    [/ResizeObserver/, 'ResizeObserver (Chrome 64 — fine, but confirm no polyfill assumed)'],
  ];

  for (const [pattern, label] of banned) {
    const hits = sources.filter((s) => pattern.test(s.text)).map((s) => s.file);
    check(`client avoids ${label}`, hits.length === 0, hits.join(', '));
  }

  /**
   * Wake Lock arrived in milestone 6. It is Chrome 84+, so on the target device
   * it simply does not exist — every use must be behind a capability check and
   * paired with the video fallback, never assumed.
   */
  const wakeLockFiles = sources.filter((s) => /wakeLock/i.test(s.text));
  for (const file of wakeLockFiles) {
    check(
      `${file.file} guards its Wake Lock use behind a capability check`,
      /wakeLock\?\.|wakeLock\s*&&|typeof[^;]*wakeLock/.test(file.text),
    );
    check(
      `${file.file} provides a fallback for browsers without Wake Lock`,
      /captureStream|<video|createElement\('video'\)/.test(file.text),
    );
  }
  check(
    'no bare navigator.wakeLock call outside a guard',
    !/[^?.\w]navigator\.wakeLock\.request/.test(sources.map((s) => s.text).join('\n')),
  );

  return { results };
}
