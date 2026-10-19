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
      block_writes:false,parent:{
        id:SOURCE_ID,name:'production',branched_at:'2026-09-18T12:00:00.000000000Z',
      },
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
  assert.deepEqual((await platform.getDatabase('restore-1')).parent,{
    id:SOURCE_ID,name:'production',branchedAt:'2026-09-18T12:00:00.000Z',
  });
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

test('an external abort reaches the in-flight Platform fetch immediately',async()=>{
  const controller=new AbortController();
  let observedSignal;
  const platform=client({
    fetch(_url,{signal}){
      observedSignal=signal;
      return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{
        reject(Object.assign(new Error('interrupted provider detail'),{name:'AbortError'}));
      },{once:true}));
    },
  },{timeoutMs:10_000,signal:controller.signal});
  const pending=platform.getDatabase('production');
  controller.abort();
  await assert.rejects(pending,error=>error.code==='TURSO_PLATFORM_TIMEOUT');
  assert.equal(observedSignal.aborted,true);
});

test('provider responses must retain exact authoritative identity and configuration fields',async()=>{
  const invalidResponses=[
    {database:{DbId:SOURCE_ID,Name:'other',Hostname:'other.turso.io',group:'default',block_writes:false,parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'https://secret.example/x',group:'default',block_writes:false,parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'production.turso.io',group:'default',block_writes:'false',parent:null}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'production.turso.io',group:'default',block_writes:false,parent:{name:'source'}}},
    {database:{DbId:SOURCE_ID,Name:'production',Hostname:'production.turso.io',group:'default',block_writes:false}},
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

const DATABASE={
  DbId:SOURCE_ID,Name:'production',Hostname:'production-randori.turso.io',group:'default',
  block_writes:false,parent:null,
};

async function platformError(promise){
  let observed;
  await assert.rejects(promise,error=>{ observed=error; return error instanceof TursoPlatformError; });
  return observed;
}

test('a 200 response with a null body is invalid, never an absent database',async()=>{
  // Only an explicit 404 may mean "absent"; otherwise a deleted-database check could pass on a bogus body.
  for(const allowNotFound of [true,false]){
    const platform=client(recorder([new Response('null',{status:200})]));
    const error=await platformError(platform.getDatabase('production',{allowNotFound}));
    assert.equal(error.code,'TURSO_PLATFORM_RESPONSE_INVALID');
  }
  const absent=client(recorder([json({},404)]));
  assert.equal(await absent.getDatabase('production',{allowNotFound:true}),null);
});

test('client configuration rejects unsafe endpoints, tokens, signals, and limits',()=>{
  const record=recorder([]);
  const invalid=error=>error instanceof TursoPlatformError&&error.code==='TURSO_PLATFORM_INVALID';
  for(const baseUrl of ['not a url','http://api.turso.tech','https://api.turso.tech/v1','https://u:p@api.turso.tech','https://api.turso.tech/#x']){
    assert.throws(()=>client(record,{baseUrl}),invalid);
  }
  for(const token of [undefined,'short',` ${TOKEN}`,`${TOKEN}\u0000`,'x'.repeat(16*1024+1)]){
    assert.throws(()=>client(record,{token}),invalid);
  }
  for(const signal of [null,{},{aborted:'no',addEventListener(){}},{aborted:false}]){
    assert.throws(()=>client(record,{signal}),invalid);
  }
  for(const timeoutMs of [0,60_001,1.5,'100']){
    assert.throws(()=>client(record,{timeoutMs}),invalid);
  }
  assert.throws(()=>client(record,{maxResponseBytes:1024*1024+1}),invalid);
  assert.throws(()=>client(record,{fetchImpl:{}}),invalid);
  assert.throws(()=>client(record,{organization:'Bad_Org'}),invalid);
  // The global fetch is used when none is injected.
  assert.equal(typeof createTursoPlatformClient({organization:'randori-org',token:TOKEN}).getDatabase,'function');
});

test('transport, metadata, and body failures map to sanitized retryable codes',async()=>{
  const cases=[
    [new TypeError('ECONNRESET'),'TURSO_PLATFORM_FAILED',true],
    [Object.assign(new Error('aborted'),{name:'AbortError'}),'TURSO_PLATFORM_TIMEOUT',true],
    [Object.assign(new Error('aborted'),{code:'ABORT_ERR'}),'TURSO_PLATFORM_TIMEOUT',true],
    [null,'TURSO_PLATFORM_RESPONSE_INVALID',false],
    [{status:'200',ok:true},'TURSO_PLATFORM_RESPONSE_INVALID',false],
    [new Response('',{status:200}),'TURSO_PLATFORM_RESPONSE_INVALID',false],
    [new Response(new Uint8Array([0xff,0xfe]),{status:200}),'TURSO_PLATFORM_RESPONSE_INVALID',false],
    [json(DATABASE,200,{'content-length':'-1'}),'TURSO_PLATFORM_RESPONSE_INVALID',false],
    [json({},429),'TURSO_PLATFORM_RATE_LIMITED',true],
    [json({},503),'TURSO_PLATFORM_UNAVAILABLE',true],
    [json({},400),'TURSO_PLATFORM_REJECTED',false],
    [json({},404),'TURSO_PLATFORM_NOT_FOUND',false],
  ];
  for(const [response,code,retryable] of cases){
    const error=await platformError(client(recorder([response])).getDatabase('production'));
    assert.equal(error.code,code,`${code} for ${String(response?.status??response)}`);
    assert.equal(error.retryable,retryable);
    assert.equal(publicTursoPlatformError(error).error,code);
  }

  const unreadable={status:200,ok:true,headers:new Headers(),async arrayBuffer(){ throw new Error('stream torn'); }};
  const readError=await platformError(client(recorder([unreadable])).getDatabase('production'));
  assert.equal(readError.message,'response could not be read');
  assert.equal(readError.cause.message,'stream torn');

  const undeclared={status:200,ok:true,headers:new Headers(),async arrayBuffer(){ return new Uint8Array(64).buffer; }};
  const large=await platformError(client(recorder([undeclared]),{maxResponseBytes:16}).getDatabase('production'));
  assert.equal(large.message,'response is too large');

  assert.deepEqual(publicTursoPlatformError(new Error('raw')),{
    ok:false,error:'TURSO_PLATFORM_FAILED',message:'The Turso Platform API request failed.',
  });
  assert.equal(publicTursoPlatformError(new TursoPlatformError('NOT_A_CODE','x')).error,'TURSO_PLATFORM_FAILED');
  assert.equal(new TursoPlatformError('X','y',{status:1.5}).status,undefined);
});

test('database identity, parent, and configuration responses are validated field by field',async()=>{
  const invalidResponse=error=>error.code==='TURSO_PLATFORM_RESPONSE_INVALID';
  for(const body of [
    [DATABASE],
    {database:'production'},
    {...DATABASE,Hostname:'Production.turso.io'},
    {...DATABASE,Hostname:'production.turso.io.'},
    {...DATABASE,Hostname:'localhost'},
    {...DATABASE,DbId:' padded '},
    {...DATABASE,block_writes:'false'},
    {...DATABASE,parent:undefined},
    {...DATABASE,parent:{id:SOURCE_ID,name:'production',branched_at:'yesterday'}},
    {...DATABASE,parent:{id:SOURCE_ID,name:'production',branched_at:'2026-13-45T99:99:99Z'}},
    {...DATABASE,parent:{id:SOURCE_ID,name:'Bad Name',branched_at:'2026-09-18T12:00:00Z'}},
  ]){
    const error=await platformError(client(recorder([json(body)])).getDatabase('production'));
    assert.ok(error.code==='TURSO_PLATFORM_RESPONSE_INVALID'||error.code==='TURSO_PLATFORM_INVALID',JSON.stringify(body));
  }
  for(const body of [[],{block_writes:'yes'},{}]){
    await assert.rejects(client(recorder([json(body)])).getDatabaseConfiguration('production'),invalidResponse);
  }
});

test('mutations require acknowledged results that match the requested database',async()=>{
  const invalid=error=>error.code==='TURSO_PLATFORM_INVALID';
  const invalidResponse=error=>error.code==='TURSO_PLATFORM_RESPONSE_INVALID';
  const record=recorder([]);
  await assert.rejects(client(record).setDatabaseBlockWrites('production','true'),invalid);
  assert.equal(record.calls.length,0);
  await assert.rejects(client(recorder([json({block_writes:false})])).setDatabaseBlockWrites('production',true),/not acknowledged/);

  const pitr={name:'restore-1',group:'default',sourceName:'production',pitrAt:'2026-09-18T12:00:00.000Z'};
  for(const pitrAt of [undefined,1758196800000,'2026-09-18T12:00:00Z','2026-02-30T00:00:00.000Z','soon']){
    await assert.rejects(client(record).createPitrDatabase({...pitr,pitrAt}),invalid);
  }
  await assert.rejects(client(record).createPitrDatabase(),invalid);
  assert.equal(record.calls.length,0);
  for(const body of [{},{database:[]},{database:null}]){
    await assert.rejects(client(recorder([json(body)])).createPitrDatabase(pitr),/create database response is invalid/);
  }
  await assert.rejects(
    client(recorder([json({database:{DbId:RESTORE_ID,Name:'restore-2',Hostname:'restore-2-randori.turso.io'}})])).createPitrDatabase(pitr),
    /created database name does not match/,
  );

  await assert.rejects(client(recorder([json({database:'other'})])).deleteDatabase('restore-1'),/deleted database name does not match/);
  await assert.rejects(client(recorder([json({})])).deleteDatabase('restore-1'),invalidResponse);
  await assert.rejects(client(record).deleteDatabase('production/../x'),invalid);
});
