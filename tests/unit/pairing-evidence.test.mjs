import assert from 'node:assert/strict';
import test from 'node:test';

import {createClient} from '@libsql/client';

import {hasPrimaryUnavailableEvidence} from '../../api/_pairing-evidence.js';

async function database(){
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE outbox_events (
    id INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL
  )`);
  return db;
}

async function insert(db,{key,payload,type='pairing.email.requested',version=1}){
  await db.execute({
    sql:`INSERT INTO outbox_events (event_type,event_version,idempotency_key,payload_json)
      VALUES (?,?,?,?)`,
    args:[type,version,key,JSON.stringify(payload)],
  });
}

test('primary unavailable evidence requires the exact versioned event and JSON identity types',async()=>{
  const cases=[
    {name:'valid',key:'randori/10/unavailable/2',payload:{week_id:10,user_id:2,kind:'unavailable'},expected:true},
    {name:'numeric-string week',key:'randori/10/unavailable/2',payload:{week_id:'10',user_id:2,kind:'unavailable'},expected:false},
    {name:'numeric-prefix week',key:'randori/10/unavailable/2',payload:{week_id:'10junk',user_id:2,kind:'unavailable'},expected:false},
    {name:'fractional user',key:'randori/10/unavailable/2',payload:{week_id:10,user_id:2.9,kind:'unavailable'},expected:false},
    {name:'numeric-string user',key:'randori/10/unavailable/2',payload:{week_id:10,user_id:'2',kind:'unavailable'},expected:false},
    {name:'wrong kind type',key:'randori/10/unavailable/2',payload:{week_id:10,user_id:2,kind:true},expected:false},
    {name:'wrong key',key:'randori/10/paired/2',payload:{week_id:10,user_id:2,kind:'unavailable'},expected:false},
  ];
  for(const item of cases){
    const db=await database();
    try{
      await insert(db,item);
      assert.equal(await hasPrimaryUnavailableEvidence(db,{weekId:10,userId:2}),item.expected,item.name);
    }finally{ db.close(); }
  }

  const wrongVersion=await database();
  try{
    await insert(wrongVersion,{key:'randori/10/unavailable/2',
      payload:{week_id:10,user_id:2,kind:'unavailable'},version:2});
    assert.equal(await hasPrimaryUnavailableEvidence(wrongVersion,{weekId:10,userId:2}),false);
  }finally{ wrongVersion.close(); }
});

test('primary unavailable evidence validates its trusted call boundary',async()=>{
  const db=await database();
  try{
    await assert.rejects(hasPrimaryUnavailableEvidence(null,{weekId:10,userId:2}),TypeError);
    for(const input of [
      {weekId:0,userId:2},{weekId:'10junk',userId:2},{weekId:10,userId:2.5},
    ]) await assert.rejects(hasPrimaryUnavailableEvidence(db,input),TypeError);
  }finally{ db.close(); }
});
