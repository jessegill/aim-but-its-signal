/**
 * SignOnWindow — classic AIM sign-on styling, hosting the device-linking QR
 * code and the connection state (SPEC.md §8, §9).
 *
 * The 2003 sign-on window had a screen-name field and a password field. Neither
 * exists here: this client links as a secondary device and never sees a
 * credential. So the shape is kept — yellow banner, bevelled well, buttons
 * bottom-right — and the middle is a QR code instead of a password box.
 *
 * The banner mark is original artwork (SPEC.md §9, §10). No running man, no AOL
 * wordmark, and the product name is passed in by the host rather than hardcoded
 * to anything trademarked (SPEC.md §10).
 *
 * All four connection states from SPEC.md §8 are rendered here, each with a
 * plain-language explanation of what does and does not work in that state, and
 * `unlinked` / `daemon-down` surface the recovery action rather than leaving
 * the user staring at a dead window.
 *
 * NO PRESENCE: the LED reports this device's link to the service. It is not a
 * status dropdown and there is nothing here to set yourself "away" with.
 */

import * as React from 'react';
import type { ConnectionState } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { Button, Checkbox, Window, WindowBody, cx } from './controls';
import { AppMark } from './icons';
import { CONNECTION_LABELS } from './connection';

export interface SignOnWindowProps {
  /** Product name for the banner and title bar. Host-supplied — see SPEC.md §10. */
  productName?: string;
  state: ConnectionState;

  /**
   * The QR payload. Accepts either a ready-made image (data: URI or an <svg>
   * element) or the raw linking URI, in which case a placeholder is drawn and
   * the URI is offered as selectable text so linking is still possible.
   */
  qrImageSrc?: string | null;
  qrSvg?: React.ReactNode;
  linkingUri?: string | null;

  /** Device name that will show in the account's linked-devices list. */
  deviceName?: string;
  onDeviceNameChange?: (name: string) => void;

  rememberDevice?: boolean;
  onRememberDeviceChange?: (v: boolean) => void;

  /** Regenerate the code / retry linking. */
  onRelink?: () => void;
  /** Restart the background service after `daemon-down`. */
  onRestartService?: () => void;
  onCancel?: () => void;
  onHelp?: () => void;

  windowActive?: boolean;
  onMinimize?: () => void;
  onClose?: () => void;

  className?: string;
  style?: React.CSSProperties;
}

export function SignOnWindow({
  productName = 'Instant Messenger',
  state,
  qrImageSrc,
  qrSvg,
  linkingUri,
  deviceName,
  onDeviceNameChange,
  rememberDevice = true,
  onRememberDeviceChange,
  onRelink,
  onRestartService,
  onCancel,
  onHelp,
  windowActive = true,
  onMinimize,
  onClose,
  className,
  style,
}: SignOnWindowProps) {
  const label = CONNECTION_LABELS[state];
  const showQr = state === 'linking' || state === 'unlinked';

  return (
    <Window className={cx('aim-signon', className)} style={style}>
      <TitleBar
        title={`Sign On — ${productName}`}
        active={windowActive}
        showMaximize={false}
        onMinimize={onMinimize}
        onClose={onClose}
      />

      <WindowBody>
        <div className="aim-signon__banner">
          <AppMark size={38} />
          <span className="aim-signon__wordmark">
            <span className="aim-signon__wordmark-main">{productName}</span>
            <span className="aim-signon__wordmark-sub">Linked Device</span>
          </span>
        </div>

        <div className="aim-signon__body">
          {showQr ? (
            <>
              <div className="aim-signon__instructions">
                To link this computer to your account:
                <ol>
                  <li>Open the messenger app on your phone.</li>
                  <li>Go to Settings → Linked Devices.</li>
                  <li>Scan the code below.</li>
                </ol>
              </div>

              <div className="aim-signon__qr-frame">
                {qrSvg ? (
                  <div className="aim-signon__qr">{qrSvg}</div>
                ) : qrImageSrc ? (
                  <img className="aim-signon__qr" src={qrImageSrc} alt="Device linking code" />
                ) : (
                  <div className="aim-signon__qr aim-signon__qr--placeholder">
                    {state === 'linking' ? 'Generating code…' : 'No code yet'}
                  </div>
                )}
              </div>

              {linkingUri && !qrImageSrc && !qrSvg ? (
                <div
                  className="aim-security__fingerprint aim-selectable"
                  title="Linking URI — paste into the phone app if you cannot scan"
                  style={{ fontSize: 10 }}
                >
                  {linkingUri}
                </div>
              ) : null}

              <label className="aim-field aim-field--stacked">
                <span className="aim-field__label">This device will appear as:</span>
                <input
                  className="aim-input"
                  value={deviceName ?? ''}
                  placeholder="Desktop"
                  onChange={(e) => onDeviceNameChange?.(e.target.value)}
                />
              </label>

              <Checkbox
                label="Keep me signed on"
                checked={rememberDevice}
                onChange={(e) => onRememberDeviceChange?.(e.currentTarget.checked)}
              />
            </>
          ) : (
            <div className="aim-signon__instructions">{label.detail}</div>
          )}

          {state === 'linking' ? (
            <div className="aim-progress" role="progressbar" aria-label="Linking">
              <div className="aim-progress__blocks" />
            </div>
          ) : null}

          {/* Connection state — required to be visible (SPEC.md §8). */}
          <div
            className={cx('aim-signon__state', `aim-signon__state--${state}`)}
            title={label.detail}
          >
            <span className="aim-signon__state-led" aria-hidden="true" />
            <span className="aim-signon__state-label">{label.short}</span>
            <span className="aim-signon__state-detail">({state})</span>
          </div>

          <div className="aim-signon__actions">
            {onHelp ? (
              <Button size="small" onClick={onHelp}>
                Help
              </Button>
            ) : null}
            {state === 'daemon-down' && onRestartService ? (
              <Button size="small" isDefault onClick={onRestartService}>
                Restart Service
              </Button>
            ) : null}
            {state !== 'daemon-down' && onRelink ? (
              <Button size="small" isDefault onClick={onRelink}>
                {state === 'linked' ? 'Relink…' : 'New Code'}
              </Button>
            ) : null}
            {onCancel ? (
              <Button size="small" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      </WindowBody>
    </Window>
  );
}

/* ---------------------------------------------------------------------------
 * ConnectionBadge — the same state readout, sized for a status bar. Reuse it
 * anywhere the link state needs to be visible outside the sign-on window.
 * ------------------------------------------------------------------------ */
export function ConnectionBadge({
  state,
  showState = false,
  className,
}: {
  state: ConnectionState;
  showState?: boolean;
  className?: string;
}) {
  const label = CONNECTION_LABELS[state];
  return (
    <span
      className={cx('aim-signon__state', `aim-signon__state--${state}`, className)}
      style={{ border: 0, padding: 0, background: 'transparent' }}
      title={label.detail}
    >
      <span className="aim-signon__state-led" aria-hidden="true" />
      <span>{label.short}</span>
      {showState ? <span className="aim-signon__state-detail">({state})</span> : null}
    </span>
  );
}
