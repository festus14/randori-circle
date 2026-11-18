import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { primaryExecutionContext } from '../../api/_execution-context.js';
import { admitExecution, ExecutionBusyError } from '../../api/_execution-queue.js';

const SECRET='execution-context-test-secret'.repeat(2);
const ENV={EXECUTION_QUEUE_ENABLED:'true',EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://provider.invalid/execute',JWT_SECRET:SECRET};
let currentDb;
const auth=req=>({id:Number(req.headers['x-test-user']||1)});
mock.module('../../api/_db.js',{exports:{getClient:()=>currentDb,getJwtSecret:()=>SECRET,getAdminEmails:()=>new Set(),
  initSentry:()=>{},isSentryConfigured:()=>false,captureSentryException:()=>{},captureSentryMessage:()=>{},verifyMutationOrigin:()=>true,
  verifyRequestAuth:auth,verifySignedRequestAuth:auth}});
const {default:dataHandler}=await import('../../api/data.js');
const {sendWorkspaceFailure}=await import('../../api/_workspace-router.js');
async function fixture(t){const file=await createMigratedDatabase({prefix:'randori-exec-context-'}),db=createClient({url:file.url});currentDb=db;t.after(()=>{currentDb=null;db.close();file.cleanup();});
  await db.execute("INSERT INTO circles(id,public_id,slug,name,is_primary) VALUES(1,'primary','primary','Primary',1)");
  await db.execute("INSERT INTO auth_accounts(id,email,password_hash,display_name,color) VALUES(1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222')");
  await db.execute("INSERT INTO pairing_weeks(id,week_label,week_start,is_demo) VALUES(10,'2026-W38','2026-09-14T07:00:00.000Z',0)");
  await db.execute("INSERT INTO pairing_groups(id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES(20,10,1,2,0)");
  await db.execute("INSERT INTO pairing_participants(week_id,user_id,position,source) VALUES(10,1,0,'auth'),(10,2,1,'auth')");return db;}
function response(){const res={headers:{},statusCode:200,setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};return res;}
function envFor(t,extra={}){const keys={...ENV,...extra};const previous=Object.fromEntries(Object.keys(keys).map(key=>[key,process.env[key]]));Object.assign(process.env,keys);t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});}

test('primary context flag off is no-I/O; selected circle is server-derived, never a client hint',async t=>{
  assert.equal(await primaryExecutionContext(new Proxy({}, {get(){throw new Error('I/O');}}),{},{}),undefined);
  const db=await fixture(t),base={userId:1,weekId:10,pairId:20,operation:'test'};
  assert.equal((await primaryExecutionContext(db,base,ENV)).circleId,1);
  assert.equal((await primaryExecutionContext(db,{...base,workspace:{context:{membership:{id:22}}}},ENV)).circleId,22);
  await db.execute("UPDATE circles SET archived_at=datetime('now') WHERE id=1");
  await assert.rejects(primaryExecutionContext(db,base,ENV),ExecutionBusyError);
});

