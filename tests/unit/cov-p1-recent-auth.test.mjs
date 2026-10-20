import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  readRecentAuth,
  recordRecentAuth,
  requireRecentAuth,
  RECENT_AUTH_MAX_AGE_SECONDS,
} from '../../api/_recent-auth.js';

const HASH='c'.repeat(64);
const NOW=1_800_000_000;

function fakeDb(rows){
  const calls=[];
  return {calls,async execute(statement){ calls.push(statement); return rows===undefined?{}:{rows}; }};
}

test('recordRecentAuth rejects invalid evidence without touching the database',async()=>{
  const db=fakeDb([]);
  const valid={sessionHash:HASH,userId:1,method:'password',nowSeconds:NOW};
  for(const input of [
    {...valid,sessionHash:'C'.repeat(64)},
    {...valid,sessionHash:undefined},
    {...valid,userId:0},
    {...valid,userId:'abc'},
    {...valid,method:'magic-link'},
    {...valid,nowSeconds:0},
    {...valid,nowSeconds:'1800000000'},
  ]){
    await assert.rejects(recordRecentAuth(db,input),TypeError);
  }
  await assert.rejects(recordRecentAuth(null,valid),TypeError);
  await assert.rejects(recordRecentAuth(db),TypeError);
  assert.equal(db.calls.length,0);
});

test('recordRecentAuth fails when the session is gone or owned by someone else',async()=>{
  const valid={sessionHash:HASH,userId:'7',method:'google',nowSeconds:NOW};
  // Revoked/expired session: the INSERT ... SELECT returns no row.
  await assert.rejects(recordRecentAuth(fakeDb([]),valid),/persistence failed/);
  await assert.rejects(recordRecentAuth(fakeDb(undefined),valid),/persistence failed/);
  await assert.rejects(recordRecentAuth(fakeDb([{session_hash:'d'.repeat(64),user_id:7}]),valid),/persistence failed/);
  await assert.rejects(recordRecentAuth(fakeDb([{session_hash:HASH,user_id:8}]),valid),/persistence failed/);

  const db=fakeDb([{session_hash:HASH,user_id:7,authenticated_at:NOW,method:'google'}]);
  assert.deepEqual(await recordRecentAuth(db,valid),{authenticatedAt:NOW,method:'google'});
  assert.deepEqual(db.calls[0].args,[NOW,'google',HASH,7,NOW]);
});

test('readRecentAuth treats malformed sessions and options as invalid',async()=>{
  const db=fakeDb([{authenticated_at:NOW,method:'password'}]);
  const payload={id:3,sessionHash:HASH};
  const invalid={ok:false,reason:'invalid_session'};
  assert.deepEqual(await readRecentAuth(db,null),invalid);
  assert.deepEqual(await readRecentAuth(db,{id:3}),invalid);
  assert.deepEqual(await readRecentAuth(db,{sessionHash:HASH}),invalid);
  assert.deepEqual(await readRecentAuth({},payload,{nowSeconds:NOW}),invalid);
  assert.deepEqual(await readRecentAuth(db,payload,{nowSeconds:-1}),invalid);
  assert.deepEqual(await readRecentAuth(db,payload,{nowSeconds:NOW,maxAgeSeconds:0}),invalid);
  assert.deepEqual(await readRecentAuth(db,payload,{nowSeconds:NOW,maxAgeSeconds:3601}),invalid);
  assert.deepEqual(await readRecentAuth(db,payload,{nowSeconds:NOW,maxAgeSeconds:1.5}),invalid);
  assert.equal(db.calls.length,0);
});

test('readRecentAuth requires exactly one proof with a known method inside the window',async()=>{
  const payload={uid:'3',sessionHash:HASH};
  const required={ok:false,reason:'recent_auth_required'};
  assert.deepEqual(await readRecentAuth(fakeDb([]),payload,{nowSeconds:NOW}),required);
  assert.deepEqual(await readRecentAuth(fakeDb(undefined),payload,{nowSeconds:NOW}),required);
  assert.deepEqual(await readRecentAuth(fakeDb([{},{}]),payload,{nowSeconds:NOW}),required);
  assert.deepEqual(await readRecentAuth(fakeDb([{authenticated_at:NOW,method:null}]),payload,{nowSeconds:NOW}),required);
  assert.deepEqual(await readRecentAuth(fakeDb([{authenticated_at:NOW,method:'sms'}]),payload,{nowSeconds:NOW}),required);

  const db=fakeDb([{authenticated_at:NOW-30,method:'password'}]);
  assert.deepEqual(await readRecentAuth(db,payload,{nowSeconds:NOW,maxAgeSeconds:120}),
    {ok:true,method:'password',authenticatedAt:NOW-30,expiresAt:NOW+90});
  assert.deepEqual(db.calls[0].args,[HASH,3,NOW,NOW-120,NOW]);
  const defaults=fakeDb([{authenticated_at:NOW,method:'google'}]);
  await readRecentAuth(defaults,payload,{nowSeconds:NOW});
  assert.equal(defaults.calls[0].args[3],NOW-RECENT_AUTH_MAX_AGE_SECONDS);
});

test('requireRecentAuth throws a 403 RECENT_AUTH_REQUIRED error when proof is missing',async()=>{
  await assert.rejects(requireRecentAuth(fakeDb([]),{id:1,sessionHash:HASH},{nowSeconds:NOW}),
    error=>error.code==='RECENT_AUTH_REQUIRED'&&error.statusCode===403);
  const ok=await requireRecentAuth(fakeDb([{authenticated_at:NOW,method:'google'}]),{id:1,sessionHash:HASH},{nowSeconds:NOW});
  assert.equal(ok.ok,true);
});
