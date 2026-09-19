import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateCatalog } from '../api/_catalog.js';

const CATALOG_URL = new URL('../data/randori-catalog-v1.json', import.meta.url);
const MANIFEST_URL = new URL('../data/randori-catalog-provenance-v1.json', import.meta.url);
const LOCK_URL = new URL('../data/.randori-catalog-provenance.lock', import.meta.url);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('--date must use YYYY-MM-DD');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail('--date must be a real calendar date');
  }
  return value;
}

function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) fail(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} must be a positive safe integer`);
  return parsed;
}

export function parseTakedownArguments(argv, { now = new Date() } = {}) {
  const allowed = new Set(['--slug', '--version', '--reference', '--date', '--reason', '--dry-run']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!allowed.has(name)) fail(`unknown argument: ${name}`);
    if (values.has(name)) fail(`duplicate argument: ${name}`);
    if (name === '--dry-run') {
      values.set(name, true);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${name} requires a value`);
    values.set(name, value);
    index += 1;
  }

  const slug = values.get('--slug');
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) fail('--slug must be lowercase kebab-case');
  const version = parsePositiveInteger(values.get('--version'), '--version');
  const reference = values.get('--reference');
  if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
    fail('--reference must be a bounded issue or incident reference');
  }
  const date = parseDate(values.get('--date'));
  const today = new Date(now).toISOString().slice(0, 10);
  if (date > today) fail('--date must not be in the future');
  const reason = values.get('--reason') ?? `Emergency provenance takedown (${reference}).`;
  if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500 || /[\r\n]/.test(reason)) {
    fail('--reason must be a single non-empty line of at most 500 characters');
  }
  return { slug, version, reference, date, reason, dryRun: values.has('--dry-run') };
}

export function applyTakedown(catalog, manifest, {
  slug, version, reference, date, reason, now = new Date(),
}) {
  const nextCatalog = structuredClone(catalog);
  const nextManifest = structuredClone(manifest);
  const key = `${slug}@${version}`;
  const exercise = nextCatalog.exercises.find(candidate => (
    candidate.slug === slug && candidate.version === version
  ));
  const record = nextManifest.records.find(candidate => candidate.key === key);
  if (!exercise || !record) fail(`no catalogue and provenance record found for ${key}`);

  const desiredCatalogTakedown = { status: 'revoked', requestedAt: date, reference };
  const desiredManifestTakedown = { status: 'revoked', effectiveAt: date, reference };
  const desiredRetirement = { status: 'retired', retiredAt: date, reason, replacement: null };
  try {
    validateCatalog(nextCatalog, undefined, nextManifest, { now });
  } catch (error) {
    const interruptedAfterManifestWrite = exercise.status === 'active'
      && exercise.governance.takedown.status === 'none'
      && record.takedown.status === 'revoked'
      && record.takedown.effectiveAt === date
      && record.takedown.reference === reference;
    if (!interruptedAfterManifestWrite) throw error;
    const recoveredBaseline = structuredClone(nextManifest);
    recoveredBaseline.records.find(candidate => candidate.key === key).takedown = {
      status: 'clear', effectiveAt: null, reference: null,
    };
    // Validate the complete pre-operation catalogue after reversing only the
    // exact partial write that this command can produce. Any unrelated defect
    // still blocks recovery.
    validateCatalog(nextCatalog, undefined, recoveredBaseline, { now });
  }

  const matches = exercise.status === 'retired'
    && JSON.stringify(exercise.governance.takedown) === JSON.stringify(desiredCatalogTakedown)
    && JSON.stringify(record.takedown) === JSON.stringify(desiredManifestTakedown);
  if (matches) {
    validateCatalog(nextCatalog, undefined, nextManifest, { now });
    return { catalog: nextCatalog, manifest: nextManifest, changed: false, key };
  }

  const existingStates = [exercise.governance.takedown.status, record.takedown.status];
  const compatibleStates = new Set(['none', 'clear', 'revoked']);
  if (existingStates.some(state => !compatibleStates.has(state))) {
    fail(`${key} has a non-clear takedown workflow; resolve it before applying a revocation`);
  }
  for (const current of [exercise.governance.takedown, record.takedown]) {
    const currentReference = current.reference;
    const currentDate = current.requestedAt ?? current.effectiveAt;
    if (currentReference !== null && (currentReference !== reference || currentDate !== date)) {
      fail(`${key} is already bound to a different takedown event`);
    }
  }
  if (exercise.status === 'active') {
    exercise.status = 'retired';
    exercise.governance.retirement = desiredRetirement;
  }
  exercise.governance.takedown = desiredCatalogTakedown;
  record.takedown = desiredManifestTakedown;
  validateCatalog(nextCatalog, undefined, nextManifest, { now });
  return { catalog: nextCatalog, manifest: nextManifest, changed: true, key };
}

