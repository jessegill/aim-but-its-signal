/**
 * Message persistence, expiry enforcement, the outbound queue, and the echo-protection
 * ledger.
 *
 * ---------------------------------------------------------------------------------------
 * DISAPPEARING MESSAGES (SPEC.md §8, §11.4)
 * ---------------------------------------------------------------------------------------
 * Expiry is enforced *here*, in the store, never in the UI. Two independent mechanisms:
 *
 *   1. A background sweeper deletes expired rows on a timer.
 *   2. Every public read path calls `sweepIfDue()` first AND filters
 *      `(expires_at IS NULL OR expires_at > now)` in SQL.
 *
 * (2) exists because (1) can be late — the process may have been asleep, the timer may not
 * have fired yet. An expired message can therefore never be returned, even in the window
 * before the sweeper runs. The SQL filter is what makes that a guarantee rather than a race.
 *
 * Deletion goes through `db.securePurge`, which checkpoints the WAL so the pre-delete page
 * images do not survive in the `-wal` file, and VACUUMs so the bytes are not merely unlinked.
 *
 * ---------------------------------------------------------------------------------------
 * PERSIST BEFORE ACKNOWLEDGE
 * ---------------------------------------------------------------------------------------
 * `persistInboundThenAck` is the only public way to record an inbound message. It commits
 * (with `synchronous = FULL`, so the WAL is fsynced) and only then invokes the caller's
 * acknowledge callback. There is deliberately no exported "insert and return" variant, so a
 * receive path cannot acknowledge to the daemon before the message is durable. A crash
 * between "received from Signal" and "written to disk" therefore leaves the message
 * unacknowledged and it will be redelivered.
 *
 * ---------------------------------------------------------------------------------------
 * MESSAGE IDENTITY — the tuple, and nothing else
 * ---------------------------------------------------------------------------------------
 * Verified against signal-cli 0.14.6: a message is identified by
 * `(author service id, sender's send timestamp)`. Every reaction, quote, edit, remote-delete
 * and receipt references its target by that tuple. There is **no stable server GUID in the
 * JSON envelopes**, so nothing here may depend on one.
 *
 * `messages.id` is therefore *derived*, never supplied: `id = `${senderId}:${sentAt}``. The
 * schema enforces it with `CHECK (id = sender_id || ':' || sent_at)`, so an id-keyed lookup
 * and a tuple-keyed lookup provably cannot disagree. Every reference-resolution path below
 * takes the tuple:
 *
 *   | reference        | entry point                              | resolves by      |
 *   |------------------|------------------------------------------|------------------|
 *   | redelivery       | `persistInboundThenAck`                  | (sender, sentAt) |
 *   | edit             | `applyEdit(senderId, targetSentAt, …)`   | (sender, sentAt) |
 *   | reaction         | `applyReaction({targetSenderId, …})`     | (sender, sentAt) |
 *   | remote delete    | `deleteForEveryone(senderId, sentAt)`    | (sender, sentAt) |
 *   | receipt          | `setReceiptByTimestamp(senderId, sentAt)`| (sender, sentAt) |
 *   | quote            | `PersistMessageInput.quote` (QuoteTarget)| (author, sentAt) |
 *
 * ---------------------------------------------------------------------------------------
 * THE EXPIRY CLOCK IS OURS
 * ---------------------------------------------------------------------------------------
 * There is **no `expirationStartTimestamp` in any envelope** — the daemon never tells us when
 * a disappearing-message timer started. This layer computes every deadline itself, from
 * `dataMessage.expiresInSeconds` and a local clock, via {@link computeExpiresAt}. Nothing
 * here reads a daemon-supplied start time; there is nowhere it could enter.
 */

import type {
  Attachment,
  BuddyId,
  ConversationId,
  Message,
  MessageKind,
  Reaction,
  ReceiptState,
} from '../../shared/types.ts';

import type { SqliteBindValue, StoreDatabase } from './db.ts';
import type { AttachmentCache } from './attachments.ts';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * A quote's target, given as the tuple the protocol actually uses. The store derives
 * `quote_id` from it; callers never construct an id, so a quote can never point at a
 * message id that no message has.
 */
export interface QuoteTarget {
  authorId: BuddyId;
  /** The quoted message's own send timestamp (`quote.id` in the envelope). */
  sentAt: number;
  authorName: string;
  /** Text as the sender quoted it. Null when unavailable. */
  text: string | null;
}

