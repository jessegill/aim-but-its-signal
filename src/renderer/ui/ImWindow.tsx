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
import type { Attachment, Buddy, GroupChat, Message, PickedFile } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, imMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, TextArea, Window, WindowBody, cx } from './controls';
import { FormattingToolbar, type FormattingState } from './FormattingToolbar';
import { MessageLog, TypingIndicator, formatBytes } from './MessageLog';
import { formatDuration } from './BuddyRow';
import { BuddyGlyph, GlyphAttachment } from './icons';
import { senderColor } from './senderColors';
import { EMOJI_SECTIONS } from './emoji';

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
  /** The ✉ toolbar button and the *Attach…* button: any file. */
  onAttach?: () => void;
  /** The 🖼 toolbar button: the same picker, filtered to images. Falls back to `onAttach`. */
  onAttachImage?: () => void;
  /**
   * Files chosen but not yet sent. Staged in the host, not here: the paths came from the main
   * process's picker and go back to it on send, and this component never learns what a path is
   * for beyond printing its name.
   */
  pendingFiles?: PickedFile[];
  onRemovePendingFile?: (path: string) => void;
  /** Addressed by ids — see the note on `attachment:open` in shared/types.ts. */
  onOpenAttachment?: (a: Attachment, messageId: string) => void;
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
  onAttachImage,
  pendingFiles = EMPTY_FILES,
  onRemovePendingFile,
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
  const [emoticonsOpen, setEmoticonsOpen] = React.useState(false);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);

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

  /**
   * A colour per member, in rooms only. Own lines are left to `--ink-me` — red already means
   * "you" and nothing is gained by moving it. A 1:1 window keeps AIM's two-colour convention
   * intact, which is all the attribution two people need.
   */
  const resolveSenderColor = React.useMemo(
    () =>
      group === null
        ? undefined
        : (m: Message): string | undefined => (m.outgoing ? undefined : senderColor(m.senderId)),
    [group]
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

  /**
   * Inserts text at the caret, the way a toolbar insertion is expected to behave — appending to
   * the end would be wrong the moment the user goes back to fix a word mid-sentence.
   *
   * Falls back to appending if the field has no selection to speak of, which is what a
   * never-focused textarea reports.
   */
  const insertAtCaret = (text: string) => {
    const field = inputRef.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);

    if (controlled) onDraftChange?.(next);
    else setLocalDraft(next);

    // The caret has to be restored after React has written the new value, or the browser puts
    // it at the end and the next keystroke lands in the wrong place.
    requestAnimationFrame(() => {
      const at = start + text.length;
      field?.focus();
      field?.setSelectionRange(at, at);
    });
  };

  const doSend = () => {
    const body = value.trim();
    // A file with no caption is an ordinary message; text with nothing else is too. Neither is
    // not.
    if ((!body && pendingFiles.length === 0) || blockedForSend) return;
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

  /**
   * The composer wears whatever the toolbar is set to.
   *
   * This is what makes the colour and size buttons honest rather than decorative: they change
   * something the user can see. It stops at this window — none of it reaches the wire, which is
   * what the toolbar's hover text says — but "local preview" is a real behaviour, and it is the
   * one AIM's own colour buttons had for anyone whose recipient did not render HTML.
   */
  const composerStyle: React.CSSProperties = {
    fontWeight: formatting?.bold === true ? 'bold' : undefined,
    fontStyle: formatting?.italic === true ? 'italic' : undefined,
    textDecoration: formatting?.underline === true ? 'underline' : undefined,
    fontFamily: formatting?.mono === true ? 'var(--aim-font-mono)' : undefined,
    fontSize: formatting?.fontSize === undefined ? undefined : `${formatting.fontSize}px`,
    color: formatting?.color,
    background: formatting?.background,
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
            resolveSenderColor={resolveSenderColor}
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
          onInsertImage={onAttachImage ?? onAttach}
          // Signal has no link markup — a URL in the body IS the link, and every client
          // autolinks it. So "insert link" is exactly "type a URL here", and the honest
          // implementation is a caret insertion with the scheme already filled in.
          onInsertLink={() => insertAtCaret('https://')}
          onInsertEmoticon={() => setEmoticonsOpen((open) => !open)}
          emoticonsOpen={emoticonsOpen}
          disabled={blockedForSend}
        />

        {emoticonsOpen ? (
          <EmojiPalette
            /* Stays open across picks: choosing three in a row is the common case, and a
               palette that closed after each one would make that four extra clicks. */
            onPick={insertAtCaret}
            onDismiss={() => setEmoticonsOpen(false)}
          />
        ) : null}

        <div className="aim-im__compose">
          {blockedForSend && blockReason ? (
            <div className="aim-im__warning">{blockReason}</div>
          ) : null}

          {pendingFiles.length > 0 ? (
            <ul className="aim-im__pending" aria-label="Files to send">
              {pendingFiles.map((file) => (
                <li key={file.path} className="aim-msg__chip" title={file.name}>
                  <GlyphAttachment size={12} />
                  <span className="aim-im__pending-name">{file.name}</span>
                  <span className="aim-msg__chip-meta">{formatBytes(file.size)}</span>
                  <button
                    type="button"
                    className="aim-im__pending-remove"
                    aria-label={`Remove ${file.name}`}
                    title={`Remove ${file.name}`}
                    onClick={() => onRemovePendingFile?.(file.path)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <TextArea
            ref={inputRef}
            className="aim-im__input"
            style={composerStyle}
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
              disabled={blockedForSend || (value.trim().length === 0 && pendingFiles.length === 0)}
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

/** Stable identity, so a host that passes nothing does not re-render the composer each time. */
const EMPTY_FILES: PickedFile[] = [];

/**
 * The emoji picker behind the smiley button.
 *
 * Unicode, not `:-)`. AIM's own menu inserted text and each end drew its own graphic — that is
 * era-correct and it is not what ships here, because it is not what the other end sees: a phone
 * renders 🙂, so the picker offers 🙂. A period-accurate control whose output nobody else's
 * client understands is a costume, not a feature.
 *
 * The chrome around it is still 2003: square corners, XP face, hard-edged buttons. It is the
 * glyphs that are modern, because the glyphs are the part that travels.
 */
function EmojiPalette({
  onPick,
  onDismiss,
}: {
  onPick: (emoji: string) => void;
  onDismiss: () => void;
}): React.ReactElement {
  const [section, setSection] = React.useState(0);
  const current = EMOJI_SECTIONS[section] ?? EMOJI_SECTIONS[0];

  return (
    <div
      className="aim-emoji"
      role="group"
      aria-label="Emoji"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDismiss();
      }}
    >
      <div className="aim-emoji__tabs" role="tablist" aria-label="Emoji categories">
        {EMOJI_SECTIONS.map((entry, index) => (
          <button
            key={entry.name}
            type="button"
            role="tab"
            aria-selected={index === section}
            className={cx('aim-emoji__tab', index === section && 'aim-emoji__tab--on')}
            title={entry.name}
            onClick={() => setSection(index)}
          >
            {entry.emoji[0]}
          </button>
        ))}
        <span className="aim-emoji__tabspacer" />
        <button
          type="button"
          className="aim-emoji__close"
          aria-label="Close emoji picker"
          title="Close"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>

      <div className="aim-emoji__grid" role="tabpanel" aria-label={current.name}>
        {current.emoji.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="aim-emoji__btn"
            aria-label={emoji}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
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
            {/* The same colour this member's lines carry in the log, so the list is a legend
                for the conversation rather than a second unrelated rendering of the roster.
                Own entry is left alone — it is already marked as self. */}
            <span
              className="aim-room__name"
              style={m.isSelf ? undefined : { color: senderColor(m.id) }}
            >
              {m.name}
            </span>
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
