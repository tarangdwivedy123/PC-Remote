/**
 * Generates the PWA icons.
 *
 * Written by hand rather than pulled from a design tool, because the project has
 * no image toolchain and the icon is simple enough that a few filled rectangles
 * do the job. Re-run with `node scripts/make-icons.mjs` after changing anything
 * here; the PNGs are committed so a normal build never needs to run this.
 *
 * The mark is a screen outline with three ascending bars inside it — the stats
 * sparkline that is the app's most recognisable feature at a glance.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'public');

const BG = [0x0a, 0x0a, 0x0b, 0xff];
const FRAME = [0x2f, 0x8f, 0x86, 0xff];
const BAR = [0x43, 0xab, 0x9f, 0xff];

// ---------------------------------------------------------------------------
// A minimal PNG encoder: RGBA, no interlacing, filter type 0 on every scanline.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter byte; 0 means "none", which
  // compresses fine for flat colour and keeps this encoder trivial.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
    px[i + 3] = colour[3];
  };
  const rect = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, colour);
  };

  rect(0, 0, size, size, BG);

  /**
   * Everything stays inside the middle 80%. Android crops maskable icons to
   * whatever shape the launcher uses, and a glyph drawn to the edges loses its
   * corners on a circular mask.
   */
  const safe = Math.round(size * 0.1);
  const inner = size - safe * 2;

  const frameW = inner;
  const frameH = Math.round(inner * 0.72);
  const frameX = safe;
  const frameY = safe + Math.round((inner - frameH) / 2) - Math.round(inner * 0.06);
  const border = Math.max(2, Math.round(size * 0.035));

  // Screen outline.
  rect(frameX, frameY, frameW, border, FRAME);
  rect(frameX, frameY + frameH - border, frameW, border, FRAME);
  rect(frameX, frameY, border, frameH, FRAME);
  rect(frameX + frameW - border, frameY, border, frameH, FRAME);

  // Stand.
  const standW = Math.round(inner * 0.34);
  const standH = Math.max(2, Math.round(size * 0.045));
  rect(frameX + Math.round((frameW - standW) / 2), frameY + frameH + Math.round(size * 0.03), standW, standH, FRAME);

  // Three ascending bars inside the screen.
  const padding = border * 2;
  const barArea = frameW - padding * 2;
  const barW = Math.round(barArea / 5);
  const gap = Math.round((barArea - barW * 3) / 2);
  const baseY = frameY + frameH - border - Math.round(size * 0.05);
  const heights = [0.3, 0.55, 0.85];
  for (let i = 0; i < 3; i++) {
    const h = Math.round((frameH - border * 2 - size * 0.08) * heights[i]);
    rect(frameX + padding + i * (barW + gap), baseY - h, barW, h, BAR);
  }

  return encodePng(size, size, px);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  const png = drawIcon(size);
  writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)}  ${png.length} bytes`);
}
