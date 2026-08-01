/**
 * Buddies, user-defined groups, and local nicknames.
 *
 * The roster is contact-based, not conversation-based (SPEC.md §6): it holds everyone the
 * user knows, including people they have never exchanged a message with, and it is keyed by
 * the Signal contact identity (`uuid`, the ACI).
 *
 * Group membership is **exclusive**, enforced by `PRIMARY KEY (buddy_id)` on
 * `buddy_group_members`. `moveBuddy` is an upsert against that key, so moving a buddy replaces
 * their assignment; a raw second INSERT for the same buddy fails with a constraint error. The
 * invariant lives in the schema, not in application code.
 *
 * There is no `profile_key` column. signal-cli 0.14.6 does not expose profile keys through
 * its API, and SPEC.md §10 forbids key handling in this codebase.
 */

import type { Buddy, BuddyGroup, BuddyId, GroupId, Roster } from '../../shared/types.ts';
import { DEFAULT_GROUP_NAME } from '../../shared/types.ts';
import type { StoreDatabase } from './db.ts';

/**
 * A contact as returned by signal-cli's `listContacts`.
 *
 * Field names follow signal-cli 0.14.6. Everything except `uuid` is optional because the
 * daemon omits fields it has no value for, and because the exact set is still being verified
 * against the live daemon — an unexpected extra field is ignored, a missing one degrades to a
 * sensible default rather than throwing.
 */
export interface RawContact {
  /** The ACI. The roster key. */
  uuid: string;
  number?: string | null;
  /** Contact name from the user's own address book / contact record. */
  name?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  /** Name from the contact's Signal profile. */
  profileName?: string | null;
  /** Signal's own nickname feature — distinct from our local screen-name override. */
  nickName?: string | null;
  username?: string | null;
  /** Per-contact disappearing-message timer, in seconds. */
  messageExpirationTime?: number | null;
  isBlocked?: boolean | null;
  isHidden?: boolean | null;
  isRegistered?: boolean | null;
}

export interface RosterStore {
  ensureDefaultGroup(): GroupId;
  upsertContacts(contacts: RawContact[], now?: number): number;
  getBuddy(id: BuddyId): Buddy | null;
  listBuddies(): Buddy[];
  getRoster(): Roster;
  setNickname(id: BuddyId, nickname: string | null): void;
  setMessageExpirationTime(id: BuddyId, seconds: number): void;
  moveBuddy(buddyId: BuddyId, groupId: GroupId, sortOrder?: number): void;
  reorderBuddy(buddyId: BuddyId, sortOrder: number): void;
  createGroup(name: string, sortOrder?: number): GroupId;
  renameGroup(groupId: GroupId, name: string): void;
  deleteGroup(groupId: GroupId): void;
  reorderGroup(groupId: GroupId, sortOrder: number): void;
  setGroupCollapsed(groupId: GroupId, collapsed: boolean): void;
  listGroups(): BuddyGroup[];
}

interface BuddyRow {
  id: string;
  number: string | null;
  display_name: string;
  nickname: string | null;
  message_expiration_time: number;
  blocked: number;
  hidden: number;
  unregistered: number;
}

/**
 * The single definition of how a contact's display name is chosen, so every window agrees
 * (see the note in `shared/types.ts`). Preference order: the user's own contact name, then
 * the profile name, then given/family, then Signal's nickname, then the phone number, then a
 * shortened ACI so something always renders.
 */
export function resolveDisplayName(contact: RawContact): string {
  const candidates = [
    contact.name,
    contact.profileName,
    [contact.givenName, contact.familyName].filter(Boolean).join(' ').trim() || null,
    contact.nickName,
    contact.username,
    contact.number,
  ];
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate.trim();
  }
  return contact.uuid.slice(0, 8);
}

