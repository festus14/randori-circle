import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

const database=createClient({url:'file::memory:'});
let beforeExecute=null;
const observedSql=[];
const db={
  async execute(statement){
    const sql=typeof statement==='string' ? statement : statement.sql;
    observedSql.push(sql);
    if(beforeExecute) await beforeExecute(sql);
    return database.execute(statement);
  },
};

mock.module('../../api/_db.js', {
  exports:{
    getClient:()=>db,
    verifyRequestAuth:req=>{
      const id=Number(req?.headers?.['x-test-user']);
      return Number.isSafeInteger(id) && id>0 ? {id} : null;
    },
    verifyMutationOrigin:()=>true,
  },
});

const {default:videoHandler}=await import('../../api/video.js');

function invoke({method='GET',url='/api/video/signal',query={},headers={'x-test-user':'2'},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
    };
    Promise.resolve(videoHandler({method,url,query,headers,body},response))
      .then(()=>finish(undefined))
      .catch(reject);
  });
}

function workspace(overrides={}){
  return {
    schema_version:2,
    base_revision:0,
    client_id:'source_auth_client',
    client_seq:0,
    language:'javascript',
    question_id:'focus-block-rollup',
    question_version:1,
    code:'const authorized = true;',
    ...overrides,
  };
}

function workspacePost(payload=workspace(),headers={'x-test-user':'2'}){
  return invoke({
    method:'POST',
    headers,
    body:{room_id:'week_10_pair_20',type:'code-sync',payload},
  });
}

function workspaceGet(headers={'x-test-user':'2'},roomId='week_10_pair_20'){
  return invoke({
    url:`/api/video/signal?room_id=${roomId}&channel=workspace&after_revision=0`,
    query:{room_id:roomId,channel:'workspace',after_revision:'0'},
    headers,
  });
}

function signalPost(roomId='week_10_pair_20',headers={'x-test-user':'2'}){
  return invoke({
    method:'POST',
    headers,
    body:{room_id:roomId,from_id:'peer-a',type:'offer',payload:'{"sdp":"safe"}'},
  });
}

before(async()=>{
  await database.batch([
    `CREATE TABLE pairing_groups (
      id INTEGER PRIMARY KEY,
      week_id INTEGER NOT NULL,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      user_c_id INTEGER,
      is_ai_pair INTEGER DEFAULT 0,
      topic TEXT,
      topic_kind TEXT
    )`,
    `CREATE TABLE pairing_participants (
      week_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (week_id,user_id)
    )`,
    `CREATE TABLE video_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE pair_room_snapshots (
      room_id TEXT PRIMARY KEY,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      language TEXT NOT NULL,
      question_id TEXT NOT NULL,
      code TEXT NOT NULL,
      updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(week_id,pair_group_id)
    )`,
  ],'write');
});

