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

export function App(): JSX.Element {
  const [state, setState] = React.useState<ConnectionState>('linking');
  const [linkingUri, setLinkingUri] = React.useState<string | null>(null);
  const [deviceName, setDeviceName] = React.useState('AIMgnal');
  const [windowActive, setWindowActive] = React.useState(() => document.hasFocus());
  const [notice, setNotice] = React.useState<string | null>(hasBridge() ? null : BRIDGE_MISSING);

  /** Asks main for a fresh code. The URI also arrives on `connection:linkUri`. */
  const requestCode = React.useCallback((name: string): void => {
    setLinkingUri(null);
    void (async () => {
      try {
        setLinkingUri(await invoke('connection:startLink', name));
        setNotice(null);
      } catch (err) {
        setNotice(describeFailure('connection:startLink', err));
      }
    })();
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const current = await invoke('connection:get');
        setState(current);
        setNotice(null);
        // Main generates a code itself when it finds no linked account, usually before this
        // window has loaded — so ask for the one on offer, and only request a new one if
        // there is none.
        const uri = await invoke('connection:getLinkUri');
        if (uri !== null) setLinkingUri(uri);
        else if (current === 'unlinked') requestCode('AIMgnal');
      } catch (err) {
        // Worth saying out loud here: this window exists to explain the connection, so a
        // window that cannot read it must not look like a window that read "fine".
        setNotice(describeFailure('connection:get', err));
      }
    })();
  }, [requestCode]);

  useIpcEvent('connection:state', (next) => {
    setState(next);
    setNotice(null);
  });

  // A code rotates on every relink and expires if left unscanned; main pushes each new one.
  useIpcEvent('connection:linkUri', (uri) => {
    setLinkingUri(uri);
    setNotice(null);
  });

  const restartService = React.useCallback((): void => {
    setNotice('Restarting the messaging service…');
    void invoke('connection:restartService').catch((err: unknown) => {
      setNotice(describeFailure('connection:restartService', err));
    });
  }, []);

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
          onRelink={() => requestCode(deviceName)}
          onRestartService={restartService}
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
