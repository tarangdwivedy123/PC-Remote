import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { MonitorInfo, MonitorInput, MonitorState } from '@pcr/shared';

import { dataDir } from '../config.js';
import { createLogger } from '../log.js';
import type { StateHub } from '../state.js';
import { WinHost } from '../winhost/host.js';

const log = createLogger('monitors');

/**
 * How often the current input is re-read.
 *
 * Measured at ~125ms for two monitors, which is far too expensive for the 1 Hz
 * broadcast tick but fine on a slow timer. Nothing changes a monitor's input
 * except a person, so a stale reading for a few seconds costs nothing — and a
 * switch made from here refreshes immediately rather than waiting for this.
 */
const POLL_INTERVAL_MS = 10_000;

/**
 * Consecutive failed reads before a monitor is reported as uncontrollable.
 * Three polls is about half a minute — long enough to ride out a monitor that is
 * briefly busy, short enough to notice one that has genuinely gone away.
 */
const MISSES_BEFORE_GIVING_UP = 3;

/**
 * Coalescing window for brightness writes. Longer than the 100ms used for the
 * volume sliders because a DDC round trip is an order of magnitude slower than a
 * Core Audio call, and the monitor visibly steps through intermediate values.
 */
const BRIGHTNESS_COALESCE_MS = 200;

/** Raw row from the host's `monitors` command. */
interface RawMonitor {
  id: string;
  device: string;
  description?: string;
  hardwareId?: string;
  primary: boolean;
  hasInput: boolean;
  currentInput: number;
  hasBrightness?: boolean;
  brightness?: number;
  brightnessMax?: number;
  capabilities?: string;
  error?: string;
}

interface RawResult {
  monitors: RawMonitor[];
  /** EDID names keyed by plug-and-play id. */
  names?: Record<string, string>;
}

/**
 * Monitor input switching over DDC/CI.
 *
 * The capabilities string — which is the only trustworthy list of a monitor's
 * real inputs — costs 2 to 3.5 seconds per display to read. So it is read once
 * at startup, in the background, and cached for the life of the process. The
 * recurring poll reads only the current input.
 */
export class MonitorService {
  #hub: StateHub;
  #host: WinHost;
  #timer: NodeJS.Timeout | undefined;
  #polling = false;

  /** Input lists from the one-off capabilities scan, keyed by monitor id. */
  #inputs = new Map<string, MonitorInput[]>();

  /**
   * Last input a monitor actually reported, and how many polls have failed since.
   *
   * A DDC/CI read dropping once is unremarkable, so one failure must not blank
   * the card or replace a working row with an error. The last good value is held
   * and only given up on after several consecutive misses — by which point the
   * monitor really is asleep, switched elsewhere, or unplugged.
   */
  #lastGood = new Map<string, number>();
  #misses = new Map<string, number>();

  /**
   * Brightness written locally but not yet confirmed by a poll, and the pending
   * write itself.
   *
   * A DDC write takes ~60ms and the poll only runs every 10 seconds, so without
   * an optimistic value the slider would snap back to the old reading the moment
   * you let go. The coalescing is the same idea as the volume sliders: dragging
   * must not queue one DDC conversation per pixel.
   */
  #optimisticBrightness = new Map<string, number>();
  #pendingBrightness = new Map<string, number>();
  #brightnessTimer: NodeJS.Timeout | undefined;
  #names = new Map<string, string>();
  #scanning = false;

  constructor(hub: StateHub, host: WinHost) {
    this.#hub = hub;
    this.#host = host;
  }

  async start(): Promise<void> {
    if (!this.#host.ready) {
      this.#hub.setMonitors(null);
      return;
    }

    /**
     * Nothing here is awaited. The capabilities scan takes ~6 seconds for two
     * displays, and the host serialises requests on one pipe — so awaiting even
     * the quick poll queues it behind the scan and delays agent startup by the
     * whole six seconds. The scan publishes when it finishes, and the timer
     * keeps the reading fresh after that.
     */
    void this.#scan();

    this.#timer = setInterval(() => void this.#poll(), POLL_INTERVAL_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#brightnessTimer) clearTimeout(this.#brightnessTimer);
    this.#brightnessTimer = undefined;
  }

