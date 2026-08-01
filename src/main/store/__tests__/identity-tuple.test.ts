/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * Message identity is `(author service id, sender's send timestamp)` and nothing else.
 *
 * Verified against signal-cli 0.14.6: every reaction, quote, edit, remote-delete and receipt
 * references its target by that tuple, and there is no stable server GUID in the envelopes.
 * These tests pin the invariant that makes that safe — `messages.id` is *derived* from the
 * tuple, so an id-keyed lookup and a tuple-keyed lookup cannot disagree.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';
import { deriveMessageId, computeExpiresAt } from '../messages.ts';

const ALICE = 'aaaaaaaa-0000-0000-0000-0000000000a1';
const BOB = 'bbbbbbbb-0000-0000-0000-0000000000b1';

describe('message identity', () => {
  test('the schema refuses a row whose id is not derived from the tuple', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      assert.throws(
        () =>
          store.db.raw
            .prepare(
              `INSERT INTO messages (id, conversation_id, sender_id, sent_at, kind)
               VALUES ('some-server-guid', ?, ?, ?, 'text')`
            )
            .run(ALICE, ALICE, clock.now),
        /CHECK constraint failed/i
      );

      // The derived form is accepted.
      assert.doesNotThrow(() =>
        store.db.raw
          .prepare(
            `INSERT INTO messages (id, conversation_id, sender_id, sent_at, kind)
             VALUES (?, ?, ?, ?, 'text')`
          )
          .run(deriveMessageId(ALICE, clock.now), ALICE, ALICE, clock.now)
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('there is no server_guid column for anything to depend on', () => {
    const fixture = makeStore();
    try {
      const columns = fixture.store.db.raw
        .prepare(`SELECT name FROM pragma_table_info('messages')`)
        .pluck<string>()
        .all();
      assert.ok(!columns.includes('server_guid'));
      assert.ok(columns.includes('quote_sent_at'));
    } finally {
      fixture.cleanup();
    }
  });

  test('every reference type resolves by the tuple', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentAt = clock.now;
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: ALICE,
          senderId: ALICE,
          outgoing: false,
          body: 'original text',
          sentAt,
          receivedAt: sentAt,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );
      // The caller never chose this id; it is a function of the tuple.
      assert.equal(stored.id, deriveMessageId(ALICE, sentAt));

      // Reaction, by (targetSenderId, targetSentAt).
      const reacted = store.messages.applyReaction({
        targetSenderId: ALICE,
        targetSentAt: sentAt,
        authorId: BOB,
        authorName: 'Bob',
        emoji: '♥',
      });
      assert.equal(reacted?.reactions.length, 1);

      // Receipt, by (senderId, sentAt) — the form daemon receipts arrive in.
      store.messages.setReceiptByTimestamp(ALICE, sentAt, 'read');
      assert.equal(store.messages.getMessageByNaturalKey(ALICE, sentAt)?.receipt, 'read');

      // Edit, by (senderId, targetSentAt).
      const edited = store.messages.applyEdit(ALICE, sentAt, 'corrected text', sentAt + 50);
      assert.equal(edited?.body, 'corrected text');
      assert.equal(edited?.editedAt, sentAt + 50);
      assert.equal(edited?.id, stored.id, 'the edit must land on the same row');

      // Remote delete, by (senderId, sentAt).
      const tombstone = store.messages.deleteForEveryone(ALICE, sentAt, sentAt + 100);
      assert.equal(tombstone.kind, 'tombstone');
      assert.equal(tombstone.id, stored.id);
    } finally {
      fixture.cleanup();
    }
  });

  test('a quote target is stored as a tuple and links without a caller-built id', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const quotedAt = clock.now;
      store.messages.persistInboundThenAck(
        {
          conversationId: ALICE,
          senderId: ALICE,
          outgoing: false,
          body: 'the quoted original',
          sentAt: quotedAt,
          receivedAt: quotedAt,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );

      const reply = store.messages.persistInboundThenAck(
        {
          conversationId: ALICE,
          senderId: BOB,
          outgoing: false,
          body: 'replying',
          sentAt: quotedAt + 10,
          receivedAt: quotedAt + 10,
          expiresAt: null,
          kind: 'text',
          // Note: no id anywhere. Only the tuple.
          quote: {
            authorId: ALICE,
            sentAt: quotedAt,
            authorName: 'Alice',
            text: 'the quoted original',
          },
        },
        (m) => m
      );

      assert.equal(reply.quote?.id, deriveMessageId(ALICE, quotedAt));
      assert.equal(reply.quote?.authorId, ALICE);

      const row = store.db.raw
        .prepare(`SELECT quote_author_id, quote_sent_at FROM messages WHERE id = ?`)
        .get(reply.id) as { quote_author_id: string; quote_sent_at: number };
      assert.equal(row.quote_author_id, ALICE);
      assert.equal(row.quote_sent_at, quotedAt);

      // And the link is live: deleting the original purges the quoted copy, which only works
      // if the quote's stored tuple matches the target's tuple.
      store.messages.deleteForEveryone(ALICE, quotedAt, quotedAt + 20);
      assert.equal(store.messages.getMessage(reply.id)?.quote?.text, null);
    } finally {
      fixture.cleanup();
    }
  });

  test('an identity notice is an ordinary tuple-keyed row, not a synthetic id', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.identity.record({ buddyId: ALICE, safetyNumber: 'AAAAA', at: clock.now });
      store.identity.record({ buddyId: ALICE, safetyNumber: 'BBBBB', at: clock.now + 1 });

      const notice = store.messages.getMessages(ALICE)[0];
      assert.equal(notice.kind, 'identity-change');
      assert.equal(notice.id, deriveMessageId(notice.senderId, notice.sentAt));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('the expiry clock is ours', () => {
  test('computeExpiresAt derives the deadline from a local start time', () => {
    // There is no expirationStartTimestamp in any envelope; the caller supplies the start.
    assert.equal(computeExpiresAt(30, 1_000), 1_000 + 30_000);
    assert.equal(computeExpiresAt(0, 1_000), null, '0 seconds means the timer is disabled');
    assert.equal(computeExpiresAt(null, 1_000), null);
    assert.equal(computeExpiresAt(undefined, 1_000), null);
    assert.equal(computeExpiresAt(Number.NaN, 1_000), null);
    assert.equal(computeExpiresAt(-5, 1_000), null);
  });

  test('a stored deadline is exactly what the app computed, not anything from the daemon', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const receivedAt = clock.now;
      const expiresAt = computeExpiresAt(60, receivedAt);
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: ALICE,
          senderId: ALICE,
          outgoing: false,
          body: 'timed',
          sentAt: receivedAt - 5_000, // sender's clock; deliberately not the timer basis
          receivedAt,
          expiresAt,
          kind: 'text',
        },
        (m) => m
      );
      assert.equal(stored.expiresAt, receivedAt + 60_000);
    } finally {
      fixture.cleanup();
    }
  });
});
