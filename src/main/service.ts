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

import { app, dialog, net, Notification, protocol, shell } from 'electron';

import { ATTACHMENT_SCHEME, parseAttachmentUrl } from '@shared/types';
import type {
  Buddy,
  ConnectionState,
  ConversationEntry,
  ConversationId,
  ConversationShelf,
  GroupChat,
  Message,
  Roster,
  SelfAccount,
} from '@shared/types';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SignalDaemon, defaultSocketPath, signalCliAttachmentsDir } from './daemon.ts';
import { RpcClient, RpcTimeoutError } from './rpc.ts';
import {
  describeSendFailure,
  isAccountGoneError,
  receiveSaysUnlinked,
  summarizeSendResults,
} from './signal-results.ts';
import { parseReceive } from './events.ts';
import type { DomainEvent, IncomingMessageEvent, RawAttachment } from './events.ts';
import { WindowManager } from './windows.ts';
import {
  ATTACHMENTS_SUBDIR,
  STORE_SUBDIR,
  openStore,
  computeExpiresAt,
  deriveMessageId,
} from './store/index.ts';
import type { RawContact, RawGroup, RawGroupMember, Store } from './store/index.ts';
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
  read: 'im:read',
} as const;

/** What appears in the phone's Linked Devices list. */
const DEVICE_NAME = 'AIMgnal';

/**
 * How long `finishLink` may wait for the phone. It blocks until the QR code is scanned, so the
 * RPC default (30 s) failed every link that took longer than that to find a phone and open the
 * camera.
 */
const LINK_TIMEOUT_MS = 10 * 60_000;

/** Ceiling on receives held while bring-up is still resolving the account's own ACI. */
const MAX_PENDING_RECEIVES = 10_000;

export class AppService {
  readonly windows: WindowManager;
  private readonly daemon: SignalDaemon;
  private readonly rpc: RpcClient;
  private readonly store: Store;

  /** E.164 of the linked account, required on every request in multi-account mode. */
  private account: string | null = null;
  /** The account's own ACI — decides `outgoing` and resolves Note to Self. */
  private selfId: string | null = null;
  /** The account's Signal username, if it has one. Opt-in on Signal, so usually null. */
  private selfUsername: string | null = null;

  private state: ConnectionState = 'daemon-down';
  private rosterSyncing = false;
  private groupSyncing = false;

  private readonly userDataDir: string;

