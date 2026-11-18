#!/usr/bin/env node
// Explicitly paid operator action, never imported by CI or executed on requests.
import { pathToFileURL } from 'node:url';
import { getClient } from '../api/_db.js';
import { admitExecution, checkExecutionLease, finishExecution, executionQueueEnabled } from '../api/_execution-queue.js';
import { prepareExecutionSnapshot } from '../api/_execution-warm.js';

export async function main({ argv = process.argv.slice(2), env = process.env,
  dbFactory = getClient, loadSdk = () => import('@vercel/sandbox'), output = console.log } = {}) {
  if (argv.length !== 2 || !['javascript', 'python'].includes(argv[0]) || argv[1] !== '--confirm-spend'
    || !executionQueueEnabled(env) || env.EXECUTION_PROVIDER !== 'vercel-sandbox') {
    throw new Error('Usage: execution-prewarm.mjs javascript|python --confirm-spend; requires EXECUTION_QUEUE_ENABLED=true and vercel-sandbox');
  }
  const db = dbFactory(), language = argv[0];
  const lease = await admitExecution(db, { ops: true, operation: `prewarm:${language}` }, { env });
  let safe = true;
  const started = Date.now();
  try {
    const { Sandbox } = await loadSdk();
    const result = await prepareExecutionSnapshot(language, { Sandbox,
      beforeCreate: () => checkExecutionLease(db, lease), lifecycle: event => { safe = event === 'stopped'; } });
    output(`EXECUTION_WARM_${language.toUpperCase()}_SNAPSHOT_ID=${result.snapshotId}`);
    output(`Snapshot expires after ${result.expirationMs / 86400000} days; replace only after a drained redeploy.`);
    return result;
  } finally {
    try { await finishExecution(db, lease, { safeToRelease: safe, providerMs: Date.now() - started }); } catch {}
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(() => { console.error('Execution pre-warm failed; no automatic cold retry. Check credentials, admission and SDK support.'); process.exitCode = 1; });
}
