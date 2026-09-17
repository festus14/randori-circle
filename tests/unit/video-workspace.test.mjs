import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../../db/migrate.js';

const databaseDirectory=mkdtempSync(join(tmpdir(),'randori-video-workspace-'));
const db=createClient({url:`file:${join(databaseDirectory,'test.sqlite')}`});

function authPayload(req){
  const value=Number(req?.headers?.['x-test-user']);
  return Number.isSafeInteger(value) && value>0 ? {id:value} : null;
}

mock.module('../../api/_db.js', {
  exports: {
    getClient:()=>db,
    verifyRequestAuth:authPayload,
    verifyMutationOrigin:()=>true,
  },
});

const {default:videoHandler}=await import('../../api/video.js');

function invoke({method='GET',url='/api/video/signal',query={},headers={},body={}}={}){
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
    schema_version:1,
    base_revision:0,
    client_id:'client_A1',
    client_seq:0,
    language:'javascript',
    question_id:'two-sum',
    code:'function twoSum() { return []; }',
    ...overrides,
  };
}

function post(payload=workspace(),overrides={}){
  return invoke({
    method:'POST',
    headers:{'x-test-user':'2'},
    body:{room_id:'week_10_pair_20',type:'code-sync',payload,...overrides},
  });
}

function get(afterRevision=0,overrides={}){
  return invoke({
    url:`/api/video/signal?room_id=week_10_pair_20&channel=workspace&after_revision=${afterRevision}`,
    query:{room_id:'week_10_pair_20',channel:'workspace',after_revision:String(afterRevision)},
    headers:{'x-test-user':'2'},
    ...overrides,
  });
}

before(async()=>{
  await runMigrations(db,{maxAttempts:4,baseDelayMs:0,maxDelayMs:0});
});

