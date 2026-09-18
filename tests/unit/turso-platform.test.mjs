import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TursoPlatformError,
  createTursoPlatformClient,
  publicTursoPlatformError,
} from '../../db/turso-platform.js';

const TOKEN='platform-token-that-must-never-be-returned';
const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const RESTORE_ID='22222222-2222-4222-8222-222222222222';

function json(value,status=200,headers={}){
  return new Response(JSON.stringify(value),{
    status,headers:{'content-type':'application/json',...headers},
  });
}

function recorder(responses){
  const calls=[];
  return {
    calls,
    async fetch(url,options){
      calls.push({url,options});
      const response=responses.shift();
      if(response instanceof Error) throw response;
      if(typeof response==='function') return response(url,options);
      return response;
    },
  };
}

function client(record,overrides={}){
  return createTursoPlatformClient({
    organization:'randori-org',token:TOKEN,fetchImpl:record.fetch,...overrides,
  });
}

test('Platform adapter uses exact database, PITR, configuration, token, and delete contracts',async()=>{
  const record=recorder([
    json({database:{
      DbId:SOURCE_ID,Name:'production',Hostname:'production-randori.turso.io',group:'default',
      block_writes:false,parent:null,
    }}),
    json({block_writes:false}),
    json({block_writes:true}),
    json({database:{DbId:RESTORE_ID,Name:'restore-1',Hostname:'restore-1-randori.turso.io'}}),
    json({database:{
      DbId:RESTORE_ID,Name:'restore-1',Hostname:'restore-1-randori.turso.io',group:'default',
      block_writes:false,parent:{id:SOURCE_ID,name:'production'},
    }}),
    json({jwt:'short-lived-database-token'}),
    json({database:'restore-1'}),
  ]);
  const platform=client(record);

  const source=await platform.getDatabase('production');
  assert.deepEqual(source,{
    id:SOURCE_ID,name:'production',hostname:'production-randori.turso.io',group:'default',
    blockWrites:false,parent:null,
  });
  assert.deepEqual(await platform.getDatabaseConfiguration('production'),{blockWrites:false});
  assert.deepEqual(await platform.setDatabaseBlockWrites('production',true),{blockWrites:true});
  assert.deepEqual(await platform.createPitrDatabase({
    name:'restore-1',group:'default',sourceName:'production',pitrAt:'2026-09-18T12:00:00.000Z',
  }),{id:RESTORE_ID,name:'restore-1',hostname:'restore-1-randori.turso.io'});
  assert.equal((await platform.getDatabase('restore-1')).parent.id,SOURCE_ID);
  assert.equal(await platform.createDatabaseToken('restore-1',{
    expiration:'30m',authorization:'full-access',
  }),'short-lived-database-token');
  assert.deepEqual(await platform.deleteDatabase('restore-1'),{deleted:true});

  assert.deepEqual(record.calls.map(call=>[call.options.method,new URL(call.url).pathname]),[
    ['GET','/v1/organizations/randori-org/databases/production'],
    ['GET','/v1/organizations/randori-org/databases/production/configuration'],
    ['PATCH','/v1/organizations/randori-org/databases/production/configuration'],
    ['POST','/v1/organizations/randori-org/databases'],
    ['GET','/v1/organizations/randori-org/databases/restore-1'],
    ['POST','/v1/organizations/randori-org/databases/restore-1/auth/tokens'],
    ['DELETE','/v1/organizations/randori-org/databases/restore-1'],
  ]);
  assert.deepEqual(JSON.parse(record.calls[2].options.body),{block_writes:true});
  assert.deepEqual(JSON.parse(record.calls[3].options.body),{
    name:'restore-1',group:'default',
    seed:{type:'database',name:'production',timestamp:'2026-09-18T12:00:00.000Z'},
  });
  const tokenUrl=new URL(record.calls[5].url);
  assert.equal(tokenUrl.searchParams.get('expiration'),'30m');
  assert.equal(tokenUrl.searchParams.get('authorization'),'full-access');
  assert.ok(record.calls.every(call=>call.options.headers.authorization===`Bearer ${TOKEN}`));
  assert.ok(record.calls.every(call=>call.options.redirect==='error'));
});

