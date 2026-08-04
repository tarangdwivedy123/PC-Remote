import { readFileSync } from 'node:fs';
import path from 'node:path';

import WebSocket from 'ws';

import { buildMediaState, keysOnlyState } from '../../agent/src/media/index.js';
import { friendlyAppName } from '../../agent/src/media/appNames.js';
import { REPO_ROOT, createChecker, startAgent, tempDataDir } from './lib.mjs';

/**
 * Milestone 4A: media-key emulation.
 *
 * Implemented with a `keybd_event` P/Invoke inside the shared Windows helper
 * rather than a bundled nircmd.exe — the same "no third-party binary" choice made
 * for volume. Windows routes these system-wide hardware keys to whichever app
 * owns media playback, so it works without knowing what is playing.
 *
 * What cannot be asserted here: that a key actually changed playback. That needs
 * a real media app holding a session, which a headless suite has no way to
 * arrange. These checks cover the mechanism and the honesty of the reported
 * state; the README's by-hand steps cover the audible result.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 4 — media keys and sessions');

  // -- session state, no media app required --------------------------------

  const rich = buildMediaState(
    {
      available: true,
      hasSession: true,
      app: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
      title: 'Some Song',
      artist: 'Some Artist',
      album: 'Some Album',
      status: 'playing',
      positionSec: 42.5,
      durationSec: 210,
      canNext: true,
      canPrevious: true,
      canSeek: true,
    },
    'abc123',
  );
  check('a live session reports the smtc backend', rich.backend === 'smtc');
  check('metadata is carried through', rich.title === 'Some Song' && rich.artist === 'Some Artist');
  check('the owning app is named, not its AppUserModelID', rich.sourceApp === 'Spotify', rich.sourceApp);
  check('position and duration are reported', rich.positionSec === 42.5 && rich.durationSec === 210);
  check('seek is offered when the session supports it', rich.canSeek === true);
  check('the artwork id is attached', rich.thumbnailId === 'abc123');

  /**
   * A scrubber with no end to scrub towards is unusable, so seek needs both the
   * capability flag and a known duration.
   */
  const noDuration = buildMediaState({
    available: true, hasSession: true, status: 'playing', canSeek: true, durationSec: 0,
  });
  check('seek is withheld when the duration is unknown', noDuration.canSeek === false);

  const sparse = buildMediaState({
    available: true, hasSession: true, status: 'paused', title: 'T', artist: '', album: '',
  });
  check(
    'empty artist and album are omitted rather than rendered blank',
    sparse.artist === undefined && sparse.album === undefined && sparse.title === 'T',
  );
  check('no artwork id when there is no artwork', sparse.thumbnailId === undefined);

  const keys = keysOnlyState();
  check('the keys fallback claims no metadata', keys.title === undefined && keys.backend === 'keys');
  check('the keys fallback admits it cannot know the status', keys.status === 'unknown');
  check('the keys fallback offers no seek', keys.canSeek === false);

  // -- app naming ----------------------------------------------------------
  const names: [string, string][] = [
    ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'Media Player'],
    ['chrome.exe', 'Google Chrome'],
    ['msedge.exe', 'Microsoft Edge'],
    ['SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'Spotify'],
    ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', 'VLC'],
    ['SomeVendor.CoolPlayer_abc!App', 'Cool Player'],
    ['', ''],
  ];
  for (const [input, expected] of names) {
    check(
      `app id "${input.slice(0, 34) || '(empty)'}" reads as "${expected}"`,
      friendlyAppName(input) === expected,
      friendlyAppName(input),
    );
  }


  // -- capability flags are advisory, not gospel ---------------------------

  const mediaSource = readFileSync(path.join(REPO_ROOT, 'agent/src/media/index.ts'), 'utf8');
  /**
   * Chrome playing a YouTube video reports canPause:false and canNext:false while
   * responding perfectly well to the keys. Treating those as authoritative left
   * the transport buttons dead, so a refused action escalates instead.
   */
  /**
   * Play and pause are collapsed into the toggle before anything is sent, rather
   * than being tried discretely first. A session's reported status is not
   * reliable — Chrome was measured claiming `status: paused` and `canPause: true`
   * at once — so choosing between play and pause from it means routinely sending
   * the action that is already true, which apps accept and ignore.
   */
  check(
    'play and pause are always sent as a toggle',
    /action === 'play' \|\| action === 'pause' \|\| action === 'playPause' \? 'toggle'/.test(mediaSource),
  );
  check(
    'a refused action ultimately falls back to the media key',
    /falling back to the media key/.test(mediaSource) && /mediaKey', \{ key: toKey\(action\)/.test(mediaSource),
  );
  /**
   * No status-based short-circuit remains, and none is needed: a toggle cannot be
   * redundant. The earlier version skipped sends when the status looked already
   * correct, which is precisely what broke the button when that status was wrong.
   */
  check(
    'the transport does not gate on the reported status',
    !/current\?\.status === 'playing'/.test(mediaSource),
  );

  const ui = readFileSync(path.join(REPO_ROOT, 'client/src/components/NowPlayingSection.tsx'), 'utf8');
  check(
    'next and previous are never greyed out on advertised capability',
    !/disabled=\{[^}]*canNext/.test(ui) && !/disabled=\{[^}]*canPrevious/.test(ui),
  );

  const hostScript2 = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  /**
   * PowerShell 5.1 hands back an unprojected __ComObject from OpenReadAsync and
   * refuses to cast it to the WinRT interface, so DataReader was unreachable and
   * artwork silently never loaded. Reflection lets the CLR do the QueryInterface.
   */
  check(
    'artwork is read through the AsStreamForRead extension, not DataReader',
    // A method *call* — the prose above mentions GetInputStreamAt by name, and
    // matching the bare word finds the comment explaining why it is not used.
    /AsStreamForRead\.Invoke/.test(hostScript2) && !/\.GetInputStreamAt\(/.test(hostScript2),
  );
  check('the image format is sniffed from its magic bytes', /0x89 -and .*0x50/.test(hostScript2));

  // -- source guarantees ---------------------------------------------------

  const script = readFileSync(path.join(REPO_ROOT, 'agent/src/winhost/script.ts'), 'utf8');
  check(
    'the four media virtual-key codes are the documented ones',
    /VK_MEDIA_NEXT_TRACK = 0xB0/.test(script) &&
      /VK_MEDIA_PREV_TRACK = 0xB1/.test(script) &&
      /VK_MEDIA_STOP = 0xB2/.test(script) &&
      /VK_MEDIA_PLAY_PAUSE = 0xB3/.test(script),
  );
  /**
   * Media keys are extended-key scan codes. Without KEYEVENTF_EXTENDEDKEY some
   * applications ignore them entirely, which would look like the feature simply
   * not working for certain apps.
   */
  check(
    'keys are sent with the extended-key flag',
    /KEYEVENTF_EXTENDEDKEY, UIntPtr\.Zero/.test(script),
  );
  check(
    'both a key-down and a key-up are sent',
    (script.match(/keybd_event\(vk/g) ?? []).length === 2,
  );

  /**
   * One PowerShell process serves both volume and media. A second host would pay
   * the ~600ms Add-Type compile again for no benefit.
   */
  const indexSource = readFileSync(path.join(REPO_ROOT, 'agent/src/index.ts'), 'utf8');
  check(
    'volume and media share a single Windows helper process',
    (indexSource.match(/new WinHost\(\)/g) ?? []).length === 1 &&
      /new VolumeService\(hub, winHost\)/.test(indexSource) &&
      /new MediaService\(hub, winHost\)/.test(indexSource),
  );

  // -- live agent ----------------------------------------------------------

  const dataDir = tempDataDir('m4-media');
  const port = 8792;
  const agent = await startAgent({ port, dataDir, entry: 'source' });

  try {
    check('agent starts with the media service', agent.up);
    if (!agent.up) {
      console.log(agent.plainOutput);
      return { results };
    }

    const pin = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')).pin;
    const { token } = await (
      await fetch(`${agent.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin, deviceName: 'm4-verify' }),
      })
    ).json();
    const authed = { authorization: `Bearer ${token}` };

    const readMedia = async () => {
      const body = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
      return body.state?.media ?? null;
    };

    let media = null;
    const waitStart = Date.now();
    while (Date.now() - waitStart < 25_000) {
      media = await readMedia();
      if (media) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check('media state appears after startup', media !== null, `${Date.now() - waitStart}ms`);
    if (!media) return { results };

    /**
     * Which backend is live depends on whether anything on this desktop happens
     * to hold a media session, so branch rather than assume. Both paths are worth
     * asserting; the interesting one is whichever the machine is in.
     */
    const playing = media.backend === 'smtc';
    console.log(
      `        \x1b[2m(a media session ${playing ? 'is' : 'is not'} active here — checking the ${media.backend} backend)\x1b[0m`,
    );

    if (playing) {
      check('a live session reports real capabilities', typeof media.canSeek === 'boolean' && typeof media.canNext === 'boolean');
      check('a live session reports a real status', ['playing', 'paused', 'stopped', 'unknown'].includes(media.status), media.status);
      check('a live session names the owning app', typeof media.sourceApp === 'string' && media.sourceApp.length > 0, media.sourceApp);
    } else {
      /**
       * The honesty requirement. Media keys report nothing back, so any status
       * other than "unknown" would be a guess — and a play/pause button that
       * silently inverts the first time playback is changed on the PC itself is
       * worse than one that admits it does not know.
       */
      check('playback status is reported as unknown rather than guessed', media.status === 'unknown', media.status);
      check('seek is advertised as unsupported', media.canSeek === false);
      check('next and previous are advertised as available', media.canNext === true && media.canPrevious === true);
      check(
        'no metadata is invented for the keys backend',
        media.title === undefined && media.artist === undefined && media.thumbnailId === undefined,
        JSON.stringify(media),
      );
    }

    // -- commands ------------------------------------------------------------
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    const acks = new Map<string, { ok: boolean; error?: string }>();
    let lastError: string | undefined;
    let nextId = 1;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('ws failed')));
      setTimeout(() => reject(new Error('ws open timed out')), 5000);
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === 'ack') acks.set(frame.id, { ok: frame.ok, error: frame.error });
      else if (frame.type === 'error') lastError = frame.message;
    });

    const command = async (cmd: unknown): Promise<{ ok: boolean; error?: string }> => {
      const id = String(nextId++);
      lastError = undefined;
      socket.send(JSON.stringify({ type: 'command', id, command: cmd }));
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const ack = acks.get(id);
        if (ack) return ack;
        if (lastError !== undefined) return { ok: false, error: lastError };
        await new Promise((r) => setTimeout(r, 25));
      }
      return { ok: false, error: 'no ack' };
    };

    /**
     * These genuinely act on the machine.
     *
     * With no media session they press inert media keys, which proves the whole
     * path from WebSocket to user32 works. With a session live they would reach
     * whatever is actually playing — pausing someone's music because they ran
     * the test suite is not acceptable, so the transport commands are skipped and
     * only their registration is checked.
     */
    if (playing) {
      console.log(
        '        \x1b[2m(transport commands skipped: a real session is playing and would be affected)\x1b[0m',
      );
      const registered = readFileSync(path.join(REPO_ROOT, 'agent/src/media/commands.ts'), 'utf8');
      for (const kind of ['media.playPause', 'media.play', 'media.pause', 'media.next', 'media.previous', 'media.stop']) {
        check(`${kind} has a handler`, registered.includes(`'${kind}'`));
      }
    } else {
      for (const kind of ['media.playPause', 'media.next', 'media.previous', 'media.stop']) {
        const ack = await command({ kind });
        check(`${kind} is accepted and dispatched`, ack.ok, ack.error);
      }
      // No keyboard has discrete play and pause keys; both map onto the toggle.
      for (const kind of ['media.play', 'media.pause']) {
        const ack = await command({ kind });
        check(`${kind} maps onto the play/pause key`, ack.ok, ack.error);
      }
    }

    const seek = await command({ kind: 'media.seek', positionSec: 30 });
    if (playing) {
      check('seek against a live session is answered either way', typeof seek.ok === 'boolean', seek.error);
    } else {
      check(
        'seek with no session is refused with a reason',
        !seek.ok && (seek.error ?? '').length > 0 && !/not available on this agent/i.test(seek.error ?? ''),
        seek.error,
      );
    }

    const negative = await command({ kind: 'media.seek', positionSec: -5 });
    check('a negative seek position is rejected by zod', !negative.ok, negative.error);

    // Sending a burst must not wedge the shared host, which volume also uses.
    // Skipped when something is really playing, for the same reason as above.
    if (!playing) {
      for (let i = 0; i < 8; i++) await command({ kind: 'media.playPause' });
    }
    const volumeAfter = await (await fetch(`${agent.base}/api/state`, { headers: authed })).json();
    check(
      'volume still works through the shared host after a burst of media keys',
      typeof volumeAfter.state?.volume?.master === 'number',
      `master=${volumeAfter.state?.volume?.master}%`,
    );

    socket.close();
  } finally {
    await agent.stop();
  }

  return { results };
}
