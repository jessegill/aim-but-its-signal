/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * The buddy list is conversation-driven: a contact earns a row by having a conversation, or by
 * the user explicitly shelving them. These are the two halves of that rule.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';

const ADA = 'aaaaaaaa-1111-1111-1111-111111111111';
const GRACE = 'bbbbbbbb-2222-2222-2222-222222222222';
const GROUP = 'Z3JvdXAtaWQtYmFzZTY0';

describe('conversation shelves', () => {
  test("'normal' is the absence of a row, not a stored value", () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      assert.equal(store.shelves.get(ADA), 'normal');

      store.shelves.set(ADA, 'pinned');
      assert.equal(store.shelves.get(ADA), 'pinned');
      assert.equal(store.shelves.listShelved().length, 1);

      // Un-pinning deletes rather than writing a default, so the table only ever holds
      // conversations the user has actually sorted.
      store.shelves.set(ADA, 'normal');
      assert.equal(store.shelves.get(ADA), 'normal');
      assert.deepEqual(store.shelves.listShelved(), []);
      assert.equal(
        Number(store.db.raw.prepare('SELECT count(*) FROM conversation_shelf').pluck().get()),
        0
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('the schema refuses a shelf it does not know', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      assert.throws(
        () =>
          store.db.raw
            .prepare(
              `INSERT INTO conversation_shelf (conversation_id, shelf, updated_at)
                      VALUES (?, ?, 0)`
            )
            .run(ADA, 'somewhere-else'),
        /CHECK constraint failed/i
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('a shelf applies to a chat room exactly as it does to a person', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.shelves.set(GROUP, 'archived');
      store.shelves.set(ADA, 'pinned');

      const shelved = [...store.shelves.listShelved()].sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(shelved, [
        { id: ADA, shelf: 'pinned' },
        { id: GROUP, shelf: 'archived' },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('a shelf outlives the contact it points at', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      // Deliberately no roster entry and no group row: the shelf is keyed by conversation id
      // and must not be a foreign key to either table.
      store.shelves.set('someone-who-is-gone', 'archived');
      assert.equal(store.shelves.get('someone-who-is-gone'), 'archived');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('conversation activity', () => {
  test('only conversations with messages are listed, newest first', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.roster.upsertContacts([
        { uuid: ADA, name: 'Ada' },
        { uuid: GRACE, name: 'Grace' },
      ]);

      // Grace is a contact who has never written. She must not appear.
      store.messages.persistInboundThenAck(
        {
          conversationId: ADA,
          senderId: ADA,
          outgoing: false,
          body: 'first',
          sentAt: clock.now,
          receivedAt: clock.now,
          kind: 'text',
        },
        (m) => m
      );
      store.messages.persistInboundThenAck(
        {
          conversationId: GROUP,
          senderId: ADA,
          outgoing: false,
          body: 'later, in a room',
          sentAt: clock.now + 5000,
          receivedAt: clock.now + 5000,
          kind: 'text',
        },
        (m) => m
      );

      const activity = store.messages.listConversationActivity();
      assert.deepEqual(
        activity.map((a) => a.conversationId),
        [GROUP, ADA],
        'most recent conversation first'
      );
      assert.equal(activity[1].lastMessageAt, clock.now);
      assert.ok(!activity.some((a) => a.conversationId === GRACE));
    } finally {
      fixture.cleanup();
    }
  });

  test('a conversation whose history has entirely expired stops being listed', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.persistInboundThenAck(
        {
          conversationId: ADA,
          senderId: ADA,
          outgoing: false,
          body: 'this disappears',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: clock.now + 1000,
          kind: 'text',
        },
        (m) => m
      );
      assert.equal(store.messages.listConversationActivity().length, 1);

      // Not a bug: with every message gone there is no conversation left to show, and leaving
      // a row behind would advertise that one existed.
      clock.now += 5000;
      assert.deepEqual(store.messages.listConversationActivity(), []);
    } finally {
      fixture.cleanup();
    }
  });
});