beforeEach(async()=>{
  await db.execute(`DELETE FROM pair_room_snapshots`);
  await db.execute(`DELETE FROM video_signals`);
  await db.execute(`DELETE FROM pairing_groups`);
  await db.execute({
    sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (?,?,?,?,?)`,
    args:[20,10,2,4,6],
  });
});

after(()=>{
  db.close();
  rmSync(databaseDirectory,{recursive:true,force:true});
});

test('workspace reads and writes require authentication and exact room membership', async()=>{
  const anonymous=await invoke({
    query:{room_id:'week_10_pair_20',channel:'workspace'},
  });
  assert.equal(anonymous.status,401);

  const outsider=await get(0,{headers:{'x-test-user':'99'}});
  assert.equal(outsider.status,403);

  const malformedRooms=[
    'week_01_pair_20',
    'week_10_pair_020',
    'week_10_pair_20/extra',
    ' week_10_pair_20',
    'WEEK_10_PAIR_20',
    'w10-p20',
  ];
  for(const room_id of malformedRooms){
    const result=await post(workspace(),{room_id});
    assert.equal(result.status,400,room_id);
  }

  const unsupportedThirdMember=await invoke({
    url:'/api/video/signal?room_id=week_10_pair_20&channel=workspace',
    query:{room_id:'week_10_pair_20',channel:'workspace'},
    headers:{'x-test-user':'6'},
  });
  assert.equal(unsupportedThirdMember.status,403);

  const objectRoom=await invoke({
    method:'POST',
    headers:{'x-test-user':'2'},
    body:{room_id:{toString:'not-callable'},type:'code-sync',payload:workspace()},
  });
  assert.equal(objectRoom.status,400);
});

test('workspace payload validation is strict and byte-based', async()=>{
  const invalidPayloads=[
    workspace({schema_version:2}),
    workspace({base_revision:-1}),
    workspace({base_revision:Number.MAX_SAFE_INTEGER+1}),
    workspace({client_id:'short'}),
    workspace({client_id:'not+urlsafe'}),
    workspace({client_seq:-1}),
    workspace({client_seq:1.5}),
    workspace({language:'typescript'}),
    workspace({question_id:'../two-sum'}),
    workspace({question_id:'Two-Sum'}),
    {...workspace(),unexpected:true},
  ];
  for(const payload of invalidPayloads){
    const result=await post(payload);
    assert.equal(result.status,400,JSON.stringify(payload));
  }

  const malformedJson=await post('{not-json');
  assert.equal(malformedJson.status,400);

  const exactLimit=await post(workspace({code:'é'.repeat(10*1024)}));
  assert.equal(exactLimit.status,200);
  assert.equal(exactLimit.body.snapshot.revision,1);

  await db.execute(`DELETE FROM pair_room_snapshots`);
  const overCodeLimit=await post(workspace({code:'é'.repeat((10*1024)+1)}));
  assert.equal(overCodeLimit.status,413);

  const overSerializedLimit=await post(workspace({code:'\0'.repeat(20*1024)}));
  assert.equal(overSerializedLimit.status,413);
});

test('workspace snapshots use monotonic CAS revisions and idempotent client sequence retries', async()=>{
  const created=await post();
  assert.equal(created.status,200);
  assert.equal(created.body.idempotent,false);
  assert.equal(created.body.snapshot.revision,1);
  assert.equal(created.body.snapshot.updated_by,2);

  const retry=await post(workspace({code:'this changed but must not overwrite the accepted retry'}));
  assert.equal(retry.status,200);
  assert.equal(retry.body.idempotent,true);
  assert.equal(retry.body.snapshot.code,'function twoSum() { return []; }');

  const stale=await post(workspace({client_id:'client_B2',client_seq:0,code:'stale'}));
  assert.equal(stale.status,409);
  assert.equal(stale.body.current.revision,1);
  assert.equal(stale.body.current.code,'function twoSum() { return []; }');

  const updated=await post(workspace({
    base_revision:1,
    client_id:'client_B2',
    client_seq:1,
    language:'python',
    code:'def two_sum():\n    return []',
  }));
  assert.equal(updated.status,200);
  assert.equal(updated.body.snapshot.revision,2);
  assert.equal(updated.body.snapshot.language,'python');

  const changed=await get(1);
  assert.equal(changed.status,200);
  assert.equal(changed.body.revision,2);
  assert.equal(changed.body.snapshot.code,'def two_sum():\n    return []');

  const unchanged=await get(2);
  assert.equal(unchanged.status,200);
  assert.equal(unchanged.body.revision,2);
  assert.equal(unchanged.body.snapshot,null);

  const invalidAfter=await get('01');
  assert.equal(invalidAfter.status,400);

  const signals=await db.execute(`SELECT COUNT(*) AS count FROM video_signals`);
  assert.equal(Number(signals.rows[0].count),0,'workspace code must never enter transient video_signals');
});

test('competing writes from the same base allow exactly one CAS winner', async()=>{
  // Create the runtime tables before racing so the test isolates snapshot CAS.
  assert.equal((await get(0)).status,200);
  const [left,right]=await Promise.all([
    post(workspace({client_id:'client_C3',code:'left'})),
    post(workspace({client_id:'client_D4',code:'right'})),
  ]);
  assert.deepEqual([left.status,right.status].sort(),[200,409]);

  const current=await get(0);
  assert.equal(current.body.snapshot.revision,1);
  assert.ok(['left','right'].includes(current.body.snapshot.code));

  const [updateLeft,updateRight]=await Promise.all([
    post(workspace({base_revision:1,client_id:'client_E5',client_seq:1,code:'updated-left'})),
    post(workspace({base_revision:1,client_id:'client_F6',client_seq:1,code:'updated-right'})),
  ]);
  assert.deepEqual([updateLeft.status,updateRight.status].sort(),[200,409]);
  const updated=await get(1);
  assert.equal(updated.body.snapshot.revision,2);
  assert.ok(['updated-left','updated-right'].includes(updated.body.snapshot.code));
});

test('workspace query parameters can be parsed from the URL without framework query hydration', async()=>{
  const result=await invoke({
    url:'/api/video/signal?room_id=week_10_pair_20&channel=workspace&after_revision=0',
    headers:{'x-test-user':'2'},
  });
  assert.equal(result.status,200);
  assert.equal(result.body.revision,0);
});
