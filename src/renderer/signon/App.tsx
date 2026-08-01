import type { JSX } from 'react'

/**
 * Sign-on / QR linking window — scaffold placeholder.
 *
 * TODO(ui): owned by the UI module — the classic AIM sign-on window, showing the QR code the
 * user scans from their phone plus the connection state (linked | linking | unlinked |
 * daemon-down, SPEC.md §8).
 */
export function App(): JSX.Element {
  return (
    <main className="chrome">
      <div className="titlebar-drag" style={{ padding: 'var(--space-3)' }}>
        <h1>Sign On</h1>
      </div>
    </main>
  )
}
