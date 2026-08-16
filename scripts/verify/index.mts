/**
 * Runs every milestone verification in sequence.
 *
 *   npm run verify
 *
 * Each suite boots a real agent on its own port with its own data directory, so
 * this never touches the config in %APPDATA% and never collides with an agent
 * you already have running.
 */
import { run as runDev } from './m1-dev.mjs';
import { run as runProtocol } from './m1-protocol.mjs';
import { run as runRender } from './m1-render.mts';
import { run as runStatic } from './m1-static.mjs';
import { run as runClient } from './m2-client.mts';
import { run as runParsers } from './m2-parsers.mts';
import { run as runStats } from './m2-stats.mjs';
import { run as runVolume } from './m3-volume.mts';
import { run as runMedia } from './m4-media.mts';
import { run as runSystem } from './m6-system.mts';
import { run as runMonitors } from './m7-monitors.mts';
import { run as runExtras } from './m8-extras.mts';
import { run as runPackaging } from './m9-packaging.mts';
import { run as runOldChrome } from './old-chrome.mts';

const suites = [
  { name: 'm1-protocol', run: runProtocol },
  { name: 'm1-static', run: runStatic },
  { name: 'm1-dev', run: runDev },
  { name: 'm2-stats', run: runStats },
  { name: 'm2-parsers', run: runParsers },
  { name: 'm3-volume', run: runVolume },
  { name: 'm4-media', run: runMedia },
  { name: 'm6-system', run: runSystem },
  { name: 'm7-monitors', run: runMonitors },
  { name: 'm8-extras', run: runExtras },
  { name: 'm9-packaging', run: runPackaging },
  { name: 'old-chrome', run: runOldChrome },
  // The render suites go last: they install DOM globals process-wide, which the
  // agent suites would then pick up.
  { name: 'm1-render', run: runRender },
  { name: 'm2-client', run: runClient },
];

let total = 0;
let failedTotal = 0;
const brokenSuites: string[] = [];

for (const suite of suites) {
  try {
    const { results } = await suite.run();
    const failed = results.filter((r) => !r.ok);
    total += results.length;
    failedTotal += failed.length;
    if (failed.length > 0) brokenSuites.push(suite.name);
  } catch (err) {
    brokenSuites.push(suite.name);
    failedTotal += 1;
    total += 1;
    console.error(`\n  \x1b[31mSuite "${suite.name}" threw:\x1b[0m`, err);
  }
}

const passed = total - failedTotal;
console.log(
  `\n${failedTotal === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${total} checks passed\x1b[0m` +
    (brokenSuites.length > 0 ? `  (failures in: ${brokenSuites.join(', ')})` : ''),
);

process.exit(failedTotal === 0 ? 0 : 1);
