/**
 * Wire protocol between the agent (PC) and the client (phone).
 *
 * Bump PROTOCOL_VERSION on any breaking change. The client compares the
 * version in the `hello` frame against its own and shows a "reload me"
 * banner on mismatch, which matters because the phone aggressively caches
 * the PWA shell.
 */
export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORT = 8765;

/** Interval the agent uses for its single broadcast timer. */
export const BROADCAST_INTERVAL_MS = 1000;

/** Number of stats samples retained by the agent and replayed on connect. */
export const HISTORY_LENGTH = 120;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface CpuStats {
  /** Total load across all cores, 0-100. */
  loadPct: number;
  /** Per-logical-core load, 0-100 each. */
  perCorePct: number[];
  /** Package temperature in Celsius, if the platform reports one. */
  tempC?: number;
  brand?: string;
  cores?: number;
}

export interface MemStats {
  usedBytes: number;
  totalBytes: number;
  /** Convenience: usedBytes / totalBytes * 100. */
  usedPct: number;
}

export interface DiskStats {
  readMBs: number;
  writeMBs: number;
}

export interface NetStats {
  /** Outbound megabytes per second. */
  upMBs: number;
  /** Inbound megabytes per second. */
  downMBs: number;
  iface?: string;
}

export interface GpuStats {
  name?: string;
  utilPct: number;
  memUsedMB: number;
  memTotalMB: number;
  tempC: number;
}

export interface Stats {
  cpu: CpuStats;
  mem: MemStats;
  disk: DiskStats;
  net: NetStats;
  /** Absent entirely when nvidia-smi is unavailable. Never null. */
  gpu?: GpuStats;
  /** Seconds since boot. */
  uptimeSec: number;
}

/**
 * One point in the rolling history. Deliberately flat and short-keyed: 120 of
 * these get serialised on every connect, and the phone charts want columnar
 * numbers, not nested objects.
 */
