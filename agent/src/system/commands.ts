import type { AuthService } from '../auth.js';
import { CommandError, type CommandRouter } from '../commands.js';
import { createLogger } from '../log.js';
import type { SystemService } from './index.js';

const log = createLogger('system');

/**
 * Binds the system commands.
 *
 * Lock, sleep and display-off are freely available — all three are recoverable
 * by walking over to the machine.
 *
 * Shutdown and restart are not, so they carry a second gate on top of the
 * phone's confirm-twice UI: a single-use token from `/api/confirm-token` with a
 * 30-second life. The UI alone would leave the machine one malformed frame away
 * from powering off, and "are you sure?" is not a control, it is a suggestion.
 */
export function registerSystemCommands(
  router: CommandRouter,
  system: SystemService,
  auth: AuthService,
): void {
  const simple = (['lock', 'sleep', 'displayOff'] as const).map(
    (action) => [`system.${action}` as const, action] as const,
  );

  for (const [kind, action] of simple) {
    router.register(kind, async () => {
      try {
        await system.run(action);
      } catch (err) {
        throw new CommandError((err as Error).message);
      }
    });
  }

  router.register('system.sleepTimer', (command) => {
    system.sleepTimer(command.minutes);
  });

  router.register('system.sendText', async (command) => {
    try {
      await system.sendText(command.text);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });

  router.register('system.openUrl', async (command) => {
    try {
      await system.openUrl(command.url);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });

  const destructive = [
    ['system.shutdown', 'shutdown'],
    ['system.restart', 'restart'],
  ] as const;

  for (const [kind, action] of destructive) {
    router.register(kind, async (command) => {
      // Single-use: consuming it here means a replayed frame cannot fire twice.
      if (!auth.consumeConfirmToken(command.confirm, kind)) {
        log.warn(`rejected ${kind}: bad or expired confirmation token`);
        throw new CommandError(
          'That confirmation expired. Press and hold again to confirm.',
        );
      }
      try {
        await system.run(action);
      } catch (err) {
        throw new CommandError((err as Error).message);
      }
    });
  }
}
