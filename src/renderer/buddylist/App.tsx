import type { JSX } from 'react'

/**
 * Buddy list window — scaffold placeholder.
 *
 * TODO(ui): owned by the UI module — the real AIM 5.1 buddy list (title bar, menu bar,
 * collapsible groups with counts, double-click to open an IM window) replaces this entirely.
 * Only the drag region is load-bearing: the window is frameless, so without it the window
 * cannot be moved.
 */
export function App(): JSX.Element {
  return (
    <main className="chrome">
      <div className="titlebar-drag" style={{ padding: 'var(--space-3)' }}>
        <h1>Buddy List</h1>
      </div>
    </main>
  )
}
