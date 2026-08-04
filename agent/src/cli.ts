import { color, raw } from './log.js';

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  showPin: boolean;
  resetPin: boolean;
  revokeAll: boolean;
  port: number | undefined;
  lanIp: string | undefined;
  /**
   * Set by `npm run dev`. When present the banner points the phone at the Vite
   * dev server (which proxies /api and /ws back here) instead of at the agent's
   * own static files, so hot reload works on the device.
   */
  devClientPort: number | undefined;
  verbose: boolean;
  unknown: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    help: false,
    version: false,
    showPin: false,
    resetPin: false,
    revokeAll: false,
    port: undefined,
    lanIp: undefined,
    devClientPort: undefined,
    verbose: false,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      // npm and tsx both insert a bare `--` when forwarding arguments to the
      // script. Skip it silently rather than reporting it as unrecognised.
      case '--':
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '--show-pin':
        out.showPin = true;
        break;
      case '--reset-pin':
        out.resetPin = true;
        break;
      case '--revoke-all':
        out.revokeAll = true;
        break;
      case '--verbose':
        out.verbose = true;
        break;
      case '--port': {
        const next = argv[++i];
        const parsed = Number(next);
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) out.port = parsed;
        else out.unknown.push(`--port ${next ?? ''}`.trim());
        break;
      }
      case '--lan-ip': {
        const next = argv[++i];
        if (next) out.lanIp = next;
        else out.unknown.push('--lan-ip');
        break;
      }
      case '--dev-client-port': {
        const next = argv[++i];
        const parsed = Number(next);
        if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) out.devClientPort = parsed;
        else out.unknown.push(`--dev-client-port ${next ?? ''}`.trim());
        break;
      }
      default:
        if (arg !== undefined) out.unknown.push(arg);
    }
  }

  return out;
}

export function printHelp(version: string): void {
  raw('');
  raw(`${color('bold', 'pc-remote agent')} ${color('dim', `v${version}`)}`);
  raw(color('dim', 'LAN-only remote control for this PC. Serves the phone dashboard.'));
  raw('');
  raw(color('bold', 'Usage'));
  raw('  pc-remote-agent [options]');
  raw('');
  raw(color('bold', 'Options'));
  raw('  --port <n>        Listen on a different port (default 8765)');
  raw('  --lan-ip <ip>     Force the address printed in the banner and QR code');
  raw('  --show-pin        Print the current pairing PIN and config path, then exit');
  raw('  --reset-pin       Generate a new pairing PIN, then exit');
  raw('  --revoke-all      Un-pair every device, then exit');
  raw('  --verbose         Debug-level logging');
  raw('  --dev-client-port <n>');
  raw('                    Point the banner at a Vite dev server (set by npm run dev)');
  raw('  -h, --help        This message');
  raw('  -v, --version     Print the version');
  raw('');
  raw(color('bold', 'Environment'));
  raw('  PCR_PORT              Same as --port');
  raw('  PCR_HOST              Bind address (default 0.0.0.0)');
  raw('  PCR_LAN_IP            Same as --lan-ip');
  raw('  PCR_DATA_DIR          Where config.json and caches live');
  raw('  PCR_CLIENT_DIR        Path to the built client (normally auto-detected)');
  raw('  PCR_VENDOR_DIR        Path to svcl.exe / nircmd.exe');
  raw('  PCR_QR_BLOCKS=1       Render the QR with full blocks (if half-blocks look wrong)');
  raw('  PCR_LOG_LEVEL         debug | info | warn | error');
  raw('  PCR_ALLOW_ANY_IP=1    Disable the RFC1918-only request guard (not recommended)');
  raw('');
}