function digest(raw) {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

async function assertSafeRegularFile(url, label, maximumBytes) {
  if (!(url instanceof URL) || url.protocol !== 'file:') fail(`${label} path is invalid`);
  const info = await lstat(url);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a regular non-symlink file`);
  if (info.size > maximumBytes) fail(`${label} exceeds its size limit`);
  const [resolvedFile, resolvedParent] = await Promise.all([realpath(url), realpath(new URL('.', url))]);
  if (!resolvedFile.startsWith(`${resolvedParent}/`)) fail(`${label} escapes its data directory`);
  return info.mode & 0o777;
}

async function readJsonFile(url, label, maximumBytes) {
  const mode = await assertSafeRegularFile(url, label, maximumBytes);
  const raw = await readFile(url, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) fail(`${label} exceeds its size limit`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return { value, raw, mode };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function acquireLock(lockUrl, { now = new Date(), staleMs = LOCK_STALE_MS } = {}) {
  if (!(lockUrl instanceof URL) || lockUrl.protocol !== 'file:') fail('operator lock path is invalid');
  await realpath(new URL('.', lockUrl));
  const nonce = randomUUID();
  const payload = `${JSON.stringify({ version: 1, pid: process.pid, createdAt: new Date(now).toISOString(), nonce })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockUrl, 'wx', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return nonce;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await lstat(lockUrl);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024) {
        fail('operator lock is unsafe');
      }
      let existing;
      try {
        existing = JSON.parse(await readFile(lockUrl, 'utf8'));
      } catch {
        fail('operator lock is malformed');
      }
      const createdAt = Date.parse(existing?.createdAt);
      if (
        existing?.version !== 1
        || !Number.isSafeInteger(existing?.pid)
        || existing.pid < 1
        || typeof existing?.nonce !== 'string'
        || !/^[a-f0-9-]{36}$/i.test(existing.nonce)
        || !Number.isFinite(createdAt)
      ) {
        fail('operator lock is malformed');
      }
      const age = new Date(now).valueOf() - createdAt;
      if (age <= staleMs || processIsAlive(existing.pid)) fail('another catalogue operation holds the lock');
      const staleUrl = pathToFileURL(`${fileURLToPath(lockUrl)}.stale-${nonce}`);
      try {
        await rename(lockUrl, staleUrl);
      } catch (renameError) {
        if (renameError?.code === 'ENOENT') continue;
        throw renameError;
      }
      await rm(staleUrl, { force: true });
    }
  }
  fail('could not acquire the catalogue operation lock');
}

async function releaseLock(lockUrl, nonce) {
  try {
    const info = await lstat(lockUrl);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 1024) return;
    const current = JSON.parse(await readFile(lockUrl, 'utf8'));
    if (current?.nonce === nonce) await rm(lockUrl);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function writePairFailClosed({
  manifest,
  catalog,
  manifestUrl,
  catalogUrl,
  expectedManifestRaw,
  expectedCatalogRaw,
  afterManifestRename,
}) {
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const manifestTemp = pathToFileURL(`${fileURLToPath(manifestUrl)}${suffix}`);
  const catalogTemp = pathToFileURL(`${fileURLToPath(catalogUrl)}${suffix}`);
  const [manifestMode, catalogMode] = await Promise.all([
    assertSafeRegularFile(manifestUrl, 'provenance manifest', MAX_MANIFEST_BYTES),
    assertSafeRegularFile(catalogUrl, 'catalogue', MAX_CATALOG_BYTES),
  ]);
  try {
    await Promise.all([
      writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx', mode: manifestMode,
      }),
      writeFile(catalogTemp, `${JSON.stringify(catalog, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx', mode: catalogMode,
      }),
    ]);
    const [currentManifest, currentCatalog] = await Promise.all([
      readFile(manifestUrl, 'utf8'),
      readFile(catalogUrl, 'utf8'),
    ]);
    if (
      digest(currentManifest) !== digest(expectedManifestRaw)
      || digest(currentCatalog) !== digest(expectedCatalogRaw)
    ) {
      fail('catalogue files changed after validation');
    }
    // Revocation lands first. An interrupted pair therefore makes runtime
    // validation fail closed rather than serving disputed content.
    await rename(manifestTemp, manifestUrl);
    if (afterManifestRename) await afterManifestRename();
    await rename(catalogTemp, catalogUrl);
  } finally {
    await Promise.all([
      rm(manifestTemp, { force: true }),
      rm(catalogTemp, { force: true }),
    ]);
  }
}

export async function executeTakedown(options, {
  catalogUrl = CATALOG_URL,
  manifestUrl = MANIFEST_URL,
  lockUrl = LOCK_URL,
  lockNow = new Date(),
  staleLockMs = LOCK_STALE_MS,
  holdLockMs = 0,
  afterManifestRename,
} = {}) {
  const lockNonce = await acquireLock(lockUrl, { now: lockNow, staleMs: staleLockMs });
  try {
    const [catalogFile, manifestFile] = await Promise.all([
      readJsonFile(catalogUrl, 'catalogue', MAX_CATALOG_BYTES),
      readJsonFile(manifestUrl, 'provenance manifest', MAX_MANIFEST_BYTES),
    ]);
    const result = applyTakedown(catalogFile.value, manifestFile.value, options);
    if (holdLockMs > 0) await new Promise(resolve => setTimeout(resolve, holdLockMs));
    if (!options.dryRun && result.changed) {
      await writePairFailClosed({
        manifest: result.manifest,
        catalog: result.catalog,
        manifestUrl,
        catalogUrl,
        expectedManifestRaw: manifestFile.raw,
        expectedCatalogRaw: catalogFile.raw,
        afterManifestRename,
      });
    }
    return result;
  } finally {
    await releaseLock(lockUrl, lockNonce);
  }
}

async function takedownCommand(argv) {
  const options = parseTakedownArguments(argv);
  const result = await executeTakedown(options);
  if (options.dryRun) {
    console.log(`Takedown dry run valid for ${result.key}; changed=${result.changed}`);
    return;
  }
  console.log(`Takedown ${result.changed ? 'applied' : 'already applied'} for ${result.key}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === 'takedown') return takedownCommand(rest);
  fail('usage: catalog-provenance.mjs takedown --slug <slug> --version <n> --reference <ref> --date <YYYY-MM-DD> [--reason <text>] [--dry-run]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(`Catalogue provenance operation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
