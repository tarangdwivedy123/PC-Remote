import { CommandError, type CommandRouter } from '../commands.js';
import type { MonitorService } from './index.js';

/**
 * Binds the monitor commands.
 *
 * Deliberately *not* behind a confirmation. Switching an input is disruptive but
 * it is also the thing you came here to do, and a two-tap dance on something
 * used several times a day would be its own kind of annoying. The safeguards are
 * that the target value must be one the monitor itself advertised, and that the
 * UI says plainly what switching away means.
 */
export function registerMonitorCommands(router: CommandRouter, monitors: MonitorService): void {
  /**
   * Not awaited, unlike the input change: this is a slider, and holding the
   * WebSocket command open for a coalesced DDC write would make dragging feel
   * like it was fighting back. Failures surface on the next poll instead.
   */
  router.register('monitor.setBrightness', (command) => {
    try {
      monitors.setBrightness(command.id, command.brightness);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });

  router.register('monitor.setInput', async (command) => {
    try {
      await monitors.setInput(command.id, command.input);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });
}
