/**
 * Types shared across the main and renderer processes.
 *
 * Field names here mirror what signal-cli 0.14.6 actually returns (verified against the
 * installed daemon), not the indicative shapes in SPEC.md §6. Notably the contact identity
 * field is `uuid`, and no profile key is exposed by the daemon at all — per SPEC.md §10 no
 * key material is handled in this codebase.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Signal contact identity (ACI/UUID). The roster is keyed by this, never by conversation. */
export type BuddyId = string;

/**
 * A conversation. For 1:1 this is derived from the BuddyId; for groups it is the group id.
 * Kept distinct from BuddyId so the two can never be accidentally interchanged.
 */
export type ConversationId = string;

export type GroupId = number;

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

export interface Buddy {
  id: BuddyId;
  /** E.164 number. Absent for contacts known only by ACI. */
  number: string | null;
  /**
   * Resolved display name. signal-cli exposes several competing name fields; resolution
   * order is defined once in the store layer so every window agrees.
   */
  displayName: string;
  /** Local-only screen-name override (SPEC.md §2). Distinct from Signal's own nickName. */
  nickname: string | null;
  /** Per-contact disappearing-message timer in seconds. 0 = disabled. */
  messageExpirationTime: number;
  blocked: boolean;
  hidden: boolean;
  /** Contact is no longer registered with Signal; render but do not allow sends. */
  unregistered: boolean;
}

export interface BuddyGroup {
  id: GroupId;
  name: string;
  sortOrder: number;
  collapsed: boolean;
}

export interface Roster {
  groups: BuddyGroup[];
  /** Membership is exclusive — a buddy appears under exactly one group. */
  buddies: (Buddy & { groupId: GroupId; sortOrder: number })[];
}

/** Buddies with no explicit assignment land here (SPEC.md §6). */
export const DEFAULT_GROUP_NAME = 'Buddies';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageKind =
  | 'text'
  | 'attachment'
  | 'sticker'
  | 'voice'
  | 'reaction'
  | 'tombstone'
  | 'call'
  | 'identity-change'
  | 'system';

export type ReceiptState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Attachment {
  id: string;
  contentType: string;
  filename: string | null;
  size: number | null;
  /** Local path once downloaded by the daemon. Null while pending or if declined. */
  path: string | null;
  /** View-once media is never persisted to disk (SPEC.md §8). */
  viewOnce: boolean;
  isVoiceNote: boolean;
}

export interface QuoteStub {
  id: string;
  authorId: BuddyId;
  authorName: string;
  /** Null when the quoted message is unavailable locally. */
  text: string | null;
}

export interface Reaction {
  emoji: string;
  authorId: BuddyId;
  authorName: string;
}

export interface Message {
  id: string;
  conversationId: ConversationId;
  senderId: BuddyId;
  /**
   * The sender's display name, resolved when the message is read rather than stored with it,
   * so a contact who is renamed is renamed everywhere at once.
   *
   * Required, not optional: in a group conversation the window has no single "other party" to
   * fall back on, and SPEC.md §8 makes sender attribution mandatory there. Falls back to a
   * shortened ACI for a sender who is in no roster, so a line is never anonymous.
   */
  senderName: string;
  /** True when this account sent it — including via sync from another device. */
  outgoing: boolean;
  body: string | null;
  sentAt: number;
  receivedAt: number | null;
  /**
   * Absolute expiry. Null = never. Enforced in the store layer, never only in the UI
   * (SPEC.md §8, §11.4).
   */
  expiresAt: number | null;
  /** Set when the sender edited; UI must show current text plus a marker, never stale text. */
  editedAt: number | null;
  quote: QuoteStub | null;
  reactions: Reaction[];
  attachments: Attachment[];
  kind: MessageKind;
  receipt: ReceiptState | null;
}

// ---------------------------------------------------------------------------
// Signal groups
// ---------------------------------------------------------------------------

/**
 * A Signal group conversation.
 *
 * Deliberately not a `BuddyGroup` — that is the local, user-defined buddy-list folder from
 * SPEC.md §6 and shares nothing with this but the word. A `GroupChat` is a real conversation
 * on the service, keyed by the base64 group id that arrives on `dataMessage.groupInfo.groupId`
 * and goes back out as the `groupId` param of `send`.
 */
