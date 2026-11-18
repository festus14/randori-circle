import assert from 'node:assert/strict';
import {test,mock,afterEach} from 'node:test';
let mode='wal',release=null;const creations=[],calls=[];
mock.module('@libsql/client',{exports:{createClient:options=>{
  creations.push(options);return{closed:false,protocol:options.url.startsWith('file:')?'file':'http',
    async execute(sql){calls.push(sql);if(sql==='PRAGMA journal_mode=WAL'){
      if(mode==='throw')throw new Error('local setup failed');if(mode==='delayed')await new Promise(resolve=>{release=resolve;});return{rows:[{journal_mode:mode==='memory'?'memory':'wal'}]};}
      return{rows:[{ok:1}]};},
    async executeMultiple(sql){calls.push(sql);},async batch(stmts){calls.push('batch');return stmts.map(()=>({rows:[]}));},
    async transaction(){calls.push('transaction');return{execute:async()=>({rows:[]}),commit:async()=>{},close(){}};},
    close(){this.closed=true;calls.push('close');}};
}}});
const KEYS=['NODE_ENV','RANDORI_LOCAL_RUNTIME','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','SENTRY_DSN','EXECUTION_QUEUE_ENABLED'];
const old=Object.fromEntries(KEYS.map(key=>[key,process.env[key]]));delete process.env.SENTRY_DSN;
const {getClient,closeLocalDevelopmentClient}=await import('../../api/_db.js');
afterEach(async()=>{await closeLocalDevelopmentClient();for(const[key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;mode='wal';release=null;creations.length=0;calls.length=0;});
function local(){process.env.NODE_ENV='development';process.env.RANDORI_LOCAL_RUNTIME='true';process.env.TURSO_DATABASE_URL='file:///tmp/local-fixture-only.sqlite';delete process.env.TURSO_AUTH_TOKEN;}

test('WAL is initialized once before any local method can execute, without making getClient async',async()=>{
  local();mode='delayed';const client=getClient();assert.equal(typeof client.then,'undefined');assert.equal(getClient(),client);
  const pending=client.execute('SELECT 1');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['PRAGMA journal_mode=WAL']);release();assert.deepEqual(await pending,{rows:[{ok:1}]});
  await client.batch(['SELECT 2']);await client.executeMultiple('SELECT 3');const tx=await client.transaction('read');await tx.execute('SELECT 4');tx.close();
  assert.equal(calls.filter(sql=>sql==='PRAGMA journal_mode=WAL').length,1);assert.equal(creations.length,1);
});

for(const failure of ['throw','memory'])test(`local ${failure} WAL setup fails closed before execute/batch/transaction`,async()=>{
  local();mode=failure;const client=getClient();
  await assert.rejects(client.execute('SELECT 1'));await assert.rejects(client.batch(['SELECT 2']));await assert.rejects(client.transaction('read'));await assert.rejects(client.executeMultiple('SELECT 3'));
  assert.deepEqual(calls,['PRAGMA journal_mode=WAL']);await closeLocalDevelopmentClient();assert.equal(client.closed,true);
});

test('remote clients are never given a journal PRAGMA, even with execution queue enabled',async()=>{
  delete process.env.RANDORI_LOCAL_RUNTIME;process.env.EXECUTION_QUEUE_ENABLED='true';process.env.NODE_ENV='production';process.env.TURSO_DATABASE_URL='libsql://fixture.invalid';process.env.TURSO_AUTH_TOKEN='fixture-token';
  const client=getClient();assert.equal(client.protocol,'http');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[]);assert.deepEqual(creations,[{url:'libsql://fixture.invalid',authToken:'fixture-token'}]);client.close();
});

test('local guard rejects remote URLs/credentials/production before constructing a client',()=>{
  local();process.env.TURSO_DATABASE_URL='libsql://fixture.invalid';assert.throws(()=>getClient());
  process.env.TURSO_DATABASE_URL='file:///tmp/local-fixture-only.sqlite';process.env.TURSO_AUTH_TOKEN='fixture';assert.throws(()=>getClient());
  delete process.env.TURSO_AUTH_TOKEN;process.env.NODE_ENV='production';assert.throws(()=>getClient());assert.deepEqual(creations,[]);assert.deepEqual(calls,[]);
});
