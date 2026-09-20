import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

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

test('AI method, authentication, consent, and input checks precede readiness',async()=>{
  process.env.AI_ENABLED='true';
  let databaseCalls=0;
  activeDb={
    async execute(){ databaseCalls+=1; throw new Error('readiness must not run'); },
    async batch(){ databaseCalls+=1; throw new Error('readiness must not run'); },
  };
  const cases=[
    {request:{method:'GET',url:'/api/ai/analyze',query:{endpoint:'analyze'},headers:{'x-test-user':'2'}},status:405},
    {request:{method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},body:{ai_consent:true,transcript:'valid'}},status:401},
    {request:{method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},headers:{'x-test-user':'2'},body:{transcript:'valid'}},status:403},
    {request:{method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},headers:{'x-test-user':'2'},body:{ai_consent:true}},status:400},
    {request:{method:'POST',url:'/api/ai/analyze',query:{endpoint:'analyze'},headers:{'x-test-user':'2'},body:{ai_consent:true,transcript:'valid',room_id:'not-a-room'}},status:403},
    {request:{method:'POST',url:'/api/ai/feedback',query:{endpoint:'feedback'},headers:{'x-test-user':'2'}},status:405},
    {request:{method:'GET',url:'/api/ai/feedback',query:{endpoint:'feedback'}},status:401},
    {request:{method:'POST',url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}},status:405},
    {request:{method:'GET',url:'/api/ai/history',query:{endpoint:'history'}},status:401},
  ];

  for(const item of cases){
    const response=await invoke(item.request);
    assert.equal(response.status,item.status,JSON.stringify(item.request));
  }
  assert.equal(databaseCalls,0);
});

