/**
 * Proves the native SQLite binding is actually built against Electron's ABI.
 *
 * Run as:  ELECTRON_RUN_AS_NODE=1 npx electron .github/scripts/verify-electron-abi.cjs
 *
 * ELECTRON_RUN_AS_NODE makes the Electron binary behave like `node`, but it is still
 * Electron's V8/NODE_MODULE_VERSION. So a module compiled for stock Node fails to load here
 * with ERR_DLOPEN_FAILED / "was compiled against a different Node.js version". That is the
 * whole point: without this step CI would happily run the Node-ABI build and the app would
 * only explode at runtime on a developer's machine.
 *
 * CommonJS on purpose — `require()` is what surfaces the ABI mismatch, and it works under
 * every Electron version's ELECTRON_RUN_AS_NODE.
 */

'use strict';

const path = require('node:path');

// SPEC.md §8 requires encryption at rest, which usually means swapping better-sqlite3 for
// better-sqlite3-multiple-ciphers. Check whichever is installed.
const CANDIDATES = process.env.NATIVE_MODULE
  ? [process.env.NATIVE_MODULE]
  : ['better-sqlite3-multiple-ciphers', 'better-sqlite3'];

function fail(message, error) {
  console.error(`\n✗ ${message}`);
  if (error) console.error(error.stack ?? String(error));
  console.error(
    '\nThe native module is not usable from Electron. Rebuild it against the Electron ABI:\n' +
      '    npx electron-rebuild -f -w better-sqlite3 --arch arm64\n'
  );
  process.exit(1);
}

if (!process.versions.electron) {
  fail(
    'not running under Electron. This check is meaningless outside the Electron runtime — ' +
      'invoke it with ELECTRON_RUN_AS_NODE=1 and the electron binary.'
  );
}

console.log('runtime');
console.log(`  electron            ${process.versions.electron}`);
console.log(`  node (bundled)      ${process.versions.node}`);
console.log(`  chrome              ${process.versions.chrome}`);
console.log(`  NODE_MODULE_VERSION ${process.versions.modules}`);
console.log(`  arch                ${process.arch}`);
console.log(`  platform            ${process.platform}`);

if (process.arch !== 'arm64') {
  fail(`expected an arm64 runtime (Apple Silicon only), got ${process.arch}`);
}

let Database = null;
let resolvedName = null;
const errors = [];

for (const name of CANDIDATES) {
  try {
    Database = require(name);
    resolvedName = name;
    break;
  } catch (error) {
    errors.push(`  ${name}: ${error.message.split('\n')[0]}`);
  }
}

if (!Database) {
  fail(`could not load a native SQLite binding.\n${errors.join('\n')}`);
}

console.log(`\nloaded ${resolvedName}`);
try {
  console.log(`  from ${path.dirname(require.resolve(`${resolvedName}/package.json`))}`);
} catch {
  /* resolution of package.json is best-effort only */
}

// Exercise the binding for real. Loading alone can succeed with a stub; a prepared statement
// round-trip proves the compiled .node is functional under this ABI.
try {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  db.prepare('INSERT INTO probe (id, n) VALUES (?, ?)').run('abi', 1);
  const row = db.prepare('SELECT n FROM probe WHERE id = ?').get('abi');
  if (!row || row.n !== 1) {
    fail(`round-trip returned ${JSON.stringify(row)}, expected { n: 1 }`);
  }

  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
  console.log(`  sqlite              ${sqliteVersion}`);

  // Foreign keys are required by the schema in SPEC.md §6 (buddy_group_members references
  // buddies/buddy_groups). Confirm the build supports them.
  db.pragma('foreign_keys = ON');
  const [{ foreign_keys: fk }] = db.pragma('foreign_keys');
  if (fk !== 1) fail('this build cannot enable PRAGMA foreign_keys');

  db.close();
} catch (error) {
  fail('native SQLite round-trip failed under the Electron ABI', error);
}

console.log('\n✓ native SQLite binding loads and works under the Electron ABI');
