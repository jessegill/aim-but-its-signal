/**
 * Database encryption key management and database-location safety.
 *
 * SPEC.md §8 requires the local database to be encrypted at rest. SPEC.md §10 forbids this
 * codebase from implementing or reimplementing cryptography — so we do not. We generate a
 * random 32-byte key with the platform CSPRNG, hand it to SQLCipher (via the native driver,
 * see `db.ts`), and protect the key itself with Electron's `safeStorage`, which on macOS is
 * backed by the login Keychain.
 *
 * The key is NEVER hardcoded, NEVER derived from anything guessable, and NEVER written to
 * disk in plaintext. What lands on disk is `safeStorage.encryptString(keyHex)` — a ciphertext
 * blob that is useless without the Keychain item.
 *
 * Failure is closed: if `safeStorage` is unavailable we refuse to open the database rather
 * than quietly falling back to an unencrypted one.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nodeRequire } from './require-shim.ts';

/** Basename of the wrapped-key file inside the store directory. */
export const KEY_FILE_NAME = 'db.key';

/** 32 bytes = 256-bit AES key, the size SQLCipher expects for a raw key. */
const KEY_BYTES = 32;

const HEX_KEY_RE = /^[0-9a-f]{64}$/;

export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionUnavailableError';
  }
}

export class KeyUnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnrecoverableError';
  }
}

export class UnsafeDatabaseLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeDatabaseLocationError';
  }
}

// ---------------------------------------------------------------------------
// Database location safety
// ---------------------------------------------------------------------------

/**
 * Directory fragments that indicate a cloud-synced location. A database holding decrypted
 * message content — or even its ciphertext plus a sibling wrapped key — must never be
 * uploaded to a third-party sync service. This project itself lives in an iCloud Drive
 * folder, so this guard is not hypothetical.
 *
 * Matching is done on the normalised, case-folded absolute path.
 */
const CLOUD_SYNC_MARKERS = [
  '/library/mobile documents', // iCloud Drive (~/Library/Mobile Documents/com~apple~CloudDocs)
  'com~apple~clouddocs',
  '/library/cloudstorage', // macOS 13+ mount point for Dropbox/Drive/OneDrive providers
  '/dropbox/',
  '/google drive/',
  '/googledrive/',
  '/onedrive/',
  '/box sync/',
  '/pcloud drive/',
  '/sync.com/',
];

/**
 * `~/Desktop` and `~/Documents` are opted into iCloud Drive by the "Desktop & Documents
 * Folders" feature, which is on by default for many users. Treat them as unsafe.
 */
function homeSyncedDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, 'Desktop'), path.join(home, 'Documents')];
}

/**
 * Throws unless `dbPath` is a safe place to keep the message database.
 *
 * Intended location is `app.getPath('userData')`, which on macOS resolves to
 * `~/Library/Application Support/<AppName>`. That directory is not synced by iCloud Drive,
 * is per-user, and is where Electron expects app state to live.
 */
