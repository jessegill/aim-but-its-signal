/**
 * SQLite connection: driver selection, encryption at rest, durability pragmas, integrity
 * checking, migrations, and the secure-deletion primitives the rest of the store builds on.
 *
 * Runs in the Electron main process only (SPEC.md §3 — all persistence happens in main).
 *
 * ---------------------------------------------------------------------------------------
 * ENCRYPTION AT REST (SPEC.md §8)
 * ---------------------------------------------------------------------------------------
 * `better-sqlite3` itself has no encryption. Encryption comes from the native driver. We
 * probe, in order:
 *
 *   1. `better-sqlite3-multiple-ciphers` — a drop-in fork of better-sqlite3 that statically
 *      links SQLite3MultipleCiphers, which implements the SQLCipher format. Verified working
 *      on darwin-arm64 (prebuilt binary, no local toolchain needed). This is the default.
 *   2. `@signalapp/better-sqlite3` — Signal Desktop's fork, which links real SQLCipher. Also
 *      works, but has no prebuilds: it runs `node-gyp rebuild` and needs Xcode CLT.
 *   3. `better-sqlite3` — plain, NO ENCRYPTION. Only used when `allowUnencrypted: true` is
 *      passed explicitly, which production code must never do.
 *
 * If none of the encryption-capable drivers is installed, `openDatabase` throws rather than
 * silently degrading. There is no code path in which the app opens a plaintext database
 * without the caller having asked for one by name.
 *
 * ---------------------------------------------------------------------------------------
 * SECURE DELETION AND WAL RESIDUE
 * ---------------------------------------------------------------------------------------
 * A `DELETE` alone does not destroy data:
 *   - the freed page content stays in the file unless `secure_delete` is on, and
 *   - in WAL mode the *pre-delete* page image lives in the `-wal` file until a checkpoint.
 *
 * So `securePurge()` does all three things: delete inside a transaction with
 * `PRAGMA secure_delete = ON`, then `PRAGMA wal_checkpoint(TRUNCATE)` to fold the zeroed
 * pages into the main file and truncate the WAL to zero length, then (throttled) `VACUUM` to
 * rebuild the file and drop freelist residue. `PRAGMA temp_store = MEMORY` keeps VACUUM's
 * temporary database off disk. This sequence was verified empirically: after checkpoint the
 * deleted bytes are absent from the `.db`, `-wal` and `-shm` files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations.ts';
import { assertSafeDatabaseLocation } from './encryption.ts';
import { nodeRequire } from './require-shim.ts';

// ---------------------------------------------------------------------------
// Minimal structural typing for the driver
// ---------------------------------------------------------------------------
// Declared here rather than depending on @types/better-sqlite3, because the driver we load
// is a fork and the type package would be wrong about its name anyway.

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Values SQLite can bind. Booleans are deliberately absent — the driver rejects them. */
export type SqliteBindValue = string | number | bigint | Buffer | Uint8Array | null;

/** Positional bindings, or a single object of named bindings. */
export type SqliteBindParams = readonly (SqliteBindValue | Record<string, SqliteBindValue>)[];

export interface SqliteStatement<TRow = unknown> {
  run(...params: SqliteBindParams): SqliteRunResult;
  get(...params: SqliteBindParams): TRow | undefined;
  all(...params: SqliteBindParams): TRow[];
  iterate(...params: SqliteBindParams): IterableIterator<TRow>;
  pluck<T = unknown>(toggle?: boolean): SqliteStatement<T>;
  raw<T = unknown>(toggle?: boolean): SqliteStatement<T>;
}

/**
 * A transaction-wrapped function. Only the zero-argument form is modelled: every transaction
 * in this store closes over what it needs, which keeps the type honest and avoids `any`.
 */
export interface SqliteTransaction<T> {
  (): T;
  immediate(): T;
  exclusive(): T;
  deferred(): T;
}

export interface SqliteDatabase {
  readonly name: string;
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare<TRow = unknown>(sql: string): SqliteStatement<TRow>;
  exec(sql: string): SqliteDatabase;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(fn: () => T): SqliteTransaction<T>;
  close(): void;
}

