/**
 * The application core: one daemon, one RPC connection, one store, one window manager.
 *
 * SPEC.md §3 makes the main process the single owner of the protocol connection and all
 * application state. This is that owner. Renderers reach it only through `ipc.ts`, and it
 * reaches them only by pushing to windows.
 *
 * Ordering rule that runs through the whole file: **persist, then notify**. A message that has
 * been shown to the user but not written to disk is a message that vanishes on the next crash,
 * and there is no way to get it back — signal-cli keeps no message store, so anything it has
 * already acknowledged is gone from the server too.
 */

import { app } from 'electron';

import type {
  Buddy,
  ConnectionState,
  ConversationId,
  Message,
  Roster,
  SelfAccount,
} from '@shared/types';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SignalDaemon, defaultSocketPath, signalCliAttachmentsDir } from './daemon.ts';
import { RpcClient } from './rpc.ts';
import { parseReceive } from './events.ts';
import type { DomainEvent, IncomingMessageEvent, RawAttachment } from './events.ts';
import { WindowManager } from './windows.ts';
import { openStore, computeExpiresAt, deriveMessageId } from './store/index.ts';
import type { RawContact, Store } from './store/index.ts';
import type { Attachment } from '@shared/types';

/** Pushed channels, mirroring IpcEvents in shared/types.ts. */
export const PUSH = {
  message: 'im:message',
  typing: 'im:typing',
  receipt: 'im:receipt',
  removed: 'im:removed',
  rosterUpdated: 'roster:updated',
  connectionState: 'connection:state',
  linkUri: 'connection:linkUri',
} as const;

export class AppService {
  readonly windows: WindowManager;
  private readonly daemon: SignalDaemon;
  private readonly rpc: RpcClient;
  private readonly store: Store;

  /** E.164 of the linked account, required on every request in multi-account mode. */
  private account: string | null = null;
  /** The account's own ACI — decides `outgoing` and resolves Note to Self. */
  private selfId: string | null = null;

  private state: ConnectionState = 'daemon-down';
  private rosterSyncing = false;

