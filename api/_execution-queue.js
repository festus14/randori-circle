// #468 / ID-103. Durable retry admission in existing TTL storage. No code,
// stdin or raw account/circle ids are stored. The operation key contains an
// HMAC fingerprint of submitted bytes: not reversible, but confirmable by an
// operator with the app secret and a candidate submission.
import { createHmac, randomBytes } from 'node:crypto';

export const EXECUTION_LEASE_SECONDS = 90;
export const EXECUTION_OFFER_SECONDS = 3;
export const EXECUTION_METRIC_WINDOW_SECONDS = 900;
export const EXECUTION_TRANSACTION_ATTEMPTS = 4;
const PREFIX = 'eq1:';
const DB_SECONDS = "CAST(strftime('%s','now') AS INTEGER)";
const DB_MILLIS = "CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)";
const STATE_LIMIT = 145; // 128 pending/offered + 16 active + overflow sentinel
const CONFIG = Object.freeze({
  GLOBAL_CONCURRENCY: [4, 2, 16], CIRCLE_CONCURRENCY: [2, 1, 8],
  INTERVIEW_SHARE: [2, 1, 15], ACCOUNT_PER_MINUTE: [10, 1, 30],
  CIRCLE_PER_MINUTE: [40, 1, 120], GLOBAL_PER_MINUTE: [60, 1, 240],
  GLOBAL_PER_DAY: [150, 1, 10000], QUEUE_LIMIT: [32, 1, 128],
  MAX_WAIT_SECONDS: [15, 2, 20],
});
export function executionQueueEnabled(env = process.env) { return env.EXECUTION_QUEUE_ENABLED === 'true'; }
export class ExecutionBusyError extends Error {
  constructor(reason = 'capacity', retryAfter = 1, { quotaWindow, resetAt } = {}) {
    super('Execution is busy; your code was not run. Retry shortly.');
    this.name = 'ExecutionBusyError'; this.code = 'execution_busy'; this.reason = reason;
    this.retryAfter = Math.max(1, Math.min(86400, Math.ceil(retryAfter)));
    this.status = reason === 'quota' ? 429 : 503;
    if (quotaWindow) { this.quotaWindow = quotaWindow; this.resetAt = resetAt; }
  }
}
export function sendExecutionBusy(res, error) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Retry-After', String(error.retryAfter));
  return res.status(error.status).json({ ok: false, code: error.code,
    error: error.reason === 'quota' ? 'Execution quota reached — retry after the limit resets; your code was not run.' : error.message,
    reason: error.reason, retry_after: error.retryAfter,
    ...(error.quotaWindow ? { quota_window: error.quotaWindow, reset_at: error.resetAt } : {}) });
}
export function executionQueueConfiguration(env = process.env) {
  if (!executionQueueEnabled(env)) return null;
  const secret = env.JWT_SECRET;
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new ExecutionBusyError('configuration');
  const rawValues = {
    GLOBAL_CONCURRENCY: env.EXECUTION_GLOBAL_CONCURRENCY, CIRCLE_CONCURRENCY: env.EXECUTION_CIRCLE_CONCURRENCY,
    INTERVIEW_SHARE: env.EXECUTION_INTERVIEW_SHARE, ACCOUNT_PER_MINUTE: env.EXECUTION_ACCOUNT_PER_MINUTE,
    CIRCLE_PER_MINUTE: env.EXECUTION_CIRCLE_PER_MINUTE, GLOBAL_PER_MINUTE: env.EXECUTION_GLOBAL_PER_MINUTE,
    GLOBAL_PER_DAY: env.EXECUTION_GLOBAL_PER_DAY, QUEUE_LIMIT: env.EXECUTION_QUEUE_LIMIT,
    MAX_WAIT_SECONDS: env.EXECUTION_MAX_WAIT_SECONDS,
  };
  const values = {};
  for (const [key, [fallback, min, max]] of Object.entries(CONFIG)) {
    const raw = rawValues[key];
    const value = raw === undefined || raw === '' ? fallback : typeof raw === 'string' && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ExecutionBusyError('configuration');
    values[key] = value;
  }
  if (values.CIRCLE_CONCURRENCY > values.GLOBAL_CONCURRENCY || values.INTERVIEW_SHARE >= values.GLOBAL_CONCURRENCY
    || env.EXECUTION_STDIN_ENABLED === 'true' && (values.GLOBAL_CONCURRENCY < 4 || values.CIRCLE_CONCURRENCY < 2 || values.INTERVIEW_SHARE > values.GLOBAL_CONCURRENCY - 2)) throw new ExecutionBusyError('configuration');
  // Validate BOTH snapshots before taking any quota/lease, even a cold trial.
  for (const snapshot of [env.EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID, env.EXECUTION_WARM_PYTHON_SNAPSHOT_ID]) {
    if (snapshot !== undefined && snapshot !== '' && (typeof snapshot !== 'string' || !/^snap_[A-Za-z0-9_-]{1,128}$/.test(snapshot))) throw new ExecutionBusyError('configuration');
  }
  return Object.freeze({ ...values, secret });
}
export async function executionQueueReadiness(db, env = process.env) {
  if (!executionQueueEnabled(env)) return { ready: true };
  try {
    executionQueueConfiguration(env);
    const rows = (await db.execute('SELECT id FROM circles WHERE is_primary=1 AND archived_at IS NULL LIMIT 2')).rows;
    return rows.length === 1 ? { ready: true } : { ready: false, reason: 'primary_circle' };
  } catch (error) { return { ready: false, reason: error instanceof ExecutionBusyError ? 'configuration' : 'store' }; }
}
function digest(config, dimension, value) {
  return createHmac('sha256', config.secret).update(`randori-execution-queue-v1\0${dimension}\0${value}`).digest('hex');
}
function identity(config, context) {
  if (!context || (!Number.isSafeInteger(context.userId) || context.userId < 1) && context.ops !== true
    || (!Number.isSafeInteger(context.circleId) || context.circleId < 1) && context.ops !== true
    || typeof context.operation !== 'string' || !context.operation) throw new ExecutionBusyError('configuration');
  const lane = ['smoke-javascript','smoke-python','smoke-typescript'].includes(context.lane) ? context.lane : 'maintenance';
  return { account: digest(config, 'account', context.ops ? `ops:${lane}` : context.userId),
    circle: digest(config, 'circle', context.ops ? 'ops' : context.circleId),
    operation: digest(config, 'operation', context.operation), priority: context.interview === true ? 'i' : 'p' };
}
function parseState(row) {
  const match = /^eq1:([qol]):([a-f0-9]{64}):([a-f0-9]{64}):([ip]):([12]):([a-f0-9]{64})$/.exec(row.key);
  const arrival = Number(row.attempts), expires = Number(row.expires_at);
  if (!match || !Number.isSafeInteger(arrival) || arrival < 1 || !Number.isSafeInteger(expires)) throw new ExecutionBusyError('state');
  return { key: row.key, type: match[1], circle: match[2], account: match[3], priority: match[4], units: Number(match[5]), operation: match[6], arrival, expires };
}
/** One ordered policy choice. Occupied includes live leases AND offered units. */
export function selectExecutionTicket(tickets, occupied, turns, sequence, config) {
  const active = occupied.reduce((sum, item) => sum + item.units, 0);
  const eligible = tickets.filter(ticket => !occupied.some(lease => lease.account === ticket.account)
    && active + ticket.units <= config.GLOBAL_CONCURRENCY
    && occupied.filter(lease => lease.circle === ticket.circle).reduce((sum, item) => sum + item.units, 0) + ticket.units <= config.CIRCLE_CONCURRENCY);
  const interviews = tickets.some(item => item.priority === 'i'), practice = tickets.some(item => item.priority === 'p');
  const practiceReservation = Math.max(1, ...tickets.filter(item => item.priority === 'p').map(item => item.units));
  const interviewReservation = Math.min(config.INTERVIEW_SHARE, config.GLOBAL_CONCURRENCY - practiceReservation);
  const filtered = eligible.filter(ticket => {
    const classActive = occupied.filter(lease => lease.priority === ticket.priority).reduce((sum, item) => sum + item.units, 0);
    if (ticket.priority === 'p' && interviews) return classActive + ticket.units <= config.GLOBAL_CONCURRENCY - interviewReservation;
    if (ticket.priority === 'i' && practice) return classActive + ticket.units <= config.GLOBAL_CONCURRENCY - practiceReservation;
    return true;
  });
  const preferred = sequence % 3 === 2 ? 'p' : 'i', preferredTickets = filtered.filter(item => item.priority === preferred);
  return (preferredTickets.length ? preferredTickets : filtered).sort((a, b) => (turns[a.circle] || 0) - (turns[b.circle] || 0)
    || a.arrival - b.arrival || a.key.localeCompare(b.key))[0] || null;
}
/** Fill every eligible slot, not just one head. Advance I,I,P on SELECTION.
 * Absent clients reserve only a three-second offer; they cannot freeze turns.
 */
