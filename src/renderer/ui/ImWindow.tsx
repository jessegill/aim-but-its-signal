/**
 * ImWindow — one conversation, one OS window (SPEC.md §1).
 *
 * Layout is fixed by SPEC.md §9, top to bottom:
 *   TitleBar → MenuBar → message history pane → formatting toolbar →
 *   input pane → Send button bottom-right → StatusBar.
 *
 * Pure view. `onSend` / `onTypingChange` / window-control callbacks are supplied
 * by the host; nothing here touches IPC or the network.
 *
 * NO PRESENCE (SPEC.md §7): the status bar carries the typing indicator and the
 * disappearing-message timer, both of which are real protocol events. It does
 * NOT say "Bob is online", "Bob is idle (14 mins)", or show an away message,
 * because none of those exist.
 *
 * SECURITY (SPEC.md §8): `securityNotice` renders pinned at the top of the log,
 * above the scrolling history, so it cannot be scrolled out of sight. There is
 * no prop that suppresses it.
 */

import * as React from 'react';
import type { Attachment, Buddy, Message } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, imMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, TextArea, Window, WindowBody, cx } from './controls';
import { FormattingToolbar, type FormattingState } from './FormattingToolbar';
import { MessageLog, TypingIndicator } from './MessageLog';
import { formatDuration } from './BuddyRow';
import { BuddyGlyph } from './icons';

export interface ImWindowProps {
  contact: Buddy;
  /** Display name for the local account, used for own message lines. */
  selfName: string;
  messages: Message[];

  /** Controlled composer. Omit both to let the component hold its own draft. */
  draft?: string;
  onDraftChange?: (value: string) => void;

  /** The other party is typing right now. A protocol event, not presence. */
  theirTyping?: boolean;
  /** Fired as the user starts/stops typing so the host can emit im:setTyping. */
  onTypingChange?: (isTyping: boolean) => void;

  onSend?: (body: string) => void;
  onAttach?: () => void;
  onOpenAttachment?: (a: Attachment) => void;
  onQuoteClick?: (quoteId: string) => void;
  onVerifySafetyNumber?: () => void;
  safetyNumber?: string | null;

  /**
   * A pinned SecurityNotice. Rendered above the scrolling history and never
   * scrolled away. Pass a <SecurityNotice/>.
   */
  securityNotice?: React.ReactNode;

  formatting?: FormattingState;
  onFormattingChange?: (f: FormattingState) => void;

  menus?: MenuSpec[];
  windowActive?: boolean;
  canPlayVoice?: boolean;
  /** Disable sending, e.g. while the daemon is down. */
  sendDisabled?: boolean;
  sendDisabledReason?: string;

  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;

  className?: string;
  style?: React.CSSProperties;
}

