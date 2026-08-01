/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `test` returns a promise the runner owns. */
/**
 * Envelope parsing regression tests.
 *
 * Every fixture below is modelled on **real captured traffic** from a live signal-cli 0.14.6
 * daemon (see docs/signal-cli-rpc.md), with identifiers and message bodies replaced. Two of
 * these cases are here because the real traffic caught bugs that source-reading alone did not:
 * a phone-side edit, and view-once media.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReceive } from '../events.ts';

const SELF = 'c5d8da39-0000-0000-0000-000000000001';
const PEER = 'aaaaaaaa-0000-0000-0000-00000000000b';
const GROUP = 'Zm9vYmFyZ3JvdXBpZA==';

function receive(envelope: Record<string, unknown>): unknown {
  return { envelope, account: '+15550000' };
}

function sync(sentMessage: Record<string, unknown>, timestamp = 1_785_000_000_000): unknown {
  return receive({
    source: '+15550000',
    sourceNumber: '+15550000',
    sourceUuid: SELF,
    sourceName: 'Me',
    sourceDevice: 1,
    timestamp,
    serverReceivedTimestamp: timestamp + 40,
    serverDeliveredTimestamp: timestamp + 50,
    syncMessage: { sentMessage },
  });
}

// ---------------------------------------------------------------------------
// The @JsonUnwrapped sync shape — SPEC.md §8's "easiest thing to get wrong"
// ---------------------------------------------------------------------------

test('sync sentMessage fields are flattened, not nested under dataMessage', () => {
  const events = parseReceive(
    sync({
      destination: '+15550001',
      destinationNumber: '+15550001',
      destinationUuid: PEER,
      timestamp: 1_785_000_000_000,
      message: 'sent from my phone',
      expiresInSeconds: 0,
      isExpirationUpdate: false,
      viewOnce: false,
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'message');
  assert.equal(event.body, 'sent from my phone');
  // The conversation is the destination, never the source — source is always us on a sync.
  assert.equal(event.conversationId, PEER);
  assert.equal(event.outgoing, true);
  assert.equal(event.senderId, SELF);
});

test('a sync group send routes to the group, not to a conversation with yourself', () => {
  // Captured shape: every destination* field is null and the conversation lives in groupInfo.
  const events = parseReceive(
    sync({
      destination: null,
      destinationNumber: null,
      destinationUuid: null,
      timestamp: 1_785_000_000_001,
      message: 'hello group',
      expiresInSeconds: 0,
      isExpirationUpdate: false,
      viewOnce: false,
      groupInfo: { groupId: GROUP, groupName: 'Friends', revision: 3, type: 'DELIVER' },
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'message');
  assert.equal((events[0] as { conversationId: string }).conversationId, GROUP);
});

// ---------------------------------------------------------------------------
// Regression: an edit made on the phone
// ---------------------------------------------------------------------------

test('an edit from another device nests inside sentMessage and is not dropped', () => {
  /*
   * Found by real traffic. A *received* edit arrives at `envelope.editMessage`, but an edit the
   * user makes on their own phone arrives at `syncMessage.sentMessage.editMessage`. Parsing
   * only the former left the pre-edit text on screen permanently, which SPEC.md §8 forbids:
   * "Never present stale text as current."
   *
   * Note the asymmetry — sentMessage is @JsonUnwrapped, but editMessage.dataMessage is
   * genuinely nested.
   */
  const events = parseReceive(
    sync({
      destination: '+15550000',
      destinationNumber: '+15550000',
      destinationUuid: SELF,
      timestamp: 1_785_000_000_002,
      editMessage: {
        targetSentTimestamp: 1_785_000_000_000,
        dataMessage: {
          timestamp: 1_785_000_000_002,
          message: 'corrected text',
          expiresInSeconds: 0,
          isExpirationUpdate: false,
          viewOnce: false,
        },
      },
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'edit');
  assert.equal(event.targetSentAt, 1_785_000_000_000);
  assert.equal(event.body, 'corrected text');
});

// ---------------------------------------------------------------------------
// Regression: view-once media
// ---------------------------------------------------------------------------

