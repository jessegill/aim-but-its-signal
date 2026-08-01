/**
 * MessageLog — the conversation history pane, plus a renderer for every message
 * type in SPEC.md §8.
 *
 * ===========================================================================
 * NO CHAT BUBBLES (SPEC.md §9). Not a rounded one, not a squared one, not a
 * tinted alignment block. Messages are plain flowed text in a white well:
 *
 *     (10:47:03 PM) Bob: hey, you around?  [♥ from Alice]
 *
 * Inline timestamp, bold coloured sender name, body. Own text red, theirs blue
 * — AIM's own defaults. Nothing is right-aligned; alignment-as-authorship is a
 * 2014 idea.
 * ===========================================================================
 *
 * Every §8 message type has a defined rendering here. Nothing is silently
 * dropped — a client that quietly swallows message types is lossy in a way the
 * user cannot see, which is worse than an ugly placeholder:
 *
 *   reactions      inline, bracketed:  [♥ from Bob]
 *   quote/reply    stub above the message, with a left rule
 *   edited         current text plus "(edited)" — never stale text
 *   attachments    inline thumbnail where practical, else a labelled chip
 *   view-once      refused, never displayed, never persisted
 *   voice notes    play if supported, else "open on phone"
 *   stickers       rendered, else a labelled placeholder
 *   tombstones     "unsent this message" — the original is gone from the store
 *   calls          "call — answer on phone", never silence
 *   identity       full SecurityNotice, never abbreviated
 */

import * as React from 'react';
import type { Attachment, Message, Reaction, ReceiptState } from '../../shared/types';
import { SecurityNotice } from './SecurityNotice';
import { cx } from './controls';
import {
  GlyphAttachment,
  GlyphCall,
  GlyphSticker,
  GlyphTombstone,
  GlyphTyping,
  GlyphVoice,
} from './icons';

/* ---------------------------------------------------------------------------
 * Formatting helpers
 * ------------------------------------------------------------------------ */

/** AIM's inline stamp: `(10:47:03 PM)`. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${mm}:${ss} ${h24 < 12 ? 'AM' : 'PM'}`;
}

export function formatDay(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  const yesterday = new Date(today.getTime() - 86400000);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const RECEIPT_TEXT: Record<ReceiptState, string> = {
  sending: 'sending…',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'NOT SENT',
};

/* ---------------------------------------------------------------------------
 * Reactions — inline, bracketed, never dropped.
 * ------------------------------------------------------------------------ */
