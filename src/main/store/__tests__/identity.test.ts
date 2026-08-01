/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 — safety number / identity changes must be surfaced, never silently swallowed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';

const EVE = 'eeeeeeee-0000-0000-0000-000000000005';

describe('identity changes', () => {
  test('a first sighting is recorded without alarming the user', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const result = store.identity.record({
        buddyId: EVE,
        safetyNumber: '11111 22222 33333',
        at: clock.now,
      });
      assert.equal(result.changed, false);
      assert.equal(result.record.safetyNumber, '11111 22222 33333');
      assert.equal(store.identity.listUnacknowledged().length, 0);
      assert.equal(store.messages.countMessages(EVE), 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('a change is persisted and rendered into the conversation', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.identity.record({ buddyId: EVE, safetyNumber: 'AAAAA', at: clock.now });
      const result = store.identity.record({
        buddyId: EVE,
        safetyNumber: 'BBBBB',
        at: clock.now + 1_000,
      });

      assert.equal(result.changed, true);
      assert.equal(result.record.changedAt, clock.now + 1_000);
      assert.equal(result.record.acknowledgedAt, null);
      // A previously verified contact must not stay "verified" through a key change.
      assert.equal(result.record.trustLevel, 'UNTRUSTED');
      assert.equal(store.identity.listUnacknowledged().length, 1);

      const messages = store.messages.getMessages(EVE);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'identity-change');
      assert.match(messages[0].body ?? '', /safety number changed/i);
      // A security notice must never be given a disappearing timer.
      assert.equal(messages[0].expiresAt, null);
    } finally {
      fixture.cleanup();
    }
  });

  test('the notice survives a restart until acknowledged', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.identity.record({ buddyId: EVE, safetyNumber: 'AAAAA', at: clock.now });
      store.identity.record({ buddyId: EVE, safetyNumber: 'BBBBB', at: clock.now + 1 });
      assert.equal(store.identity.listUnacknowledged().length, 1);

      store.identity.acknowledge(EVE, clock.now + 2);
      assert.equal(store.identity.listUnacknowledged().length, 0);
      // Acknowledging dismisses the banner; it does not erase the record from history.
      assert.equal(store.messages.getMessages(EVE).length, 1);
      assert.equal(store.identity.get(EVE)?.safetyNumber, 'BBBBB');
    } finally {
      fixture.cleanup();
    }
  });

  test('an identity notice does not collide with a real message at the same instant', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.persistInboundThenAck(
        {
          conversationId: EVE,
          senderId: EVE,
          outgoing: false,
          body: 'hi',
          sentAt: clock.now + 5,
          receivedAt: clock.now + 5,
          expiresAt: null,
          kind: 'text',
        },
        (m) => m
      );
      store.identity.record({ buddyId: EVE, safetyNumber: 'AAAAA', at: clock.now });
      store.identity.record({ buddyId: EVE, safetyNumber: 'BBBBB', at: clock.now + 5 });

      const kinds = store.messages.getMessages(EVE).map((m) => m.kind);
      assert.equal(kinds.length, 2);
      assert.ok(kinds.includes('identity-change'));
      assert.ok(kinds.includes('text'));
    } finally {
      fixture.cleanup();
    }
  });
});