test('AI analysis rejects a colliding legacy identity and accepts the same id only with auth provenance',async()=>{
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  activeDb=wrapDatabase(client);

  const legacy=await analysisRequest('week_10_pair_20');
  assert.equal(legacy.status,403);
  assert.deepEqual(legacy.body,{error:'trusted room membership required'});
  assert.deepEqual(await counts(client),[0,0,0,0]);

  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  await client.execute(`UPDATE pairing_participants SET source='users' WHERE week_id=10 AND user_id=3`);
  const mixed=await analysisRequest('week_10_pair_22');
  assert.equal(mixed.status,403);
  assert.deepEqual(mixed.body,{error:'trusted room membership required'});
  assert.deepEqual(await counts(client),[0,0,0,0]);

  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=3`);
  const authenticated=await analysisRequest('week_10_pair_21');
  assert.equal(authenticated.status,200);
  assert.equal(authenticated.body.session_id,1);
  assert.equal(authenticated.body.feedback_id,1);
  assert.deepEqual(await counts(client),[1,1,1,1]);
});

test('AI analysis fails closed before consent, quota, session, feedback, or provider work for every missing contract',async()=>{
  process.env.AI_ENABLED='true';
  process.env.GROQ_API_KEY='test-groq-key';
  const contracts=[
    'auth_accounts','pairing_weeks','pairing_groups','pairing_participants','ai_sessions',
    'ai_feedback','ai_usage','ai_account_monthly_usage',
    'ai_account_monthly_reservations','ai_consents',
  ];

  for(const table of contracts){
    const client=await createDatabase();
    await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
    const statements=[];
    activeDb=wrapDatabase(client,{
      beforeExecute:async statement=>{
        const sql=typeof statement==='string'?statement:String(statement?.sql||'');
        statements.push(sql);
        if(new RegExp(`FROM\\s+${table}\\s+LIMIT\\s+0`,'iu').test(sql)){
          throw new Error(`missing ${table}`);
        }
      },
    });
    let providerCalls=0;
    globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not run'); };

    const response=await analysisRequest('week_10_pair_21');
    assert.equal(response.status,503,table);
    assert.deepEqual(response.body,{error:'AI service temporarily unavailable'},table);
    assert.deepEqual(await counts(client),[0,0,0,0],table);
    assert.equal(providerCalls,0,table);
    assert.equal(statements.some(sql=>/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)),false,table);
    client.close();
    activeDb=null;
  }
});

test('AI feedback and history fail closed on stale route contracts without writes',async()=>{
  for(const request of [
    {url:'/api/ai/feedback?id=1',query:{endpoint:'feedback',id:'1'},missing:'ai_feedback'},
    {url:'/api/ai/history',query:{endpoint:'history'},missing:'ai_usage'},
  ]){
    const client=await createDatabase();
    const statements=[];
    activeDb=wrapDatabase(client,{
      beforeExecute:async statement=>{
        const sql=typeof statement==='string'?statement:String(statement?.sql||'');
        statements.push(sql);
        if(new RegExp(`FROM\\s+${request.missing}\\s+LIMIT\\s+0`,'iu').test(sql)){
          throw new Error(`stale ${request.missing}`);
        }
      },
    });

    const response=await invoke({...request,headers:{'x-test-user':'2'}});
    assert.equal(response.status,503,request.missing);
    assert.deepEqual(response.body,{error:'AI service temporarily unavailable'},request.missing);
    assert.deepEqual(await counts(client),[0,0,0,0],request.missing);
    assert.equal(statements.some(sql=>/^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)),false,request.missing);
    client.close();
    activeDb=null;
  }
});

test('AI logging readiness failure is read-only and cannot hide an analyze result',async()=>{
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  const statements=[];
  activeDb=wrapDatabase(client,{
    beforeExecute:async statement=>{
      const sql=typeof statement==='string'?statement:String(statement?.sql||'');
      statements.push(sql);
      if(/FROM\s+app_logs\s+LIMIT\s+0/iu.test(sql)) throw new Error('diagnostic logging unavailable');
    },
  });

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(await counts(client),[1,1,1,1]);
  assert.equal(statements.some(sql=>sql.includes('INSERT INTO app_logs')),false);
  assert.equal(statements.some(sql=>/^\s*(?:CREATE|ALTER|DROP)\b/iu.test(sql)),false);
});

test('account quota survives room deletion and same-id legacy recreation without importing the legacy ledger',async()=>{
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  const month=new Date().toISOString().slice(0,7);
  await client.execute({
    sql:`INSERT INTO ai_monthly_usage (month,user_id,calls,tokens_in) VALUES (?,?,?,?)`,
    args:[month,2,99,999],
  });
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  activeDb=wrapDatabase(client);

  const analyzed=await analysisRequest('week_10_pair_21');
  assert.equal(analyzed.status,200,JSON.stringify(analyzed.body));
  assert.equal(analyzed.body.quota.calls_this_month,1,
    'an ambiguous row from the unused legacy ledger must not enter account quota');
  const stored=await client.execute({
    sql:`SELECT month,user_id,calls,tokens_in FROM ai_account_monthly_usage WHERE month=? AND user_id=?`,
    args:[month,2],
  });
  assert.equal(stored.rows.length,1);
  assert.equal(Number(stored.rows[0].calls),1);
  assert.ok(Number(stored.rows[0].tokens_in)>0);
  const schema=await client.execute(`PRAGMA table_info('ai_account_monthly_usage')`);
  assert.deepEqual(schema.rows.filter(column=>Number(column.pk)>0)
    .sort((left,right)=>Number(left.pk)-Number(right.pk))
    .map(column=>String(column.name)),['month','user_id']);

  await client.execute(`DELETE FROM pairing_groups WHERE id=21 AND week_id=10`);
  const afterDeletion=await invoke({url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}});
  assert.equal(afterDeletion.status,200);
  assert.equal(Number(afterDeletion.body.monthly.count),1);
  assert.deepEqual(afterDeletion.body.feedbacks,[]);

  await client.execute(`UPDATE pairing_participants SET source='users' WHERE week_id=10 AND user_id=2`);
  await client.execute(`INSERT INTO pairing_groups
    (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
    VALUES (21,10,2,2,NULL,1,'Recreated legacy room','both')`);
  const afterRecreation=await invoke({url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}});
  assert.equal(afterRecreation.status,200);
  assert.equal(Number(afterRecreation.body.monthly.count),1);
  assert.deepEqual(afterRecreation.body.feedbacks,[]);
  const legacy=await client.execute({sql:`SELECT calls FROM ai_monthly_usage WHERE month=?`,args:[month]});
  assert.equal(Number(legacy.rows[0].calls),99,'the additive rollout must leave the ambiguous legacy table untouched');
});

test('monthly quota consumption is atomic before provider work',async()=>{
  process.env.AI_ENABLED='true';
  process.env.GROQ_API_KEY='test-groq-key';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  activeDb=wrapDatabase(client);
  const warm=await invoke({url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}});
  assert.equal(warm.status,200);
  const month=new Date().toISOString().slice(0,7);
  await client.execute({
    sql:`INSERT INTO ai_account_monthly_usage (month,user_id,calls,tokens_in) VALUES (?,?,?,?)`,
    args:[month,2,499,0],
  });

  let preflightReads=0;
  let releaseReads;
  const bothReads=new Promise(resolve=>{ releaseReads=resolve; });
  activeDb={
    async execute(statement){
      const sql=typeof statement==='string'?statement:String(statement?.sql||'');
      if(sql.includes('SELECT calls FROM ai_account_monthly_usage')&&preflightReads<2){
        const result=await client.execute(statement);
        preflightReads+=1;
        if(preflightReads===2) releaseReads();
        await bothReads;
        return result;
      }
      return client.execute(statement);
    },
    batch:(statements,mode)=>client.batch(statements,mode),
    close:()=>client.close(),
  };
  let providerCalls=0;
  globalThis.fetch=async()=>{
    providerCalls+=1;
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({
        candidate:{strengths:[],improvements:[]},
        interviewer:{strengths:[],improvements:[]},
        overall_score:7,
        next_time_checklist:['Keep practising'],
      })}}],
      usage:{prompt_tokens:10,completion_tokens:5},
    }),{status:200});
  };

  const responses=await Promise.all([
    analysisRequest('week_10_pair_21'),
    analysisRequest('week_10_pair_21'),
  ]);
  assert.deepEqual(responses.map(response=>response.status).sort((a,b)=>a-b),[200,429]);
  assert.equal(providerCalls,1,'the atomic quota loser must stop before provider work');
  const limited=responses.find(response=>response.status===429);
  assert.equal(limited.body.count,500);
  const stored=await client.execute({
    sql:`SELECT calls FROM ai_account_monthly_usage WHERE month=? AND user_id=?`,
    args:[month,2],
  });
  assert.equal(Number(stored.rows[0].calls),500);
  const sessions=await client.execute(`SELECT COUNT(*) AS count FROM ai_sessions`);
  assert.equal(Number(sessions.rows[0].count),1,'the quota loser must not persist transcript or code');
});

test('AI consent and session creation fail closed when membership changes after the room read',async()=>{
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  let revoked=false;
  activeDb=wrapDatabase(client,{
    beforeExecute:async statement=>{
      const sql=typeof statement==='string'?statement:String(statement?.sql||'');
      if(!revoked&&sql.includes('INSERT INTO ai_consents')){
        revoked=true;
        await client.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
      }
    },
  });

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,403);
  assert.deepEqual(response.body,{error:'trusted room membership required'});
  assert.equal(revoked,true);
  assert.deepEqual(await counts(client),[0,0,0,0]);
});

test('AI session insert atomically rechecks membership after consent succeeds',async()=>{
  process.env.AI_ENABLED='true';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  let revoked=false;
  activeDb=wrapDatabase(client,{
    beforeExecute:async statement=>{
      const sql=typeof statement==='string'?statement:String(statement?.sql||'');
      if(!revoked&&sql.includes('INSERT INTO ai_sessions')){
        revoked=true;
        await client.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
      }
    },
  });

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,403);
  assert.deepEqual(response.body,{error:'trusted room membership required'});
  assert.equal(revoked,true);
  assert.deepEqual(await counts(client),[1,0,0,0]);
  const quota=await client.execute(`SELECT calls FROM ai_account_monthly_usage`);
  assert.equal(Number(quota.rows[0].calls),0,'a failed pre-provider session write refunds its reservation');
  const reservation=await client.execute(`SELECT session_id,refunded_at FROM ai_account_monthly_reservations`);
  assert.equal(reservation.rows[0].session_id,null);
  assert.ok(reservation.rows[0].refunded_at);
});

test('AI session storage errors refund only their unattached reservation before provider work',async()=>{
  process.env.AI_ENABLED='true';
  process.env.GROQ_API_KEY='test-groq-key';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  activeDb=wrapDatabase(client,{
    beforeExecute:async statement=>{
      const sql=typeof statement==='string'?statement:String(statement?.sql||'');
      if(sql.includes('INSERT INTO ai_sessions')) throw new Error('session storage unavailable');
    },
  });
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not run'); };

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,500);
  assert.deepEqual(response.body,{error:'session create failed'});
  assert.equal(providerCalls,0);
  assert.deepEqual(await counts(client),[1,0,0,0]);
  const quota=await client.execute(`SELECT calls FROM ai_account_monthly_usage`);
  assert.equal(Number(quota.rows[0].calls),0);
  const reservations=await client.execute(`SELECT session_id,refunded_at FROM ai_account_monthly_reservations`);
  assert.equal(reservations.rows.length,1);
  assert.equal(reservations.rows[0].session_id,null);
  assert.ok(reservations.rows[0].refunded_at);
});

test('an ambiguous committed session error cannot refund a persisted private session',async()=>{
  process.env.AI_ENABLED='true';
  process.env.GROQ_API_KEY='test-groq-key';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  let lostSessionResponse=false;
  activeDb={
    execute:statement=>client.execute(statement),
    async batch(statements,mode){
      const results=await client.batch(statements,mode);
      const first=typeof statements[0]==='string'?statements[0]:String(statements[0]?.sql||'');
      if(!lostSessionResponse&&first.includes('INSERT INTO ai_sessions')){
        lostSessionResponse=true;
        throw new Error('response lost after commit');
      }
      return results;
    },
    close:()=>client.close(),
  };
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not run'); };

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,500);
  assert.equal(providerCalls,0);
  assert.equal(Number((await client.execute(`SELECT COUNT(*) AS count FROM ai_sessions`)).rows[0].count),1);
  assert.equal(Number((await client.execute(`SELECT calls FROM ai_account_monthly_usage`)).rows[0].calls),1,
    'the attached reservation must stay consumed when the session commit outcome was ambiguous');
  const reservation=await client.execute(`SELECT session_id,refunded_at FROM ai_account_monthly_reservations`);
  assert.equal(Number(reservation.rows[0].session_id),1);
  assert.equal(reservation.rows[0].refunded_at,null);
});

test('AI feedback insert rechecks membership after provider work and records no result on revocation',async()=>{
  process.env.AI_ENABLED='true';
  process.env.GROQ_API_KEY='test-groq-key';
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  activeDb=wrapDatabase(client);
  let providerCalls=0;
  globalThis.fetch=async()=>{
    providerCalls+=1;
    await client.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({
        candidate:{strengths:[],improvements:[]},
        interviewer:{strengths:[],improvements:[]},
        overall_score:7,
        next_time_checklist:['Recheck authorization'],
      })}}],
      usage:{prompt_tokens:10,completion_tokens:5},
    }),{status:200});
  };

  const response=await analysisRequest('week_10_pair_21');
  assert.equal(response.status,403);
  assert.deepEqual(response.body,{error:'trusted room membership required'});
  assert.equal(providerCalls,1);
  assert.deepEqual(await counts(client),[1,1,0,0]);
  const quota=await client.execute(`SELECT calls FROM ai_account_monthly_usage`);
  assert.equal(Number(quota.rows[0].calls),1,'provider work permanently consumes the attached reservation');
  const reservation=await client.execute(`SELECT session_id,refunded_at FROM ai_account_monthly_reservations`);
  assert.equal(Number(reservation.rows[0].session_id),1);
  assert.equal(reservation.rows[0].refunded_at,null);
});

test('feedback detail and histories exclude numeric-owner collisions in legacy-source rooms',async()=>{
  const client=await createDatabase();
  await client.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  // Preserve an explicit legacy room in a separate week so the same numeric id
  // has two different identity namespaces without violating the snapshot PK.
  await client.batch([
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (11,'2026-W37','2026-09-07T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
      VALUES (30,11,2,4,NULL,0,'Legacy pair','both')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (11,2,0,'users'),(11,4,1,'users')`,
    `INSERT INTO ai_sessions (id,room_id,pair_label,transcript,created_by)
      VALUES (100,'week_11_pair_30','Legacy','legacy private transcript',2),
             (101,'week_10_pair_21','Authenticated','owned transcript',2)`,
    `INSERT INTO ai_feedback (id,session_id,role,feedback_json,model_used,confidence)
      VALUES (200,100,'both','{"secret":"legacy"}','mock',0.8),
             (201,101,'both','{"summary":"owned"}','mock',0.9)`,
  ],'write');
  activeDb=wrapDatabase(client);

  const legacy=await invoke({url:'/api/ai/feedback?id=200',query:{endpoint:'feedback',id:'200'},headers:{'x-test-user':'2'}});
  assert.equal(legacy.status,404);
  assert.equal(JSON.stringify(legacy.body).includes('legacy'),false);

  const owned=await invoke({url:'/api/ai/feedback?id=201',query:{endpoint:'feedback',id:'201'},headers:{'x-test-user':'2'}});
  assert.equal(owned.status,200);
  assert.deepEqual(owned.body.feedback,{summary:'owned'});

  const feedbackList=await invoke({url:'/api/ai/feedback',query:{endpoint:'feedback'},headers:{'x-test-user':'2'}});
  assert.deepEqual(feedbackList.body.feedbacks.map(row=>Number(row.id)),[201]);
  const history=await invoke({url:'/api/ai/history',query:{endpoint:'history'},headers:{'x-test-user':'2'}});
  assert.deepEqual(history.body.feedbacks.map(row=>Number(row.id)),[201]);
  assert.equal(JSON.stringify([feedbackList.body,history.body]).includes('legacy'),false);
});