export function Reactions({ reactions }: { reactions: Reaction[] }) {
  if (!reactions.length) return null;

  // Group identical emoji so ten hearts don't become ten brackets.
  const groups = new Map<string, string[]>();
  for (const r of reactions) {
    const list = groups.get(r.emoji);
    if (list) list.push(r.authorName);
    else groups.set(r.emoji, [r.authorName]);
  }

  return (
    <span className="aim-msg__reactions">
      {[...groups.entries()].map(([emoji, authors]) => (
        <span className="aim-msg__reaction" key={emoji}>
          [{emoji} from {authors.length <= 2 ? authors.join(' and ') : `${authors.length} people`}]
        </span>
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Quoted reply stub
 * ------------------------------------------------------------------------ */
export function QuoteStubView({
  quote,
  onClick,
}: {
  quote: NonNullable<Message['quote']>;
  onClick?: () => void;
}) {
  return (
    <div className="aim-msg__quote" onClick={onClick} title="Replying to this message">
      <span className="aim-msg__quote-author">{quote.authorName}: </span>
      {quote.text === null ? (
        <span className="aim-msg__quote-missing">
          (original message not available on this computer)
        </span>
      ) : (
        <span className="aim-msg__quote-text">{quote.text}</span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Attachments
 * ------------------------------------------------------------------------ */
export interface AttachmentViewProps {
  attachment: Attachment;
  /** Host may play voice notes; when false the fallback copy is shown. */
  canPlayVoice?: boolean;
  onOpen?: (a: Attachment) => void;
}

export function AttachmentView({ attachment: a, canPlayVoice, onOpen }: AttachmentViewProps) {
  // ---- View-once: refused, per SPEC.md §8. Never rendered, never persisted. --
  if (a.viewOnce) {
    return (
      <div className="aim-msg__chip aim-msg__viewonce" title="View-once media is not shown here">
        <GlyphAttachment size={12} />
        <span>
          <b>View-once media.</b> Not shown on this computer and not saved to disk — open it on your
          phone.
        </span>
      </div>
    );
  }

  // ---- Voice note ---------------------------------------------------------
  if (a.isVoiceNote) {
    return (
      <div className="aim-msg__chip">
        <GlyphVoice size={12} />
        {canPlayVoice && a.path ? (
          <>
            <span
              className="aim-msg__chip-link"
              role="button"
              tabIndex={0}
              onClick={() => onOpen?.(a)}
            >
              Play voice message
            </span>
            <span className="aim-msg__chip-meta">{formatBytes(a.size)}</span>
          </>
        ) : (
          <span>
            Voice message — <b>unsupported here, open on phone</b>
          </span>
        )}
      </div>
    );
  }

  // ---- Image: inline thumbnail where practical ----------------------------
  const isImage = a.contentType.startsWith('image/');
  if (isImage && a.path) {
    return (
      <img
        className="aim-msg__thumb"
        src={fileUrl(a.path)}
        alt={a.filename ?? 'Image attachment'}
        title={`${a.filename ?? 'image'} · ${formatBytes(a.size)}`}
        onClick={() => onOpen?.(a)}
      />
    );
  }

  // ---- Anything else: a clear labelled affordance -------------------------
  return (
    <div className="aim-msg__chip">
      <GlyphAttachment size={12} />
      <span
        className="aim-msg__chip-link"
        role="button"
        tabIndex={0}
        onClick={() => onOpen?.(a)}
        title={a.path ?? 'Not downloaded yet'}
      >
        {a.filename ?? a.contentType}
      </span>
      <span className="aim-msg__chip-meta">
        {formatBytes(a.size)}
        {a.path ? '' : ' · not downloaded'}
      </span>
    </div>
  );
}

function fileUrl(path: string): string {
  return path.startsWith('file:') || path.startsWith('data:') || path.startsWith('http')
    ? path
    : `file://${path}`;
}

/* ---------------------------------------------------------------------------
 * MessageRow — dispatches on `kind`
 * ------------------------------------------------------------------------ */
export interface MessageRowProps {
  message: Message;
  /** Display name for the local account. */
  selfName: string;
  /** Display name for the other party (nickname override already applied). */
  contactName: string;
  /** Override name resolution entirely — needed for group chats. */
  resolveName?: (m: Message) => string;
  canPlayVoice?: boolean;
  onOpenAttachment?: (a: Attachment) => void;
  onQuoteClick?: (quoteId: string) => void;
  /** Wired through to any SecurityNotice this row renders. */
  onVerifySafetyNumber?: () => void;
  safetyNumber?: string | null;
  className?: string;
}

export function MessageRow({
  message: m,
  selfName,
  contactName,
  resolveName,
  canPlayVoice,
  onOpenAttachment,
  onQuoteClick,
  onVerifySafetyNumber,
  safetyNumber,
  className,
}: MessageRowProps) {
  const name = resolveName ? resolveName(m) : m.outgoing ? selfName : contactName;
  const time = formatTime(m.sentAt);

  /* --- Identity change: full security treatment, never abbreviated -------- */
  if (m.kind === 'identity-change') {
    return (
      <SecurityNotice
        kind="identity-change"
        contactName={contactName}
        timestamp={time}
        safetyNumber={safetyNumber ?? m.body ?? null}
        onVerify={onVerifySafetyNumber}
        className={className}
      />
    );
  }

  /* --- Tombstone: deleted for everyone ------------------------------------ */
  if (m.kind === 'tombstone') {
    return (
      <div className={cx('aim-msg', 'aim-msg__system', 'aim-msg__tombstone', className)}>
        <span className="aim-msg__time">({time})</span>
        <GlyphTombstone size={11} />{' '}
        {m.outgoing ? 'You unsent a message.' : `${name} unsent a message.`}
      </div>
    );
  }

  /* --- Call notice: never stay silent about a call ------------------------ */
  if (m.kind === 'call') {
    return (
      <div className={cx('aim-msg', 'aim-msg__system', 'aim-msg__call', className)}>
        <span className="aim-msg__time">({time})</span>
        <GlyphCall size={12} />
        <span>
          {m.outgoing ? 'Outgoing call' : `Call from ${name}`} — <b>answer on phone.</b> Calls are
          not supported in this client.
        </span>
      </div>
    );
  }

  /* --- Generic system line ------------------------------------------------ */
  if (m.kind === 'system') {
    return (
      <div className={cx('aim-msg', 'aim-msg__system', className)}>
        <span className="aim-msg__time">({time})</span>
        {m.body}
      </div>
    );
  }

  /* --- Standalone reaction (target message not present locally) ----------- */
  if (m.kind === 'reaction') {
    return (
      <div className={cx('aim-msg', 'aim-msg__system', className)}>
        <span className="aim-msg__time">({time})</span>
        {name} reacted {m.body ?? ''} to an earlier message.
      </div>
    );
  }

  /* --- text / attachment / sticker / voice -------------------------------- */
  const hasBody = !!m.body && m.body.length > 0;

  return (
    <div className={cx('aim-msg', className)}>
      {m.quote ? (
        <QuoteStubView quote={m.quote} onClick={() => onQuoteClick?.(m.quote!.id)} />
      ) : null}

      <div>
        <span className="aim-msg__time">({time})</span>
        <span
          className={cx(
            'aim-msg__sender',
            m.outgoing ? 'aim-msg__sender--me' : 'aim-msg__sender--them'
          )}
        >
          {name}:
        </span>{' '}
        {hasBody ? <span className="aim-msg__body">{m.body}</span> : null}
        {!hasBody && m.kind === 'sticker' ? <span className="aim-dim">sent a sticker</span> : null}
        {!hasBody && m.kind === 'attachment' ? <span className="aim-dim">sent a file</span> : null}
        {!hasBody && m.kind === 'voice' ? (
          <span className="aim-dim">sent a voice message</span>
        ) : null}
        {/* Edit marker — the body above is always the CURRENT text. */}
        {m.editedAt ? (
          <span className="aim-msg__edit" title={`Edited at ${formatTime(m.editedAt)}`}>
            (edited)
          </span>
        ) : null}
        {m.expiresAt ? (
          <span className="aim-msg__edit" title={`Disappears at ${formatTime(m.expiresAt)}`}>
            ⧗
          </span>
        ) : null}
        <Reactions reactions={m.reactions} />
        {m.outgoing && m.receipt ? (
          <span
            className={cx('aim-msg__receipt', m.receipt === 'failed' && 'aim-msg__receipt--failed')}
            title={`Delivery: ${m.receipt}`}
          >
            {RECEIPT_TEXT[m.receipt]}
          </span>
        ) : null}
      </div>

      {m.kind === 'sticker' && m.attachments.length === 0 ? (
        <div className="aim-msg__sticker" title="Sticker">
          <span>
            <GlyphSticker size={24} />
            sticker
          </span>
        </div>
      ) : null}

      {m.attachments.map((a) => (
        <AttachmentView
          key={a.id}
          attachment={a}
          canPlayVoice={canPlayVoice}
          onOpen={onOpenAttachment}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Typing indicator — a real per-message protocol event, NOT presence
 * (SPEC.md §7). It means "this person is typing right now", which Signal does
 * transmit; it says nothing about whether they are online, idle, or away.
 * ------------------------------------------------------------------------ */
export function TypingIndicator({ name }: { name: string }) {
  return (
    <span className="aim-typing">
      <GlyphTyping size={11} />
      {name} is typing…
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * MessageLog
 * ------------------------------------------------------------------------ */
export interface MessageLogProps {
  messages: Message[];
  selfName: string;
  contactName: string;
  resolveName?: (m: Message) => string;
  canPlayVoice?: boolean;
  showDayDividers?: boolean;
  /** Stick to the bottom as messages arrive, unless the user scrolled up. */
  autoScroll?: boolean;
  emptyLabel?: string;
  safetyNumber?: string | null;
  onOpenAttachment?: (a: Attachment) => void;
  onQuoteClick?: (quoteId: string) => void;
  onVerifySafetyNumber?: () => void;
  /**
   * Rendered above the log body. Use for a persistent SecurityNotice that must
   * stay visible regardless of scroll position.
   */
  banner?: React.ReactNode;
  className?: string;
}

export function MessageLog({
  messages,
  selfName,
  contactName,
  resolveName,
  canPlayVoice,
  showDayDividers = true,
  autoScroll = true,
  emptyLabel = 'No messages yet. Say something.',
  safetyNumber,
  onOpenAttachment,
  onQuoteClick,
  onVerifySafetyNumber,
  banner,
  className,
}: MessageLogProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true);

  const onScroll = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  React.useEffect(() => {
    if (!autoScroll) return;
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages, autoScroll]);

  let lastDay = '';

  return (
    <div
      ref={ref}
      onScroll={onScroll}
      className={cx('aim-im__log', 'aim-log', className)}
      role="log"
      aria-live="polite"
    >
      {banner}

      {messages.length === 0 && !banner ? <div className="aim-log__empty">{emptyLabel}</div> : null}

      {messages.map((m) => {
        const day = formatDay(m.sentAt);
        const divider = showDayDividers && day !== lastDay;
        lastDay = day;
        return (
          <React.Fragment key={m.id}>
            {divider ? <div className="aim-msg__divider">{day}</div> : null}
            <MessageRow
              message={m}
              selfName={selfName}
              contactName={contactName}
              resolveName={resolveName}
              canPlayVoice={canPlayVoice}
              safetyNumber={safetyNumber}
              onOpenAttachment={onOpenAttachment}
              onQuoteClick={onQuoteClick}
              onVerifySafetyNumber={onVerifySafetyNumber}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
}
