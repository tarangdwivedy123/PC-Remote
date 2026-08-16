import QRCode from 'qrcode';

/**
 * Console QR rendering.
 *
 * The library's own `type: 'terminal'` renderer picks colours that only scan on
 * a dark-background terminal. Phone cameras need genuinely dark modules on a
 * genuinely light background, so this renders the raw module matrix with
 * explicit ANSI black/white and does not care what theme the console uses.
 */

const RESET = '\x1b[0m';
const BLACK_FG = '\x1b[30m';
const WHITE_FG = '\x1b[97m';
const BLACK_BG = '\x1b[40m';
const WHITE_BG = '\x1b[107m';

/** Modules of light margin around the code. The spec's minimum is 4. */
const QUIET_ZONE = 4;

export interface QrOptions {
  /**
   * Full-size mode: one text row and two columns per module, using coloured
   * spaces only. Larger, but needs no Unicode block glyphs — use it if the
   * console font renders half-blocks as tofu.
   */
  blocks?: boolean;
}

interface Matrix {
  size: number;
  /** True where the module is dark. */
  dark: (x: number, y: number) => boolean;
}

function createMatrix(text: string): Matrix {
  // Level M survives a bit of glare and camera blur on an old phone sensor
  // while keeping a short URL inside a version 2-3 symbol.
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const total = size + QUIET_ZONE * 2;
  return {
    size: total,
    dark: (x, y) => {
      const mx = x - QUIET_ZONE;
      const my = y - QUIET_ZONE;
      if (mx < 0 || my < 0 || mx >= size || my >= size) return false; // quiet zone
      return data[my * size + mx] === 1;
    },
  };
}

/** One row of text per module, two coloured spaces per module. */
function renderBlocks(m: Matrix): string {
  const lines: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let line = '';
    let currentBg: string | undefined;
    for (let x = 0; x < m.size; x++) {
      const bg = m.dark(x, y) ? BLACK_BG : WHITE_BG;
      if (bg !== currentBg) {
        line += bg;
        currentBg = bg;
      }
      line += '  ';
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}

/**
 * Half-block mode: two module rows per text row, one column per module. A text
 * cell is about twice as tall as it is wide, so this comes out roughly square.
 */
function renderHalfBlocks(m: Matrix): string {
  const UPPER = '▀'; // ▀ upper half block
  const lines: string[] = [];

  for (let y = 0; y < m.size; y += 2) {
    let line = '';
    let currentStyle: string | undefined;
    for (let x = 0; x < m.size; x++) {
      const upperDark = m.dark(x, y);
      // An odd module count leaves the final row unpaired; pad it with quiet
      // zone (light) rather than letting it read as a dark stripe.
      const lowerDark = y + 1 < m.size ? m.dark(x, y + 1) : false;

      // Foreground paints the upper half, background the lower half.
      const style = `${upperDark ? BLACK_FG : WHITE_FG}${lowerDark ? BLACK_BG : WHITE_BG}`;
      if (style !== currentStyle) {
        line += style;
        currentStyle = style;
      }
      line += UPPER;
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}

/** Renders `text` as a scannable QR code made of terminal escape sequences. */
/**
 * The raw module grid, for renderers that are not a terminal.
 *
 * The first-run window draws its QR from this rather than re-encoding: there is
 * no reason to carry a second QR implementation in the tray process when the
 * agent already has one, and two encoders could disagree.
 */
export function qrMatrix(text: string): boolean[][] {
  const matrix = createMatrix(text);
  const rows: boolean[][] = [];
  for (let y = 0; y < matrix.size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < matrix.size; x++) row.push(matrix.dark(x, y));
    rows.push(row);
  }
  return rows;
}

export function renderQr(text: string, options: QrOptions = {}): string {
  const matrix = createMatrix(text);
  const useBlocks = options.blocks ?? process.env['PCR_QR_BLOCKS'] === '1';
  return useBlocks ? renderBlocks(matrix) : renderHalfBlocks(matrix);
}

/**
 * Indents each line so the code sits inside the banner. Padding has to be
 * emitted before the colour escapes, otherwise the white background bleeds
 * leftwards across the terminal.
 */
export function indentQr(qr: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return qr
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

/** Width in terminal columns, used to size the banner around the code. */
export function qrWidth(text: string, options: QrOptions = {}): number {
  const matrix = createMatrix(text);
  const useBlocks = options.blocks ?? process.env['PCR_QR_BLOCKS'] === '1';
  return useBlocks ? matrix.size * 2 : matrix.size;
}
