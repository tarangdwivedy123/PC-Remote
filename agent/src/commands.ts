import { z } from 'zod';

import type { Command, CommandKind } from '@pcr/shared';

import { createLogger } from './log.js';

const log = createLogger('commands');

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const volumeLevel = z.number().finite().min(0).max(100);
/** Session ids are agent-minted, so this only has to reject absurd input. */
const sessionId = z.string().min(1).max(200);


export const CommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('volume.setMaster'), volume: volumeLevel }),
  z.object({ kind: z.literal('volume.setMuted'), muted: z.boolean() }),
  z.object({ kind: z.literal('volume.setApp'), id: sessionId, volume: volumeLevel }),
  z.object({ kind: z.literal('volume.setAppMuted'), id: sessionId, muted: z.boolean() }),
  z.object({ kind: z.literal('media.playPause') }),
  z.object({ kind: z.literal('media.play') }),
  z.object({ kind: z.literal('media.pause') }),
  z.object({ kind: z.literal('media.next') }),
  z.object({ kind: z.literal('media.previous') }),
  z.object({ kind: z.literal('media.stop') }),
  z.object({ kind: z.literal('media.seek'), positionSec: z.number().finite().min(0).max(86_400) }),
  z.object({
    kind: z.literal('monitor.setInput'),
    id: z.string().min(1).max(200),
    // One byte: VCP values are 0-255, and anything else is not an input source.
    input: z.number().int().min(0).max(255),
  }),
  z.object({
    kind: z.literal('monitor.setBrightness'),
    id: z.string().min(1).max(200),
    brightness: z.number().int().min(0).max(100),
  }),
  z.object({ kind: z.literal('volume.setMicMuted'), muted: z.boolean() }),
  z.object({ kind: z.literal('volume.setOutputDevice'), id: z.string().min(1).max(400) }),
  // 0 cancels. The ceiling is 12 hours: beyond that it is a scheduled task, not
  // a sleep timer.
  z.object({ kind: z.literal('system.sleepTimer'), minutes: z.number().int().min(0).max(720) }),
  z.object({ kind: z.literal('system.sendText'), text: z.string().min(1).max(10_000) }),
  z.object({
    kind: z.literal('system.openUrl'),
    url: z
      .string()
      .min(1)
      .max(2000)
      /**
       * http(s) only, and checked again in the host before ShellExecute. This is
       * the one call in the project that can start a process, so a file:// or a
       * UNC path reaching it would turn a dashboard button into "run anything".
       */
      .refine((u) => /^https?:\/\//i.test(u), { message: 'only http and https links can be opened' })
      .refine((u) => !/[\u0000-\u001f]/.test(u), { message: 'the link contains control characters' }),
  }),
  z.object({ kind: z.literal('system.lock') }),
  z.object({ kind: z.literal('system.sleep') }),
  z.object({ kind: z.literal('system.displayOff') }),
  z.object({ kind: z.literal('system.shutdown'), confirm: z.string().min(8).max(200) }),
  z.object({ kind: z.literal('system.restart'), confirm: z.string().min(8).max(200) }),
]);

export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('command'),
    id: z.string().min(1).max(64),
    command: CommandSchema,
  }),
  z.object({ type: z.literal('ping'), t: z.number().finite() }),
]);

/**
 * Compile-time guarantee that the zod schema and the hand-written union in
 * @pcr/shared describe the same shape. `shared` deliberately has no runtime
 * dependencies so it cannot host the zod schema itself; this assertion is what
 * keeps the two from drifting apart silently.
 */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const _commandSchemaMatchesSharedType: Equals<z.infer<typeof CommandSchema>, Command> = true;
void _commandSchemaMatchesSharedType;

// ---------------------------------------------------------------------------
// Cost table for the per-connection rate limiter
// ---------------------------------------------------------------------------

/**
 * Slider drags arrive in bursts and are cheap to service, so they cost one
 * token. Anything that spawns a process or changes power state costs more, both
 * to bound process churn and to make an accidental repeat physically slower.
 */
const COMMAND_COST: Partial<Record<CommandKind, number>> = {
  'volume.setMaster': 1,
  'volume.setApp': 1,
  'media.seek': 1,
  // Switching an input is disruptive and slow (a DDC round trip plus a settle
  // delay), so it is priced well above a slider drag.
  'monitor.setInput': 10,
  // A slider drag, so cheap like the volume ones.
  'monitor.setBrightness': 1,
  'volume.setMicMuted': 2,
  // Switching the whole system's output is disruptive; price it accordingly.
  'volume.setOutputDevice': 10,
  'system.sleepTimer': 5,
  'system.sendText': 5,
  // Opens a window on the PC, so priced to make repeat-firing slow.
  'system.openUrl': 10,
  'system.lock': 5,
  'system.sleep': 10,
  'system.displayOff': 5,
  'system.shutdown': 20,
  'system.restart': 20,
};

export function commandCost(kind: CommandKind): number {
  return COMMAND_COST[kind] ?? 2;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface CommandContext {
  /** Label of the paired device that sent this, for the audit log. */
  device: string;
  remoteAddress: string;
}

/** Thrown by handlers to send a specific message back in the ack frame. */
export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

type Handler<K extends CommandKind> = (
  command: Extract<Command, { kind: K }>,
  context: CommandContext,
) => void | Promise<void>;

/** Storage type for the map. See the cast in `register` for why it is widened. */
type AnyHandler = (command: Command, context: CommandContext) => void | Promise<void>;

export class CommandRouter {
  #handlers = new Map<CommandKind, AnyHandler>();

  register<K extends CommandKind>(kind: K, handler: Handler<K>): void {
    if (this.#handlers.has(kind)) {
      log.warn(`handler for ${kind} was replaced`);
    }
    // Widening a handler that accepts one variant into one that accepts the
    // whole union is unsound in general, so TypeScript rejects it outright. It
    // is sound *here* because the map is keyed by `kind` and `dispatch` only
    // ever invokes a handler with the command whose kind matched its key.
    this.#handlers.set(kind, handler as unknown as AnyHandler);
  }

  registered(): CommandKind[] {
    return [...this.#handlers.keys()];
  }

  async dispatch(command: Command, context: CommandContext): Promise<void> {
    const handler = this.#handlers.get(command.kind);
    if (!handler) {
      // Reachable whenever the phone has a newer client bundle cached than the
      // agent's feature set, e.g. right after a partial upgrade.
      throw new CommandError(`"${command.kind}" is not available on this agent yet`);
    }
    await handler(command, context);
  }
}