export interface GroupChat {
  id: ConversationId;
  name: string;
  members: GroupMember[];
  /** Per-group disappearing-message timer in seconds. 0 = disabled. */
  messageExpirationTime: number;
  blocked: boolean;
  /** False once the user has left or been removed: history stays readable, sends will fail. */
  isMember: boolean;
}

export interface GroupMember {
  id: BuddyId;
  /** Resolved the same way a buddy's name is, so one person reads the same everywhere. */
  name: string;
  isAdmin: boolean;
  /** True for the local account's own entry. */
  isSelf: boolean;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export type ConnectionState = 'linked' | 'linking' | 'unlinked' | 'daemon-down';

// ---------------------------------------------------------------------------
// IPC surface (SPEC.md §3)
// ---------------------------------------------------------------------------

/** renderer → main. Every send routes through main; renderers are network-silent. */
export interface IpcRequests {
  /**
   * `contact` is the conversation's header identity and is present for both kinds: for a group
   * it is synthesized from the group so one window can render either. `group` is what tells
   * them apart, and carries the roster the chat-room window needs.
   */
  'im:getInitial': (conversationId: ConversationId) => {
    messages: Message[];
    contact: Buddy | null;
    group: GroupChat | null;
  };
  'im:subscribe': (conversationId: ConversationId) => void;
  'im:send': (
    conversationId: ConversationId,
    body: string,
    attachments?: string[]
  ) => { messageId: string };
  'im:markRead': (conversationId: ConversationId) => void;
  'im:setTyping': (conversationId: ConversationId, isTyping: boolean) => void;

  'roster:get': () => Roster;
  /**
   * Signal group conversations. Separate from `roster:get` because a group is not a roster
   * entry: the roster is people (SPEC.md §6) and these are conversations, with their own
   * membership that no buddy group has.
   */
  'chats:get': () => GroupChat[];
  'roster:move': (buddyId: BuddyId, groupId: GroupId) => void;
  'roster:setNick': (buddyId: BuddyId, nickname: string | null) => void;

  'group:create': (name: string) => GroupId;
  'group:rename': (groupId: GroupId, name: string) => void;
  'group:delete': (groupId: GroupId) => void;
  'group:reorder': (groupId: GroupId, sortOrder: number) => void;
  'group:setCollapsed': (groupId: GroupId, collapsed: boolean) => void;

  'window:openIm': (buddyId: BuddyId) => void;

  'connection:get': () => ConnectionState;
  /**
   * Begins device linking and returns the `sgnl://linkdevice?…` URI to render as a QR code.
   * This is also the relink path — SPEC.md §8 requires a way to re-scan.
   */
  'connection:startLink': () => string;

  /** The local account, for the buddy-list banner and own-message attribution. */
  'self:get': () => SelfAccount | null;
}

/** The linked account itself. Never a roster entry — the user is not their own buddy. */
export interface SelfAccount {
  id: BuddyId;
  number: string | null;
  displayName: string;
}

/** main → renderer, pushed. */
export interface IpcEvents {
  'im:message': (conversationId: ConversationId, message: Message) => void;
  /**
   * `senderName` is who is typing. Carried because in a group the window cannot infer it —
   * there is no single other party — and "someone is typing" is a worse answer than a name.
   */
  'im:typing': (conversationId: ConversationId, isTyping: boolean, senderName: string) => void;
  'im:receipt': (conversationId: ConversationId, messageId: string, state: ReceiptState) => void;
  /** A message expired or was deleted for everyone; the renderer must drop it. */
  'im:removed': (conversationId: ConversationId, messageId: string) => void;
  'roster:updated': () => void;
  'connection:state': (state: ConnectionState) => void;
  /**
   * A fresh device-linking URI. Pushed rather than returned once, because the URI rotates on
   * every relink attempt and the sign-on window has to redraw its QR without reloading.
   */
  'connection:linkUri': (uri: string) => void;
}

export type IpcRequestChannel = keyof IpcRequests;
export type IpcEventChannel = keyof IpcEvents;
