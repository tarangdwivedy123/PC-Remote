import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

import { themeColor } from '../lib/theme';

export interface SparkSeries {
  values: number[];
  /** A CSS variable name, e.g. `--chart-cpu`, resolved when the plot is built. */
  color: string;
  label: string;
}

interface SparklineProps {
  series: SparkSeries[];
  /**
   * Fixed upper bound for the y axis. Percentages pass 100 so the line does not
   * rescale every second; throughput passes undefined to auto-scale.
   */
  yMax?: number;
  /**
   * Floor for the auto-scaled ceiling. Without it, 20 KB/s of idle background
   * traffic fills the whole chart height and reads as saturation.
   */
  autoMinTop?: number;
  height?: number;
  ariaLabel: string;
}

const DEFAULT_HEIGHT = 30;

/**
 * A minimal uPlot line chart.
 *
 * uPlot rather than a React charting library because this repaints five charts a
 * second on a phone that may be a decade old — the React reconciler must not be
 * anywhere near the render path. The instance is created once and fed with
 * `setData`, so a data update touches a canvas and nothing else.
 *
 * Everything uPlot can draw is switched off: no axes, grid, legend, cursor, or
 * points. Those are the expensive parts, and a sparkline needs none of them.
 */
export function Sparkline({
  series,
  yMax,
  autoMinTop = 1,
  height = DEFAULT_HEIGHT,
  ariaLabel,
}: SparklineProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Read inside uPlot callbacks, which are registered once and would otherwise
  // capture the first render's props forever.
  const configRef = useRef({ yMax, autoMinTop });
  configRef.current = { yMax, autoMinTop };

  // Create the plot once. Series *identity* can change every second, so this
  // effect deliberately depends only on the shape (count and colours) — a new
  // instance per tick would be catastrophic for performance.
  const signature = series.map((s) => s.color).join('|');

  /**
   * Bumped when the theme changes, to force a rebuild.
   *
   * uPlot bakes the stroke colour into its canvas at creation, so unlike the
   * rest of the UI a chart cannot follow a CSS class change — the old colours
   * stay drawn until the plot is made again.
   */
  const [themeEpoch, setThemeEpoch] = useState(0);
  useEffect(() => {
    const onThemeChange = (): void => setThemeEpoch((n) => n + 1);
    window.addEventListener('pcr:themechange', onThemeChange);
    return () => window.removeEventListener('pcr:themechange', onThemeChange);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const width = container.clientWidth;
    // A zero width means the element is not laid out yet (a collapsed parent, or
    // a hidden section). uPlot throws on a zero-width canvas, so skip and let the
    // resize handler pick it up.
    if (width <= 0) return;

    const options: uPlot.Options = {
      width,
      height,
      // A couple of pixels top and bottom keeps a flat line at 0 or 100 from
      // being clipped in half by the canvas edge.
      padding: [2, 0, 2, 0],
      cursor: { show: false },
      legend: { show: false },
      axes: [{ show: false }, { show: false }],
      scales: {
        // Plain indices, not timestamps: uPlot's time scale does tick maths and
        // date formatting that a sparkline never displays.
        x: { time: false },
        y: {
          range: (_u, dataMin, dataMax) => {
            const { yMax: fixedMax, autoMinTop: floor } = configRef.current;
            if (fixedMax !== undefined) return [0, fixedMax];
            const peak = Number.isFinite(dataMax) ? dataMax : 0;
            const low = Number.isFinite(dataMin) ? Math.min(0, dataMin) : 0;
            // Headroom above the peak so the busiest point is not flush against
            // the top edge.
            return [low, Math.max(peak * 1.2, floor ?? 1)];
          },
        },
      },
      series: [
        {},
        ...series.map((s) => ({
          // Resolved here rather than stored: this runs on every rebuild, which
          // is exactly when the theme may have changed.
          stroke: themeColor(s.color, '#43ab9f'),
          width: 1.25,
          points: { show: false },
        })),
      ],
      // Sub-pixel alignment: smoother line on a high-DPI phone screen, and it
      // skips uPlot's rounding pass.
      pxAlign: false,
    };

    const data = buildData(series);
    const plot = new uPlot(options, data, container);
    plotRef.current = plot;

    return () => {
      plot.destroy();
      plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, height, themeEpoch]);

  // Feed new data without re-creating anything.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    plot.setData(buildData(series));
  }, [series]);

  /**
   * Resize on orientation change. A window listener rather than ResizeObserver:
   * the chart's width only ever changes when the viewport does, and this avoids
   * an observer per chart firing during scroll.
   */
  useEffect(() => {
    let frame = 0;
    const onResize = (): void => {
      // Coalesce the burst of resize events Chrome fires while rotating.
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const container = containerRef.current;
        const plot = plotRef.current;
        if (!container || !plot) return;
        const width = container.clientWidth;
        if (width > 0) plot.setSize({ width, height });
      });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [height]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

/**
 * uPlot wants columnar data: [xs, ys1, ys2, …]. All series are assumed to share
 * a sample count, which they do — they come from the same StatsSample array.
 */
function buildData(series: SparkSeries[]): uPlot.AlignedData {
  const length = series[0]?.values.length ?? 0;
  const xs = new Array<number>(length);
  for (let i = 0; i < length; i++) xs[i] = i;
  return [xs, ...series.map((s) => s.values)] as uPlot.AlignedData;
}
