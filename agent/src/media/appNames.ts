/**
 * Turns a media session's owner into something worth putting on screen.
 *
 * SMTC identifies the owning app by AppUserModelID, which for a packaged app is
 * a string like:
 *
 *   Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic
 *
 * and for a desktop app is usually just the executable, `chrome.exe`. Neither is
 * something to show a user, so this cleans them up and maps the common ones to
 * the names they are actually known by.
 */

/**
 * Apps whose identifier does not resemble their name. Keyed by the cleaned-up
 * form, so both `Microsoft.ZuneMusic_hash!Entry` and a bare `Microsoft.ZuneMusic`
 * resolve the same way.
 */
const ALIASES = new Map<string, string>([
  // Media Player kept its old Zune identifier through two renames.
  ['microsoft.zunemusic', 'Media Player'],
  ['microsoft.zunevideo', 'Media Player'],
  ['microsoft.media.player', 'Media Player'],
  ['microsoft.windowsmediaplayer', 'Windows Media Player'],
  ['wmplayer', 'Windows Media Player'],
  ['chrome', 'Google Chrome'],
  ['msedge', 'Microsoft Edge'],
  ['firefox', 'Firefox'],
  ['brave', 'Brave'],
  ['opera', 'Opera'],
  ['vivaldi', 'Vivaldi'],
  ['spotify', 'Spotify'],
  ['spotifyab.spotifymusic', 'Spotify'],
  ['vlc', 'VLC'],
  ['foobar2000', 'foobar2000'],
  ['musicbee', 'MusicBee'],
  ['itunes', 'iTunes'],
  ['applemusic', 'Apple Music'],
  ['appleinc.applemusicwin', 'Apple Music'],
  ['tidal', 'TIDAL'],
  ['deezer', 'Deezer'],
  ['audacious', 'Audacious'],
  ['mpv', 'mpv'],
  ['potplayermini64', 'PotPlayer'],
  ['potplayermini', 'PotPlayer'],
]);

export function friendlyAppName(aumid: string): string {
  const raw = (aumid ?? '').trim();
  if (raw === '') return '';

  // Packaged apps: "Family_publisherhash!AppId" — the family is the useful half.
  let base = raw.includes('!') ? (raw.split('!')[0] ?? raw) : raw;
  // Strip the publisher hash that follows the underscore.
  const underscore = base.indexOf('_');
  if (underscore > 0) base = base.slice(0, underscore);
  // Desktop apps arrive as an executable, sometimes with a full path.
  base = base.replace(/\\/g, '/');
  const lastSlash = base.lastIndexOf('/');
  if (lastSlash >= 0) base = base.slice(lastSlash + 1);
  base = base.replace(/\.exe$/i, '');

  const alias = ALIASES.get(base.toLowerCase());
  if (alias) return alias;

  // Unknown packaged app: drop a leading vendor segment so
  // "SomeVendor.CoolPlayer" reads as "CoolPlayer".
  const parts = base.split('.').filter(Boolean);
  const tail = parts.length > 1 ? (parts[parts.length - 1] ?? base) : base;

  return titleCase(tail);
}

/** "coolPlayer" and "cool_player" both become "Cool Player". */
function titleCase(value: string): string {
  const spaced = value
    .replace(/[_-]+/g, ' ')
    // Split camelCase, but leave runs of capitals ("VLC", "MPC") intact.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced === '') return '';
  return spaced
    .split(/\s+/)
    .map((word) => (word.length <= 1 ? word.toUpperCase() : word[0]?.toUpperCase() + word.slice(1)))
    .join(' ');
}