export function selectExecutionFill(tickets, occupied, turns, sequence, config) {
  const pending = [...tickets], allocated = [...occupied], selected = [], nextTurns = { ...turns };
  let nextSequence = sequence;
  while (selected.length < config.GLOBAL_CONCURRENCY) {
    const ticket = selectExecutionTicket(pending, allocated, nextTurns, nextSequence, config);
    if (!ticket) break;
    selected.push(ticket); allocated.push(ticket); pending.splice(pending.indexOf(ticket), 1);
    nextTurns[ticket.circle] = ++nextSequence;
  }
  return { selected, turns: nextTurns, sequence: nextSequence };
}
function retryableConflict(error) {
  let current = error;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    if ([current.code, current.rawCode].some(code => ['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(String(code).toUpperCase()))) return true;
    if (/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message || '')) || /^database is busy$/i.test(String(current.message || ''))) return true;
  }
  return false;
}
async function batch(db, statements) {
  if (typeof db.batch === 'function') return db.batch(statements);
  const results = []; for (const statement of statements) results.push(await db.execute(statement)); return results;
}
function upsertRows(rows) {
  return { sql: `INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES ${rows.map(() => '(?,?,?)').join(',')}
    ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at`, args: rows.flat() };
}
function refusalEvent(reason) {
  return ['configuration','configuration_changed','primary_circle','state','request_cost'].includes(reason) ? 'configuration' : reason === 'store' ? 'store' : reason === 'quota' ? 'quota' : 'shed';
}
// Never hold the admission write lock for telemetry. One bounded best-effort
// insert per invocation, no retry on unknown outcome, and no exact-count claim.
async function metrics(db, events) {
  if (!events.length || !db || typeof db.execute !== 'function') return;
  let timer;
  const statement = { sql: `INSERT INTO app_logs(level,source,event,message,meta_json,user_id,route,ua,ip,created_at)
    VALUES ${events.map(() => "('info','runner','execution_queue_metric',?,?,NULL,NULL,NULL,NULL,datetime('now'))").join(',')}`,
  args: events.flatMap(({ outcome, waitMs = null, providerMs = null, units = 0 }) => [outcome, JSON.stringify({ waitMs, providerMs, units })]) };
  try { await Promise.race([Promise.resolve().then(() => db.execute(statement)), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); } catch {}
  finally { clearTimeout(timer); }
}
export async function recordExecutionRefusal(db, reason) { await metrics(db, [{ outcome: refusalEvent(reason) }]); }

async function admissionTransaction(tx, who, config, units) {
  // Two batched reads, one control read, one write batch: no per-ticket RTTs.
  const [clockResult, stateResult] = await batch(tx, [
    `SELECT ${DB_SECONDS} AS seconds,${DB_MILLIS} AS millis`,
    { sql: `SELECT key,attempts,expires_at FROM auth_rate_limits WHERE key GLOB 'eq1:[qol]:*' ORDER BY key LIMIT ?`, args: [STATE_LIMIT] },
  ]);
  const now = Number(clockResult.rows[0]?.seconds), millis = Number(clockResult.rows[0]?.millis);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(millis)) throw new ExecutionBusyError('state');
  const state = stateResult.rows.map(parseState), expired = state.filter(item => item.expires <= now);
  const live = state.filter(item => item.expires > now), leases = live.filter(item => item.type === 'l');
  const pending = live.filter(item => item.type !== 'l'), offers = pending.filter(item => item.type === 'o');
  const minute = Math.floor(now / 60), day = Math.floor(now / 86400);
  const quotas = [
    [`${PREFIX}r:a:${who.account}:${minute}`, config.ACCOUNT_PER_MINUTE, (minute + 1) * 60, 'minute'],
    [`${PREFIX}r:c:${who.circle}:${minute}`, config.CIRCLE_PER_MINUTE, (minute + 1) * 60, 'minute'],
    [`${PREFIX}r:g:${minute}`, config.GLOBAL_PER_MINUTE, (minute + 1) * 60, 'minute'],
    [`${PREFIX}r:d:${day}`, config.GLOBAL_PER_DAY, (day + 1) * 86400, 'day'],
  ];
  const lookupKeys = [...quotas.map(item => item[0]), `${PREFIX}s`, `${PREFIX}policy`, ...new Set([...pending.map(item => item.circle), who.circle].map(circle => `${PREFIX}t:${circle}`))];
  const controls = (await tx.execute({ sql: `SELECT key,attempts FROM auth_rate_limits WHERE key IN (${lookupKeys.map(() => '?').join(',')}) AND expires_at>?`, args: [...lookupKeys, now] })).rows;
  const values = {};
  for (const row of controls) { const value = Number(row.attempts); if (!Number.isSafeInteger(value) || value < 0) throw new ExecutionBusyError('state'); values[row.key] = value; }
  const policy = Number.parseInt(digest(config, 'policy', JSON.stringify(['offers-v2', ...Object.keys(CONFIG).map(key => config[key])])).slice(0, 12), 16);
  if (values[`${PREFIX}policy`] !== undefined && values[`${PREFIX}policy`] !== policy && live.length) throw new ExecutionBusyError('configuration_changed');
  const qKey = `${PREFIX}q:${who.circle}:${who.account}:${who.priority}:${units}:${who.operation}`;
  const existing = pending.find(item => item.account === who.account);
  let error = null, lease = null;
  const remove = expired.map(item => item.key), rows = [[`${PREFIX}policy`, policy, now + EXECUTION_LEASE_SECONDS + config.MAX_WAIT_SECONDS]];
  const events = expired.filter(item => item.type !== 'l').map(item => ({ outcome: 'shed', waitMs: Math.min(600000, Math.max(0, millis - item.arrival)) }));
  if (state.length >= STATE_LIMIT) error = new ExecutionBusyError('capacity');
  else if (expired.some(item => item.type !== 'l' && item.account === who.account)) error = new ExecutionBusyError('queue_expired');
  else if (leases.some(item => item.account === who.account)) error = new ExecutionBusyError('already_running');
  else if (existing && existing.key.replace('eq1:o:', 'eq1:q:') !== qKey) error = new ExecutionBusyError('pending_run');
  else if (!existing && pending.length >= config.QUEUE_LIMIT) error = new ExecutionBusyError('queue_full');
  else {
    const exhausted = quotas.find(([key, limit]) => (values[key] || 0) + units > limit);
    if (exhausted) {
      const [, , expires, quotaWindow] = exhausted;
      error = new ExecutionBusyError('quota', expires - now, { quotaWindow, resetAt: new Date(expires * 1000).toISOString() });
      if (existing) { remove.push(existing.key); pending.splice(pending.indexOf(existing), 1); }
    } else {
      const ticket = existing || { ...who, type: 'q', key: qKey, units, arrival: millis, expires: now + config.MAX_WAIT_SECONDS };
      if (!existing) pending.push(ticket);
      const turns = {};
      for (const key of lookupKeys) if (key.startsWith(`${PREFIX}t:`)) turns[key.slice(`${PREFIX}t:`.length)] = values[key] || 0;
      const fill = selectExecutionFill(pending.filter(item => item.type === 'q'), [...leases, ...offers], turns, values[`${PREFIX}s`] || 0, config);
      const ownSelected = ticket.type === 'o' || fill.selected.some(item => item.key === ticket.key);
      for (const selected of fill.selected) {
        remove.push(selected.key);
        if (selected.account !== who.account) rows.push([selected.key.replace('eq1:q:', 'eq1:o:'), selected.arrival, Math.min(selected.expires, now + EXECUTION_OFFER_SECONDS)]);
      }
      if (fill.selected.length) {
        rows.push([`${PREFIX}s`, fill.sequence, now + 900]);
        for (const circle of new Set(fill.selected.map(item => item.circle))) rows.push([`${PREFIX}t:${circle}`, fill.turns[circle], now + 900]);
      }
      if (ownSelected) {
        remove.push(ticket.key);
        lease = { key: `${PREFIX}l:${who.circle}:${who.account}:${who.priority}:${units}:${randomBytes(32).toString('hex')}`, units, expires: now + EXECUTION_LEASE_SECONDS };
        rows.push([lease.key, millis, lease.expires]);
        for (const [key, , expires] of quotas) rows.push([key, (values[key] || 0) + units, expires]);
        events.push({ outcome: 'admitted', waitMs: Math.max(0, millis - ticket.arrival), units });
      } else {
        if (!existing && !fill.selected.some(item => item.key === ticket.key)) rows.push([ticket.key, millis, ticket.expires]);
        error = new ExecutionBusyError('queued');
      }
    }
  }
  const writes = [];
  if (remove.length) writes.push({ sql: `DELETE FROM auth_rate_limits WHERE key IN (${remove.map(() => '?').join(',')})`, args: remove });
  // All renames, offers, turns, quotas and lease are atomic, in one batch RTT.
  writes.push(upsertRows(rows));
  writes.push({ sql: `DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE key GLOB 'eq1:*' AND expires_at<=? LIMIT 64)`, args: [now] });
  await batch(tx, writes);
  if (error && !['queued','already_running','pending_run','queue_expired'].includes(error.reason)) events.push({ outcome: refusalEvent(error.reason) });
  return { lease, error, events };
}
export async function admitExecution(db, context, { env = process.env, units = 1, random = Math.random } = {}) {
  if (!executionQueueEnabled(env)) return null; // exact no-I/O legacy path
  let result;
  try {
    const config = executionQueueConfiguration(env);
    if (![1, 2].includes(units) || !db?.transaction) throw new ExecutionBusyError('configuration');
    if (units > config.CIRCLE_CONCURRENCY || units === 2 && config.GLOBAL_CONCURRENCY < 4) throw new ExecutionBusyError('request_cost', 60);
    const who = identity(config, context);
    for (let attempt = 0; attempt < EXECUTION_TRANSACTION_ATTEMPTS; attempt++) {
      let tx = null, commitStarted = false, rolledBack = false;
      try {
        tx = await db.transaction('write');
        const pending = await admissionTransaction(tx, who, config, units);
        commitStarted = true; await tx.commit(); result = pending; break;
      } catch (error) {
        // SQLite's native COMMIT can return BUSY while its transaction is
        // demonstrably still open. A confirmed rollback makes this retry safe.
        // Remote/lost COMMIT replies have no such proof and are never replayed.
        if(commitStarted&&db.protocol==='file'&&tx?.closed===false&&retryableConflict(error)){
          try{await tx.rollback();rolledBack=true;commitStarted=false;}catch{}
        }
        if (tx && !commitStarted && !rolledBack) { try { await tx.rollback(); rolledBack = true; } catch {} }
        // Never retry a commit with unknown outcome, even a busy response.
        if (commitStarted || tx && !rolledBack || attempt === EXECUTION_TRANSACTION_ATTEMPTS - 1 || !retryableConflict(error)) throw error;
      } finally { try { await tx?.close?.(); } catch {} }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, 30 * (2 ** attempt) + Math.floor(random() * 20))));
    }
  } catch (error) {
    const failure = error instanceof ExecutionBusyError ? error : new ExecutionBusyError('store');
    await recordExecutionRefusal(db, failure.reason); throw failure;
  }
  await metrics(db, result.events);
  if (result.error) throw result.error;
  return result.lease;
}
export async function checkExecutionLease(db, lease) {
  let result;
  try { result = await db.execute({ sql: `SELECT 1 FROM auth_rate_limits WHERE key=? AND expires_at>${DB_SECONDS}+80`, args: [lease.key] }); }
  catch { await recordExecutionRefusal(db, 'store'); throw new ExecutionBusyError('store'); }
  if (result.rows.length !== 1) throw new ExecutionBusyError('lease_expired');
}
export async function finishExecution(db, lease, { safeToRelease = false, providerMs = null } = {}) {
  if (!lease) return;
  if (safeToRelease) {
    // Generation-keyed DELETE is idempotent: retry known lock conflicts even
    // if an earlier acknowledgement was lost, unlike admission/quotas.
    for(let attempt=0;attempt<EXECUTION_TRANSACTION_ATTEMPTS;attempt++){
      try{await db.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[lease.key]});break;}
      catch(error){
        if(attempt===EXECUTION_TRANSACTION_ATTEMPTS-1||!retryableConflict(error)){await recordExecutionRefusal(db,'store');break;}
        await new Promise(resolve=>setTimeout(resolve,30*(2**attempt)+Math.floor(Math.random()*20)));
      }
    }
  }
  await metrics(db, [{ outcome: 'finished', providerMs, units: lease.units }]);
}
export function executionPercentiles(values) {
  const sorted = values.filter(value => Number.isSafeInteger(value) && value >= 0 && value <= 600000).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}
