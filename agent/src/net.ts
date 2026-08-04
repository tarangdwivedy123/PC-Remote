import os from 'node:os';

/**
 * LAN address discovery. A Windows dev box typically has half a dozen IPv4
 * interfaces — Hyper-V switches, WSL, VirtualBox, VPN taps — and only one of
 * them is reachable from the phone. Rather than guess with
 * `networkInterfaces()[0]`, score them and show the user the ranked list.
 */

export interface LanCandidate {
  address: string;
  iface: string;
  netmask: string;
  mac: string;
  score: number;
  /** Why this scored the way it did, shown when --verbose-net is passed. */
  note: string;
}

/** Interface names that are almost never the route to a phone on the Wi-Fi. */
const VIRTUAL_PATTERNS = [
  /virtualbox/i,
  /vmware/i,
  /hyper-?v/i,
  /vethernet/i,
  /\bwsl\b/i,
  /docker/i,
  /tailscale/i,
  /zerotier/i,
  /radmin/i,
  /npcap/i,
  /loopback/i,
  /bluetooth/i,
  /tap-?windows/i,
  /openvpn/i,
  /wireguard/i,
  /\bvpn\b/i,
  /tunnel/i,
  /teredo/i,
  /isatap/i,
];

const WIRELESS_PATTERNS = [/wi-?fi/i, /wireless/i, /wlan/i, /\bwl\w*\d/i];
const WIRED_PATTERNS = [/ethernet/i, /^eth\d/i, /^en\w+/i, /local area connection/i];

function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  const [a, b] = parts;
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isLinkLocalV4(addr: string): boolean {
  return addr.startsWith('169.254.');
}

/** Carrier-grade NAT / shared address space, used by some VPN clients. */
function isCgnatV4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  return parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127;
}

export function getLanCandidates(): LanCandidate[] {
  const interfaces = os.networkInterfaces();
  const out: LanCandidate[] = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      // Node <18 reports family as a string, >=18 as the number 4. Accept both.
      const isV4 = addr.family === 'IPv4' || (addr.family as unknown as number) === 4;
      if (!isV4 || addr.internal) continue;

      let score = 0;
      const notes: string[] = [];

      if (isPrivateV4(addr.address)) {
        score += 50;
        notes.push('private range');
      } else if (isLinkLocalV4(addr.address)) {
        // 169.254 means DHCP failed. Reachable only by accident.
        score -= 40;
        notes.push('link-local (no DHCP)');
      } else if (isCgnatV4(addr.address)) {
        score -= 20;
        notes.push('CGNAT range');
      } else {
        // A public address here means the machine is directly on the internet.
        // Strongly deprioritise: this project must never be reachable off-LAN.
        score -= 60;
        notes.push('public address');
      }

      // 192.168/16 is the overwhelmingly common home-router range, so nudge it
      // above 10/8 and 172.16/12 which are more often virtual switches.
      if (addr.address.startsWith('192.168.')) {
        score += 10;
        notes.push('home-router range');
      }

      if (VIRTUAL_PATTERNS.some((re) => re.test(name))) {
        score -= 45;
        notes.push('virtual/VPN adapter');
      }
      if (WIRELESS_PATTERNS.some((re) => re.test(name))) {
        score += 20;
        notes.push('wireless');
      } else if (WIRED_PATTERNS.some((re) => re.test(name))) {
        score += 15;
        notes.push('wired');
      }

      // A zeroed MAC is a strong tell for a software adapter.
      if (addr.mac && addr.mac !== '00:00:00:00:00:00') score += 5;
      else notes.push('no MAC');

      out.push({
        address: addr.address,
        iface: name,
        netmask: addr.netmask,
        mac: addr.mac,
        score,
        note: notes.join(', '),
      });
    }
  }

  return out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

/**
 * Best guess at the address to print in the banner. `PCR_LAN_IP` overrides it
 * outright, for the case where the heuristic picks the wrong NIC.
 */
export function pickLanAddress(): string | undefined {
  const override = process.env['PCR_LAN_IP'];
  if (override) return override;
  const candidates = getLanCandidates();
  return candidates[0]?.address;
}

export function buildUrl(address: string, port: number): string {
  return `http://${address}:${port}`;
}

/**
 * Both wired and wireless interfaces sharing a /24 is normal on a desktop that
 * is docked. Callers use this to warn when several candidates look equally
 * plausible and the printed one might be wrong.
 */
export function hasAmbiguousLan(candidates: LanCandidate[]): boolean {
  const top = candidates[0];
  const second = candidates[1];
  if (!top || !second) return false;
  return top.score - second.score < 15;
}
