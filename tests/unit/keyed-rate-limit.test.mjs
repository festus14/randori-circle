// The shared keyed fixed-window limiter behind product feedback (ID-91) and
// embedded video (ID-98).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { consumeKeyedRateLimits } from '../../api/_keyed-rate-limit.js';

const SECRET='keyed-rate-limit-test-secret-0123456789';

async function database(){
  const db=createClient({url:'file::memory:'});
  await db.execute('CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)');
  return db;
}

test('dimensions are consumed in order, the first exhausted one stops, and Retry-After is the rest of its window',async()=>{
  const db=await database();
  const nowSeconds=1_800_000_123;
  const dimensions=[['a','x',{limit:2,windowSeconds:60}],['b','y',{limit:3,windowSeconds:600}]];
  const run=()=>consumeKeyedRateLimits(db,{label:'test-v1',secret:SECRET,dimensions,nowSeconds});
  assert.deepEqual({...await run()},{allowed:true,dimension:null,retryAfter:0});
  assert.deepEqual({...await run()},{allowed:true,dimension:null,retryAfter:0});
  assert.deepEqual({...await run()},{allowed:false,dimension:'a',retryAfter:60-(nowSeconds%60)});
  const rows=(await db.execute('SELECT key,attempts,expires_at FROM auth_rate_limits ORDER BY expires_at')).rows;
  const key=(dimension,value,window)=>createHmac('sha256',SECRET)
    .update(`test-v1\0${dimension}\0${value}\0${Math.floor(nowSeconds/window)}`,'utf8').digest('hex');
  assert.deepEqual(rows.map(row=>[row.key,Number(row.attempts),Number(row.expires_at)]),[
    [key('a','x',60),3,(Math.floor(nowSeconds/60)+1)*60],
    [key('b','y',600),2,(Math.floor(nowSeconds/600)+1)*600],
  ],'the blocked attempt leaves the later dimension untouched');
});

test('invalid inputs and an invalid counter fail closed',async()=>{
  const db=await database();
  const good={label:'l',secret:SECRET,dimensions:[],nowSeconds:1};
  for(const [target,options] of [[null,good],[{},good],[db,{...good,label:''}],[db,{...good,secret:''}],[db,{...good,nowSeconds:0}],[db,{...good,nowSeconds:1.5}]]){
    await assert.rejects(consumeKeyedRateLimits(target,options),TypeError);
  }
  const broken={execute:async()=>({rows:[{attempts:'many'}]})};
  await assert.rejects(consumeKeyedRateLimits(broken,{...good,dimensions:[['a','x',{limit:1,windowSeconds:60}]]}),/invalid rate limit state/);
  const empty={execute:async()=>({})};
  await assert.rejects(consumeKeyedRateLimits(empty,{...good,dimensions:[['a','x',{limit:1,windowSeconds:60}]]}),/invalid rate limit state/);
});
