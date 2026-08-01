/**
 * signal-cli JSON-RPC payloads → typed domain events.
 *
 * Every shape here is documented in docs/signal-cli-rpc.md, which was verified against the
 * tagged v0.14.6 source and a live daemon. Several are counter-intuitive; the comments say
 * which and why, because getting them wrong fails silently rather than loudly.
 *
 * This layer is deliberately total: an envelope it does not understand becomes `null` and is
 * ignored, never a half-populated message. It must not throw on unexpected input — a malformed
 * payload from the daemon should not take down message delivery.
 */

import type { BuddyId, ConversationId, MessageKind, ReceiptState } from '@shared/types';

// ---------------------------------------------------------------------------
// Domain events
// ---------------------------------------------------------------------------

export interface IncomingMessageEvent {
  type: 'message';
  conversationId: ConversationId;
  /** Who authored it. For sync messages this is the local user. */
  senderId: BuddyId;
  senderName: string | null;
  /** True when this account sent it, from any device. */
  outgoing: boolean;
  /** The sender's timestamp — the stable message identity across the whole protocol. */
  sentAt: number;
  receivedAt: number;
  body: string | null;
  /** Seconds; 0 means no timer. The absolute deadline is computed locally. */
  expiresInSeconds: number;
  viewOnce: boolean;
  kind: MessageKind;
  attachments: RawAttachment[];
  quote: QuoteRef | null;
  groupId: string | null;
}

export interface RawAttachment {
  id: string;
  contentType: string;
  filename: string | null;
  size: number | null;
  /** Path the daemon already wrote to disk before we saw this envelope. */
  path: string | null;
  isVoiceNote: boolean;
}

export interface QuoteRef {
  authorId: BuddyId;
  sentAt: number;
  authorName: string | null;
  text: string | null;
}

export interface ReactionEvent {
  type: 'reaction';
  conversationId: ConversationId;
  authorId: BuddyId;
  authorName: string | null;
  emoji: string;
  isRemove: boolean;
  targetAuthorId: BuddyId;
  targetSentAt: number;
}

export interface EditEvent {
  type: 'edit';
  conversationId: ConversationId;
  senderId: BuddyId;
  targetSentAt: number;
  body: string | null;
  editedAt: number;
}

export interface RemoteDeleteEvent {
  type: 'remote-delete';
  conversationId: ConversationId;
  senderId: BuddyId;
  targetSentAt: number;
}

export interface ReceiptEvent {
  type: 'receipt';
  senderId: BuddyId;
  state: ReceiptState;
  targetSentAts: number[];
}

export interface TypingEvent {
  type: 'typing';
  conversationId: ConversationId;
  senderId: BuddyId;
  isTyping: boolean;
}

export interface ExpirationUpdateEvent {
  type: 'expiration-update';
  conversationId: ConversationId;
  buddyId: BuddyId;
  expiresInSeconds: number;
}

export interface IdentityChangeEvent {
  type: 'identity-change';
  buddyId: BuddyId;
  buddyName: string | null;
}

export interface CallEvent {
  type: 'call';
  conversationId: ConversationId;
  senderId: BuddyId;
  sentAt: number;
}

/** The user read something on another device; clear local unread state. */
export interface SyncReadEvent {
  type: 'sync-read';
  targets: { senderId: BuddyId; sentAt: number }[];
}

export type DomainEvent =
  | IncomingMessageEvent
  | ReactionEvent
  | EditEvent
  | RemoteDeleteEvent
  | ReceiptEvent
  | TypingEvent
  | ExpirationUpdateEvent
  | IdentityChangeEvent
  | CallEvent
  | SyncReadEvent;

