/**
 * Safety numbers and identity-key changes.
 *
 * SPEC.md §8: identity changes are security-critical. They are persisted here **and** written
 * into the conversation as a `kind: 'identity-change'` message, so the IM window has something
 * to render. "The retro idiom has no place for it" is never a reason to drop a security
 * signal — style it to fit the era instead.
 *
 * Nothing here touches key material (SPEC.md §10). A safety number is a public fingerprint
 * string produced by the daemon; we store it verbatim and compare it for equality.
 */

import type { BuddyId, ConversationId } from '../../shared/types.ts';
import type { StoreDatabase } from './db.ts';
import type { MessageStore } from './messages.ts';

export type TrustLevel = 'TRUSTED_UNVERIFIED' | 'TRUSTED_VERIFIED' | 'UNTRUSTED';

export interface IdentityRecord {
  buddyId: BuddyId;
  safetyNumber: string | null;
  trustLevel: TrustLevel;
  firstSeenAt: number;
  /** When the safety number last changed. Null if it has never changed since first seen. */
  changedAt: number | null;
  /** Null while the user has not yet dismissed the warning. */
  acknowledgedAt: number | null;
}

export interface RecordIdentityInput {
  buddyId: BuddyId;
  safetyNumber: string | null;
  trustLevel?: TrustLevel;
  /** Conversation to post the notice into. Defaults to the buddy's 1:1 conversation. */
  conversationId?: ConversationId;
  at?: number;
}

export interface IdentityResult {
  record: IdentityRecord;
  /** True when this was a *change* to a previously known safety number, not a first sighting. */
  changed: boolean;
}

export interface IdentityStore {
  record(input: RecordIdentityInput): IdentityResult;
  get(buddyId: BuddyId): IdentityRecord | null;
  listUnacknowledged(): IdentityRecord[];
  acknowledge(buddyId: BuddyId, at?: number): void;
  setTrustLevel(buddyId: BuddyId, trustLevel: TrustLevel, at?: number): void;
}

interface IdentityRow {
  buddy_id: string;
  safety_number: string | null;
  trust_level: string;
  first_seen_at: number;
  changed_at: number | null;
  acknowledged_at: number | null;
}

function toRecord(row: IdentityRow): IdentityRecord {
  return {
    buddyId: row.buddy_id,
    safetyNumber: row.safety_number,
    trustLevel: row.trust_level as TrustLevel,
    firstSeenAt: row.first_seen_at,
    changedAt: row.changed_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

export function createIdentityStore(db: StoreDatabase, messages: MessageStore): IdentityStore {
  const raw = db.raw;

  const select = raw.prepare<IdentityRow>(`SELECT * FROM identity_records WHERE buddy_id = ?`);

  /**
   * Identity notices are ordinary message rows, and a message's identity IS its
   * `(sender_id, sent_at)` tuple — there is no synthetic id to fall back on. So the notice
   * must claim a free timestamp. Collisions with a real message at the same millisecond are
   * vanishingly rare but would silently be treated as a redelivery, so nudge forward until
   * the slot is free.
   */
  function freeTimestamp(senderId: BuddyId, preferred: number): number {
    const taken = raw
      .prepare(`SELECT 1 FROM messages WHERE sender_id = ? AND sent_at = ?`)
      .pluck<number>();
    let candidate = preferred;
    for (let i = 0; i < 1000; i += 1) {
      if (taken.get(senderId, candidate) !== 1) return candidate;
      candidate += 1;
    }
    throw new Error(`Could not find a free timestamp for an identity notice on ${senderId}.`);
  }

  return {
    record(input) {
      const at = input.at ?? Date.now();
      const conversationId = input.conversationId ?? input.buddyId;

      const existing = select.get(input.buddyId);
      const changed =
        existing?.safety_number != null &&
        input.safetyNumber != null &&
        existing.safety_number !== input.safetyNumber;

      const apply = db.transaction(() => {
        if (!existing) {
          raw
            .prepare(
              `INSERT INTO identity_records
                 (buddy_id, safety_number, trust_level, first_seen_at, changed_at, acknowledged_at)
               VALUES (?, ?, ?, ?, NULL, ?)`
            )
            .run(
              input.buddyId,
              input.safetyNumber,
              input.trustLevel ?? 'TRUSTED_UNVERIFIED',
              at,
              at // a first sighting needs no acknowledgement
            );
        } else if (changed) {
          raw
            .prepare(
              `UPDATE identity_records
                  SET safety_number = ?, trust_level = ?, changed_at = ?, acknowledged_at = NULL
                WHERE buddy_id = ?`
            )
            // A changed key is untrusted again until the user verifies it, regardless of what
            // it was before. Never silently carry a previous "verified" over a key change.
            .run(input.safetyNumber, input.trustLevel ?? 'UNTRUSTED', at, input.buddyId);
        } else if (input.trustLevel) {
          raw
            .prepare(
              `UPDATE identity_records SET trust_level = ?, safety_number = ? WHERE buddy_id = ?`
            )
            .run(input.trustLevel, input.safetyNumber ?? existing.safety_number, input.buddyId);
        }
      });
      apply();

      if (changed) {
        // Persisted as a conversation entry so it cannot be lost between app runs, and so the
        // IM window renders it in-line where the user is already looking.
        messages.persistInboundThenAck(
          {
            conversationId,
            senderId: input.buddyId,
            outgoing: false,
            body: 'Safety number changed. Verify before sending anything sensitive.',
            sentAt: freeTimestamp(input.buddyId, at),
            receivedAt: at,
            // Never given an expiry: a security notice must not disappear on a timer.
            expiresAt: null,
            kind: 'identity-change',
          },
          (message) => message
        );
      }

      const record = toRecord(select.get(input.buddyId)!);
      return { record, changed };
    },

    get(buddyId) {
      const row = select.get(buddyId);
      return row ? toRecord(row) : null;
    },

    listUnacknowledged() {
      const rows = raw
        .prepare<IdentityRow>(
          `SELECT * FROM identity_records WHERE acknowledged_at IS NULL ORDER BY changed_at DESC`
        )
        .all();
      return rows.map(toRecord);
    },

    acknowledge(buddyId, at) {
      raw
        .prepare(`UPDATE identity_records SET acknowledged_at = ? WHERE buddy_id = ?`)
        .run(at ?? Date.now(), buddyId);
    },

    setTrustLevel(buddyId, trustLevel, at) {
      raw
        .prepare(
          `UPDATE identity_records SET trust_level = ?, acknowledged_at = ? WHERE buddy_id = ?`
        )
        .run(trustLevel, at ?? Date.now(), buddyId);
    },
  };
}
