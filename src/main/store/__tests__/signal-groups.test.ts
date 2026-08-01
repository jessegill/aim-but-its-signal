/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 — "Group messages: open in an AIM chat-room-styled window; sender attribution
 * required."
 *
 * Attribution is the property under test throughout. A group conversation with no per-sender
 * name is not a degraded group chat, it is an unreadable one: every line looks like it came
 * from the same person.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from './helpers.ts';

const ADA = 'aaaaaaaa-1111-1111-1111-111111111111';
const GRACE = 'bbbbbbbb-2222-2222-2222-222222222222';
const KATHERINE = 'cccccccc-3333-3333-3333-333333333333';
const STRANGER = 'dddddddd-4444-4444-4444-444444444444';
const GROUP = 'Z3JvdXAtaWQtYmFzZTY0';

describe('signal groups', () => {
  test('members are named from the roster, and strangers still get a name', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([
        { uuid: ADA, name: 'Ada Lovelace' },
        { uuid: GRACE, profileName: 'Grace Hopper' },
      ]);
      store.signalGroups.upsertGroups([
        {
          id: GROUP,
          name: 'Analytical Engine',
          members: [{ uuid: ADA }, { uuid: GRACE }, { uuid: STRANGER }],
          admins: [{ uuid: GRACE }],
        },
      ]);

      const group = store.signalGroups.getGroup(GROUP, ADA);
      assert.ok(group);
      assert.equal(group.name, 'Analytical Engine');
      assert.equal(group.members.length, 3);

      // Admins first, then alphabetical.
      assert.deepEqual(
        group.members.map((m) => m.name),
        ['Grace Hopper', 'Ada Lovelace', STRANGER.slice(0, 8)]
      );
      assert.equal(group.members[0].isAdmin, true);
      // Someone with no contact record is a member like any other — never dropped, because a
      // missing member is exactly the one whose messages would be unattributable.
      assert.equal(group.members[2].id, STRANGER);
      assert.equal(
        group.members.find((m) => m.id === ADA)?.isSelf,
        true,
        'the local account is marked as itself'
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('a member who leaves disappears from the list', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.signalGroups.upsertGroups([
        { id: GROUP, name: 'Team', members: [{ uuid: ADA }, { uuid: GRACE }] },
      ]);
      // The daemon is the authority on membership; a second sync replaces rather than merges.
      store.signalGroups.upsertGroups([{ id: GROUP, name: 'Team', members: [{ uuid: ADA }] }]);

      assert.deepEqual(store.signalGroups.memberIds(GROUP), [ADA]);
    } finally {
      fixture.cleanup();
    }
  });

  test('every message carries its own sender name', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.roster.upsertContacts([
        { uuid: ADA, name: 'Ada' },
        { uuid: GRACE, name: 'Grace' },
      ]);

      for (const [i, sender] of [ADA, GRACE, STRANGER].entries()) {
        store.messages.persistInboundThenAck(
          {
            conversationId: GROUP,
            senderId: sender,
            outgoing: false,
            body: `line ${String(i)}`,
            sentAt: clock.now + i,
            receivedAt: clock.now + i,
            kind: 'text',
          },
          (m) => m
        );
      }

      const messages = store.messages.getMessages(GROUP);
      assert.deepEqual(
        messages.map((m) => m.senderName),
        ['Ada', 'Grace', STRANGER.slice(0, 8)]
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('renaming a contact renames their whole history', () => {
    const fixture = makeStore();
    const { store, clock } = fixture;
    try {
      store.roster.upsertContacts([{ uuid: KATHERINE, profileName: 'K. Johnson' }]);
      store.messages.persistInboundThenAck(
        {
          conversationId: GROUP,
          senderId: KATHERINE,
          outgoing: false,
          body: 'checked the numbers',
          sentAt: clock.now,
          receivedAt: clock.now,
          kind: 'text',
        },
        (m) => m
      );
      assert.equal(store.messages.getMessages(GROUP)[0].senderName, 'K. Johnson');

      // Names are resolved on read, not stored on the row, so an old name cannot survive
      // anywhere — including on messages received before the change.
      store.roster.upsertContacts([{ uuid: KATHERINE, name: 'Katherine Johnson' }]);
      assert.equal(store.messages.getMessages(GROUP)[0].senderName, 'Katherine Johnson');

      // A local nickname is an override, and overrides everywhere (SPEC.md §2).
      store.roster.setNickname(KATHERINE, 'Kat');
      assert.equal(store.messages.getMessages(GROUP)[0].senderName, 'Kat');
      assert.equal(store.roster.displayNameFor(KATHERINE), 'Kat');
    } finally {
      fixture.cleanup();
    }
  });

  test('a group with no name of its own still has a title', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.signalGroups.upsertGroups([{ id: GROUP, members: [{ uuid: ADA }] }]);
      const group = store.signalGroups.getGroup(GROUP);
      assert.equal(group?.name, 'Unnamed group');
      // Absent isMember means present — defaulting the other way silently disables sending.
      assert.equal(group?.isMember, true);
    } finally {
      fixture.cleanup();
    }
  });

  test('a member known only by phone number is not mistaken for a sender', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      // Message senders are always ACIs. A number-only member cannot be matched to one, so
      // listing them would claim an attribution the log can never actually make.
      store.signalGroups.upsertGroups([
        { id: GROUP, name: 'Team', members: [{ uuid: ADA }, { number: '+15550001' }] },
      ]);
      assert.deepEqual(store.signalGroups.memberIds(GROUP), [ADA]);
    } finally {
      fixture.cleanup();
    }
  });

  test('group state survives a reopen and is not confused with buddy groups', () => {
    const dir = makeStore().dir;
    const first = makeStore({ userDataDir: dir });
    try {
      first.store.signalGroups.upsertGroups([
        { id: GROUP, name: 'Persisted', messageExpirationTime: 3600, members: [{ uuid: ADA }] },
      ]);
      // Same word, different universe: a local buddy-list folder named the same thing must not
      // collide with, or be found by, the Signal group of that name.
      first.store.roster.createGroup('Persisted');
    } finally {
      first.store.close();
    }

    const second = makeStore({ userDataDir: dir });
    try {
      const group = second.store.signalGroups.getGroup(GROUP);
      assert.equal(group?.name, 'Persisted');
      assert.equal(group?.messageExpirationTime, 3600);
      assert.equal(second.store.signalGroups.isKnownGroup(GROUP), true);
      assert.equal(second.store.signalGroups.isKnownGroup('no-such-group'), false);

      assert.equal(
        second.store.roster.getRoster().groups.filter((g) => g.name === 'Persisted').length,
        1
      );
      assert.equal(second.store.signalGroups.listGroups().length, 1);
    } finally {
      second.cleanup();
    }
  });
});