  constructor(options?: { socketPath?: string; userDataDir?: string }) {
    const socketPath = options?.socketPath ?? defaultSocketPath();

    this.store = openStore({ userDataDir: options?.userDataDir ?? app.getPath('userData') });
    this.windows = new WindowManager(this.store.windows);
    this.daemon = new SignalDaemon({ socketPath });
    this.rpc = new RpcClient({ socketPath });

    this.wire();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isEncrypted(): boolean {
    return this.store.encrypted;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private wire(): void {
    this.daemon.on('state', (state: ConnectionState) => {
      this.setState(state);
    });

    this.daemon.on('started', () => {
      // The socket does not exist the instant the process spawns; RpcClient's reconnect
      // backoff absorbs the gap rather than us guessing at a sleep.
      void this.rpc.connect().catch(() => {
        /* reconnect loop owns retries */
      });
    });

    this.rpc.on('connected', () => {
      void this.onRpcConnected();
    });

    this.rpc.on('disconnected', () => {
      // The daemon may still be alive; the connection is what we lost. Under
      // --receive-mode on-connection nothing is pulled from the server while we are
      // detached, so nothing is silently consumed and dropped.
      this.setState('linking');
    });

    this.rpc.on('notification', (method: string, params: unknown) => {
      if (method !== 'receive') return;
      this.onReceive(params);
    });

    // Expiry is enforced by the store; the UI is told after the fact so a window showing an
    // expired message drops it. The store is the authority, never the renderer (SPEC.md §11.4).
    this.store.messages.startExpirySweeper((removed) => {
      for (const ref of removed) {
        this.windows.sendToIm(ref.conversationId, PUSH.removed, ref.conversationId, ref.id);
      }
    });
  }

  start(): void {
    // Rows stuck in `sending` mean we crashed mid-send. Surface them as failed rather than
    // blind-retrying, which could double-send.
    this.store.messages.recoverInterruptedSends();
    this.daemon.start();
  }

  async stop(): Promise<void> {
    this.store.messages.stopExpirySweeper();
    this.rpc.close();
    await this.daemon.stop();
    this.windows.closeAll();
    this.store.close();
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.windows.broadcast(PUSH.connectionState, next);
  }

  // -------------------------------------------------------------------------
  // Connection bring-up
  // -------------------------------------------------------------------------

  private async onRpcConnected(): Promise<void> {
    try {
      const record = firstRecord(await this.rpc.call('listAccounts'));

      const number =
        record === null ? null : typeof record.number === 'string' ? record.number : null;
      const aci = record === null ? null : typeof record.uuid === 'string' ? record.uuid : null;

      if (number === null) {
        // The daemon is up but no account is linked. This is the first-run path.
        this.setState('unlinked');
        this.windows.openSignOn();
        return;
      }

      this.account = number;
      this.selfId = aci;
      this.setState('linked');
      await this.syncRoster();
    } catch {
      this.setState('daemon-down');
    }
  }

  /** Pulls the roster from the daemon into the store. Contacts are the buddy list (SPEC.md §6). */
  async syncRoster(): Promise<void> {
    if (this.account === null || this.rosterSyncing) return;
    this.rosterSyncing = true;
    try {
      const result = await this.rpc.call('listContacts', { account: this.account });
      if (!Array.isArray(result)) return;

      const contacts: RawContact[] = result.flatMap((raw) => {
        const record =
          typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
        const uuid = record === null ? null : record.uuid;
        if (typeof uuid !== 'string' || uuid === '') return [];

        const profile =
          record !== null && typeof record.profile === 'object' && record.profile !== null
            ? (record.profile as Record<string, unknown>)
            : null;

        return [
          {
            uuid,
            number: asString(record?.number),
            name: asString(record?.name),
            givenName: asString(record?.givenName),
            familyName: asString(record?.familyName),
            profileName: joinNames(asString(profile?.givenName), asString(profile?.familyName)),
            nickName: asString(record?.nickName),
            username: asString(record?.username),
            messageExpirationTime: asNumber(record?.messageExpirationTime),
            isBlocked: record?.isBlocked === true,
            isHidden: record?.isHidden === true,
          },
        ];
      });

      this.store.roster.upsertContacts(contacts);
      this.windows.broadcast(PUSH.rosterUpdated);
    } finally {
      this.rosterSyncing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  private onReceive(params: unknown): void {
    const selfId = this.selfId;
    if (selfId === null) return;

    let events: DomainEvent[];
    try {
      events = parseReceive(params, { selfId });
    } catch {
      // A malformed envelope must never take down message delivery.
      return;
    }

    for (const event of events) {
      try {
        this.applyEvent(event);
      } catch {
        // Likewise: one bad event does not stop the rest of the batch.
      }
    }
  }

  private applyEvent(event: DomainEvent): void {
    switch (event.type) {
      case 'message':
        this.applyIncomingMessage(event);
        return;

      case 'reaction': {
        const updated = this.store.messages.applyReaction({
          targetSenderId: event.targetAuthorId,
          targetSentAt: event.targetSentAt,
          authorId: event.authorId,
          authorName: event.authorName ?? event.authorId,
          emoji: event.emoji,
          remove: event.isRemove,
        });
        if (updated !== null) this.pushMessage(event.conversationId, updated);
        return;
      }

      case 'edit': {
        const updated = this.store.messages.applyEdit(
          event.senderId,
          event.targetSentAt,
          event.body,
          event.editedAt
        );
        if (updated !== null) this.pushMessage(event.conversationId, updated);
        return;
      }

      case 'remote-delete': {
        // Replace with a tombstone and purge the original (SPEC.md §8).
        const tombstone = this.store.messages.deleteForEveryone(event.senderId, event.targetSentAt);
        this.pushMessage(event.conversationId, tombstone);
        return;
      }

      case 'receipt':
        for (const sentAt of event.targetSentAts) {
          this.store.messages.setReceiptByTimestamp(event.senderId, sentAt, event.state);
          const id = deriveMessageId(event.senderId, sentAt);
          this.windows.broadcast(PUSH.receipt, event.senderId, id, event.state);
        }
        return;

      case 'typing':
        // Typing is not presence (SPEC.md §7) — it is a per-message protocol event, so it is
        // pushed straight through without being persisted.
        this.windows.sendToIm(
          event.conversationId,
          PUSH.typing,
          event.conversationId,
          event.isTyping
        );
        return;

      case 'expiration-update':
        this.store.roster.setMessageExpirationTime(event.buddyId, event.expiresInSeconds);
        this.windows.broadcast(PUSH.rosterUpdated);
        return;

      case 'identity-change':
        // A security signal must never be dropped because the retro idiom lacks a place for it
        // (SPEC.md §8). The safety number is not carried on the exception envelope, so it has
        // to be fetched before the change can be recorded as a change rather than a first
        // sighting — hence the async hop.
        void this.recordIdentityChange(event.buddyId);
        return;

      case 'call': {
        // Calls are out of scope, but silence would be misleading (SPEC.md §8).
        const notice = this.store.messages.persistInboundThenAck(
          {
            conversationId: event.conversationId,
            senderId: event.senderId,
            outgoing: false,
            body: null,
            sentAt: event.sentAt,
            kind: 'call',
          },
          (message) => message
        );
        this.pushMessage(event.conversationId, notice);
        return;
      }

      case 'sync-read':
        for (const target of event.targets) {
          this.store.messages.setReceiptByTimestamp(target.senderId, target.sentAt, 'read');
        }
        return;
    }
  }

  private applyIncomingMessage(event: IncomingMessageEvent): void {
    const messageId = deriveMessageId(event.senderId, event.sentAt);

    // View-once media is never persisted (SPEC.md §8). `ingest` returns null for it and shreds
    // the daemon's own copy, which is written to disk before we ever see this envelope.
    const attachments = event.attachments.flatMap((raw): Attachment[] => {
      const candidate = toAttachment(raw, event.viewOnce);
      const ingested = this.store.attachments.ingest(messageId, candidate);
      return ingested === null ? [] : [ingested];
    });

    const expiresAt = computeExpiresAt(event.expiresInSeconds, event.receivedAt);

    // Persist, THEN notify. `persistInboundThenAck` commits and fsyncs before invoking the
    // callback, so acknowledging before the write is not expressible.
    this.store.messages.persistInboundThenAck(
      {
        conversationId: event.conversationId,
        senderId: event.senderId,
        outgoing: event.outgoing,
        body: event.body,
        sentAt: event.sentAt,
        receivedAt: event.receivedAt,
        expiresAt,
        kind: event.kind,
        quote: event.quote
          ? {
              authorId: event.quote.authorId,
              sentAt: event.quote.sentAt,
              authorName: event.quote.authorName ?? event.quote.authorId,
              text: event.quote.text,
            }
          : null,
        attachments,
      },
      (message, inserted) => {
        // A redelivery must not re-notify; the protocol redelivers freely.
        if (!inserted) return;

        this.pushMessage(event.conversationId, message);

        if (!event.outgoing) {
          if (this.windows.hasIm(event.conversationId)) {
            this.windows.flash(event.conversationId);
          } else {
            // SPEC.md §9 — opening on an incoming message was a preference in AIM, and is
            // wired as one here.
            if (this.openOnIncoming) this.windows.openIm(event.conversationId);
          }
        }
      }
    );
  }

  /** SPEC.md §9: "Incoming message with no window open: open one. Make this a user preference." */
  openOnIncoming = true;

  /**
   * Looks up the buddy's current safety number and records it.
   *
   * The store decides whether this is a first sighting or a genuine change, and posts the
   * user-visible notice itself when it is a change — so this must not persist one too, or the
   * conversation gets two rows for one event.
   */
  private async recordIdentityChange(buddyId: string): Promise<void> {
    if (this.account === null) return;

    let safetyNumber: string | null = null;
    try {
      const result = await this.rpc.call('listIdentities', {
        account: this.account,
        recipient: buddyId,
      });
      safetyNumber = asString(firstRecord(result)?.safetyNumber);
    } catch {
      // Recording with a null safety number still captures that the identity is untrusted,
      // which is the part that matters. Losing the notice entirely would not be acceptable.
    }

    const { changed } = this.store.identity.record({
      buddyId,
      safetyNumber,
      trustLevel: 'UNTRUSTED',
    });
    if (!changed) return;

    const latest = this.store.messages.getLatestMessage(buddyId);
    if (latest !== null) this.pushMessage(buddyId, latest);
  }

  private pushMessage(conversationId: ConversationId, message: Message): void {
    this.windows.sendToIm(conversationId, PUSH.message, conversationId, message);

    // The buddy list needs these too: it derives per-group unread counts from inbound messages,
    // since there is no presence to put in that slot (SPEC.md §7). Sending to a window that has
    // no IM open is the whole point — that is exactly when a buddy becomes unread.
    const buddyList = this.windows.buddyListWindow;
    if (buddyList !== null && this.windows.imWindow(conversationId) !== buddyList) {
      buddyList.webContents.send(PUSH.message, conversationId, message);
    }
  }

  /** The linked account. Not a roster entry — the user is not their own buddy. */
  selfAccount(): SelfAccount | null {
    if (this.selfId === null) return null;
    return {
      id: this.selfId,
      number: this.account,
      displayName: this.store.roster.getBuddy(this.selfId)?.displayName ?? this.account ?? 'Me',
    };
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Queues, sends, and records a message.
   *
   * The queue row is written *before* the network call so a crash mid-send leaves evidence
   * rather than a message the user believes they sent. It doubles as the echo-protection
   * ledger (SPEC.md §8).
   */
  async send(
    conversationId: ConversationId,
    body: string,
    attachments?: string[]
  ): Promise<string> {
    if (this.account === null) throw new Error('not linked');

    const buddy = this.store.roster.getBuddy(conversationId);
    const expiresAt = computeExpiresAt(buddy?.messageExpirationTime ?? 0, Date.now());
    const queueId = `out-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

    const row = this.store.messages.enqueueOutbound({
      id: queueId,
      conversationId,
      recipientId: conversationId,
      body,
      attachments: attachments ?? [],
      expiresAt,
    });

    this.store.messages.markOutboundSending(row.id);

    try {
      const params: Record<string, unknown> = { account: this.account, message: body };
      // A group id and a recipient are different params; sending both is an error.
      if (isGroupConversation(conversationId)) params.groupId = conversationId;
      else params.recipient = conversationId;
      if (attachments !== undefined && attachments.length > 0) params.attachment = attachments;

      const result = await this.rpc.call('send', params);
      const record =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
      const timestamp = asNumber(record?.timestamp) ?? Date.now();

      const selfId = this.selfId;
      if (selfId === null) throw new Error('self identity unknown');

      const message = this.store.messages.markOutboundSent(row.id, timestamp, selfId);
      this.pushMessage(conversationId, message);
      return message.id;
    } catch (error) {
      this.store.messages.markOutboundFailed(
        row.id,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  async setTyping(conversationId: ConversationId, isTyping: boolean): Promise<void> {
    if (this.account === null) return;
    const params: Record<string, unknown> = { account: this.account };
    if (isGroupConversation(conversationId)) params.groupId = conversationId;
    else params.recipient = conversationId;
    if (!isTyping) params.stop = true;
    await this.rpc.call('sendTyping', params).catch(() => {
      /* typing is best-effort; never surface a failure to the user */
    });
  }

  // -------------------------------------------------------------------------
  // Reads for the IPC layer
  // -------------------------------------------------------------------------

  getInitial(conversationId: ConversationId): { messages: Message[]; contact: Buddy | null } {
    return {
      messages: this.store.messages.getMessages(conversationId, { limit: 200 }),
      contact: this.store.roster.getBuddy(conversationId),
    };
  }

  getRoster(): Roster {
    return this.store.roster.getRoster();
  }

  get roster() {
    return this.store.roster;
  }

  /** Starts the linking flow and returns the URI to render as a QR code. */
  async startLink(deviceName: string): Promise<string> {
    this.setState('linking');
    const result = await this.rpc.call('startLink');
    const record =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
    const uri = asString(record?.deviceLinkUri);
    if (uri === null) throw new Error('daemon did not return a device link URI');

    // Pushed as well as returned: a relink rotates the URI, and the sign-on window has to
    // redraw its QR without reloading.
    this.windows.broadcast(PUSH.linkUri, uri);

    // finishLink blocks until the primary device responds, so it is deliberately not awaited
    // here — the renderer shows the QR while this resolves in the background.
    void this.rpc
      .call('finishLink', { deviceLinkUri: uri, deviceName })
      .then(async () => {
        await this.onRpcConnected();
        this.windows.closeSignOn();
        this.windows.openBuddyList();
      })
      .catch(() => {
        this.setState('unlinked');
      });

    return uri;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First element of an unknown array-shaped RPC result, as a record. */
function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  return typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function joinNames(given: string | null, family: string | null): string | null {
  const joined = [given, family]
    .filter((part) => part !== null)
    .join(' ')
    .trim();
  return joined === '' ? null : joined;
}

/**
 * Group ids are base64 and far longer than an ACI; a UUID is always 36 characters with
 * dashes in fixed positions.
 */
function isGroupConversation(conversationId: ConversationId): boolean {
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId);
}

/**
 * Resolves where the daemon already put an attachment's bytes.
 *
 * The envelope has no path field; the daemon writes the file into its own attachments
 * directory named by the envelope `id` before we ever see the message. Verified against real
 * traffic for both an image and a voice note.
 *
 * Getting this wrong is a security bug, not a rendering one: with a null path the store cannot
 * shred the daemon's copy, so a disappearing-message attachment outlives its timer on disk,
 * outside every sweep (SPEC.md §8).
 */
function resolveAttachmentPath(raw: RawAttachment): string | null {
  if (raw.path !== null) return raw.path;
  if (raw.id === '') return null;
  const candidate = join(signalCliAttachmentsDir(), raw.id);
  return existsSync(candidate) ? candidate : null;
}

function toAttachment(raw: RawAttachment, viewOnce: boolean): Attachment {
  return {
    id: raw.id,
    contentType: raw.contentType,
    filename: raw.filename,
    size: raw.size,
    path: resolveAttachmentPath(raw),
    viewOnce,
    isVoiceNote: raw.isVoiceNote,
  };
}
