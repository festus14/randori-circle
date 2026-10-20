import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import * as Y from 'yjs';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

let currentDb=null;
let directory=null;

function auth(req){
  if(req?.headers?.['x-test-auth-failure']) return Promise.reject(new Error('session store unavailable'));
  const id=Number(req?.headers?.['x-test-user']);
  return Number.isSafeInteger(id)&&id>0?{id}:null;
}

mock.module('../../api/_db.js',{exports:{
  getClient:()=>currentDb,verifyMutationOrigin:()=>true,verifyRequestAuth:auth,
}});

const {default:handler}=await import('../../api/code-document.js');

function invoke({method='GET',query={},body={},user=1,headers:requestHeaders={}}={}){
  const search=new URLSearchParams(query).toString();
  return new Promise((resolve,reject)=>{
    let status=200; const headers={}; let settled=false;
    const finish=value=>{ if(!settled){ settled=true; resolve({status,headers,body:value}); } };
    const res={status(value){ status=value; return this; },setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },end(value){ finish(value); return this; }};
    const req={method,url:`/api/code-document${search?`?${search}`:''}`,query,body,
      headers:{...(user?{'x-test-user':String(user)}:{}),...requestHeaders}};
    Promise.resolve(handler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function database(){
  directory=mkdtempSync(join(tmpdir(),'randori-code-document-api-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222'),
    (9,'outside@example.test','hash','Outside','#999999')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
    VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,1,0,'auth'),(10,2,1,'auth'),(10,9,2,'auth')`);
  return db;
}

const query={room_id:'week_10_pair_20',question_slug:'focus-block-rollup',question_version:'1',language:'javascript'};

beforeEach(()=>{
  currentDb=null;
  for(const key of ['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED']) delete process.env[key];
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(directory){ rmSync(directory,{recursive:true,force:true}); directory=null; }
});

test('code-document API is private, no-store, and returns the same 404 for denied rooms',async()=>{
  currentDb=await database();
  const anonymous=await invoke({query,user:null}); assert.equal(anonymous.status,401);
  const crossSite=await invoke({query,headers:{cookie:'randori_session=test','sec-fetch-site':'cross-site'}});
  assert.equal(crossSite.status,403);
  const outsider=await invoke({query,user:9}); assert.equal(outsider.status,404);
  assert.deepEqual(outsider.body,{ok:false,error:'code document not found'});
  const malformed=await invoke({query:{...query,room_id:'week_10_pair_020'}}); assert.equal(malformed.status,400);
  const member=await invoke({query,user:1});
  assert.equal(member.status,200); assert.equal(member.headers['cache-control'],'private, no-store');
  assert.equal(member.body.ok,true); assert.equal(member.body.created,true);
  assert.match(member.body.document_version,/^[a-f0-9]{64}$/);
  const futureCursor=await invoke({query:{...query,after_revision:'999'},user:1});
  assert.equal(futureCursor.status,200); assert.equal(futureCursor.body.changed,true);
  assert.equal(typeof futureCursor.body.state,'string');
});

test('code-document API returns the controlled 503 when session verification rejects',async()=>{
  currentDb=await database();
  for(const method of ['GET','POST']){
    const failed=await invoke({method,query,headers:{'x-test-auth-failure':'1'}});
    assert.equal(failed.status,503);
    assert.deepEqual(failed.body,{ok:false,error:'code document unavailable'});
  }
  const anonymous=await invoke({query,user:null});
  assert.equal(anonymous.status,401);
  assert.deepEqual(anonymous.body,{ok:false,error:'authentication required'});
});

test('code-document API merges a canonical update and duplicate delivery is no-write success',async()=>{
  currentDb=await database();
  const initial=(await invoke({query})).body;
  const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(initial.state,'base64'));
  const vector=Y.encodeStateVector(doc); doc.getText('code').insert(0,'shared');
  const update=Buffer.from(Y.encodeStateAsUpdate(doc,vector)).toString('base64');
  const body={room_id:query.room_id,question_slug:query.question_slug,question_version:1,
    language:'javascript',update,client_id:'client_api',client_seq:1};
  const merged=await invoke({method:'POST',body});
  assert.equal(merged.status,200); assert.equal(merged.body.idempotent,false);
  assert.equal(merged.body.revision,2);
  const duplicate=await invoke({method:'POST',body:{...body,client_seq:0}});
  assert.equal(duplicate.status,200); assert.equal(duplicate.body.idempotent,true);
  assert.equal(duplicate.body.revision,2);
});
