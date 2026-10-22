import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

let activeDb=null;
let sentryConfigured=false;
const sentryMessages=[];
const sentryExceptions=[];
const realFetch=globalThis.fetch;

mock.module('../../api/_db.js',{
  exports:{
    getClient:()=>{
      if(activeDb instanceof Error) throw activeDb;
      return activeDb;
    },
    verifyRequestAuth:req=>{
      const raw=req?.headers?.['x-test-user'];
      if(raw===undefined) return null;
      const payload={id:Number.isNaN(Number(raw))?raw:Number(raw),email:`user-${raw}@example.test`};
      if(req.headers['x-test-demo']) payload.is_demo=true;
      return payload;
    },
    verifyMutationOrigin:req=>req?.headers?.['x-test-cross-origin']!=='1',
    initSentry:()=>{},
    isSentryConfigured:()=>sentryConfigured,
    captureSentryMessage:(message,context)=>{ sentryMessages.push({message,context}); },
    captureSentryException:(error,context)=>{ sentryExceptions.push({error,context}); },
  },
});

const {default:aiHandler}=await import('../../api/ai.js');

const POLICY='2026-09-17';
const PAIR_ROOM='week_10_pair_22';
const AI_ROOM='week_10_pair_21';
const SOLO_HUMAN_ROOM='week_10_pair_23';

function invokeRequest(req){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const response={
      status(code){ statusCode=code; return this; },
      setHeader(){},
      json(payload){ resolve({status:statusCode,body:payload}); },
      end(payload){ resolve({status:statusCode,body:payload}); },
    };
    Promise.resolve(aiHandler(req,response)).catch(reject);
  });
}

function invoke({method='GET',url='/',query={},headers={},body={}}={}){
  return invokeRequest({method,url,query,headers,body});
}

function analyze(body,{user='2',headers={}}={}){
  return invoke({
    method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},
    headers:{'x-test-user':user,'user-agent':'cov-agent','x-forwarded-for':'203.0.113.9, 10.0.0.1',...headers},
    body:{room_id:PAIR_ROOM,ai_consent:true,transcript:'We discussed a bounded, source-aware solution for streaming input.',...body},
  });
}

async function createDatabase(){
  const client=createClient({url:'file::memory:'});
  await client.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT,display_name TEXT,color TEXT,is_demo INTEGER DEFAULT 0)`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT,color TEXT)`,
    `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY,week_label TEXT NOT NULL,week_start TEXT,focus TEXT,is_demo INTEGER DEFAULT 0)`,
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER DEFAULT 0,topic TEXT,topic_kind TEXT)`,
    `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,
      source TEXT NOT NULL,PRIMARY KEY (week_id,user_id))`,
    `CREATE TABLE ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT,pair_label TEXT,transcript TEXT,
      code_snapshots TEXT,interviewer_questions TEXT,started_at TEXT,ended_at TEXT,duration_sec INTEGER,
      cost_cents INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),created_by INTEGER)`,
    `CREATE TABLE ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER NOT NULL,role TEXT,
      feedback_json TEXT NOT NULL,evidence TEXT,model_used TEXT,reason_for_pick TEXT,estimated_cost_cents INTEGER,
      confidence REAL,created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE ai_usage (date TEXT PRIMARY KEY,calls INTEGER DEFAULT 0,tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,updated_at TEXT)`,
    `CREATE TABLE ai_monthly_usage (month TEXT PRIMARY KEY,user_id INTEGER,calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,updated_at TEXT)`,
    `CREATE TABLE ai_account_monthly_usage (month TEXT NOT NULL,user_id INTEGER NOT NULL,calls INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(month,user_id))`,
    `CREATE TABLE ai_account_monthly_reservations (reservation_id TEXT PRIMARY KEY,month TEXT NOT NULL,user_id INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,session_id INTEGER UNIQUE,refunded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE ai_consents (user_id INTEGER PRIMARY KEY,consented_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,policy_version TEXT NOT NULL)`,
    `CREATE TABLE app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT,source TEXT,event TEXT,message TEXT,
      meta_json TEXT,user_id INTEGER,route TEXT,ua TEXT,ip TEXT,created_at TEXT DEFAULT (datetime('now')))`,
    `INSERT INTO auth_accounts (id,email,display_name,is_demo) VALUES (2,'two@example.test','Two',0),(3,'three@example.test','Three',0)`,
    `INSERT INTO pairing_weeks (id,week_label) VALUES (10,'2026-W38')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES
      (21,10,2,2,NULL,1),(22,10,2,3,NULL,0),(23,10,2,2,NULL,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth'),(10,3,1,'auth')`,
    {sql:`INSERT INTO ai_consents (user_id,policy_version) VALUES (3,?)`,args:[POLICY]},
  ],'write');
  return client;
}

