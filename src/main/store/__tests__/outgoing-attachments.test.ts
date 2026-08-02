/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * Files the *user* sends.
 *
 * Two properties matter here and neither is obvious from the inbound path, which is where all
 * the other attachment tests live:
 *
 *   1. **The user's own file is never destroyed.** Inbound ingestion shreds its source on
 *      purpose — that source is the daemon's scratch copy. The outgoing source is a document in
 *      the user's own folder, and shredding it would be catastrophic and unrecoverable.
 *   2. **A sent attachment is still subject to expiry.** Signal never syncs a message back to
 *      the device that sent it, so the cached copy taken here is the only one this app manages.
 *      If it escaped the sweep, a file sent into a disappearing-message conversation would
 *      outlive its timer on the sender's own disk.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { makeStore, makeTempDir } from './helpers.ts';
import { guessContentType } from '../attachments.ts';

const SELF = 'ffffffff-0000-0000-0000-00000000000f';
const DAVE = 'dddddddd-0000-0000-0000-000000000004';

/** A file standing in for something the user picked out of their own Documents folder. */
function makeUserFile(dir: string, name: string, contents = 'the user’s own document'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('outgoing attachments', () => {
  test('a sent file is recorded on the message and copied into the cache', () => {
    const sourceDir = makeTempDir('aimgnal-docs-');
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = makeUserFile(sourceDir, 'holiday.png');

      store.messages.enqueueOutbound({
        id: 'out-att-1',
        conversationId: DAVE,
        recipientId: DAVE,
        body: null,
        attachments: [source],
        now: clock.now,
      });
      store.messages.markOutboundSending('out-att-1', clock.now);
      const sent = store.messages.markOutboundSent('out-att-1', clock.now + 5, SELF, clock.now);

      assert.equal(sent.attachments.length, 1, 'the sent file left no record on the message');
      const [attachment] = sent.attachments;
      assert.equal(attachment.filename, 'holiday.png');
      assert.equal(attachment.contentType, 'image/png');
      assert.equal(attachment.viewOnce, false);
      assert.equal(attachment.isVoiceNote, false);

      // A file with no caption is an attachment, not an empty text message.
      assert.equal(sent.kind, 'attachment');
      assert.equal(sent.body, null);

      // The cached copy is ours, inside the cache root, and readable.
      assert.ok(attachment.path, 'no cached path was recorded');
      assert.ok(
        path.resolve(attachment.path).startsWith(path.resolve(store.attachments.dir) + path.sep),
        'the cached copy escaped the attachment cache'
      );
      assert.equal(fs.readFileSync(attachment.path, 'utf8'), 'the user’s own document');

      // THE POINT: the user's original is untouched.
      assert.equal(fs.existsSync(source), true, 'sending a file deleted the user’s own copy');
      assert.equal(fs.readFileSync(source, 'utf8'), 'the user’s own document');
    } finally {
      fixture.cleanup();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('a sent file in a disappearing conversation is shredded on the timer', () => {
    const sourceDir = makeTempDir('aimgnal-docs-');
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = makeUserFile(sourceDir, 'secret.pdf', 'contents that must not survive');

      store.messages.enqueueOutbound({
        id: 'out-att-2',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'look at this',
        attachments: [source],
        expiresAt: clock.now + 1_000,
        now: clock.now,
      });
      const sent = store.messages.markOutboundSent('out-att-2', clock.now + 5, SELF, clock.now);
      const cached = sent.attachments[0].path;
      assert.ok(cached);
      assert.equal(fs.existsSync(cached), true);

      const removed = store.messages.sweepExpired(clock.now + 2_000);

      assert.equal(removed.length, 1, 'the expiring message was not swept');
      assert.equal(store.messages.getMessage(sent.id), null);
      assert.equal(fs.existsSync(cached), false, 'the cached copy outlived its timer');
      // Still not the user's problem: their own file is theirs.
      assert.equal(fs.existsSync(source), true, 'expiry deleted the user’s own copy');
    } finally {
      fixture.cleanup();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('a file that vanished between the picker and the send does not lose the message', () => {
    const sourceDir = makeTempDir('aimgnal-docs-');
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = makeUserFile(sourceDir, 'moved.txt');
      store.messages.enqueueOutbound({
        id: 'out-att-3',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'here you go',
        attachments: [source],
        now: clock.now,
      });
      // The user moved it after picking it. signal-cli has already accepted the send by the
      // time we adopt, so the message must still be recorded — just without the file.
      fs.rmSync(source);

      const sent = store.messages.markOutboundSent('out-att-3', clock.now + 5, SELF, clock.now);

      assert.equal(sent.body, 'here you go');
      assert.equal(sent.attachments.length, 0);
      assert.equal(sent.kind, 'text');
    } finally {
      fixture.cleanup();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('adopting twice does not duplicate the attachment rows', () => {
    const sourceDir = makeTempDir('aimgnal-docs-');
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const source = makeUserFile(sourceDir, 'twice.txt');
      const sentAt = clock.now + 9;

      for (const id of ['out-att-4a', 'out-att-4b']) {
        store.messages.enqueueOutbound({
          id,
          conversationId: DAVE,
          recipientId: DAVE,
          body: 'retry',
          attachments: [source],
          now: clock.now,
        });
      }

      store.messages.markOutboundSent('out-att-4a', sentAt, SELF, clock.now);
      // The same (selfId, sentAt) — a retry that resolved to the same send timestamp. The
      // second call must not stack a second copy of the file onto the message.
      const second = store.messages.markOutboundSent('out-att-4b', sentAt, SELF, clock.now);

      assert.equal(second.attachments.length, 1);
      assert.equal(store.messages.countMessages(DAVE), 1);
    } finally {
      fixture.cleanup();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  test('adopt never shreds the source, even when the cache copy fails', () => {
    const sourceDir = makeTempDir('aimgnal-docs-');
    const fixture = makeStore();
    try {
      const source = makeUserFile(sourceDir, 'kept.txt');
      // A directory is not a file: adopt skips it rather than throwing or destroying anything.
      const notAFile = path.join(sourceDir, 'a-directory');
      fs.mkdirSync(notAFile);

      const adopted = fixture.store.attachments.adopt('msg-1', [
        { id: 'a0', path: source },
        { id: 'a1', path: notAFile },
        { id: 'a2', path: path.join(sourceDir, 'never-existed.txt') },
      ]);

      assert.equal(adopted.length, 1);
      assert.equal(adopted[0].id, 'a0');
      assert.equal(fs.existsSync(source), true);
      assert.equal(fs.existsSync(notAFile), true);
    } finally {
      fixture.cleanup();
      fs.rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});

describe('content type guessing', () => {
  test('covers what the log needs to decide on a thumbnail', () => {
    assert.equal(guessContentType('a.png'), 'image/png');
    assert.equal(guessContentType('a.JPG'), 'image/jpeg');
    assert.equal(guessContentType('holiday photo.heic'), 'image/heic');
    assert.equal(guessContentType('notes.pdf'), 'application/pdf');
    assert.equal(guessContentType('clip.mov'), 'video/quicktime');
  });

  test('an unknown or absent extension is octet-stream, never a guessed image', () => {
    // Guessing `image/*` here would make the log try to render arbitrary bytes as a thumbnail.
    assert.equal(guessContentType('Makefile'), 'application/octet-stream');
    assert.equal(guessContentType('archive.tar.zst'), 'application/octet-stream');
    assert.equal(guessContentType(''), 'application/octet-stream');
  });
});