export function ImWindow({
  contact,
  selfName,
  messages,
  draft,
  onDraftChange,
  theirTyping,
  onTypingChange,
  onSend,
  onAttach,
  onOpenAttachment,
  onQuoteClick,
  onVerifySafetyNumber,
  safetyNumber,
  securityNotice,
  formatting,
  onFormattingChange,
  menus,
  windowActive = true,
  canPlayVoice,
  sendDisabled,
  sendDisabledReason,
  onMinimize,
  onMaximize,
  onClose,
  className,
  style,
}: ImWindowProps) {
  const [localDraft, setLocalDraft] = React.useState('');
  const controlled = draft !== undefined;
  const value = controlled ? draft : localDraft;

  // A nickname that is present but blank must fall through to the real name,
  // otherwise the title bar of a whole window goes empty.
  const nick = contact.nickname?.trim();
  const contactName = nick !== undefined && nick.length > 0 ? nick : contact.displayName;

  // Unregistered contacts render normally but cannot be sent to (types.ts).
  const blockedForSend = contact.unregistered || contact.blocked || !!sendDisabled;
  const blockReason = contact.unregistered
    ? `${contactName} is no longer registered. Messages cannot be delivered.`
    : contact.blocked
      ? `${contactName} is blocked. Unblock to send.`
      : sendDisabledReason;

  /* Typing signal: on while the field is non-empty and being edited, off after
     a short idle or on send. The host decides what to do with it. */
  const typingTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingOn = React.useRef(false);

  const signalTyping = React.useCallback(
    (on: boolean) => {
      if (typingOn.current === on) return;
      typingOn.current = on;
      onTypingChange?.(on);
    },
    [onTypingChange]
  );

  React.useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    []
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    if (controlled) onDraftChange?.(next);
    else setLocalDraft(next);

    signalTyping(next.trim().length > 0);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => signalTyping(false), 4000);
  };

  const doSend = () => {
    const body = value.trim();
    if (!body || blockedForSend) return;
    signalTyping(false);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    onSend?.(body);
    if (!controlled) setLocalDraft('');
    else onDraftChange?.('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter newlines. That is the AIM behaviour.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  const expiryOn = contact.messageExpirationTime > 0;

  return (
    <Window className={cx('aim-im', className)} style={style}>
      <TitleBar
        title={contactName}
        active={windowActive}
        onMinimize={onMinimize}
        onMaximize={onMaximize}
        onClose={onClose}
      />
      <MenuBar menus={menus ?? imMenus()} />

      <WindowBody>
        <div className="aim-im__logwrap">
          <MessageLog
            messages={messages}
            selfName={selfName}
            contactName={contactName}
            canPlayVoice={canPlayVoice}
            safetyNumber={safetyNumber}
            onOpenAttachment={onOpenAttachment}
            onQuoteClick={onQuoteClick}
            onVerifySafetyNumber={onVerifySafetyNumber}
            /* Pinned above the history. Cannot be scrolled out of view, and
               there is no prop to remove it (SPEC.md §8). */
            banner={securityNotice}
          />
        </div>

        <FormattingToolbar
          state={formatting}
          onChange={onFormattingChange}
          onAttach={onAttach}
          disabled={blockedForSend}
        />

        <div className="aim-im__compose">
          {blockedForSend && blockReason ? (
            <div className="aim-im__warning">{blockReason}</div>
          ) : null}

          <TextArea
            className="aim-im__input"
            value={value}
            placeholder={blockedForSend ? '' : `Message ${contactName}…`}
            aria-label={`Message to ${contactName}`}
            disabled={blockedForSend}
            onChange={handleChange}
            onKeyDown={onKeyDown}
            onBlur={() => signalTyping(false)}
          />

          <div className="aim-im__actions">
            <Button size="small" onClick={onAttach} disabled={blockedForSend} title="Attach a file">
              Attach…
            </Button>
            {expiryOn ? (
              <span
                className="aim-dim"
                title={`Messages in this conversation disappear after ${formatDuration(
                  contact.messageExpirationTime
                )}`}
              >
                ⧗ {formatDuration(contact.messageExpirationTime)}
              </span>
            ) : null}
            <span className="aim-im__actions-spacer" />
            {/* Send is bottom-right, per SPEC.md §9. */}
            <Button
              isDefault
              wide
              onClick={doSend}
              disabled={blockedForSend || value.trim().length === 0}
            >
              Send
            </Button>
          </div>
        </div>
      </WindowBody>

      <StatusBar
        cells={[
          {
            grow: true,
            // Typing only. Never "online", "idle" or "away" — no such data exists.
            content: theirTyping ? <TypingIndicator name={contactName} /> : '',
            title: 'Typing indicators are per-message protocol events, not availability.',
          },
          {
            width: 96,
            content: (
              <>
                <BuddyGlyph size={11} />
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {contact.number ?? 'no number'}
                </span>
              </>
            ),
            title: contact.number ?? 'Known by account id only',
          },
        ]}
      />
    </Window>
  );
}
