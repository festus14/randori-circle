// #468 / ID-103. Durable, bounded retry queue over existing v1 TTL storage.
// No code, stdin, raw account/circle ids or provider messages are stored here.
// Every admission is serialized by a libSQL write transaction, including quotas
// and the lease. A busy response never starts work in the background.
import { createHmac, randomBytes } from 'node:crypto';

export const EXECUTION_LEASE_SECONDS = 90; // create 20s + VM 60s + safety margin
export const EXECUTION_METRIC_WINDOW_SECONDS = 900;
const PREFIX = 'eq1:';
const DB_SECONDS = "CAST(strftime('%s','now') AS INTEGER)";
const DB_MILLIS = "CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)";
const STATE_LIMIT = 145; // max 128 waiting + max 16 active + overflow sentinel
const CONFIG = Object.freeze({
  GLOBAL_CONCURRENCY: [4, 2, 16], CIRCLE_CONCURRENCY: [2, 1, 8],
  INTERVIEW_SHARE: [2, 1, 15], ACCOUNT_PER_MINUTE: [10, 1, 30],
  CIRCLE_PER_MINUTE: [40, 1, 120], GLOBAL_PER_MINUTE: [60, 1, 240],
  GLOBAL_PER_DAY: [150, 1, 10000], QUEUE_LIMIT: [32, 1, 128],
  MAX_WAIT_SECONDS: [15, 2, 20],
});

export function executionQueueEnabled(env = process.env) { return env.EXECUTION_QUEUE_ENABLED === 'true'; }

export class ExecutionBusyError extends Error {
  constructor(reason = 'capacity', retryAfter = 2) {
    super('Execution is busy; your code was not run. Retry shortly.');
    this.name = 'ExecutionBusyError';
    this.code = 'execution_busy';
    this.reason = reason;
    this.retryAfter = Math.max(1, Math.min(86400, Math.ceil(retryAfter)));
    this.status = reason === 'quota' ? 429 : 503;
  }
}

export function sendExecutionBusy(res, error) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(error.retryAfter));
  return res.status(error.status).json({ ok: false, code: error.code,
    error: error.reason === 'quota' ? 'Execution quota reached — retry after the limit resets; your code was not run.' : error.message,
    reason: error.reason, retry_after: error.retryAfter });
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
    || env.EXECUTION_STDIN_ENABLED === 'true' && (values.GLOBAL_CONCURRENCY < 4 || values.CIRCLE_CONCURRENCY < 2 || values.INTERVIEW_SHARE > values.GLOBAL_CONCURRENCY - 2)) {
    throw new ExecutionBusyError('configuration');
  }
  return Object.freeze({ ...values, secret });
}

function digest(config, dimension, value) {
  return createHmac('sha256', config.secret).update(`randori-execution-queue-v1\0${dimension}\0${value}`).digest('hex');
}
function identity(config, context) {
  if (!context || (!Number.isSafeInteger(context.userId) || context.userId < 1) && context.ops !== true
    || (!Number.isSafeInteger(context.circleId) || context.circleId < 1) && context.ops !== true
    || typeof context.operation !== 'string' || !context.operation) throw new ExecutionBusyError('configuration');
  const lane = ['smoke-javascript','smoke-python'].includes(context.lane) ? context.lane : 'maintenance';
  return { account: digest(config, 'account', context.ops ? `ops:${lane}` : context.userId),
    circle: digest(config, 'circle', context.ops ? 'ops' : context.circleId),
    operation: digest(config, 'operation', context.operation), priority: context.interview === true ? 'i' : 'p' };
}

function parseState(row) {
  const match = /^eq1:([ql]):([a-f0-9]{64}):([a-f0-9]{64}):([ip]):([12]):([a-f0-9]{64})$/.exec(row.key);
  const arrival = Number(row.attempts), expires = Number(row.expires_at);
  if (!match || !Number.isSafeInteger(arrival) || arrival < 1 || !Number.isSafeInteger(expires)) throw new ExecutionBusyError('state');
  return { key: row.key, type: match[1], circle: match[2], account: match[3], priority: match[4], units: Number(match[5]),
    operation: match[6], arrival, expires };
}

/** Pure policy: I,I,P weighted turns; least-recently served circle then FIFO.
 * Reserve interview capacity while interviews wait, and at least one practice
 * unit while practice waits. Idle shares are borrowable; no active run is killed.
 */