test('only the exact live ID-99 room gets bounded interview priority; lobby, ended and flag off stay practice',async t=>{
  const db=await fixture(t);envFor(t,{INTERVIEW_SESSION_ENABLED:'true'});
  const args={userId:1,weekId:10,pairId:20,operation:'test'};
  assert.equal((await primaryExecutionContext(db,args,process.env)).interview,false,'lobby');
  await db.execute("INSERT INTO pair_interview_sessions(week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,editing_locked,revision,updated_by,created_at,updated_at) VALUES(10,20,1,2,'interviewer',strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,1,2,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  assert.equal((await primaryExecutionContext(db,args,process.env)).interview,true);
  assert.equal((await primaryExecutionContext(db,{...args,weekId:null,pairId:null},process.env)).interview,false,'solo');
  process.env.INTERVIEW_SESSION_ENABLED='false';assert.equal((await primaryExecutionContext(db,args,process.env)).interview,false);
  process.env.INTERVIEW_SESSION_ENABLED='true';
  await db.execute("INSERT INTO pair_session_controls(week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at) VALUES(10,20,1,'auth',2,'auth',1,'auth','paused',0,NULL,1,2,'auth',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  assert.equal((await primaryExecutionContext(db,args,process.env)).interview,false,'ended');
});

test('pre-v26 interview capability safely falls back without runtime DDL or invented priority',async t=>{
  const db=await fixture(t);envFor(t,{INTERVIEW_SESSION_ENABLED:'true'});
  // Isolated compatibility fixture: code with interview flag but no v26 ledger.
  await db.execute('DELETE FROM schema_migrations WHERE version=26');
  const ctx=await primaryExecutionContext(db,{userId:1,weekId:10,pairId:20,operation:'test'},process.env);
  assert.equal(ctx.interview,false);
});

test('primary execute busy/quotas never call the provider or persist a wrong-answer run, off remains legacy',async t=>{
  const db=await fixture(t);envFor(t,{EXECUTION_ACCOUNT_PER_MINUTE:'10'});let calls=0;const native=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;throw new Error('provider must not be contacted');};t.after(()=>{globalThis.fetch=native;});
  await admitExecution(db,{userId:10,circleId:1,operation:'held'}, {env:ENV});
  await admitExecution(db,{userId:11,circleId:1,operation:'held'}, {env:ENV});
  const req={method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-user':'1'},body:{question_slug:'focus-block-rollup',question_version:1,language:'javascript',code:'function rollUpFocusBlocks(){return [];}'}};
  const res=response();await dataHandler(req,res);
  assert.equal(res.statusCode,503);assert.equal(res.body.code,'execution_busy');assert.equal(res.body.reason,'queued');assert.equal(res.headers['Retry-After'],'1');assert.equal(calls,0);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM session_runs')).rows[0].n,0);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM app_logs WHERE event IN ('execute_lease_start','execute_attempt')")).rows[0].n,0,'queue-on never runs legacy admission');
  await db.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'eq1:*'");
  process.env.EXECUTION_ACCOUNT_PER_MINUTE='1';
  const lease=await admitExecution(db,{userId:1,circleId:1,operation:'charged'},{env:process.env});
  await db.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[lease.key]});
  const quota=response();await dataHandler(req,quota);assert.equal(quota.statusCode,429);assert.equal(quota.body.reason,'quota');assert.equal(calls,0);
  process.env.EXECUTION_QUEUE_ENABLED='false';
  const legacy=response();await dataHandler(req,legacy);assert.equal(legacy.body.code,'execution_unavailable');assert.equal(calls,1);
  assert.ok(Number((await db.execute("SELECT COUNT(*) AS n FROM app_logs WHERE event='execute_lease_start'")).rows[0].n)>0);
});

test('primary store refusal is an explicit no-run 503 with recorded metrics, not provider_error',async t=>{
  const db=await fixture(t);envFor(t,{EXECUTION_ACCOUNT_PER_MINUTE:'10'});let calls=0,attempts=0;
  const native=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw new Error('provider must not run');};t.after(()=>{globalThis.fetch=native;});
  currentDb={execute:s=>db.execute(s),transaction:async()=>{attempts++;throw Object.assign(new Error('store down'),{code:'NETWORK_ERROR'});}};
  const res=response();await dataHandler({method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-user':'1'},
    body:{question_slug:'focus-block-rollup',question_version:1,language:'javascript',code:'function rollUpFocusBlocks(){return [];}' }},res);
  assert.equal(res.statusCode,503);assert.equal(res.body.code,'execution_busy');assert.equal(res.body.reason,'store');assert.equal(res.headers['Retry-After'],'1');assert.equal(calls,0);assert.equal(attempts,1);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM app_logs WHERE event='execution_queue_metric' AND message='store' AND user_id IS NULL")).rows[0].n),1);
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS n FROM session_runs')).rows[0].n),0);
});

test('secondary workspace sends the same no-store busy/quota shape, not generic execution failure',()=>{
  const res=response();sendWorkspaceFailure(res,new ExecutionBusyError('quota',60));
  assert.equal(res.statusCode,429);assert.equal(res.headers['Retry-After'],'60');assert.equal(res.body.code,'execution_busy');assert.equal(res.body.retry_after,60);
});