type SqliteConstructor = new (
  filename: string,
  options?: Record<string, unknown>
) => SqliteDatabase;

/** `PRAGMA name` read back as a number. */
function pragmaNumber(db: SqliteDatabase, name: string): number {
  return Number(db.pragma(name, { simple: true }));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NoEncryptedDriverError extends Error {
  tried: string[];
  constructor(tried: string[], detail: string) {
    super(
      `No encryption-capable SQLite driver is installed (tried: ${tried.join(', ')}). ` +
        `SPEC.md §8 requires the local database to be encrypted at rest, so the store will ` +
        `not open a plaintext database. Install 'better-sqlite3-multiple-ciphers'. ${detail}`
    );
    this.name = 'NoEncryptedDriverError';
    this.tried = tried;
  }
}

export class DatabaseKeyMismatchError extends Error {
  constructor(file: string) {
    super(
      `${file} could not be decrypted with the key from the OS keychain. The database is ` +
        `either corrupt or was created under a different keychain identity.`
    );
    this.name = 'DatabaseKeyMismatchError';
  }
}

export class EncryptionNotEffectiveError extends Error {
  constructor(file: string, driver: string) {
    super(
      `${file} still begins with a plaintext SQLite header after keying, so it is NOT ` +
        `encrypted. The loaded driver (${driver}) accepted the cipher pragmas but ignored ` +
        `them — SQLite silently ignores unknown pragmas, which is exactly how a build ends up ` +
        `believing it has encryption at rest when it does not. Install ` +
        `'better-sqlite3-multiple-ciphers' in place of plain 'better-sqlite3'.`
    );
    this.name = 'EncryptionNotEffectiveError';
  }
}

export class DatabaseCorruptError extends Error {
  problems: string[];
  constructor(file: string, problems: string[]) {
    super(
      `Integrity check failed for ${file}. The database is damaged and will not be opened; ` +
        `continuing would serve partial or wrong message history. Problems:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nRecovery: quit the app, move the database aside, and relaunch to start a fresh ` +
        `history (SPEC.md §2 — history accumulates going forward and is not imported).`
    );
    this.name = 'DatabaseCorruptError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Driver resolution
// ---------------------------------------------------------------------------

export type DriverName =
  'better-sqlite3-multiple-ciphers' | '@signalapp/better-sqlite3' | 'better-sqlite3';

/** Drivers that can actually encrypt, in preference order. */
export const ENCRYPTED_DRIVERS: DriverName[] = [
  'better-sqlite3-multiple-ciphers',
  '@signalapp/better-sqlite3',
];

interface ResolvedDriver {
  name: DriverName;
  ctor: SqliteConstructor;
  encrypts: boolean;
}

/**
 * Tests and `npm`-less development need to point at a driver that is not resolvable from this
 * file. Honoured only when Electron is absent — a packaged app can never be redirected.
 */
function driverPathOverride(): string | null {
  const override = process.env.AIMGNAL_SQLITE_DRIVER;
  if (!override) return null;
  let insideElectron = false;
  try {
    insideElectron = Boolean((nodeRequire('electron') as { app?: unknown } | undefined)?.app);
  } catch {
    insideElectron = false;
  }
  if (insideElectron) return null;
  return override;
}

function tryLoad(id: string): SqliteConstructor | null {
  try {
    const mod = nodeRequire(id) as SqliteConstructor | { default?: SqliteConstructor };
    const ctor = (mod as { default?: SqliteConstructor }).default ?? (mod as SqliteConstructor);
    return typeof ctor === 'function' ? ctor : null;
  } catch {
    return null;
  }
}

function classifyDriver(id: string): DriverName {
  if (id.includes('multiple-ciphers')) return 'better-sqlite3-multiple-ciphers';
  if (id.includes('signalapp')) return '@signalapp/better-sqlite3';
  return 'better-sqlite3';
}

const DRIVER_INSTALL_HINT =
  "Install 'better-sqlite3-multiple-ciphers': on macOS arm64 it ships a prebuilt binary, and " +
  'for Electron it must additionally be rebuilt against the Electron ABI ' +
  '(@electron/rebuild, or electron-builder install-app-deps).';

export function resolveDriver(allowUnencrypted: boolean): ResolvedDriver {
  const override = driverPathOverride();
  const tried: string[] = [];

  if (override) {
    tried.push(override);
    const ctor = tryLoad(override);
    if (ctor) {
      const name = classifyDriver(override);
      const encrypts = name !== 'better-sqlite3';
      if (!encrypts && !allowUnencrypted)
        throw new NoEncryptedDriverError(tried, DRIVER_INSTALL_HINT);
      return { name, ctor, encrypts };
    }
  }

  for (const name of ENCRYPTED_DRIVERS) {
    tried.push(name);
    const ctor = tryLoad(name);
    if (ctor) return { name, ctor, encrypts: true };
  }

  if (allowUnencrypted) {
    tried.push('better-sqlite3');
    const ctor = tryLoad('better-sqlite3');
    if (ctor) return { name: 'better-sqlite3', ctor, encrypts: false };
  }

  throw new NoEncryptedDriverError(tried, DRIVER_INSTALL_HINT);
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export interface OpenOptions {
  /** Absolute path to the database file. Must live under `app.getPath('userData')`. */
  file: string;
  /** Hex-encoded 256-bit key. Required unless `allowUnencrypted` is set. */
  keyHex?: string | null;
  /**
   * Opt in to a PLAINTEXT database. Only tests and the "prove secure deletion actually
   * removes bytes" harness may pass this. Production must never set it.
   */
  allowUnencrypted?: boolean;
  /** `full` (default) runs `PRAGMA integrity_check`; `quick` runs `quick_check`. */
  integrityCheck?: 'full' | 'quick' | 'off';
  /** `FULL` (default) fsyncs every commit. `NORMAL` is the documented floor. */
  synchronous?: 'FULL' | 'NORMAL';
  /** Skips the cloud-sync/location guard. Only for tests using an OS temp directory. */
  skipLocationGuard?: boolean;
  /** Minimum interval between VACUUMs during secure purges. Default 60s. */
  vacuumThrottleMs?: number;
  /** Milliseconds to wait on a locked database before failing. Default 5000. */
  busyTimeoutMs?: number;
}

export interface StoreDatabase {
  readonly raw: SqliteDatabase;
  readonly driver: DriverName;
  /** True only when the database file on disk is actually encrypted. */
  readonly encrypted: boolean;
  readonly file: string;
  readonly schemaVersion: number;
  /** Runs `fn` in an IMMEDIATE transaction. Multi-statement work must use this. */
  transaction<T>(fn: () => T): SqliteTransaction<T>;
  /**
   * Runs a destructive `fn` and then makes the removal real: checkpoint the WAL (always) and
   * VACUUM (throttled, or forced). Returns whatever `fn` returned.
   */
  securePurge<T>(fn: () => T, opts?: { forceVacuum?: boolean }): T;
  /** Folds the WAL into the main database and truncates it to zero length. */
  checkpoint(): void;
  close(): void;
}

export function openDatabase(options: OpenOptions): StoreDatabase {
  const {
    file,
    keyHex = null,
    allowUnencrypted = false,
    integrityCheck = 'full',
    synchronous = 'FULL',
    skipLocationGuard = false,
    vacuumThrottleMs = 60_000,
    busyTimeoutMs = 5_000,
  } = options;

  if (!skipLocationGuard) assertSafeDatabaseLocation(file);

  if (!allowUnencrypted && !keyHex) {
    throw new Error(
      'openDatabase requires keyHex. The key must come from the OS keychain via ' +
        'getOrCreateDatabaseKey(); there is no default and no fallback.'
    );
  }

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  const driver = resolveDriver(allowUnencrypted);
  const isNew = !fs.existsSync(file) || fs.statSync(file).size === 0;
  const db: SqliteDatabase = new driver.ctor(file);

  let encrypted = false;
  try {
    if (driver.encrypts && keyHex) {
      applyKey(db, driver.name, keyHex);
      encrypted = true;
    } else if (!allowUnencrypted) {
      throw new NoEncryptedDriverError(
        [driver.name],
        'The resolved driver cannot encrypt and allowUnencrypted was not set.'
      );
    }

    // Verify the key before doing anything else: a wrong key surfaces as SQLITE_NOTADB here.
    try {
      db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get();
    } catch (err) {
      if (encrypted) throw new DatabaseKeyMismatchError(file);
      throw err;
    }

    applyPragmas(db, { synchronous, busyTimeoutMs, isNew });
    runIntegrityCheck(db, file, integrityCheck);
    fs.chmodSync(file, 0o600);
    migrate(db);

    if (encrypted) {
      // Do not take the driver's word for it. SQLite ignores unknown pragmas silently, so a
      // plain build accepts `PRAGMA cipher`/`PRAGMA hexkey` without complaint and writes a
      // cleartext file. Check the bytes.
      db.pragma('wal_checkpoint(TRUNCATE)');
      assertFileIsEncrypted(file, driver.name);
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* already failing */
    }
    throw err;
  }

  let lastVacuumAt = 0;

  const handle: StoreDatabase = {
    raw: db,
    driver: driver.name,
    encrypted,
    file,
    get schemaVersion(): number {
      return pragmaNumber(db, 'user_version');
    },
    transaction<T>(fn: () => T): SqliteTransaction<T> {
      const tx = db.transaction(fn);
      // IMMEDIATE takes the write lock up front, so a write transaction can never fail
      // halfway through with SQLITE_BUSY and leave the caller guessing.
      const wrapped = (() => tx.immediate()) as SqliteTransaction<T>;
      wrapped.immediate = () => tx.immediate();
      wrapped.exclusive = () => tx.exclusive();
      wrapped.deferred = () => tx.deferred();
      return wrapped;
    },
    securePurge<T>(fn: () => T, opts?: { forceVacuum?: boolean }): T {
      const result = db.transaction(fn).immediate();
      // Always checkpoint: without this the pre-delete page images survive in the -wal file.
      db.pragma('wal_checkpoint(TRUNCATE)');
      const now = Date.now();
      if (opts?.forceVacuum || now - lastVacuumAt >= vacuumThrottleMs) {
        db.exec('VACUUM');
        db.pragma('wal_checkpoint(TRUNCATE)');
        lastVacuumAt = now;
      }
      return result;
    },
    checkpoint(): void {
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    close(): void {
      if (!db.open) return;
      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* closing anyway */
      }
      db.close();
    },
  };

  return handle;
}

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

function applyKey(db: SqliteDatabase, driverName: DriverName, keyHex: string): void {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error('Database key must be 64 lowercase hex characters (256 bits).');
  }
  if (driverName === 'better-sqlite3-multiple-ciphers') {
    // Select the SQLCipher scheme, then its v4 defaults (AES-256-CBC, HMAC-SHA512,
    // 256k PBKDF2 iterations for passphrases). `hexkey` supplies the 32 raw key bytes
    // directly, so the KDF is bypassed — appropriate here because the key is already
    // full-entropy CSPRNG output held in the keychain, not a user passphrase.
    db.pragma(`cipher='sqlcipher'`);
    db.pragma(`legacy=4`);
    db.pragma(`hexkey='${keyHex}'`);
  } else {
    // Real SQLCipher: a raw key is given as x'<hex>'.
    db.pragma(`key="x'${keyHex}'"`);
  }
}

/** Every unencrypted SQLite file starts with this 16-byte magic. */
const PLAINTEXT_SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Proves encryption is actually in effect by reading the file header. Cheap, and it is the
 * only check that distinguishes "the driver encrypts" from "the driver ignored the pragma".
 */
export function assertFileIsEncrypted(file: string, driverName = 'unknown'): void {
  let header: Buffer;
  const fd = fs.openSync(file, 'r');
  try {
    header = Buffer.alloc(PLAINTEXT_SQLITE_HEADER.length);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    header = header.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
  // An empty file is not yet proof of anything; migrations always write, so this cannot
  // happen on the open path.
  if (header.length === 0) return;
  if (header.equals(PLAINTEXT_SQLITE_HEADER)) {
    throw new EncryptionNotEffectiveError(file, driverName);
  }
}

// ---------------------------------------------------------------------------
// Pragmas
// ---------------------------------------------------------------------------

function applyPragmas(
  db: SqliteDatabase,
  opts: { synchronous: 'FULL' | 'NORMAL'; busyTimeoutMs: number; isNew: boolean }
): void {
  // Overwrite freed content with zeros. Per-connection, so it is set on every open.
  db.pragma('secure_delete=ON');
  // Keep VACUUM's temporary database (and any spill) out of the filesystem.
  db.pragma('temp_store=MEMORY');
  // Referential integrity is off by default in SQLite. The cascade deletes that purge
  // attachments and reactions depend on it.
  db.pragma('foreign_keys=ON');
  db.pragma(`busy_timeout=${Math.max(0, Math.floor(opts.busyTimeoutMs))}`);

  // auto_vacuum can only be set on an empty database, or converted by a VACUUM. FULL returns
  // freed pages to the OS immediately, which is what we want after an expiry purge.
  const currentAutoVacuum = pragmaNumber(db, 'auto_vacuum');
  if (currentAutoVacuum !== 1) {
    db.pragma('auto_vacuum=FULL');
    if (!opts.isNew) db.exec('VACUUM');
  }

  db.pragma('journal_mode=WAL');
  // FULL fsyncs the WAL on every commit. NORMAL can lose the last transactions on power loss.
  // A chat client writes a handful of small rows per message, so FULL is affordable and it is
  // what makes "persist before acknowledge" (see messages.ts) actually mean something.
  db.pragma(`synchronous=${opts.synchronous}`);
  db.pragma('wal_autocheckpoint=256');
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

function runIntegrityCheck(db: SqliteDatabase, file: string, mode: 'full' | 'quick' | 'off'): void {
  if (mode === 'off') return;
  const pragma = mode === 'quick' ? 'quick_check' : 'integrity_check';
  const rows = db.pragma(pragma) as Record<string, string>[];
  const problems = rows
    .map((row) => String(Object.values(row)[0] ?? ''))
    .filter((value) => value.toLowerCase() !== 'ok');
  if (problems.length > 0) throw new DatabaseCorruptError(file, problems);

  // A dangling foreign key means a purge left a partial row graph behind — worth knowing.
  const fkProblems = db.pragma('foreign_key_check') as unknown[];
  if (fkProblems.length > 0) {
    throw new DatabaseCorruptError(file, [
      `${fkProblems.length} foreign key violation(s): ${JSON.stringify(fkProblems.slice(0, 5))}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

/**
 * Applies every migration newer than `user_version`, each in its own transaction. Forward
 * only: a database from a newer build is refused rather than downgraded.
 *
 * Idempotent by construction — running it twice applies nothing the second time.
 */
export function migrate(db: SqliteDatabase): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `);

  const current = pragmaNumber(db, 'user_version');

  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build understands ` +
        `(${LATEST_SCHEMA_VERSION}). Migrations are forward-only; refusing to open. ` +
        `Upgrade the application.`
    );
  }

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      if (migration.requiresForeignKeysOff) {
        // SQLite's supported table-rebuild recipe: check referential integrity explicitly
        // before committing, because the pragma that would have enforced it is off.
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `Migration ${migration.version} (${migration.name}) left ${violations.length} ` +
              `foreign key violation(s); rolling back.`
          );
        }
      }
      db.prepare(
        'INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, Date.now());
      // PRAGMA does not accept bound parameters; the value is a validated integer literal.
      db.pragma(`user_version=${Number(migration.version)}`);
    });

    if (migration.requiresForeignKeysOff) {
      // foreign_keys is a no-op inside a transaction, so it has to be toggled around it.
      db.pragma('foreign_keys=OFF');
      try {
        apply.immediate();
      } finally {
        db.pragma('foreign_keys=ON');
      }
    } else {
      apply.immediate();
    }
  }

  return pragmaNumber(db, 'user_version');
}
