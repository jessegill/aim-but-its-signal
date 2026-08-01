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
import type { Attachment, Buddy, GroupChat, Message } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, imMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, TextArea, Window, WindowBody, cx } from './controls';
import { FormattingToolbar, type FormattingState } from './FormattingToolbar';
import { MessageLog, TypingIndicator } from './MessageLog';
import { formatDuration } from './BuddyRow';
import { BuddyGlyph } from './icons';

export interface ImWindowProps {
  contact: Buddy;
  /**
   * Set for a group conversation, and the only thing that distinguishes one: the window
   * becomes an AIM chat room (SPEC.md §8) — a participant list beside the history, and every
   * line attributed to its own sender instead of to a single other party.
   */
  group?: GroupChat | null;
  /** Display name for the local account, used for own message lines. */
  selfName: string;
  messages: Message[];

  /** Controlled composer. Omit both to let the component hold its own draft. */
  draft?: string;
  onDraftChange?: (value: string) => void;

  /** The other party is typing right now. A protocol event, not presence. */
  theirTyping?: boolean;
  /** Who is typing. Only meaningful in a group; 1:1 falls back to the contact's name. */
  typingName?: string | null;
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
  group = null,
  selfName,
  messages,
  draft,
  onDraftChange,
  theirTyping,
  typingName,
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

  // Unregistered contacts render normally but cannot be sent to (types.ts). For a group the
  // same flag carries "you are not in this group any more", which has the same consequence and
  // needs its own wording — telling the user a chat room is "no longer registered" is nonsense.
  const blockedForSend = contact.unregistered || contact.blocked || !!sendDisabled;
  const blockReason = contact.unregistered
    ? group !== null
      ? `You are no longer a member of ${contactName}. The history stays; new messages cannot be sent.`
      : `${contactName} is no longer registered. Messages cannot be delivered.`
    : contact.blocked
      ? group !== null
        ? `${contactName} is blocked. Unblock the group to send.`
        : `${contactName} is blocked. Unblock to send.`
      : sendDisabledReason;

  /**
   * In a chat room every line is attributed to whoever sent it. `senderName` is resolved in the
   * main process against the roster, so a member with a local nickname reads the same here as
   * in the buddy list. Own lines keep `selfName` — "You" by any other spelling is confusing
   * when your own display name is also in the member list.
   */
  const resolveName = React.useMemo(
    () =>
      group === null ? undefined : (m: Message): string => (m.outgoing ? selfName : m.senderName),
    [group, selfName]
  );

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

  // A blank name is as bad as no name — fall back rather than render "  is typing…".
  const typedBy = typingName?.trim();
  const typingLabel = typedBy !== undefined && typedBy.length > 0 ? typedBy : contactName;

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
            resolveName={resolveName}
            canPlayVoice={canPlayVoice}
            safetyNumber={safetyNumber}
            onOpenAttachment={onOpenAttachment}
            onQuoteClick={onQuoteClick}
            onVerifySafetyNumber={onVerifySafetyNumber}
            /* Pinned above the history. Cannot be scrolled out of view, and
               there is no prop to remove it (SPEC.md §8). */
            banner={securityNotice}
          />
          {group !== null ? <RoomList group={group} /> : null}
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
            placeholder={
              blockedForSend
                ? ''
                : group !== null
                  ? 'Send to chat room…'
                  : `Message ${contactName}…`
            }
            aria-label={
              group !== null ? `Message to ${contactName} chat room` : `Message to ${contactName}`
            }
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
            content: theirTyping ? <TypingIndicator name={typingLabel} /> : '',
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
                  {group !== null
                    ? `${String(group.members.length)} in room`
                    : (contact.number ?? 'no number')}
                </span>
              </>
            ),
            title:
              group !== null
                ? // Not a presence count. Signal has no presence (SPEC.md §7) — this is
                  // membership, and everyone in it is listed whether or not they are around.
                  `${String(group.members.length)} members. Membership, not availability — Signal has no presence.`
                : (contact.number ?? 'Known by account id only'),
          },
        ]}
      />
    </Window>
  );
}

/**
 * The chat-room participant list (SPEC.md §8).
 *
 * Deliberately NOT the buddy list's row component: those rows carry availability affordances,
 * and this list has none to carry. Signal has no presence (SPEC.md §7), so everybody in a group
 * is listed identically whether or not they are anywhere near their phone. The heading says
 * "members" for the same reason — a count here is membership, not who is around.
 */
function RoomList({ group }: { group: GroupChat }): React.ReactElement {
  return (
    <div className="aim-room" role="group" aria-label="Chat room members">
      <div className="aim-room__title">Members ({group.members.length})</div>
      <ul className="aim-room__list">
        {group.members.map((m) => (
          <li
            key={m.id}
            className={cx('aim-room__member', m.isSelf && 'aim-room__member--self')}
            title={m.isAdmin ? `${m.name} — group admin` : m.name}
          >
            <BuddyGlyph size={11} />
            <span className="aim-room__name">{m.name}</span>
            {m.isAdmin ? (
              <span className="aim-room__admin" aria-label="group admin">
                ★
              </span>
            ) : null}
          </li>
        ))}
        {group.members.length === 0 ? (
          <li className="aim-room__empty">
            Member list not synced yet — messages still show who sent them.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
