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
  /**
   * Windows' firewall category for this network. 'Public' means the phone is
   * being blocked before it ever reaches the agent, and the page has to say so
   * rather than show a QR code that cannot work.
   */
  networkCategory?: 'Public' | 'Private' | 'DomainAuthenticated' | '';
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

  /**
   * Shown instead of the reassuring Wi-Fi note, because when this is the case
   * nothing else on the page will work. Windows blocks incoming connections on
   * networks it considers public, and the app's firewall rule deliberately does
   * not cover them -- being unreachable on a café network is the point.
   *
   * The remedy offered is to reclassify the network, not to widen the firewall.
   * Telling Windows "this is my home network" is both true and the thing that
   * makes every other kind of local sharing work; punching a hole for public
   * networks would undo the guarantee the whole app rests on.
   */
  const blocked =
    info.networkCategory === 'Public'
      ? `<div class="blocked">
           <strong>Windows is blocking your phone</strong>
           <p>Your network${info.network ? ` <b>${escapeHtml(info.network)}</b>` : ''} is set to
           <b>Public</b>, so Windows refuses connections from other devices — including your phone.
           The QR code below cannot work until this is changed.</p>
           <p class="fix"><button id="fix" type="button">Fix this for me</button>
           <span id="fixmsg"></span></p>
             <p class="small">Windows will ask for permission. This marks the network as
             trusted, which is what lets your own devices reach this PC.
             Only do this on a network you trust, such as your home Wi-Fi.</p>
           <p class="small">Prefer to do it yourself? <b>Settings &rsaquo; Network &amp; internet
           &rsaquo; Wi-Fi</b>, click your network, choose <b>Private network</b>.</p>
         </div>`
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
.blocked{margin:0 0 22px;padding:14px 16px;border-radius:10px;text-align:left;
  background:rgba(248,113,113,.13);border:1px solid rgba(248,113,113,.42)}
.blocked strong{display:block;margin-bottom:6px;color:#f87171;font-size:15px}
.blocked p{margin:0 0 8px;font-size:13.5px;line-height:1.5}
.blocked p:last-child{margin-bottom:0}
.blocked .fix{padding-top:8px;border-top:1px solid rgba(248,113,113,.25)}
.blocked .small{color:#9aa1ae;font-size:12.5px}
.blocked button{padding:9px 16px;border:0;border-radius:8px;background:#f87171;color:#2a0a0a;
  font:600 14px/1 inherit;cursor:pointer}
.blocked button:hover{filter:brightness(1.08)}
.blocked button:disabled{opacity:.55;cursor:default}
#fixmsg{margin-left:10px;font-size:13px;color:#9aa1ae}
</style></head><body>
<div class="card">
  <h1>Connect your phone</h1>
  <p class="lead">Point your phone's camera at this code and tap the link.</p>
  ${blocked}
  <div class="qr">${qrSvg(info.pairUrl)}</div>
  ${blocked ? '' : network}
  <div class="alt">
    Camera not working? Type this into your phone's browser:
    <code>${escapeHtml(info.plainUrl)}</code>
    then enter this PIN:
    <code class="pin">${escapeHtml(info.pin)}</code>
  </div>
</div>
<script>
(function(){
  var b=document.getElementById('fix'), m=document.getElementById('fixmsg');
  if(!b) return;
  b.onclick=function(){
    b.disabled=true; m.textContent='Waiting for your permission…';
    var x=new XMLHttpRequest();
    x.open('POST','/api/fix-network',true);
    x.onreadystatechange=function(){
      if(x.readyState!==4) return;
      // The prompt having been raised is not the same as it having been
      // accepted, so this asks the user to confirm by reloading rather than
      // claiming success.
      m.textContent='Approve the Windows prompt, then reload this page.';
      b.disabled=false;
    };
    x.send();
  };
})();
</script>
</body></html>`;
}
