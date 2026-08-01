/**
 * Shared fixtures for the store tests.
 *
 * Tests run against a real SQLite file in an OS temp directory — not `:memory:` — because
 * several of the security guarantees under test (secure deletion, WAL residue, view-once
 * never touching disk) are only meaningful on a real file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { openStore } from '../index.ts';
import type { Store, StoreOptions } from '../index.ts';
import type { SafeStorageLike } from '../encryption.ts';

export interface Fixture {
  store: Store;
  dir: string;
  /** Absolute path to the database file. */
  file: string;
  /** Mutable clock the message store reads through `options.messages.now`. */
  clock: { now: number };
  cleanup(): void;
}

export function makeTempDir(prefix = 'aimgnal-store-'): string {
  // realpath so /var/... resolves to /private/var/... — the location guard compares resolved
  // absolute paths, and mismatched symlinks make failures confusing.
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

/**
 * A stand-in for Electron's `safeStorage`. Real `safeStorage` wraps the payload with a key
 * held in the macOS Keychain; this wraps it with a per-instance random key held in memory.
 * The property under test is the same: what lands on disk is ciphertext, and the store cannot
 * read it without the wrapping key.
 */
export function fakeSafeStorage(available = true): SafeStorageLike {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => available,
    encryptString(plain: string): Buffer {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(encrypted: Buffer): string {
      const iv = encrypted.subarray(0, 12);
      const tag = encrypted.subarray(12, 28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString(
        'utf8'
      );
    },
  };
}

export interface FixtureOptions extends Partial<StoreOptions> {
  /** Starting value for the injected clock. */
  startAt?: number;
}

export function makeStore(options: FixtureOptions = {}): Fixture {
  const dir = options.userDataDir ?? makeTempDir();
  const clock = { now: options.startAt ?? 1_700_000_000_000 };

  const store = openStore({
    userDataDir: dir,
    // Default to a plaintext database: the point of most tests is to prove that data is
    // physically absent from the file, which an encrypted file would make vacuously true.
    allowUnencrypted: options.allowUnencrypted ?? true,
    keyHex: options.keyHex,
    safeStorage: options.safeStorage,
    integrityCheck: options.integrityCheck,
    synchronous: options.synchronous,
    messages: { sweepIntervalMs: 60_000, now: () => clock.now, ...options.messages },
  });

  return {
    store,
    dir,
    file: store.db.file,
    clock,
    cleanup() {
      try {
        store.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Reads the database file plus its WAL and shared-memory sidecars. */
export function databaseBytes(file: string): Buffer {
  const parts: Buffer[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      parts.push(fs.readFileSync(file + suffix));
    } catch {
      /* sidecar may not exist */
    }
  }
  return Buffer.concat(parts);
}

/** True if `needle` appears anywhere in the database file or its sidecars. */
export function fileContains(file: string, needle: string): boolean {
  return databaseBytes(file).includes(Buffer.from(needle, 'utf8'));
}

/** Recursively lists every file under `dir`. */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}
