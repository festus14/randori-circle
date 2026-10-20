// A migrated-to-latest SQLite file for unit tests, without re-running the
// migration chain for every test.
//
// Most unit fixtures only need "an empty database at the latest schema".
// Running prepareMigrationConnection -> inspectMigrationState -> applyMigrations
// over every executable migration costs about a second per test locally and
// several on CI, and dominated the unit suite's wall time. This helper runs the
// real applyMigrations path once to build a template file, then copies that
// file for each test.
//
// The template is cached in the OS temp directory, keyed by a hash of every
// db/*.js source, the executable migration checksums and the @libsql/client
// version, so `node --test` worker processes share one build and any schema,
// ledger or runner change produces a new template. Set
// RANDORI_MIGRATED_TEMPLATE_CACHE=0 to build a private template per process.
//
// Tests that exercise migrations themselves (partial versions, fingerprints,
// adopt/apply paths, fresh or unmanaged ledgers, runner behaviour) must keep
// calling the migration runner directly.
//
// The copy is byte-for-byte what applyMigrations produced, so schema, ledger
// rows and seeded rows (credential key controls, membership rollout) match a
// freshly migrated file. Only the wall-clock values written during migration
// (applied_at, execution_ms, installed_at/updated_at) come from the template
// build rather than from the test's own run.
import { createHash, randomUUID } from 'node:crypto';
import {
  constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIDE_FILES = ['-wal', '-shm', '-journal'];
const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

let templatePromise = null;
let readyTemplatePath = null;

function templateKey() {
  const hash = createHash('sha256');
  const dbDir = join(ROOT, 'db');
  for (const name of readdirSync(dbDir).filter((file) => file.endsWith('.js')).sort()) {
    hash.update(`${name}\0`).update(readFileSync(join(dbDir, name))).update('\0');
  }
  hash.update(JSON.stringify(EXECUTABLE_MIGRATIONS.map(({ version, checksum }) => [version, checksum])));
  for (const pkg of ['@libsql/client', 'libsql']) {
    const manifest = join(ROOT, 'node_modules', pkg, 'package.json');
    hash.update(`${pkg}:${existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : 'missing'}\0`);
  }
  return hash.digest('hex').slice(0, 32);
}

async function migrateFile(path) {
  const db = createClient({ url: `file:${path}` });
  try {
    await prepareMigrationConnection(db);
    const initial = await inspectMigrationState(db, { migrations: EXECUTABLE_MIGRATIONS });
    const result = await applyMigrations(db, {
      migrations: EXECUTABLE_MIGRATIONS,
      expectedStateFingerprint: initial.stateFingerprint,
      retry: NO_RETRY,
    });
    if (result.toVersion !== EXECUTABLE_MIGRATIONS.at(-1).version) {
      throw new Error(`migrated template stopped at version ${result.toVersion}`);
    }
    // Fold any WAL content into the main file so a plain file copy is complete.
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true });
}

async function buildTemplate() {
  const key = templateKey();
  if (process.env.RANDORI_MIGRATED_TEMPLATE_CACHE === '0') {
    const directory = mkdtempSync(join(tmpdir(), 'randori-migrated-template-'));
    const path = join(directory, `${key}.sqlite`);
    await migrateFile(path);
    process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    return path;
  }
  const cacheDir = join(tmpdir(), 'randori-migrated-template');
  const path = join(cacheDir, `${key}.sqlite`);
  if (existsSync(path)) return path;
  mkdirSync(cacheDir, { recursive: true });
  // Build under a unique name and rename into place, so concurrent test
  // processes never copy a half-written template.
  const building = join(cacheDir, `${key}.${process.pid}.${randomUUID()}.building.sqlite`);
  try {
    await migrateFile(building);
    renameSync(building, path);
  } finally {
    for (const suffix of ['', ...SIDE_FILES]) rmSync(`${building}${suffix}`, { force: true });
  }
  return path;
}

/** Path of the migrated template, built at most once per process. */
export function migratedTemplatePath() {
  templatePromise ??= buildTemplate().then((path) => {
    readyTemplatePath = path;
    return path;
  }, (error) => {
    templatePromise = null;
    throw error;
  });
  return templatePromise;
}

/**
 * Write a migrated-to-latest database at `path`, which must not exist yet.
 * Open clients on it only after this resolves, and still call
 * prepareMigrationConnection on each client: its pragmas are per connection.
 */
export async function copyMigratedDatabase(path) {
  const template = await migratedTemplatePath();
  copyFileSync(template, path, constants.COPYFILE_EXCL);
  return path;
}

/**
 * Synchronous copy for fixtures that must stay synchronous. The template must
 * already be built in this process: `await migratedTemplatePath()` first, for
 * example in a `before()` hook or at module top level.
 */
export function copyMigratedDatabaseSync(path) {
  if (!readyTemplatePath) throw new Error('await migratedTemplatePath() before copyMigratedDatabaseSync()');
  copyFileSync(readyTemplatePath, path, constants.COPYFILE_EXCL);
  return path;
}

/**
 * A fresh migrated database in its own temp directory.
 * Returns { directory, path, url, cleanup }.
 */
export async function createMigratedDatabase({ prefix = 'randori-migrated-', filename = 'database.sqlite' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const path = join(directory, filename);
  try {
    await copyMigratedDatabase(path);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    path,
    url: `file:${path}`,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
