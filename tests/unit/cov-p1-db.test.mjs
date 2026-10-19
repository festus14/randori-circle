import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,test} from 'node:test';
import jwt from 'jsonwebtoken';

import {
  closeLocalDevelopmentClient,
  getClient,
  installLocalDevelopmentSqlObserver,
  issueSession,
  JWT_AUDIENCE,
  JWT_ISSUER,
  revokeAccountSessions,
  revokeRequestSession,
  verifyMutationOrigin,
  verifyRequestAuth,
  verifySignedRequestAuth,
} from '../../api/_db.js';

const ENV_KEYS=['JWT_SECRET','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','RANDORI_LOCAL_RUNTIME','NODE_ENV',
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];
const ORIGINAL=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const SECRET='cov-p1-db-secret-with-at-least-thirty-two-chars';
const JTI='A'.repeat(43);
const NOW=1_800_000_000;
const cleanups=[];

afterEach(async()=>{
  while(cleanups.length) await cleanups.pop()();
  await closeLocalDevelopmentClient();
  for(const key of ENV_KEYS){
    if(ORIGINAL[key]===undefined) delete process.env[key];
    else process.env[key]=ORIGINAL[key];
  }
});

function token(claims={},{secret=SECRET}={}){
  return jwt.sign({id:5,email:'u@example.test',jti:JTI,iat:NOW-10,exp:NOW+600,...claims},secret,
    {algorithm:'HS256',issuer:JWT_ISSUER,audience:JWT_AUDIENCE});
}

function bearer(value){
  return {headers:{authorization:`Bearer ${value}`}};
}

function localFile(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-db-'));
  cleanups.push(()=>rmSync(directory,{recursive:true,force:true}));
  return pathToFileURL(join(directory,'local.sqlite')).href;
}

test('signed request auth normalizes ids and rejects malformed identities',()=>{
  process.env.JWT_SECRET=SECRET;
  const ok=verifySignedRequestAuth(bearer(token({id:undefined,uid:'12'})),{nowSeconds:NOW});
  assert.equal(ok.id,12);
  assert.equal(ok.authTransport,'bearer');
  assert.equal(Object.keys(ok).includes('jti'),false);
  assert.match(ok.sessionHash,/^[a-f0-9]{64}$/);

  const cookie=verifySignedRequestAuth({headers:{Cookie:`other=1; randori_session=${encodeURIComponent(token())}`}},{nowSeconds:NOW});
  assert.equal(cookie.authTransport,'cookie');

  for(const claims of [{id:'012'},{id:0},{id:1.5},{id:undefined,uid:undefined},{jti:'short'}]){
    assert.equal(verifySignedRequestAuth(bearer(token(claims)),{nowSeconds:NOW}),null);
  }
  assert.equal(verifySignedRequestAuth(bearer(token({},{secret:'another-secret-of-sufficient-length!!'})),{nowSeconds:NOW}),null);
  assert.equal(verifySignedRequestAuth(bearer(token()),{nowSeconds:NOW+601}),null);
  // Malformed percent-encoding in an unrelated cookie does not break parsing.
  assert.equal(verifySignedRequestAuth({headers:{cookie:'bad=%E0%A4%A; =x; noequals'}}),null);
  assert.equal(verifySignedRequestAuth(null),null);
});