export function selectExecutionTicket(tickets, leases, turns, sequence, config) {
  const active = leases.reduce((sum, item) => sum + item.units, 0);
  const eligible = tickets.filter(ticket => !leases.some(lease => lease.account === ticket.account)
    && active + ticket.units <= config.GLOBAL_CONCURRENCY
    && leases.filter(lease => lease.circle === ticket.circle).reduce((sum, item) => sum + item.units, 0) + ticket.units <= config.CIRCLE_CONCURRENCY);
  const interviews = tickets.some(item => item.priority === 'i');
  const practice = tickets.some(item => item.priority === 'p');
  const practiceReservation = Math.max(1, ...tickets.filter(item => item.priority === 'p').map(item => item.units));
  const interviewReservation = Math.min(config.INTERVIEW_SHARE, config.GLOBAL_CONCURRENCY - practiceReservation);
  const filtered = eligible.filter(ticket => {
    const classActive = leases.filter(lease => lease.priority === ticket.priority).reduce((sum, item) => sum + item.units, 0);
    if (ticket.priority === 'p' && interviews) return classActive + ticket.units <= config.GLOBAL_CONCURRENCY - interviewReservation;
    if (ticket.priority === 'i' && practice) return classActive + ticket.units <= config.GLOBAL_CONCURRENCY - practiceReservation;
    return true;
  });
  const preferred = sequence % 3 === 2 ? 'p' : 'i';
  const preferredTickets = filtered.filter(item => item.priority === preferred);
  const candidates = preferredTickets.length ? preferredTickets : filtered;
  return candidates.sort((a, b) => (turns[a.circle] || 0) - (turns[b.circle] || 0)
    || a.arrival - b.arrival || a.key.localeCompare(b.key))[0] || null;
}

async function metric(db, outcome, { waitMs = null, providerMs = null, units = 0 } = {}) {
  await db.execute({ sql: `INSERT INTO app_logs(level,source,event,message,meta_json,user_id,route,ua,ip,created_at)
    VALUES('info','runner','execution_queue_metric',?,?,NULL,NULL,NULL,NULL,datetime('now'))`,
  args: [outcome, JSON.stringify({ waitMs, providerMs, units })] });
}
async function put(db, key, value, expires) {
  await db.execute({ sql: `INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at`, args: [key, value, expires] });
}

