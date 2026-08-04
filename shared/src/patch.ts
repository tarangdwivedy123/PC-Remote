import type { DeepPartial } from './protocol.js';

/**
 * Marker written into a patch when a key went away.
 *
 * `undefined` cannot survive JSON.stringify, so a removal has to be spelled out
 * explicitly — otherwise a GPU that disappears (nvidia-smi unplugged or crashed)
 * would linger in the client's state forever.
 *
 * A single-key object rather than a magic string. An earlier version used a
 * string prefixed with a NUL to guarantee it could never collide with a real
 * value, which worked but rendered in editors as an ordinary space: the sentinel
 * *looked* like `' __del'`, so any hand-written comparison against that silently
 * failed to match with no visible reason why. This form carries the same
 * collision guarantee — no state field is an object whose only key is
 * `__pcrDeleted` — while staying legible and greppable.
 */
export const DELETED_MARKER_KEY = '__pcrDeleted';

export const DELETED: { readonly __pcrDeleted: true } = { __pcrDeleted: true };

/**
 * Structural check rather than identity: the marker is serialised and reparsed on
 * the way to the client, so `=== DELETED` would never match on the receiving end.
 */
export function isDeleted(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    value[DELETED_MARKER_KEY] === true &&
    Object.keys(value).length === 1
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Shallow-compare arrays element-wise. Arrays in this protocol are either
 * numbers (per-core load) or small records (audio sessions), and
 * they are always replaced wholesale rather than index-patched — index-level
 * diffs on a reordering list produce patches larger than the list itself.
 */
function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!deepEqual(a[i], b[i])) return false;
  }
  return true;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Produce the minimal patch that turns `prev` into `next`.
 * Returns `undefined` when they are already equal, which is the common case for
 * volume and media between two 1 Hz ticks and is what keeps idle traffic near
 * zero.
 */
export function computePatch<T>(prev: T, next: T): DeepPartial<T> | undefined {
  if (deepEqual(prev, next)) return undefined;
  if (!isPlainObject(prev) || !isPlainObject(next)) {
    return next as DeepPartial<T>;
  }

  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(next)) {
    const a = (prev as Record<string, unknown>)[key];
    const b = (next as Record<string, unknown>)[key];
    if (deepEqual(a, b)) continue;

    if (isPlainObject(a) && isPlainObject(b)) {
      const sub = computePatch(a, b);
      if (sub !== undefined) patch[key] = sub;
    } else {
      // Arrays, primitives, and object<->primitive transitions replace wholesale.
      patch[key] = b === undefined ? DELETED : b;
    }
  }

  // Keys present in prev but gone from next.
  for (const key of Object.keys(prev)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      patch[key] = DELETED;
    }
  }

  return patch as DeepPartial<T>;
}

/**
 * Apply a patch produced by `computePatch`, returning a new object. Never
 * mutates its input: the client keeps the previous state object around for
 * React's identity checks, so in-place mutation would silently skip renders.
 */
export function applyPatch<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };

  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, unknown>)[key];
    if (isDeleted(value)) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = applyPatch(current, value as DeepPartial<Record<string, unknown>>);
    } else {
      out[key] = value;
    }
  }

  return out as T;
}
