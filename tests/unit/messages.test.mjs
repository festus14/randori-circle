import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import {
  ensureMessagesReadiness,
  MAX_MESSAGES_PER_ROOM,
  MAX_MESSAGES_PER_USER_PER_MINUTE,
  MESSAGE_RATE_RETRY_SECONDS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_CODE_POINTS,
  MessageDataError,
  MessageInputError,
  normalizeMessageTimestamp,
  parseMessageSend,
  parseMessagesQuery,
  projectMessage,
  validateMessagesPostQuery,
} from '../../api/_messages.js';

let currentDb=null;

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test',name:'Member'};
  if(identity==='partner') return {id:4,email:'partner@example.test',name:'Partner'};
  if(identity==='third') return {id:6,email:'third@example.test',name:'Third'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test',name:'Outsider'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getJwtSecret:()=>'message-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,
  },
});

const {default:dataHandler}=await import('../../api/data.js');

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function invoke({method='GET',url='/api/messages',query={endpoint:'messages'},headers={'x-test-auth':'member'},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const res={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      end(payload){ finish(payload); },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function readyDatabase(){
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE auth_accounts (
    id INTEGER PRIMARY KEY, display_name TEXT NOT NULL
  )`);
  await db.execute(`INSERT INTO auth_accounts (id,display_name) VALUES
    (2,'Member'),(4,'Partner'),(6,'Third'),(9,'Outsider')`);
  await db.execute(`CREATE TABLE pairing_groups (
    id INTEGER PRIMARY KEY, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL, user_c_id INTEGER
  )`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES
    (20,10,2,4,6),(21,10,4,9,NULL),(22,11,2,4,NULL)`);
  await db.execute(`CREATE TABLE pair_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL,
    pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
    message TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  return db;
}

function tracedClient(delegate,calls){
  return {
    async execute(statement){
      calls.push({sql:sqlText(statement),args:statement?.args||[]});
      return delegate.execute(statement);
    },
    async batch(statements,mode){
      for(const statement of statements) calls.push({sql:sqlText(statement),args:statement?.args||[]});
      return delegate.batch(statements,mode);
    },
    close(){ return delegate.close(); },
  };
}

beforeEach(()=>{
  currentDb=null;
  delete process.env.TURSO_DATABASE_URL;
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
});

test('message request parsing accepts only canonical rooms and strict bounded cursors',()=>{
  assert.deepEqual(parseMessagesQuery({
    url:'/api/messages',
    query:{endpoint:'messages',room_id:'week_10_pair_20'},
  }),{
    roomId:'week_10_pair_20',weekId:10,pairGroupId:20,afterId:0,limit:50,
  });
  assert.deepEqual(parseMessagesQuery({
    url:'/api/data?endpoint=messages&room_id=week_10_pair_20&after_id=42&limit=1',
    query:{endpoint:'messages',room_id:'week_10_pair_20',after_id:'42',limit:'1'},
  }),{
    roomId:'week_10_pair_20',weekId:10,pairGroupId:20,afterId:42,limit:1,
  });
  assert.deepEqual(parseMessagesQuery({
    url:'/api/messages',
    query:{endpoint:'messages',room_id:'week_10_pair_20',after_id:String(Number.MAX_SAFE_INTEGER),limit:'50'},
  }),{
    roomId:'week_10_pair_20',weekId:10,pairGroupId:20,afterId:Number.MAX_SAFE_INTEGER,limit:50,
  });

  for(const req of [
    {url:'/api/messages',query:{}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_01_pair_2'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',week_id:'1'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:['week_1_pair_2','week_2_pair_3']}},
    {url:'/api/messages?room_id=week_1_pair_2&room_id=week_2_pair_3',query:{endpoint:'messages'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',after_id:'-1'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',after_id:'01'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',after_id:'1.5'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',after_id:String(Number.MAX_SAFE_INTEGER+1)}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',limit:'0'}},
    {url:'/api/messages',query:{endpoint:'messages',room_id:'week_1_pair_2',limit:'51'}},
    {url:'/api/messages',query:{endpoint:['messages','messages'],room_id:'week_1_pair_2'}},
  ]) assert.throws(()=>parseMessagesQuery(req),MessageInputError);

  assert.equal(validateMessagesPostQuery({url:'/api/messages',query:{endpoint:'messages'}}),true);
  for(const req of [
    {url:'/api/messages?week_id=10',query:{endpoint:'messages',week_id:'10'}},
    {url:'/api/messages?room_id=week_10_pair_20',query:{endpoint:'messages'}},
    {url:'/api/data?endpoint=messages&endpoint=messages',query:{}},
  ]) assert.throws(()=>validateMessagesPostQuery(req),MessageInputError);
});

test('message sends require exact fields and enforce character and byte limits without coercion',()=>{
  assert.deepEqual(parseMessageSend({room_id:'week_10_pair_20',message:'  hello pair  '}),{
    roomId:'week_10_pair_20',weekId:10,pairGroupId:20,message:'hello pair',
  });
  const maximumEmoji='😀'.repeat(MAX_MESSAGE_CODE_POINTS);
  assert.equal(Buffer.byteLength(maximumEmoji,'utf8'),MAX_MESSAGE_BYTES);
  assert.equal(parseMessageSend({room_id:'week_10_pair_20',message:maximumEmoji}).message,maximumEmoji);

  for(const body of [
    null,[],{},
    {room_id:'week_10_pair_20',message:'ok',extra:true},
    {room_id:'week_10_pair_20',message:'ok',week_id:10},
    {room_id:'week_10_pair_20',message:42},
    {room_id:'week_10_pair_20',message:{}},
    {room_id:'week_10_pair_20',message:'   '},
    {room_id:'week_01_pair_20',message:'hello'},
  ]) assert.throws(()=>parseMessageSend(body),error=>error instanceof MessageInputError&&error.statusCode===400);

  for(const message of ['x'.repeat(MAX_MESSAGE_CODE_POINTS+1),'😀'.repeat(MAX_MESSAGE_CODE_POINTS+1)]){
    assert.throws(
      ()=>parseMessageSend({room_id:'week_10_pair_20',message}),
      error=>error instanceof MessageInputError&&error.statusCode===413,
    );
  }
});

test('message projection exposes only safe fields and canonical UTC timestamps',()=>{
  assert.deepEqual(projectMessage({
    id:7,sender_id:2,sender_name:' Member ',message:'hello',created_at:'2026-09-18 06:07:08',
    email:'private@example.test',password_hash:'private',
  }),{
    id:7,sender_id:2,sender_name:'Member',message:'hello',created_at:'2026-09-18T06:07:08.000Z',
  });
  assert.equal(normalizeMessageTimestamp('2026-09-18T07:07:08+01:00'),'2026-09-18T06:07:08.000Z');
  assert.equal(normalizeMessageTimestamp('2024-02-29 23:59:59.123456'),'2024-02-29T23:59:59.123Z');
  for(const timestamp of ['2026-02-29 00:00:00','2026-01-01','now',42,null]){
    assert.equal(normalizeMessageTimestamp(timestamp),null,String(timestamp));
  }
  assert.throws(()=>projectMessage({id:0,sender_id:2,message:'x',created_at:'2026-09-18 06:07:08'}),MessageDataError);
  assert.throws(()=>projectMessage({id:1,sender_id:2,message:'x'.repeat(2001),created_at:'2026-09-18 06:07:08'}),MessageDataError);
});

test('message schema readiness coalesces concurrent probes and retries after failure',async()=>{
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  let calls=0;
  const coalesced={
    async execute(){
      calls+=1;
      if(calls===1) await gate;
      return {rows:[]};
    },
  };
  const first=ensureMessagesReadiness(coalesced);
  const second=ensureMessagesReadiness(coalesced);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  release();
  await Promise.all([first,second]);
  assert.equal(calls,2);
  await ensureMessagesReadiness(coalesced);
  assert.equal(calls,2,'successful readiness remains cached');

  let attempts=0;
  const retryable={
    async execute(){
      attempts+=1;
      if(attempts===1) throw new Error('missing table');
      return {rows:[]};
    },
  };
  await assert.rejects(()=>ensureMessagesReadiness(retryable),/missing table/);
  await ensureMessagesReadiness(retryable);
  assert.equal(attempts,3,'a rejected readiness promise is evicted before retry');
});

test('messages reject unauthenticated and malformed requests before database access',async()=>{
  const calls=[];
  currentDb={async execute(statement){ calls.push(sqlText(statement)); throw new Error('must not query'); }};

  const unauthenticated=await invoke({
    url:'/api/messages',query:{endpoint:'messages',room_id:'week_10_pair_20'},headers:{},
  });
  assert.equal(unauthenticated.status,401);
  assert.equal(unauthenticated.headers['cache-control'],'private, no-store');

  const malformed=await invoke({
    url:'/api/messages',query:{endpoint:'messages',room_id:'week_10_pair_20x'},
  });
  assert.equal(malformed.status,400);

  const oversized=await invoke({
    method:'POST',body:{room_id:'week_10_pair_20',message:'x'.repeat(2001)},
  });
  assert.equal(oversized.status,413);
  const legacyQuery=await invoke({
    method:'POST',url:'/api/messages?week_id=10',query:{endpoint:'messages',week_id:'10'},
    body:{room_id:'week_10_pair_20',message:'hello'},
  });
  assert.equal(legacyQuery.status,400);
  assert.equal(calls.length,0);

  const method=await invoke({method:'DELETE'});
  assert.equal(method.status,405);
  assert.equal(method.headers.allow,'GET, POST');
});

test('message reads enforce exact membership and isolate week and pair rows',async()=>{
  const database=await readyDatabase();
  await database.batch([
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (1,10,20,2,'old','2026-09-18 06:00:00')`},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (2,11,20,2,'wrong week','2026-09-18 06:01:00')`},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (3,10,21,4,'wrong pair','2026-09-18 06:02:00')`},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (4,10,20,4,'middle','2026-09-18 06:03:00')`},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (5,10,20,6,'newest','2026-09-18 06:04:00')`},
  ],'write');
  const calls=[];
  currentDb=tracedClient(database,calls);

  const bootstrap=await invoke({
    query:{endpoint:'messages',room_id:'week_10_pair_20',after_id:'0',limit:'2'},
  });
  assert.equal(bootstrap.status,200);
  assert.equal(bootstrap.headers['cache-control'],'private, no-store');
  assert.equal(bootstrap.body.room_id,'week_10_pair_20');
  assert.deepEqual(bootstrap.body.messages.map(message=>message.id),[4,5]);
  assert.equal(bootstrap.body.after,5);
  assert.deepEqual(Object.keys(bootstrap.body.messages[0]).sort(),[
    'created_at','id','message','sender_id','sender_name',
  ]);
  assert.equal(bootstrap.body.messages[0].sender_name,'Partner');
  assert.equal(bootstrap.body.messages[0].created_at,'2026-09-18T06:03:00.000Z');

  const incremental=await invoke({
    query:{endpoint:'messages',room_id:'week_10_pair_20',after_id:'1',limit:'1'},
    headers:{'x-test-auth':'third'},
  });
  assert.equal(incremental.status,200,'user_c is an exact room member');
  assert.deepEqual(incremental.body.messages.map(message=>message.id),[4]);
  assert.equal(incremental.body.after,4);

  const empty=await invoke({
    query:{endpoint:'messages',room_id:'week_10_pair_20',after_id:'5',limit:'50'},
  });
  assert.deepEqual(empty.body.messages,[]);
  assert.equal(empty.body.after,5);

  const outsider=await invoke({
    query:{endpoint:'messages',room_id:'week_10_pair_20'},headers:{'x-test-auth':'outsider'},
  });
  assert.equal(outsider.status,404);
  assert.deepEqual(outsider.body,{error:'pair not found'});
  const messageAccessesBeforeForbiddenPost=calls.filter(call=>call.sql.includes('pair_messages')).length;
  const forbiddenPost=await invoke({
    method:'POST',headers:{'x-test-auth':'outsider'},
    body:{room_id:'week_10_pair_20',message:'not allowed'},
  });
  assert.equal(forbiddenPost.status,404);
  assert.deepEqual(forbiddenPost.body,outsider.body);
  assert.equal(
    calls.filter(call=>call.sql.includes('pair_messages')).length,
    messageAccessesBeforeForbiddenPost,
    'a nonmember never reaches message schema or storage',
  );
  const absent=await invoke({query:{endpoint:'messages',room_id:'week_11_pair_20'}});
  assert.equal(absent.status,404,'the same pair id in another week does not authorize access');
  assert.deepEqual(absent.body,outsider.body,'absent and unauthorized rooms are indistinguishable');
  const absentPost=await invoke({
    method:'POST',body:{room_id:'week_11_pair_20',message:'not allowed'},
  });
  assert.equal(absentPost.status,404);
  assert.deepEqual(absentPost.body,outsider.body,'POST also hides whether the room exists');
  assert.equal(calls.some(call=>/\b(?:CREATE|ALTER|DROP)\b/i.test(call.sql)),false);

  const firstMessageRead=calls.findIndex(call=>call.sql.includes('FROM pair_messages pm'));
  const firstAccess=calls.findIndex(call=>call.sql.includes('FROM pairing_groups'));
  assert.ok(firstAccess>=0&&firstMessageRead>firstAccess,'membership is checked before message reads');
});

