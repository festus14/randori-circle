import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import {confirmationText,mountAiConsent} from '../../assets/ai-consent.js';
import {normalizeAnalysisPayload} from '../../assets/ai-consent.js';
import {consentDocument,consentWindow,until} from '../support/ai-consent-dom.mjs';

let activeDb=null;
const realFetch=globalThis.fetch;

mock.module('../../api/_db.js',{
  exports:{
    getClient:()=>activeDb,
    verifyRequestAuth:req=>{
      const id=Number(req?.headers?.['x-test-user']);
      return Number.isSafeInteger(id)&&id>0?{id,email:`user-${id}@example.test`}:null;
    },
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const {default:aiHandler}=await import('../../api/ai.js');

function invoke({method='GET',url='/',query={},headers={},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const response={
      status(code){ statusCode=code; return this; },
      setHeader(){},
      json(payload){ resolve({status:statusCode,body:payload}); },
      end(payload){ resolve({status:statusCode,body:payload}); },
    };
    Promise.resolve(aiHandler({method,url,query,headers,body},response)).catch(reject);
  });
}

async function createDatabase(){
  const client=createClient({url:'file::memory:'});
  await client.batch([
    `CREATE TABLE auth_accounts (
      id INTEGER PRIMARY KEY,email TEXT,display_name TEXT,color TEXT,
      is_demo INTEGER DEFAULT 0
    )`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT,color TEXT)`,
    `CREATE TABLE pairing_weeks (
      id INTEGER PRIMARY KEY,week_label TEXT NOT NULL,week_start TEXT,
      focus TEXT,is_demo INTEGER DEFAULT 0
    )`,
    `CREATE TABLE pairing_groups (
      id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER DEFAULT 0,
      topic TEXT,topic_kind TEXT
    )`,
    `CREATE TABLE pairing_participants (
      week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,
      source TEXT NOT NULL,PRIMARY KEY (week_id,user_id)
    )`,
    `CREATE TABLE ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,room_id TEXT,pair_label TEXT,transcript TEXT,
      code_snapshots TEXT,interviewer_questions TEXT,started_at TEXT,ended_at TEXT,
      duration_sec INTEGER,cost_cents INTEGER DEFAULT 0,created_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER
    )`,
    `CREATE TABLE ai_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,session_id INTEGER NOT NULL,role TEXT,
      feedback_json TEXT NOT NULL,evidence TEXT,model_used TEXT,reason_for_pick TEXT,
      estimated_cost_cents INTEGER,confidence REAL,created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE ai_usage (
      date TEXT PRIMARY KEY,calls INTEGER DEFAULT 0,tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,updated_at TEXT
    )`,
    `CREATE TABLE ai_monthly_usage (
      month TEXT PRIMARY KEY,user_id INTEGER,calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,updated_at TEXT
    )`,
    `CREATE TABLE ai_account_monthly_usage (
      month TEXT NOT NULL,user_id INTEGER NOT NULL,calls INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(month,user_id)
    )`,
    `CREATE TABLE ai_account_monthly_reservations (
      reservation_id TEXT PRIMARY KEY,month TEXT NOT NULL,user_id INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL DEFAULT 0,session_id INTEGER UNIQUE,refunded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE ai_consents (
      user_id INTEGER PRIMARY KEY,consented_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,policy_version TEXT NOT NULL
    )`,
    `CREATE TABLE app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT,source TEXT,event TEXT,message TEXT,
      meta_json TEXT,user_id INTEGER,route TEXT,ua TEXT,ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `INSERT INTO auth_accounts (id,email,display_name,color,is_demo)
      VALUES (2,'auth-two@example.test','Auth Two','#123456',0),
             (3,'auth-three@example.test','Auth Three','#654321',0)`,
    `INSERT INTO users (id,name,color) VALUES (2,'Legacy Two','#abcdef'),(4,'Legacy Four','#fedcba')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_groups (
      id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind
    ) VALUES
      (20,10,2,2,NULL,1,'Legacy room','both'),
      (21,10,2,2,NULL,1,'Authenticated room','both'),
      (22,10,2,3,NULL,0,'Authenticated pair','both')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (10,2,0,'users'),(10,3,1,'auth')`,
  ],'write');
  return client;
}

function wrapDatabase(client,{beforeExecute}={}){
  return {
    async execute(statement){
      if(beforeExecute) await beforeExecute(statement,client);
      return client.execute(statement);
    },
    async batch(statements,mode){
      if(beforeExecute){
        for(const statement of statements) await beforeExecute(statement,client);
      }
      return client.batch(statements,mode);
    },
    close:()=>client.close(),
  };
}

function analysisRequest(roomId){
  return invoke({
    method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},headers:{'x-test-user':'2'},
    body:{room_id:roomId,transcript:'We discussed a bounded, source-aware solution.',ai_consent:true},
  });
}

