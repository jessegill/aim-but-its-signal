/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { openDatabase, migrate } from '../db.ts';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../migrations.ts';
import { makeStore, makeTempDir } from './helpers.ts';

describe('migrations', () => {
  test('run cleanly on a fresh database', () => {
    const fixture = makeStore();
    try {
      assert.equal(fixture.store.db.schemaVersion, LATEST_SCHEMA_VERSION);

      const tables = fixture.store.db.raw
        .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
        .pluck()
        .all() as string[];

      for (const expected of [
        'attachments',
        'buddies',
        'buddy_group_members',
        'buddy_groups',
        'identity_records',
        'messages',
        'outbound_queue',
        'reactions',
        'schema_migrations',
        'window_geometry',
      ]) {
        assert.ok(tables.includes(expected), `missing table ${expected}`);
      }

      const applied = fixture.store.db.raw
        .prepare(`SELECT version FROM schema_migrations ORDER BY version`)
        .pluck()
        .all() as number[];
      assert.deepEqual(
        applied,
        MIGRATIONS.map((m) => m.version)
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('are idempotent: re-running applies nothing', () => {
    const fixture = makeStore();
    try {
      const before = fixture.store.db.raw
        .prepare(`SELECT sql FROM sqlite_schema ORDER BY name`)
        .pluck()
        .all() as string[];

      // Running the migrator again on an already-migrated database must be a no-op.
      const version = migrate(fixture.store.db.raw);
      assert.equal(version, LATEST_SCHEMA_VERSION);
      assert.equal(migrate(fixture.store.db.raw), LATEST_SCHEMA_VERSION);

      const after = fixture.store.db.raw
        .prepare(`SELECT sql FROM sqlite_schema ORDER BY name`)
        .pluck()
        .all() as string[];
      assert.deepEqual(after, before);

      const applied = fixture.store.db.raw
        .prepare(`SELECT count(*) FROM schema_migrations`)
        .pluck()
        .get();
      assert.equal(Number(applied), MIGRATIONS.length);
    } finally {
      fixture.cleanup();
    }
  });

  test('are idempotent across reopen, and data survives', () => {
    const dir = makeTempDir();
    try {
      const first = makeStore({ userDataDir: dir });
      first.store.roster.upsertContacts([{ uuid: 'aaaa-1111', number: '+15550100', name: 'Ada' }]);
      first.store.close();

      const second = makeStore({ userDataDir: dir });
      try {
        assert.equal(second.store.db.schemaVersion, LATEST_SCHEMA_VERSION);
        assert.equal(second.store.roster.getBuddy('aaaa-1111')?.displayName, 'Ada');
        assert.equal(
          Number(
            second.store.db.raw.prepare(`SELECT count(*) FROM schema_migrations`).pluck().get()
          ),
          MIGRATIONS.length
        );
      } finally {
        second.store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuse to open a database from a newer build', () => {
    const fixture = makeStore();
    const file = fixture.file;
    try {
      fixture.store.db.raw.pragma(`user_version=${LATEST_SCHEMA_VERSION + 5}`);
      fixture.store.close();

      assert.throws(
        () => openDatabase({ file, allowUnencrypted: true }),
        /forward-only|newer than this build/i
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('the schema has no profile_key column', () => {
    // signal-cli 0.14.6 does not expose profile keys, and SPEC.md §10 forbids key handling
    // here. A column that can never be populated must not exist.
    const fixture = makeStore();
    try {
      const columns = fixture.store.db.raw
        .prepare(`SELECT name FROM pragma_table_info('buddies')`)
        .pluck()
        .all() as string[];
      assert.ok(!columns.includes('profile_key'));
      assert.ok(columns.includes('message_expiration_time'));
      assert.ok(columns.includes('id'));
    } finally {
      fixture.cleanup();
    }
  });

  test('the database file is created outside the project and with tight permissions', () => {
    const fixture = makeStore();
    try {
      assert.ok(!fixture.file.startsWith(process.cwd()));
      assert.ok(!/Mobile Documents|CloudDocs/i.test(fixture.file));
      const mode = fs.statSync(fixture.file).mode & 0o777;
      assert.equal(mode, 0o600);
      assert.equal(path.basename(fixture.file), 'messages.db');
    } finally {
      fixture.cleanup();
    }
  });
});
