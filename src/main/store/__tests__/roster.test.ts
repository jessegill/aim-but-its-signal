/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_GROUP_NAME } from '../../../shared/types.ts';
import { makeStore } from './helpers.ts';
import { resolveDisplayName } from '../roster.ts';

const ADA = 'aaaaaaaa-1111-1111-1111-111111111111';
const GRACE = 'bbbbbbbb-2222-2222-2222-222222222222';

describe('roster', () => {
  test('exclusive group membership cannot be violated', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([{ uuid: ADA, name: 'Ada' }]);
      const work = store.roster.createGroup('Work');
      const family = store.roster.createGroup('Family');

      store.roster.moveBuddy(ADA, work);
      assert.equal(
        Number(
          store.db.raw
            .prepare('SELECT count(*) FROM buddy_group_members WHERE buddy_id = ?')
            .pluck()
            .get(ADA)
        ),
        1
      );

      // A raw second INSERT must fail: the invariant lives in the schema, not in app code.
      assert.throws(
        () =>
          store.db.raw
            .prepare(
              'INSERT INTO buddy_group_members (buddy_id, group_id, sort_order) VALUES (?, ?, 0)'
            )
            .run(ADA, family),
        /UNIQUE constraint failed: buddy_group_members\.buddy_id/i
      );

      // And the supported path replaces rather than duplicating.
      store.roster.moveBuddy(ADA, family);
      const rows = store.db.raw
        .prepare('SELECT group_id FROM buddy_group_members WHERE buddy_id = ?')
        .pluck()
        .all(ADA) as number[];
      assert.deepEqual(rows, [family]);

      const roster = store.roster.getRoster();
      assert.equal(roster.buddies.filter((b) => b.id === ADA).length, 1);
      assert.equal(roster.buddies.find((b) => b.id === ADA)?.groupId, family);
    } finally {
      fixture.cleanup();
    }
  });

  test('unassigned buddies land in the default group', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([
        { uuid: ADA, name: 'Ada' },
        { uuid: GRACE, number: '+15550111' },
      ]);
      const roster = store.roster.getRoster();
      const fallback = roster.groups.find((g) => g.name === DEFAULT_GROUP_NAME);
      assert.ok(fallback, 'default group missing');
      assert.equal(roster.buddies.length, 2);
      for (const buddy of roster.buddies) assert.equal(buddy.groupId, fallback.id);
      // A roster entry with zero messages is valid and must render (SPEC.md §6).
      assert.equal(store.messages.countMessages(ADA), 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('a local nickname survives a refresh from the daemon', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([{ uuid: ADA, name: 'Ada Lovelace' }]);
      store.roster.setNickname(ADA, 'countess');

      store.roster.upsertContacts([{ uuid: ADA, name: 'Ada L.', messageExpirationTime: 3600 }]);

      const buddy = store.roster.getBuddy(ADA)!;
      assert.equal(buddy.nickname, 'countess');
      assert.equal(buddy.displayName, 'Ada L.');
      assert.equal(buddy.messageExpirationTime, 3600);
    } finally {
      fixture.cleanup();
    }
  });

  test('deleting a group re-homes its members instead of orphaning them', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([{ uuid: ADA, name: 'Ada' }]);
      const work = store.roster.createGroup('Work');
      store.roster.moveBuddy(ADA, work);
      store.roster.deleteGroup(work);

      const roster = store.roster.getRoster();
      const fallback = roster.groups.find((g) => g.name === DEFAULT_GROUP_NAME)!;
      assert.equal(roster.buddies.find((b) => b.id === ADA)?.groupId, fallback.id);
      assert.ok(!roster.groups.some((g) => g.id === work));
    } finally {
      fixture.cleanup();
    }
  });

  test('the default group cannot be deleted', () => {
    const fixture = makeStore();
    try {
      const id = fixture.store.roster.ensureDefaultGroup();
      assert.throws(() => fixture.store.roster.deleteGroup(id), /cannot be deleted/i);
    } finally {
      fixture.cleanup();
    }
  });

  test('group collapse and ordering round-trip', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      const a = store.roster.createGroup('Alpha');
      const b = store.roster.createGroup('Beta');
      store.roster.reorderGroup(a, 10);
      store.roster.reorderGroup(b, 5);
      store.roster.setGroupCollapsed(a, true);

      const groups = store.roster.listGroups();
      const ordered = groups.map((g) => g.name);
      assert.ok(ordered.indexOf('Beta') < ordered.indexOf('Alpha'));
      assert.equal(groups.find((g) => g.id === a)?.collapsed, true);
      assert.equal(groups.find((g) => g.id === b)?.collapsed, false);
    } finally {
      fixture.cleanup();
    }
  });

  test('display name resolution is deterministic and always yields something', () => {
    assert.equal(
      resolveDisplayName({ uuid: 'x', name: 'Contact', profileName: 'Profile' }),
      'Contact'
    );
    assert.equal(resolveDisplayName({ uuid: 'x', profileName: 'Profile' }), 'Profile');
    assert.equal(
      resolveDisplayName({ uuid: 'x', givenName: 'Grace', familyName: 'Hopper' }),
      'Grace Hopper'
    );
    assert.equal(resolveDisplayName({ uuid: 'x', number: '+15550100' }), '+15550100');
    assert.equal(resolveDisplayName({ uuid: 'abcdefghij' }), 'abcdefgh');
  });

  test('unregistered contacts are stored, not dropped', () => {
    const fixture = makeStore();
    const { store } = fixture;
    try {
      store.roster.upsertContacts([{ uuid: GRACE, name: 'Grace', isRegistered: false }]);
      const buddy = store.roster.getBuddy(GRACE)!;
      assert.equal(buddy.unregistered, true);
      assert.equal(store.roster.getRoster().buddies.length, 1);
    } finally {
      fixture.cleanup();
    }
  });
});