export interface StatsSample {
  /** Epoch milliseconds. */
  t: number;
  cpu: number;
  mem: number;
  diskR: number;
  diskW: number;
  netUp: number;
  netDown: number;
  gpu?: number;
  gpuMem?: number;
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export interface AudioSession {
  /**
   * Identity used to target commands, formatted `<process>:<pid>`.
   *
   * The process name is carried alongside the pid on purpose: Windows recycles
   * pids, and a slider write can arrive after the app it targeted has exited. The
   * agent re-checks the name before applying, so a stale write is dropped rather
   * than silently muting whatever inherited the pid.
   */
  id: string;
  /** Executable name, e.g. "chrome". */
  process: string;
  /** Friendly name for the UI, e.g. "Google Chrome". */
  name: string;
  /** 0-100. */
  volume: number;
  muted: boolean;
  pid?: number;
  /**
   * False when the app holds a session but is not currently rendering audio —
   * a paused Chrome tab, for instance. Those stay listed so they can be ducked
   * before playback starts, but the UI dims them.
   */
  active?: boolean;
}

export interface AudioDevice {
  id: string;
  /** Endpoint name, e.g. "Speakers/Headphones" or "VX3276-FHD". */
  name: string;
  /** Adapter behind it, which disambiguates two endpoints with the same name. */
  adapter: string;
  isDefault: boolean;
}

export interface VolumeState {
  /** System master volume, 0-100. */
  master: number;
  muted: boolean;
  /**
   * Active playback devices. Exactly one is the default at a time — Windows
   * routes a stream to a single endpoint and offers no way to fan it out.
   */
  outputs?: AudioDevice[];
  /** Per-app sessions, one row per process. */
  sessions: AudioSession[];
  /**
   * Default recording device. Absent when the machine has no microphone, which
   * is ordinary rather than an error.
   */
  mic?: {
    muted: boolean;
    volume: number;
    /**
     * Recent input levels, 0-100, oldest first. Sampled far faster than the 1 Hz
     * broadcast and sent as a batch, because a meter that updates once a second
     * is not a meter — it is a random number.
     */
    levels: number[];
  };
  /**
   * Set when the audio host could not be started at all (no default playback
   * device, PowerShell blocked). The UI disables the controls and shows `reason`.
   */
  unavailable?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type PlaybackStatus = 'playing' | 'paused' | 'stopped' | 'unknown';

/**
 * Which mechanism is driving media control.
 * - `keys`  Milestone A: blind media-key emulation. No metadata, no seek.
 * - `smtc`  Milestone B: the C# helper is alive and reporting real session data.
 */
export type MediaBackend = 'keys' | 'smtc';

export interface MediaState {
  backend: MediaBackend;
  status: PlaybackStatus;
  /** Owning app, e.g. "Spotify" / "Chrome". Only populated by the smtc backend. */
  sourceApp?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** Current position in seconds. */
  positionSec?: number;
  /** Track length in seconds. */
  durationSec?: number;
  /** Whether the current session accepts a seek command. */
  canSeek?: boolean;
  canNext?: boolean;
  canPrevious?: boolean;
  /**
   * Cache-busting id for the artwork. The thumbnail itself is fetched over HTTP
   * from /api/media/thumbnail rather than inlined, so a 100 KB base64 blob does
   * not ride along on every 1 Hz broadcast.
   */
  thumbnailId?: string;
}

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

export interface MonitorInput {
  /** VCP value for input source (code 0x60), e.g. 0x0F for DisplayPort 1. */
  code: number;
  label: string;
}

export interface MonitorInfo {
  /** Stable within a session: the display device name plus a physical index. */
  id: string;
  name: string;
  primary: boolean;
  /** Absent when the monitor will not report it. */
  currentInput?: number;
  /**
   * Inputs the monitor advertises in its capabilities string. Empty when it
   * publishes none, in which case the UI offers no switching rather than
   * guessing at values the display may not have.
   */
  inputs: MonitorInput[];
  /**
   * Brightness as a percentage. Absent when the monitor does not expose the
   * luminance control, which some do not even while offering input switching.
   */
  brightness?: number;
  /** Why this display cannot be controlled, when it cannot. */
  unavailable?: string;
}

export interface MonitorState {
  monitors: MonitorInfo[];
  /** True while the slow one-off capabilities scan is still running. */
  scanning: boolean;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemState {
  /**
   * What the PC currently has on its clipboard, when it is text.
   *
   * Mirrored to the phone so a copy on either side is available on the other.
   * Truncated: this is for links and snippets, not for moving documents.
   */
  clipboard?: string;
  /** Bumped whenever the clipboard text changes, so the phone can react once. */
  clipboardAt?: number;
  /**
   * Epoch ms at which a scheduled sleep will fire, when one is armed. The phone
   * renders the countdown from this rather than being sent a ticking number, so
   * a dropped frame cannot make the clock jump.
   */
  sleepAt?: number;
  /** False when clipboard and link sending are unavailable. */
  canSend: boolean;
}

// ---------------------------------------------------------------------------
// Aggregate state
// ---------------------------------------------------------------------------

export interface HostInfo {
  hostname: string;
  platform: string;
  osRelease?: string;
  agentVersion: string;
}

export interface AgentState {
  /** Epoch ms this snapshot was produced. */
  t: number;
  stats: Stats | null;
  volume: VolumeState | null;
  media: MediaState | null;
  monitors: MonitorState | null;
  system: SystemState | null;
}

// ---------------------------------------------------------------------------
// Commands (client -> agent)
// ---------------------------------------------------------------------------

export type Command =
  | { kind: 'volume.setMaster'; volume: number }
  | { kind: 'volume.setMuted'; muted: boolean }
  | { kind: 'volume.setApp'; id: string; volume: number }
  | { kind: 'volume.setAppMuted'; id: string; muted: boolean }
  | { kind: 'media.playPause' }
  | { kind: 'media.play' }
  | { kind: 'media.pause' }
  | { kind: 'media.next' }
  | { kind: 'media.previous' }
  | { kind: 'media.stop' }
  | { kind: 'media.seek'; positionSec: number }
  | { kind: 'monitor.setInput'; id: string; input: number }
  | { kind: 'monitor.setBrightness'; id: string; brightness: number }
  | { kind: 'volume.setMicMuted'; muted: boolean }
  | { kind: 'volume.setOutputDevice'; id: string }
  | { kind: 'system.sleepTimer'; minutes: number }
  | { kind: 'system.sendText'; text: string }
  | { kind: 'system.openUrl'; url: string }
  | { kind: 'system.lock' }
  | { kind: 'system.sleep' }
  | { kind: 'system.displayOff' }
  | { kind: 'system.shutdown'; confirm: string }
  | { kind: 'system.restart'; confirm: string };

export type CommandKind = Command['kind'];

/**
 * Token the client must echo back in `system.shutdown` / `system.restart`.
 * The agent issues it from /api/confirm-token with a short TTL, so a stray or
 * replayed frame cannot power the machine off.
 */
export const CONFIRM_TOKEN_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** Recursive partial, used for delta broadcasts. */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface HelloFrame {
  type: 'hello';
  protocol: number;
  host: HostInfo;
  /** Full state at the moment of connect. */
  state: AgentState;
  /** Replay of the rolling history so charts render populated. */
  history: StatsSample[];
  /** Server clock, so the phone can correct for skew. */
  serverTime: number;
  /** Broadcast cadence, so the client can size its chart window. */
  intervalMs: number;
}

export interface StateFrame {
  type: 'state';
  state: AgentState;
  /** Newest sample, appended to the client's history ring. */
  sample?: StatsSample;
}

export interface PatchFrame {
  type: 'patch';
  /** Delta against the last state the server sent this connection. */
  patch: DeepPartial<AgentState>;
  sample?: StatsSample;
}

export interface AckFrame {
  type: 'ack';
  /** Correlates with the `id` on the CommandFrame. */
  id: string;
  ok: boolean;
  error?: string;
}

export interface ErrorFrame {
  type: 'error';
  code: 'unauthorized' | 'rate_limited' | 'bad_request' | 'internal';
  message: string;
}

export interface PongFrame {
  type: 'pong';
  /** Echo of the client's ping timestamp, for RTT measurement. */
  t: number;
}

export type ServerFrame =
  | HelloFrame
  | StateFrame
  | PatchFrame
  | AckFrame
  | ErrorFrame
  | PongFrame;

export interface CommandFrame {
  type: 'command';
  /** Client-generated correlation id. */
  id: string;
  command: Command;
}

export interface PingFrame {
  type: 'ping';
  t: number;
}

export type ClientFrame = CommandFrame | PingFrame;

// ---------------------------------------------------------------------------
// HTTP API shapes
// ---------------------------------------------------------------------------

export interface PairRequest {
  pin: string;
  /** Free-text label so the agent's console log says which device paired. */
  deviceName?: string;
}

export interface PairResponse {
  token: string;
  host: HostInfo;
  protocol: number;
}

export interface PairErrorResponse {
  error: string;
  /** Milliseconds the client should wait before retrying, when rate limited. */
  retryAfterMs?: number;
}
