import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureAiAnalyzeReadiness,
  ensureAiFeedbackReadiness,
  ensureAiHistoryReadiness,
  ensureAiLogReadiness,
} from '../../api/_ai-readiness.js';

const WRITE=/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|VACUUM|REINDEX)\b/iu;

function normalized(statement){ return String(statement).replace(/\s+/gu,' ').trim(); }
function database(execute){ return {execute}; }

async function statementsFor(guard){
  const statements=[];
  const db=database(async statement=>{
    statements.push(normalized(statement));
    return {rows:[],rowsAffected:0};
  });
  assert.equal(await guard(db),true);
  assert.equal(statements.some(sql=>WRITE.test(sql)),false);
  return statements;
}

test('AI readiness uses exact route-scoped read-only projections',async()=>{
  assert.deepEqual(await statementsFor(ensureAiAnalyzeReadiness),[
    'SELECT id,is_demo FROM auth_accounts LIMIT 0',
    'SELECT id,week_label FROM pairing_weeks LIMIT 0',
    'SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair FROM pairing_groups LIMIT 0',
    'SELECT week_id,user_id,source FROM pairing_participants LIMIT 0',
    'SELECT id,room_id,pair_label,transcript,code_snapshots, interviewer_questions,started_at,ended_at,duration_sec,cost_cents,created_at, created_by FROM ai_sessions LIMIT 0',
    'SELECT id,session_id,role,feedback_json,evidence,model_used, reason_for_pick,estimated_cost_cents,confidence,created_at FROM ai_feedback LIMIT 0',
    'SELECT date,calls,tokens_in,tokens_out,updated_at FROM ai_usage LIMIT 0',
    'SELECT month,user_id,calls,tokens_in,updated_at FROM ai_account_monthly_usage LIMIT 0',
    'SELECT reservation_id,month,user_id,tokens_in,session_id, refunded_at,created_at FROM ai_account_monthly_reservations LIMIT 0',
    'SELECT user_id,consented_at,revoked_at,policy_version FROM ai_consents LIMIT 0',
  ]);

  assert.deepEqual(await statementsFor(ensureAiFeedbackReadiness),[
    'SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair FROM pairing_groups LIMIT 0',
    'SELECT week_id,user_id,source FROM pairing_participants LIMIT 0',
    'SELECT id,room_id,pair_label,created_by FROM ai_sessions LIMIT 0',
    'SELECT id,session_id,feedback_json,evidence,model_used, reason_for_pick,confidence,created_at FROM ai_feedback LIMIT 0',
  ]);

  assert.deepEqual(await statementsFor(ensureAiHistoryReadiness),[
    'SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair FROM pairing_groups LIMIT 0',
    'SELECT week_id,user_id,source FROM pairing_participants LIMIT 0',
    'SELECT id,room_id,pair_label,duration_sec,created_by FROM ai_sessions LIMIT 0',
    'SELECT id,session_id,role,model_used,estimated_cost_cents, confidence,created_at FROM ai_feedback LIMIT 0',
    'SELECT date,calls,tokens_in,tokens_out,updated_at FROM ai_usage LIMIT 0',
    'SELECT month,user_id,calls FROM ai_account_monthly_usage LIMIT 0',
  ]);

  assert.deepEqual(await statementsFor(ensureAiLogReadiness),[
    'SELECT id,level,source,event,message,meta_json,user_id,route,ua,ip, created_at FROM app_logs LIMIT 0',
  ]);
});

test('analyze readiness includes the active-membership joins only when they are used',async()=>{
  const previous=process.env.CIRCLE_MEMBERSHIP_ENABLED;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  try{
    const statements=await statementsFor(ensureAiAnalyzeReadiness);
    assert.ok(statements.includes('SELECT id,is_primary,archived_at FROM circles LIMIT 0'));
    assert.ok(statements.includes('SELECT circle_id,user_id,status FROM circle_memberships LIMIT 0'));
  }finally{
    if(previous===undefined) delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
    else process.env.CIRCLE_MEMBERSHIP_ENABLED=previous;
  }
});

test('AI readiness coalesces per client and contract and caches only success',async()=>{
  const statements=[];
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const db=database(async statement=>{
    statements.push(normalized(statement));
    if(statements.length===1) await gate;
    return {rows:[],rowsAffected:0};
  });

  const first=ensureAiAnalyzeReadiness(db);
  const second=ensureAiAnalyzeReadiness(db);
  await Promise.resolve();
  assert.equal(statements.length,1);
  release();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(statements.length,10);
  assert.equal(await ensureAiAnalyzeReadiness(db),true);
  assert.equal(statements.length,10,'a successful contract is cached for the concrete client');

  assert.equal(await ensureAiLogReadiness(db),true);
  assert.equal(statements.length,11,'a distinct route contract has its own probe');

  const other=database(async statement=>{
    statements.push(normalized(statement));
    return {rows:[],rowsAffected:0};
  });
  assert.equal(await ensureAiLogReadiness(other),true);
  assert.equal(statements.length,12,'different clients never share readiness');
});

test('AI readiness rejects invalid clients and retries failed probes',async()=>{
  await assert.rejects(ensureAiHistoryReadiness(null),/database client is required/);
  await assert.rejects(ensureAiHistoryReadiness({}),/database client is required/);

  const statements=[];
  let failures=1;
  const db=database(async statement=>{
    statements.push(normalized(statement));
    if(failures-->0) throw new Error('AI schema temporarily unavailable');
    return {rows:[],rowsAffected:0};
  });
  await assert.rejects(ensureAiHistoryReadiness(db),/temporarily unavailable/);
  assert.equal(await ensureAiHistoryReadiness(db),true);
  assert.equal(statements.length,7,'the failed first probe is evicted before retry');
  assert.equal(statements.some(sql=>WRITE.test(sql)),false);
});
