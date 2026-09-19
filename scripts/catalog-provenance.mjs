import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateProvenanceManifest } from '../api/_catalog-provenance.js';

const CATALOG_URL = new URL('../data/randori-catalog-v1.json', import.meta.url);
const MANIFEST_URL = new URL('../data/randori-catalog-provenance-v1.json', import.meta.url);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/;

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
  const matches = exercise.status === 'retired'
    && JSON.stringify(exercise.governance.retirement) === JSON.stringify(desiredRetirement)
    && JSON.stringify(exercise.governance.takedown) === JSON.stringify(desiredCatalogTakedown)
    && JSON.stringify(record.takedown) === JSON.stringify(desiredManifestTakedown);
  if (matches) {
    validateProvenanceManifest(nextManifest, nextCatalog, { now });
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
  if (exercise.status === 'retired' && exercise.governance.retirement.reason !== reason) {
    fail(`${key} is already retired for a different reason`);
  }

  exercise.status = 'retired';
  exercise.governance.retirement = desiredRetirement;
  exercise.governance.takedown = desiredCatalogTakedown;
  record.takedown = desiredManifestTakedown;
  validateProvenanceManifest(nextManifest, nextCatalog, { now });
  return { catalog: nextCatalog, manifest: nextManifest, changed: true, key };
}

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function writePairFailClosed(manifest, catalog) {
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const manifestTemp = pathToFileURL(`${fileURLToPath(MANIFEST_URL)}${suffix}`);
  const catalogTemp = pathToFileURL(`${fileURLToPath(CATALOG_URL)}${suffix}`);
  try {
    await Promise.all([
      writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
      writeFile(catalogTemp, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    ]);
    // Revocation lands first. An interrupted pair therefore makes runtime
    // validation fail closed rather than serving disputed content.
    await rename(manifestTemp, MANIFEST_URL);
    await rename(catalogTemp, CATALOG_URL);
  } finally {
    await Promise.all([
      rm(manifestTemp, { force: true }),
      rm(catalogTemp, { force: true }),
    ]);
  }
}

async function takedownCommand(argv) {
  const options = parseTakedownArguments(argv);
  const [catalog, manifest] = await Promise.all([readJson(CATALOG_URL), readJson(MANIFEST_URL)]);
  const result = applyTakedown(catalog, manifest, options);
  if (options.dryRun) {
    console.log(`Takedown dry run valid for ${result.key}; changed=${result.changed}`);
    return;
  }
  if (result.changed) await writePairFailClosed(result.manifest, result.catalog);
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
