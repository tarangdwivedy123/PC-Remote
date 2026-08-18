import { qrMatrix } from './qr.js';

/**
 * The pairing page shown in the PC's own browser.
 *
 * Exists because the tray window cannot be depended on. It is a WinForms process
 * that can die, and when it does the agent keeps running, keeps serving, and
 * becomes completely invisible — no icon, no window, no way to find the address.
 * An HTTP page cannot fail that way: if the agent is up at all, this works.
 *
 * Self-contained on purpose. No external requests, no client bundle, nothing that
 * has to have been built.
 */

export interface PairInfo {
  /** Encoded into the QR: the address with the single-use pairing code. */
  pairUrl: string;
  /** Shown as text, for typing by hand. */
  plainUrl: string;
  network: string;
  pin: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The QR as SVG rather than a canvas or an image.
 *
 * One `path` of rectangles scales to any size, needs no script, and survives
 * being printed or zoomed — which matters, because a phone camera has to resolve
 * it off a monitor.
 */
function qrSvg(text: string, px = 260): string {
  const modules = qrMatrix(text);
  const quiet = 2;
  const size = modules.length + quiet * 2;

  let path = '';
  for (let y = 0; y < modules.length; y++) {
    const row = modules[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }

  return (
    `<svg viewBox="0 0 ${size} ${size}" width="${px}" height="${px}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/>` +
    `</svg>`
  );
}

export function renderPairPage(info: PairInfo): string {
  const network = info.network
    ? `<div class="wifi"><span>Your phone must be on this Wi-Fi</span><strong>${escapeHtml(
        info.network,
      )}</strong></div>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your phone — PC Remote</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:#0d0e12;color:#e9ebf0;
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:light){body{background:#f4f5f8;color:#15171c}}
.card{width:min(420px,92vw);padding:34px 32px 30px;border-radius:16px;background:#171920;
  box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:center}
@media (prefers-color-scheme:light){.card{background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.10)}}
h1{margin:0 0 6px;font-size:22px;letter-spacing:-.01em}
p.lead{margin:0 0 22px;color:#9aa1ae;font-size:14.5px}
.qr{display:inline-block;padding:10px;background:#fff;border-radius:10px;line-height:0}
.wifi{margin:22px 0 0;padding:11px 14px;border-radius:9px;background:rgba(250,204,21,.12);
  border:1px solid rgba(250,204,21,.32);font-size:13.5px;text-align:left}
.wifi span{display:block;color:#caa33a;margin-bottom:2px}
.wifi strong{font-size:15px}
.alt{margin:20px 0 0;padding-top:18px;border-top:1px solid rgba(255,255,255,.09);
  font-size:13.5px;color:#9aa1ae;text-align:left}
@media (prefers-color-scheme:light){.alt{border-top-color:rgba(0,0,0,.09)}}
code{display:block;margin:5px 0 12px;padding:9px 11px;border-radius:7px;
  background:rgba(127,127,127,.14);font:600 14px/1.4 ui-monospace,Consolas,monospace;
  color:inherit;word-break:break-all}
.pin{letter-spacing:.16em}
</style></head><body>
<div class="card">
  <h1>Connect your phone</h1>
  <p class="lead">Point your phone's camera at this code and tap the link.</p>
  <div class="qr">${qrSvg(info.pairUrl)}</div>
  ${network}
  <div class="alt">
    Camera not working? Type this into your phone's browser:
    <code>${escapeHtml(info.plainUrl)}</code>
    then enter this PIN:
    <code class="pin">${escapeHtml(info.pin)}</code>
  </div>
</div>
</body></html>`;
}
