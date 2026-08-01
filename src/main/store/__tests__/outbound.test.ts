/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * Durability of outbound sends, and the echo-protection ledger (SPEC.md §8 — "track sent
 * timestamps so the user's own outbound messages do not double-render when they return via
 * sync").
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore, makeTempDir } from './helpers.ts';
import { deriveMessageId } from '../messages.ts';
import * as fs from 'node:fs';

const SELF = 'ffffffff-0000-0000-0000-00000000000f';
const DAVE = 'dddddddd-0000-0000-0000-000000000004';

describe('outbound queue', () => {
  test('a message is durable before the send is attempted', () => {
    const dir = makeTempDir();
    try {
      const first = makeStore({ userDataDir: dir });
      first.store.messages.enqueueOutbound({
        id: 'out-1',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'typed but never sent',
        now: first.clock.now,
      });
      first.store.messages.markOutboundSending('out-1', first.clock.now);
      // Simulate a crash: close without ever reaching markOutboundSent.
      first.store.close();

      const second = makeStore({ userDataDir: dir });
      try {
        const row = second.store.messages.getOutbound('out-1');
        assert.ok(row, 'the queued message did not survive the crash');
        assert.equal(row.body, 'typed but never sent');
        // openStore() calls recoverInterruptedSends(), so it is surfaced rather than lost or
        // blindly retried.
        assert.equal(row.state, 'failed');
        assert.match(row.lastError ?? '', /interrupted/i);
        assert.equal(second.store.messages.listPendingOutbound().length, 1);
      } finally {
        second.store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marking sent writes the message row and empties the ledger body', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.enqueueOutbound({
        id: 'out-2',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'hello there',
        now: clock.now,
      });
      store.messages.markOutboundSending('out-2', clock.now);
      const stored = store.messages.markOutboundSent('out-2', clock.now + 7, SELF, clock.now);

      assert.equal(stored.body, 'hello there');
      assert.equal(stored.outgoing, true);
      assert.equal(stored.senderId, SELF);
      assert.equal(stored.receipt, 'sent');
      // The history row is keyed by the tuple the protocol uses, not by the queue handle:
      // that is what lets a receipt or a remote-delete for this message find it later.
      assert.equal(stored.id, deriveMessageId(SELF, clock.now + 7));
      assert.ok(store.messages.getMessageByNaturalKey(SELF, clock.now + 7));

      const ledger = store.messages.getOutbound('out-2')!;
      assert.equal(ledger.state, 'sent');
      assert.equal(ledger.sentTimestamp, clock.now + 7);
      // Only the timestamp is retained — no second copy of the body to chase on expiry.
      assert.equal(ledger.body, null);
    } finally {
      fixture.cleanup();
    }
  });

  test('echo protection recognises our own timestamps', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.enqueueOutbound({
        id: 'out-3',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'sent from desktop',
        now: clock.now,
      });
      store.messages.markOutboundSent('out-3', 1_700_000_012_345, SELF, clock.now);

      assert.equal(store.messages.wasSentByUs(1_700_000_012_345), true);
      assert.equal(store.messages.wasSentByUs(1_700_000_099_999), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('a sync echo of our own message does not create a second row', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const sentTimestamp = 1_700_000_022_222;
      store.messages.enqueueOutbound({
        id: 'out-4',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'echoed',
        now: clock.now,
      });
      store.messages.markOutboundSent('out-4', sentTimestamp, SELF, clock.now);

      // The same message coming back from the phone as a sync message.
      const echo = store.messages.persistInboundThenAck(
        {
          conversationId: DAVE,
          senderId: SELF,
          outgoing: true,
          body: 'echoed',
          sentAt: sentTimestamp,
          receivedAt: clock.now + 100,
          expiresAt: null,
          kind: 'text',
        },
        (m, inserted) => ({ m, inserted })
      );

      assert.equal(echo.inserted, false, 'the sync echo created a duplicate row');
      assert.equal(store.messages.countMessages(DAVE), 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('failures record an error and a retry count', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.enqueueOutbound({
        id: 'out-5',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'will fail',
        now: clock.now,
      });
      store.messages.markOutboundFailed('out-5', 'daemon-down', 30_000, clock.now);
      const row = store.messages.getOutbound('out-5')!;
      assert.equal(row.state, 'failed');
      assert.equal(row.retryCount, 1);
      assert.equal(row.lastError, 'daemon-down');
      assert.equal(row.nextAttemptAt, clock.now + 30_000);
      assert.equal(store.messages.listPendingOutbound(clock.now).length, 0);
      assert.equal(store.messages.listPendingOutbound(clock.now + 30_000).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('the echo ledger can be pruned without touching message history', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.messages.enqueueOutbound({
        id: 'out-6',
        conversationId: DAVE,
        recipientId: DAVE,
        body: 'old',
        now: clock.now,
      });
      store.messages.markOutboundSent('out-6', clock.now + 1, SELF, clock.now);

      assert.equal(store.messages.pruneEchoLedger(clock.now + 1_000), 1);
      assert.equal(store.messages.getOutbound('out-6'), null);
      assert.equal(store.messages.countMessages(DAVE), 1);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('inbound durability', () => {
  test('acknowledge runs only after the row is committed', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      let visibleDuringAck: number | null = null;
      store.messages.persistInboundThenAck(
        {
          conversationId: DAVE,
          senderId: DAVE,
          outgoing: false,
          body: 'durable',
          sentAt: clock.now,
          receivedAt: clock.now,
          expiresAt: null,
          kind: 'text',
        },
        () => {
          // A separate read must already see the committed row.
          visibleDuringAck = Number(
            store.db.raw.prepare('SELECT count(*) FROM messages').pluck().get()
          );
        }
      );
      assert.equal(visibleDuringAck, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test('redelivery is idempotent', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      const input = {
        conversationId: DAVE,
        senderId: DAVE,
        outgoing: false,
        body: 'delivered twice',
        sentAt: clock.now,
        receivedAt: clock.now,
        expiresAt: null,
        kind: 'text' as const,
      };
      const first = store.messages.persistInboundThenAck(input, (m, inserted) => inserted);
      const second = store.messages.persistInboundThenAck(input, (m, inserted) => inserted);
      assert.equal(first, true);
      assert.equal(second, false);
      assert.equal(store.messages.countMessages(DAVE), 1);
    } finally {
      fixture.cleanup();
    }
  });
});
