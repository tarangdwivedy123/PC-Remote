import { formatRelativeTime } from '@pcr/shared';

import { useColumnCount } from '../lib/useCompact';
import { useConnection, useConnectionValue } from '../lib/useConnection';
import { Section } from './Section';
import { MonitorsSection } from './MonitorsSection';
import { NowPlayingSection } from './NowPlayingSection';
import { StatsSection } from './StatsSection';
import { SystemSection } from './SystemSection';
import { VolumeSection } from './VolumeSection';
import { StatusBar } from './StatusBar';

export function Dashboard(): JSX.Element {
  const columns = useColumnCount();
  const hasMonitors = useConnectionValue((s) =>
    (s.state?.monitors?.monitors ?? []).some((m) => m.inputs.length > 0),
  );

  if (columns === 1) {
    return (
      <div className="min-h-screen">
        <StatusBar />
        {/*
          space-y-* (margins) rather than `flex gap-*`: flexbox gap is a Chrome 84
          feature and this has to work on Chrome 70, where it silently collapses to
          no spacing at all.
        */}
        <main className="dashboard mx-auto max-w-md space-y-3 px-3 py-3 pb-safe">
          <NowPlayingSection />
          <VolumeSection />
          <MonitorsSection />
          <SystemSection />
          {/* Stats last: it is the thing you glance at, not the thing you reach
              for, so the controls get the top of the screen and the thumb. */}
          <StatsSection />
          <LinkDiagnostics />
        </main>
      </div>
    );
  }

  /**
   * Landscape: real columns, sized to the viewport.
   *
   * The cards are distributed by hand rather than flowed. CSS multi-column
   * balances to the height of the content and stops, which left a large empty
   * band under everything; a flex row of full-height columns can actually be
   * told to fill the screen, and the cards inside share the slack.
   *
   * Monitors is checked rather than rendered blind, because the section returns
   * nothing when no display can be controlled — and an empty element would still
   * take a whole column's width.
   */
  const cards: JSX.Element[] = [
    <NowPlayingSection key="now" />,
    <VolumeSection key="vol" />,
    ...(hasMonitors ? [<MonitorsSection key="mon" />] : []),
    <SystemSection key="sys" />,
    <StatsSection key="stats" />,
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <StatusBar />
      <main className="dashboard-cols flex min-h-0 flex-1 px-1 pb-1">
        {distribute(cards, columns).map((column, index) => (
          <div className="dashboard-col" key={index}>
            {column}
          </div>
        ))}
      </main>
    </div>
  );
}

/**
 * Splits the cards across columns, keeping their order.
 *
 * Weighted rather than round-robin: the cards differ enormously in height — a
 * monitor with seven inputs is several times a stats card — so dealing them out
 * evenly by count produces one overflowing column beside a half-empty one. The
 * weights are rough, and only need to be right relative to each other.
 */
const CARD_WEIGHT: Record<string, number> = {
  now: 3,
  vol: 3,
  mon: 4,
  sys: 3,
  stats: 3,
};

export function distribute(cards: JSX.Element[], columns: number): JSX.Element[][] {
  const out: JSX.Element[][] = Array.from({ length: columns }, () => []);
  const load = new Array<number>(columns).fill(0);

  for (const card of cards) {
    const weight = CARD_WEIGHT[String(card.key)] ?? 3;
    // Left-most lightest column, so ties keep the original reading order.
    let target = 0;
    for (let i = 1; i < columns; i++) {
      if (load[i]! < load[target]!) target = i;
    }
    out[target]!.push(card);
    load[target] = load[target]! + weight;
  }

  return out;
}

/**
 * Proof-of-life panel for the pairing and transport work. It shows that frames
 * are arriving on the 1 Hz timer, which is otherwise invisible until the stats
 * charts exist. Worth keeping past milestone 1 — it is the first place to look
 * when the phone says "connected" but nothing is moving.
 */
function LinkDiagnostics(): JSX.Element {
  const { host, state, history, lastFrameAt, rttMs, status } = useConnection();

  const age = lastFrameAt === null ? null : Date.now() - lastFrameAt;

  return (
    <Section title="Link" meta={status}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <Row label="Agent" value={host ? `v${host.agentVersion}` : '—'} />
        <Row label="Host" value={host?.hostname ?? '—'} />
        <Row label="Round trip" value={rttMs === null ? '—' : `${rttMs} ms`} />
        <Row
          label="Last frame"
          value={age === null ? '—' : age < 2000 ? `${age} ms ago` : formatRelativeTime(lastFrameAt!)}
        />
        <Row label="History" value={`${history.length} samples`} />
        <Row
          label="Snapshot"
          value={state ? new Date(state.t).toLocaleTimeString() : '—'}
        />
      </dl>
    </Section>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="truncate text-right numeric">{value}</dd>
    </>
  );
}