  constructor(options?: { socketPath?: string; userDataDir?: string }) {
    const socketPath = options?.socketPath ?? defaultSocketPath();

    this.userDataDir = options?.userDataDir ?? app.getPath('userData');
    this.store = openStore({ userDataDir: this.userDataDir });
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

    // The daemon's own stdout/stderr, and our notes about it. Nothing consumed this before, so
    // the single most useful signal when the daemon misbehaves — its own account of why it
    // exited — was being computed and then dropped on the floor. A packaged build that fails to
    // start signal-cli is indistinguishable from one that starts it fine without this.
    this.daemon.on('log', (line: string) => {
      console.error(`[signal-cli] ${line}`);
    });

    this.daemon.on('exited', (code: number | null, signal: string | null) => {
      console.error(`[signal-cli] daemon exited (code=${String(code)} signal=${String(signal)})`);
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

    this.rpc.on('error', (error: Error) => {
      // Connection errors are normal: the socket does not exist yet while the daemon boots, and
      // goes away whenever it restarts. The reconnect loop is the recovery path, so there is
      // nothing to do here — but the listener must exist, or EventEmitter turns each one into an
      // uncaught exception.
      this.daemon.emit('log', `rpc: ${error.message}`);
    });

    this.rpc.on('disconnected', () => {
      // The daemon may still be alive; the connection is what we lost. Under
      // --receive-mode on-connection nothing is pulled from the server while we are
      // detached, so nothing is silently consumed and dropped.
      this.setState('linking');
    });

    this.rpc.on('notification', (method: string, params: unknown) => {
      if (method !== 'receive') return;
      if (receiveSaysUnlinked(params)) {
        void this.onAccountLost();
        return;
      }
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

      if (number === null) {
        // The daemon is up but no account is linked: first run, or this computer was removed
        // from the phone's Linked Devices (the daemon drops an unregistered account at start,
        // so both look the same). Either way the answer is a QR code, generated now rather
        // than waiting for a click — a sign-on window with no code in it is a dead end.
        this.account = null;
        this.selfId = null;
        this.pendingReceives.length = 0;
        this.setState('unlinked');
        // Brought to the front: nothing else in the app works until the code is scanned, and
        // a sign-on window behind other apps looks exactly like no sign-on window at all.
        this.windows.openSignOn().once('ready-to-show', () => {
          app.focus({ steal: true });
          this.windows.signOnWindow?.focus();
        });
        if (this.latestLinkUri === null) {
          void this.startLink().catch((error: unknown) => {
            console.error(`[link] could not generate a linking code: ${describe(error)}`);
          });
        }
        return;
      }

      if (this.account !== null && this.account !== number) {
        // A different account than the one whose events may be buffered.
        this.selfId = null;
        this.pendingReceives.length = 0;
      }
      this.account = number;
      this.setState('linked');
      // Order matters: the ACI has to be known before any receive can be attributed or any
      // send made, and `listAccounts` does not carry it (see resolveSelfId).
      await this.resolveSelfId();
      if (this.selfId === null) {
        console.error("[bring-up] could not resolve this account's ACI; receives stay buffered");
      } else {
        this.flushPendingReceives();
      }
      // Roster first: group member names are resolved against contacts, so syncing groups
      // against an empty buddies table would name every member by a truncated ACI.
      await this.syncRoster();
      await this.syncSignalGroups();
    } catch (error) {
      console.error(`[bring-up] ${describe(error)}`);
      if (isAccountGoneError(error)) {
        void this.onAccountLost();
        return;
      }
      this.setState('daemon-down');
    }
  }

  /** Set while a lost account is being recovered, so a burst of failures restarts once. */
  private recoveringAccount = false;

  /**
   * This computer stopped being a linked device — removed from the phone, or deregistered.
   *
   * A running daemon keeps failing on the stale account; a fresh one drops it, reports no
   * accounts, and so leads bring-up straight to the sign-on window with a new QR code.
   */
  private async onAccountLost(): Promise<void> {
    if (this.recoveringAccount) return;
    this.recoveringAccount = true;
    console.error('[link] this computer is no longer linked; restarting signal-cli to relink');
    this.account = null;
    this.selfId = null;
    this.pendingReceives.length = 0;
    this.setState('unlinked');
    try {
      await this.daemon.restart();
    } finally {
      this.recoveringAccount = false;
    }
  }

  /**
   * Resolves the account's own ACI, and its username if it has one.
   *
   * `listAccounts` returns **only** `{"number":"+1…"}` — verified live against 0.14.6. There is
   * no `uuid` field, so the ACI has to be found elsewhere or every send fails with "self identity
   * unknown" and every incoming message is misattributed as not-outgoing.
   *
   * `listContacts` contains a self entry keyed by the account number; `listIdentities` also
   * carries one and is the fallback, because a null ACI breaks the app outright.
   *
   * The username is looked for in the same pass but is never required: it is opt-in on Signal,
   * so its absence is the ordinary case and callers fall back to a neutral label.
   */
  private async resolveSelfId(): Promise<void> {
    const account = this.account;
    if (account === null) return;

    // Checked first because it is the account's own record rather than a contact's view of it.
    // Harmless if the field is absent — which it was on 0.14.6 the last time it was observed.
    try {
      this.selfUsername ??= asString(firstRecord(await this.rpc.call('listAccounts'))?.username);
    } catch {
      // Nothing to do; the contact sweep below is the real source.
    }

    for (const method of ['listContacts', 'listIdentities'] as const) {
      try {
        const result = await this.rpc.call(method, { account });
        if (!Array.isArray(result)) continue;
        for (const raw of result) {
          if (typeof raw !== 'object' || raw === null) continue;
          const entry = raw as Record<string, unknown>;
          if (entry.number !== account) continue;
          this.selfUsername ??= asString(entry.username);
          const uuid = entry.uuid;
          if (typeof uuid === 'string' && uuid !== '') {
            this.selfId = uuid;
            return;
          }
        }
      } catch {
        // Try the next source rather than leaving the app unable to send.
      }
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

  /**
   * Pulls Signal group conversations into the store.
   *
   * Groups are not buddies and never enter the roster (SPEC.md §6) — this is what makes a
   * group *conversation* renderable: its name for the title bar, and its members for sender
   * attribution and the chat-room list (SPEC.md §8).
   */
  async syncSignalGroups(): Promise<void> {
    if (this.account === null || this.groupSyncing) return;
    this.groupSyncing = true;
    try {
      const result = await this.rpc.call('listGroups', { account: this.account });
      if (!Array.isArray(result)) return;

      const groups: RawGroup[] = result.flatMap((entry) => {
        const record =
          typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : null;
        const id = record === null ? null : record.id;
        if (typeof id !== 'string' || id === '') return [];
        return [
          {
            id,
            name: asString(record?.name),
            description: asString(record?.description),
            isMember: record?.isMember !== false,
            isBlocked: record?.isBlocked === true,
            messageExpirationTime: asNumber(record?.messageExpirationTime),
            members: asMembers(record?.members),
            admins: asMembers(record?.admins),
          },
        ];
      });

      this.store.signalGroups.upsertGroups(groups);
      this.windows.broadcast(PUSH.rosterUpdated);
    } catch {
      // A group list we could not fetch degrades to unnamed conversations, which is survivable.
      // Failing bring-up over it would not be.
    } finally {
      this.groupSyncing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Receives that arrived before the account's own ACI was known.
   *
   * Under `--receive-mode on-connection` the daemon starts pushing the moment the socket
   * connects — and the first thing it pushes is everything that queued up while the app was
   * closed. The ACI is only known a couple of round trips later. These used to be dropped, and
   * since the daemon has already acknowledged them to the server and keeps no store, that was
   * every message received while the app was shut, lost for good on every launch.
   */
  private readonly pendingReceives: unknown[] = [];

  private onReceive(params: unknown): void {
    const selfId = this.selfId;
    if (selfId === null) {
      if (this.pendingReceives.length < MAX_PENDING_RECEIVES) {
        this.pendingReceives.push(params);
      } else {
        console.error('[receive] buffer full before bring-up finished; dropping a receive');
      }
      return;
    }
    this.processReceive(params, selfId);
  }

  /** Applies buffered receives in arrival order. Synchronous, so nothing can interleave. */
  private flushPendingReceives(): void {
    const selfId = this.selfId;
    if (selfId === null) return;
    const pending = this.pendingReceives.splice(0);
    for (const params of pending) this.processReceive(params, selfId);
  }

  private processReceive(params: unknown, selfId: string): void {
    let events: DomainEvent[];
    try {
      events = parseReceive(params, { selfId });
    } catch (error) {
      // A malformed envelope must never take down message delivery — but it must not vanish
      // without a trace either.
      console.error(`[receive] could not parse an envelope: ${describe(error)}`);
      return;
    }

    for (const event of events) {
      try {
        this.applyEvent(event);
      } catch (error) {
        // Likewise: one bad event does not stop the rest of the batch.
        console.error(`[receive] could not apply a ${event.type} event: ${describe(error)}`);
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

      case 'receipt': {
        // A receipt acknowledges a message *we* sent, so the message it refers to is keyed by
        // (selfId, sentAt). This used to resolve against `event.senderId` — the ACI of whoever
        // was doing the acknowledging — which matches no row we ever wrote, so the UPDATE hit
        // nothing and the pushed id was for a message that does not exist. Nothing outgoing
        // ever advanced past "sending".
        const selfId = this.selfId;
        if (selfId === null) return;

        for (const sentAt of event.targetSentAts) {
          const ref = this.store.messages.setReceiptByTimestamp(selfId, sentAt, event.state);
          // Null means no such message, or a state that would move backwards — in a group every
          // member acknowledges separately, so later receipts for an already-read message are
          // the normal case rather than an error.
          if (ref === null) continue;
          this.windows.sendToIm(
            ref.conversationId,
            PUSH.receipt,
            ref.conversationId,
            ref.id,
            event.state
          );
        }
        return;
      }

      case 'typing':
        // Typing is not presence (SPEC.md §7) — it is a per-message protocol event, so it is
        // pushed straight through without being persisted.
        this.windows.sendToIm(
          event.conversationId,
          PUSH.typing,
          event.conversationId,
          event.isTyping,
          this.store.roster.displayNameFor(event.senderId)
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

      case 'sync-read': {
        // Read on the phone or another device: clear the unread count here too, or the buddy
        // list and Dock badge keep nagging about messages the user has already seen.
        const conversations = new Set<ConversationId>();
        for (const target of event.targets) {
          this.store.messages.setReceiptByTimestamp(target.senderId, target.sentAt, 'read');
          const message = this.store.messages.getMessageByNaturalKey(
            target.senderId,
            target.sentAt
          );
          if (message !== null) conversations.add(message.conversationId);
        }
        for (const conversationId of conversations) this.markRead(conversationId);
        return;
      }
    }
  }

  /**
   * ACIs we have already re-synced the roster for. A sender who genuinely has no contact
   * record — someone in a group the user has never messaged — must not cause a `listContacts`
   * round trip on every single message they send.
   */
  private readonly resolvedUnknownSenders = new Set<string>();

  /**
   * Fills in whatever this message referred to that we cannot yet name.
   *
   * Both cases are ordinary rather than exceptional: a group created since bring-up, and a
   * group member the user has no contact record for. Sender attribution is required in group
   * conversations (SPEC.md §8), and a room of truncated ACIs technically satisfies it while
   * being useless — so a first sighting is worth one round trip.
   */
  private backfillNames(event: IncomingMessageEvent): void {
    if (
      isGroupConversation(event.conversationId) &&
      !this.store.signalGroups.isKnownGroup(event.conversationId)
    ) {
      void this.syncSignalGroups();
    }

    if (
      this.store.roster.getBuddy(event.senderId) === null &&
      !this.resolvedUnknownSenders.has(event.senderId)
    ) {
      // signal-cli creates a recipient record when it first hears from someone, so the contact
      // list very often knows this sender by the time we ask — just not before they spoke.
      this.resolvedUnknownSenders.add(event.senderId);
      void this.syncRoster();
    }
  }

  /** True when the user has blocked this sender or this room. */
  private isBlocked(event: IncomingMessageEvent): boolean {
    if (event.outgoing) return false;
    if (this.store.roster.getBuddy(event.senderId)?.blocked === true) return true;
    return (
      isGroupConversation(event.conversationId) &&
      this.store.signalGroups.getGroup(event.conversationId)?.blocked === true
    );
  }

  private applyIncomingMessage(event: IncomingMessageEvent): void {
    const messageId = deriveMessageId(event.senderId, event.sentAt);

    if (this.isBlocked(event)) {
      // Blocked means discarded, as on the phone. The daemon has already written any media to
      // disk; ingesting it as view-once shreds that copy and keeps nothing.
      for (const raw of event.attachments) {
        this.store.attachments.ingest(messageId, toAttachment(raw, true));
      }
      return;
    }

    this.backfillNames(event);

    // A conversation's first-ever message, from someone not pinned — a stranger, in effect.
    // Signal shows these as message requests; here they get a notification and a row in the
    // buddy list, but do not throw a window onto the screen uninvited.
    const isFirstContact =
      !event.outgoing &&
      this.store.messages.countMessages(event.conversationId) === 0 &&
      !this.store.shelves.listShelved().some((entry) => entry.id === event.conversationId);

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
          const open = this.windows.imWindow(event.conversationId);
          const focused = open?.isFocused() === true;
          if (open !== null) {
            this.windows.flash(event.conversationId);
          } else if (this.openOnIncoming && !isFirstContact) {
            // SPEC.md §9 — opening on an incoming message was a preference in AIM, and is
            // wired as one here.
            this.windows.openIm(event.conversationId);
          }
          if (!focused) this.announce(event.conversationId, message, event.viewOnce);
        }
      }
    );
  }

  // -------------------------------------------------------------------------
  // Attention: unread counts, Dock badge, notifications, sounds
  // -------------------------------------------------------------------------

  /** Unread inbound messages per conversation, since the user last looked at it. */
  private readonly unread = new Map<ConversationId, number>();

  /** Clears a conversation's unread count — read here, or read on another device. */
  markRead(conversationId: ConversationId): void {
    if (this.unread.delete(conversationId)) this.updateBadge();
    const buddyList = this.windows.buddyListWindow;
    if (buddyList !== null) buddyList.webContents.send(PUSH.read, conversationId);
  }

  private updateBadge(): void {
    let total = 0;
    for (const count of this.unread.values()) total += count;
    app.dock?.setBadge(total > 0 ? String(total) : '');
  }

  /**
   * Tells the user about a message they are not looking at.
   *
   * A disappearing message's notification carries no text: Notification Center keeps its own
   * copy, which would outlive the timer in exactly the way the attachment warning describes.
   */
  private announce(conversationId: ConversationId, message: Message, viewOnce: boolean): void {
    this.unread.set(conversationId, (this.unread.get(conversationId) ?? 0) + 1);
    this.updateBadge();
    playSound('receive');

    if (!Notification.isSupported()) return;
    const sender = this.store.roster.displayNameFor(message.senderId);
    const room = isGroupConversation(conversationId)
      ? this.store.signalGroups.getGroup(conversationId)?.name
      : undefined;
    const title = room !== undefined ? `${sender} in ${room}` : sender;
    let body: string;
    if (message.expiresAt !== null) body = 'New disappearing message';
    else if (viewOnce) body = 'Sent a view-once message — open it on your phone';
    else if (message.body !== null && message.body !== '') body = message.body;
    else if (message.attachments.length > 0) body = 'Sent a file';
    else body = 'New message';

    const notification = new Notification({ title, body, silent: true });
    notification.on('click', () => {
      this.windows.openIm(conversationId);
    });
    notification.show();
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
      username: this.selfUsername,
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
  /**
   * Absolute paths this process has handed to a renderer from the file picker.
   *
   * `im:send` will not attach a path that is not in here. Without the ledger the attachment
   * argument is an arbitrary-file-read primitive: a renderer that had been compromised could
   * name `~/.ssh/id_ed25519` and have the main process mail it to a contact, and every part of
   * that would look like an ordinary send. Bounded because the picker is a human action; entries
   * are kept for the session so a file can be attached again without re-picking it.
   */
  private readonly vendedAttachmentPaths = new Set<string>();

  /** Records a path the picker returned, making it eligible to be attached. */
  vendAttachmentPath(path: string): void {
    this.vendedAttachmentPaths.add(resolve(path));
  }

  async send(
    conversationId: ConversationId,
    body: string,
    attachments?: string[]
  ): Promise<string> {
    if (this.account === null) throw new Error('not linked');
    for (const path of attachments ?? []) {
      if (this.vendedAttachmentPaths.has(resolve(path))) continue;
      // Deliberately refuses rather than sending. See vendedAttachmentPaths.
      throw new Error('attachment was not chosen with the file picker');
    }
    // Checked *before* the RPC call, not after. Validating anything post-send means the message
    // has already left for a real contact by the time we refuse it — the user sees a failure,
    // retries, and sends twice.
    const selfId = this.selfId;
    if (selfId === null) throw new Error('self identity unknown');

    // The outbound default comes from whichever conversation this is. Reading only the roster
    // meant a group's timer was always taken as 0, so a message sent into a disappearing-message
    // group was kept forever on this machine — the one copy the group's own timer cannot reach.
    const timer = isGroupConversation(conversationId)
      ? (this.store.signalGroups.getGroup(conversationId)?.messageExpirationTime ?? 0)
      : (this.store.roster.getBuddy(conversationId)?.messageExpirationTime ?? 0);
    const expiresAt = computeExpiresAt(timer, Date.now());
    const queueId = `out-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;

    const row = this.store.messages.enqueueOutbound({
      id: queueId,
      conversationId,
      recipientId: conversationId,
      // A file sent with no caption has no body at all, rather than an empty string that would
      // render as a blank line in the log.
      body: body === '' ? null : body,
      attachments: attachments ?? [],
      expiresAt,
    });

    this.store.messages.markOutboundSending(row.id);

    try {
      const params: Record<string, unknown> = { account: this.account };
      // Omitted rather than sent empty: signal-cli treats a present `message` as a text body.
      if (body !== '') params.message = body;
      // A group id and a recipient are different params; sending both is an error.
      if (isGroupConversation(conversationId)) params.groupId = conversationId;
      else params.recipient = conversationId;
      if (attachments !== undefined && attachments.length > 0) params.attachment = attachments;

      const result = await this.rpc.call('send', params);
      const summary = summarizeSendResults(result);
      const timestamp = summary.timestamp ?? Date.now();

      const message = this.store.messages.markOutboundSent(row.id, timestamp, selfId);
      this.pushMessage(conversationId, message);
      playSound('send');

      // The call succeeds as long as *anyone* got the message. In a group, the members who did
      // not are only visible here — say so in the conversation rather than showing "sent".
      if (summary.failures.length > 0) {
        const who = summary.failures
          .map((failure) => {
            const id = failure.uuid ?? failure.number ?? 'someone';
            const name = this.store.roster.displayNameFor(id);
            return `${name} (${describeSendFailure(failure.type)})`;
          })
          .join(', ');
        const notice = this.store.messages.postNotice(conversationId, `Not delivered to ${who}.`);
        this.pushMessage(conversationId, notice);
      }
      return message.id;
    } catch (error) {
      this.store.messages.markOutboundFailed(row.id, describe(error));
      if (isAccountGoneError(error)) void this.onAccountLost();
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  /**
   * Serves cached attachment bytes to the renderer for inline thumbnails.
   *
   * Must run after `app.whenReady()`; the scheme's privileges are declared before ready, in
   * index.ts.
   *
   * Every rule that governs {@link openAttachment} governs this too, because it is the same
   * capability with a different consumer: the URL carries **ids, not a path**, the path comes
   * from the message row, and the result must resolve inside our own cache root. A renderer
   * cannot name a file, and a row holding a foreign path cannot be used to read one.
   *
   * No disappearing-message warning here, deliberately. Rendering a thumbnail inside the app is
   * not handing the file to another application — nothing leaves, nothing is cached anywhere the
   * sweep cannot reach, and the log already shows the message. The warning belongs on the
   * boundary crossing, which is `openAttachment`.
   */
  serveAttachments(): void {
    protocol.handle(ATTACHMENT_SCHEME, async (request) => {
      const notFound = new Response(null, { status: 404 });
      const target = parseAttachmentUrl(request.url);
      if (target === null) return notFound;
      const { messageId, attachmentId } = target;

      const message = this.store.messages.getMessage(messageId);
      const attachment = message?.attachments.find((a) => a.id === attachmentId);
      // A null path, or view-once media that somehow reached a row, serves nothing.
      if (attachment === undefined || attachment.viewOnce || attachment.path === null) {
        return notFound;
      }

      const path = resolve(attachment.path);
      const cacheRoot = resolve(this.store.attachments.dir);
      if (path !== cacheRoot && !path.startsWith(cacheRoot + sep)) return notFound;
      if (!existsSync(path)) return notFound;

      return await net.fetch(pathToFileURL(path).toString());
    });
  }

  /**
   * True once the user has accepted the disappearing-message warning for this run.
   *
   * Session-scoped on purpose: the warning is about a property of the *app boundary*, not of a
   * particular file, so asking again on every attachment would be nagging rather than
   * informing. Not persisted — a fresh launch says it once more, which is cheap.
   */
  private expiringAttachmentWarningAccepted = false;

  /**
   * Hands a received attachment to the system, addressed by ids.
   *
   * **The path is resolved here, from the message row.** A path supplied by the renderer would
   * be an arbitrary-file-open primitive; nothing the renderer sends is used to locate the file.
   * The resolved path is additionally required to be inside our own attachment cache, so a row
   * that somehow held a foreign path could not be used to open one either.
   *
   * ---------------------------------------------------------------------------------------
   * THE DISAPPEARING-MESSAGE DECISION
   * ---------------------------------------------------------------------------------------
   * Attachments on an expiring message are shredded when the timer runs out, and the store goes
   * to real trouble to make that stick. Handing the file to Preview or QuickLook copies it
   * somewhere the sweep cannot reach — recents lists, thumbnail caches, autosave.
   *
   * Of the three available answers — refuse, warn, or allow silently — this app **warns, then
   * allows**. Refusing would make a legitimate file unreachable on the machine it was sent to,
   * which pushes the user to screenshot it instead and is worse for them by every measure.
   * Allowing silently would weaken a promise the rest of the codebase keeps carefully, without
   * the person relying on it ever being told. So the guarantee ends at the app boundary, the
   * user is told exactly that before it happens, and they decide.
   */
  async openAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<{ opened: boolean; reason: string | null }> {
    const message = this.store.messages.getMessage(messageId);
    if (message === null) {
      return { opened: false, reason: 'That message is no longer on this computer.' };
    }

    const attachment = message.attachments.find((candidate) => candidate.id === attachmentId);
    if (attachment === undefined) {
      return { opened: false, reason: 'That attachment is no longer on this computer.' };
    }
    if (attachment.viewOnce) {
      // Unreachable — view-once media never reaches the database (three barriers, see
      // store/attachments.ts). Refused here anyway rather than trusting that.
      return {
        opened: false,
        reason: 'View-once media is never saved here. Open it on your phone.',
      };
    }
    if (attachment.path === null) {
      return { opened: false, reason: 'That file was never downloaded to this computer.' };
    }

    const path = resolve(attachment.path);
    const cacheRoot = resolve(this.store.attachments.dir);
    if (path !== cacheRoot && !path.startsWith(cacheRoot + sep)) {
      return { opened: false, reason: 'That file is not in this app’s attachment store.' };
    }
    if (!existsSync(path)) {
      return { opened: false, reason: 'That file is no longer on disk.' };
    }

    if (message.expiresAt !== null && !this.expiringAttachmentWarningAccepted) {
      const parent = this.windows.imWindow(message.conversationId);
      const options = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Open Anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'This message disappears',
        message: 'Opening this file ends the disappearing-message guarantee.',
        detail:
          'This app deletes the file when the timer runs out. Another application cannot be ' +
          'made to do the same — Preview, Quick Look and the like keep their own copies in ' +
          'recents and thumbnail caches, and those will outlive the timer.\n\n' +
          'The message itself still disappears here on schedule.',
        checkboxLabel: 'Don’t warn me again while the app is running',
        checkboxChecked: false,
      };
      const answer =
        parent === null
          ? await dialog.showMessageBox(options)
          : await dialog.showMessageBox(parent, options);

      if (answer.response !== 1) {
        return { opened: false, reason: null };
      }
      if (answer.checkboxChecked) this.expiringAttachmentWarningAccepted = true;
    }

    const failure = await shell.openPath(path);
    if (failure !== '') {
      return { opened: false, reason: `The system could not open that file: ${failure}` };
    }
    return { opened: true, reason: null };
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

  getInitial(conversationId: ConversationId): {
    messages: Message[];
    contact: Buddy | null;
    group: GroupChat | null;
  } {
    const group = isGroupConversation(conversationId)
      ? this.store.signalGroups.getGroup(conversationId, this.selfId)
      : null;

    return {
      messages: this.store.messages.getMessages(conversationId, { limit: 200 }),
      // One window renders both kinds, so a group is handed over as a Buddy-shaped header too.
      // The `group` field is what the renderer switches on; this is only the chrome's identity.
      contact: group !== null ? groupAsBuddy(group) : this.store.roster.getBuddy(conversationId),
      group,
    };
  }

  getRoster(): Roster {
    return this.store.roster.getRoster();
  }

  /**
   * Which conversations the buddy list should show, and where each one sits.
   *
   * The union of "has messages" and "the user shelved it". Both halves are needed: a pinned
   * contact you have not spoken to yet must still appear (pinning them is the whole point), and
   * a conversation you have never sorted must appear once it has traffic.
   */
  getConversations(): ConversationEntry[] {
    const entries = new Map<ConversationId, ConversationEntry>();

    for (const {
      conversationId,
      lastMessageAt,
    } of this.store.messages.listConversationActivity()) {
      entries.set(conversationId, { id: conversationId, shelf: 'normal', lastMessageAt });
    }
    for (const { id, shelf } of this.store.shelves.listShelved()) {
      const existing = entries.get(id);
      entries.set(id, { id, shelf, lastMessageAt: existing?.lastMessageAt ?? null });
    }

    return [...entries.values()];
  }

  setShelf(conversationId: ConversationId, shelf: ConversationShelf): void {
    this.store.shelves.set(conversationId, shelf);
    this.windows.broadcast(PUSH.rosterUpdated);
  }

  /** Group conversations, for the buddy list's chat-room section. */
  getChats(): GroupChat[] {
    // Groups the user has left keep their history but are not places they can go back to, so
    // they are not offered as somewhere to start a conversation.
    return this.store.signalGroups.listGroups(this.selfId).filter((group) => group.isMember);
  }

  get roster() {
    return this.store.roster;
  }

  /** The QR payload currently on offer, so a sign-on window opened late can still draw it. */
  private latestLinkUri: string | null = null;
  /** Bumped per code, so a superseded code's failure cannot clobber a newer one's state. */
  private linkGeneration = 0;

  get linkUri(): string | null {
    return this.latestLinkUri;
  }

  /**
   * Starts the linking flow and returns the URI to render as a QR code.
   *
   * Every call issues a fresh code; an earlier code that is still pending may also complete,
   * and a scan of either is accepted.
   */
  async startLink(deviceName: string = DEVICE_NAME): Promise<string> {
    const generation = ++this.linkGeneration;
    this.setState('linking');

    let uri: string | null;
    try {
      const result = await this.rpc.call('startLink');
      const record =
        typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
      uri = asString(record?.deviceLinkUri);
      if (uri === null) throw new Error('daemon did not return a device link URI');
    } catch (error) {
      if (generation === this.linkGeneration) this.setState('unlinked');
      throw error;
    }

    this.latestLinkUri = uri;
    // Never log the URI itself: it carries the provisioning key.
    console.error('[link] linking code ready; waiting for the phone to scan it');
    // Pushed as well as returned: a relink rotates the URI, and the sign-on window has to
    // redraw its QR without reloading.
    this.windows.broadcast(PUSH.linkUri, uri);

    // finishLink blocks until the phone scans the code, so it is deliberately not awaited
    // here — the renderer shows the QR while this resolves in the background.
    void this.rpc
      .call('finishLink', { deviceLinkUri: uri, deviceName }, { timeoutMs: LINK_TIMEOUT_MS })
      .then(() => {
        this.latestLinkUri = null;
        this.linkGeneration += 1;
        // The daemon subscribes a connection only to the accounts that existed when it opened,
        // so the new account would receive nothing on this one. Reconnecting re-runs bring-up
        // (listAccounts → ACI → roster → groups) on a connection that includes it.
        this.rpc.reconnect();
        this.windows.closeSignOn();
        this.windows.openBuddyList();
      })
      .catch((error: unknown) => {
        if (generation !== this.linkGeneration) return; // a newer code is on screen
        console.error(`[link] ${describe(error)}`);
        this.latestLinkUri = null;
        this.setState('unlinked');
        // An unscanned code expires. While someone is looking at the sign-on window, replace
        // it rather than leaving a code on screen that can no longer work.
        const expired =
          error instanceof RpcTimeoutError || /time ?out|timed out|closed/i.test(describe(error));
        if (expired && this.windows.signOnWindow !== null) {
          setTimeout(() => {
            if (generation !== this.linkGeneration) return;
            void this.startLink(deviceName).catch(() => undefined);
          }, 1_000);
        }
      });

    return uri;
  }

  /** Stops signal-cli and starts a fresh one. The sign-on window's "restart" action. */
  async restartService(): Promise<void> {
    this.setState('daemon-down');
    await this.daemon.restart();
  }

  /**
   * Signs this computer off the account and erases everything it stored.
   *
   * A linked device cannot remove itself from the account — only the phone can — so this
   * deletes signal-cli's local credentials for the account (the part that grants access), then
   * this app's own database, key and attachment cache, and relaunches to the sign-on window.
   * The dialog tells the user to finish the job on the phone.
   */
  async signOff(): Promise<boolean> {
    const parent = this.windows.buddyListWindow;
    const options = {
      type: 'warning' as const,
      buttons: ['Cancel', 'Sign Off and Erase'],
      defaultId: 0,
      cancelId: 0,
      title: 'Sign off',
      message: 'Sign off and erase this computer’s copy of your account?',
      detail:
        'This deletes the Signal credentials stored on this computer, every message and file ' +
        'this app has saved, and its encryption key. It cannot be undone.\n\n' +
        'Afterwards, remove “AIMgnal” from Settings › Linked Devices on your phone.',
    };
    const answer =
      parent === null
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(parent, options);
    if (answer.response !== 1) return false;

    if (this.account !== null) {
      try {
        await this.rpc.call('deleteLocalAccountData', {
          account: this.account,
          ignoreRegistered: true,
        });
      } catch (error) {
        console.error(`[sign-off] could not delete signal-cli account data: ${describe(error)}`);
      }
    }

    await this.stop();
    rmSync(join(this.userDataDir, STORE_SUBDIR), { recursive: true, force: true });
    rmSync(join(this.userDataDir, ATTACHMENTS_SUBDIR), { recursive: true, force: true });
    app.relaunch();
    app.exit(0);
    return true;
  }

  /** The conversation a message belongs to, for checking which window may act on it. */
  conversationOfMessage(messageId: string): ConversationId | null {
    return this.store.messages.getMessage(messageId)?.conversationId ?? null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Plays one of the three message sounds (SPEC.md §9) with macOS `afplay`.
 *
 * The main process has no audio API and the sound must play with no window open. Packaged
 * builds unpack `resources/sounds` from the asar (see electron-builder.yml) because `afplay`
 * cannot read inside an archive.
 */
function playSound(name: 'receive' | 'send'): void {
  const file = join(
    app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
    'resources',
    'sounds',
    `${name}.wav`
  );
  if (!existsSync(file)) return;
  const child = spawn('/usr/bin/afplay', [file], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
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

/** `listGroups[].members` / `.admins`. Entries with no ACI are kept; the store drops them. */
function asMembers(value: unknown): RawGroupMember[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    return [
      {
        uuid: asString(record.uuid),
        number: asString(record.number),
        isAdmin: record.isAdmin === true,
      },
    ];
  });
}

function joinNames(given: string | null, family: string | null): string | null {
  const joined = [given, family]
    .filter((part) => part !== null)
    .join(' ')
    .trim();
  return joined === '' ? null : joined;
}

/**
 * A group in the shape the IM window's chrome expects.
 *
 * `unregistered` carries "you are no longer in this group": the window already refuses to send
 * to an unregistered contact and explains why, and leaving a group has the same consequence.
 * Reusing the flag means there is one code path that can disable sending, not two.
 */
function groupAsBuddy(group: GroupChat): Buddy {
  return {
    id: group.id,
    number: null,
    displayName: group.name,
    nickname: null,
    messageExpirationTime: group.messageExpirationTime,
    blocked: group.blocked,
    hidden: false,
    unregistered: !group.isMember,
  };
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
