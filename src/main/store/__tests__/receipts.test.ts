/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * Delivery receipts.
 *
 * A receipt acknowledges a message *we* sent. Its target is therefore keyed by the local
 * account and the send timestamp — never by the ACI of whoever is acknowledging it. Getting
 * that wrong matched no row at all, and every outgoing message stayed on "sending…" forever.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';
import { deriveMessageId } from '../messages.ts';

const SELF = 'ffffffff-0000-0000-0000-00000000000f';
const DAVE = 'dddddddd-0000-0000-0000-000000000004';
const ERIN = 'eeeeeeee-0000-0000-0000-000000000005';
const GROUP = 'Z3JvdXAtaWQtYmFzZTY0';

/** Sends a message into `conversationId` and returns its send timestamp. */
function send(store: ReturnType<typeof makeStore>['store'], conversationId: string, at: number) {
  store.messages.enqueueOutbound({
    id: `out-${String(at)}`,
    conversationId,
    recipientId: conversationId,
    body: 'anyone there',
    now: at,
  });
  store.messages.markOutboundSending(`out-${String(at)}`, at);
  store.messages.markOutboundSent(`out-${String(at)}`, at, SELF, at);
  return at;
}

describe('delivery receipts', () => {
  test('a receipt advances the message we sent, and reports where it lives', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentAt = send(store, DAVE, clock.now);
      assert.equal(store.messages.getMessageByNaturalKey(SELF, sentAt)?.receipt, 'sent');

      const ref = store.messages.setReceiptByTimestamp(SELF, sentAt, 'delivered');
      assert.deepEqual(ref, { id: deriveMessageId(SELF, sentAt), conversationId: DAVE });
      assert.equal(store.messages.getMessageByNaturalKey(SELF, sentAt)?.receipt, 'delivered');
    } finally {
      fixture.cleanup();
    }
  });

  test('the acknowledging party is not the key — that combination matches nothing', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentAt = send(store, DAVE, clock.now);

      // The old bug in one line: Dave sends the receipt, so resolving by *Dave* looks for a
      // message Dave authored at our send timestamp. No such message exists.
      assert.equal(store.messages.setReceiptByTimestamp(DAVE, sentAt, 'delivered'), null);
      assert.equal(
        store.messages.getMessageByNaturalKey(SELF, sentAt)?.receipt,
        'sent',
        'the message must be untouched, not silently altered'
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('receipts only move forward, so a group cannot make the state flap', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentAt = send(store, GROUP, clock.now);

      // Every member acknowledges separately and in no particular order.
      assert.ok(store.messages.setReceiptByTimestamp(SELF, sentAt, 'delivered'));
      assert.ok(store.messages.setReceiptByTimestamp(SELF, sentAt, 'read'));

      // A slower member's delivery receipt arrives after someone else has already read it.
      assert.equal(store.messages.setReceiptByTimestamp(SELF, sentAt, 'read'), null);
      assert.equal(store.messages.setReceiptByTimestamp(SELF, sentAt, 'delivered'), null);
      assert.equal(store.messages.getMessageByNaturalKey(SELF, sentAt)?.receipt, 'read');
    } finally {
      fixture.cleanup();
    }
  });

  test('a receipt can rescue a send we had written off as failed', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentAt = send(store, DAVE, clock.now);
      store.db.raw
        .prepare(`UPDATE messages SET receipt = 'failed' WHERE id = ?`)
        .run(deriveMessageId(SELF, sentAt));

      // The message evidently did arrive, whatever we concluded locally.
      assert.ok(store.messages.setReceiptByTimestamp(SELF, sentAt, 'delivered'));
      assert.equal(store.messages.getMessageByNaturalKey(SELF, sentAt)?.receipt, 'delivered');
    } finally {
      fixture.cleanup();
    }
  });

  test('a read receipt synced from another device targets the original author', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      // Reading someone else's message on the phone is the mirror case: there the natural key
      // really is the other party's, because they authored the message being read.
      store.messages.persistInboundThenAck(
        {
          conversationId: ERIN,
          senderId: ERIN,
          outgoing: false,
          body: 'read this on my phone',
          sentAt: clock.now,
          receivedAt: clock.now,
          kind: 'text',
        },
        (m) => m
      );

      const ref = store.messages.setReceiptByTimestamp(ERIN, clock.now, 'read');
      assert.deepEqual(ref, { id: deriveMessageId(ERIN, clock.now), conversationId: ERIN });
    } finally {
      fixture.cleanup();
    }
  });
});
