import type { ReactNode } from 'react';

interface SectionProps {
  title: string;
  /** Small right-aligned text in the header, e.g. a status or a count. */
  meta?: ReactNode;
  children: ReactNode;
  /** Removes the default body padding, for edge-to-edge lists and charts. */
  flush?: boolean;
  /**
   * A control in the header, e.g. a refresh button. Rendered after `meta` and
   * given its own touch target, so it does not crowd the title.
   */
  action?: ReactNode;
}

export function Section({ title, meta, children, flush, action }: SectionProps): JSX.Element {
  return (
    <section className="card">
      <header className="card-header">
        <h2 className="card-title">{title}</h2>
        {meta ? <div className="text-xs text-fg-faint numeric">{meta}</div> : null}
        {action ? <div className="-my-2 ml-1 shrink-0">{action}</div> : null}
      </header>
      <div className={flush ? 'pb-1' : 'px-4 pb-4'}>{children}</div>
    </section>
  );
}

/**
 * Stand-in for a section whose feature lands in a later milestone. Keeping the
 * real card in the layout from the start means the scroll order and spacing get
 * validated on the actual phone before the content exists.
 */
export function ComingSoon({ milestone, what }: { milestone: string; what: string }): JSX.Element {
  return (
    <div className="py-3">
      <p className="text-sm text-fg-faint">{what}</p>
      <p className="mt-1 text-xs text-fg-faint">Arrives in {milestone}.</p>
    </div>
  );
}