export interface PersistMessageInput {
  conversationId: ConversationId;
  senderId: BuddyId;
  outgoing: boolean;
  body: string | null;
  sentAt: number;
  receivedAt?: number | null;
  /** Absolute expiry in ms. Null = never. */
  expiresAt?: number | null;
  editedAt?: number | null;
  kind: MessageKind;
  receipt?: ReceiptState | null;
  quote?: QuoteTarget | null;
  attachments?: Attachment[];
}

export interface PersistResult {
  message: Message;
  /** False when the natural key already existed — i.e. this was a redelivery. */
  inserted: boolean;
}

export interface ExpiredRef {
  id: string;
  conversationId: ConversationId;
}

export type OutboundState = 'queued' | 'sending' | 'sent' | 'failed';

export interface OutboundRow {
  id: string;
  conversationId: ConversationId;
  recipientId: BuddyId | null;
  body: string | null;
  attachments: string[];
  createdAt: number;
  sentTimestamp: number | null;
  state: OutboundState;
  retryCount: number;
  nextAttemptAt: number;
  lastError: string | null;
  expiresAt: number | null;
}

export interface EnqueueOutboundInput {
  id: string;
  conversationId: ConversationId;
  recipientId: BuddyId | null;
  body: string | null;
  attachments?: string[];
  expiresAt?: number | null;
  now?: number;
}

export interface MessageStoreOptions {
  /** Sweeper period. Default 10s. */
  sweepIntervalMs?: number;
  /** Injected for deterministic tests. */
  now?: () => number;
}

export interface MessageStore {
  // -- inbound ------------------------------------------------------------
  persistInboundThenAck<T>(
    input: PersistMessageInput,
    acknowledge: (message: Message, inserted: boolean) => T
  ): T;

  // -- reads (all expiry-safe) --------------------------------------------
  getMessages(
    conversationId: ConversationId,
    opts?: { limit?: number; beforeSentAt?: number }
  ): Message[];
  getMessage(id: string): Message | null;
  getMessageByNaturalKey(senderId: BuddyId, sentAt: number): Message | null;
  getLatestMessage(conversationId: ConversationId): Message | null;
  countMessages(conversationId: ConversationId): number;
  listConversationIds(): ConversationId[];

  // -- mutations ----------------------------------------------------------
  applyEdit(
    senderId: BuddyId,
    targetSentAt: number,
    body: string | null,
    editedAt: number
  ): Message | null;
  applyReaction(input: {
    targetSenderId: BuddyId;
    targetSentAt: number;
    authorId: BuddyId;
    authorName: string;
    emoji: string;
    remove?: boolean;
    receivedAt?: number;
  }): Message | null;
  /**
   * Local-only receipt update, for a message the UI already holds. Inbound receipts from the
   * daemon carry a timestamp, not an id — use {@link setReceiptByTimestamp} for those.
   */
  setReceipt(messageId: string, state: ReceiptState): void;
  /** The path for daemon receipts: they reference their target by (author, sentAt). */
  setReceiptByTimestamp(senderId: BuddyId, sentAt: number, state: ReceiptState): void;
  /** Starts a disappearing-message timer relative to `from` (default now). */
  startExpiryTimer(messageId: string, seconds: number, from?: number): number | null;
  /** Applies a timer to every message in a conversation that has none yet (e.g. on read). */
  startExpiryTimersForConversation(
    conversationId: ConversationId,
    seconds: number,
    from?: number
  ): number;

  // -- security-critical --------------------------------------------------
  deleteForEveryone(targetSenderId: BuddyId, targetSentAt: number, deletedAt?: number): Message;
  sweepExpired(now?: number): ExpiredRef[];
  startExpirySweeper(onRemoved?: (removed: ExpiredRef[]) => void): void;
  stopExpirySweeper(): void;

