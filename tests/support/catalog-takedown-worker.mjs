import { pathToFileURL } from 'node:url';

import { executeTakedown } from '../../scripts/catalog-provenance.mjs';

const [catalogPath, manifestPath, lockPath, reference, holdLockMs = '0'] = process.argv.slice(2);

try {
  const result = await executeTakedown({
    slug: 'focus-block-rollup',
    version: 1,
    reference,
    date: '2026-09-19',
    reason: `Concurrent takedown ${reference}.`,
    now: '2026-09-19',
    dryRun: false,
  }, {
    catalogUrl: pathToFileURL(catalogPath),
    manifestUrl: pathToFileURL(manifestPath),
    lockUrl: pathToFileURL(lockPath),
    lockNow: '2026-09-19T12:00:00.000Z',
    holdLockMs: Number(holdLockMs),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, changed: result.changed })}\n`);
} catch (error) {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 1;
}