test('mutation origin checks protect only cookie-authenticated unsafe requests',()=>{
  const cookie='randori_session=abc';
  assert.equal(verifyMutationOrigin({method:'GET'}),true);
  assert.equal(verifyMutationOrigin({}),true);
  assert.equal(verifyMutationOrigin({method:'POST',headers:{Authorization:'Bearer x'}}),true);
  assert.equal(verifyMutationOrigin({method:'POST',headers:{cookie:'other=1'}}),true);
  const post=(headers,socket)=>verifyMutationOrigin({method:'post',headers:{cookie,...headers},socket});
  assert.equal(post({host:'app.test'}),false);
  assert.equal(post({origin:'https://app.test'}),false);
  assert.equal(post({origin:'https://app.test',host:'app.test'}),false,'no protocol evidence');
  assert.equal(post({origin:'https://app.test',host:'app.test','x-forwarded-proto':'ftp'}),false);
  assert.equal(post({origin:'https://app.test',host:'app.test','x-forwarded-proto':'HTTPS, http'}),true);
  assert.equal(post({origin:'https://app.test',host:'app.test'},{encrypted:true}),true);
  assert.equal(post({origin:'http://app.test',host:'app.test'},{}),true);
  assert.equal(post({Origin:'https://app.test','x-forwarded-host':'app.test, evil.test',host:'x'},{encrypted:true}),true);
  assert.equal(post({origin:'https://evil.test',host:'app.test'},{encrypted:true}),false);
  for(const origin of ['https://app.test/path','https://app.test/?q=1','https://app.test/#h','https://u:p@app.test','not a url']){
    assert.equal(post({origin,host:'app.test'},{encrypted:true}),false,origin);
  }
  assert.equal(post({origin:'https://app.test',host:'bad host'},{encrypted:true}),false);
});

