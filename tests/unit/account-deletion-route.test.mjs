// Fail-closed branches of the /api/auth/account/delete handler (issue #339).
// Only the deletion module and the auth readiness probe are replaced, so each
// collaborator can fail on demand; sessions, origin checks and rate limits are
// the real ones on a migrated database (see account-deletion-api.test.mjs for
// the end-to-end behaviour).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

let S;
function freshState(){
  return {
    ready:async()=>{},
    eligibility:async()=>({ok:true}),
    deletedForSession:async()=>false,
    remove:async()=>({ok:true,status:'deleted'}),
  };
}
S=freshState();

mock.module('../../api/_auth-readiness.js',{exports:{ensureAuthReadiness:async()=>{}}});
mock.module('../../api/_account-deletion.js',{exports:{
  // api/_data-export.js (imported by api/auth.js) reads this at import time.
  ACCOUNT_DATA_INVENTORY:[],
  DELETED_ACCOUNT_PASSWORD_HASH:'!account-deleted',
  LIVE_ACCOUNT_SQL:"password_hash<>'!account-deleted'",
  accountDeletionEnabled:()=>process.env.ACCOUNT_DELETION_ENABLED==='true',
  accountDeletedForSession:(...args)=>S.deletedForSession(...args),
  deleteAccount:(...args)=>S.remove(...args),
  ensureAccountDeletionReadiness:(...args)=>S.ready(...args),
  parseAccountDeletionRequest:body=>{
    if(body?.confirm!=='DELETE'||Object.keys(body).length!==1) throw new Error('confirmation_required');
    return body;
  },
  readAccountDeletionEligibility:(...args)=>S.eligibility(...args),
}});

const {default:handler}=await import('../../api/auth.js');
const {issueSession}=await import('../../api/_db.js');

const ENV_KEYS=['ACCOUNT_DELETION_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','JWT_SECRET','NODE_ENV','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const resources=[];

beforeEach(()=>{ S=freshState(); });
afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

function response(){
  return {
    statusCode:200,headers:{},body:null,
    status(code){ this.statusCode=code; return this; },
    setHeader(name,value){ this.headers[String(name).toLowerCase()]=value; },
    getHeader(name){ return this.headers[String(name).toLowerCase()]; },
    json(value){ this.body=value; return this; },
  };
}

async function call({method='GET',body,cookie=''}={}){
  const res=response();
  await handler({method,url:'/api/auth/account/delete',query:{endpoint:'account-delete'},body,
    headers:{host:'randori.example.test',origin:'https://randori.example.test','x-forwarded-proto':'https',cookie},
    socket:{remoteAddress:'198.51.100.9'}},res);
  return res;
}

async function fixture(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-route-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  Object.assign(process.env,{NODE_ENV:'production',JWT_SECRET:'account-deletion-route-secret-at-least-32-bytes',
    TURSO_DATABASE_URL:url,ACCOUNT_DELETION_ENABLED:'true'});
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  delete process.env.TURSO_AUTH_TOKEN;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES (2,'member@example.test','x','Member','#222222')`);
  const token=await issueSession(db,{id:2,email:'member@example.test',name:'Member'});
  return {db,cookie:`randori_session=${encodeURIComponent(token)}`};
}

const UNAVAILABLE=[503,{error:'account deletion temporarily unavailable'}];

test('every collaborator failure answers 503 and an impossible state answers 401',async()=>{
  const {db,cookie}=await fixture();
  S.eligibility=async()=>{ throw new Error('read failed'); };
  let res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
  S.eligibility=async()=>({ok:false,reason:'not_found'});
  res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],[401,{error:'authentication required'}]);

  S.remove=async()=>{ throw new Error('write failed'); };
  res=await call({method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
  S.remove=async()=>({ok:false,reason:'not_found'});
  res=await call({method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([res.statusCode,res.body],[401,{error:'authentication required'}]);
  S.remove=async(database,{userId,sessionHash,adminEmails,hashInvitationEmail})=>{
    assert.equal(typeof database.execute,'function');
    assert.equal(typeof hashInvitationEmail,'function');
    assert.equal(userId,2);
    assert.match(sessionHash,/^[a-f0-9]{64}$/);
    assert.ok(adminEmails instanceof Set);
    return {ok:true,status:'deleted'};
  };
  res=await call({method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([res.statusCode,res.body],[200,{ok:true,status:'deleted'}]);

  await db.execute(`DROP TABLE auth_rate_limits`);
  res=await call({method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);

  S.ready=async()=>{ throw new Error('schema drift'); };
  res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
});

test('a dead session is checked for an earlier deletion only on POST, and that check fails closed',async()=>{
  const {db,cookie}=await fixture();
  await db.execute(`UPDATE auth_sessions SET revoked_at=created_at,revocation_reason='logout_all'`);
  let asked=0;
  S.deletedForSession=async(database,{userId,sessionHash})=>{
    asked+=1;
    assert.equal(userId,2);
    assert.match(sessionHash,/^[a-f0-9]{64}$/);
    return false;
  };
  assert.equal((await call({cookie})).statusCode,401);
  assert.equal(asked,0);
  assert.equal((await call({method:'POST',body:{confirm:'DELETE'},cookie})).statusCode,401);
  assert.equal(asked,1);
  assert.equal((await call({method:'POST',body:{confirm:'DELETE'}})).statusCode,401,'no credential, nothing to check');
  assert.equal(asked,1);
  S.deletedForSession=async()=>{ throw new Error('read failed'); };
  const res=await call({method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
});
