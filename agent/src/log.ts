/**
 * Tiny leveled logger. No dependency, and it degrades to plain text when stdout
 * is not a TTY — which is exactly the case when Task Scheduler runs the agent at
 * login and pipes output to a log file.
 */

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

const codes = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

type ColorName = keyof typeof codes;

export function color(name: ColorName, text: string): string {
  return useColor ? `${codes[name]}${text}${codes.reset}` : text;
}

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

let threshold: Level = (process.env['PCR_LOG_LEVEL'] as Level) ?? 'info';
if (!LEVELS.includes(threshold)) threshold = 'info';

function enabled(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(threshold);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const tags: Record<Level, string> = {
  debug: color('dim', 'debug'),
  info: color('cyan', ' info'),
  warn: color('yellow', ' warn'),
  error: color('red', 'error'),
};

function emit(level: Level, scope: string, args: unknown[]): void {
  if (!enabled(level)) return;
  const prefix = `${color('dim', timestamp())} ${tags[level]} ${color('dim', `[${scope}]`)}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(prefix, ...args);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export function setLogLevel(level: Level): void {
  if (LEVELS.includes(level)) threshold = level;
}

/** Writes straight to stdout with no prefix — for the startup banner and QR. */
export function raw(text: string): void {
  process.stdout.write(`${text}\n`);
}