test('message reads re-authorize inside the storage query when membership changes after the precheck',async()=>{
  const database=await readyDatabase();
  await database.execute({
    sql:`INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?)`,
    args:[10,20,4,'must stay private','2026-09-18 06:00:00'],
  });
  let revoked=false;
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(!revoked&&sql.includes('FROM pair_messages pm')){
        revoked=true;
        await database.execute(`UPDATE pairing_groups SET user_a_id=9 WHERE id=20 AND week_id=10`);
      }
      return database.execute(statement);
    },
    close(){ return database.close(); },
  };

  const response=await invoke({query:{endpoint:'messages',room_id:'week_10_pair_20'}});
  assert.equal(revoked,true);
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
  assert.doesNotMatch(JSON.stringify(response.body),/must stay private/);
});

test('message sends derive identity, close the membership race, and do not fake idempotency',async()=>{
  const database=await readyDatabase();
  const calls=[];
  currentDb=tracedClient(database,calls);
  const request={
    method:'POST',
    body:{room_id:'week_10_pair_20',message:'  Sunday works  '},
  };
  const first=await invoke(request);
  const second=await invoke(request);
  assert.equal(first.status,201);
  assert.equal(second.status,201);
  assert.equal(first.body.room_id,'week_10_pair_20');
  assert.equal(first.body.message.message,'Sunday works');
  assert.equal(first.body.message.sender_id,2);
  assert.equal(first.body.message.sender_name,'Member');
  assert.match(first.body.message.created_at,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.notEqual(first.body.message.id,second.body.message.id,'repeated POSTs are explicitly not idempotent without schema support');

  const stored=await database.execute(`SELECT week_id,pair_group_id,sender_id,message FROM pair_messages ORDER BY id`);
  assert.deepEqual(stored.rows.map(row=>({...row})),[
    {week_id:10,pair_group_id:20,sender_id:2,message:'Sunday works'},
    {week_id:10,pair_group_id:20,sender_id:2,message:'Sunday works'},
  ]);
  const inserts=calls.filter(call=>call.sql.includes('INSERT INTO pair_messages'));
  assert.equal(inserts.length,2);
  assert.ok(inserts.every(call=>call.sql.includes('WHERE EXISTS')));
  assert.equal(calls.some(call=>call.sql.includes('WHERE pm.id=')),false,'send has no fallible post-write lookup');
});

test('message sends enforce the durable per-user rate limit atomically',async()=>{
  const database=await readyDatabase();
  await database.execute(`WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<${MAX_MESSAGES_PER_USER_PER_MINUTE-1}
  ) INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message,created_at)
    SELECT 11,22,2,'recent-'||n,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM seq`);
  currentDb=database;

  const request={method:'POST',body:{room_id:'week_10_pair_20',message:'concurrent'}};
  const responses=await Promise.all([invoke(request),invoke(request)]);
  assert.deepEqual(responses.map(response=>response.status).sort((a,b)=>a-b),[201,429]);
  const limited=responses.find(response=>response.status===429);
  assert.equal(limited.headers['retry-after'],String(MESSAGE_RATE_RETRY_SECONDS));
  assert.deepEqual(limited.body,{error:'message rate limit exceeded'});
  const count=await database.execute({
    sql:`SELECT COUNT(*) AS count FROM pair_messages
      WHERE sender_id=? AND datetime(created_at)>=datetime('now','-1 minute')`,
    args:[2],
  });
  assert.equal(Number(count.rows[0].count),MAX_MESSAGES_PER_USER_PER_MINUTE);
});

test('message sends enforce the durable room cap atomically',async()=>{
  const database=await readyDatabase();
  await database.execute(`WITH RECURSIVE digit(n) AS (
    SELECT 0 UNION ALL SELECT n+1 FROM digit WHERE n<9
  ) INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message,created_at)
    SELECT 10,20,6,'old-'||(a.n*1000+b.n*100+c.n*10+d.n),'2020-01-01 00:00:00'
    FROM digit a CROSS JOIN digit b CROSS JOIN digit c CROSS JOIN digit d
    WHERE (a.n*1000+b.n*100+c.n*10+d.n)<${MAX_MESSAGES_PER_ROOM-1}`);
  currentDb=database;

  const responses=await Promise.all([
    invoke({method:'POST',body:{room_id:'week_10_pair_20',message:'last slot'}}),
    invoke({method:'POST',headers:{'x-test-auth':'partner'},body:{room_id:'week_10_pair_20',message:'competing last slot'}}),
  ]);
  assert.deepEqual(responses.map(response=>response.status).sort((a,b)=>a-b),[201,409]);
  assert.deepEqual(responses.find(response=>response.status===409).body,{error:'message room is full'});
  const count=await database.execute({sql:`SELECT COUNT(*) AS count FROM pair_messages WHERE week_id=? AND pair_group_id=?`,args:[10,20]});
  assert.equal(Number(count.rows[0].count),MAX_MESSAGES_PER_ROOM);
});

test('a membership change during send returns the generic room diagnostic and writes nothing',async()=>{
  const database=await readyDatabase();
  let revoked=false;
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(!revoked&&sql.includes('INSERT INTO pair_messages')){
        revoked=true;
        await database.execute(`UPDATE pairing_groups SET user_a_id=9 WHERE id=20 AND week_id=10`);
      }
      return database.execute(statement);
    },
    close(){ return database.close(); },
  };

  const response=await invoke({method:'POST',body:{room_id:'week_10_pair_20',message:'must not persist'}});
  assert.equal(revoked,true);
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
  const count=await database.execute(`SELECT COUNT(*) AS count FROM pair_messages`);
  assert.equal(Number(count.rows[0].count),0);
});

