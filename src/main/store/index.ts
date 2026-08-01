/**
 * The persistence layer. Main process only (SPEC.md §3).
 *
 * Typical use from `src/main/index.ts`:
 *
 * ```ts
 * await app.whenReady();               // safeStorage is not available before this
 * const store = openStore({ userDataDir: app.getPath('userData') });
 * store.messages.startExpirySweeper((removed) => {
 *   for (const ref of removed) pushToRenderer('im:removed', ref.conversationId, ref.id);
 * });
 * ```
 *
 * `userDataDir` must be `app.getPath('userData')` — on macOS
 * `~/Library/Application Support/<AppName>`. It is deliberately not a path inside the project:
 * this repository lives in an iCloud Drive folder, and message content must never sync to a
 * third party. `assertSafeDatabaseLocation` refuses cloud-synced paths outright.
 */

import * as path from 'node:path';

import { openDatabase } from './db.ts';
import type { OpenOptions, StoreDatabase } from './db.ts';
import { getOrCreateDatabaseKey } from './encryption.ts';
import type { SafeStorageLike } from './encryption.ts';
import { createAttachmentCache } from './attachments.ts';
import type { AttachmentCache } from './attachments.ts';
import { createMessageStore } from './messages.ts';
import type { MessageStore, MessageStoreOptions } from './messages.ts';
import { createRosterStore } from './roster.ts';
import type { RosterStore } from './roster.ts';
import { createWindowStore } from './windows.ts';
import type { WindowStore } from './windows.ts';
import { createIdentityStore } from './identity.ts';
import type { IdentityStore } from './identity.ts';

export * from './db.ts';
export * from './encryption.ts';
export * from './migrations.ts';
export * from './attachments.ts';
export * from './messages.ts';
export * from './roster.ts';
export * from './windows.ts';
export * from './identity.ts';

export interface StoreOptions {
  /** `app.getPath('userData')`. */
  userDataDir: string;
  /** Overrides the key. Tests only — production always uses the keychain. */
  keyHex?: string | null;
  /** Opens a PLAINTEXT database. Tests only; production must never set this. */
  allowUnencrypted?: boolean;
  /** Skips the cloud-sync location guard. Tests using an OS temp directory only. */
  skipLocationGuard?: boolean;
  /** Injected safeStorage, for tests. */
  safeStorage?: SafeStorageLike;
  integrityCheck?: OpenOptions['integrityCheck'];
  synchronous?: OpenOptions['synchronous'];
  messages?: MessageStoreOptions;
}

export interface Store {
  readonly db: StoreDatabase;
  readonly messages: MessageStore;
  readonly roster: RosterStore;
  readonly windows: WindowStore;
  readonly identity: IdentityStore;
  readonly attachments: AttachmentCache;
  /** True only when the file on disk is genuinely encrypted. */
  readonly encrypted: boolean;
  close(): void;
}

export const DATABASE_FILE_NAME = 'messages.db';
export const STORE_SUBDIR = 'store';
export const ATTACHMENTS_SUBDIR = 'attachments';

export function openStore(options: StoreOptions): Store {
  const storeDir = path.join(options.userDataDir, STORE_SUBDIR);
  const file = path.join(storeDir, DATABASE_FILE_NAME);

  const allowUnencrypted = options.allowUnencrypted ?? false;
  const keyHex = allowUnencrypted
    ? (options.keyHex ?? null)
    : (options.keyHex ?? getOrCreateDatabaseKey(storeDir, options.safeStorage));

  const db = openDatabase({
    file,
    keyHex,
    allowUnencrypted,
    skipLocationGuard: options.skipLocationGuard,
    integrityCheck: options.integrityCheck,
    synchronous: options.synchronous,
  });

  const attachments = createAttachmentCache({
    dir: path.join(options.userDataDir, ATTACHMENTS_SUBDIR),
    skipLocationGuard: options.skipLocationGuard,
  });

  const messages = createMessageStore(db, attachments, options.messages);
  const roster = createRosterStore(db);
  const windows = createWindowStore(db);
  const identity = createIdentityStore(db, messages);

  // Anything left mid-send from a previous run is surfaced, never silently dropped or blindly
  // retried, and anything already past its timer goes before the first read can see it.
  messages.recoverInterruptedSends();
  messages.sweepExpired();
  roster.ensureDefaultGroup();

  return {
    db,
    messages,
    roster,
    windows,
    identity,
    attachments,
    encrypted: db.encrypted,
    close() {
      messages.stopExpirySweeper();
      db.close();
    },
  };
}