// ---------------------------------------------------------------------------
// Safe accessors
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function obj(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function bool(value: unknown): boolean {
  return value === true;
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ParseContext {
  /** The local account's own ACI, used to decide `outgoing` and to resolve Note to Self. */
  selfId: BuddyId;
}

/**
 * Normalises a `receive` notification's params and converts it to domain events.
 *
 * One envelope can yield more than one event (a message that also carries a reaction, a
 * receipt batch), so this returns an array. An unrecognised envelope yields `[]`.
 */
export function parseReceive(params: unknown, context: ParseContext): DomainEvent[] {
  const outer = obj(params);
  if (outer === null) return [];

  // An external `subscribeReceive` subscription wraps its payload in `result`; the internal
  // auto-subscription does not. We only use the internal one, but normalise defensively —
  // calling subscribeReceive in on-connection mode would deliver every event twice, in two
  // different shapes (docs/signal-cli-rpc.md §1).
  const payload = obj(outer.result) ?? outer;

  const events: DomainEvent[] = [];

  // An identity change arrives as `exception`, a *sibling* of `envelope` — not as a message
  // type. Parsing only `envelope` drops a security signal on the floor (SPEC.md §8).
  const exception = obj(payload.exception);
  if (exception !== null && str(exception.type) === 'UntrustedIdentityException') {
    const buddyId = str(exception.sender) ?? str(exception.senderUuid);
    if (buddyId !== null) {
      events.push({ type: 'identity-change', buddyId, buddyName: str(exception.senderName) });
    }
  }

  const envelope = obj(payload.envelope);
  if (envelope === null) return events;

  const sourceUuid = str(envelope.sourceUuid);
  const sourceName = str(envelope.sourceName);
  const envelopeTimestamp = num(envelope.timestamp);
  const receivedAt = num(envelope.serverDeliveredTimestamp) ?? Date.now();

  // All seven payload fields can be absent simultaneously — sender-key distribution, profile
  // key updates, null messages. Ignore silently; do not render an empty row.
  const dataMessage = obj(envelope.dataMessage);
  const syncMessage = obj(envelope.syncMessage);
  const editMessage = obj(envelope.editMessage);
  const receiptMessage = obj(envelope.receiptMessage);
  const typingMessage = obj(envelope.typingMessage);
  const callMessage = obj(envelope.callMessage);

  if (sourceUuid === null || envelopeTimestamp === null) return events;

  if (receiptMessage !== null) {
    events.push(...parseReceipt(receiptMessage, sourceUuid));
  }

  if (typingMessage !== null) {
    const groupId = str(typingMessage.groupId);
    events.push({
      type: 'typing',
      conversationId: groupId ?? sourceUuid,
      senderId: sourceUuid,
      isTyping: str(typingMessage.action) === 'STARTED',
    });
  }

  if (callMessage !== null) {
    events.push({
      type: 'call',
      conversationId: sourceUuid,
      senderId: sourceUuid,
      sentAt: envelopeTimestamp,
    });
  }

  if (editMessage !== null) {
    const target = num(editMessage.targetSentTimestamp);
    const inner = obj(editMessage.dataMessage);
    if (target !== null) {
      events.push({
        type: 'edit',
        conversationId: conversationForData(inner, sourceUuid),
        senderId: sourceUuid,
        targetSentAt: target,
        body: inner === null ? null : str(inner.message),
        editedAt: envelopeTimestamp,
      });
    }
  }

  if (dataMessage !== null) {
    events.push(
      ...parseDataMessage(dataMessage, {
        conversationId: conversationForData(dataMessage, sourceUuid),
        senderId: sourceUuid,
        senderName: sourceName,
        outgoing: sourceUuid === context.selfId,
        envelopeTimestamp,
        receivedAt,
      })
    );
  }

  if (syncMessage !== null) {
    events.push(...parseSyncMessage(syncMessage, context, envelopeTimestamp, receivedAt));
  }

  return events;
}

// ---------------------------------------------------------------------------
// Data messages
// ---------------------------------------------------------------------------

/**
 * A group message belongs to its group; a 1:1 message belongs to the peer. Note this is the
 * *inbound* rule — sync messages invert it and are handled separately.
 */
function conversationForData(dataMessage: Rec | null, sourceUuid: string): ConversationId {
  const groupInfo = dataMessage === null ? null : obj(dataMessage.groupInfo);
  return (groupInfo === null ? null : str(groupInfo.groupId)) ?? sourceUuid;
}

interface DataContext {
  conversationId: ConversationId;
  senderId: BuddyId;
  senderName: string | null;
  outgoing: boolean;
  envelopeTimestamp: number;
  receivedAt: number;
}

function parseDataMessage(dataMessage: Rec, context: DataContext): DomainEvent[] {
  const events: DomainEvent[] = [];

  // A timer change is an event about the conversation, not a message. Persisting it through the
  // message path would create a blank row in the log.
  if (bool(dataMessage.isExpirationUpdate)) {
    events.push({
      type: 'expiration-update',
      conversationId: context.conversationId,
      buddyId: context.senderId,
      expiresInSeconds: num(dataMessage.expiresInSeconds) ?? 0,
    });
    return events;
  }

  const remoteDelete = obj(dataMessage.remoteDelete);
  if (remoteDelete !== null) {
    const target = num(remoteDelete.timestamp);
    if (target !== null) {
      events.push({
        type: 'remote-delete',
        conversationId: context.conversationId,
        senderId: context.senderId,
        targetSentAt: target,
      });
    }
    return events;
  }

  const reaction = obj(dataMessage.reaction);
  if (reaction !== null) {
    const targetSentAt = num(reaction.targetSentTimestamp);
    const targetAuthorId = str(reaction.targetAuthorUuid) ?? str(reaction.targetAuthor);
    const emoji = str(reaction.emoji);
    if (targetSentAt !== null && targetAuthorId !== null && emoji !== null) {
      events.push({
        type: 'reaction',
        conversationId: context.conversationId,
        authorId: context.senderId,
        authorName: context.senderName,
        emoji,
        isRemove: bool(reaction.isRemove),
        targetAuthorId,
        targetSentAt,
      });
    }
    return events;
  }

  const attachments = parseAttachments(dataMessage);
  const body = str(dataMessage.message);
  const sticker = obj(dataMessage.sticker);
  const viewOnce = bool(dataMessage.viewOnce);

  /*
   * A data message with no body, no attachments and no sticker carries only protocol plumbing
   * (a profile key update, a group context refresh). Rendering it would produce an empty row.
   *
   * View-once is the exception, and it looks identical on the wire. Confirmed against real
   * captured traffic: a view-once envelope has NO `attachments` key and a null `message` —
   * signal-cli never hands us the media at all. That is exactly what SPEC.md §8 wants for
   * "never persist", but treating it as plumbing would drop the message entirely and the user
   * would never know anything was sent. §8 opens by calling that outcome quietly lossy and
   * misleading, so this emits an event with no content for the UI to render as a placeholder.
   */
  if (body === null && attachments.length === 0 && sticker === null && !viewOnce) return events;

  events.push({
    type: 'message',
    conversationId: context.conversationId,
    senderId: context.senderId,
    senderName: context.senderName,
    outgoing: context.outgoing,
    sentAt: num(dataMessage.timestamp) ?? context.envelopeTimestamp,
    receivedAt: context.receivedAt,
    body,
    expiresInSeconds: num(dataMessage.expiresInSeconds) ?? 0,
    viewOnce,
    kind: viewOnce ? 'attachment' : messageKind(sticker !== null, attachments),
    attachments,
    quote: parseQuote(dataMessage),
    groupId: groupIdOf(dataMessage),
  });

  return events;
}

function groupIdOf(dataMessage: Rec): string | null {
  const groupInfo = obj(dataMessage.groupInfo);
  return groupInfo === null ? null : str(groupInfo.groupId);
}

function messageKind(isSticker: boolean, attachments: RawAttachment[]): MessageKind {
  if (isSticker) return 'sticker';
  if (attachments.some((a) => a.isVoiceNote)) return 'voice';
  if (attachments.length > 0) return 'attachment';
  return 'text';
}

function parseAttachments(dataMessage: Rec): RawAttachment[] {
  return arr(dataMessage.attachments).flatMap((raw): RawAttachment[] => {
    const record = obj(raw);
    if (record === null) return [];
    const contentType = str(record.contentType) ?? 'application/octet-stream';
    const filename = str(record.filename);
    return [
      {
        id: str(record.id) ?? '',
        contentType,
        filename,
        size: num(record.size),
        path: str(record.file),
        // The JSON layer drops any explicit voice-note flag (docs/signal-cli-rpc.md §7), so
        // this heuristic — audio with no filename — is the only signal available. It is
        // flagged as unverified in the doc and should be re-checked against a real voice note.
        isVoiceNote: contentType.startsWith('audio/') && filename === null,
      },
    ];
  });
}

function parseQuote(dataMessage: Rec): QuoteRef | null {
  const quote = obj(dataMessage.quote);
  if (quote === null) return null;
  const sentAt = num(quote.id);
  const authorId = str(quote.authorUuid) ?? str(quote.author);
  if (sentAt === null || authorId === null) return null;
  return { authorId, sentAt, authorName: str(quote.authorName), text: str(quote.text) };
}

// ---------------------------------------------------------------------------
// Sync messages — SPEC.md §8's "easiest thing to get wrong"
// ---------------------------------------------------------------------------

/**
 * A message the user sent from another device (usually their phone).
 *
 * Two traps, both of which fail silently:
 *
 * 1. `sentMessage` is `@JsonUnwrapped` — the data-message fields sit *directly* on it. There is
 *    no `sentMessage.dataMessage`. Reading `sentMessage.dataMessage.message` yields `undefined`
 *    and the desktop stays quiet while the user types on their phone.
 * 2. The conversation is `destinationUuid`, **not** `sourceUuid`. Source is always the local
 *    user on a sync envelope, so using it routes every phone-sent message into a conversation
 *    with yourself.
 */
function parseSyncMessage(
  syncMessage: Rec,
  context: ParseContext,
  envelopeTimestamp: number,
  receivedAt: number
): DomainEvent[] {
  const events: DomainEvent[] = [];

  const readMessages = arr(syncMessage.readMessages);
  if (readMessages.length > 0) {
    const targets = readMessages.flatMap((raw) => {
      const record = obj(raw);
      if (record === null) return [];
      const senderId = str(record.senderUuid) ?? str(record.sender);
      const sentAt = num(record.timestamp);
      return senderId !== null && sentAt !== null ? [{ senderId, sentAt }] : [];
    });
    if (targets.length > 0) events.push({ type: 'sync-read', targets });
  }

  const sent = obj(syncMessage.sentMessage);
  // `syncMessage` is frequently an empty object — sync types the JSON layer does not model.
  // Ignore it, but never assume `sentMessage` exists.
  if (sent === null) return events;

  // Group sends have all `destination*` null and carry groupInfo instead.
  const groupInfo = obj(sent.groupInfo);
  const groupId = groupInfo === null ? null : str(groupInfo.groupId);
  const destination = str(sent.destinationUuid);
  const conversationId = groupId ?? destination;
  if (conversationId === null) return events;

  /*
   * An edit made on another device nests inside `sentMessage` as `sentMessage.editMessage`,
   * NOT at `envelope.editMessage` where a *received* edit arrives. Confirmed against real
   * captured traffic.
   *
   * Note the asymmetry with the surrounding message fields: `sentMessage` is @JsonUnwrapped,
   * but `editMessage.dataMessage` is genuinely nested. Falling through to parseDataMessage
   * here would find no body, no attachments and no sticker, return nothing, and leave the
   * pre-edit text on screen permanently — which SPEC.md §8 forbids ("never present stale text
   * as current").
   */
  const editMessage = obj(sent.editMessage);
  if (editMessage !== null) {
    const target = num(editMessage.targetSentTimestamp);
    const inner = obj(editMessage.dataMessage);
    if (target !== null) {
      events.push({
        type: 'edit',
        conversationId,
        senderId: context.selfId,
        targetSentAt: target,
        body: inner === null ? null : str(inner.message),
        editedAt: envelopeTimestamp,
      });
    }
    return events;
  }

  events.push(
    ...parseDataMessage(sent, {
      conversationId,
      senderId: context.selfId,
      senderName: null,
      outgoing: true,
      envelopeTimestamp,
      receivedAt,
    })
  );

  return events;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

function parseReceipt(receiptMessage: Rec, senderId: BuddyId): ReceiptEvent[] {
  const targets = arr(receiptMessage.timestamps).flatMap((value) => {
    const parsed = num(value);
    return parsed === null ? [] : [parsed];
  });
  if (targets.length === 0) return [];

  // A viewed receipt is not a read receipt, but for a text-first client "viewed" implies the
  // stronger state, so it maps to 'read' rather than being dropped.
  const state: ReceiptState = bool(receiptMessage.isRead)
    ? 'read'
    : bool(receiptMessage.isViewed)
      ? 'read'
      : 'delivered';

  return [{ type: 'receipt', senderId, state, targetSentAts: targets }];
}
