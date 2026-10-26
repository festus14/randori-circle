// Fail-closed branches of the /api/auth/account/export handler (issue #365).
// Only the export module and the auth readiness probe are replaced, so each
// collaborator can fail on demand; sessions, recent auth and rate limits are
// the real ones on a migrated database (see data-export-api.test.mjs for
// the end-to-end behaviour).
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

class TooLarge extends Error{
  constructor(){ super('too large'); this.name='DataExportTooLargeError'; this.code='EXPORT_TOO_LARGE'; }
}

let S;
function freshState(){
  return {
    ready:async()=>{},
    build:async()=>({version:1,format:'randori-circle-data-export',account:{id:2}}),
  };
}
S=freshState();

mock.module('../../api/_auth-readiness.js',{exports:{ensureAuthReadiness:async()=>{}}});
mock.module('../../api/_data-export.js',{exports:{
  DataExportTooLargeError:TooLarge,
  dataExportEnabled:()=>process.env.DATA_EXPORT_ENABLED==='true',
  ensureDataExportReadiness:(...args)=>S.ready(...args),
  buildDataExport:(...args)=>S.build(...args),
}});

const {default:handler}=await import('../../api/auth.js');
const {issueSession}=await import('../../api/_db.js');

const ENV_KEYS=['DATA_EXPORT_ENABLED','JWT_SECRET','NODE_ENV','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL'];
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

async function call({method='GET',cookie=''}={}){
  const res=response();
  await handler({method,url:'/api/auth/account/export',query:{endpoint:'account-export'},
    headers:{host:'randori.example.test',origin:'https://randori.example.test','x-forwarded-proto':'https',cookie},
    socket:{remoteAddress:'198.51.100.9'}},res);
  return res;
}

async function fixture({recent=true}={}){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-data-export-route-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  Object.assign(process.env,{NODE_ENV:'production',JWT_SECRET:'data-export-route-secret-at-least-32-bytes',
    TURSO_DATABASE_URL:url,DATA_EXPORT_ENABLED:'true'});
  delete process.env.TURSO_AUTH_TOKEN;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES (2,'member@example.test','x','Member','#222222')`);
  const token=await issueSession(db,{id:2,email:'member@example.test',name:'Member'},
    recent?{recentAuthMethod:'password'}:{});
  return {db,cookie:`randori_session=${encodeURIComponent(token)}`};
}

const UNAVAILABLE=[503,{error:'data export temporarily unavailable'}];

test('every collaborator failure answers 503, an oversized export answers 413, and success downloads',async()=>{
  const {db,cookie}=await fixture();
  S.ready=async()=>{ throw new Error('schema drift'); };
  assert.deepEqual([(await call({cookie})).statusCode,(await call({cookie})).body],UNAVAILABLE);
  S.ready=async()=>{};
  S.build=async()=>{ throw new Error('read failed'); };
  let res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
  S.build=async()=>{ throw new TooLarge(); };
  res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],[413,{error:'data export is too large',code:'export_too_large'}]);
  let seen=null;
  S.build=async(database,options)=>{ seen=options; return {version:1,account:{id:2}}; };
  res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],[200,{version:1,account:{id:2}}]);
  assert.equal(res.getHeader('content-disposition'),'attachment; filename="randori-circle-data-export.json"');
  assert.deepEqual(seen,{userId:2});
  await db.execute(`DROP TABLE auth_rate_limits`);
  res=await call({cookie});
  assert.deepEqual([res.statusCode,res.body],UNAVAILABLE);
});

test('unauthenticated, stale-proof and flag-off requests never reach the builder',async()=>{
  const {cookie}=await fixture();
  let builds=0;
  S.build=async()=>{ builds+=1; return {}; };
  assert.equal((await call()).statusCode,401);
  const stale=await fixture({recent:false});
  const res=await call({cookie:stale.cookie});
  assert.deepEqual([res.statusCode,res.body],[403,{error:'recent authentication required',code:'recent_auth_required'}]);
  process.env.DATA_EXPORT_ENABLED='false';
  const off=await call({cookie});
  assert.equal(off.statusCode,404);
  assert.equal(builds,0);
});

test('a non-GET method answers 405',async()=>{
  const {cookie}=await fixture();
  const res=await call({method:'POST',cookie});
  assert.deepEqual([res.statusCode,res.body],[405,{error:'GET only'}]);
  assert.equal(res.getHeader('allow'),'GET');
});
