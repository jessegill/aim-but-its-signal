/**
 * Sign-on / device-linking window (SPEC.md §9).
 *
 * Shows the QR code the user scans from their phone to link this computer as a secondary
 * device, and reports all four connection states from SPEC.md §8 — `linked`, `linking`,
 * `unlinked`, `daemon-down` — each with the plain-language explanation the UI library carries
 * for it. The state is never guessed: until `connection:get` answers or `connection:state`
 * arrives the window says "Linking…" rather than claiming to be connected.
 *
 * The QR payload is the `sgnl://linkdevice?uuid=…&pub_key=…` URI the daemon produces
 * (docs/signal-cli-rpc.md §3.3). This renderer never generates, parses, or holds key material
 * — it receives an opaque string and draws it (SPEC.md §10). The encoder in ./qr.ts is pure
 * computation over that string.
 *
 * NO PRESENCE (SPEC.md §7): the LED here reports this device's link to the service. It is not
 * a status selector and there is nothing to set yourself "away" with.
 */

import * as React from 'react';
import type { JSX } from 'react';

import type { ConnectionState } from '@shared/types';

import { CONNECTION_LABELS, ConnectionBadge, SignOnWindow, StatusBar } from '../ui';
import { QrCode } from './QrCode';
import {
  BRIDGE_MISSING,
  describeFailure,
  hasBridge,
  invoke,
  useIpcEvent,
  windowChrome,
} from './ipc';

const PRODUCT_NAME = 'Instant Messenger';

/**
 * The linking URI.
 *
 * CONTRACT GAP: src/shared/types.ts has no channel that carries it, so it is read from the
 * window's query string — the same mechanism createImWindow already uses for conversationId.
 * Main can pass `?linkingUri=…` (or `?deviceLinkUri=…`) when it opens this window. A pushed
 * channel is needed for the real flow, because the URI is regenerated on every relink and the
 * code has to be redrawn without reloading the window.
 */
function initialLinkingUri(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('linkingUri') ?? params.get('deviceLinkUri');
}

export function App(): JSX.Element {
  const [state, setState] = React.useState<ConnectionState>('linking');
  const [linkingUri] = React.useState<string | null>(initialLinkingUri);
  const [deviceName, setDeviceName] = React.useState('Desktop');
  const [rememberDevice, setRememberDevice] = React.useState(true);
  const [windowActive, setWindowActive] = React.useState(() => document.hasFocus());
  const [notice, setNotice] = React.useState<string | null>(hasBridge() ? null : BRIDGE_MISSING);

  React.useEffect(() => {
    void (async () => {
      try {
        setState(await invoke('connection:get'));
        setNotice(null);
      } catch (err) {
        // Worth saying out loud here: this window exists to explain the connection, so a
        // window that cannot read it must not look like a window that read "fine".
        setNotice(describeFailure('connection:get', err));
      }
    })();
  }, []);

  useIpcEvent('connection:state', (next) => {
    setState(next);
    setNotice(null);
  });

  React.useEffect(() => {
    const onFocus = (): void => setWindowActive(true);
    const onBlur = (): void => setWindowActive(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const label = CONNECTION_LABELS[state];

  return (
    <div
      className="aim-root chrome"
      style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <SignOnWindow
          /* The library sizes itself for the showcase page; here the window IS the component.
             minHeight rather than height so a short window scrolls instead of clipping the
             buttons. */
          style={{ width: '100%', minHeight: '100%' }}
          productName={PRODUCT_NAME}
          state={state}
          windowActive={windowActive}
          // Rendered as SVG so it stays sharp at any size. When there is no URI yet the
          // library draws its own "Generating code…" placeholder, which is the truth.
          qrSvg={
            linkingUri !== null ? <QrCode value={linkingUri} className="aim-signon__qr" /> : null
          }
          linkingUri={linkingUri}
          deviceName={deviceName}
          onDeviceNameChange={setDeviceName}
          rememberDevice={rememberDevice}
          onRememberDeviceChange={setRememberDevice}
          onRelink={() => setNotice(RELINK_NOTICE)}
          onRestartService={() => setNotice(RESTART_NOTICE)}
          onMinimize={windowChrome.minimize}
          onClose={windowChrome.close}
        />
      </div>

      {/* The same state readout as the window body, sized for a status bar, so the link state
          is visible even when the body is scrolled (SPEC.md §8 requires it to be visible). */}
      <StatusBar
        cells={[
          { grow: true, content: notice ?? label.detail, title: label.detail },
          { width: 104, content: <ConnectionBadge state={state} />, title: label.detail },
        ]}
      />
    </div>
  );
}

/* Both actions need a main-process capability that no channel in src/shared/types.ts exposes.
   The buttons stay visible and say what is missing — SPEC.md §8 requires a path back to a
   working link, and hiding the control would hide the gap too. */
const RELINK_NOTICE =
  'Generating a new linking code needs a main-process channel (startLink) — not wired yet.';
const RESTART_NOTICE =
  'Restarting the background messaging service is a main-process action — not wired yet.';