function bool(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

function rowToBuddy(row: BuddyRow): Buddy {
  return {
    id: row.id,
    number: row.number,
    displayName: row.display_name,
    nickname: row.nickname,
    messageExpirationTime: row.message_expiration_time,
    blocked: row.blocked === 1,
    hidden: row.hidden === 1,
    unregistered: row.unregistered === 1,
  };
}

export function createRosterStore(db: StoreDatabase): RosterStore {
  const raw = db.raw;

  function ensureDefaultGroup(): GroupId {
    const existing = raw
      .prepare(`SELECT id FROM buddy_groups WHERE name = ? COLLATE NOCASE`)
      .pluck()
      .get(DEFAULT_GROUP_NAME) as number | undefined;
    if (existing != null) return existing;
    const result = raw
      .prepare(`INSERT INTO buddy_groups (name, sort_order, collapsed) VALUES (?, 0, 0)`)
      .run(DEFAULT_GROUP_NAME);
    return Number(result.lastInsertRowid);
  }

  const upsertBuddy = raw.prepare(`
    INSERT INTO buddies (
      id, number, display_name, message_expiration_time, blocked, hidden, unregistered,
      updated_at
    ) VALUES (@id, @number, @display_name, @message_expiration_time, @blocked, @hidden,
              @unregistered, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      number                  = excluded.number,
      display_name            = excluded.display_name,
      message_expiration_time = excluded.message_expiration_time,
      blocked                 = excluded.blocked,
      hidden                  = excluded.hidden,
      unregistered            = excluded.unregistered,
      updated_at              = excluded.updated_at
  `);
  // NOTE: `nickname` is deliberately absent from the UPDATE list. It is a local-only override
  // (SPEC.md §2) and must survive every refresh from the daemon.

  const assignToGroup = raw.prepare(`
    INSERT INTO buddy_group_members (buddy_id, group_id, sort_order)
    VALUES (?, ?, ?)
    ON CONFLICT(buddy_id) DO UPDATE SET group_id = excluded.group_id,
                                        sort_order = excluded.sort_order
  `);

  function backfillMemberships(defaultGroupId: GroupId): void {
    const strays = raw
      .prepare(
        `SELECT b.id FROM buddies b
          LEFT JOIN buddy_group_members m ON m.buddy_id = b.id
          WHERE m.buddy_id IS NULL`
      )
      .pluck()
      .all() as string[];
    let order = Number(
      raw
        .prepare(`SELECT COALESCE(MAX(sort_order), -1) FROM buddy_group_members WHERE group_id = ?`)
        .pluck()
        .get(defaultGroupId)
    );
    for (const id of strays) assignToGroup.run(id, defaultGroupId, ++order);
  }

  const store: RosterStore = {
    ensureDefaultGroup,

    upsertContacts(contacts, now) {
      const at = now ?? Date.now();
      const apply = db.transaction(() => {
        const defaultGroupId = ensureDefaultGroup();
        for (const contact of contacts) {
          if (!contact || typeof contact.uuid !== 'string' || contact.uuid.length === 0) continue;
          upsertBuddy.run({
            id: contact.uuid,
            number: contact.number ?? null,
            display_name: resolveDisplayName(contact),
            message_expiration_time: Math.max(0, Math.floor(contact.messageExpirationTime ?? 0)),
            blocked: bool(contact.isBlocked),
            hidden: bool(contact.isHidden),
            // `isRegistered` is the positive form the daemon reports; we store the negation.
            unregistered: contact.isRegistered === false ? 1 : 0,
            updated_at: at,
          });
        }
        backfillMemberships(defaultGroupId);
        return contacts.length;
      });
      return apply();
    },

    getBuddy(id) {
      const row = raw.prepare(`SELECT * FROM buddies WHERE id = ?`).get(id) as BuddyRow | undefined;
      return row ? rowToBuddy(row) : null;
    },

    listBuddies() {
      const rows = raw
        .prepare(`SELECT * FROM buddies ORDER BY display_name COLLATE NOCASE`)
        .all() as BuddyRow[];
      return rows.map(rowToBuddy);
    },

    getRoster(): Roster {
      const read = db.transaction(() => {
        const defaultGroupId = ensureDefaultGroup();
        backfillMemberships(defaultGroupId);

        const groups = raw
          .prepare(
            `SELECT id, name, sort_order, collapsed FROM buddy_groups ORDER BY sort_order, id`
          )
          .all() as { id: number; name: string; sort_order: number; collapsed: number }[];

        const buddies = raw
          .prepare(
            `SELECT b.*, m.group_id, m.sort_order AS member_sort_order
               FROM buddies b
               JOIN buddy_group_members m ON m.buddy_id = b.id
              ORDER BY m.group_id, m.sort_order, b.display_name COLLATE NOCASE`
          )
          .all() as (BuddyRow & { group_id: number; member_sort_order: number })[];

        return {
          groups: groups.map((g) => ({
            id: g.id,
            name: g.name,
            sortOrder: g.sort_order,
            collapsed: g.collapsed === 1,
          })),
          buddies: buddies.map((row) => ({
            ...rowToBuddy(row),
            groupId: row.group_id,
            sortOrder: row.member_sort_order,
          })),
        };
      });
      return read();
    },

    setNickname(id, nickname) {
      const trimmed = nickname?.trim();
      raw
        .prepare(`UPDATE buddies SET nickname = ? WHERE id = ?`)
        .run(trimmed && trimmed.length > 0 ? trimmed : null, id);
    },

    setMessageExpirationTime(id, seconds) {
      raw
        .prepare(`UPDATE buddies SET message_expiration_time = ? WHERE id = ?`)
        .run(Math.max(0, Math.floor(seconds)), id);
    },

    moveBuddy(buddyId, groupId, sortOrder) {
      const apply = db.transaction(() => {
        const exists = raw.prepare(`SELECT 1 FROM buddy_groups WHERE id = ?`).pluck().get(groupId);
        if (exists !== 1) throw new Error(`No such buddy group: ${groupId}`);
        const order =
          sortOrder ??
          Number(
            raw
              .prepare(
                `SELECT COALESCE(MAX(sort_order), -1) + 1 FROM buddy_group_members WHERE group_id = ?`
              )
              .pluck()
              .get(groupId)
          );
        // Upsert on the exclusive-membership primary key: a move replaces, never duplicates.
        assignToGroup.run(buddyId, groupId, order);
      });
      apply();
    },

    reorderBuddy(buddyId, sortOrder) {
      raw
        .prepare(`UPDATE buddy_group_members SET sort_order = ? WHERE buddy_id = ?`)
        .run(Math.floor(sortOrder), buddyId);
    },

    createGroup(name, sortOrder) {
      const trimmed = name.trim();
      if (trimmed.length === 0) throw new Error('Group name cannot be empty.');
      const apply = db.transaction(() => {
        const order =
          sortOrder ??
          Number(
            raw.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM buddy_groups`).pluck().get()
          );
        const result = raw
          .prepare(`INSERT INTO buddy_groups (name, sort_order, collapsed) VALUES (?, ?, 0)`)
          .run(trimmed, order);
        return Number(result.lastInsertRowid);
      });
      return apply();
    },

    renameGroup(groupId, name) {
      const trimmed = name.trim();
      if (trimmed.length === 0) throw new Error('Group name cannot be empty.');
      raw.prepare(`UPDATE buddy_groups SET name = ? WHERE id = ?`).run(trimmed, groupId);
    },

    deleteGroup(groupId) {
      const apply = db.transaction(() => {
        const defaultGroupId = ensureDefaultGroup();
        if (groupId === defaultGroupId) {
          throw new Error(`The default "${DEFAULT_GROUP_NAME}" group cannot be deleted.`);
        }
        // Members are re-homed, never orphaned — every buddy must remain in exactly one group.
        let order = Number(
          raw
            .prepare(
              `SELECT COALESCE(MAX(sort_order), -1) FROM buddy_group_members WHERE group_id = ?`
            )
            .pluck()
            .get(defaultGroupId)
        );
        const members = raw
          .prepare(`SELECT buddy_id FROM buddy_group_members WHERE group_id = ?`)
          .pluck()
          .all(groupId) as string[];
        for (const buddyId of members) assignToGroup.run(buddyId, defaultGroupId, ++order);
        raw.prepare(`DELETE FROM buddy_groups WHERE id = ?`).run(groupId);
      });
      apply();
    },

    reorderGroup(groupId, sortOrder) {
      raw
        .prepare(`UPDATE buddy_groups SET sort_order = ? WHERE id = ?`)
        .run(Math.floor(sortOrder), groupId);
    },

    setGroupCollapsed(groupId, collapsed) {
      raw
        .prepare(`UPDATE buddy_groups SET collapsed = ? WHERE id = ?`)
        .run(bool(collapsed), groupId);
    },

    listGroups() {
      const rows = raw
        .prepare(`SELECT id, name, sort_order, collapsed FROM buddy_groups ORDER BY sort_order, id`)
        .all() as { id: number; name: string; sort_order: number; collapsed: number }[];
      return rows.map((g) => ({
        id: g.id,
        name: g.name,
        sortOrder: g.sort_order,
        collapsed: g.collapsed === 1,
      }));
    },
  };

  return store;
}
