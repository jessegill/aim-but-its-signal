/**
 * Persisted window geometry, one row per conversation (SPEC.md §9 — "persist each IM window's
 * position and size per conversation; restore on reopen").
 *
 * This module stores numbers only. Re-validating them against the *current* display layout
 * (a monitor may have been unplugged since last run) belongs to the window manager in
 * `src/main/windows.ts`, which is the only place that knows about screens.
 */

import type { ConversationId } from '../../shared/types.ts';
import type { StoreDatabase } from './db.ts';

/** Reserved key for the buddy list, which is not a conversation but does have geometry. */
export const BUDDY_LIST_WINDOW_KEY = '__buddylist__';

export interface WindowGeometry {
  conversationId: ConversationId;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  updatedAt: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowStore {
  get(conversationId: ConversationId): WindowGeometry | null;
  save(conversationId: ConversationId, bounds: WindowBounds, now?: number): void;
  forget(conversationId: ConversationId): void;
  all(): WindowGeometry[];
}

interface WindowGeometryRow {
  conversation_id: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  updated_at: number;
}

/** Guards against NaN/Infinity/absurd values reaching the database or a BrowserWindow. */
function sanitiseCoordinate(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (Math.abs(rounded) > 100_000) return null;
  return rounded;
}

function sanitiseExtent(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 100_000) return null;
  return rounded;
}

export function createWindowStore(db: StoreDatabase): WindowStore {
  const raw = db.raw;

  const upsert = raw.prepare(`
    INSERT INTO window_geometry (conversation_id, x, y, w, h, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      updated_at = excluded.updated_at
  `);

  function toGeometry(row: WindowGeometryRow): WindowGeometry {
    return {
      conversationId: row.conversation_id,
      x: row.x,
      y: row.y,
      w: row.w,
      h: row.h,
      updatedAt: row.updated_at,
    };
  }

  return {
    get(conversationId) {
      const row = raw
        .prepare<WindowGeometryRow>(`SELECT * FROM window_geometry WHERE conversation_id = ?`)
        .get(conversationId);
      return row ? toGeometry(row) : null;
    },

    save(conversationId, bounds, now) {
      const x = sanitiseCoordinate(bounds.x);
      const y = sanitiseCoordinate(bounds.y);
      const w = sanitiseExtent(bounds.width);
      const h = sanitiseExtent(bounds.height);
      // A window with no usable size is not worth remembering; storing it would make the next
      // launch open a zero-height window.
      if (w == null || h == null) return;
      upsert.run(conversationId, x, y, w, h, now ?? Date.now());
    },

    forget(conversationId) {
      raw.prepare(`DELETE FROM window_geometry WHERE conversation_id = ?`).run(conversationId);
    },

    all() {
      const rows = raw
        .prepare<WindowGeometryRow>(`SELECT * FROM window_geometry ORDER BY updated_at DESC`)
        .all();
      return rows.map(toGeometry);
    },
  };
}