  /**
   * Switches a monitor to a different input.
   *
   * The value is checked against what the monitor actually advertised. Writing an
   * arbitrary VCP value to a display is a good way to land it on a dead input
   * with no picture, which on a monitor whose buttons are hard to reach is a
   * genuinely annoying thing to do by accident.
   */
  async setInput(id: string, input: number): Promise<void> {
    if (!this.#host.ready) throw new Error('The Windows helper is not running');

    const known = this.#inputs.get(id);
    if (known && known.length > 0 && !known.some((i) => i.code === input)) {
      throw new Error(`That monitor does not list input 0x${input.toString(16).toUpperCase()}`);
    }

    log.warn(`switching ${this.#label(id)} to input 0x${input.toString(16).toUpperCase()}`);
    const result = await this.#host.request<{ currentInput: number }>('monitorSetInput', {
      monitor: id,
      input,
    });
    if (typeof result?.currentInput !== 'number') {
      throw new Error('The monitor did not accept the input change');
    }
    /**
     * Seed the remembered value from the switch itself. A monitor that has just
     * moved to another device often stops answering, and without this the row
     * would immediately fall back to showing the old input.
     */
    this.#lastGood.set(id, result.currentInput);
    this.#misses.set(id, 0);
    await this.#poll();
  }

  /**
   * Queues a brightness change. Reflected immediately, written after a short
   * coalescing window.
   */
  setBrightness(id: string, percent: number): void {
    if (!this.#host.ready) throw new Error('The Windows helper is not running');
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    this.#optimisticBrightness.set(id, clamped);
    this.#pendingBrightness.set(id, clamped);
    this.#publishCurrent();

    if (this.#brightnessTimer === undefined) {
      this.#brightnessTimer = setTimeout(() => {
        this.#brightnessTimer = undefined;
        void this.#flushBrightness();
      }, BRIGHTNESS_COALESCE_MS);
      this.#brightnessTimer.unref?.();
    }
  }

  async #flushBrightness(): Promise<void> {
    const writes = [...this.#pendingBrightness];
    this.#pendingBrightness.clear();

    for (const [id, percent] of writes) {
      try {
        await this.#host.request<{ brightness: number }>('setBrightness', {
          monitor: id,
          percent,
        });
      } catch (err) {
        log.debug(`brightness write to ${this.#label(id)} failed:`, err);
      }
    }
    await this.#poll();
  }

  // -- internals -----------------------------------------------------------

  #label(id: string): string {
    return this.#names.get(id) ?? id;
  }

  /**
   * Learns each monitor's real input list.
   *
   * Two things make this awkward, and both are handled here rather than being
   * pushed onto the user:
   *
   * 1. It takes ~6 seconds for two displays, and the interop host serialises
   *    requests on one pipe — so running it on the shared host would stall every
   *    volume, media and system command behind it. It gets its own throwaway
   *    host, which is shut down the moment the scan finishes.
   * 2. The answer never changes for a given monitor, so it is cached on disk.
   *    After the first run there is no scan at all: restarting the agent picks
   *    the input lists straight out of the cache.
   */
  async #scan(): Promise<void> {
    await this.#loadCache();
    // Publish the cached lists immediately so the phone has them straight away.
    await this.#poll();

    const known = await this.#currentHardwareIds();
    if (known.length > 0 && known.every((id) => this.#capsCache.has(id))) {
      log.info(`input lists for ${known.length} display(s) came from cache`);
      return;
    }

    this.#scanning = true;
    this.#publishCurrent();
    const started = Date.now();

    // A dedicated process, so a six-second DDC conversation cannot delay a
    // play/pause press on the shared host.
    const scanHost = new WinHost('winhost-scan');
    try {
      await scanHost.start();
      if (!scanHost.ready) throw new Error(scanHost.fatalReason ?? 'scan host did not start');

      const raw = await scanHost.request<RawResult>(
        'monitors',
        { withCapabilities: true },
        // Well beyond the measured 3.5s worst case: a monitor that is asleep or
        // has DDC/CI switched off in its menu takes much longer to give up.
        45_000,
      );

      for (const m of raw?.monitors ?? []) {
        if (m.capabilities && m.hardwareId) this.#capsCache.set(m.hardwareId, m.capabilities);
      }
      await this.#saveCache();
      this.#absorb(raw);

      const controllable = [...this.#inputs.values()].filter((v) => v.length > 0).length;
      log.info(
        `${raw?.monitors?.length ?? 0} display(s), ${controllable} with switchable inputs ` +
          `(scan took ${Date.now() - started}ms, cached for next time)`,
      );
    } catch (err) {
      log.warn('monitor capability scan failed:', err);
    } finally {
      scanHost.stop();
      this.#scanning = false;
      await this.#poll();
    }
  }

  // -- capability cache ----------------------------------------------------

  /** Capabilities strings keyed by the monitor's plug-and-play id. */
  #capsCache = new Map<string, string>();

  get #cacheFile(): string {
    return path.join(dataDir(), 'monitor-capabilities.json');
  }

  async #currentHardwareIds(): Promise<string[]> {
    try {
      const raw = await this.#host.request<RawResult>('monitors', { withCapabilities: false }, 15_000);
      return (raw?.monitors ?? []).map((m) => m.hardwareId ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  async #loadCache(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#cacheFile, 'utf8')) as Record<string, string>;
      for (const [id, caps] of Object.entries(parsed)) {
        if (typeof caps === 'string' && caps.length > 0) this.#capsCache.set(id, caps);
      }
    } catch {
      // No cache yet, or it is unreadable. Either way the scan will rebuild it.
    }
  }

  async #saveCache(): Promise<void> {
    const file = this.#cacheFile;
    const temp = `${file}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.#capsCache), null, 2), 'utf8');
      await rename(temp, file);
    } catch (err) {
      log.debug('could not write the monitor capability cache:', err);
    }
  }

  #publishCurrent(): void {
    const state = this.#hub.snapshot().monitors;
    if (state) this.#hub.setMonitors({ ...state, scanning: this.#scanning });
  }

  async #poll(): Promise<void> {
    if (this.#polling || !this.#host.ready) return;
    this.#polling = true;
    try {
      const raw = await this.#host.request<RawResult>('monitors', { withCapabilities: false }, 15_000);
      this.#absorb(raw);
    } catch (err) {
      log.debug('monitor poll failed:', err);
    } finally {
      this.#polling = false;
    }
  }

  #absorb(raw: RawResult | undefined): void {
    if (!raw?.monitors) return;

    for (const [key, value] of Object.entries(raw.names ?? {})) {
      this.#namesByHardwareId.set(key, value);
    }

    const monitors: MonitorInfo[] = raw.monitors.map((m) => {
      // The poll does not read capabilities, so fall back to the disk cache to
      // keep the input list populated between scans.
      if (!m.capabilities && m.hardwareId && this.#capsCache.has(m.hardwareId)) {
        m = { ...m, capabilities: this.#capsCache.get(m.hardwareId) };
      }
      if (m.capabilities) {
        const parsed = parseInputs(m.capabilities);
        if (parsed.length > 0) this.#inputs.set(m.id, parsed);
        else this.#inputs.set(m.id, []);
      }

      const name = this.#resolveName(m);
      this.#names.set(m.id, name);

      const info: MonitorInfo = {
        id: m.id,
        name,
        primary: m.primary,
        inputs: this.#inputs.get(m.id) ?? [],
      };

      /**
       * The optimistic value wins until a poll confirms it, then is dropped so
       * that turning the knob on the monitor itself is picked up again.
       */
      const pendingBrightness = this.#optimisticBrightness.get(m.id);
      if (typeof m.brightness === 'number' && m.hasBrightness && (m.brightnessMax ?? 0) > 0) {
        const reported = Math.round((m.brightness * 100) / (m.brightnessMax ?? 100));
        if (pendingBrightness === undefined) {
          info.brightness = reported;
        } else {
          info.brightness = pendingBrightness;
          if (Math.abs(reported - pendingBrightness) <= 2) this.#optimisticBrightness.delete(m.id);
        }
      } else if (pendingBrightness !== undefined) {
        info.brightness = pendingBrightness;
      }

      if (m.hasInput) {
        this.#lastGood.set(m.id, m.currentInput);
        this.#misses.set(m.id, 0);
        info.currentInput = m.currentInput;
      } else {
        const misses = (this.#misses.get(m.id) ?? 0) + 1;
        this.#misses.set(m.id, misses);
        const remembered = this.#lastGood.get(m.id);

        if (remembered !== undefined && misses < MISSES_BEFORE_GIVING_UP) {
          // Keep showing what it last said. The poll runs every 10s, so this
          // rides out roughly half a minute of silence before admitting defeat.
          info.currentInput = remembered;
        } else {
          if (remembered !== undefined) this.#lastGood.delete(m.id);
          if (m.error) info.unavailable = m.error;
        }
      }

      return info;
    });

    const state: MonitorState = { monitors, scanning: this.#scanning };
    this.#hub.setMonitors(state);
  }

  #namesByHardwareId = new Map<string, string>();

  /**
   * Prefers the EDID model name. The description Windows reports is frequently
   * the literal string "Generic PnP Monitor", which is useless when the whole
   * point is telling two displays apart.
   */
  #resolveName(m: RawMonitor): string {
    const fromEdid = m.hardwareId ? this.#namesByHardwareId.get(m.hardwareId) : undefined;
    if (fromEdid) return fromEdid;

    const description = (m.description ?? '').trim();
    if (description && !/^generic\b/i.test(description)) return description;

    // Last resort: "\\.\DISPLAY2:0" -> "Display 2".
    const match = /DISPLAY(\d+)/i.exec(m.device ?? m.id);
    return match ? `Display ${match[1]}` : (description || m.id);
  }
}

// ---------------------------------------------------------------------------
// Parsing — exported for the verification suite
// ---------------------------------------------------------------------------

/**
 * MCCS input source values. Monitors are not obliged to follow this, but the
 * common ones do, and an unrecognised value is labelled by its number rather
 * than hidden — a monitor that reports an input we cannot name should still be
 * selectable.
 */
const INPUT_LABELS = new Map<number, string>([
  [0x01, 'VGA 1'],
  [0x02, 'VGA 2'],
  [0x03, 'DVI 1'],
  [0x04, 'DVI 2'],
  [0x05, 'Composite 1'],
  [0x06, 'Composite 2'],
  [0x07, 'S-Video 1'],
  [0x08, 'S-Video 2'],
  [0x09, 'Tuner 1'],
  [0x0c, 'Component 1'],
  [0x0f, 'DisplayPort 1'],
  [0x10, 'DisplayPort 2'],
  [0x11, 'HDMI 1'],
  [0x12, 'HDMI 2'],
  // Not in the spec, but what several vendors use for USB-C / Thunderbolt.
  [0x1b, 'USB-C'],
  [0x1c, 'USB-C 2'],
]);

export function inputLabel(code: number): string {
  return INPUT_LABELS.get(code) ?? `Input 0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Pulls the input list out of a monitor's capabilities string.
 *
 * The string looks like:
 *   (prot(monitor)type(LCD)...vcp(02 04 ... 60(01 03 04 0F 10 11 12) 87 ...))
 *
 * Only the values inside `60(...)` are real inputs. Note this must not match a
 * bare `60` elsewhere in the vcp list, nor the `60` that could appear inside
 * another feature's value list.
 */
