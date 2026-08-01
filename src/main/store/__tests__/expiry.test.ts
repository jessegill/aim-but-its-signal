/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 / §11.4 — disappearing messages.
 *
 * "A message the sender believed was ephemeral must not persist in local SQLite." These tests
 * check both halves of that: it is not *readable* through any public path, and it is not
 * *present* in the database file.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { makeStore, fileContains, walkFiles } from './helpers.ts';

const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const CONVO = ALICE;

describe('disappearing messages', () => {
  test('an expired message is unreadable through every public read path', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const expiresAt = clock.now + 5_000;

      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: 'ephemeral-body',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt,
          kind: 'text',
        },
        (m) => m
      );
      // A second, permanent message so "empty result" cannot be mistaken for "no data at all".
      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: 'permanent-body',
          sentAt: clock.now + 1,
          receivedAt: clock.now + 1,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );

      // Before expiry it is readable.
      assert.equal(store.messages.getMessages(CONVO).length, 2);
      assert.ok(store.messages.getMessageByNaturalKey(ALICE, fixture.clock.now));

      // Move past the timer. The sweeper interval is 60s in tests and is never started here,
      // so anything that still returns the message would be a real leak, not a timing artefact.
      const sentAt = clock.now;
      clock.now = expiresAt + 1;

      const listed = store.messages.getMessages(CONVO);
      assert.deepEqual(
        listed.map((m) => m.body),
        ['permanent-body']
      );
      assert.equal(store.messages.getMessage(`${ALICE}:${sentAt}`), null);
      assert.equal(store.messages.getMessageByNaturalKey(ALICE, sentAt), null);
      assert.equal(store.messages.countMessages(CONVO), 1);
      assert.equal(store.messages.getLatestMessage(CONVO)?.body, 'permanent-body');
      assert.deepEqual(store.messages.listConversationIds(), [CONVO]);

      // Reactions and edits must not resurrect it either.
      assert.equal(
        store.messages.applyReaction({
          targetSenderId: ALICE,
          targetSentAt: sentAt,
          authorId: ALICE,
          authorName: 'Alice',
          emoji: '♥',
        }),
        null
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('an expired message is physically gone from the database file', () => {
    // Runs against a plaintext database on purpose: on an encrypted file the body would be
    // absent whether or not deletion worked, so the assertion would prove nothing.
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-c4f1e0-ephemeral-payload';
      const expiresAt = clock.now + 5_000;

      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: needle,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt,
          kind: 'text',
        },
        (m) => m
      );

      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle), 'precondition: body is in the file');
      assert.equal(store.db.encrypted, false, 'precondition: this test needs a plaintext file');

      clock.now = expiresAt + 1;
      const removed = store.messages.sweepExpired();
      assert.deepEqual(
        removed.map((r) => r.id),
        [`${ALICE}:${expiresAt - 5_000}`]
      );

      assert.ok(
        !fileContains(fixture.file, needle),
        'expired body still present in the database file, WAL or shm'
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('a read alone purges expired rows, even if the sweeper never fires', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-read-path-purge';
      const expiresAt = clock.now + 1_000;
      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: needle,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt,
          kind: 'text',
        },
        (m) => m
      );
      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle));

      clock.now = expiresAt + 1;
      // No explicit sweep — only a read.
      assert.deepEqual(store.messages.getMessages(CONVO), []);

      assert.ok(!fileContains(fixture.file, needle), 'read path did not purge the expired row');
      assert.equal(Number(store.db.raw.prepare('SELECT count(*) FROM messages').pluck().get()), 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('expiry removes attachment rows and the cached files', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = `${fixture.dir}/incoming.bin`;
      fs.writeFileSync(source, Buffer.from('ATTACHMENT-NEEDLE-payload'));

      const expiresAt = clock.now + 1_000;
      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: null,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt,
          kind: 'attachment',
          attachments: [
            {
              id: 'att-1',
              contentType: 'application/octet-stream',
              filename: 'incoming.bin',
              size: 25,
              path: source,
              viewOnce: false,
              isVoiceNote: false,
            },
          ],
        },
        (m) => m
      );

      const cached = walkFiles(store.attachments.dir);
      assert.equal(cached.length, 1);
      assert.ok(fs.existsSync(cached[0]));

      clock.now = expiresAt + 1;
      store.messages.sweepExpired();

      assert.equal(
        Number(store.db.raw.prepare('SELECT count(*) FROM attachments').pluck().get()),
        0
      );
      assert.equal(walkFiles(store.attachments.dir).length, 0, 'cached attachment survived expiry');
      assert.ok(!fs.existsSync(cached[0]));
    } finally {
      fixture.cleanup();
    }
  });

  test('an expiring message is purged from the outbound queue too', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-queued-ephemeral';
      const expiresAt = clock.now + 1_000;
      store.messages.enqueueOutbound({
        id: 'out-1',
        conversationId: CONVO,
        recipientId: ALICE,
        body: needle,
        expiresAt,
        now: clock.now,
      });
      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle));

      clock.now = expiresAt + 1;
      store.messages.sweepExpired();

      assert.equal(store.messages.getOutbound('out-1'), null);
      assert.ok(!fileContains(fixture.file, needle), 'queued ephemeral body survived expiry');
    } finally {
      fixture.cleanup();
    }
  });

  test('a quoted copy of an expiring message is purged with it', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-quoted-original';
      const expiresAt = clock.now + 1_000;
      const original = store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: needle,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt,
          kind: 'text',
        },
        (m) => m
      );

      store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: 'replying to that',
          sentAt: clock.now + 10,
          receivedAt: clock.now + 10,
          expiresAt: null,
          kind: 'text',
          quote: {
            authorId: ALICE,
            sentAt: original.sentAt,
            authorName: 'Alice',
            text: needle,
          },
        },
        (m) => m
      );

      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle));

      clock.now = expiresAt + 1;
      store.messages.sweepExpired();

      const remaining = store.messages.getMessages(CONVO);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].quote?.text, null);
      assert.ok(!fileContains(fixture.file, needle), 'the quoted copy outlived the original');
    } finally {
      fixture.cleanup();
    }
  });

  test('startExpiryTimer never extends an existing timer', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: CONVO,
          senderId: ALICE,
          outgoing: false,
          body: 'timed',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: clock.now + 1_000,
          kind: 'text',
        },
        (m) => m
      );
      // A later, longer timer must not push the deadline out.
      assert.equal(store.messages.startExpiryTimer(stored.id, 60, clock.now), null);
      assert.equal(store.messages.getMessage(stored.id)?.expiresAt, clock.now + 1_000);
    } finally {
      fixture.cleanup();
    }
  });
});
