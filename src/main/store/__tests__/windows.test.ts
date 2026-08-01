/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §9 — window position and size persist per conversation and restore on reopen.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

import { makeStore, makeTempDir } from './helpers.ts';
import { BUDDY_LIST_WINDOW_KEY } from '../windows.ts';

describe('window geometry', () => {
  test('round-trips per conversation and survives a restart', () => {
    const dir = makeTempDir();
    try {
      const first = makeStore({ userDataDir: dir });
      first.store.windows.save('convo-a', { x: 100, y: 200, width: 400, height: 500 }, 1);
      first.store.windows.save('convo-b', { x: -50, y: 0, width: 300, height: 300 }, 2);
      first.store.windows.save(BUDDY_LIST_WINDOW_KEY, { x: 10, y: 10, width: 200, height: 700 }, 3);
      first.store.close();

      const second = makeStore({ userDataDir: dir });
      try {
        assert.deepEqual(second.store.windows.get('convo-a'), {
          conversationId: 'convo-a',
          x: 100,
          y: 200,
          w: 400,
          h: 500,
          updatedAt: 1,
        });
        // Each conversation is independent — one window's geometry never overwrites another's.
        assert.equal(second.store.windows.get('convo-b')?.w, 300);
        assert.equal(second.store.windows.get(BUDDY_LIST_WINDOW_KEY)?.h, 700);
        assert.equal(second.store.windows.all().length, 3);
      } finally {
        second.store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('saving again replaces rather than duplicating', () => {
    const fixture = makeStore();
    try {
      fixture.store.windows.save('c', { x: 1, y: 1, width: 10, height: 10 }, 1);
      fixture.store.windows.save('c', { x: 2, y: 2, width: 20, height: 20 }, 2);
      assert.equal(fixture.store.windows.all().length, 1);
      assert.equal(fixture.store.windows.get('c')?.w, 20);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects nonsense geometry instead of storing it', () => {
    const fixture = makeStore();
    try {
      fixture.store.windows.save('bad', { x: NaN, y: 0, width: 0, height: 400 });
      assert.equal(fixture.store.windows.get('bad'), null);

      fixture.store.windows.save('huge', { x: 0, y: 0, width: 1e9, height: 400 });
      assert.equal(fixture.store.windows.get('huge'), null);

      // A finite size with an unusable position is still worth keeping; the coordinate is
      // dropped and the window manager will centre it.
      fixture.store.windows.save('partial', { x: Infinity, y: 5, width: 300, height: 400 });
      const stored = fixture.store.windows.get('partial')!;
      assert.equal(stored.x, null);
      assert.equal(stored.y, 5);
      assert.equal(stored.w, 300);
    } finally {
      fixture.cleanup();
    }
  });

  test('forget removes only that conversation', () => {
    const fixture = makeStore();
    try {
      fixture.store.windows.save('a', { x: 0, y: 0, width: 10, height: 10 });
      fixture.store.windows.save('b', { x: 0, y: 0, width: 10, height: 10 });
      fixture.store.windows.forget('a');
      assert.equal(fixture.store.windows.get('a'), null);
      assert.ok(fixture.store.windows.get('b'));
    } finally {
      fixture.cleanup();
    }
  });
});
