import { useCallback, useEffect, useRef, useState } from 'react';

interface SliderProps {
  /** Authoritative value from the agent, 0-100. */
  value: number;
  /** Called at most every `throttleMs` while dragging, and once on release. */
  onChange: (value: number) => void;
  disabled?: boolean;
  ariaLabel: string;
  accent?: string;
  throttleMs?: number;
}

/**
 * How long after releasing the thumb the local value keeps winning over the
 * agent's. The agent echoes an optimistic value within ~100ms, but a poll that
 * was already in flight can land just after release carrying the old reading.
 * Without this grace period the thumb visibly snaps back and then forward again.
 */
const SETTLE_MS = 700;

const DEFAULT_THROTTLE_MS = 100;

/**
 * Touch-friendly range input.
 *
 * The value is "controlled by the agent except while the user is touching it".
 * Dragging must never be interrupted by an incoming state broadcast, which
 * arrives every second and would otherwise yank the thumb back mid-gesture.
 */
export function Slider({
  value,
  onChange,
  disabled = false,
  ariaLabel,
  accent = '#43ab9f',
  throttleMs = DEFAULT_THROTTLE_MS,
}: SliderProps): JSX.Element {
  const [local, setLocal] = useState(value);
  const interacting = useRef(false);
  const settleUntil = useRef(0);

  const lastSent = useRef(0);
  const trailing = useRef<number | undefined>(undefined);
  const trailingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Adopt the agent's value unless the user owns the control right now.
  useEffect(() => {
    if (interacting.current) return;
    if (Date.now() < settleUntil.current) return;
    setLocal(value);
  }, [value]);

  const flushTrailing = useCallback(() => {
    trailingTimer.current = undefined;
    const pending = trailing.current;
    if (pending === undefined) return;
    trailing.current = undefined;
    lastSent.current = Date.now();
    onChange(pending);
  }, [onChange]);

  /**
   * Leading-edge throttle with a guaranteed trailing call. The trailing call is
   * the important half: without it the last position of a fast drag is dropped
   * and the volume ends up wherever the final throttled sample happened to fall.
   */
  const send = useCallback(
    (next: number) => {
      const now = Date.now();
      const elapsed = now - lastSent.current;
      if (elapsed >= throttleMs) {
        lastSent.current = now;
        onChange(next);
        return;
      }
      trailing.current = next;
      if (trailingTimer.current === undefined) {
        trailingTimer.current = setTimeout(flushTrailing, throttleMs - elapsed);
      }
    },
    [flushTrailing, onChange, throttleMs],
  );

  useEffect(
    () => () => {
      if (trailingTimer.current !== undefined) clearTimeout(trailingTimer.current);
    },
    [],
  );

  const handleInput = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const next = Number(event.target.value);
    setLocal(next);
    send(next);
  };

  const begin = (): void => {
    interacting.current = true;
  };

  const end = (): void => {
    if (!interacting.current) return;
    interacting.current = false;
    settleUntil.current = Date.now() + SETTLE_MS;
    // Make sure the released position is what the agent ends up with, even if the
    // throttle would otherwise have swallowed it.
    if (trailingTimer.current !== undefined) {
      clearTimeout(trailingTimer.current);
      trailingTimer.current = undefined;
    }
    trailing.current = undefined;
    lastSent.current = Date.now();
    onChange(local);
  };

  return (
    <input
      type="range"
      min={0}
      max={100}
      step={1}
      value={local}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={handleInput}
      // Both families: Chrome 70 on an old Android fires touch events, and
      // pointer events are not reliably present.
      onTouchStart={begin}
      onTouchEnd={end}
      onTouchCancel={end}
      onMouseDown={begin}
      onMouseUp={end}
      // A drag released outside the element still has to commit.
      onBlur={end}
      className="pcr-slider"
      style={
        {
          // Consumed by the CSS to paint the filled portion of the track.
          '--pcr-slider-accent': disabled ? '#3a3a3a' : accent,
          '--pcr-slider-pct': `${local}%`,
        } as React.CSSProperties
      }
    />
  );
}
