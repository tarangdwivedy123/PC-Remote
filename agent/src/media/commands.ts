import { CommandError, type CommandRouter } from '../commands.js';
import type { MediaAction, MediaService } from './index.js';

/**
 * Binds the media commands to the router.
 *
 * These are awaited, unlike the volume commands, so a failure nacks the
 * WebSocket command and the phone can show why. There is no debounce to wait
 * behind — a transport button is one discrete press, not a drag.
 *
 * `play` and `pause` stay distinct here rather than being collapsed into the
 * toggle up front. With a media session they are genuinely different operations,
 * and pressing "play" on something already playing should be a no-op instead of
 * pausing it. The service folds them onto the toggle only when it has to fall
 * back to a key.
 */
export function registerMediaCommands(router: CommandRouter, media: MediaService): void {
  const bind = (kind: 'media.playPause' | 'media.play' | 'media.pause' | 'media.next' | 'media.previous' | 'media.stop', action: MediaAction): void => {
    router.register(kind, async () => {
      try {
        await media.control(action);
      } catch (err) {
        throw new CommandError((err as Error).message);
      }
    });
  };

  bind('media.playPause', 'playPause');
  bind('media.play', 'play');
  bind('media.pause', 'pause');
  bind('media.next', 'next');
  bind('media.previous', 'previous');
  bind('media.stop', 'stop');

  router.register('media.seek', async (command) => {
    try {
      await media.seek(command.positionSec);
    } catch (err) {
      throw new CommandError((err as Error).message);
    }
  });
}
