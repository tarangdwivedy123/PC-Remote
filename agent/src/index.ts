import os from 'node:os';

import type { HostInfo } from '@pcr/shared';

import { AuthService } from './auth.js';
import { printBanner } from './banner.js';
import { parseArgs, printHelp } from './cli.js';
import { CommandRouter } from './commands.js';
import { ConfigStore, generatePin } from './config.js';
import { color, createLogger, raw, setLogLevel } from './log.js';
import { pickLanAddress } from './net.js';
import { startServer, type StartedServer } from './server.js';
import { StateHub } from './state.js';
import { StatsSampler } from './stats/index.js';
import { VolumeService } from './volume/index.js';
import { registerVolumeCommands } from './volume/commands.js';
import { MediaService } from './media/index.js';
import { registerMediaCommands } from './media/commands.js';
import { WinHost } from './winhost/host.js';
import { MonitorService } from './monitors/index.js';
import { registerMonitorCommands } from './monitors/commands.js';
import { SystemService } from './system/index.js';
import { registerSystemCommands } from './system/commands.js';
import { AGENT_VERSION } from './version.js';

const log = createLogger('agent');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp(AGENT_VERSION);
    return;
  }
  if (args.version) {
    raw(AGENT_VERSION);
    return;
  }
  if (args.verbose) setLogLevel('debug');
  if (args.unknown.length > 0) {
    log.warn(`ignoring unrecognised argument(s): ${args.unknown.join(' ')}`);
  }

  // Flags win over env, env wins over the stored config. Setting the env var
  // here rather than threading a parameter keeps one resolution path.
  if (args.port !== undefined) process.env['PCR_PORT'] = String(args.port);
  if (args.lanIp !== undefined) process.env['PCR_LAN_IP'] = args.lanIp;

  const config = await ConfigStore.load();

  // -- one-shot maintenance commands ---------------------------------------

  if (args.showPin) {
    raw('');
    raw(`  ${color('bold', 'Pairing PIN:')}  ${color('green', config.current.pin)}`);
    raw(color('dim', `  config: ${config.file}`));
    raw(color('dim', `  paired devices: ${config.current.tokens.length}`));
    raw('');
    return;
  }

  if (args.resetPin) {
    const pin = generatePin();
    config.update((c) => {
      c.pin = pin;
    });
    await config.flush();
    raw('');
    raw(`  ${color('bold', 'New pairing PIN:')}  ${color('green', pin)}`);
    raw(
      color(
        'dim',
        '  Already-paired devices keep working. Use --revoke-all to force re-pairing.',
      ),
    );
    raw('');
    return;
  }

  if (args.revokeAll) {
    const count = config.current.tokens.length;
    config.update((c) => {
      c.tokens = [];
    });
    await config.flush();
    raw('');
    raw(`  ${color('yellow', `Un-paired ${count} device(s).`)}`);
    raw(color('dim', `  They will need the PIN again: ${config.current.pin}`));
    raw('');
    return;
  }

  // -- normal startup ------------------------------------------------------

  if (process.platform !== 'win32') {
    log.warn(
      `running on ${process.platform}; volume, media and system actions are Windows-only ` +
        `and will report as unavailable`,
    );
  }

  const hostInfo: HostInfo = {
    hostname: os.hostname(),
    platform: process.platform,
    osRelease: os.release(),
    agentVersion: AGENT_VERSION,
  };

  const auth = new AuthService(config);
  const hub = new StateHub();
  const router = new CommandRouter();

  /**
   * Late-bound: the media service does not exist until after the server is
   * listening, but the artwork route needs to reach it.
   */
  let mediaRef: MediaService | undefined;

  const server = await startServer({
    config,
    auth,
    hub,
    router,
    host: hostInfo,
    getThumbnail: () => mediaRef?.thumbnail,
  });

  const devPort =
    args.devClientPort ??
    (process.env['PCR_DEV_CLIENT_PORT'] ? Number(process.env['PCR_DEV_CLIENT_PORT']) : undefined);

  printBanner({
    port: config.current.port,
    pin: config.current.pin,
    pairedCount: config.current.tokens.length,
    configFile: config.file,
    version: AGENT_VERSION,
    clientBuilt: server.clientDir !== undefined,
    devClientUrl: devPort ? `http://${pickLanAddress() ?? 'localhost'}:${devPort}` : undefined,
  });

  log.info(`listening on ${server.address}`);

  /**
   * Stats start last, after the banner is on screen. The URL, QR and PIN are what
   * the user is waiting for, and the first sample plus the nvidia-smi probe take
   * long enough to be noticeable. Clients that connect in the gap receive
   * `stats: null` and render a "waiting for the first sample" placeholder, so
   * nothing depends on this having finished.
   */
  const stats = new StatsSampler(hub);
  /**
   * One PowerShell process backs both volume and media keys. It compiles its C#
   * interop once at startup (~600ms); a host per feature would pay that twice
   * and add a process for nothing.
   */
  const winHost = new WinHost();
  const volume = new VolumeService(hub, winHost);
  const media = new MediaService(hub, winHost);
  mediaRef = media;
  const system = new SystemService(hub, winHost);
  const monitors = new MonitorService(hub, winHost);
  registerVolumeCommands(router, volume);
  registerMediaCommands(router, media);
  registerSystemCommands(router, system, auth);
  registerMonitorCommands(router, monitors);

  installShutdownHandlers(server, config, stats, volume, media, monitors, system, winHost);
  await stats.start();
  // Started after stats so the compile does not delay the charts.
  await winHost.start();
  await volume.start();
  await media.start();
  await monitors.start();
  system.start();
}

function installShutdownHandlers(
  server: StartedServer,
  config: ConfigStore,
  stats: StatsSampler,
  volume: VolumeService,
  media: MediaService,
  monitors: MonitorService,
  system: SystemService,
  winHost: WinHost,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // Second Ctrl-C: the user is impatient and something is hanging.
      log.warn('forcing exit');
      process.exit(1);
    }
    shuttingDown = true;
    raw('');
    log.info(`${signal} received, shutting down`);

    // Don't let a wedged socket keep the process alive forever.
    const forceTimer = setTimeout(() => {
      log.warn('shutdown timed out; exiting anyway');
      process.exit(1);
    }, 5000);
    forceTimer.unref?.();

    try {
      // Stop the child-process owners first: the samplers hold typeperf and
      // nvidia-smi, and the volume service holds a PowerShell host. Leaving any
      // of them orphaned keeps processes alive after exit.
      stats.stop();
      volume.stop();
      media.stop();
      monitors.stop();
      system.stop();
      winHost.stop();
      await server.close();
      await config.flush();
    } catch (err) {
      log.error('error during shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows sends SIGHUP when the console window closes.
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  process.on('uncaughtException', (err) => {
    // A remote control that dies because one poll threw is worse than one that
    // logs and carries on, so this deliberately does not exit.
    log.error('uncaught exception (continuing):', err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection (continuing):', reason);
  });
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : err);
  if (process.env['PCR_LOG_LEVEL'] === 'debug' && err instanceof Error) {
    log.error(err.stack);
  }
  process.exit(1);
});
