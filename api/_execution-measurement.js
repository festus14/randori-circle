// Aggregate, allowlisted cold-vs-snapshot evidence, shared by both smoke
// assessors. Percentiles need >=20 paired samples before claiming improvement.
import { createHash } from 'node:crypto';
import { executionPercentiles, executionQueueEnabled } from './_execution-queue.js';
import { executionWarmSnapshot } from './_execution-warm.js';
export const WARM_MEASUREMENT_MIN_SAMPLES = 20;
export function warmMeasurementEnabled(env = process.env) {
  return executionQueueEnabled(env) && env.EXECUTION_WARM_MEASURE_ENABLED === 'true';
}
export function warmMeasurementCohort(env = process.env) {
  if (!warmMeasurementEnabled(env)) return null;
  const ids = ['javascript', 'python'].map(language => executionWarmSnapshot(language, env));
  if (env.EXECUTION_PROVIDER !== 'vercel-sandbox' || ids.some(id => !id)) throw new Error('pristine snapshots required');
  return createHash('sha256').update(JSON.stringify(['sdk-3.8.0', 'node24-python3.14', ...ids])).digest('hex');
}
export function sanitizeStartupPair(value) {
  if (!value || typeof value !== 'object') return null;
  const { coldMs, snapshotMs } = value;
  if (![coldMs, snapshotMs].every(ms => Number.isSafeInteger(ms) && ms >= 0 && ms <= 20000)) return null;
  return { coldMs, snapshotMs };
}
export function summarizeStartupPairs(pairs) {
  const valid = pairs.map(sanitizeStartupPair).filter(Boolean);
  const cold = executionPercentiles(valid.map(pair => pair.coldMs));
  const snapshot = executionPercentiles(valid.map(pair => pair.snapshotMs));
  const enough = cold.samples >= WARM_MEASUREMENT_MIN_SAMPLES;
  return { cold, snapshot, minimumSamples: WARM_MEASUREMENT_MIN_SAMPLES, sufficient: enough,
    improvementMs: enough ? cold.p95 - snapshot.p95 : null,
    improved: enough ? snapshot.p95 < cold.p95 : null };
}
export function sanitizeStartupMeasurement(value) {
  if (!value || value.windowDays !== 30 || typeof value.samplesTruncated !== 'boolean') return null;
  const languages = {};
  for (const language of ['javascript', 'python']) {
    const entry = value.languages?.[language];
    if (!entry || entry.minimumSamples !== WARM_MEASUREMENT_MIN_SAMPLES) return null;
    const metrics = {};
    for (const mode of ['cold', 'snapshot']) {
      const item = entry[mode];
      if (!item || !Number.isSafeInteger(item.samples) || item.samples < 0 || item.samples > 140) return null;
      const valid = ms => item.samples === 0 ? ms === null : Number.isSafeInteger(ms) && ms >= 0 && ms <= 20000;
      if (!valid(item.p50) || !valid(item.p95) || item.p50 > item.p95) return null;
      metrics[mode] = { samples: item.samples, p50: item.p50, p95: item.p95 };
    }
    if (metrics.cold.samples !== metrics.snapshot.samples) return null;
    const sufficient = metrics.cold.samples >= WARM_MEASUREMENT_MIN_SAMPLES;
    const improvementMs = sufficient ? metrics.cold.p95 - metrics.snapshot.p95 : null;
    const improved = sufficient ? improvementMs > 0 : null;
    if (entry.sufficient !== sufficient || entry.improvementMs !== improvementMs || entry.improved !== improved) return null;
    languages[language] = { ...metrics, minimumSamples: WARM_MEASUREMENT_MIN_SAMPLES, sufficient, improvementMs, improved };
  }
  return { windowDays: 30, samplesTruncated: value.samplesTruncated, languages };
}

export async function readStartupMeasurement(db, env = process.env) {
  const cohort = warmMeasurementCohort(env);
  if (!cohort) return null;
  const rows = (await db.execute(`SELECT meta_json FROM app_logs WHERE source='runner' AND user_id IS NULL
    AND event='execution_smoke_result' AND created_at>=datetime('now','-30 days') ORDER BY id DESC LIMIT 141`)).rows;
  const pairs = { javascript: [], python: [] };
  for (const row of rows.slice(0, 140)) {
    let stored; try { stored = JSON.parse(row.meta_json); } catch { continue; }
    if (stored?._warmCohort !== cohort) continue;
    for (const language of Object.keys(pairs)) {
      if (stored[language]?.status === 'ok') pairs[language].push(stored[language]?.startup);
    }
  }
  return { windowDays: 30, samplesTruncated: rows.length > 140,
    languages: Object.fromEntries(Object.entries(pairs).map(([language, values]) => [language, summarizeStartupPairs(values)])) };
}
