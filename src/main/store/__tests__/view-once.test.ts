/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 — view-once media is never persisted. Not to the database, not to the
 * attachment cache on disk.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeStore, fileContains, walkFiles } from './helpers.ts';

const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';

function writeIncoming(dir: string, name: string, contents: string): string {
  const daemonDir = path.join(dir, 'daemon-attachments');
  fs.mkdirSync(daemonDir, { recursive: true });
  const file = path.join(daemonDir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('view-once media', () => {
  test('never reaches the attachment cache or the database', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const needle = 'VIEW-ONCE-NEEDLE-secret-photo-bytes';
      const source = writeIncoming(fixture.dir, 'viewonce.jpg', needle);

      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: BOB,
          senderId: BOB,
          outgoing: false,
          body: null,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'attachment',
          attachments: [
            {
              id: 'vo-1',
              contentType: 'image/jpeg',
              filename: 'viewonce.jpg',
              size: needle.length,
              path: source,
              viewOnce: true,
              isVoiceNote: false,
            },
          ],
        },
        (m) => m
      );

      // Nothing in the database.
      assert.equal(
        Number(store.db.raw.prepare('SELECT count(*) FROM attachments').pluck().get()),
        0
      );
      assert.deepEqual(stored.attachments, []);

      // Nothing in the cache directory.
      assert.deepEqual(walkFiles(store.attachments.dir), []);

      // The daemon's downloaded copy is destroyed, not left lying around.
      assert.ok(!fs.existsSync(source), 'the downloaded view-once file was left on disk');

      // And the bytes are nowhere in the database file either.
      store.db.checkpoint();
      assert.ok(!fileContains(fixture.file, needle));

      // The conversation is not silently lossy: the message row survives and is flagged, so
      // the UI can say "view-once media — open on your phone".
      const row = store.db.raw
        .prepare('SELECT had_view_once, kind FROM messages WHERE id = ?')
        .get(stored.id) as { had_view_once: number; kind: string };
      assert.equal(row.had_view_once, 1);
      assert.equal(row.kind, 'attachment');
    } finally {
      fixture.cleanup();
    }
  });

  test('a redelivered view-once message still destroys the new download', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const first = writeIncoming(fixture.dir, 'vo-a.jpg', 'first-copy');
      const input = {
        conversationId: BOB,
        senderId: BOB,
        outgoing: false,
        body: null,
        sentAt: clock.now,
        receivedAt: clock.now,
        expiresAt: null,
        kind: 'attachment' as const,
        attachments: [
          {
            id: 'vo-2',
            contentType: 'image/jpeg',
            filename: 'vo-a.jpg',
            size: 10,
            path: first,
            viewOnce: true,
            isVoiceNote: false,
          },
        ],
      };
      store.messages.persistInboundThenAck(input, (m) => m);

      const second = writeIncoming(fixture.dir, 'vo-b.jpg', 'second-copy');
      const result = store.messages.persistInboundThenAck(
        { ...input, attachments: [{ ...input.attachments[0], path: second }] },
        (m, inserted) => ({ m, inserted })
      );

      assert.equal(result.inserted, false, 'redelivery must not create a second row');
      assert.ok(!fs.existsSync(second), 'redelivered view-once download was left on disk');
      assert.deepEqual(walkFiles(store.attachments.dir), []);
    } finally {
      fixture.cleanup();
    }
  });

  test('the schema itself refuses a view-once attachment row', () => {
    // Belt and braces: even a future caller that bypasses the cache cannot store one, because
    // `attachments.view_once` carries CHECK (view_once = 0).
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: BOB,
          senderId: BOB,
          outgoing: false,
          body: 'hi',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );

      assert.throws(
        () =>
          store.db.raw
            .prepare(
              `INSERT INTO attachments (id, message_id, content_type, view_once)
               VALUES ('sneaky', ?, 'image/jpeg', 1)`
            )
            .run(stored.id),
        /CHECK constraint failed/i
      );
    } finally {
      fixture.cleanup();
    }
  });

  test("the daemon's own copy is shredded for ordinary attachments too", () => {
    // signal-cli writes to $XDG_DATA_HOME/signal-cli/attachments/ before we see the envelope.
    // If that copy survived, a disappearing-message attachment would outlive its timer in a
    // directory our expiry sweep cannot reach.
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = writeIncoming(fixture.dir, 'ordinary.jpg', 'ORDINARY-NEEDLE-bytes');
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: BOB,
          senderId: BOB,
          outgoing: false,
          body: null,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'attachment',
          attachments: [
            {
              id: 'src-1',
              contentType: 'image/jpeg',
              filename: 'ordinary.jpg',
              size: 21,
              path: source,
              viewOnce: false,
              isVoiceNote: false,
            },
          ],
        },
        (m) => m
      );

      assert.ok(!fs.existsSync(source), "the daemon's copy was left behind");
      // Exactly one managed copy remains, inside our cache.
      const cached = stored.attachments[0].path!;
      assert.ok(cached.startsWith(store.attachments.dir));
      assert.ok(fs.existsSync(cached));
      assert.equal(walkFiles(store.attachments.dir).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('shredding works on a file this process did not create', () => {
    const fixture = makeStore();
    try {
      const foreign = writeIncoming(fixture.dir, 'foreign.bin', 'NOT-OURS-payload');
      assert.ok(fs.existsSync(foreign));
      fixture.store.attachments.shred(foreign);
      assert.ok(!fs.existsSync(foreign));
      // Idempotent: shredding a path that is already gone must not throw.
      assert.doesNotThrow(() => fixture.store.attachments.shred(foreign));
    } finally {
      fixture.cleanup();
    }
  });

  test('a normal attachment is cached and recorded', () => {
    // Control case — the view-once rule must not be implemented by dropping all attachments.
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = writeIncoming(fixture.dir, 'photo.jpg', 'ordinary-bytes');
      const stored = store.messages.persistInboundThenAck(
        {
          conversationId: BOB,
          senderId: BOB,
          outgoing: false,
          body: null,
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'attachment',
          attachments: [
            {
              id: 'ok-1',
              contentType: 'image/jpeg',
              filename: 'photo.jpg',
              size: 14,
              path: source,
              viewOnce: false,
              isVoiceNote: false,
            },
          ],
        },
        (m) => m
      );

      assert.equal(stored.attachments.length, 1);
      assert.equal(stored.attachments[0].viewOnce, false);
      assert.ok(stored.attachments[0].path?.startsWith(store.attachments.dir));
      assert.ok(fs.existsSync(stored.attachments[0].path!));
    } finally {
      fixture.cleanup();
    }
  });
});
