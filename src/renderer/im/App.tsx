import type { JSX } from 'react'

interface AppProps {
  /** Null only in the scaffold; main always supplies it for a real IM window. */
  conversationId: string | null
}

/**
 * IM window — scaffold placeholder. One instance per conversation (SPEC.md §1).
 *
 * TODO(ui): owned by the UI module — message history pane, formatting toolbar, input pane and
 * Send button replace this entirely.
 */
export function App({ conversationId }: AppProps): JSX.Element {
  return (
    <main className="chrome">
      <div className="titlebar-drag" style={{ padding: 'var(--space-3)' }}>
        <h1>IM Window</h1>
        <p>{conversationId ?? 'no conversation'}</p>
      </div>
    </main>
  )
}