  // -- outbound queue / echo ledger ---------------------------------------
  enqueueOutbound(input: EnqueueOutboundInput): OutboundRow;
  markOutboundSending(id: string, now?: number): void;
  markOutboundSent(id: string, sentTimestamp: number, selfId: BuddyId, now?: number): Message;
  markOutboundFailed(id: string, error: string, retryAfterMs?: number, now?: number): void;
  listPendingOutbound(now?: number): OutboundRow[];
  getOutbound(id: string): OutboundRow | null;
  /** Reclaims rows stuck in `sending` after a crash. Returns how many were reclaimed. */
  recoverInterruptedSends(now?: number): number;
  /** Echo protection: did this account send a message with this timestamp? */
  wasSentByUs(sentTimestamp: number): boolean;
  /** Drops ledger rows older than `before`, keeping the table bounded. */
  pruneEchoLedger(before: number): number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The one and only way a `messages.id` is produced. Enforced by the schema's
 * `CHECK (id = sender_id || ':' || sent_at)`.
 */
export function deriveMessageId(senderId: BuddyId, sentAt: number): string {
  return `${senderId}:${sentAt}`;
}

/**
 * Turns `dataMessage.expiresInSeconds` into an absolute deadline.
 *
 * The daemon does **not** send an `expirationStartTimestamp` — there is no such field in any
 * envelope — so the app owns the expiry clock outright. `startedAt` is a local timestamp: use
 * the receive time for incoming messages, and the read time if you are implementing
 * read-triggered timers (see `startExpiryTimer`).
 *
 * Returns null for a zero/absent/invalid timer, which is the "never expires" case.
 */
export function computeExpiresAt(
  expiresInSeconds: number | null | undefined,
  startedAt: number
): number | null {
  if (expiresInSeconds == null) return null;
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return null;
  return startedAt + Math.floor(expiresInSeconds) * 1000;
}

function bool(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

const NOT_EXPIRED = '(m.expires_at IS NULL OR m.expires_at > ?)';

interface AttachmentRow {
  id: string;
  message_id: string;
  sort_order: number;
  content_type: string;
  filename: string | null;
  size: number | null;
  path: string | null;
  view_once: number;
  is_voice_note: number;
}

interface ReactionRow {
  message_id: string;
  author_id: string;
  author_name: string;
  emoji: string;
  received_at: number;
}

interface OutboundQueueRow {
  id: string;
  conversation_id: string;
  recipient_id: string | null;
  body: string | null;
  attachments_json: string | null;
  created_at: number;
  sent_timestamp: number | null;
  state: OutboundState;
  retry_count: number;
  next_attempt_at: number;
  last_error: string | null;
  expires_at: number | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  outgoing: number;
  body: string | null;
  sent_at: number;
  received_at: number | null;
  expires_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  quote_id: string | null;
  quote_author_id: string | null;
  quote_sent_at: number | null;
  quote_author_name: string | null;
  quote_text: string | null;
  kind: string;
  receipt: string | null;
  had_view_once: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMessageStore(
  db: StoreDatabase,
  attachmentCache: AttachmentCache,
  options: MessageStoreOptions = {}
): MessageStore {
  const sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const raw = db.raw;

  /**
   * Earliest known `expires_at` across messages and the outbound queue.
   * `undefined` means "not yet computed"; `null` means "nothing expires".
   */
  let nextExpiryAt: number | null | undefined = undefined;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let onRemovedCallback: ((removed: ExpiredRef[]) => void) | null = null;

  // -- prepared statements -------------------------------------------------

  const insertMessage = raw.prepare(`
    INSERT INTO messages (
      id, conversation_id, sender_id, outgoing, body, sent_at, received_at, expires_at,
      edited_at, deleted_at, quote_id, quote_author_id, quote_sent_at, quote_author_name,
      quote_text, kind, receipt, had_view_once
    ) VALUES (
      @id, @conversation_id, @sender_id, @outgoing, @body, @sent_at, @received_at, @expires_at,
      @edited_at, @deleted_at, @quote_id, @quote_author_id, @quote_sent_at, @quote_author_name,
      @quote_text, @kind, @receipt, @had_view_once
    )
    ON CONFLICT(sender_id, sent_at) DO NOTHING
  `);

  const insertAttachment = raw.prepare(`
    INSERT INTO attachments (
      id, message_id, sort_order, content_type, filename, size, path, view_once, is_voice_note
    ) VALUES (@id, @message_id, @sort_order, @content_type, @filename, @size, @path, 0, @is_voice_note)
    ON CONFLICT(id) DO NOTHING
  `);

  const selectByNaturalKey = raw.prepare(
    `SELECT * FROM messages m WHERE m.sender_id = ? AND m.sent_at = ?`
  );
  const selectById = raw.prepare(`SELECT * FROM messages m WHERE m.id = ?`);
  const minExpiry = raw.prepare(`
    SELECT MIN(e) AS next FROM (
      SELECT MIN(expires_at) AS e FROM messages       WHERE expires_at IS NOT NULL
      UNION ALL
      SELECT MIN(expires_at) AS e FROM outbound_queue WHERE expires_at IS NOT NULL
    )
  `);

  // -- expiry --------------------------------------------------------------

  function refreshNextExpiry(): void {
    const row = minExpiry.get() as { next: number | null } | undefined;
    nextExpiryAt = row?.next ?? null;
  }

  function noteExpiry(expiresAt: number | null | undefined): void {
    if (expiresAt == null) return;
    if (nextExpiryAt === undefined || nextExpiryAt === null || expiresAt < nextExpiryAt) {
      nextExpiryAt = expiresAt;
    }
  }

  /**
   * Runs a sweep when something is known to be due. Called at the top of every read path, so
   * expired rows are gone before a read can observe them even if the timer has not fired.
   */
  function sweepIfDue(at: number): void {
    if (nextExpiryAt === undefined) refreshNextExpiry();
    if (nextExpiryAt !== null && nextExpiryAt !== undefined && nextExpiryAt <= at) {
      sweepExpired(at);
    }
  }

  function sweepExpired(at: number = now()): ExpiredRef[] {
    const doomed = raw
      .prepare(
        `SELECT id, conversation_id FROM messages
          WHERE expires_at IS NOT NULL AND expires_at <= ?`
      )
      .all(at) as { id: string; conversation_id: string }[];

    const doomedIds = doomed.map((row) => row.id);

    const paths =
      doomedIds.length === 0
        ? []
        : (raw
            .prepare(
              `SELECT path FROM attachments
                WHERE path IS NOT NULL AND message_id IN (${placeholders(doomedIds.length)})`
            )
            .pluck()
            .all(...doomedIds) as string[]);

    const purgedQueue = db.securePurge(() => {
      // Denormalised quote copies of an expiring message must go too, or the body survives
      // inside whatever quoted it.
      raw
        .prepare(
          `UPDATE messages SET quote_text = NULL
            WHERE quote_id IN (SELECT id FROM messages
                                WHERE expires_at IS NOT NULL AND expires_at <= ?)`
        )
        .run(at);

      // Cascades remove attachments and reactions.
      raw.prepare(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?`).run(at);

      // The outbound queue holds message bodies before a send completes. An ephemeral message
      // must not outlive its timer there either.
      return raw
        .prepare(`DELETE FROM outbound_queue WHERE expires_at IS NOT NULL AND expires_at <= ?`)
        .run(at).changes;
    });

    if (doomedIds.length > 0 || purgedQueue > 0) {
      attachmentCache.shredAll(paths);
      for (const id of doomedIds) attachmentCache.purgeMessage(id);
    }

    refreshNextExpiry();

    return doomed.map((row) => ({ id: row.id, conversationId: row.conversation_id }));
  }

  // -- hydration -----------------------------------------------------------

  function loadAttachments(messageIds: string[]): Map<string, Attachment[]> {
    const out = new Map<string, Attachment[]>();
    if (messageIds.length === 0) return out;
    const rows = raw
      .prepare<AttachmentRow>(
        `SELECT * FROM attachments
          WHERE message_id IN (${placeholders(messageIds.length)})
          ORDER BY message_id, sort_order`
      )
      .all(...messageIds);
    for (const row of rows) {
      const list = out.get(row.message_id) ?? [];
      list.push({
        id: row.id,
        contentType: row.content_type,
        filename: row.filename,
        size: row.size,
        path: row.path,
        // Always false: view-once media is never in this table (CHECK constraint).
        viewOnce: false,
        isVoiceNote: row.is_voice_note === 1,
      });
      out.set(row.message_id, list);
    }
    return out;
  }

  function loadReactions(messageIds: string[]): Map<string, Reaction[]> {
    const out = new Map<string, Reaction[]>();
    if (messageIds.length === 0) return out;
    const rows = raw
      .prepare<ReactionRow>(
        `SELECT * FROM reactions
          WHERE message_id IN (${placeholders(messageIds.length)})
          ORDER BY message_id, received_at`
      )
      .all(...messageIds);
    for (const row of rows) {
      const list = out.get(row.message_id) ?? [];
      list.push({ emoji: row.emoji, authorId: row.author_id, authorName: row.author_name });
      out.set(row.message_id, list);
    }
    return out;
  }

  function hydrate(rows: MessageRow[]): Message[] {
    const ids = rows.map((row) => row.id);
    const attachments = loadAttachments(ids);
    const reactions = loadReactions(ids);
    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderId: row.sender_id,
      outgoing: row.outgoing === 1,
      body: row.body,
      sentAt: row.sent_at,
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
      editedAt: row.edited_at,
      quote: row.quote_id
        ? {
            id: row.quote_id,
            authorId: row.quote_author_id ?? '',
            authorName: row.quote_author_name ?? '',
            text: row.quote_text,
          }
        : null,
      reactions: reactions.get(row.id) ?? [],
      attachments: attachments.get(row.id) ?? [],
      kind: row.kind as MessageKind,
      receipt: (row.receipt as ReceiptState | null) ?? null,
    }));
  }

  function hydrateOne(row: MessageRow | undefined): Message | null {
    if (!row) return null;
    return hydrate([row])[0] ?? null;
  }

  // -- writes --------------------------------------------------------------

  /**
   * Not exported. The only public inbound path is {@link persistInboundThenAck}, so a caller
   * cannot obtain a message object before the transaction has committed.
   */
  function persistInbound(input: PersistMessageInput): PersistResult {
    // Derived, never supplied — see "MESSAGE IDENTITY" above. The schema CHECK enforces it.
    const id = deriveMessageId(input.senderId, input.sentAt);
    const incoming = input.attachments ?? [];
    const hadViewOnce = incoming.some((a) => a.viewOnce);

    // Redelivery: the natural key already exists. Return the stored row untouched rather than
    // re-copying attachments over the ones already cached.
    const already = selectByNaturalKey.get(input.senderId, input.sentAt) as MessageRow | undefined;
    if (already) {
      // A redelivered view-once attachment still has a freshly downloaded file to destroy.
      for (const attachment of incoming) {
        if (attachment.viewOnce) attachmentCache.shred(attachment.path);
      }
      const stored = hydrateOne(already);
      if (!stored) throw new Error(`Message ${id} could not be re-read after redelivery.`);
      return { message: stored, inserted: false };
    }

    // View-once media never reaches the database or the cache (SPEC.md §8). The message row
    // is still recorded — with `had_view_once` set — so the conversation is not silently
    // lossy and the UI can render "view-once media, open on phone".
    const persistable: Attachment[] = [];
    for (const attachment of incoming) {
      const ingested = attachmentCache.ingest(id, attachment);
      if (ingested) persistable.push(ingested);
    }

    const write = db.transaction(() => {
      const result = insertMessage.run({
        id,
        conversation_id: input.conversationId,
        sender_id: input.senderId,
        outgoing: bool(input.outgoing),
        body: input.body ?? null,
        sent_at: input.sentAt,
        received_at: input.receivedAt ?? null,
        expires_at: input.expiresAt ?? null,
        edited_at: input.editedAt ?? null,
        deleted_at: null,
        quote_id: input.quote ? deriveMessageId(input.quote.authorId, input.quote.sentAt) : null,
        quote_author_id: input.quote?.authorId ?? null,
        quote_sent_at: input.quote?.sentAt ?? null,
        quote_author_name: input.quote?.authorName ?? null,
        quote_text: input.quote?.text ?? null,
        kind: input.kind,
        receipt: input.receipt ?? null,
        had_view_once: bool(hadViewOnce),
      });

      const inserted = result.changes === 1;
      if (inserted) {
        let order = 0;
        for (const attachment of persistable) {
          insertAttachment.run({
            id: attachment.id,
            message_id: id,
            sort_order: order++,
            content_type: attachment.contentType,
            filename: attachment.filename ?? null,
            size: attachment.size ?? null,
            path: attachment.path ?? null,
            is_voice_note: bool(attachment.isVoiceNote),
          });
        }
      }
      return inserted;
    });

    const inserted = write();
    if (inserted) noteExpiry(input.expiresAt ?? null);

    const row = (selectByNaturalKey.get(input.senderId, input.sentAt) ?? undefined) as
      MessageRow | undefined;
    const message = hydrateOne(row);
    if (!message) {
      throw new Error(
        `Message ${id} vanished immediately after being written. This indicates database ` +
          `corruption or a concurrent writer outside the main process.`
      );
    }
    return { message, inserted };
  }

  function persistInboundThenAck<T>(
    input: PersistMessageInput,
    acknowledge: (message: Message, inserted: boolean) => T
  ): T {
    // The transaction inside persistInbound has committed and (synchronous = FULL) been
    // fsynced by the time we get here. Only now may the caller tell the daemon it has the
    // message. A throw from `acknowledge` does not roll anything back — that is correct: the
    // message is durable, and redelivery is idempotent.
    const { message, inserted } = persistInbound(input);
    return acknowledge(message, inserted);
  }

  // -- outbound ------------------------------------------------------------

  function outboundRow(row: OutboundQueueRow | undefined): OutboundRow | null {
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      recipientId: row.recipient_id,
      body: row.body,
      attachments: row.attachments_json ? (JSON.parse(row.attachments_json) as string[]) : [],
      createdAt: row.created_at,
      sentTimestamp: row.sent_timestamp,
      state: row.state,
      retryCount: row.retry_count,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      expiresAt: row.expires_at,
    };
  }

  const store: MessageStore = {
    persistInboundThenAck,

    // -- reads -------------------------------------------------------------

    getMessages(conversationId, opts = {}) {
      const at = now();
      sweepIfDue(at);
      const limit = Math.max(1, Math.min(opts.limit ?? 500, 5_000));
      const params: SqliteBindValue[] = [conversationId, at];
      let sql = `SELECT * FROM messages m WHERE m.conversation_id = ? AND ${NOT_EXPIRED}`;
      if (opts.beforeSentAt != null) {
        sql += ` AND m.sent_at < ?`;
        params.push(opts.beforeSentAt);
      }
      sql += ` ORDER BY m.sent_at DESC LIMIT ?`;
      params.push(limit);
      const rows = raw.prepare<MessageRow>(sql).all(...params);
      return hydrate(rows.reverse());
    },

    getMessage(id) {
      const at = now();
      sweepIfDue(at);
      const row = selectById.get(id) as MessageRow | undefined;
      if (!row) return null;
      if (row.expires_at != null && row.expires_at <= at) return null;
      return hydrateOne(row);
    },

    getMessageByNaturalKey(senderId, sentAt) {
      const at = now();
      sweepIfDue(at);
      const row = selectByNaturalKey.get(senderId, sentAt) as MessageRow | undefined;
      if (!row) return null;
      if (row.expires_at != null && row.expires_at <= at) return null;
      return hydrateOne(row);
    },

    getLatestMessage(conversationId) {
      const at = now();
      sweepIfDue(at);
      const row = raw
        .prepare(
          `SELECT * FROM messages m
            WHERE m.conversation_id = ? AND ${NOT_EXPIRED}
            ORDER BY m.sent_at DESC LIMIT 1`
        )
        .get(conversationId, at) as MessageRow | undefined;
      return hydrateOne(row);
    },

    countMessages(conversationId) {
      const at = now();
      sweepIfDue(at);
      return Number(
        raw
          .prepare(`SELECT count(*) FROM messages m WHERE m.conversation_id = ? AND ${NOT_EXPIRED}`)
          .pluck()
          .get(conversationId, at)
      );
    },

    listConversationIds() {
      const at = now();
      sweepIfDue(at);
      return raw
        .prepare(
          `SELECT DISTINCT m.conversation_id FROM messages m WHERE ${NOT_EXPIRED}
            ORDER BY m.conversation_id`
        )
        .pluck()
        .all(at) as string[];
    },

    // -- mutations ---------------------------------------------------------

    applyEdit(senderId, targetSentAt, body, editedAt) {
      const at = now();
      sweepIfDue(at);
      // The previous text must not survive the edit — SPEC.md §8 forbids presenting stale
      // text as current, and a leftover copy in a freed page is exactly that.
      db.securePurge(() => {
        raw
          .prepare(
            `UPDATE messages SET body = ?, edited_at = ? WHERE sender_id = ? AND sent_at = ?`
          )
          .run(body, editedAt, senderId, targetSentAt);
      });
      return store.getMessageByNaturalKey(senderId, targetSentAt);
    },

    applyReaction(input) {
      const at = input.receivedAt ?? now();
      sweepIfDue(at);
      const target = selectByNaturalKey.get(input.targetSenderId, input.targetSentAt) as
        MessageRow | undefined;
      if (!target) return null;
      if (target.expires_at != null && target.expires_at <= at) return null;

      const apply = db.transaction(() => {
        if (input.remove) {
          raw
            .prepare(`DELETE FROM reactions WHERE message_id = ? AND author_id = ?`)
            .run(target.id, input.authorId);
        } else {
          raw
            .prepare(
              `INSERT INTO reactions (message_id, author_id, author_name, emoji, received_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(message_id, author_id)
               DO UPDATE SET emoji = excluded.emoji,
                             author_name = excluded.author_name,
                             received_at = excluded.received_at`
            )
            .run(target.id, input.authorId, input.authorName, input.emoji, at);
        }
      });
      apply();
      return store.getMessage(target.id);
    },

    setReceipt(messageId, state) {
      raw.prepare(`UPDATE messages SET receipt = ? WHERE id = ?`).run(state, messageId);
    },

    setReceiptByTimestamp(senderId, sentAt, state) {
      raw
        .prepare(`UPDATE messages SET receipt = ? WHERE sender_id = ? AND sent_at = ?`)
        .run(state, senderId, sentAt);
    },

    startExpiryTimer(messageId, seconds, from) {
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      const base = from ?? now();
      const expiresAt = base + Math.floor(seconds) * 1000;
      const changed = raw
        .prepare(
          `UPDATE messages SET expires_at = ?
            WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)`
        )
        .run(expiresAt, messageId, expiresAt).changes;
      if (changed > 0) noteExpiry(expiresAt);
      return changed > 0 ? expiresAt : null;
    },

    startExpiryTimersForConversation(conversationId, seconds, from) {
      if (!Number.isFinite(seconds) || seconds <= 0) return 0;
      const base = from ?? now();
      const expiresAt = base + Math.floor(seconds) * 1000;
      const changed = raw
        .prepare(
          `UPDATE messages SET expires_at = ?
            WHERE conversation_id = ? AND expires_at IS NULL AND kind != 'tombstone'`
        )
        .run(expiresAt, conversationId).changes;
      if (changed > 0) noteExpiry(expiresAt);
      return changed;
    },

    // -- security-critical -------------------------------------------------

    deleteForEveryone(targetSenderId, targetSentAt, deletedAt) {
      const at = deletedAt ?? now();
      const existing = selectByNaturalKey.get(targetSenderId, targetSentAt) as
        MessageRow | undefined;

      const id = existing?.id ?? deriveMessageId(targetSenderId, targetSentAt);
      const conversationId = existing?.conversation_id ?? targetSenderId;
      const outgoing = existing?.outgoing ?? 0;
      const receivedAt = existing?.received_at ?? null;
      const expiresAt = existing?.expires_at ?? null;

      const paths = (
        raw
          .prepare(`SELECT path FROM attachments WHERE message_id = ? AND path IS NOT NULL`)
          .pluck()
          .all(id) as string[]
      ).slice();

      db.securePurge(
        () => {
          // Any denormalised copy of this body inside a quote must go too.
          raw
            .prepare(
              `UPDATE messages SET quote_text = NULL
                WHERE quote_author_id = ? AND quote_sent_at = ?`
            )
            .run(targetSenderId, targetSentAt);

          // DELETE then INSERT rather than UPDATE ... SET body = NULL: with
          // secure_delete = ON, deleting the record zeroes the freed cell, whereas an
          // in-place update can leave the longer original text in the page's free space.
          raw.prepare(`DELETE FROM messages WHERE id = ?`).run(id);

          raw
            .prepare(
              `INSERT INTO messages (
                 id, conversation_id, sender_id, outgoing, body, sent_at, received_at,
                 expires_at, edited_at, deleted_at, quote_id, quote_author_id, quote_sent_at,
                 quote_author_name, quote_text, kind, receipt, had_view_once
               ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL,
                         'tombstone', NULL, 0)`
            )
            .run(
              id,
              conversationId,
              targetSenderId,
              outgoing,
              targetSentAt,
              receivedAt,
              expiresAt,
              at
            );

          // If it was ours and still sitting in the queue, purge the queued copy of the body.
          raw
            .prepare(
              `UPDATE outbound_queue SET body = NULL, attachments_json = NULL
                WHERE sent_timestamp = ?`
            )
            .run(targetSentAt);
        },
        // Rare and user-visible: pay for a full rebuild so the original body is really gone.
        { forceVacuum: true }
      );

      attachmentCache.shredAll(paths);
      attachmentCache.purgeMessage(id);

      const tombstone = hydrateOne(selectById.get(id) as MessageRow | undefined);
      if (!tombstone) {
        throw new Error(`Failed to write tombstone for ${id}.`);
      }
      return tombstone;
    },

    sweepExpired,

    startExpirySweeper(onRemoved) {
      if (onRemoved) onRemovedCallback = onRemoved;
      if (sweepTimer) return;
      refreshNextExpiry();
      sweepTimer = setInterval(() => {
        const removed = sweepExpired(now());
        if (removed.length > 0 && onRemovedCallback) onRemovedCallback(removed);
      }, sweepIntervalMs);
      // Never hold the process open just to sweep.
      if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    },

    stopExpirySweeper() {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      onRemovedCallback = null;
    },

    // -- outbound queue ----------------------------------------------------

    enqueueOutbound(input) {
      const at = input.now ?? now();
      const row: OutboundQueueRow = {
        id: input.id,
        conversation_id: input.conversationId,
        recipient_id: input.recipientId ?? null,
        body: input.body ?? null,
        attachments_json:
          input.attachments && input.attachments.length > 0
            ? JSON.stringify(input.attachments)
            : null,
        created_at: at,
        sent_timestamp: null,
        state: 'queued' as const,
        retry_count: 0,
        next_attempt_at: at,
        last_error: null,
        expires_at: input.expiresAt ?? null,
      };
      raw
        .prepare(
          `INSERT INTO outbound_queue (
             id, conversation_id, recipient_id, body, attachments_json, created_at,
             sent_timestamp, state, retry_count, next_attempt_at, last_error, expires_at
           ) VALUES (
             @id, @conversation_id, @recipient_id, @body, @attachments_json, @created_at,
             @sent_timestamp, @state, @retry_count, @next_attempt_at, @last_error, @expires_at
           )`
        )
        // Spread: an interface has no implicit index signature, so it is not directly
        // assignable to the named-bindings parameter type.
        .run({ ...row });
      noteExpiry(input.expiresAt ?? null);
      return outboundRow(row)!;
    },

    markOutboundSending(id, at) {
      raw
        .prepare(`UPDATE outbound_queue SET state = 'sending', next_attempt_at = ? WHERE id = ?`)
        .run(at ?? now(), id);
    },

    markOutboundSent(id, sentTimestamp, selfId, at) {
      const stamp = at ?? now();
      const commit = db.transaction(() => {
        const queued = raw
          .prepare<OutboundQueueRow>(`SELECT * FROM outbound_queue WHERE id = ?`)
          .get(id);
        if (!queued) {
          throw new Error(`markOutboundSent: no queued message ${id}. Enqueue before sending.`);
        }

        insertMessage.run({
          // The queue row's id is a client-generated handle for the *send attempt*. The
          // message's identity is the tuple, which only exists once the daemon assigns the
          // send timestamp — so the history row is keyed by (selfId, sentTimestamp), not by
          // the queue handle.
          id: deriveMessageId(selfId, sentTimestamp),
          conversation_id: queued.conversation_id,
          sender_id: selfId,
          outgoing: 1,
          body: queued.body ?? null,
          sent_at: sentTimestamp,
          received_at: stamp,
          expires_at: queued.expires_at ?? null,
          edited_at: null,
          deleted_at: null,
          quote_id: null,
          quote_author_id: null,
          quote_sent_at: null,
          quote_author_name: null,
          quote_text: null,
          kind: 'text',
          receipt: 'sent',
          had_view_once: 0,
        });

        // The ledger keeps only the timestamp from here on. Retaining the body would give an
        // ephemeral message a second home that the expiry sweep would have to chase.
        raw
          .prepare(
            `UPDATE outbound_queue
                SET state = 'sent', sent_timestamp = ?, body = NULL, attachments_json = NULL,
                    last_error = NULL
              WHERE id = ?`
          )
          .run(sentTimestamp, id);

        return queued.expires_at ?? null;
      });
      noteExpiry(commit());
      // Look up by natural key, not by our client id: if the sync echo of this message
      // happened to land first it already owns the (sender_id, sent_at) row.
      const stored = hydrateOne(
        selectByNaturalKey.get(selfId, sentTimestamp) as MessageRow | undefined
      );
      if (!stored) throw new Error(`markOutboundSent: message ${id} was not stored.`);
      return stored;
    },

    markOutboundFailed(id, error, retryAfterMs, at) {
      const stamp = at ?? now();
      raw
        .prepare(
          `UPDATE outbound_queue
              SET state = 'failed', retry_count = retry_count + 1, last_error = ?,
                  next_attempt_at = ?
            WHERE id = ?`
        )
        .run(error, stamp + (retryAfterMs ?? 0), id);
    },

    listPendingOutbound(at) {
      const stamp = at ?? now();
      const rows = raw
        .prepare<OutboundQueueRow>(
          `SELECT * FROM outbound_queue
            WHERE state IN ('queued', 'failed') AND next_attempt_at <= ?
            ORDER BY created_at`
        )
        .all(stamp);
      return rows.map((row) => outboundRow(row)!);
    },

    getOutbound(id) {
      return outboundRow(
        raw.prepare<OutboundQueueRow>(`SELECT * FROM outbound_queue WHERE id = ?`).get(id)
      );
    },

    recoverInterruptedSends(at) {
      const stamp = at ?? now();
      // A row left in 'sending' means the process died between "about to send" and "sent". We
      // cannot know whether Signal accepted it, so we surface it as failed with an explicit
      // reason rather than silently retrying (which could duplicate) or dropping it (which
      // would lose a message the user believes they sent).
      return raw
        .prepare(
          `UPDATE outbound_queue
              SET state = 'failed',
                  last_error = 'interrupted while sending; delivery unknown',
                  next_attempt_at = ?
            WHERE state = 'sending'`
        )
        .run(stamp).changes;
    },

    wasSentByUs(sentTimestamp) {
      return (
        raw
          .prepare(`SELECT 1 FROM outbound_queue WHERE sent_timestamp = ? LIMIT 1`)
          .pluck()
          .get(sentTimestamp) === 1
      );
    },

    pruneEchoLedger(before) {
      return raw
        .prepare(`DELETE FROM outbound_queue WHERE state = 'sent' AND created_at < ?`)
        .run(before).changes;
    },
  };

  refreshNextExpiry();
  return store;
}