test('message readiness failures retry and all storage errors stay generic',async()=>{
  const database=await readyDatabase();
  await database.execute('DROP TABLE pair_messages');
  currentDb=database;
  const request={query:{endpoint:'messages',room_id:'week_10_pair_20'}};
  const missing=await invoke(request);
  assert.equal(missing.status,503);
  assert.deepEqual(missing.body,{error:'messages unavailable'});
  await database.execute(`CREATE TABLE pair_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL,
    pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL,
    message TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const recovered=await invoke(request);
  assert.equal(recovered.status,200,'failed readiness is evicted so a later request retries');

  const calls=[];
  const failing=tracedClient(database,calls);
  currentDb={
    ...failing,
    async execute(statement){
      const sql=sqlText(statement);
      calls.push({sql,args:statement?.args||[]});
      if(sql.includes('FROM pair_messages pm')) throw new Error('sensitive database coordinates');
      return database.execute(statement);
    },
  };
  const failed=await invoke(request);
  assert.equal(failed.status,503);
  assert.deepEqual(failed.body,{error:'messages unavailable'});
  assert.doesNotMatch(JSON.stringify(failed.body),/sensitive|database coordinates/i);

  const insertCalls=[];
  currentDb={
    ...tracedClient(database,insertCalls),
    async execute(statement){
      const sql=sqlText(statement);
      insertCalls.push({sql,args:statement?.args||[]});
      if(sql.includes('INSERT INTO pair_messages')) throw new Error('private insert failure');
      return database.execute(statement);
    },
  };
  const sendFailed=await invoke({
    method:'POST',body:{room_id:'week_10_pair_20',message:'will not persist'},
  });
  assert.equal(sendFailed.status,503);
  assert.deepEqual(sendFailed.body,{error:'messages unavailable'});
  const count=await database.execute(`SELECT COUNT(*) AS count FROM pair_messages`);
  assert.equal(Number(count.rows[0].count),0);
});
