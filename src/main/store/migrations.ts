/**
 * Versioned, forward-only schema migrations.
 *
 * Rules:
 *  - Migrations are append-only. Never edit a migration that has shipped; add a new one.
 *  - Each migration runs inside its own transaction and bumps `PRAGMA user_version`.
 *  - `user_version` is the authority. `schema_migrations` is an audit log.
 *
 * Schema notes (deltas from SPEC.md §6, all deliberate and verified against signal-cli 0.14.6):
 *  - `buddies.profile_key` is NOT present. signal-cli does not expose profile keys through its
 *    API, and SPEC.md §10 forbids key handling in this codebase. A column that can never be
 *    populated is a liability, not documentation.
 *  - `buddies.id` is the contact `uuid` (the ACI) as returned by `listContacts`.
 *  - `buddies.message_expiration_time` holds the per-contact disappearing-message timer in
 *    seconds, which `listContacts` does return.
 *  - `PRIMARY KEY (buddy_id)` on `buddy_group_members` is retained: it is what enforces
 *    exclusive group membership at the schema level (SPEC.md §6).
 *  - Tables are STRICT so a type error is a loud failure rather than a silently coerced row.
 */

import type { SqliteDatabase } from './db.ts';

export interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
  /**
   * Set for migrations that rebuild a table other tables reference. SQLite's supported
   * 12-step ALTER requires foreign keys to be disabled around the rebuild, otherwise the
   * `DROP TABLE` cascades into the child rows we are trying to preserve. The runner toggles
   * the pragma outside the transaction and runs `foreign_key_check` before committing.
   */
  requiresForeignKeysOff?: boolean;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-roster-messages-geometry',
    up: (db) => {
      db.exec(`
        CREATE TABLE buddies (
          id                      TEXT    PRIMARY KEY NOT NULL,  -- Signal ACI/UUID
          number                  TEXT,                          -- E.164, may be absent
          display_name            TEXT    NOT NULL DEFAULT '',
          nickname                TEXT,                          -- local-only override
          message_expiration_time INTEGER NOT NULL DEFAULT 0,    -- seconds; 0 = disabled
          blocked                 INTEGER NOT NULL DEFAULT 0,
          hidden                  INTEGER NOT NULL DEFAULT 0,
          unregistered            INTEGER NOT NULL DEFAULT 0,
          updated_at              INTEGER NOT NULL DEFAULT 0
        ) STRICT;

        CREATE TABLE buddy_groups (
          id         INTEGER PRIMARY KEY,
          name       TEXT    NOT NULL,
          sort_order INTEGER NOT NULL,
          collapsed  INTEGER NOT NULL DEFAULT 0
        ) STRICT;

        CREATE UNIQUE INDEX buddy_groups_name ON buddy_groups(name COLLATE NOCASE);

        -- PRIMARY KEY (buddy_id) is the exclusive-membership constraint. Do not widen it.
        CREATE TABLE buddy_group_members (
          buddy_id   TEXT    NOT NULL REFERENCES buddies(id)      ON DELETE CASCADE,
          group_id   INTEGER NOT NULL REFERENCES buddy_groups(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (buddy_id)
        ) STRICT;

        CREATE INDEX buddy_group_members_group ON buddy_group_members(group_id, sort_order);

        CREATE TABLE messages (
          id                TEXT    PRIMARY KEY NOT NULL,
          conversation_id   TEXT    NOT NULL,
          sender_id         TEXT    NOT NULL,
          outgoing          INTEGER NOT NULL DEFAULT 0,
          body              TEXT,
          sent_at           INTEGER NOT NULL,
          received_at       INTEGER,
          expires_at        INTEGER,   -- absolute ms; NULL = never (SPEC.md §8)
          edited_at         INTEGER,
          deleted_at        INTEGER,   -- set when tombstoned (deleted for everyone)
          quote_id          TEXT,
          quote_author_id   TEXT,
          quote_author_name TEXT,
          quote_text        TEXT,      -- denormalised copy; purged with the quoted original
          kind              TEXT    NOT NULL,
          receipt           TEXT,
          had_view_once     INTEGER NOT NULL DEFAULT 0,  -- media was view-once; never stored
          server_guid       TEXT
        ) STRICT;

        -- Idempotency key for redelivered inbound messages. signal-cli identifies a message
        -- by (source account, send timestamp); a redelivery carries the same pair.
        CREATE UNIQUE INDEX messages_natural_key ON messages(sender_id, sent_at);
        CREATE INDEX messages_conversation ON messages(conversation_id, sent_at);
        CREATE INDEX messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX messages_quote_id ON messages(quote_id) WHERE quote_id IS NOT NULL;

        CREATE TABLE window_geometry (
          conversation_id TEXT PRIMARY KEY NOT NULL,
          x               INTEGER,
          y               INTEGER,
          w               INTEGER,
          h               INTEGER,
          updated_at      INTEGER NOT NULL DEFAULT 0
        ) STRICT;
      `);
    },
  },

  {
    version: 2,
    name: 'attachments-reactions-identity',
    up: (db) => {
      db.exec(`
        -- CHECK (view_once = 0) is a schema-level guarantee that view-once media can never be
        -- persisted, even by a future caller that forgets the rule (SPEC.md §8).
        CREATE TABLE attachments (
          id            TEXT    PRIMARY KEY NOT NULL,
          message_id    TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          sort_order    INTEGER NOT NULL DEFAULT 0,
          content_type  TEXT    NOT NULL DEFAULT 'application/octet-stream',
          filename      TEXT,
          size          INTEGER,
          path          TEXT,
          view_once     INTEGER NOT NULL DEFAULT 0 CHECK (view_once = 0),
          is_voice_note INTEGER NOT NULL DEFAULT 0
        ) STRICT;

        CREATE INDEX attachments_message ON attachments(message_id);

        CREATE TABLE reactions (
          message_id  TEXT    NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          author_id   TEXT    NOT NULL,
          author_name TEXT    NOT NULL DEFAULT '',
          emoji       TEXT    NOT NULL,
          received_at INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (message_id, author_id)
        ) STRICT;

        -- Safety-number / identity state. A security signal is never swallowed (SPEC.md §8).
        CREATE TABLE identity_records (
          buddy_id        TEXT    PRIMARY KEY NOT NULL,
          safety_number   TEXT,
          trust_level     TEXT    NOT NULL DEFAULT 'UNTRUSTED',
          first_seen_at   INTEGER NOT NULL,
          changed_at      INTEGER,
          acknowledged_at INTEGER
        ) STRICT;

        CREATE INDEX identity_records_unacknowledged
          ON identity_records(changed_at) WHERE acknowledged_at IS NULL;
      `);
    },
  },

  {
    version: 3,
    name: 'outbound-queue-and-echo-ledger',
    up: (db) => {
      db.exec(`
        -- Written BEFORE a send is attempted, so a crash mid-send cannot vaporise a message
        -- the user believes they sent. Doubles as the echo-protection ledger (SPEC.md §8):
        -- when our own message returns as a sync message from the phone, its timestamp is
        -- looked up here and the echo is suppressed.
        --
        -- Content lifetime is deliberately short: once a row reaches state 'sent' the body and
        -- attachment list are nulled, leaving only the timestamp. The ledger therefore retains
        -- no message content that could outlive a disappearing-message timer.
        CREATE TABLE outbound_queue (
          id               TEXT    PRIMARY KEY NOT NULL,   -- client-generated message id
          conversation_id  TEXT    NOT NULL,
          recipient_id     TEXT,
          body             TEXT,
          attachments_json TEXT,
          created_at       INTEGER NOT NULL,
          sent_timestamp   INTEGER,                        -- daemon-assigned; echo ledger key
          state            TEXT    NOT NULL
                                   CHECK (state IN ('queued','sending','sent','failed')),
          retry_count      INTEGER NOT NULL DEFAULT 0,
          next_attempt_at  INTEGER NOT NULL DEFAULT 0,
          last_error       TEXT,
          expires_at       INTEGER
        ) STRICT;

        CREATE INDEX outbound_queue_pending ON outbound_queue(state, next_attempt_at);
        CREATE INDEX outbound_queue_sent_timestamp
          ON outbound_queue(sent_timestamp) WHERE sent_timestamp IS NOT NULL;
        CREATE INDEX outbound_queue_expires
          ON outbound_queue(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX outbound_queue_conversation ON outbound_queue(conversation_id, created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'message-identity-is-the-tuple',
    requiresForeignKeysOff: true,
    up: (db) => {
      // Verified against signal-cli 0.14.6: a message is identified by
      // (author service id, sender's send timestamp). Every reaction, quote, edit,
      // remote-delete and receipt references its target by that tuple. There is **no stable
      // server GUID in the JSON envelopes at all**, so `server_guid` is removed rather than
      // left as a column nothing can populate.
      //
      // Two changes make the tuple the only identity that exists:
      //
      //  1. CHECK (id = sender_id || ':' || sent_at) — `messages.id` is now provably derived
      //     from the tuple. An id-keyed lookup and a tuple-keyed lookup cannot disagree,
      //     because a row whose id is not the derived value cannot be inserted.
      //  2. `quote_sent_at` — a quote now stores its target as an explicit
      //     (quote_author_id, quote_sent_at) tuple instead of relying on the caller to have
      //     built a matching id string. `quote_id` remains as the derived convenience value.
      db.exec(`
        CREATE TABLE messages_new (
          id                TEXT    PRIMARY KEY NOT NULL,
          conversation_id   TEXT    NOT NULL,
          sender_id         TEXT    NOT NULL,
          outgoing          INTEGER NOT NULL DEFAULT 0,
          body              TEXT,
          sent_at           INTEGER NOT NULL,
          received_at       INTEGER,
          expires_at        INTEGER,
          edited_at         INTEGER,
          deleted_at        INTEGER,
          quote_id          TEXT,
          quote_author_id   TEXT,
          quote_sent_at     INTEGER,
          quote_author_name TEXT,
          quote_text        TEXT,
          kind              TEXT    NOT NULL,
          receipt           TEXT,
          had_view_once     INTEGER NOT NULL DEFAULT 0,
          CHECK (id = sender_id || ':' || sent_at)
        ) STRICT;

        -- Rows whose id was not already the derived value are rewritten to it, so the copy
        -- cannot fail the new CHECK.
        INSERT INTO messages_new (
          id, conversation_id, sender_id, outgoing, body, sent_at, received_at, expires_at,
          edited_at, deleted_at, quote_id, quote_author_id, quote_sent_at, quote_author_name,
          quote_text, kind, receipt, had_view_once
        )
        SELECT
          sender_id || ':' || sent_at, conversation_id, sender_id, outgoing, body, sent_at,
          received_at, expires_at, edited_at, deleted_at, quote_id, quote_author_id,
          CAST(substr(quote_id, instr(quote_id, ':') + 1) AS INTEGER), quote_author_name,
          quote_text, kind, receipt, had_view_once
        FROM messages;

        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;

        CREATE UNIQUE INDEX messages_natural_key ON messages(sender_id, sent_at);
        CREATE INDEX messages_conversation ON messages(conversation_id, sent_at);
        CREATE INDEX messages_expires_at ON messages(expires_at) WHERE expires_at IS NOT NULL;
        CREATE INDEX messages_quote_target
          ON messages(quote_author_id, quote_sent_at) WHERE quote_author_id IS NOT NULL;
      `);
    },
  },
];

/** Highest schema version this build knows how to produce. */
export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0
);
