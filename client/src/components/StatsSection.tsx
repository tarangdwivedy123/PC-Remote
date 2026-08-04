import { useMemo, type ReactNode } from 'react';

import { formatGiB, formatUptime, type Stats, type StatsSample } from '@pcr/shared';

import { useConnection } from '../lib/useConnection';
import { Section } from './Section';
import { Sparkline, type SparkSeries } from './Sparkline';

/**
 * Chart colours. All desaturated: these sit on an always-on AMOLED panel, so a
 * saturated line at full brightness is both harsh in a dark room and the kind of
 * static bright element worth avoiding.
 */
const COLOR = {
  cpu: '#43ab9f',
  mem: '#6b8fc4',
  primary: '#43ab9f',
  secondary: '#c2a24a',
  gpu: '#a06bc4',
} as const;

export function StatsSection(): JSX.Element {
  const { state, history } = useConnection();
  const stats = state?.stats ?? null;

  /**
   * Pull the columnar arrays out once per history change rather than per chart.
   * Each is a fresh array, which is what makes the Sparkline data effect fire —
   * so this must not run more often than the history actually changes.
   */
  const columns = useMemo(() => extractColumns(history), [history]);

  if (!stats) {
    return (
      <Section title="Stats">
        <p className="py-3 text-sm text-fg-faint">Waiting for the first sample…</p>
      </Section>
    );
  }

  const hasGpu = stats.gpu !== undefined;

  return (
    <Section title="Stats" meta={`up ${formatUptime(stats.uptimeSec)}`}>
      <div className="space-y-3">
        <Metric
          label="CPU"
          value={`${stats.cpu.loadPct.toFixed(0)}%`}
          detail={stats.cpu.brand}
          series={[{ values: columns.cpu, color: COLOR.cpu, label: 'CPU load' }]}
          yMax={100}
          ariaLabel={`CPU load ${stats.cpu.loadPct.toFixed(0)} percent`}
        />

        <PerCoreBars cores={stats.cpu.perCorePct} />

        <Metric
          label="RAM"
          value={`${stats.mem.usedPct.toFixed(0)}%`}
          detail={`${formatGiB(stats.mem.usedBytes)} / ${formatGiB(stats.mem.totalBytes)} GB`}
          series={[{ values: columns.mem, color: COLOR.mem, label: 'Memory used' }]}
          yMax={100}
          ariaLabel={`Memory ${stats.mem.usedPct.toFixed(0)} percent used`}
        />

        <Metric
          label="Disk"
          value={
            <TwoValues
              a={`${stats.disk.readMBs.toFixed(1)}`}
              aLabel="R"
              b={`${stats.disk.writeMBs.toFixed(1)}`}
              bLabel="W"
              unit="MB/s"
            />
          }
          series={[
            { values: columns.diskR, color: COLOR.primary, label: 'Disk read' },
            { values: columns.diskW, color: COLOR.secondary, label: 'Disk write' },
          ]}
          autoMinTop={5}
          ariaLabel={`Disk read ${stats.disk.readMBs.toFixed(1)}, write ${stats.disk.writeMBs.toFixed(1)} megabytes per second`}
        />

        <Metric
          label="Network"
          value={
            <TwoValues
              a={formatRate(stats.net.downMBs)}
              aLabel="↓"
              b={formatRate(stats.net.upMBs)}
              bLabel="↑"
              unit="MB/s"
            />
          }
          series={[
            { values: columns.netDown, color: COLOR.primary, label: 'Download' },
            { values: columns.netUp, color: COLOR.secondary, label: 'Upload' },
          ]}
          autoMinTop={1}
          ariaLabel={`Network down ${formatRate(stats.net.downMBs)}, up ${formatRate(stats.net.upMBs)} megabytes per second`}
        />

        {/*
          Rendered only when the agent actually sent a gpu field. It omits the key
          entirely when nvidia-smi is unavailable, so this is absence rather than
          a zeroed-out row — an integrated-graphics machine shows no GPU section
          at all instead of a misleading 0%.
        */}
        {hasGpu && stats.gpu ? (
          <Metric
            label="GPU"
            value={`${stats.gpu.utilPct.toFixed(0)}%`}
            detail={gpuDetail(stats.gpu)}
            series={[{ values: columns.gpu, color: COLOR.gpu, label: 'GPU load' }]}
            yMax={100}
            ariaLabel={`GPU ${stats.gpu.utilPct.toFixed(0)} percent`}
          />
        ) : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------

interface MetricProps {
  label: string;
  value: ReactNode;
  detail?: string;
  series: SparkSeries[];
  yMax?: number;
  autoMinTop?: number;
  ariaLabel: string;
}

function Metric({ label, value, detail, series, yMax, autoMinTop, ariaLabel }: MetricProps): JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-dim">{label}</span>
        <span className="text-stat numeric">{value}</span>
      </div>
      {detail ? <p className="truncate text-xs text-fg-faint">{detail}</p> : null}
      <div className="mt-1">
        <Sparkline series={series} yMax={yMax} autoMinTop={autoMinTop} ariaLabel={ariaLabel} />
      </div>
    </div>
  );
}

/** Two readouts sharing one unit, e.g. disk read and write. */
function TwoValues({
  a,
  aLabel,
  b,
  bLabel,
  unit,
}: {
  a: string;
  aLabel: string;
  b: string;
  bLabel: string;
  unit: string;
}): JSX.Element {
  return (
    <span>
      <span className="text-fg-faint">{aLabel}</span>{' '}
      <span style={{ color: `var(${COLOR.primary})` }}>{a}</span>
      <span className="mx-1 text-fg-faint">·</span>
      <span className="text-fg-faint">{bLabel}</span>{' '}
      <span style={{ color: `var(${COLOR.secondary})` }}>{b}</span>
      <span className="ml-1 text-xs text-fg-faint">{unit}</span>
    </span>
  );
}

/**
 * Per-core load as vertical bars. Vertical rather than a labelled list because it
 * has to stay one compact row whether the CPU has 4 cores or 32 — a list would
 * grow the card past a phone screen on a many-core machine.
 *
 * Grid, not flex: `gap` on a flex container is a Chrome 84 feature and collapses
 * silently on the target device. Grid gap has worked since Chrome 57.
 */
function PerCoreBars({ cores }: { cores: number[] }): JSX.Element | null {
  if (cores.length === 0) return null;

  return (
    <div>
      <div
        className="grid items-end gap-px"
        style={{ gridTemplateColumns: `repeat(${cores.length}, 1fr)`, height: 20 }}
        role="img"
        aria-label={`Per-core load: ${cores.map((c) => `${c.toFixed(0)}%`).join(', ')}`}
      >
        {cores.map((load, index) => (
          <div key={index} className="relative h-full bg-ink-700">
            <div
              className="absolute bottom-0 left-0 w-full"
              style={{
                // Floor of 2% so an idle core still shows a visible sliver and
                // the row does not look broken.
                height: `${Math.max(2, Math.min(100, load))}%`,
                backgroundColor: `var(${COLOR.cpu})`,
                // Dim the quiet cores so the busy ones stand out at a glance.
                opacity: 0.35 + (Math.min(100, load) / 100) * 0.65,
              }}
            />
          </div>
        ))}
      </div>
      <p className="mt-1 text-xs text-fg-faint">{cores.length} logical cores</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Columns {
  cpu: number[];
  mem: number[];
  diskR: number[];
  diskW: number[];
  netUp: number[];
  netDown: number[];
  gpu: number[];
}

/**
 * Converts the sample array into the per-series columns uPlot wants. One pass
 * over the history rather than one pass per chart.
 */
function extractColumns(history: StatsSample[]): Columns {
  const n = history.length;
  const columns: Columns = {
    cpu: new Array<number>(n),
    mem: new Array<number>(n),
    diskR: new Array<number>(n),
    diskW: new Array<number>(n),
    netUp: new Array<number>(n),
    netDown: new Array<number>(n),
    gpu: new Array<number>(n),
  };

  for (let i = 0; i < n; i++) {
    const sample = history[i];
    if (!sample) continue;
    columns.cpu[i] = sample.cpu;
    columns.mem[i] = sample.mem;
    columns.diskR[i] = sample.diskR;
    columns.diskW[i] = sample.diskW;
    columns.netUp[i] = sample.netUp;
    columns.netDown[i] = sample.netDown;
    // Samples recorded before a GPU appeared have no gpu field. 0 keeps the
    // series length aligned with the x axis, which uPlot requires.
    columns.gpu[i] = sample.gpu ?? 0;
  }

  return columns;
}

/** Sub-100 KB/s reads better with more precision than 0.0. */
function formatRate(mbs: number): string {
  if (mbs >= 10) return mbs.toFixed(0);
  if (mbs >= 1) return mbs.toFixed(1);
  return mbs.toFixed(2);
}

function gpuDetail(gpu: NonNullable<Stats['gpu']>): string {
  const parts: string[] = [];
  if (gpu.memTotalMB > 0) {
    parts.push(`${(gpu.memUsedMB / 1024).toFixed(1)} / ${(gpu.memTotalMB / 1024).toFixed(1)} GB`);
  }
  // A card that does not report temperature sends 0; showing "0°C" would be a lie.
  if (gpu.tempC > 0) parts.push(`${gpu.tempC.toFixed(0)}°C`);
  if (gpu.name) parts.push(gpu.name);
  return parts.join(' · ');
}
