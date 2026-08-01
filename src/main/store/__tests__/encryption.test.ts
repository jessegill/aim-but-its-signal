/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * SPEC.md §8 — encryption at rest, and the fail-closed behaviour around it.
 *
 * These tests exercise the real driver and the real key-wrapping path, with a stand-in for
 * Electron's `safeStorage` (which cannot run outside Electron). Whether the file on disk is
 * genuinely ciphertext is checked directly, not assumed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { openStore } from '../index.ts';
import {
  openDatabase,
  assertFileIsEncrypted,
  ENCRYPTED_DRIVERS,
  EncryptionNotEffectiveError,
} from '../db.ts';
import {
  getOrCreateDatabaseKey,
  assertSafeDatabaseLocation,
  EncryptionUnavailableError,
  KeyUnrecoverableError,
  UnsafeDatabaseLocationError,
  KEY_FILE_NAME,
} from '../encryption.ts';
import { makeTempDir, fakeSafeStorage } from './helpers.ts';

const HAS_ENCRYPTED_DRIVER = (() => {
  try {
    const dir = makeTempDir('retro-im-probe-');
    const db = openDatabase({
      file: path.join(dir, 'probe.db'),
      keyHex: randomBytes(32).toString('hex'),
    });
    const encrypted = db.encrypted;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return encrypted;
  } catch {
    return false;
  }
})();

describe('encryption at rest', () => {
  test(
    'the database file is ciphertext, unreadable without the key',
    {
      skip: !HAS_ENCRYPTED_DRIVER
        ? `no encryption-capable driver installed (${ENCRYPTED_DRIVERS.join(' / ')})`
        : false,
    },
    () => {
      const dir = makeTempDir();
      try {
        const safeStorage = fakeSafeStorage();
        const store = openStore({ userDataDir: dir, safeStorage });
        assert.equal(store.encrypted, true);

        const needle = 'PLAINTEXT-NEEDLE-should-never-appear';
        store.messages.persistInboundThenAck(
          {
            conversationId: 'peer',
            senderId: 'peer',
            outgoing: false,
            body: needle,
            sentAt: 1,
            receivedAt: 1,
            expiresAt: null,
            kind: 'text',
          },
          (m) => m
        );
        const file = store.db.file;
        store.close();

        const bytes = fs.readFileSync(file);
        assert.ok(!bytes.includes(Buffer.from(needle)), 'message body is in cleartext on disk');
        assert.notEqual(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');

        // Opening it with the wrong key must fail, not silently produce an empty database.
        assert.throws(
          () => openDatabase({ file, keyHex: randomBytes(32).toString('hex') }),
          /could not be decrypted|not a database/i
        );

        // Reopening with the same keychain reads it back.
        const reopened = openStore({ userDataDir: dir, safeStorage });
        try {
          assert.equal(reopened.messages.getMessages('peer')[0].body, needle);
        } finally {
          reopened.close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  test('the key on disk is wrapped, never plaintext', () => {
    const dir = makeTempDir();
    try {
      const safeStorage = fakeSafeStorage();
      const keyHex = getOrCreateDatabaseKey(dir, safeStorage);
      assert.match(keyHex, /^[0-9a-f]{64}$/);

      const keyFile = path.join(dir, KEY_FILE_NAME);
      const onDisk = fs.readFileSync(keyFile);
      assert.ok(!onDisk.includes(Buffer.from(keyHex, 'utf8')), 'key is on disk in plaintext');
      assert.ok(!onDisk.includes(Buffer.from(keyHex, 'hex')), 'raw key bytes are on disk');
      assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);

      // Stable across calls — a regenerated key would orphan the database.
      assert.equal(getOrCreateDatabaseKey(dir, safeStorage), keyHex);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when safeStorage is unavailable', () => {
    const dir = makeTempDir();
    try {
      assert.throws(
        () => getOrCreateDatabaseKey(dir, fakeSafeStorage(false)),
        EncryptionUnavailableError
      );
      // Nothing was written, so a later successful run starts clean.
      assert.ok(!fs.existsSync(path.join(dir, KEY_FILE_NAME)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to regenerate a key it cannot decrypt', () => {
    const dir = makeTempDir();
    try {
      getOrCreateDatabaseKey(dir, fakeSafeStorage());
      // A different keychain identity — e.g. the file was copied from another machine.
      assert.throws(() => getOrCreateDatabaseKey(dir, fakeSafeStorage()), KeyUnrecoverableError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a plaintext file is detected even if the driver claimed to encrypt it', () => {
    // SQLite ignores unknown pragmas silently, so plain better-sqlite3 accepts
    // `PRAGMA cipher` / `PRAGMA hexkey` without error and writes a cleartext database. This
    // is the check that stops that from passing as encryption at rest.
    const dir = makeTempDir();
    try {
      const file = path.join(dir, 'plain.db');
      const db = openDatabase({ file, allowUnencrypted: true });
      db.raw.exec('CREATE TABLE t(a TEXT)');
      db.checkpoint();
      db.close();

      assert.throws(
        () => assertFileIsEncrypted(file, 'better-sqlite3'),
        EncryptionNotEffectiveError
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('openDatabase refuses to run without a key unless explicitly told to', () => {
    const dir = makeTempDir();
    try {
      assert.throws(
        () => openDatabase({ file: path.join(dir, 'x.db') }),
        /requires keyHex|encryption-capable/i
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('database location safety', () => {
  test('refuses iCloud Drive and other cloud-synced paths', () => {
    const home = process.env.HOME ?? '/Users/nobody';
    const unsafe = [
      `${home}/Library/Mobile Documents/com~apple~CloudDocs/Projects/app/messages.db`,
      `${home}/Library/CloudStorage/Dropbox/messages.db`,
      `${home}/Dropbox/messages.db`,
      `${home}/Documents/messages.db`,
      `${home}/Desktop/messages.db`,
    ];
    for (const file of unsafe) {
      assert.throws(
        () => assertSafeDatabaseLocation(file),
        UnsafeDatabaseLocationError,
        `expected ${file} to be rejected`
      );
    }
  });

  test('refuses a path inside the project directory', () => {
    assert.throws(
      () => assertSafeDatabaseLocation(path.join(process.cwd(), 'messages.db')),
      UnsafeDatabaseLocationError
    );
  });

  test('accepts the Application Support location Electron actually uses', () => {
    const home = process.env.HOME ?? '/Users/nobody';
    assert.doesNotThrow(() =>
      assertSafeDatabaseLocation(`${home}/Library/Application Support/RetroIM/store/messages.db`)
    );
  });

  test('refuses a relative path', () => {
    assert.throws(
      () => assertSafeDatabaseLocation('store/messages.db'),
      UnsafeDatabaseLocationError
    );
  });
});
