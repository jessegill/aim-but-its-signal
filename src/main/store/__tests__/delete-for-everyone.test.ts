/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 — "deleted for everyone": replace with a tombstone and purge the original from
 * the store.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeStore, fileContains, walkFiles } from './helpers.ts';

const CARL = 'cccccccc-0000-0000-0000-000000000003';

describe('deleted for everyone', () => {
  test('purges the original body and leaves a tombstone', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-regretted-message-text';
      const original = store.messages.persistInboundThenAck(
        {
          conversationId: CARL,
          senderId: CARL,
          outgoing: false,
          body: needle,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );

      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle), 'precondition: body is in the file');

      const tombstone = store.messages.deleteForEveryone(CARL, clock.now, clock.now + 500);

      assert.equal(tombstone.id, original.id);
      assert.equal(tombstone.kind, 'tombstone');
      assert.equal(tombstone.body, null);
      assert.deepEqual(tombstone.attachments, []);
      assert.deepEqual(tombstone.reactions, []);

      // The tombstone is still in the conversation — history does not silently lose a slot.
      const listed = store.messages.getMessages(CARL);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].kind, 'tombstone');
      assert.equal(listed[0].body, null);

      assert.ok(!fileContains(fixture.file, needle), 'original body survived the deletion');
    } finally {
      fixture.cleanup();
    }
  });

  test('purges attachments, their cached files, and reactions', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const daemonDir = path.join(fixture.dir, 'daemon-attachments');
      fs.mkdirSync(daemonDir, { recursive: true });
      const source = path.join(daemonDir, 'evidence.bin');
      fs.writeFileSync(source, 'ATTACHMENT-NEEDLE-evidence');

      const original = store.messages.persistInboundThenAck(
        {
          conversationId: CARL,
          senderId: CARL,
          outgoing: false,
          body: 'with attachment',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'attachment',
          attachments: [
            {
              id: 'att-del-1',
              contentType: 'application/octet-stream',
              filename: 'evidence.bin',
              size: 26,
              path: source,
              viewOnce: false,
              isVoiceNote: false,
            },
          ],
        },
        (m) => m
      );

      store.messages.applyReaction({
        targetSenderId: CARL,
        targetSentAt: clock.now,
        authorId: CARL,
        authorName: 'Carl',
        emoji: '♥',
      });

      const cachedPath = original.attachments[0].path!;
      assert.ok(fs.existsSync(cachedPath));

      store.messages.deleteForEveryone(CARL, clock.now, clock.now + 1);

      assert.equal(
        Number(store.db.raw.prepare('SELECT count(*) FROM attachments').pluck().get()),
        0
      );
      assert.equal(Number(store.db.raw.prepare('SELECT count(*) FROM reactions').pluck().get()), 0);
      assert.ok(!fs.existsSync(cachedPath), 'cached attachment survived deletion');
      assert.deepEqual(walkFiles(store.attachments.dir), []);
      assert.ok(!fileContains(fixture.file, 'ATTACHMENT-NEEDLE-evidence'));
    } finally {
      fixture.cleanup();
    }
  });

  test('purges the denormalised copy held by a quoting message', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-quoted-then-deleted';
      const original = store.messages.persistInboundThenAck(
        {
          conversationId: CARL,
          senderId: CARL,
          outgoing: false,
          body: needle,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );
      store.messages.persistInboundThenAck(
        {
          conversationId: CARL,
          senderId: CARL,
          outgoing: false,
          body: 'quoting it',
          sentAt: clock.now + 5,
          receivedAt: clock.now + 5,
          expiresAt: null,
          kind: 'text',
          quote: { authorId: CARL, sentAt: original.sentAt, authorName: 'Carl', text: needle },
        },
        (m) => m
      );

      store.messages.deleteForEveryone(CARL, clock.now, clock.now + 10);

      const quoting = store.messages.getMessageByNaturalKey(CARL, clock.now + 5);
      assert.equal(quoting?.quote?.text, null);
      assert.ok(!fileContains(fixture.file, needle), 'quote copy of the deleted body survived');
    } finally {
      fixture.cleanup();
    }
  });

  test('writes a tombstone even if the original was never received', () => {
    // The delete can arrive before the message it refers to. History must still be coherent.
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const tombstone = store.messages.deleteForEveryone(CARL, clock.now, clock.now);
      assert.equal(tombstone.kind, 'tombstone');
      assert.equal(tombstone.body, null);
      assert.equal(store.messages.getMessages(CARL).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('clears the queued copy of our own deleted message', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'NEEDLE-own-sent-then-deleted';
      store.messages.enqueueOutbound({
        id: 'out-del-1',
        conversationId: CARL,
        recipientId: CARL,
        body: needle,
        now: clock.now,
      });
      const sentTimestamp = clock.now + 20;
      store.messages.markOutboundSending('out-del-1', clock.now);
      store.messages.markOutboundSent('out-del-1', sentTimestamp, 'self-uuid', clock.now);

      store.db.checkpoint();
      assert.ok(fileContains(fixture.file, needle));

      store.messages.deleteForEveryone('self-uuid', sentTimestamp, clock.now + 30);

      assert.equal(store.messages.getOutbound('out-del-1')?.body, null);
      assert.ok(!fileContains(fixture.file, needle), 'queued copy of the deleted body survived');
    } finally {
      fixture.cleanup();
    }
  });
});