function wrap(client,{fail}={}){
  const check=async statement=>{
    const sql=typeof statement==='string'?statement:String(statement?.sql||'');
    if(fail){ const error=fail(sql); if(error) throw error; }
  };
  return {
    async execute(statement){ await check(statement); return client.execute(statement); },
    async batch(statements,mode){ for(const statement of statements) await check(statement); return client.batch(statements,mode); },
    close:()=>client.close(),
  };
}

const VALID_FEEDBACK={
  candidate:{
    strengths:[{point:'Bounded design',evidence:'a bounded, source-aware solution',confidence:0.9}],
    improvements:[{point:'Edge cases',evidence:'',suggestion:'Test empty input'}],
  },
  interviewer:{
    strengths:[{point:'Paced well',evidence:'We discussed totally different words entirely here today',confidence:0.8}],
    improvements:[{point:'Probe deeper',evidence:'random bounded, source-aware solution for something',suggestion:'Ask about scale'}],
  },
  overall_score:8,
  next_time_checklist:['  Frame the problem  ','',],
};

function providerResponse(content,{status=200,usage={prompt_tokens:120,completion_tokens:40}}={}){
  return new Response(JSON.stringify({choices:[{message:{content}}],usage}),{status});
}

function scriptFetch(handlers){
  const calls=[];
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body)});
    const handler=handlers.shift();
    if(!handler) throw new Error('unexpected provider call');
    return handler(String(url));
  };
  return calls;
}

