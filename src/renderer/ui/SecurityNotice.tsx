/**
 * SecurityNotice — safety-number / identity-change and related security signals.
 *
 * ===========================================================================
 * SPEC.md §8: "When retro authenticity conflicts with a security signal,
 * SECURITY WINS. Style the security element to fit the era; do not drop it."
 * ===========================================================================
 *
 * Consequences, deliberate and load-bearing:
 *
 *   1. There is NO prop that hides this component. No `hidden`, no `muted`, no
 *      `compact` that elides the text. If a host renders a message stream that
 *      contains an identity change, this appears. `onAcknowledge` dismisses the
 *      ACTION PROMPT only — the notice itself stays in the log forever, because
 *      the event stays in history forever.
 *
 *   2. It is the loudest thing on screen: hazard-striped rule, red shield,
 *      uppercase caption. That is louder than a 2003 UI would normally be, and
 *      that is the correct trade.
 *
 *   3. The wording never reassures. An identity change has a benign cause
 *      (reinstall, new phone) and a hostile one (interception), and this UI is
 *      not able to tell them apart — so it says exactly that and points at the
 *      only reliable check, which is out-of-band verification.
 *
 * The styling is era-appropriate: bevelled panel, hard edges, no rounding, no
 * modern toast. It fits, but it does not blend in, and it is not supposed to.
 */

import * as React from 'react';
import { Button, cx } from './controls';
import { GlyphSecurity } from './icons';

export type SecurityNoticeKind =
  /** The contact's safety number changed. The canonical §8 case. */
  | 'identity-change'
  /** The user has not yet verified this contact's safety number. */
  | 'unverified'
  /** A previously verified contact's number changed — strictly worse. */
  | 'verified-broken'
  /** Delivery failed because the identity is untrusted and must be resolved. */
  | 'send-blocked'
  /** Disappearing-message timer changed. Security-relevant, not an alarm. */
  | 'expiry-changed'
  /** Generic slot for future security events. Never a dumping ground for chatter. */
  | 'notice';

export interface SecurityNoticeProps {
  kind: SecurityNoticeKind;
  /** Who the notice concerns. */
  contactName: string;
  /** Human-formatted event time. */
  timestamp?: string;
  /**
   * Safety-number digits, if the host has them. Shown verbatim and selectable so
   * the user can read them aloud during out-of-band verification.
   */
  safetyNumber?: string | null;
  /** For 'expiry-changed'. e.g. "1 week", "off". */
  newExpiry?: string;
  /** Overrides the generated body copy entirely. Use sparingly. */
  children?: React.ReactNode;

  onVerify?: () => void;
  onLearnMore?: () => void;
  /**
   * Hides the ACTION BUTTONS once the user has dealt with it. The notice text
   * itself never disappears. There is no prop that removes it.
   */
  onAcknowledge?: () => void;
  acknowledged?: boolean;

  className?: string;
}

interface Copy {
  title: string;
  body: React.ReactNode;
  /** Blocking notices get the heavier frame and inverted caption. */
  blocking: boolean;
}

function copyFor(kind: SecurityNoticeKind, name: string, newExpiry?: string): Copy {
  switch (kind) {
    case 'identity-change':
      return {
        blocking: true,
        title: 'Safety number changed',
        body: (
          <>
            Your safety number with <b>{name}</b> has changed. This happens when someone reinstalls
            the app or switches to a new phone — and it is also what interception looks like.{' '}
            <b>This client cannot tell the two apart.</b> Compare the number below with {name} in
            person or over a call you started yourself before sending anything sensitive.
          </>
        ),
      };
    case 'verified-broken':
      return {
        blocking: true,
        title: 'Verified safety number changed',
        body: (
          <>
            You had previously marked <b>{name}</b> as verified, and their safety number has now
            changed. The old verification no longer means anything. Re-verify before you continue.
          </>
        ),
      };
    case 'send-blocked':
      return {
        blocking: true,
        title: 'Message not sent — identity unresolved',
        body: (
          <>
            Nothing was sent to <b>{name}</b>. Their identity key changed and has not been accepted,
            so the message was held rather than delivered to a key you have not checked. Review the
            safety number, then send again.
          </>
        ),
      };
    case 'unverified':
      return {
        blocking: false,
        title: 'Safety number not verified',
        body: (
          <>
            You have not verified your safety number with <b>{name}</b>. Messages are still
            end-to-end encrypted, but nothing has confirmed that the other end is really {name}.
          </>
        ),
      };
    case 'expiry-changed':
      return {
        blocking: false,
        title: 'Disappearing messages changed',
        body: (
          <>
            <b>{name}</b> set disappearing messages to <b>{newExpiry ?? 'a new value'}</b>. Messages
            in this conversation are removed from this computer when the timer runs out.
          </>
        ),
      };
    case 'notice':
    default:
      return { blocking: false, title: 'Security notice', body: null };
  }
}

export function SecurityNotice({
  kind,
  contactName,
  timestamp,
  safetyNumber,
  newExpiry,
  children,
  onVerify,
  onLearnMore,
  onAcknowledge,
  acknowledged,
  className,
}: SecurityNoticeProps) {
  const copy = copyFor(kind, contactName, newExpiry);
  // Note what this does NOT gate: the notice body. `acknowledged` only retires
  // the buttons once the user has dealt with them.
  const hasAction = Boolean(onVerify) || Boolean(onLearnMore) || Boolean(onAcknowledge);
  const showActions = !acknowledged && hasAction;

  return (
    <div
      className={cx('aim-security', copy.blocking && 'aim-security--blocking', className)}
      role="alert"
      aria-live="assertive"
    >
      <div className="aim-security__bar" aria-hidden="true" />
      <div className="aim-security__inner">
        <span className="aim-security__icon" aria-hidden="true">
          <GlyphSecurity size={22} />
        </span>
        <div className="aim-security__content">
          <div className="aim-security__title">
            {copy.title}
            {timestamp ? <span style={{ fontWeight: 'normal' }}> · {timestamp}</span> : null}
          </div>
          <div className="aim-security__body">{children ?? copy.body}</div>

          {safetyNumber ? (
            <div className="aim-security__fingerprint aim-selectable" title="Safety number">
              {safetyNumber}
            </div>
          ) : null}

          {showActions ? (
            <div className="aim-security__actions">
              {onVerify ? (
                <Button size="small" isDefault onClick={onVerify}>
                  Verify…
                </Button>
              ) : null}
              {onLearnMore ? (
                <Button size="small" onClick={onLearnMore}>
                  What is this?
                </Button>
              ) : null}
              {onAcknowledge ? (
                <Button
                  size="small"
                  onClick={onAcknowledge}
                  title="Hides these buttons. The notice itself stays in the conversation."
                >
                  I understand
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Format a Signal-style 60-digit safety number into 12 groups of 5, the way it
 * is displayed for reading aloud. Non-digits are stripped; anything that is not
 * 60 digits is returned untouched rather than mangled.
 */
export function formatSafetyNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 60) return raw;
  const groups = digits.match(/.{1,5}/g) ?? [];
  return [
    groups.slice(0, 4).join(' '),
    groups.slice(4, 8).join(' '),
    groups.slice(8).join(' '),
  ].join('\n');
}