export async function admitExecution(db, context, { env = process.env, units = 1 } = {}) {
  const config = executionQueueConfiguration(env);
  if (!config) return null; // exact pre-flag path, not even a database read
  if (![1, 2].includes(units) || !db?.transaction) throw new ExecutionBusyError('configuration');
  if(units > config.CIRCLE_CONCURRENCY || units === 2 && config.GLOBAL_CONCURRENCY < 4) throw new ExecutionBusyError('request_cost',60);
  const who = identity(config, context);
  let tx;
  try { tx = await db.transaction('write'); } catch { throw new ExecutionBusyError('store'); }
  let result;
  try {
    const clock = (await tx.execute(`SELECT ${DB_SECONDS} AS seconds,${DB_MILLIS} AS millis`)).rows[0];
    const now = Number(clock.seconds), millis = Number(clock.millis);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(millis)) throw new ExecutionBusyError('state');
    // Read expired tickets too so their wait can be measured and this caller
    // receives a terminal shed rather than silently renewing its queue deadline.
    const rows = (await tx.execute({ sql: `SELECT key,attempts,expires_at FROM auth_rate_limits
      WHERE key GLOB 'eq1:[ql]:*' ORDER BY key LIMIT ?`, args: [STATE_LIMIT] })).rows;
    // Expired rows cannot permanently fill the bounded state read.
    await tx.execute({ sql: `DELETE FROM auth_rate_limits WHERE key IN
      (SELECT key FROM auth_rate_limits WHERE key GLOB 'eq1:[ql]:*' AND expires_at<=? LIMIT ?)`, args: [now, STATE_LIMIT] });
    const state = rows.map(parseState);
    const expired = state.filter(item => item.type === 'q' && item.expires <= now);
    for (const item of expired) await metric(tx, 'shed', { waitMs: Math.max(0, millis - item.arrival) });
    const tickets = state.filter(item => item.type === 'q' && item.expires > now);
    const leases = state.filter(item => item.type === 'l' && item.expires > now);
    // A rolling deployment with different limits/keys must drain first. Otherwise
    // two instances could each admit against a different account/circle policy.
    const policy = Number.parseInt(digest(config, 'policy', JSON.stringify(Object.keys(CONFIG).map(key => config[key]))).slice(0, 12), 16);
    const previousPolicy = (await tx.execute({ sql: 'SELECT attempts FROM auth_rate_limits WHERE key=? AND expires_at>?', args: [`${PREFIX}policy`, now] })).rows[0];
    if (previousPolicy && Number(previousPolicy.attempts) !== policy && (tickets.length || leases.length)) throw new ExecutionBusyError('configuration_changed');
    // Old configs are fenced until their last possible
    // lease expires, including time spent in this bounded admission transaction.
    await put(tx, `${PREFIX}policy`, policy, now + EXECUTION_LEASE_SECONDS + config.MAX_WAIT_SECONDS);
    const refuse = async (reason, retry = 2, record = true) => {
      if (record) await metric(tx, reason === 'quota' ? 'quota' : 'shed');
      return { error: new ExecutionBusyError(reason, retry) };
    };
    const ownExpired = expired.some(item => item.account === who.account);
    if (rows.length >= STATE_LIMIT) result = await refuse('capacity');
    else if (ownExpired) result = await refuse('queue_expired', 2, false);
    else if (leases.some(item => item.account === who.account)) result = await refuse('already_running', 2, false);
    else {
      const existing = tickets.find(item => item.account === who.account);
      const key = `${PREFIX}q:${who.circle}:${who.account}:${who.priority}:${units}:${who.operation}`;
      // Another operation/tab cannot consume or mutate a pending ticket.
      if (existing && existing.key !== key) result = await refuse('pending_run', 2, false);
      else if (!existing && tickets.length >= config.QUEUE_LIMIT) result = await refuse('queue_full');
      else {
        const minute = Math.floor(now / 60), day = Math.floor(now / 86400);
        const quotaKeys = [
          [`${PREFIX}r:a:${who.account}:${minute}`, config.ACCOUNT_PER_MINUTE, (minute + 1) * 60],
          [`${PREFIX}r:c:${who.circle}:${minute}`, config.CIRCLE_PER_MINUTE, (minute + 1) * 60],
          [`${PREFIX}r:g:${minute}`, config.GLOBAL_PER_MINUTE, (minute + 1) * 60],
          [`${PREFIX}r:d:${day}`, config.GLOBAL_PER_DAY, (day + 1) * 86400],
        ];
        const counters = [];
        for (const [quotaKey, limit, expires] of quotaKeys) {
          const row = (await tx.execute({ sql: 'SELECT attempts FROM auth_rate_limits WHERE key=?', args: [quotaKey] })).rows[0];
          const value = Number(row?.attempts || 0);
          if (!Number.isSafeInteger(value) || value < 0) throw new ExecutionBusyError('state');
          counters.push([quotaKey, value, expires]);
          if (value + units > limit) {
            if (existing) await tx.execute({ sql: 'DELETE FROM auth_rate_limits WHERE key=?', args: [existing.key] });
            result = await refuse('quota', expires - now);
            break;
          }
        }
        if (!result) {
          const ticket = existing || { ...who, key, units, arrival: millis, expires: now + config.MAX_WAIT_SECONDS };
          if (!existing) { await put(tx, key, millis, ticket.expires); tickets.push(ticket); }
          const turns = {};
          const turnKeys = [...new Set(tickets.map(item => `${PREFIX}t:${item.circle}`)), `${PREFIX}s`];
          const turnRows = (await tx.execute({ sql: `SELECT key,attempts FROM auth_rate_limits WHERE key IN
            (${turnKeys.map(() => '?').join(',')}) AND expires_at>?`, args: [...turnKeys, now] })).rows;
          let sequence = 0;
          for(const row of turnRows){
            const value=Number(row.attempts);
            if(!Number.isSafeInteger(value)||value<0)throw new ExecutionBusyError('state');
            if(row.key===`${PREFIX}s`)sequence=value;
            else turns[row.key.slice(`${PREFIX}t:`.length)]=value;
          }
          const winner = selectExecutionTicket(tickets, leases, turns, sequence, config);
          if (winner?.key === key) {
            const leaseKey = `${PREFIX}l:${who.circle}:${who.account}:${who.priority}:${units}:${randomBytes(32).toString('hex')}`;
            // Check the DB clock again at the spend boundary, after all reads.
            const current = Number((await tx.execute(`SELECT ${DB_SECONDS} AS seconds`)).rows[0].seconds);
            if (current >= ticket.expires) {
              await tx.execute({ sql: 'DELETE FROM auth_rate_limits WHERE key=?', args: [key] });
              result = await refuse('queue_expired');
            } else {
              await put(tx, leaseKey, millis, current + EXECUTION_LEASE_SECONDS);
              await tx.execute({ sql: 'DELETE FROM auth_rate_limits WHERE key=?', args: [key] });
              await put(tx, `${PREFIX}s`, sequence + 1, current + 900);
              await put(tx, `${PREFIX}t:${who.circle}`, sequence + 1, current + 900);
              for (const [quotaKey, value, expires] of counters) await put(tx, quotaKey, value + units, expires);
              await metric(tx, 'admitted', { waitMs: Math.max(0, millis - ticket.arrival), units });
              result = { key: leaseKey, units, expires: current + EXECUTION_LEASE_SECONDS };
            }
          } else result = { error: new ExecutionBusyError('queued') };
        }
      }
    }
    await tx.execute({ sql: `DELETE FROM auth_rate_limits WHERE key IN
      (SELECT key FROM auth_rate_limits WHERE (key GLOB 'eq1:r:*' OR key GLOB 'eq1:t:*' OR key='eq1:s' OR key='eq1:policy')
        AND expires_at<=? LIMIT 64)`, args: [now] });
    await tx.commit();
  } catch (error) {
    try { await tx.rollback(); } catch {}
    // Ambiguous commit => no provider call. The possible lease expires safely.
    throw error instanceof ExecutionBusyError ? error : new ExecutionBusyError('store');
  } finally { await tx.close?.(); }
  if (result.error) throw result.error;
  return result;
}

