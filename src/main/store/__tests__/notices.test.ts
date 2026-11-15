/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * App-generated notices ("Not delivered to …") written into a conversation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';
import { SYSTEM_SENDER_ID } from '../messages.ts';

const GROUP = 'Z3JvdXAtaWQtYmFzZTY0';

describe('notices', () => {
  test('a notice is a system row that never expires and shows in the conversation', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const notice = store.messages.postNotice(GROUP, 'Not delivered to Dave.', clock.now);
      assert.equal(notice.kind, 'system');
      assert.equal(notice.senderId, SYSTEM_SENDER_ID);
      assert.equal(notice.expiresAt, null);
      assert.deepEqual(
        store.messages.getMessages(GROUP).map((m) => m.body),
        ['Not delivered to Dave.']
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('two notices in the same millisecond both survive', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const a = store.messages.postNotice(GROUP, 'first', clock.now);
      const b = store.messages.postNotice(GROUP, 'second', clock.now);
      assert.notEqual(a.id, b.id);
      assert.equal(store.messages.countMessages(GROUP), 2);
    } finally {
      fixture.cleanup();
    }
  });
});