async function counts(client){
  const [consents,sessions,feedback,usage]=await Promise.all([
    client.execute(`SELECT COUNT(*) AS count FROM ai_consents`),
    client.execute(`SELECT COUNT(*) AS count FROM ai_sessions`),
    client.execute(`SELECT COUNT(*) AS count FROM ai_feedback`),
    client.execute(`SELECT COUNT(*) AS count FROM ai_usage`),
  ]);
  return [consents,sessions,feedback,usage].map(result=>Number(result.rows[0].count));
}

afterEach(()=>{
  activeDb?.close?.();
  activeDb=null;
  delete process.env.GROQ_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_ENABLED;
  globalThis.fetch=realFetch;
});


function consentRequest(userId,body,roomId){
  return invoke({method:body?'POST':'GET',url:'/api/ai/consent',query:{endpoint:'consent',...(roomId?{room_id:roomId}:{})},headers:{'x-test-user':String(userId)},body:body||{}});
}
function consentController(doc,responses=[]){
  return mountAiConsent({doc,win:consentWindow,host:{
    userId:()=>2,roomId:()=> 'week_10_pair_21',editProfile(){},
    async request(path,body){
      const response=await consentRequest(2,body,new URL(path,'http://localhost').searchParams.get('room_id'));
      responses.push(response);
      if(response.status!==200) throw {...response.body,http_status:response.status};
      return response.body;
    },
  }});
}
async function ready(){
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  activeDb=wrapDatabase(client);
  return client;
}

test('consent endpoint is caller-only, explicit, authenticated, and has no analysis side effects',async()=>{
  const client=await ready();
  process.env.GROQ_API_KEY='must-not-run';
  let calls=0; globalThis.fetch=async()=>{calls++;throw new Error('no provider');};
  assert.equal((await consentRequest(0,{ai_consent:true,room_id:'week_10_pair_22'})).status,401);
  assert.equal((await consentRequest(2,{ai_consent:'true',room_id:'week_10_pair_22'})).status,400);
  assert.equal((await consentRequest(2,{ai_consent:true,room_id:'manual'})).status,403);
  assert.equal((await consentRequest(7,{ai_consent:true,room_id:'week_10_pair_22'})).status,403);
  assert.equal((await invoke({method:'DELETE',url:'/api/ai/consent'})).status,405);
  const allowed=await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_22',user_id:3});
  assert.equal(allowed.status,200); assert.equal(allowed.body.consented,true);
  assert.equal(allowed.body.pending_participant_count,1);
  assert.deepEqual(await counts(client),[1,0,0,0]);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS n FROM ai_account_monthly_reservations')).rows[0].n),0);
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS n FROM ai_account_monthly_usage')).rows[0].n),0);
  assert.equal(calls,0);
  const other=await consentRequest(3);
  assert.equal(other.body.consented,false); assert.equal(other.body.consented_at,null);
  assert.deepEqual(Object.keys(other.body).sort(),['available','consented','consented_at','policy_version']);
  const banner=await consentRequest(3,null,'week_10_pair_22');
  assert.equal(banner.body.feedback_requested,false); assert.equal(banner.body.pending_participant_count,1);
  const requested=await consentRequest(2,{feedback_requested:true,room_id:'week_10_pair_22'});
  assert.equal(requested.status,200);
  assert.equal((await consentRequest(3,null,'week_10_pair_22')).body.feedback_requested,true);
  assert.equal('participant_ids' in banner.body,false);
  await consentRequest(3,{ai_consent:false,user_id:2});
  assert.equal((await consentRequest(2)).body.consented,true,'a partner cannot withdraw the caller consent');
});

