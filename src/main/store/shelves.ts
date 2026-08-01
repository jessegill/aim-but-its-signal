/**
 * Where each conversation sits in the buddy list: pinned, ordinary, or archived.
 *
 * A shelf is a property of a *conversation*, not of a buddy or a group, which is why it lives
 * apart from both. The same three states have to apply to a person and to a chat room, and
 * neither the roster nor `signal_groups` can own a concept that spans them.
 *
 * Only departures from the default are stored. 'normal' is the absence of a row, so the table
 * stays proportional to what the user has actually sorted rather than to how many people they
 * know, and un-pinning is a delete rather than a state that has to be written and remembered.
 */

import type { ConversationId, ConversationShelf } from '../../shared/types.ts';
import type { StoreDatabase } from './db.ts';

export interface ShelfStore {
  /** The shelf for one conversation. 'normal' when nothing has been set. */
  get(id: ConversationId): ConversationShelf;
  /** Setting 'normal' removes the row — the default is never stored. */
  set(id: ConversationId, shelf: ConversationShelf, now?: number): void;
  /** Only the conversations that are *not* normal. */
  listShelved(): { id: ConversationId; shelf: ConversationShelf }[];
}

interface ShelfRow {
  conversation_id: string;
  shelf: string;
}

export function createShelfStore(db: StoreDatabase): ShelfStore {
  const raw = db.raw;

  const selectOne = raw
    .prepare(`SELECT shelf FROM conversation_shelf WHERE conversation_id = ?`)
    .pluck();

  const upsert = raw.prepare(`
    INSERT INTO conversation_shelf (conversation_id, shelf, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET shelf = excluded.shelf,
                                               updated_at = excluded.updated_at
  `);

  const remove = raw.prepare(`DELETE FROM conversation_shelf WHERE conversation_id = ?`);

  return {
    get(id) {
      const value = selectOne.get(id) as string | undefined;
      return value === 'pinned' || value === 'archived' ? value : 'normal';
    },

    set(id, shelf, now) {
      if (id === '') throw new Error('conversationId cannot be empty');
      if (shelf === 'normal') {
        remove.run(id);
        return;
      }
      upsert.run(id, shelf, now ?? Date.now());
    },

    listShelved() {
      const rows = raw
        .prepare(`SELECT conversation_id, shelf FROM conversation_shelf`)
        .all() as ShelfRow[];
      return rows.flatMap((row) =>
        row.shelf === 'pinned' || row.shelf === 'archived'
          ? [{ id: row.conversation_id, shelf: row.shelf }]
          : []
      );
    },
  };
}
