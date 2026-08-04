import { useCallback, useState } from 'react';

import type { MonitorInfo } from '@pcr/shared';

import { connection } from '../lib/connection';
import { useConnectionValue } from '../lib/useConnection';
import { Section } from './Section';
import { Slider } from './Slider';

export function MonitorsSection(): JSX.Element | null {
  const monitors = useConnectionValue((s) => s.state?.monitors ?? null);
  const [note, setNote] = useState<string | null>(null);

  // Nothing to show on a machine with no DDC/CI-capable display, rather than an
  // empty card taking up space on a phone screen.
  if (!monitors) return null;

  // A display that offers only brightness is still worth showing.
  const switchable = monitors.monitors.filter(
    (m) => m.inputs.length > 0 || m.brightness !== undefined,
  );
  if (switchable.length === 0 && !monitors.scanning) return null;

  return (
    <Section title="Monitors" meta={monitors.scanning ? 'scanning…' : undefined}>
      {monitors.scanning && switchable.length === 0 ? (
        <p className="py-2 text-sm text-fg-faint">Asking your displays what inputs they have…</p>
      ) : null}

      {switchable.map((monitor) => (
        <MonitorRow key={monitor.id} monitor={monitor} onNote={setNote} />
      ))}


      {note ? <p className="mt-1 text-xs text-warn-bright">{note}</p> : null}
    </Section>
  );
}

function MonitorRow({
  monitor,
  onNote,
}: {
  monitor: MonitorInfo;
  onNote: (note: string | null) => void;
}): JSX.Element {
  const [pending, setPending] = useState<number | null>(null);

  const select = useCallback(
    (code: number) => {
      if (code === monitor.currentInput) return;
      onNote(null);
      setPending(code);
      connection
        .send({ kind: 'monitor.setInput', id: monitor.id, input: code })
        .catch((err: Error) => onNote(`${monitor.name}: ${err.message}`))
        .then(() => setPending(null));
    },
    [monitor.id, monitor.name, monitor.currentInput, onNote],
  );

  return (
    <div className="border-t border-ink-700 py-2 first:border-t-0">
      <div className="flex items-baseline justify-between">
        <span className="truncate text-sm text-fg">{monitor.name}</span>
        {monitor.primary ? (
          <span className="ml-2 shrink-0 text-xs text-fg-faint">primary</span>
        ) : null}
      </div>

      {monitor.unavailable ? (
        <p className="mt-1 text-xs text-warn-bright">{monitor.unavailable}</p>
      ) : null}

      {/*
        Brightness, when the monitor exposes the luminance control. Some offer
        input switching but not this, so it is driven by the field's presence
        rather than assumed.
      */}
      {monitor.brightness !== undefined ? (
        <div className="mt-1 flex items-center">
          <span className="w-14 shrink-0 text-xs text-fg-faint">Bright</span>
          <span className="min-w-0 flex-1">
            <Slider
              value={monitor.brightness}
              onChange={(v) =>
                connection.sendNoAck({ kind: 'monitor.setBrightness', id: monitor.id, brightness: v })
              }
              ariaLabel={`${monitor.name} brightness`}
              accent="var(--warn-bright)"
              // A DDC write is far slower than a Core Audio one and the panel
              // visibly steps through values, so send less often than a volume drag.
              throttleMs={200}
            />
          </span>
          <span className="ml-2 w-9 shrink-0 text-right text-xs text-fg-faint numeric">
            {monitor.brightness}%
          </span>
        </div>
      ) : null}

      {/*
        A native select rather than a grid of buttons.

        Seven inputs was three rows of 48px buttons, which made this the tallest
        card on the screen by a wide margin. A select collapses that to one row
        and, on Android, opens the system picker — which is a better list than
        anything rendered here would be, and needs no styling to stay legible.
      */}
      {monitor.inputs.length > 0 ? (
        <div className="mt-1 flex items-center">
          <span className="w-14 shrink-0 text-xs text-fg-faint">Input</span>
          <select
            value={monitor.currentInput ?? ''}
            onChange={(e) => select(Number(e.target.value))}
            disabled={pending !== null}
            aria-label={`${monitor.name} input source`}
            className="h-12 min-w-0 flex-1 rounded-md border px-2 text-sm"
            style={{
              borderColor: 'var(--line-bright)',
              backgroundColor: 'var(--ink-900)',
              color: 'var(--fg)',
            }}
          >
            {/*
              The monitor can sit on an input it did not advertise, which would
              otherwise leave the select showing an unrelated entry as selected.
            */}
            {monitor.currentInput !== undefined &&
            !monitor.inputs.some((i) => i.code === monitor.currentInput) ? (
              <option value={monitor.currentInput}>
                {`Current (0x${monitor.currentInput.toString(16).toUpperCase()})`}
              </option>
            ) : null}
            {monitor.inputs.map((input) => (
              <option key={input.code} value={input.code}>
                {input.label}
              </option>
            ))}
          </select>
          {pending !== null ? (
            <span className="ml-2 shrink-0 text-xs text-fg-faint">switching…</span>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}
