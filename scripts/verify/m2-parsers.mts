import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { parseProbeLine, parseSampleLine } from '../../agent/src/stats/gpu.js';
import { parseCsvLine, parseHeader } from '../../agent/src/stats/perfcounters.js';
import { DELETED, applyPatch, computePatch, isDeleted } from '../../shared/src/patch.js';
import { REPO_ROOT, createChecker } from './lib.mjs';

/**
 * Pure-function checks for the two output parsers.
 *
 * These matter more than usual because neither code path can be exercised on the
 * development machine: it has no NVIDIA GPU, so every nvidia-smi branch is dead
 * code here and would otherwise ship completely untested. The typeperf fixtures
 * are copied verbatim from real output on this machine.
 */
export async function run() {
  const { check, results } = createChecker('Milestone 2 — output parsers');

  // -- nvidia-smi ----------------------------------------------------------

  const normal = parseSampleLine('45, 3072, 8192, 67', 'NVIDIA GeForce RTX 3070');
  check(
    'parses a normal nvidia-smi sample row',
    normal?.utilPct === 45 && normal?.memUsedMB === 3072 && normal?.memTotalMB === 8192 && normal?.tempC === 67,
    JSON.stringify(normal),
  );
  check('carries the GPU name through', normal?.name === 'NVIDIA GeForce RTX 3070');

  const idle = parseSampleLine('0, 512, 8192, 34', 'GPU');
  check('an idle GPU at 0% is not mistaken for missing data', idle?.utilPct === 0, JSON.stringify(idle));

  /**
   * nvidia-smi prints these literals for fields a card does not support —
   * laptop GPUs commonly omit temperature. Number("[N/A]") is NaN, which would
   * serialise to null in JSON and render as an empty readout.
   */
  const partial = parseSampleLine('45, [N/A], [N/A], [Not Supported]', 'Quadro');
  check(
    'unsupported fields become 0 rather than NaN',
    partial?.utilPct === 45 && partial?.memUsedMB === 0 && partial?.memTotalMB === 0 && partial?.tempC === 0,
    JSON.stringify(partial),
  );
  check(
    'no NaN survives into the parsed object',
    partial !== undefined && Object.values(partial).every((v) => typeof v !== 'number' || Number.isFinite(v)),
  );

  check('a row with no utilisation is rejected', parseSampleLine('[N/A], 1, 2, 3', 'GPU') === undefined);
  check('a truncated row is rejected', parseSampleLine('45, 3072', 'GPU') === undefined);
  check('an empty row is rejected', parseSampleLine('', 'GPU') === undefined);
  check('a header echo is rejected', parseSampleLine('utilization.gpu, memory.used', 'GPU') === undefined);

  const probe = parseProbeLine('NVIDIA GeForce RTX 4060 Laptop GPU, 12, 1024, 8188, 41');
  check(
    'parses the probe row including the GPU name',
    probe?.name === 'NVIDIA GeForce RTX 4060 Laptop GPU' && probe.stats.utilPct === 12 && probe.stats.memTotalMB === 8188,
    JSON.stringify(probe),
  );
  check('a probe row missing fields is rejected', parseProbeLine('Some GPU, 12') === undefined);

  // Multi-GPU machines print one row per card; only the first is used.
  const multi = 'NVIDIA A, 10, 1, 2, 30\nNVIDIA B, 90, 3, 4, 80';
  const first = parseProbeLine(multi.split('\n')[0] as string);
  check('with several GPUs the first row parses cleanly', first?.name === 'NVIDIA A' && first.stats.utilPct === 10);

  // -- typeperf CSV --------------------------------------------------------

  const simple = parseCsvLine('"07/30/2026 04:14:07.784","480346.950494","12096.880180"');
  check(
    'splits a quoted typeperf data row',
    simple.length === 3 && simple[0]?.startsWith('07/30/2026') && simple[2] === '12096.880180',
    JSON.stringify(simple),
  );

  /**
   * Adapter descriptions can contain commas. A naive split(',') would shift every
   * column after the offending one, silently attributing disk bytes to network.
   */
  const withComma = parseCsvLine('"ts","\\\\PC\\Network Interface(Realtek Gaming 2.5GbE, PCIe)\\Bytes Sent/sec","5"');
  check(
    'a comma inside a quoted instance name does not split the row',
    withComma.length === 3 && withComma[2] === '5',
    JSON.stringify(withComma),
  );

  check('an empty trailing field is preserved', parseCsvLine('"a","b",""').length === 3);

  // Verbatim header from typeperf on this machine.
  const header =
    '"(PDH-CSV 4.0)","\\\\MYPC\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",' +
    '"\\\\MYPC\\PhysicalDisk(_Total)\\Disk Write Bytes/sec",' +
    '"\\\\MYPC\\Network Interface(Intel[R] Ethernet Connection [7] I219-LM)\\Bytes Received/sec",' +
    '"\\\\MYPC\\Network Interface(Intel[R] Wireless-AC 9560 160MHz)\\Bytes Received/sec",' +
    '"\\\\MYPC\\Network Interface(Intel[R] Ethernet Connection [7] I219-LM)\\Bytes Sent/sec",' +
    '"\\\\MYPC\\Network Interface(Intel[R] Wireless-AC 9560 160MHz)\\Bytes Sent/sec"';

  const columns = parseHeader(header);
  check('header maps to one column per counter, dropping the PDH marker', columns.length === 6, `${columns.length} columns`);
  check('disk read column identified', columns[0]?.kind === 'diskRead' && !columns[0]?.ignored);
  check('disk write column identified', columns[1]?.kind === 'diskWrite' && !columns[1]?.ignored);
  check(
    'both received columns identified as network receive',
    columns[2]?.kind === 'netRx' && columns[3]?.kind === 'netRx',
  );
  check(
    'both sent columns identified as network transmit',
    columns[4]?.kind === 'netTx' && columns[5]?.kind === 'netTx',
  );
  check(
    'instance names are extracted from the counter path',
    columns[3]?.instance === 'Intel[R] Wireless-AC 9560 160MHz',
    columns[3]?.instance,
  );
  check(
    'the _Total disk instance is not filtered out',
    columns[0]?.instance === '_Total' && columns[0]?.ignored === false,
  );

  /**
   * Loopback and tunnel pseudo-adapters expose the same counters as real NICs.
   * Counting them would inflate the network figures, since traffic to the machine
   * itself appears on both.
   */
  const pseudoHeader =
    '"(PDH-CSV 4.0)","\\\\PC\\Network Interface(Loopback Pseudo-Interface 1)\\Bytes Received/sec",' +
    '"\\\\PC\\Network Interface(isatap.{GUID})\\Bytes Sent/sec",' +
    '"\\\\PC\\Network Interface(Teredo Tunneling Pseudo-Interface)\\Bytes Sent/sec",' +
    '"\\\\PC\\Network Interface(Wi-Fi 6 AX201)\\Bytes Received/sec"';
  const pseudo = parseHeader(pseudoHeader);
  check('loopback instance is ignored', pseudo[0]?.ignored === true);
  check('isatap instance is ignored', pseudo[1]?.ignored === true);
  check('teredo instance is ignored', pseudo[2]?.ignored === true);
  check('a real adapter is not ignored', pseudo[3]?.ignored === false, pseudo[3]?.instance);

  // An unrecognised counter must be ignored rather than silently counted as disk.
  const unknown = parseHeader('"(PDH-CSV 4.0)","\\\\PC\\Processor(_Total)\\% Idle Time"');
  check('an unrecognised counter is marked ignored', unknown[0]?.ignored === true);

  // -- the deletion marker -------------------------------------------------

  /**
   * This marker is how the agent tells the client a field went away — a GPU
   * disappearing being the case that matters. It crosses the wire as JSON, so
   * identity comparison cannot work on the receiving end, and an earlier version
   * used a NUL-prefixed string that editors rendered as a plain space. These
   * checks exist so neither trap can come back unnoticed.
   */
  const wireMarker = JSON.parse(JSON.stringify(DELETED));
  check('the deletion marker survives a JSON round trip', isDeleted(wireMarker));
  check('the marker is not identity-compared', wireMarker !== DELETED && isDeleted(wireMarker));

  const notMarkers: [unknown, string][] = [
    ['', 'an empty string'],
    [' __del', 'the old string sentinel'],
    [0, 'zero'],
    [null, 'null'],
    [{}, 'an empty object'],
    [{ __pcrDeleted: false }, 'the key set to false'],
    [{ __pcrDeleted: true, other: 1 }, 'the key alongside other data'],
    [{ utilPct: 0, memUsedMB: 0, memTotalMB: 0, tempC: 0 }, 'a zeroed GPU object'],
  ];
  for (const [value, label] of notMarkers) {
    check(`${label} is not mistaken for a deletion`, !isDeleted(value));
  }

  const removed = computePatch(
    { stats: { cpu: { loadPct: 5 }, gpu: { utilPct: 64 } } },
    { stats: { cpu: { loadPct: 6 } } },
  );
  check('computePatch marks a removed nested key', isDeleted((removed as never)?.stats?.gpu));

  const reapplied = applyPatch(
    { stats: { cpu: { loadPct: 5 }, gpu: { utilPct: 64 } } },
    JSON.parse(JSON.stringify(removed)),
  );
  check(
    'applyPatch drops the key after the marker crosses the wire',
    !('gpu' in (reapplied as { stats: Record<string, unknown> }).stats) &&
      (reapplied as { stats: { cpu: { loadPct: number } } }).stats.cpu.loadPct === 6,
    JSON.stringify(reapplied),
  );

  /**
   * Guard against an invisible control character being reintroduced anywhere in
   * the source. That is what made the original bug so hard to see.
   */
  // scripts/ included deliberately: the verification scripts are full of
  // hand-written regexes, which is precisely where an escape like \\b turns
  // into the control character it denotes. That happened, and this missed it.
  const sourceRoots = ['shared/src', 'agent/src', 'client/src', 'scripts'];
  const offenders: string[] = [];
  for (const root of sourceRoots) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      const text = readFileSync(file, 'utf8');
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        // Tab, LF and CR are legitimate; everything else below 0x20 is not.
        if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
          offenders.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')} (U+${code.toString(16).padStart(4, '0')})`);
          break;
        }
      }
    }
  }
  check('no invisible control characters anywhere in the source', offenders.length === 0, offenders.join(', '));

  return { results };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css|mts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}