test('view-once media surfaces as a message even though no media is delivered', () => {
  /*
   * Found by real traffic. A view-once envelope carries NO `attachments` key and a null
   * `message` — signal-cli never hands over the media at all, which is what §8 wants for
   * "never persist". But it is otherwise indistinguishable from protocol plumbing, so the
   * message was being discarded entirely and the user would never know anything was sent.
   */
  const events = parseReceive(
    sync({
      destination: '+15550000',
      destinationNumber: '+15550000',
      destinationUuid: SELF,
      timestamp: 1_785_000_000_003,
      message: null,
      expiresInSeconds: 0,
      isExpirationUpdate: false,
      viewOnce: true,
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'message');
  assert.equal(event.viewOnce, true);
  // Nothing to persist, and nothing that could leak to disk.
  assert.equal(event.attachments.length, 0);
  assert.equal(event.body, null);
});

// ---------------------------------------------------------------------------
// Plumbing must stay silent
// ---------------------------------------------------------------------------

test('an envelope with no payload at all yields nothing', () => {
  // Sender-key distribution, profile-key updates and null messages all look like this.
  const events = parseReceive(
    receive({
      source: '+15550001',
      sourceNumber: '+15550001',
      sourceUuid: PEER,
      sourceName: 'Alice',
      sourceDevice: 1,
      timestamp: 1_785_000_000_004,
      serverReceivedTimestamp: 1_785_000_000_044,
      serverDeliveredTimestamp: 1_785_000_000_054,
    }),
    { selfId: SELF }
  );
  assert.deepEqual(events, []);
});

test('an empty syncMessage does not crash and yields nothing', () => {
  const events = parseReceive(
    receive({
      source: '+15550000',
      sourceUuid: SELF,
      sourceDevice: 1,
      timestamp: 1_785_000_000_005,
      syncMessage: {},
    }),
    { selfId: SELF }
  );
  assert.deepEqual(events, []);
});

test('a plain data message with no content is treated as plumbing', () => {
  const events = parseReceive(
    receive({
      source: '+15550001',
      sourceUuid: PEER,
      sourceDevice: 1,
      timestamp: 1_785_000_000_006,
      dataMessage: {
        timestamp: 1_785_000_000_006,
        message: null,
        expiresInSeconds: 0,
        viewOnce: false,
      },
    }),
    { selfId: SELF }
  );
  assert.deepEqual(events, []);
});

// ---------------------------------------------------------------------------
// Disappearing messages and timer changes
// ---------------------------------------------------------------------------

test('a timer change is an expiration-update, not a blank message row', () => {
  const events = parseReceive(
    sync({
      destinationUuid: SELF,
      timestamp: 1_785_000_000_007,
      message: null,
      expiresInSeconds: 300,
      isExpirationUpdate: true,
      viewOnce: false,
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'expiration-update');
  assert.equal((events[0] as { expiresInSeconds: number }).expiresInSeconds, 300);
});

test('a disappearing message carries its timer through for local expiry computation', () => {
  // There is no expirationStartTimestamp in any envelope, so the app owns the clock entirely.
  const events = parseReceive(
    sync({
      destinationUuid: SELF,
      timestamp: 1_785_000_000_008,
      message: 'this disappears',
      expiresInSeconds: 300,
      isExpirationUpdate: false,
      viewOnce: false,
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'message');
  assert.equal(event.expiresInSeconds, 300);
});

// ---------------------------------------------------------------------------
// Reactions, receipts, identity
// ---------------------------------------------------------------------------

test('a reaction and its removal both parse, keyed by the target tuple', () => {
  const base = {
    destinationUuid: SELF,
    timestamp: 1_785_000_000_009,
    expiresInSeconds: 0,
    isExpirationUpdate: false,
    viewOnce: false,
  };

  const added = parseReceive(
    sync({
      ...base,
      reaction: { emoji: '❤️', targetAuthorUuid: PEER, targetSentTimestamp: 111, isRemove: false },
    }),
    { selfId: SELF }
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].type, 'reaction');
  assert.equal((added[0] as { isRemove: boolean }).isRemove, false);
  assert.equal((added[0] as { targetSentAt: number }).targetSentAt, 111);

  const removed = parseReceive(
    sync({
      ...base,
      reaction: { emoji: '❤️', targetAuthorUuid: PEER, targetSentTimestamp: 111, isRemove: true },
    }),
    { selfId: SELF }
  );
  assert.equal((removed[0] as { isRemove: boolean }).isRemove, true);
});

test('an identity change arrives as an exception sibling of envelope, not a message type', () => {
  // Parsing only `envelope` would drop a security signal on the floor (SPEC.md §8).
  const events = parseReceive(
    {
      envelope: { sourceUuid: PEER, sourceDevice: 1, timestamp: 1_785_000_000_010 },
      exception: { type: 'UntrustedIdentityException', sender: PEER, senderName: 'Alice' },
      account: '+15550000',
    },
    { selfId: SELF }
  );

  assert.equal(
    events.some((event) => event.type === 'identity-change'),
    true
  );
});

test('receipts carry every timestamp in the batch', () => {
  const events = parseReceive(
    receive({
      sourceUuid: PEER,
      sourceDevice: 1,
      timestamp: 1_785_000_000_011,
      receiptMessage: {
        when: 1_785_000_000_011,
        isDelivery: false,
        isRead: true,
        timestamps: [111, 222, 333],
      },
    }),
    { selfId: SELF }
  );

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.type, 'receipt');
  assert.equal(event.state, 'read');
  assert.deepEqual(event.targetSentAts, [111, 222, 333]);
});

// ---------------------------------------------------------------------------
// Robustness — a malformed payload must never stop message delivery
// ---------------------------------------------------------------------------

test('garbage input yields no events instead of throwing', () => {
  for (const input of [
    null,
    undefined,
    42,
    'string',
    [],
    {},
    { envelope: null },
    { envelope: 7 },
  ]) {
    assert.doesNotThrow(() => parseReceive(input, { selfId: SELF }));
    assert.deepEqual(parseReceive(input, { selfId: SELF }), []);
  }
});