export function parseInputs(capabilities: string): MonitorInput[] {
  const values = extractFeatureValues(capabilities, '60');
  if (values === undefined) return [];

  const seen = new Set<number>();
  const inputs: MonitorInput[] = [];
  for (const token of values.trim().split(/\s+/)) {
    if (!/^[0-9a-f]{1,2}$/i.test(token)) continue;
    const code = parseInt(token, 16);
    if (!Number.isFinite(code) || seen.has(code)) continue;
    seen.add(code);
    inputs.push({ code, label: inputLabel(code) });
  }
  return inputs;
}

/**
 * Finds a feature's value list inside the `vcp(...)` block, tracking bracket
 * depth so only a code at the top level of that block counts.
 *
 * A plain regex for `60\(` is not enough: it also matches a `60(...)` nested
 * inside some other feature's value list, and the first match wins. Real
 * monitors do not nest that way today, but silently offering a made-up input
 * because of it would park a display on a dead source — which on a monitor whose
 * buttons are behind the panel is a genuinely irritating thing to fix.
 */
function extractFeatureValues(capabilities: string, code: string): string | undefined {
  const vcpAt = capabilities.toLowerCase().indexOf('vcp(');
  if (vcpAt < 0) return undefined;

  let depth = 0;
  let i = vcpAt + 3;
  let token = '';

  for (; i < capabilities.length; i++) {
    const ch = capabilities[i];

    if (ch === '(') {
      depth += 1;
      // depth 1 is the vcp list itself; a bracket opening there belongs to the
      // token just read, which is the feature code.
      if (depth === 2 && token.toLowerCase() === code.toLowerCase()) {
        const close = findClose(capabilities, i);
        return close < 0 ? undefined : capabilities.slice(i + 1, close);
      }
      token = '';
      continue;
    }

    if (ch === ')') {
      depth -= 1;
      token = '';
      if (depth === 0) return undefined; // end of the vcp block
      continue;
    }

    if (depth === 1) {
      token = /\s/.test(ch ?? '') ? '' : token + ch;
    }
  }
  return undefined;
}

function findClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