async function count(client,table){
  return Number((await client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
}

let client;
beforeEach(async()=>{
  process.env.AI_ENABLED='true';
  client=await createDatabase();
  activeDb=wrap(client);
  sentryConfigured=false;
  sentryMessages.length=0;
  sentryExceptions.length=0;
});

afterEach(()=>{
  client?.close();
  activeDb=null;
  for(const key of ['GROQ_API_KEY','OPENAI_API_KEY','AI_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','JWT_SECRET']){
    delete process.env[key];
  }
  globalThis.fetch=realFetch;
});

test('routing resolves endpoints from query, path, id parameter and malformed URLs',async()=>{
  const unknown=await invoke({url:'/api/ai/unknown'});
  assert.equal(unknown.status,400);
  assert.equal(unknown.body.got,'unknown');
  const malformed=await invoke({url:'http://[bad/route'});
  assert.equal(malformed.status,400);
  assert.equal(malformed.body.got,'route');
  const empty=await invoke({url:undefined});
  assert.equal(empty.status,400);
  // ?endpoint= and ?id= both route without a query object.
  assert.equal((await invoke({url:'/api/ai?endpoint=HISTORY'})).status,401);
  assert.equal((await invoke({url:'/api/ai?id=7'})).status,401);
  // An unrouted POST falls through to analysis, which enforces its own gates.
  const post=await invoke({method:'POST',url:'/api/ai'});
  assert.equal(post.status,401);
  assert.equal((await invoke({method:'GET',url:'/api/ai/analyze'})).status,405);
  assert.equal((await invoke({method:'POST',url:'/api/ai/feedback'})).status,405);
  assert.equal((await invoke({method:'POST',url:'/api/ai/history'})).status,405);
  assert.equal((await invoke({method:'POST',url:'/',headers:{'x-test-cross-origin':'1'}})).status,403);
});

test('analysis fails closed when disabled, unauthenticated, empty, or bound to an untrusted room',async()=>{
  delete process.env.AI_ENABLED;
  assert.equal((await analyze({})).status,503);
  process.env.AI_ENABLED='true';
  assert.equal((await analyze({ai_consent:'true'})).status,403);
  const empty=await analyze({transcript:'',code:''});
  assert.equal(empty.status,400);
  assert.match(empty.body.error,/transcript or code required/);
  assert.equal((await analyze({},{user:'not-a-number'})).status,401);
  assert.equal((await analyze({room_id:'room-22'})).status,403);
  assert.equal((await analyze({room_id:'week_10_pair_99'})).status,403,'nonexistent room');
  assert.equal((await analyze({},{user:'9'})).status,403,'outsider');
  const solo=await analyze({room_id:SOLO_HUMAN_ROOM});
  assert.equal(solo.status,403);
  assert.match(solo.body.error,/single-user analysis requires a trusted AI-pair room/);
  assert.equal(await count(client,'ai_sessions'),0);
});

test('readiness, room lookup and consent storage failures map to non-disclosing errors',async()=>{
  activeDb=new Error('no database');
  assert.equal((await analyze({})).status,503);
  activeDb=wrap(client,{fail:sql=>sql.includes('JOIN pairing_weeks pw')?new Error('room read failed'):null});
  assert.equal((await analyze({})).status,503);
  activeDb=wrap(client,{fail:sql=>sql.includes('INSERT INTO ai_consents')?new Error('disk full'):null});
  const consent=await analyze({});
  assert.equal(consent.status,500);
  assert.equal(consent.body.error,'unable to record AI consent');
});

test('analysis waits for every participant to consent under the current policy',async()=>{
  await client.execute(`UPDATE ai_consents SET revoked_at=datetime('now') WHERE user_id=3`);
  const pending=await analyze({});
  assert.equal(pending.status,403);
  assert.equal(pending.body.pending_participant_count,1);
  const stored=await client.execute(`SELECT user_id,policy_version FROM ai_consents WHERE user_id=2`);
  assert.equal(stored.rows[0].policy_version,POLICY,'caller consent is still recorded');
  assert.equal(await count(client,'ai_sessions'),0);
});

test('daily demo and global pools block before quota reservation and log a warning to Sentry',async()=>{
  sentryConfigured=true;
  process.env.JWT_SECRET='unit-test-secret-at-least-thirty-two-characters';
  const today=new Date().toISOString().slice(0,10);
  await client.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=2`);
  await client.execute({sql:`INSERT INTO ai_usage (date,calls) VALUES (?,100)`,args:[today]});
  const userAgent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
  const demo=await analyze({},{headers:{'user-agent':userAgent}});
  assert.equal(demo.status,429);
  assert.equal(demo.body.demo,true);
  const log=await client.execute(`SELECT level,event,ua,ip,route FROM app_logs`);
  // ID-82: a coarse family and a daily keyed hash, never the raw values.
  const {logAddressHash}=await import('../../api/_log-privacy.js');
  assert.deepEqual({...log.rows[0]},{level:'warn',event:'ai_quota_daily_demo',ua:'Safari 17 on macOS',
    ip:logAddressHash('203.0.113.9'),route:'/api/ai/analyze'});
  assert.match(log.rows[0].ip,/^h1:[0-9a-f]{16}$/);
  assert.equal(sentryMessages.length,1);
  assert.equal(sentryMessages[0].context.level,'warning');

  await client.execute(`UPDATE auth_accounts SET is_demo=0 WHERE id=2`);
  await client.execute({sql:`UPDATE ai_usage SET calls=14400 WHERE date=?`,args:[today]});
  const global=await analyze({});
  assert.equal(global.status,429);
  assert.match(global.body.error,/14,400 exhausted/);
  assert.equal(await count(client,'ai_account_monthly_reservations'),0);
});

test('monthly quota blocks at the account limit and corrupt ledgers fail closed',async()=>{
  const month=new Date().toISOString().slice(0,7);
  await client.execute({sql:`INSERT INTO ai_account_monthly_usage (month,user_id,calls) VALUES (?,2,500)`,args:[month]});
  const blocked=await analyze({});
  assert.equal(blocked.status,429);
  assert.equal(blocked.body.limit,500);
  const log=await client.execute(`SELECT user_id,event FROM app_logs`);
  assert.equal(Number(log.rows[0].user_id),2,'payload identity is attributed');
  assert.equal(log.rows[0].event,'ai_quota_blocked');

  await client.execute({sql:`UPDATE ai_account_monthly_usage SET calls=-1 WHERE month=?`,args:[month]});
  assert.equal((await analyze({})).status,503);

  await client.execute(`DELETE FROM ai_account_monthly_usage`);
  activeDb=wrap(client,{fail:sql=>sql.includes('INSERT INTO ai_account_monthly_reservations')?new Error('reserve failed'):null});
  const reserve=await analyze({});
  assert.equal(reserve.status,503);
  assert.equal(reserve.body.error,'AI quota temporarily unavailable');
});

test('without provider keys a template result is verified against the transcript and persisted',async()=>{
  const result=await analyze({
    transcript:'short\nCandidate explained the sliding window approach clearly',
    code:{file:'main.js'},interviewer_questions:'How would this scale?',duration_sec:'90',
  });
  assert.equal(result.status,200);
  assert.equal(result.body.mocked,true);
  assert.match(result.body.model_used,/\(mocked\)$/);
  assert.equal(result.body.feedback.candidate.strengths[0].evidence,'Candidate explained the sliding window approach clearly');
  assert.ok(result.body.evidence_validated.loweredConfidence);
  assert.equal(result.body.quota.calls_this_month,1);
  const session=await client.execute(`SELECT room_id,code_snapshots,cost_cents FROM ai_sessions`);
  assert.equal(session.rows[0].room_id,PAIR_ROOM);
  assert.equal(session.rows[0].code_snapshots,'{"file":"main.js"}');
  const usage=await client.execute(`SELECT calls FROM ai_usage`);
  assert.equal(Number(usage.rows[0].calls),1);
});

test('single-user AI-pair rooms analyse with only the caller consent',async()=>{
  await client.execute(`DELETE FROM ai_consents`);
  const result=await analyze({room_id:AI_ROOM,transcript:'',code:'function solve(){ return 1; }'});
  assert.equal(result.status,200);
  assert.equal(result.body.feedback.candidate.strengths[0].evidence,'function solve(){ return 1; }');
});

test('OpenAI-only mode uses provider usage for cost and verifies evidence by phrase chunks',async()=>{
  process.env.OPENAI_API_KEY='openai-key';
  const calls=scriptFetch([()=>providerResponse(JSON.stringify(VALID_FEEDBACK))]);
  const result=await analyze({});
  assert.equal(result.status,200);
  assert.equal(result.body.openaiFallback,true);
  assert.equal(result.body.model_used,'gpt-4o-mini (openai fallback)');
  assert.equal(calls[0].url,'https://api.openai.com/v1/chat/completions');
  assert.equal(result.body.estimated_cost.tokens_in,120);
  assert.equal(result.body.estimated_cost.tokens_out,40);
  const verification=result.body.evidence_validated;
  assert.equal(verification.total,4);
  assert.equal(verification.validated,2,'exact quote and 5-word chunk validate');
  assert.equal(result.body.feedback.candidate.improvements[0].evidence,'no direct quote');
  assert.equal(result.body.feedback.interviewer.strengths[0].evidence,'no direct quote - inferred');
  assert.equal(result.body.feedback.interviewer.strengths[0].confidence,0.6);
  assert.deepEqual(result.body.feedback.next_time_checklist,['Frame the problem']);
});

test('OpenAI-only mode: invalid envelopes are 502, HTTP errors degrade to a minimal template',async()=>{
  process.env.OPENAI_API_KEY='openai-key';
  scriptFetch([()=>new Response(JSON.stringify({choices:[{message:{content:'   '}}]}),{status:200})]);
  const invalid=await analyze({});
  assert.equal(invalid.status,502);
  assert.ok(invalid.body.session_id>0);

  scriptFetch([()=>new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429})]);
  const degraded=await analyze({});
  assert.equal(degraded.status,200);
  assert.equal(degraded.body.mocked,true);
  assert.match(degraded.body.reason_for_pick,/openai failed openai 429: rate limited/);
  assert.equal(degraded.body.feedback.overall_score,6);
});

test('Groq primary failure on a long session retries the fast model before succeeding',async()=>{
  process.env.GROQ_API_KEY='groq-key';
  const calls=scriptFetch([
    ()=>new Response(JSON.stringify({error:'model overloaded'}),{status:503}),
    ()=>providerResponse(JSON.stringify(VALID_FEEDBACK),{usage:{}}),
  ]);
  const result=await analyze({transcript:'a bounded, source-aware solution '.repeat(900)});
  assert.equal(result.status,200);
  assert.equal(calls[0].body.model,'llama-3.3-70b-versatile');
  assert.equal(calls[1].body.model,'llama-3.1-8b-instant');
  assert.equal(result.body.model_used,'llama-3.1-8b-instant');
  assert.match(result.body.reason_for_pick,/primary failed \(groq 503: model overloaded\), fallback fast/);
});

test('Groq failures fall back to OpenAI, and report 502 when every provider fails',async()=>{
  process.env.GROQ_API_KEY='groq-key';
  process.env.OPENAI_API_KEY='openai-key';
  scriptFetch([
    ()=>{ throw new Error('socket hang up'); },
    ()=>new Response('not json',{status:502}),
    ()=>providerResponse(JSON.stringify(VALID_FEEDBACK)),
  ]);
  const fallback=await analyze({interviewer_questions:'q'.repeat(600)});
  assert.equal(fallback.status,200);
  assert.equal(fallback.body.model_used,'gpt-4o-mini (fallback)');
  assert.match(fallback.body.reason_for_pick,/system design.*primary and fast Groq failed.*groq fail -> openai/);

  scriptFetch([
    ()=>new Response('upstream exploded',{status:500}),
    ()=>new Response('[]',{status:500}),
    ()=>{ throw Object.assign(new Error('aborted'),{name:'AbortError'}); },
  ]);
  const allFail=await analyze({duration_sec:1500});
  assert.equal(allFail.status,502);
  const log=await client.execute(`SELECT message FROM app_logs WHERE event='ai_groq_fail'`);
  assert.match(log.rows[0].message,/groq 500: \[\]/);

  delete process.env.OPENAI_API_KEY;
  scriptFetch([()=>{ throw Object.assign(new Error('aborted'),{name:'AbortError'}); }]);
  const timeout=await analyze({});
  assert.equal(timeout.status,502);
  const timeoutLog=await client.execute(`SELECT message FROM app_logs WHERE event='ai_groq_fail' ORDER BY id DESC LIMIT 1`);
  assert.equal(timeoutLog.rows[0].message,'groq request timed out');
});

test('malformed provider feedback is rejected after the session is stored',async()=>{
  process.env.GROQ_API_KEY='groq-key';
  const invalidShapes=[
    'not json',
    JSON.stringify([]),
    JSON.stringify({...VALID_FEEDBACK,candidate:[]}),
    JSON.stringify({...VALID_FEEDBACK,candidate:{strengths:{},improvements:[]}}),
    JSON.stringify({...VALID_FEEDBACK,candidate:{strengths:[null],improvements:[]}}),
    JSON.stringify({...VALID_FEEDBACK,candidate:{strengths:[{point:' ',evidence:''}],improvements:[]}}),
    JSON.stringify({...VALID_FEEDBACK,candidate:{strengths:[],improvements:[{point:'x',evidence:''}]}}),
    JSON.stringify({...VALID_FEEDBACK,candidate:{strengths:[{point:'x',evidence:'',confidence:2}],improvements:[]}}),
    JSON.stringify({...VALID_FEEDBACK,overall_score:11}),
    JSON.stringify({...VALID_FEEDBACK,next_time_checklist:[1]}),
  ];
  scriptFetch(invalidShapes.map(content=>()=>providerResponse(content)));
  for(const shape of invalidShapes){
    const result=await analyze({});
    assert.equal(result.status,502,shape);
  }
  assert.equal(await count(client,'ai_feedback'),0);
  assert.equal(await count(client,'ai_sessions'),invalidShapes.length);
});

test('a provider envelope without choices is treated as an invalid Groq response',async()=>{
  process.env.GROQ_API_KEY='groq-key';
  scriptFetch([()=>new Response(JSON.stringify({choices:[['x']]}),{status:200})]);
  const result=await analyze({});
  assert.equal(result.status,502);
  assert.equal(await count(client,'ai_feedback'),0);
});

test('feedback insert failures after provider work are logged and hidden from the caller',async()=>{
  activeDb=wrap(client,{fail:sql=>sql.includes('INSERT INTO ai_feedback')?new Error('feedback write failed'):null});
  const feedback=await analyze({});
  assert.equal(feedback.status,500);
  assert.equal(feedback.body.error,'feedback create failed');
  const log=await client.execute(`SELECT event FROM app_logs WHERE event='ai_feedback_insert_fail'`);
  assert.equal(log.rows.length,1);
});

test('feedback detail returns parsed owner rows, tolerates corrupt JSON and hides other sessions',async()=>{
  const created=await analyze({});
  assert.equal(created.status,200);
  const id=created.body.session_id;
  const detail=await invoke({url:`/api/ai/feedback?id=${id}`,headers:{'x-test-user':'2'}});
  assert.equal(detail.status,200);
  assert.equal(detail.body.session_id,id);
  assert.equal(detail.body.room_id,PAIR_ROOM);
  assert.equal(detail.body.evidence.validation.total,detail.body.feedback.candidate.strengths.length
    +detail.body.feedback.candidate.improvements.length+detail.body.feedback.interviewer.strengths.length
    +detail.body.feedback.interviewer.improvements.length);

  await client.execute(`UPDATE ai_feedback SET feedback_json='{bad',evidence='plain text'`);
  const corrupt=await invoke({url:`/api/ai/feedback/${id}`,query:{endpoint:'feedback'},headers:{'x-test-user':'2'}});
  assert.equal(corrupt.status,200);
  assert.deepEqual(corrupt.body.feedback,{});
  assert.equal(corrupt.body.evidence,'plain text');
  await client.execute(`UPDATE ai_feedback SET evidence=NULL`);
  const noEvidence=await invoke({url:'/api/ai/feedback',query:{sessionId:String(id)},headers:{'x-test-user':'2'}});
  assert.equal(noEvidence.body.evidence,null);

  const partner=await invoke({url:`/api/ai/feedback?id=${id}`,headers:{'x-test-user':'3'}});
  assert.equal(partner.status,404,'feedback is private to the session creator');
  const list=await invoke({url:'/api/ai/feedback',headers:{'x-test-user':'2'}});
  assert.equal(list.body.count,1);
  assert.equal((await invoke({url:'/api/ai/feedback',headers:{'x-test-user':'0'}})).status,401);
  activeDb=new Error('down');
  assert.equal((await invoke({url:'/api/ai/feedback',headers:{'x-test-user':'2'}})).status,503);
});

test('feedback detail keeps the creator postcondition even if storage returns foreign rows',async()=>{
  const real=wrap(client);
  activeDb={
    async execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('WHERE (af.session_id=? OR af.id=?)')) return {rows:[{id:1,session_id:1,created_by:99,feedback_json:'{}'}]};
      return real.execute(statement);
    },
    batch:(statements,mode)=>real.batch(statements,mode),
  };
  const result=await invoke({url:'/api/ai/feedback?id=1',headers:{'x-test-user':'2'}});
  assert.equal(result.status,403);
});

test('history reports owner feedback with daily usage and demo-aware monthly limits',async()=>{
  await analyze({});
  const history=await invoke({url:'/api/ai/history',headers:{'x-test-user':'2','x-test-demo':'1'}});
  assert.equal(history.status,200);
  assert.equal(history.body.feedbacks.length,1);
  assert.equal(Number(history.body.usage_today.calls),1);
  assert.deepEqual(history.body.monthly,{count:1,limit:100,demo:true});
  assert.equal((await invoke({url:'/api/ai/history',headers:{'x-test-user':'-4'}})).status,401);
  activeDb=new Error('down');
  assert.equal((await invoke({url:'/api/ai/history',headers:{'x-test-user':'2'}})).status,503);
});

test('multi-circle control plane blocks callers without a legacy primary circle context',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const blocked=await invoke({url:'/api/ai/history',headers:{'x-test-user':'2'}});
  assert.equal(blocked.status,409);
  assert.equal(blocked.body.code,'circle_feature_unavailable');
  // Anonymous callers skip the circle check and hit the route's own auth gate.
  assert.equal((await invoke({url:'/api/ai/history'})).status,401);
  activeDb=new Error('down');
  assert.equal((await invoke({url:'/api/ai/history',headers:{'x-test-user':'2'}})).status,503);
});

test('unhandled storage errors return a generic 500 and are reported once to Sentry',async()=>{
  const real=wrap(client);
  activeDb={
    async execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('LIMIT 20')) throw new Error('list exploded');
      return real.execute(statement);
    },
    batch:(statements,mode)=>real.batch(statements,mode),
  };
  const result=await invoke({url:'/api/ai/feedback',headers:{'x-test-user':'2'}});
  assert.equal(result.status,500);
  assert.equal(result.body.error,'ai_unhandled');
  assert.equal(sentryExceptions.length,1);
  assert.equal(sentryExceptions[0].context.tags.event,'api_unhandled');
  const log=await client.execute(`SELECT level,event FROM app_logs`);
  assert.equal(log.rows[0].event,'api_unhandled');
});

function streamRequest(chunks,{error=false}={}){
  const req=new EventEmitter();
  Object.assign(req,{method:'POST',url:'/api/ai/analyze',query:{},headers:{'x-test-user':'2'},body:{}});
  setImmediate(()=>{
    if(error){ req.emit('error',new Error('stream reset')); return; }
    for(const chunk of chunks) req.emit('data',chunk);
    req.emit('end');
  });
  return req;
}

test('streamed bodies are parsed as JSON or form data and never grant implicit consent',async()=>{
  const json=await invokeRequest(streamRequest([JSON.stringify({ai_consent:true,room_id:PAIR_ROOM,transcript:'',code:''})]));
  assert.equal(json.status,400,'JSON body parsed and consent accepted');
  const form=await invokeRequest(streamRequest(['ai_consent=true&room_id=',PAIR_ROOM]));
  assert.equal(form.status,403,'form strings are not boolean consent');
  assert.equal((await invokeRequest(streamRequest([]))).status,403);
  assert.equal((await invokeRequest(streamRequest(['&']))).status,403);
  assert.equal((await invokeRequest(streamRequest([],{error:true}))).status,403);
});