test('404 can be represented only as an explicit absent database',async()=>{
  const record=recorder([json({error:'secret provider detail'},404),json({error:'secret provider detail'},404)]);
  const platform=client(record);
  assert.equal(await platform.getDatabase('restore-1',{allowNotFound:true}),null);
  await assert.rejects(
    platform.getDatabase('restore-1'),
    error=>error instanceof TursoPlatformError&&error.code==='TURSO_PLATFORM_NOT_FOUND',
  );
});

test('timeouts, HTTP failures, malformed bodies, and oversized bodies are sanitized',async()=>{
  const timeoutPlatform=client({
    fetch(_url,{signal}){
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
        reject(Object.assign(new Error('secret timeout detail'),{name:'AbortError'}));
      },{once:true}));
    },
  },{timeoutMs:5});
  let timeoutError;
  await assert.rejects(timeoutPlatform.getDatabase('production'),error=>{
    timeoutError=error;
    return error.code==='TURSO_PLATFORM_TIMEOUT'&&error.retryable===true;
  });
  assert.deepEqual(publicTursoPlatformError(timeoutError),{
    ok:false,error:'TURSO_PLATFORM_TIMEOUT',message:'The Turso Platform API request timed out.',
  });

  for(const [response,code] of [
    [json({error:'leaked-429'},429),'TURSO_PLATFORM_RATE_LIMITED'],
    [json({error:'leaked-503'},503),'TURSO_PLATFORM_UNAVAILABLE'],
    [json({error:'leaked-403'},403),'TURSO_PLATFORM_REJECTED'],
    [new Response('not-json',{status:200}),'TURSO_PLATFORM_RESPONSE_INVALID'],
    [json({database:{DbId:SOURCE_ID,Name:'production'}},200,{'content-length':'999999'}),'TURSO_PLATFORM_RESPONSE_INVALID'],
  ]){
    const platform=client(recorder([response]));
    let observed;
    await assert.rejects(platform.getDatabase('production'),error=>{
      observed=error;
      return error.code===code;
    });
    const serialized=JSON.stringify(publicTursoPlatformError(observed));
    assert.equal(serialized.includes('leaked-'),false);
    assert.equal(serialized.includes(TOKEN),false);
  }
});

test('provider responses must retain exact authoritative identity and configuration fields',async()=>{
  const invalidResponses=[
    {database:{DbId:SOURCE_ID,Name:'other',Hostname:'other.turso.io',group:'default',block_writes:false,parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'https://secret.example/x',group:'default',block_writes:false,parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'production.turso.io',group:'default',block_writes:'false',parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'production.turso.io',group:'default',block_writes:false,parent:{name:'source'}}},
  ];
  for(const value of invalidResponses){
    const platform=client(recorder([json(value)]));
    if(value.database.Name==='other'){
      assert.equal((await platform.getDatabase('production')).name,'other');
    }else{
      await assert.rejects(
        platform.getDatabase('production'),
        error=>error.code==='TURSO_PLATFORM_RESPONSE_INVALID',
      );
    }
  }
  assert.throws(
    ()=>createTursoPlatformClient({organization:'BAD/org',token:TOKEN,fetchImpl:()=>{}}),
    error=>error.code==='TURSO_PLATFORM_INVALID',
  );
  assert.throws(
    ()=>client(recorder([]),{baseUrl:'http://api.turso.test'}),
    error=>error.code==='TURSO_PLATFORM_INVALID',
  );
});

test('tokens are database scoped, explicitly authorized, short lived, and never invalidated by the adapter',async()=>{
  const record=recorder([json({jwt:'database-token-value'})]);
  const platform=client(record);
  await assert.rejects(
    platform.createDatabaseToken('production',{expiration:'never',authorization:'read-only'}),
    error=>error.code==='TURSO_PLATFORM_INVALID',
  );
  await assert.rejects(
    platform.createDatabaseToken('production',{expiration:'30m',authorization:'group'}),
    error=>error.code==='TURSO_PLATFORM_INVALID',
  );
  assert.equal(await platform.createDatabaseToken('production',{
    expiration:'10m',authorization:'read-only',
  }),'database-token-value');
  assert.equal(record.calls.length,1);
  assert.doesNotMatch(record.calls[0].url,/invalidate/i);
});
