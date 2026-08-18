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

/**
 * The name of the network this PC is on, for telling the user what their phone
 * has to join.
 *
 * "Make sure your phone is on the same Wi-Fi" is the instruction everyone gets
 * wrong — people are on mobile data, or the guest SSID, or the 5GHz twin of the
 * network the PC uses. Naming it removes the guesswork.
 *
 * Best-effort: an unknown network is not worth blocking startup over, so a
 * failure here just means the window omits that line.
 */
export async function getNetworkName(): Promise<string> {
  if (process.platform !== 'win32') return '';
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(
      'netsh',
      ['wlan', 'show', 'interfaces'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve('');
        /**
         * Matched on the line rather than a fixed offset: netsh output is
         * localised, but the SSID value itself is not, and "BSSID" would match a
         * looser pattern first — hence the word boundary.
         */
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = /^\s*SSID\s*:\s*(.+?)\s*$/.exec(line);
          if (match?.[1]) return resolve(match[1]);
        }
        resolve('');
      },
    );
  });
}

/**
 * Windows' firewall category for the network carrying the given address, plus
 * its name.
 *
 * This matters more than it looks. The installer opens the firewall for Private
 * and Domain networks only -- deliberately, because this app must never be
 * reachable from a café or airport network. But Windows marks a network Public
 * by default, and marks it Public again whenever it decides a familiar SSID is a
 * new network. When that happens the rule stops applying, the phone's packets
 * are dropped before they reach the agent, and the app looks broken while being
 * perfectly healthy.
 *
 * Knowing the category is what lets the app say so instead of hanging.
 */
export interface NetworkInfo {
  /** SSID or network name, empty when it cannot be determined. */
  name: string;
  /** '' when unknown -- treated as "probably fine", never as a blocker. */
  category: 'Public' | 'Private' | 'DomainAuthenticated' | '';
}

export async function getNetworkInfo(lanIp?: string): Promise<NetworkInfo> {
  if (process.platform !== 'win32') return { name: '', category: '' };
  const { execFile } = await import('node:child_process');

  /**
   * The address is substituted into the script rather than passed as an
   * argument: `powershell -Command` does not populate $args from trailing
   * arguments, which silently produced an empty result. It is checked against a
   * strict IPv4 pattern first, so nothing that is not four numbers can reach the
   * command line.
   */
  const safeIp = lanIp && /^\d{1,3}(\.\d{1,3}){3}$/.test(lanIp) ? lanIp : '';

  /**
   * Matched by address rather than by taking the first profile: this machine has
   * Wi-Fi, Ethernet, Bluetooth and a VPN adapter all carrying addresses, and only
   * the one actually serving the phone has a category worth reporting.
   */
  const lookup = safeIp
    ? `$alias = (Get-NetIPAddress -IPAddress '${safeIp}' -AddressFamily IPv4 | Select-Object -First 1).InterfaceAlias; ` +
      `$p = if ($alias) { Get-NetConnectionProfile -InterfaceAlias $alias | Select-Object -First 1 } else { Get-NetConnectionProfile | Select-Object -First 1 };`
    : '$p = Get-NetConnectionProfile | Select-Object -First 1;';

  const script =
    '$ErrorActionPreference = "SilentlyContinue"; ' +
    lookup +
    ' if ($p) { [Console]::Out.Write($p.Name + "|" + $p.NetworkCategory) }';

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 6000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ name: '', category: '' });
        const [name = '', category = ''] = String(stdout).trim().split('|');
        const known = ['Public', 'Private', 'DomainAuthenticated'];
        resolve({
          name,
          // An unrecognised value is reported as unknown, never as Public: a
          // false alarm telling the user their network is blocked would be worse
          // than staying quiet.
          category: (known.includes(category) ? category : '') as NetworkInfo['category'],
        });
      },
    );
  });
}
