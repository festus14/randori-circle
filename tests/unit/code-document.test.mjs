import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import * as Y from 'yjs';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import {
  CodeDocumentDataError,
  CodeDocumentInputError,
  getAuthorizedCodeDocument,
  mergeAuthorizedCodeDocument,
  parseCodeDocumentMutation,
  parseCodeDocumentQuery,
  readCanonicalCodeForExecution,
} from '../../api/_code-document.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const IDENTITY={roomId:'week_10_pair_20',weekId:10,pairGroupId:20,
  questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript'};

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-code-document-'));
  const path=join(directory,'test.sqlite');
  let db=createClient({url:`file:${path}`});
  return {get db(){ return db; },restart(){ db.close(); db=createClient({url:`file:${path}`}); return db; },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function migrate(db){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY});
}

async function seed(db,{triad=false,ai=false,mixed=false,workspace=true}={}){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0),
    (3,'three@example.test','hash','Three','#333333',0),(9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO users (id,name,color) VALUES (2,'Legacy Two','#222222')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo) VALUES
    (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute({sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
    VALUES (20,10,1,?,?,?)`,args:[ai?1:2,triad?3:null,ai?1:0]});
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth')`);
  if(!ai) await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,1,?)`,args:[mixed?'users':'auth']});
  if(triad) await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,3,2,'auth')`);
  if(workspace&&!ai&&!triad){
    await db.execute({sql:`INSERT INTO pair_room_snapshots
      (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,args:[IDENTITY.roomId,10,20,4,3,'workspace-client',4,'javascript',
        'focus-block-rollup@1',JSON.stringify({code:'return base;',board:{shapes:[]}}),1]});
  }
}

function updateFromState(state,edit){
  const base=new Y.Doc(); Y.applyUpdate(base,Buffer.from(state,'base64'));
  const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(state,'base64'));
  const before=Y.encodeStateVector(base); edit(doc.getText('code'));
  return Buffer.from(Y.encodeStateAsUpdate(doc,before)).toString('base64');
}

function input(update,{clientId='client_A1',clientSeq=1}={}){
  return {...IDENTITY,viewerId:1,update:Buffer.from(update,'base64'),clientId,clientSeq};
}

test('v20 bootstrap is server-serialized from the matching v3 workspace and survives restart',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const first=await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY,afterRevision:0});
    assert.equal(first.created,true); assert.equal(first.document.code,'return base;');
    assert.equal(first.document.revision,1); assert.match(first.document.version,/^[a-f0-9]{64}$/);
    const second=await getAuthorizedCodeDocument(item.db,{viewerId:2,...IDENTITY,afterRevision:0});
    assert.equal(second.created,false); assert.equal(second.document.state,first.document.state);
    const restarted=await getAuthorizedCodeDocument(item.restart(),{viewerId:1,...IDENTITY,afterRevision:0});
    assert.equal(restarted.document.code,'return base;');
    assert.equal(restarted.document.version,first.document.version);
  }finally{ item.close(); }
});

test('concurrent same-offset updates merge in either delivery order and duplicates do not advance revision',async()=>{
  for(const order of [[0,1],[1,0]]){
    const item=fixture();
    try{
      await migrate(item.db); await seed(item.db);
      const initial=(await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY})).document;
      const updates=[
        updateFromState(initial.state,text=>text.insert(7,'A')),
        updateFromState(initial.state,text=>text.insert(7,'B')),
      ];
      let latest;
      for(const index of order){
        latest=await mergeAuthorizedCodeDocument(item.db,input(updates[index],{clientId:`client_${index}____`,clientSeq:index+1}));
      }
      assert.equal(latest.document.code.length,'return base;'.length+2);
      assert.ok(latest.document.code.includes('A')&&latest.document.code.includes('B'));
      const revision=latest.document.revision;
      const duplicate=await mergeAuthorizedCodeDocument(item.db,input(updates[order[0]],{clientId:'client_repeat',clientSeq:99}));
      assert.equal(duplicate.idempotent,true); assert.equal(duplicate.document.revision,revision);
      const stored=(await item.db.execute(`SELECT revision,state_hash FROM pair_code_documents`)).rows[0];
      assert.equal(Number(stored.revision),revision); assert.equal(stored.state_hash,duplicate.document.stateHash);
    }finally{ item.close(); }
  }
});

test('overlapping delete and insert converge without whole-document overwrite',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const initial=(await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY})).document;
    const deletion=updateFromState(initial.state,text=>text.delete(7,4));
    const insertion=updateFromState(initial.state,text=>text.insert(7,'shared-'));
    await mergeAuthorizedCodeDocument(item.db,input(deletion,{clientId:'client_delete',clientSeq:2}));
    const merged=await mergeAuthorizedCodeDocument(item.db,input(insertion,{clientId:'client_insert',clientSeq:1}));
    assert.ok(merged.document.code.includes('shared-'));
    assert.ok(!merged.document.code.includes('base'));
  }finally{ item.close(); }
});

test('input bounds and corrupt stored state fail closed without mutation',async()=>{
  assert.throws(()=>parseCodeDocumentQuery({url:'/api/code-document?room_id=bad',query:{room_id:'bad'}}),CodeDocumentInputError);
  assert.throws(()=>parseCodeDocumentMutation({
    room_id:IDENTITY.roomId,question_slug:IDENTITY.questionSlug,question_version:1,
    language:'javascript',update:'not base64',client_id:'client_bad',client_seq:0,
  }),CodeDocumentInputError);
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY});
    await item.db.execute(`UPDATE pair_code_documents SET y_state_base64='AAAA',state_hash='${'0'.repeat(64)}',
      code_hash='${'0'.repeat(64)}',revision=revision+1,last_actor_id=1`);
    await assert.rejects(()=>getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY}),CodeDocumentDataError);
    assert.equal((await item.db.execute(`SELECT revision FROM pair_code_documents`)).rows[0].revision,2);
  }finally{ item.close(); }
});

test('authorization makes nonexistent, outsider, AI, triad, mixed-source, and colliding rooms indistinguishable',async()=>{
  for(const [shape,viewerId] of [[{},9],[{ai:true},1],[{triad:true},1],[{mixed:true},1]]){
    const item=fixture();
    try{
      await migrate(item.db); await seed(item.db,{...shape,workspace:false});
      assert.equal(await getAuthorizedCodeDocument(item.db,{viewerId,...IDENTITY}),null);
      assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_code_documents`)).rows[0].c,0);
    }finally{ item.close(); }
  }
});

