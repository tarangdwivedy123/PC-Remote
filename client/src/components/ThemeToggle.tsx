import { useCallback, useEffect, useState } from 'react';

import { applyTheme, getStoredTheme, type Theme } from '../lib/theme';

/**
 * Dark/light switch, in the status bar next to the fullscreen control.
 *
 * The theme is applied to <html> as a class and the palette is CSS variables, so
 * switching is a single class change — nothing re-renders except the charts,
 * which have to be rebuilt because uPlot bakes colours into its canvas.
 */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    /**
     * uPlot draws to a canvas with colours captured when the plot was created,
     * so a class change alone leaves the old strokes on screen. This tells the
     * charts to rebuild; they listen for it rather than being wired through
     * props, which would mean threading the theme through every section.
     */
    window.dispatchEvent(new Event('pcr:themechange'));
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-pressed={theme === 'light'}
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md active:bg-ink-700"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--fg-faint)"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {theme === 'dark' ? (
          /* Moon: currently dark, tap for light. */
          <path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        )}
      </svg>
    </button>
  );
}
