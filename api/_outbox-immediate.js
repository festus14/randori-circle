import { randomUUID } from 'node:crypto';
import { getDeadline, waitUntil } from '@vercel/functions';
import { outboxStatementIdentity } from './_outbox-identity.js';
// Delivery modules are loaded lazily, after the response, so enqueue paths
// carry no import-time coupling to provider/template code.

// Issue #250: latency-sensitive mail (password reset, verification,
// invitation, schedule) is attempted right after its enqueue transaction
// commits instead of waiting for the next scheduled `/api/cron/outbox`
// run. The outbox row stays the durable source of truth; this is only an
// early, lease-guarded claim of that row. Anything not delivered here is left
// pending/retry for the scheduled worker.
export const OUTBOX_IMMEDIATE_BUDGET_MS=8_000;
const OUTBOX_IMMEDIATE_MAX_EVENTS=8;
// Leave headroom inside the platform invocation deadline for finalization.
const PLATFORM_DEADLINE_RESERVE_MS=2_000;

/**
 * Enabled on Vercel by default; `OUTBOX_IMMEDIATE_DELIVERY=false` is the
 * operator kill switch, `true` opts in elsewhere. The attempt itself is a
 * no-op for the local identity adapter, whose development capture is read
 * from the cron response.
 */
export function outboxImmediateDeliveryEnabled(){
  const setting=String(process.env.OUTBOX_IMMEDIATE_DELIVERY||'').trim().toLowerCase();
  if(setting==='false') return false;
  return setting==='true'||process.env.VERCEL==='1';
}

/** Collect event identities from statements built by createOutboxEventStatement. */
export function outboxEventsFromStatements(statements){
  return (statements||[]).map(outboxStatementIdentity).filter(Boolean);
}

function budgetDeadline(clockNow){
  let deadline=clockNow+OUTBOX_IMMEDIATE_BUDGET_MS;
  try{
    const platform=getDeadline();
    if(platform){
      const remaining=platform.getTime()-Date.now()-PLATFORM_DEADLINE_RESERVE_MS;
      deadline=Math.min(deadline,clockNow+Math.max(0,remaining));
    }
  }catch{}
  return deadline;
}

function afterResponseTick(){
  // Yield past the current macrotask so the caller's res.json()/res.end()
  // is written before any delivery I/O starts.
  return new Promise(resolve=>setImmediate(resolve));
}

async function attemptImmediateDelivery(req,events){
  await afterResponseTick();
  const deadlineAtMs=budgetDeadline(performance.now());
  const [{localIdentityAdapterEnabled},{configuredOutboxBaseUrl,outboxDeliveryPlan},
    {getClient},{deliverOutboxEventsNow}]=await Promise.all([
    import('./_local-runtime.js'),import('./_outbox-delivery.js'),
    import('./_db.js'),import('./_outbox.js'),
  ]);
  // Local development captures mail into the cron response; leave it there.
  if(localIdentityAdapterEnabled(req)) return null;
  const baseUrl=configuredOutboxBaseUrl();
  if(!baseUrl) return null;
  const db=getClient();
  const types=[...new Set(events.map(event=>event.eventType))];
  const plan=await outboxDeliveryPlan(db,baseUrl,req,{types});
  if(plan.local||!plan.handlers.size) return null;
  return deliverOutboxEventsNow({
    db,workerId:`inline-${randomUUID()}`,handlers:plan.handlers,events,deadlineAtMs,
  });
}

/**
 * Schedule a bounded delivery attempt for events that have already committed.
 * Must be called after the commit and immediately before (or after) the
 * response is sent. Never throws, never awaits, never alters the response.
 * Returns the background promise (resolves to the result or null) for tests.
 */
export function deliverCommittedOutboxEvents(req,events){
  try{
    const targets=(events||[]).filter(event=>event&&event.eventType&&event.idempotencyKey)
      .slice(0,OUTBOX_IMMEDIATE_MAX_EVENTS);
    if(!targets.length||!outboxImmediateDeliveryEnabled()) return Promise.resolve(null);
    const work=attemptImmediateDelivery(req,targets).catch(error=>{
      // The durable row remains pending/retry; the scheduled worker retries.
      try{
        console.warn('[outbox_immediate_fail]',JSON.stringify({
          types:[...new Set(targets.map(event=>event.eventType))],
          code:String(error?.code||error?.name||'ERROR').slice(0,64),
        }));
      }catch{}
      return null;
    });
    try{ waitUntil(work); }catch{}
    return work;
  }catch{
    return Promise.resolve(null);
  }
}