export async function checkExecutionLease(db, lease) {
  const result = await db.execute({ sql: `SELECT 1 FROM auth_rate_limits WHERE key=? AND expires_at>${DB_SECONDS}+80`, args: [lease.key] });
  if (result.rows.length !== 1) throw new ExecutionBusyError('lease_expired');
}

export async function finishExecution(db, lease, { safeToRelease = false, providerMs = null } = {}) {
  if (!lease) return;
  // On crash, ambiguous creation/cleanup or Piston disconnect, hold the spend
  // slots until their backstop. Never release a possibly-running remote process.
  if (safeToRelease) await db.execute({ sql: 'DELETE FROM auth_rate_limits WHERE key=?', args: [lease.key] });
  await metric(db, 'finished', { providerMs, units: lease.units });
}

export function executionPercentiles(values) {
  const sorted = values.filter(value => Number.isSafeInteger(value) && value >= 0 && value <= 600000).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

export async function readExecutionQueueHealth(db, { env = process.env } = {}) {
  if (!executionQueueEnabled(env)) return { enabled: false };
  let config;
  try { config = executionQueueConfiguration(env); } catch { return { enabled: true, ready: false, reason: 'configuration' }; }
  const depth = (await db.execute(`SELECT
    SUM(CASE WHEN key GLOB 'eq1:q:*' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN key GLOB 'eq1:l:*' THEN CAST(substr(key,139,1) AS INTEGER) ELSE 0 END) AS active
    FROM auth_rate_limits WHERE key GLOB 'eq1:[ql]:*' AND expires_at>${DB_SECONDS}`)).rows[0];
  const usage = (await db.execute(`SELECT
    COALESCE((SELECT attempts FROM auth_rate_limits WHERE key='eq1:r:g:'||(${DB_SECONDS}/60)),0) AS minute_units,
    COALESCE((SELECT attempts FROM auth_rate_limits WHERE key='eq1:r:d:'||(${DB_SECONDS}/86400)),0) AS day_units`)).rows[0];
  const counts = (await db.execute(`SELECT message,COUNT(*) AS n FROM app_logs
    WHERE source='runner' AND user_id IS NULL AND event='execution_queue_metric'
      AND created_at>=datetime('now','-15 minutes') GROUP BY message`)).rows;
  const recent = { admitted: 0, shed: 0, quota: 0, finished: 0 };
  for (const row of counts) if (Object.hasOwn(recent, row.message)) recent[row.message] = Number(row.n);
  const rows = (await db.execute(`SELECT message,meta_json FROM app_logs
    WHERE source='runner' AND user_id IS NULL AND event='execution_queue_metric'
      AND message IN ('admitted','shed','finished') AND created_at>=datetime('now','-15 minutes')
    ORDER BY id DESC LIMIT 4097`)).rows;
  const waits = [], latencies = [];
  for (const row of rows.slice(0, 4096)) {
    let meta; try { meta = JSON.parse(row.meta_json); } catch { continue; }
    if (row.message === 'finished') latencies.push(meta?.providerMs);
    else if (meta?.waitMs !== null) waits.push(meta?.waitMs);
  }
  return { enabled: true, ready: true, windowSeconds: EXECUTION_METRIC_WINDOW_SECONDS,
    queueDepth: Number(depth.queued || 0), activeUnits: Number(depth.active || 0), recent,
    waitMs: executionPercentiles(waits), providerMs: executionPercentiles(latencies), samplesTruncated: rows.length > 4096,
    spend: { globalConcurrency: config.GLOBAL_CONCURRENCY, circleConcurrency: config.CIRCLE_CONCURRENCY,
      globalPerMinute: config.GLOBAL_PER_MINUTE, globalPerDay: config.GLOBAL_PER_DAY, interviewShare: config.INTERVIEW_SHARE,
      usedMinuteUnits: Number(usage.minute_units), usedDayUnits: Number(usage.day_units) } };
}