export function assertSafeDatabaseLocation(dbPath: string): void {
  if (!path.isAbsolute(dbPath)) {
    throw new UnsafeDatabaseLocationError(
      `Database path must be absolute, got ${JSON.stringify(dbPath)}.`
    );
  }

  const resolved = path.resolve(dbPath);
  const probe = resolved.toLowerCase();

  for (const marker of CLOUD_SYNC_MARKERS) {
    if (probe.includes(marker)) {
      throw new UnsafeDatabaseLocationError(
        `Refusing to open the message database at ${resolved}: the path looks like a ` +
          `cloud-synced folder (matched ${JSON.stringify(marker)}). Message content must ` +
          `never leave this machine. Use app.getPath('userData').`
      );
    }
  }

  for (const dir of homeSyncedDirs()) {
    if (isInside(resolved, dir)) {
      throw new UnsafeDatabaseLocationError(
        `Refusing to open the message database at ${resolved}: ${dir} may be synced to ` +
          `iCloud Drive by the "Desktop & Documents Folders" setting. Use ` +
          `app.getPath('userData').`
      );
    }
  }

  // Never inside the source tree — that is how databases get committed or synced by accident.
  if (isInside(resolved, process.cwd())) {
    throw new UnsafeDatabaseLocationError(
      `Refusing to open the message database at ${resolved}: it is inside the working ` +
        `directory (${process.cwd()}). Use app.getPath('userData').`
    );
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// safeStorage-backed key
// ---------------------------------------------------------------------------

/** The slice of Electron's `safeStorage` we depend on. Kept structural so tests can fake it. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Loads Electron's `safeStorage` lazily. Importing `electron` at module scope would make the
 * whole store unloadable in a plain-node test runner, so the require happens here.
 */
export function loadSafeStorage(): SafeStorageLike {
  let electron: { safeStorage?: SafeStorageLike } | undefined;
  try {
    electron = nodeRequire('electron') as { safeStorage?: SafeStorageLike };
  } catch {
    electron = undefined;
  }
  const safeStorage = electron?.safeStorage;
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new EncryptionUnavailableError(
      'Electron safeStorage is not available. The store must run in the Electron main ' +
        'process (SPEC.md §3). Refusing to open an unencrypted database.'
    );
  }
  return safeStorage;
}

/**
 * Returns the hex-encoded 256-bit database key, creating and wrapping one on first run.
 *
 * @param storeDir directory that holds the database and the wrapped key (created 0700).
 * @param safeStorage injected for tests; defaults to Electron's.
 *
 * Fails closed:
 * - `isEncryptionAvailable() === false` → {@link EncryptionUnavailableError}. On macOS this
 *   is false before `app.whenReady()` resolves, and can also be false if the login Keychain
 *   is locked or the user denied the app access to its "Safe Storage" Keychain item. In every
 *   one of those cases opening an unencrypted database would be a silent security downgrade.
 * - an existing key file that will not decrypt → {@link KeyUnrecoverableError}. We do NOT
 *   regenerate: a fresh key would orphan the existing database and present as unexplained
 *   data loss. The caller should surface this and offer to start over explicitly.
 */
export function getOrCreateDatabaseKey(
  storeDir: string,
  safeStorage: SafeStorageLike = loadSafeStorage()
): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError(
      'safeStorage.isEncryptionAvailable() returned false, so the database key cannot be ' +
        'protected by the OS keychain. On macOS this happens before app.whenReady(), or if ' +
        "the login Keychain is locked or access to the app's Safe Storage item was denied. " +
        'Refusing to open an unencrypted database (SPEC.md §8).'
    );
  }

  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(storeDir, 0o700);
  } catch {
    /* best effort — a pre-existing directory we do not own */
  }

  const keyFile = path.join(storeDir, KEY_FILE_NAME);

  if (fs.existsSync(keyFile)) {
    const wrapped = fs.readFileSync(keyFile);
    let keyHex: string;
    try {
      keyHex = safeStorage.decryptString(wrapped);
    } catch (err) {
      throw new KeyUnrecoverableError(
        `The database key at ${keyFile} could not be decrypted with this machine's keychain ` +
          `(${(err as Error).message}). The message database cannot be opened. This usually ` +
          `means the keychain item was deleted or the file was copied from another machine. ` +
          `Recovery requires deleting both the key file and the database.`
      );
    }
    if (!HEX_KEY_RE.test(keyHex)) {
      throw new KeyUnrecoverableError(
        `The database key at ${keyFile} decrypted to an unexpected value. Refusing to use it.`
      );
    }
    return keyHex;
  }

  const keyHex = randomBytes(KEY_BYTES).toString('hex');
  writeFileAtomic(keyFile, safeStorage.encryptString(keyHex));
  return keyHex;
}

/** Writes via a temp file + rename + fsync so a crash cannot leave a half-written key. */
function writeFileAtomic(target: string, data: Buffer): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  // fsync the directory so the rename itself is durable.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* directory fsync is unsupported on some filesystems; the rename is still atomic */
  }
}
