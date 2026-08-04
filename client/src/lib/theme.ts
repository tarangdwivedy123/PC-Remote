export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'pcr.theme';

/**
 * Reads a themed colour for code that needs a literal string rather than a class
 * — uPlot takes colours as strings, and inline SVG strokes are set as props.
 *
 * Resolved from the document element so it follows the active theme, with a
 * fallback for the server-render pass in the verification suite, where there is
 * no real computed style.
 */
export function themeColor(name: string, fallback: string): string {
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name);
  return value.trim() || fallback;
}

export function getStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private mode, or storage disabled. Fall through to the default.
  }
  /**
   * Dark unless the device says otherwise. This is a dashboard that lives on an
   * always-on screen, so dark is the better default even where the OS is light —
   * but an explicit OS preference for light is worth honouring on first run.
   */
  try {
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch {
    // matchMedia missing on a very old browser.
  }
  return 'dark';
}

/**
 * Applies the theme to the document element.
 *
 * The class goes on <html> rather than <body> so the CSS variables are in scope
 * for everything, including the inline pre-paint styles in index.html.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.remove('theme-dark', 'theme-light');
  root.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');

  // Keep the browser UI (address bar, status bar) in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f7f9' : '#000000');

  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Not being able to remember it is not a reason to refuse to apply it.
  }
}
