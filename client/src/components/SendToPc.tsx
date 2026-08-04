import { useCallback, useState } from 'react';

import { connection } from '../lib/connection';
import { useConnectionValue } from '../lib/useConnection';

/**
 * Copies to the phone's own clipboard.
 *
 * `navigator.clipboard` only exists in a secure context, and this app is served
 * over plain http on a LAN address — so it is never available here, whatever the
 * browser version. The hidden-textarea trick is not a legacy fallback in this
 * project, it is the only route.
 */
function copyOnPhone(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen rather than hidden: execCommand ignores an element that is not
    // rendered, and a focused visible textarea would scroll the page.
    area.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
    area.setAttribute('readonly', '');
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Matches what the agent will accept — anything else is refused server-side. */
const URL_PATTERN = /^https?:\/\/\S+$/i;

/**
 * Push text to the PC's clipboard, or open a link in its browser.
 *
 * The two most common reasons to reach for the PC from a phone: a URL you want
 * on the big screen, and a snippet you would otherwise retype. One field serves
 * both, because whether the text is a link is obvious from the text.
 */
export function SendToPc({ enabled }: { enabled: boolean }): JSX.Element {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pcClipboard = useConnectionValue((s) => s.state?.system?.clipboard ?? '');

  const trimmed = text.trim();
  const looksLikeUrl = URL_PATTERN.test(trimmed);

  const run = useCallback(
    (command: { kind: 'system.sendText'; text: string } | { kind: 'system.openUrl'; url: string }, done: string) => {
      setBusy(true);
      setNote(null);
      connection
        .send(command)
        .then(() => {
          setNote(done);
          // Cleared on success only: a failed send should not lose what was typed.
          setText('');
        })
        .catch((err: Error) => setNote(err.message))
        .finally(() => setBusy(false));
    },
    [],
  );

  return (
    <div>
      <p className="mb-1 text-xs uppercase tracking-wider text-fg-dim">Send to PC</p>

      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Text, or a link to open"
        aria-label="Text or link to send to the PC"
        // No autocorrect or autocapitalise: this is as often a URL or a snippet
        // of code as it is prose, and having either mangled is worse than useless.
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-12 w-full rounded-md border border-ink-700 bg-ink-900 px-3 text-sm text-fg"
      />

      <div className="mt-1 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!enabled || busy || trimmed.length === 0}
          onClick={() => run({ kind: 'system.sendText', text: trimmed }, 'Copied to the PC clipboard.')}
          className="flex min-h-[48px] items-center justify-center rounded-md border border-ink-700 px-2 text-sm text-fg-dim active:bg-ink-700"
          style={{ opacity: !enabled || trimmed.length === 0 ? 0.4 : 1 }}
        >
          Copy
        </button>
        <button
          type="button"
          disabled={!enabled || busy || !looksLikeUrl}
          onClick={() => run({ kind: 'system.openUrl', url: trimmed }, 'Opening on the PC.')}
          aria-label="Open link on the PC"
          className="flex min-h-[48px] items-center justify-center rounded-md border px-2 text-sm active:opacity-80"
          style={{
            borderColor: looksLikeUrl && enabled ? 'var(--accent)' : 'var(--line-bright)',
            color: looksLikeUrl && enabled ? 'var(--accent-bright)' : 'var(--fg-faint)',
            opacity: !enabled || !looksLikeUrl ? 0.5 : 1,
          }}
        >
          Open
        </button>
      </div>

      {/* Only http(s) is accepted, and the agent checks again — say so rather
          than letting the button silently stay dead. */}
      {trimmed.length > 0 && !looksLikeUrl ? (
        <p className="mt-1 text-xs text-fg-faint">Only http and https links can be opened.</p>
      ) : null}
      {note ? <p className="mt-1 text-xs text-fg-faint">{note}</p> : null}

      {/*
        The other direction. Whatever was last copied on the PC, ready to be
        taken onto the phone — which is the half of "clipboard sync" that cannot
        be done by typing.
      */}
      {pcClipboard ? (
        <div className="mt-2 border-t border-ink-700 pt-2">
          <p className="mb-1 text-xs uppercase tracking-wider text-fg-dim">On the PC</p>
          <button
            type="button"
            onClick={() => {
              setNote(copyOnPhone(pcClipboard) ? 'Copied to this phone.' : 'Could not copy — long-press the text instead.');
            }}
            className="flex min-h-[48px] w-full items-start rounded-md border border-ink-700 px-2 py-2 text-left active:bg-ink-700"
          >
            <span
              className="min-w-0 flex-1 text-sm text-fg"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
              }}
            >
              {pcClipboard}
            </span>
            <span className="ml-2 shrink-0 text-xs text-accent-bright">Copy</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