export async function readExecutionQueueHealth(db, { env = process.env } = {}) {
  if (!executionQueueEnabled(env)) return { enabled: false };
  const readiness = await executionQueueReadiness(db, env);
  let config;
  try { config = executionQueueConfiguration(env); } catch { config = null; }
  const depth = (await db.execute(`SELECT
    SUM(CASE WHEN key GLOB 'eq1:[qo]:*' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN key GLOB 'eq1:o:*' THEN CAST(substr(key,139,1) AS INTEGER) ELSE 0 END) AS offered,
    SUM(CASE WHEN key GLOB 'eq1:l:*' THEN CAST(substr(key,139,1) AS INTEGER) ELSE 0 END) AS active
    FROM auth_rate_limits WHERE key GLOB 'eq1:[qol]:*' AND expires_at>${DB_SECONDS}`)).rows[0];
  const usage = (await db.execute(`SELECT COALESCE((SELECT attempts FROM auth_rate_limits WHERE key='eq1:r:g:'||(${DB_SECONDS}/60)),0) AS minute_units,
    COALESCE((SELECT attempts FROM auth_rate_limits WHERE key='eq1:r:d:'||(${DB_SECONDS}/86400)),0) AS day_units`)).rows[0];
  const counts = (await db.execute(`SELECT message,COUNT(*) AS n FROM app_logs WHERE source='runner' AND user_id IS NULL AND event='execution_queue_metric'
    AND created_at>=datetime('now','-15 minutes') GROUP BY message`)).rows;
  const recent = { admitted: 0, shed: 0, quota: 0, finished: 0, store: 0, configuration: 0 };
  for (const row of counts) if (Object.hasOwn(recent, row.message)) recent[row.message] = Number(row.n);
  const rows = (await db.execute(`SELECT message,meta_json FROM app_logs WHERE source='runner' AND user_id IS NULL AND event='execution_queue_metric'
    AND message IN ('admitted','shed','finished') AND created_at>=datetime('now','-15 minutes') ORDER BY id DESC LIMIT 4097`)).rows;
  const waits = [], latencies = [];
  for (const row of rows.slice(0, 4096)) {
    let meta; try { meta = JSON.parse(row.meta_json); } catch { continue; }
    if (row.message === 'finished') latencies.push(meta?.providerMs); else if (meta?.waitMs !== null) waits.push(meta?.waitMs);
  }
  return { enabled: true, ...readiness, healthy: readiness.ready && !recent.store && !recent.configuration,
    windowSeconds: EXECUTION_METRIC_WINDOW_SECONDS, queueDepth: Number(depth.queued || 0), offeredUnits: Number(depth.offered || 0), activeUnits: Number(depth.active || 0), recent,
    countsBestEffort: true, waitMs: executionPercentiles(waits), providerMs: executionPercentiles(latencies), samplesTruncated: rows.length > 4096,
    spend: config ? { globalConcurrency: config.GLOBAL_CONCURRENCY, circleConcurrency: config.CIRCLE_CONCURRENCY, globalPerMinute: config.GLOBAL_PER_MINUTE,
      globalPerDay: config.GLOBAL_PER_DAY, interviewShare: config.INTERVIEW_SHARE, usedMinuteUnits: Number(usage.minute_units), usedDayUnits: Number(usage.day_units) } : null };
}