beforeEach(async()=>{
  beforeExecute=null;
  observedSql.length=0;
  await database.batch([
    `DELETE FROM pair_room_snapshots`,
    `DELETE FROM video_signals`,
    `DELETE FROM pairing_participants`,
    `DELETE FROM pairing_groups`,
  ],'write');
  await database.execute({
    sql:`INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
      VALUES (20,10,2,4,6,0,'Systems','backend')`,
    args:[],
  });
  await database.batch([
    {sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`,args:[]},
    {sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,4,1,'auth')`,args:[]},
    {sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,6,2,'auth')`,args:[]},
  ],'write');
});

after(()=>database.close());

test('source-tagged access denies auth IDs that collide with legacy participants', async()=>{
  await database.execute(`UPDATE pairing_participants SET source='users' WHERE week_id=10 AND user_id=2`);
  await database.execute(`INSERT INTO pair_room_snapshots
    (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
    VALUES ('week_10_pair_20',10,20,1,2,'legacy_client',1,'javascript','secret@1','private source',2)`);

  const workspaceRead=await workspaceGet();
  const workspaceWrite=await workspacePost(workspace({base_revision:1,client_seq:2}));
  const signalWrite=await signalPost();
  const legacySignalWrite=await signalPost('w10-p2-4');
  const absentRoom=await workspaceGet({'x-test-user':'2'},'week_10_pair_999');

  for(const response of [workspaceRead,workspaceWrite,signalWrite,legacySignalWrite,absentRoom]){
    assert.equal(response.status,403);
    assert.deepEqual(response.body,{ok:false,error:'not a member of this room'});
  }
  assert.equal(workspaceRead.body.current,undefined);
  const signals=await database.execute(`SELECT COUNT(*) AS count FROM video_signals`);
  assert.equal(Number(signals.rows[0].count),0);
});

test('workspace creation rechecks membership inside its insert', async()=>{
  let revoked=false;
  beforeExecute=async sql=>{
    if(!revoked && sql.includes('WITH access AS') && sql.includes('INSERT INTO pair_room_snapshots')){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  };
  const created=await workspacePost();
  assert.equal(created.status,403);
  assert.equal(created.body.snapshot,undefined);
  const stored=await database.execute(`SELECT COUNT(*) AS count FROM pair_room_snapshots`);
  assert.equal(Number(stored.rows[0].count),0);
});

test('legacy signal aliases resolve once and use the canonical storage namespace', async()=>{
  const created=await signalPost('W10-P2-4');
  assert.equal(created.status,200);
  assert.equal(created.body.room_id,'week_10_pair_20');

  const stored=await database.execute(`SELECT room_id FROM video_signals`);
  assert.deepEqual(stored.rows.map(row=>String(row.room_id)),['week_10_pair_20']);

  const polled=await invoke({
    query:{room_id:'week_10_pair_20',after:'0'},
    headers:{'x-test-user':'4'},
  });
  assert.equal(polled.status,200);
  assert.equal(polled.body.room_id,'week_10_pair_20');
  assert.equal(polled.body.signals.length,1);
  assert.equal(polled.body.signals[0].payload,'{"sdp":"safe"}');
});

test('workspace CAS rechecks membership inside the update and redacts the raced snapshot', async()=>{
  const created=await workspacePost();
  assert.equal(created.status,200);

  let revoked=false;
  beforeExecute=async sql=>{
    if(!revoked && sql.includes('WITH access AS') && sql.includes('UPDATE pair_room_snapshots')){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  };
  const update=await workspacePost(workspace({
    base_revision:1,
    client_id:'source_auth_update',
    client_seq:1,
    code:'must not be written',
  }));
  assert.equal(update.status,403);
  assert.equal(update.body.current,undefined);

  const stored=await database.execute(`SELECT revision,code FROM pair_room_snapshots WHERE room_id='week_10_pair_20'`);
  assert.equal(Number(stored.rows[0].revision),1);
  assert.equal(stored.rows[0].code,'const authorized = true;');
});

test('signal mutations and reads recheck membership in their storage statements', async()=>{
  let revoked=false;
  beforeExecute=async sql=>{
    if(!revoked && sql.includes('WITH access AS') && sql.includes('INSERT INTO video_signals')){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  };
  const deniedInsert=await signalPost();
  assert.equal(deniedInsert.status,403);
  assert.equal(Number((await database.execute(`SELECT COUNT(*) AS count FROM video_signals`)).rows[0].count),0);

  beforeExecute=null;
  await database.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`);
  assert.equal((await signalPost()).status,200);

  revoked=false;
  beforeExecute=async sql=>{
    if(!revoked && sql.includes('WITH access AS') && sql.includes('LEFT JOIN video_signals')){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  };
  const deniedRead=await invoke({query:{room_id:'week_10_pair_20',after:'0'}});
  assert.equal(deniedRead.status,403);
  assert.equal(deniedRead.body.signals,undefined);

  beforeExecute=null;
  await database.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`);
  revoked=false;
  beforeExecute=async sql=>{
    if(!revoked && sql.includes('WITH access AS') && sql.includes('DELETE FROM video_signals')){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  };
  const deniedDelete=await invoke({method:'DELETE',body:{room_id:'week_10_pair_20'}});
  assert.equal(deniedDelete.status,403);
  assert.equal(Number((await database.execute(`SELECT COUNT(*) AS count FROM video_signals`)).rows[0].count),1);
});

test('video requests do not run schema DDL', async()=>{
  assert.equal((await workspaceGet()).status,200);
  assert.equal((await signalPost()).status,200);
  assert.equal(observedSql.some(sql=>/\bCREATE\s+(?:TABLE|INDEX)\b/i.test(sql)),false);
});