test('completion blocks writes and execution lookup binds the exact canonical version',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const initial=(await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY})).document;
    const exact=await readCanonicalCodeForExecution(item.db,{viewerId:1,room:IDENTITY,
      questionSlug:IDENTITY.questionSlug,questionVersion:1,language:'javascript',documentVersion:initial.version});
    assert.equal(exact.document.code,'return base;'); assert.equal(exact.stale,false);
    const update=updateFromState(initial.state,text=>text.insert(text.length,'!'));
    const next=await mergeAuthorizedCodeDocument(item.db,input(update));
    const stale=await readCanonicalCodeForExecution(item.db,{viewerId:1,room:IDENTITY,
      questionSlug:IDENTITY.questionSlug,questionVersion:1,language:'javascript',documentVersion:initial.version});
    assert.equal(stale.stale,true); assert.equal(stale.latestVersion,next.document.version);
    const confirmed='2026-09-20T10:00:00.000Z';
    for(const userId of [1,2]) await item.db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (10,20,?,'auth',1,2,NULL,?)`,args:[userId,confirmed]});
    const blocked=await mergeAuthorizedCodeDocument(item.db,input(update,{clientId:'client_after',clientSeq:2}));
    assert.equal(blocked.terminal,true);
    const run=await readCanonicalCodeForExecution(item.db,{viewerId:1,room:IDENTITY,
      questionSlug:IDENTITY.questionSlug,questionVersion:1,language:'javascript',documentVersion:next.document.version});
    assert.equal(run.terminal,true);
  }finally{ item.close(); }
});

test('expired documents are deleted before access and rebuilt without retaining stale CRDT content',async()=>{
  const item=fixture();
  try{
    await migrate(item.db); await seed(item.db);
    const initial=(await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY})).document;
    const update=updateFromState(initial.state,text=>text.insert(text.length,' private'));
    const privateDocument=(await mergeAuthorizedCodeDocument(item.db,input(update))).document;
    await item.db.execute(`DELETE FROM pair_code_documents`);
    await item.db.execute({sql:`INSERT INTO pair_code_documents
      (week_id,pair_group_id,question_slug,question_version,language,y_state_base64,state_hash,code_hash,
       revision,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,
       last_actor_id,last_actor_source,last_client_id,last_client_seq,created_at,updated_at)
      VALUES (10,20,'focus-block-rollup',1,'javascript',?,?,?,?,1,'auth',2,'auth',NULL,1,'auth',
        'client_old',2,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`,
      args:[privateDocument.state,privateDocument.stateHash,privateDocument.codeHash,privateDocument.revision]});
    const rebuilt=await getAuthorizedCodeDocument(item.db,{viewerId:1,...IDENTITY});
    assert.equal(rebuilt.created,true); assert.equal(rebuilt.document.code,'');
  }finally{ item.close(); }
});
