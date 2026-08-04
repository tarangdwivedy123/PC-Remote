import { useCallback, useEffect, useState } from 'react';

/**
 * Vendor-prefixed fullscreen.
 *
 * The DOM typings declare `requestFullscreen` as always present, but on Chrome
 * ~70 for Android only the webkit-prefixed names exist — so the names are looked
 * up dynamically rather than declared, and picked by whichever is actually a
 * function at runtime.
 */
const REQUEST_NAMES = [
  'requestFullscreen',
  'webkitRequestFullscreen',
  'webkitRequestFullScreen',
  'mozRequestFullScreen',
  'msRequestFullscreen',
] as const;

const EXIT_NAMES = [
  'exitFullscreen',
  'webkitExitFullscreen',
  'webkitCancelFullScreen',
  'mozCancelFullScreen',
  'msExitFullscreen',
] as const;

const ELEMENT_NAMES = [
  'fullscreenElement',
  'webkitFullscreenElement',
  'mozFullScreenElement',
  'msFullscreenElement',
] as const;

const CHANGE_EVENTS = [
  'fullscreenchange',
  'webkitfullscreenchange',
  'mozfullscreenchange',
  'MSFullscreenChange',
] as const;

/** First property on `target` that is callable, already bound to it. */
function pickMethod(target: object, names: readonly string[]): (() => unknown) | undefined {
  const bag = target as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = bag[name];
    if (typeof value === 'function') return (value as () => unknown).bind(target);
  }
  return undefined;
}

function currentFullscreenElement(): Element | null {
  const bag = document as unknown as Record<string, unknown>;
  for (const name of ELEMENT_NAMES) {
    const value = bag[name];
    if (value) return value as Element;
  }
  return null;
}

function canGoFullscreen(): boolean {
  return pickMethod(document.documentElement, REQUEST_NAMES) !== undefined;
}

/**
 * Hides the browser's own chrome without needing the app installed.
 *
 * "Add to Home screen" gives a standalone launcher, but that only helps once it
 * has been installed and launched from the home screen. This works in an
 * ordinary tab, immediately, which is what you want when the phone is already
 * propped up showing the dashboard.
 *
 * The request must happen inside a user gesture, so this is a button rather than
 * something applied automatically on load.
 */
export function FullscreenButton(): JSX.Element | null {
  const [active, setActive] = useState(false);
  const [supported] = useState(canGoFullscreen);

  // The user can leave fullscreen with the system back gesture, which fires no
  // click — so the button tracks the document rather than its own state.
  useEffect(() => {
    const sync = (): void => setActive(currentFullscreenElement() !== null);
    sync();
    for (const event of CHANGE_EVENTS) document.addEventListener(event, sync);
    return () => {
      for (const event of CHANGE_EVENTS) document.removeEventListener(event, sync);
    };
  }, []);

  const toggle = useCallback(() => {
    if (currentFullscreenElement()) {
      // Bound by pickMethod: calling these detached throws "Illegal invocation".
      pickMethod(document, EXIT_NAMES)?.();
      return;
    }
    try {
      const result = pickMethod(document.documentElement, REQUEST_NAMES)?.();
      // Older implementations return undefined rather than a promise.
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Denied, typically because the gesture was not recognised. The button
      // stays as it was and a second tap usually works.
    }
  }, []);

  // Nothing to offer on a browser without the API — most likely already running
  // as an installed app, where there is no chrome to hide anyway.
  if (!supported) return null;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={active ? 'Leave full screen' : 'Full screen'}
      aria-pressed={active}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md active:bg-ink-700"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={active ? 'var(--accent-bright)' : 'var(--fg-faint)'}
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {active ? (
          <>
            <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
          </>
        ) : (
          <>
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </>
        )}
      </svg>
    </button>
  );
}