test('analyze backstop NEVER clears revocation or changes a revoked policy/date; only explicit re-consent restores use',async()=>{
  const client=await ready();
  assert.equal((await analysisRequest('week_10_pair_21')).status,200,'backstop handles never-consented solo caller');
  await consentRequest(2,{ai_consent:false});
  await client.execute(`UPDATE ai_consents SET policy_version='old-policy',consented_at='2020-01-01' WHERE user_id=2`);
  const before=(await client.execute('SELECT * FROM ai_consents WHERE user_id=2')).rows[0];
  const blocked=await analysisRequest('week_10_pair_21');
  assert.equal(blocked.status,403); assert.equal(blocked.body.pending_participant_count,1);
  assert.deepEqual((await client.execute('SELECT * FROM ai_consents WHERE user_id=2')).rows[0],before);
  assert.deepEqual(await counts(client),[1,1,1,1]);
  const restored=await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'});
  assert.equal(restored.body.consented,true);
  assert.equal((await client.execute('SELECT revoked_at FROM ai_consents WHERE user_id=2')).rows[0].revoked_at,null);
  assert.equal((await analysisRequest('week_10_pair_21')).status,200);
});

test('two-person and three-person rooms block until everyone consents; revoked partners and legacy identities stay blocked',async()=>{
  const client=await ready();
  process.env.GROQ_API_KEY='must-not-run';
  let calls=0; globalThis.fetch=async()=>{calls++;throw new Error('no provider');};
  let response=await analysisRequest('week_10_pair_22');
  assert.equal(response.status,403); assert.equal(response.body.pending_participant_count,1);
  assert.deepEqual(await counts(client),[1,0,0,0]);
  await consentRequest(3,{ai_consent:true,room_id:'week_10_pair_22'});
  delete process.env.GROQ_API_KEY;
  assert.equal((await analysisRequest('week_10_pair_22')).status,200);
  await consentRequest(3,{ai_consent:false});
  response=await analysisRequest('week_10_pair_22');
  assert.equal(response.status,403); assert.equal(response.body.pending_participant_count,1);
  await client.batch([
    `INSERT INTO auth_accounts (id,email) VALUES (5,'five@example.test')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,5,2,'auth')`,
    `UPDATE pairing_groups SET user_c_id=5 WHERE id=22`,
  ],'write');
  response=await analysisRequest('week_10_pair_22');
  assert.equal(response.status,403); assert.equal(response.body.pending_participant_count,2);
  await consentRequest(3,{ai_consent:true,room_id:'week_10_pair_22'});
  response=await analysisRequest('week_10_pair_22');
  assert.equal(response.body.pending_participant_count,1);
  await consentRequest(5,{ai_consent:true,room_id:'week_10_pair_22'});
  assert.equal((await analysisRequest('week_10_pair_22')).status,200);
  await client.execute(`UPDATE pairing_participants SET source='users' WHERE user_id=5`);
  assert.equal((await analysisRequest('week_10_pair_22')).status,403);
  assert.equal((await consentRequest(3,{ai_consent:true,room_id:'week_10_pair_22'})).status,403);
  assert.equal(calls,0);
});

