import { CommandError, type CommandRouter } from '../commands.js';
import type { VolumeService } from './index.js';

/**
 * Binds the volume commands to the router.
 *
 * All four return immediately rather than awaiting the device write. The service
 * coalesces writes on a 100ms window, so awaiting here would hold the WebSocket
 * command open for the length of the debounce and make a slider drag feel
 * laggy — and the result is reported by the next state broadcast regardless.
 */
export function registerVolumeCommands(router: CommandRouter, volume: VolumeService): void {
  router.register('volume.setOutputDevice', async (command) => {
    try {
      await volume.setOutputDevice(command.id);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });

  router.register('volume.setMicMuted', async (command) => {
    try {
      await volume.setMicMuted(command.muted);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });

  router.register('volume.setMaster', (command) => {
    volume.setMaster(command.volume);
  });

  router.register('volume.setMuted', (command) => {
    volume.setMasterMuted(command.muted);
  });

  router.register('volume.setApp', (command) => {
    volume.setApp(command.id, command.volume);
  });

  router.register('volume.setAppMuted', (command) => {
    volume.setAppMuted(command.id, command.muted);
  });
}
