/**
 * Signal group conversations.
 *
 * A group is a conversation, not a roster entry. The buddy list is contacts (SPEC.md §6) and
 * `buddy_groups` is the local folder structure; neither has anything to do with this file
 * beyond the unfortunate shared word. What lives here is what the IM window needs to render a
 * group as a chat room: the group's name, and who is in it.
 *
 * Membership is replaced wholesale on every sync rather than diffed. The daemon's `listGroups`
 * is the authority on who is in a group, and a member who has left must disappear — an upsert
 * that only ever adds would accumulate ex-members forever and show them in the room list.
 */

import type { BuddyId, ConversationId, GroupChat, GroupMember } from '../../shared/types.ts';
import type { StoreDatabase } from './db.ts';
import { resolveNames } from './roster.ts';

/**
 * A group as returned by signal-cli's `listGroups` (0.14.6, verified live — see
 * docs/signal-cli-rpc.md §5.2). Everything but `id` is optional: the daemon omits fields it has
 * no value for, and a missing field degrades rather than throws.
 */
export interface RawGroup {
  /** Base64. The same string as `dataMessage.groupInfo.groupId` and the `groupId` send param. */
  id: string;
  name?: string | null;
  description?: string | null;
  isMember?: boolean | null;
  isBlocked?: boolean | null;
  messageExpirationTime?: number | null;
  members?: RawGroupMember[] | null;
  admins?: RawGroupMember[] | null;
}

export interface RawGroupMember {
  uuid?: string | null;
  number?: string | null;
  isAdmin?: boolean | null;
}

export interface SignalGroupStore {
  /** Replaces the stored set of groups' details and membership. Returns groups written. */
  upsertGroups(groups: RawGroup[], now?: number): number;
  /**
   * The group, with member names resolved. `selfId` marks the user's own entry so the room
   * list can show it as themselves rather than as a stranger with their own name.
   */
  getGroup(id: ConversationId, selfId?: BuddyId | null): GroupChat | null;
  listGroups(selfId?: BuddyId | null): GroupChat[];
  /** True if this conversation id is a group we have synced. */
  isKnownGroup(id: ConversationId): boolean;
  /** Members' ACIs only — no name resolution. */
  memberIds(id: ConversationId): BuddyId[];
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  is_member: number;
  is_blocked: number;
  message_expiration_time: number;
  updated_at: number;
}

function bool(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

export function createSignalGroupStore(db: StoreDatabase): SignalGroupStore {
  const raw = db.raw;

  const upsertGroup = raw.prepare(`
    INSERT INTO signal_groups (
      id, name, description, is_member, is_blocked, message_expiration_time, updated_at
    ) VALUES (@id, @name, @description, @is_member, @is_blocked, @message_expiration_time,
              @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name                    = excluded.name,
      description             = excluded.description,
      is_member               = excluded.is_member,
      is_blocked              = excluded.is_blocked,
      message_expiration_time = excluded.message_expiration_time,
      updated_at              = excluded.updated_at
  `);

  const clearMembers = raw.prepare(`DELETE FROM signal_group_members WHERE group_id = ?`);
  const insertMember = raw.prepare(`
    INSERT INTO signal_group_members (group_id, member_id, is_admin) VALUES (?, ?, ?)
    ON CONFLICT(group_id, member_id) DO UPDATE SET is_admin = excluded.is_admin
  `);

  const selectGroup = raw.prepare(`SELECT * FROM signal_groups WHERE id = ?`);
  const selectMembers = raw.prepare(
    `SELECT member_id, is_admin FROM signal_group_members WHERE group_id = ?`
  );

  function hydrate(row: GroupRow, selfId: BuddyId | null): GroupChat {
    const memberRows = selectMembers.all(row.id) as { member_id: string; is_admin: number }[];
    const names = resolveNames(
      db,
      memberRows.map((m) => m.member_id)
    );
    const members: GroupMember[] = memberRows
      .map((m) => ({
        id: m.member_id,
        name: names.get(m.member_id) ?? m.member_id,
        isAdmin: m.is_admin === 1,
        isSelf: selfId !== null && m.member_id === selfId,
      }))
      // Admins first, then alphabetical — the AIM chat-room list was never in arrival order.
      .sort((a, b) =>
        a.isAdmin === b.isAdmin
          ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
          : a.isAdmin
            ? -1
            : 1
      );

    return {
      id: row.id,
      // A group with no name of its own is legal on Signal; the member list is what identifies
      // it, so say that rather than rendering an empty title bar.
      name: row.name.trim().length > 0 ? row.name.trim() : 'Unnamed group',
      members,
      messageExpirationTime: row.message_expiration_time,
      blocked: row.is_blocked === 1,
      isMember: row.is_member === 1,
    };
  }

  return {
    upsertGroups(groups, now) {
      const at = now ?? Date.now();
      const apply = db.transaction(() => {
        let written = 0;
        for (const group of groups) {
          if (!group || typeof group.id !== 'string' || group.id.length === 0) continue;

          upsertGroup.run({
            id: group.id,
            name: (group.name ?? '').trim(),
            description: group.description ?? null,
            // Absent means present: the daemon lists groups the account belongs to, and
            // defaulting to "not a member" would silently disable sending.
            is_member: group.isMember === false ? 0 : 1,
            is_blocked: bool(group.isBlocked),
            message_expiration_time: Math.max(0, Math.floor(group.messageExpirationTime ?? 0)),
            updated_at: at,
          });

          // `admins` repeats entries that are already in `members`; the flag is what it adds.
          const admins = new Set(
            (group.admins ?? []).flatMap((a) => (typeof a?.uuid === 'string' ? [a.uuid] : []))
          );
          clearMembers.run(group.id);
          const seen = new Set<string>();
          for (const member of [...(group.members ?? []), ...(group.admins ?? [])]) {
            const uuid = member?.uuid;
            // A member known only by phone number cannot be matched to a message sender, which
            // is always an ACI. Skipping keeps the room list honest about who we can attribute.
            if (typeof uuid !== 'string' || uuid.length === 0 || seen.has(uuid)) continue;
            seen.add(uuid);
            insertMember.run(group.id, uuid, bool(member.isAdmin === true || admins.has(uuid)));
          }
          written += 1;
        }
        return written;
      });
      return apply();
    },

    getGroup(id, selfId) {
      const row = selectGroup.get(id) as GroupRow | undefined;
      return row ? hydrate(row, selfId ?? null) : null;
    },

    listGroups(selfId) {
      const rows = raw
        .prepare(`SELECT * FROM signal_groups ORDER BY name COLLATE NOCASE`)
        .all() as GroupRow[];
      return rows.map((row) => hydrate(row, selfId ?? null));
    },

    isKnownGroup(id) {
      return raw.prepare(`SELECT 1 FROM signal_groups WHERE id = ?`).pluck().get(id) === 1;
    },

    memberIds(id) {
      return selectMembers.all(id).map((m) => (m as { member_id: string }).member_id);
    },
  };
}
