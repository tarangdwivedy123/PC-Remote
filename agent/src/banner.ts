import { color, raw } from './log.js';
import { buildUrl, getLanCandidates, hasAmbiguousLan, type LanCandidate } from './net.js';
import { indentQr, renderQr } from './qr.js';

export interface BannerInfo {
  port: number;
  pin: string;
  /** True when at least one device is already paired, so the PIN is optional. */
  pairedCount: number;
  configFile: string;
  version: string;
  /** Set in dev, where the phone should hit the Vite server instead. */
  devClientUrl?: string;
  clientBuilt: boolean;
}

function heading(text: string): string {
  return color('bold', text);
}

/**
 * Prints the "open this on your phone" banner: the URL, a scannable QR code,
 * the pairing PIN, and the runner-up LAN addresses in case the top pick is on
 * the wrong NIC.
 */
export function printBanner(info: BannerInfo): void {
  const candidates = getLanCandidates();
  const primary = process.env['PCR_LAN_IP'] ?? candidates[0]?.address;

  raw('');
  raw(heading('  PC REMOTE') + color('dim', `  v${info.version}`));
  raw(color('dim', '  ─────────────────────────────────────────────'));
  raw('');

  if (!primary) {
    raw(`  ${color('red', 'No LAN address found.')}`);
    raw(color('dim', '  Is Wi-Fi/Ethernet connected? You can force one with:'));
    raw(color('dim', '    set PCR_LAN_IP=192.168.1.42'));
    raw('');
    return;
  }

  const url = info.devClientUrl ?? buildUrl(primary, info.port);

  raw(`  ${heading('Open on your phone:')}`);
  raw(`    ${color('cyan', url)}`);
  raw('');

  try {
    raw(indentQr(renderQr(url), 4));
  } catch (err) {
    raw(color('yellow', `    (could not render QR: ${(err as Error).message})`));
  }
  raw('');

  if (info.pairedCount === 0) {
    raw(`  ${heading('Pairing PIN:')}  ${color('green', info.pin)}`);
    raw(color('dim', '    Enter this on the phone once. It is then remembered.'));
  } else {
    raw(
      `  ${heading('Pairing PIN:')}  ${color('green', info.pin)}  ` +
        color('dim', `(${info.pairedCount} device(s) already paired)`),
    );
  }
  raw('');

  if (info.devClientUrl) {
    raw(
      `  ${color('magenta', 'DEV MODE')} ${color('dim', `— client is served by Vite with hot reload.`)}`,
    );
    raw(color('dim', `    API and WebSocket proxy through to :${info.port}.`));
    raw(color('dim', `    Production URL (after npm run build): ${buildUrl(primary, info.port)}`));
    raw('');
  } else if (!info.clientBuilt) {
    raw(`  ${color('yellow', 'The client has not been built yet.')}`);
    raw(color('dim', '    Run `npm run build:client`, or use `npm run dev` for hot reload.'));
    raw('');
  }

  printAlternatives(candidates, primary, info.port);

  raw(color('dim', `  config: ${info.configFile}`));
  raw(color('dim', '  Ctrl-C to stop.'));
  raw('');
}

function printAlternatives(candidates: LanCandidate[], primary: string, port: number): void {
  const others = candidates.filter((c) => c.address !== primary);
  if (others.length === 0) return;

  // Only nag about alternatives when the top two scored close together, or when
  // the address was forced by hand and might not match any real interface.
  const ambiguous = hasAmbiguousLan(candidates);
  const forced = process.env['PCR_LAN_IP'] !== undefined;

  if (ambiguous || forced) {
    raw(color('yellow', "  If that address doesn't load, try one of these:"));
  } else {
    raw(color('dim', '  Other LAN addresses on this machine:'));
  }
  for (const c of others.slice(0, 4)) {
    raw(color('dim', `    ${buildUrl(c.address, port).padEnd(28)} ${c.iface}  (${c.note})`));
  }
  raw('');
}

/** Re-printable summary for the "press r" style reminder after startup noise. */
export function printCompactUrl(port: number): void {
  const primary = process.env['PCR_LAN_IP'] ?? getLanCandidates()[0]?.address;
  if (!primary) return;
  raw(color('dim', `  → ${color('cyan', buildUrl(primary, port))}`));
}