test('policy-version lapse requires the endpoint, and disabled AI collects no consent while allowing status and withdrawal',async()=>{
  const client=await ready();
  await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'});
  await client.execute(`UPDATE ai_consents SET policy_version='expired'`);
  assert.equal((await consentRequest(2)).body.consented,false);
  assert.equal((await analysisRequest('week_10_pair_21')).status,403);
  assert.equal((await client.execute('SELECT policy_version FROM ai_consents')).rows[0].policy_version,'expired');
  await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'});
  process.env.AI_ENABLED='false';
  assert.equal((await consentRequest(2)).body.available,false);
  assert.equal((await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'})).status,503);
  assert.equal((await analysisRequest('week_10_pair_21')).status,503);
  assert.equal((await consentRequest(2,{ai_consent:false})).body.consented,false);
  assert.deepEqual(await counts(client),[1,0,0,0]);
});

test('revocation retains past feedback in detail and history',async()=>{
  const client=await ready();
  const past=await analysisRequest('week_10_pair_21');
  assert.equal(past.status,200);
  const withdrawn=await consentRequest(2,{ai_consent:false});
  assert.equal(withdrawn.status,200);
  assert.equal(withdrawn.body.consented,false);
  assert.ok((await client.execute('SELECT revoked_at FROM ai_consents WHERE user_id=2')).rows[0].revoked_at);
  assert.equal((await invoke({url:'/api/ai/feedback',query:{endpoint:'feedback',id:past.body.feedback_id},headers:{'x-test-user':'2'}})).status,200);
  const history=await invoke({url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}});
  assert.equal(history.status,200); assert.equal(history.body.feedbacks.length,1);
  assert.deepEqual(await counts(client),[1,1,1,1]);

});

test('consent and explicit feedback requests in room A do not leak into untouched room B',async()=>{
  const client=await ready();
  await client.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES (23,10,2,3,0)`);
  assert.equal((await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_22'})).status,200);
  for(const room of ['week_10_pair_22','week_10_pair_23']){
    const status=await consentRequest(3,null,room);
    assert.equal(status.status,200); assert.equal(status.body.feedback_requested,false);
  }
  assert.equal((await consentRequest(3,{feedback_requested:true,room_id:'week_10_pair_22'})).status,403,'consent is required to request');
  assert.equal((await consentRequest(2,{feedback_requested:true,room_id:'week_10_pair_22'})).status,200);
  assert.equal((await consentRequest(3,null,'week_10_pair_22')).body.feedback_requested,true);
  assert.equal((await consentRequest(3,null,'week_10_pair_23')).body.feedback_requested,false);
  assert.deepEqual(await counts(client),[1,0,0,0]);
  assert.equal((await consentRequest(2,{ai_consent:false})).status,200);
  assert.equal((await consentRequest(3,null,'week_10_pair_22')).body.feedback_requested,false);
});

test('Edit profile cancels a pending analysis confirmation so withdrawal revokes and the next analyze fails',async()=>{
  const client=await ready();
  assert.equal((await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'})).status,200);
  const doc=consentDocument(),responses=[];
  const controller=consentController(doc,responses);
  const pending=controller.prepare(()=>({transcript:'not sent',code:'latest',interviewer_questions:''}));
  await until(()=>!doc.getElementById('aiAnalysisConfirm').hidden);
  const staleSend=doc.button('Send to AI');
  await controller.refreshProfile();
  assert.equal(await pending,null);
  assert.equal(doc.getElementById('aiAnalysisConfirm').hidden,true);
  doc.getElementById('aiWithdrawConsent').click();
  await until(()=>doc.button('Withdraw'));
  staleSend.click(); // A cancelled confirmation cannot clear the withdrawal.
  doc.button('Withdraw').click();
  await until(()=>doc.getElementById('aiConsentStatus').textContent.includes('consent withdrawn'));
  assert.equal(responses.at(-1).status,200);
  assert.equal(responses.at(-1).body.consented,false);
  assert.ok((await client.execute('SELECT revoked_at FROM ai_consents WHERE user_id=2')).rows[0].revoked_at);
  assert.equal((await analysisRequest('week_10_pair_21')).status,403);
  assert.deepEqual(await counts(client),[1,0,0,0]);
});

test('confirmation counts match every captured Groq/OpenAI payload, including retries, and latest code survives',async()=>{
  const raw={transcript:'notes '.repeat(5000),code:JSON.stringify(Array.from({length:6},(_,i)=>({marker:`snapshot-${i}`,code:'x'.repeat(3500)})))+'\nLATEST:\n'+'latest-code-marker\n'+'y'.repeat(6500),interviewer_questions:'questions '.repeat(600)};
  const payload=normalizeAnalysisPayload(raw),confirmation=confirmationText(payload);
  const disclosed=confirmation.match(/notes \((\d+) characters\), code \((\d+) snapshots \+ latest code, (\d+) characters\) and interviewer questions \((\d+) characters\)/).slice(1).map(Number);
  assert.ok(disclosed[1]>0 && disclosed[1]<6);
  for(const mode of ['groq','openai','retry','fallback']){
    const client=await ready();
    assert.equal((await consentRequest(2,{ai_consent:true,room_id:'week_10_pair_21'})).status,200);
    const doc=consentDocument(),controller=consentController(doc);
    const pending=controller.prepare(()=>raw);
    await until(()=>!doc.getElementById('aiAnalysisConfirm').hidden);
    assert.ok(doc.getElementById('aiAnalysisConfirm').textContent.startsWith(confirmation));
    doc.button('Send to AI').click();
    const confirmed=await pending;
    assert.deepEqual(confirmed,{...payload,ai_consent:true});
    if(mode!=='openai') process.env.GROQ_API_KEY='test';
    if(mode==='openai'||mode==='fallback') process.env.OPENAI_API_KEY='test';
    const captured=[];
    globalThis.fetch=async(url,options)=>{
      const prompt=JSON.parse(options.body).messages.at(-1).content;
      captured.push(prompt);
      if((mode==='retry'&&captured.length===1)||(mode==='fallback'&&String(url).includes('groq'))) return new Response('{}',{status:503});
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({candidate:{strengths:[],improvements:[]},interviewer:{strengths:[],improvements:[]},overall_score:7,next_time_checklist:[]})}}]}));
    };
    const result=await invoke({method:'POST',url:'/api/ai/analyze',headers:{'x-test-user':'2'},body:{...confirmed,room_id:'week_10_pair_21'}});
    assert.equal(result.status,200,mode);
    assert.equal(captured.length,{groq:1,openai:1,retry:2,fallback:3}[mode]);
    for(const prompt of captured){
      const notes=prompt.split('TRANSCRIPT:\n')[1].split('\nCODE:\n')[0];
      const code=prompt.split('\nCODE:\n')[1].split('\nINTERVIEWER QS:\n')[0];
      const questions=prompt.split('\nINTERVIEWER QS:\n')[1].split('\nProduce STRICT JSON only:')[0];
      const [snapshots,latest]=code.split('\nLATEST:\n');
      assert.deepEqual([notes.length,JSON.parse(snapshots).length,latest.length,questions.length],disclosed,mode);
      assert.equal(code,payload.code,mode);
      assert.ok(latest.startsWith('latest-code-marker\n'),mode);
      assert.ok(latest.endsWith('y'.repeat(6500)),mode);
    }
    client.close(); activeDb=null;
    delete process.env.GROQ_API_KEY; delete process.env.OPENAI_API_KEY;
  }
});

test('atomic feedback insert refuses caller or partner consent revoked during provider work, keeping quota consumed',async()=>{
  for(const revoker of [2,3]){
    const client=await ready();
    await consentRequest(3,{ai_consent:true,room_id:'week_10_pair_22'});
    process.env.GROQ_API_KEY='test';
    globalThis.fetch=async()=>{
      await consentRequest(revoker,{ai_consent:false});
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({candidate:{strengths:[],improvements:[]},interviewer:{strengths:[],improvements:[]},overall_score:7,next_time_checklist:[]})}}]}));
    };
    const result=await analysisRequest('week_10_pair_22');
    assert.equal(result.status,403); assert.equal(result.body.processing_started,true);
    assert.equal(result.body.pending_participant_count,1);
    assert.deepEqual(await counts(client),[2,1,0,0]);
    assert.equal(Number((await client.execute('SELECT calls FROM ai_account_monthly_usage')).rows[0].calls),1);
    client.close(); activeDb=null;
  }
});
