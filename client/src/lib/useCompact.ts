import { useEffect, useState } from 'react';

/**
 * The same condition as the landscape rules in index.css.
 *
 * Kept in both places on purpose: CSS handles spacing, but a few things cannot be
 * done in a stylesheet at all — uPlot sizes its canvas in JavaScript, so shrinking
 * the container with CSS only clips the chart. Those need the component to know,
 * which means asking matchMedia the same question.
 */
export const COMPACT_QUERY = '(orientation: landscape) and (max-height: 700px) and (min-width: 500px)';

/** Three columns are only worth it once there is real width to divide. */
const WIDE_QUERY = '(min-width: 900px)';

/**
 * Subscribes to a media query.
 *
 * `addEventListener` on MediaQueryList is not present on older Android Chrome,
 * which carries only the deprecated `addListener`, so both are handled.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();

    if (list.addEventListener) {
      list.addEventListener('change', update);
      return () => list.removeEventListener('change', update);
    }
    list.addListener(update);
    return () => list.removeListener(update);
  }, [query]);

  return matches;
}

/**
 * True on a short, wide screen — a phone on its side.
 *
 * Used to trade detail for density: smaller charts, tighter artwork, and the
 * diagnostics card hidden, so everything fits without scrolling.
 */
export function useCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/**
 * How many columns the landscape layout uses.
 *
 * Driven from JavaScript rather than CSS because the columns are real elements.
 * Filling the screen means each column is a flex container of known height, and
 * CSS multi-column cannot express that — it balances to the content height and
 * leaves whatever is left over as empty space at the bottom, which is exactly
 * the problem this replaced.
 */
export function useColumnCount(): number {
  const compact = useCompact();
  const wide = useMediaQuery(WIDE_QUERY);
  if (!compact) return 1;
  return wide ? 3 : 2;
}