test('local runtime client requires a credential-free file database and observes SQL',async()=>{
  process.env.RANDORI_LOCAL_RUNTIME='true';
  process.env.NODE_ENV='development';
  delete process.env.TURSO_DATABASE_URL;
  assert.throws(()=>getClient(),/Missing TURSO_DATABASE_URL/);
  process.env.TURSO_DATABASE_URL='::not a url';
  assert.throws(()=>getClient(),/Invalid local database URL/);
  process.env.TURSO_DATABASE_URL='libsql://example.turso.io';
  assert.throws(()=>getClient(),/credential-free file database/);
  const url=localFile();
  process.env.TURSO_DATABASE_URL=url;
  process.env.TURSO_AUTH_TOKEN='secret';
  assert.throws(()=>getClient(),/credential-free file database/);
  delete process.env.TURSO_AUTH_TOKEN;
  process.env.NODE_ENV='production';
  assert.throws(()=>getClient(),/credential-free file database/);
  process.env.NODE_ENV='development';

  const seen=[];
  assert.throws(()=>installLocalDevelopmentSqlObserver('x'),TypeError);
  const restore=installLocalDevelopmentSqlObserver(sql=>{ seen.push(sql.trim().split(/\s+/)[0]); });

  const client=getClient();
  assert.equal(getClient(),client,'client is reused');
  await client.executeMultiple('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
  await client.batch([{sql:'INSERT INTO t VALUES (?)',args:[2]},'INSERT INTO t VALUES (3)'],'write');
  const transaction=await client.transaction('write');
  await transaction.execute({sql:'INSERT INTO t VALUES (?)',args:[4]});
  await transaction.execute({args:[]}).catch(()=>{});
  await transaction.commit();
  transaction.close();
  const count=await client.execute('SELECT COUNT(*) AS n FROM t');
  assert.equal(Number(count.rows[0].n),4);
  assert.equal(typeof client.closed,'boolean');
  assert.deepEqual(seen,['CREATE','INSERT','INSERT','INSERT','SELECT']);

  // A throwing observer never breaks the query, and restoring is idempotent.
  const failing=installLocalDevelopmentSqlObserver(()=>{ throw new Error('observer bug'); });
  assert.equal(Number((await client.execute('SELECT 1 AS one')).rows[0].one),1);
  failing();
  failing();
  await client.execute('SELECT 2');
  assert.equal(seen.at(-1),'SELECT');
  assert.equal(seen.length,6);

  process.env.TURSO_DATABASE_URL=localFile();
  assert.throws(()=>getClient(),/changed without shutdown/);
  restore();
  await closeLocalDevelopmentClient();
  assert.notEqual(getClient(),client);
});

test('SQL observation is refused outside the local development runtime',()=>{
  process.env.NODE_ENV='production';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  assert.throws(()=>installLocalDevelopmentSqlObserver(()=>{}),/development-only/);
  process.env.NODE_ENV='development';
  delete process.env.RANDORI_LOCAL_RUNTIME;
  assert.throws(()=>installLocalDevelopmentSqlObserver(()=>{}),/development-only/);
  // Clearing the observer is always allowed.
  const restore=installLocalDevelopmentSqlObserver(null);
  restore();
});

test('session issue rolls back when persistence fails and survives rollback errors',async()=>{
  process.env.JWT_SECRET=SECRET;
  await assert.rejects(issueSession(null,{id:1,email:'a@b.test'}),TypeError);
  const events=[];
  const db={async transaction(){
    return {
      async execute(){ events.push('execute'); return {rows:[]}; },
      async commit(){ events.push('commit'); },
      async rollback(){ events.push('rollback'); throw new Error('rollback failed'); },
    };
  }};
  await assert.rejects(issueSession(db,{id:1,email:'a@b.test'},{nowSeconds:NOW}),/session persistence failed/);
  assert.deepEqual(events,['execute','rollback']);
  await assert.rejects(issueSession(db,{id:1,email:''},{nowSeconds:NOW}),TypeError);
});

test('session revocation validates inputs and reports what changed',async()=>{
  process.env.JWT_SECRET=SECRET;
  const db={calls:[],async execute(statement){ this.calls.push(statement); return {}; }};
  for(const args of [[db,0,'logout_all'],[db,1,'bogus'],[db,1,'logout_all',{nowSeconds:0}],[null,1,'logout_all']]){
    await assert.rejects(revokeAccountSessions(...args),TypeError);
  }
  assert.equal(await revokeAccountSessions(db,'3','logout_all',{nowSeconds:NOW}),0);

  assert.deepEqual(await revokeRequestSession(db,{headers:{}}),{authenticated:false,revoked:false,userId:null});
  const req=bearer(token());
  await assert.rejects(revokeRequestSession(db,req,{reason:'bogus',nowSeconds:NOW}),TypeError);
  await assert.rejects(revokeRequestSession(null,req,{nowSeconds:NOW}),TypeError);
  assert.deepEqual(await revokeRequestSession(db,req,{nowSeconds:NOW}),{authenticated:true,revoked:false,userId:5});
});

test('request auth requires one live session row and revokes on lapsed membership',async()=>{
  process.env.JWT_SECRET=SECRET;
  const req=bearer(token());
  const rowsDb=(rows)=>({calls:[],async execute(statement){ this.calls.push(statement); return rows===undefined?{}:{rows}; }});
  assert.equal(await verifyRequestAuth(req,{},{nowSeconds:NOW}),null);
  assert.equal(await verifyRequestAuth(req,rowsDb([{user_id:5}]),{nowSeconds:0}),null);
  assert.equal(await verifyRequestAuth(req,rowsDb(undefined),{nowSeconds:NOW}),null);
  assert.equal(await verifyRequestAuth(req,rowsDb([{user_id:6}]),{nowSeconds:NOW}),null);
  assert.equal((await verifyRequestAuth(req,rowsDb([{user_id:5}]),{nowSeconds:NOW})).id,5);

  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const lapsed=rowsDb([{user_id:5,active_membership:0}]);
  assert.equal(await verifyRequestAuth(req,lapsed,{nowSeconds:NOW}),null);
  assert.equal(lapsed.calls.length,2);
  assert.doesNotMatch(lapsed.calls[0].sql,/circle\.is_primary=1/);
  assert.deepEqual(lapsed.calls[1].args,[NOW,'membership_removed',5,NOW]);

  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
  const active=rowsDb([{user_id:5,active_membership:1}]);
  assert.equal((await verifyRequestAuth(req,active,{nowSeconds:NOW})).id,5);
  assert.match(active.calls[0].sql,/circle\.is_primary=1/);
});
