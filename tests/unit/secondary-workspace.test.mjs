import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createClient} from '@libsql/client';
import {copyMigratedDatabase} from '../support/migrated-db.mjs';
import {prepareMigrationConnection} from '../../db/migration-runner.js';
import {enableWorkspace,seedSecondaryCircle} from '../support/secondary-workspace-fixture.mjs';
import {resolveWorkspaceContext,scopedWorkspaceClient,parseSecondaryRoomPath} from '../../api/_workspace-access.js';
import {sendSecondaryMessage,readSecondaryMessages,readSecondaryCompletion,mutateSecondaryCompletion,
  readSecondaryControls,mutateSecondaryControls,readSecondaryDocument,mutateSecondaryDocument,readSecondarySnapshot,
  mutateSecondarySnapshot,readSecondaryMeetingLink,mutateSecondaryMeetingLink,readSecondarySignals,mutateSecondarySignals} from '../../api/_secondary-workspace.js';
import {secondaryChatRetentionClient} from '../../api/_secondary-chat-retention.js';
import {chatRetentionEvidenceBindingDigest,enqueueNextChatRetentionRun,setChatRetentionControl,runChatRetentionWorker,
  adoptChatRetentionScope,placeChatRetentionHold,releaseChatRetentionHold} from '../../api/_chat-retention.js';
import {readWorkspaceHistory} from '../../api/_workspace-history.js';
import {executeSecondaryProgram,verifySecondaryRun} from '../../api/_secondary-execution.js';
import {readSecondaryRuns} from '../../api/_secondary-workspace.js';
import * as Y from 'yjs';
import {buildDataExport} from '../../api/_data-export.js';
const KEY='workspace-test-key-at-least-thirty-two-characters',HASH='a'.repeat(64);
process.env.JWT_SECRET=KEY;
async function fixture(){
  const restore=enableWorkspace(),directory=mkdtempSync(join(tmpdir(),'randori-438-unit-'));
  const db=createClient({url:`file:${await copyMigratedDatabase(join(directory,'test.sqlite'))}`});
  await prepareMigrationConnection(db);
  for(const id of [1,2,3])await db.execute({sql:`INSERT INTO auth_accounts(id,email,password_hash,display_name,color,is_available) VALUES(?,?,?,?,?,0)`,args:[id,`438-${id}@example.test`,'hash',`User ${id}`,'#123456']});
  const secondary=await seedSecondaryCircle(db,{users:[1,2,3],unavailable:[3]});
  await db.execute({sql:`INSERT INTO auth_sessions(session_hash,user_id,created_at,expires_at) VALUES(?,1,1,4000000000)`,args:[HASH]});
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts(session_hash,user_id,circle_id,context_version,updated_at) VALUES(?,1,20,7,1)`,args:[HASH]});
  const context=await resolveWorkspaceContext(db,{id:1,sessionHash:HASH},{headers:{'x-randori-circle-context-version':'7'}}),client=scopedWorkspaceClient(db,context),room=parseSecondaryRoomPath(`/join/${secondary.room}`);
  return {db,client,room,secondary,close(){db.close();rmSync(directory,{recursive:true,force:true});restore();}};
}
const identity={questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript'};
const snapshotBody=(room,revision=0,code='code')=>({room_id:room.roomId,type:'code-sync',payload:{schema_version:3,client_id:'unit_438_snapshot',client_seq:revision+1,base_revision:revision,language:'javascript',question_id:identity.questionSlug,question_version:1,code,board:{shapes:[]}}});

test('secondary chat, snapshots, documents, signals and controls use only the owning circle',async()=>{
  const f=await fixture();try{
    await sendSecondaryMessage(f.client,f.room,{room_id:f.room.roomId,message:'private secondary'});
    assert.equal((await readSecondaryMessages(f.client,f.room)).messages[0].message,'private secondary');
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM pair_messages')).rows[0].count,0);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM chat_retention_scopes')).rows[0].count,0);
    assert.equal((await f.db.execute('SELECT circle_id,group_id FROM circle_chat_retention_scopes')).rows[0].circle_id,20);
    const saved=await mutateSecondarySnapshot(f.client,f.room,snapshotBody(f.room),KEY);assert.equal(saved.revision,1);
    const tx=await f.client.transaction('write');let initial;
    try{initial=await readSecondaryDocument(tx,f.room,identity);await tx.commit();}finally{await tx.close();}
    assert.equal(initial.document.code,'code');
    const y=new Y.Doc();Y.applyUpdate(y,Buffer.from(initial.document.stateBase64,'base64'));y.getText('code').insert(0,'// second\n');
    const update=Buffer.from(Y.encodeStateAsUpdate(y)).toString('base64');y.destroy();
    const merged=await mutateSecondaryDocument(f.client,f.room,{room_id:f.room.roomId,question_slug:identity.questionSlug,question_version:1,language:'javascript',client_id:'unit_438_editor',client_seq:1,update},KEY);
    assert.equal(merged.document.code,'// second\ncode');
    assert.equal((await readSecondarySnapshot(f.client,f.room)).snapshot.code,'// second\ncode');
    const duplicate=await mutateSecondaryDocument(f.client,f.room,{room_id:f.room.roomId,question_slug:identity.questionSlug,question_version:1,language:'javascript',client_id:'unit_438_editor',client_seq:1,update},KEY);assert.equal(duplicate.idempotent,true);
    const controls=await readSecondaryControls(f.client,f.room,KEY);
    const started=await mutateSecondaryControls(f.client,f.room,{room_id:f.room.roomId,action:'start',base_version:controls.state.version},KEY);assert.equal(started.state.timer_state,'running');
    const paused=await mutateSecondaryControls(f.client,f.room,{room_id:f.room.roomId,action:'pause',base_version:started.state.version},KEY);assert.equal(paused.state.timer_state,'paused');
    await assert.rejects(mutateSecondaryControls(f.client,f.room,{room_id:f.room.roomId,action:'set_candidate',base_version:paused.state.version,candidate_user_id:3},KEY));
    const meeting=await readSecondaryMeetingLink(f.client,f.room,KEY);assert.equal(meeting.state.lifecycle,'unscheduled');
    await assert.rejects(mutateSecondaryMeetingLink(f.client,f.room,{room_id:f.room.roomId,action:'set',base_version:'a'.repeat(64),schedule_version:meeting.state.schedule_version,completion_version:meeting.state.completion_version,url:'https://meet.example.test/room'},KEY),{code:'meeting_link_schedule_required'});
    await mutateSecondarySignals(f.client,f.room,{from_id:'unit_peer',type:'join',payload:{safe:true}});
    assert.equal((await readSecondarySignals(f.client,f.room)).signals.length,1);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM video_signals')).rows[0].count,0);
    await mutateSecondarySignals(f.client,f.room,{}, {purge:true});assert.equal((await readSecondarySignals(f.client,f.room)).signals.length,0);
    const archive=await buildDataExport(f.db,{userId:1});
    assert.equal(archive.secondary_workspace.messages[0].message,'private secondary');
    assert.equal(archive.secondary_workspace.messages[0].circle_id,20);
    assert.equal(archive.secondary_workspace.session_controls[0].timer_state,'paused');
    assert.equal(archive.secondary_workspace.session_controls[0].updated_by,'User 1');
    assert.equal(JSON.stringify(archive.secondary_workspace).includes('group_user_b_id'),false);
    assert.equal((await buildDataExport(f.db,{userId:2})).secondary_workspace.messages.length,0);
    const history=await readWorkspaceHistory(f.client,f.client.workspaceContext,KEY);assert.equal(history.total,1);assert.equal(history.history[0].circle.public_id,f.secondary.publicId);
  }finally{f.close();}
});

test('secondary custom runs use the same privacy, flag, cap and verified-feed boundaries',async()=>{
  const previous={stdin:process.env.EXECUTION_STDIN_ENABLED,provider:process.env.EXECUTION_PROVIDER,url:process.env.EXECUTION_API_URL,fetch:globalThis.fetch};
  const f=await fixture();try{
    await mutateSecondarySnapshot(f.client,f.room,snapshotBody(f.room,0,'function rollUpFocusBlocks(){ return []; }'),KEY);
    const tx=await f.client.transaction('write');let initial;
    try{initial=await readSecondaryDocument(tx,f.room,identity);await tx.commit();}finally{await tx.close();}
    const body={room_id:f.room.roomId,language:'javascript',question_slug:identity.questionSlug,question_version:1,
      code:'FORGED_CLIENT_CODE',document_version:initial.document.version,stdin:'SECONDARY_PRIVATE_INPUT'};
    const req={body,url:'/api/execute',headers:{},socket:{remoteAddress:'127.0.0.1'}};
    process.env.EXECUTION_PROVIDER='piston';process.env.EXECUTION_API_URL='https://runner.example.test/execute';
    process.env.EXECUTION_STDIN_ENABLED='false';
    await assert.rejects(executeSecondaryProgram(f.client,f.room,req,KEY),{status:404});
    process.env.EXECUTION_STDIN_ENABLED='true';
    await assert.rejects(executeSecondaryProgram(f.client,f.room,{...req,body:{...body,stdin:'é'.repeat(10001)}},KEY),{status:413});
    const requests=[];
    globalThis.fetch=async(_url,options)=>{
      const request=JSON.parse(options.body);requests.push(request);
      return new Response(JSON.stringify({run:{code:0,stdout:Object.hasOwn(request,'stdin')?'SECONDARY_PRIVATE_OUTPUT':'',stderr:''}}));
    };
    const result=await executeSecondaryProgram(f.client,f.room,req,KEY);
    assert.equal(result.custom_run.stdout,'SECONDARY_PRIVATE_OUTPUT');assert.equal(result.passed_count,0);
    assert.equal(requests.length,2);
    assert.equal(requests.find(request=>Object.hasOwn(request,'stdin')).files[0].content,initial.document.code);
    assert.equal(Object.hasOwn(requests[0],'stdin'),false);
    const runs=await readSecondaryRuns(f.client,f.room,{verify:verifySecondaryRun});
    assert.equal(runs.runs.length,1);assert.equal(runs.runs[0].authoritative,true);
    const stored=(await f.db.execute('SELECT * FROM circle_session_runs')).rows;
    const logs=(await f.db.execute('SELECT * FROM app_logs')).rows;
    for(const value of ['SECONDARY_PRIVATE_INPUT','SECONDARY_PRIVATE_OUTPUT','FORGED_CLIENT_CODE','custom_run']){
      assert.equal(JSON.stringify(runs).includes(value),false);
      assert.equal(JSON.stringify(stored).includes(value),false);
      assert.equal(JSON.stringify(logs).includes(value),false);
    }
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM session_runs')).rows[0].count,0);
  }finally{
    globalThis.fetch=previous.fetch;
    for(const [name,value] of [['EXECUTION_STDIN_ENABLED',previous.stdin],['EXECUTION_PROVIDER',previous.provider],['EXECUTION_API_URL',previous.url]]){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    f.close();
  }
});

test('first receipt freezes the complete secondary group and eligibility; membership and context changes revoke writes',async()=>{
  const f=await fixture();try{
    const initial=await readSecondaryCompletion(f.client,f.room,KEY);
    const confirmed=await mutateSecondaryCompletion(f.client,f.room,{room_id:f.room.roomId,action:'confirm',base_version:initial.completion.version},KEY);
    assert.equal(confirmed.completion.required_count,2);assert.equal(confirmed.completion.confirmed_count,1);
    const retry=await mutateSecondaryCompletion(f.client,f.room,{room_id:f.room.roomId,action:'confirm',base_version:'f'.repeat(64)},KEY);assert.equal(retry.completion.version,confirmed.completion.version);
    await assert.rejects(f.db.execute({sql:'UPDATE circle_pairing_groups SET user_a_id=user_a_id WHERE id=?',args:[f.room.groupId]}));
    await assert.rejects(f.db.execute({sql:'DELETE FROM circle_pairing_eligibility WHERE publication_id=?',args:[f.room.publicationId]}));
    await assert.rejects(f.db.execute(`UPDATE circle_session_completion_receipts SET confirmed_at='2000-01-01T00:00:00.000Z'`));
    const withdrawn=await mutateSecondaryCompletion(f.client,f.room,{room_id:f.room.roomId,action:'withdraw',base_version:confirmed.completion.version},KEY);assert.equal(withdrawn.completion.confirmed_count,0);
    await f.db.execute({sql:'UPDATE auth_session_circle_contexts SET context_version=8 WHERE session_hash=?',args:[HASH]});
    await assert.rejects(sendSecondaryMessage(f.client,f.room,{room_id:f.room.roomId,message:'stale'}),{code:'circle_context_changed'});
    await f.db.execute({sql:'UPDATE auth_session_circle_contexts SET context_version=7 WHERE session_hash=?',args:[HASH]});
    await f.db.execute('UPDATE circle_memberships SET status=\'inactive\' WHERE circle_id=20 AND user_id=1');
    await assert.rejects(sendSecondaryMessage(f.client,f.room,{room_id:f.room.roomId,message:'left'}),{code:'circle_context_changed'});
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM circle_pair_messages')).rows[0].count,0);
  }finally{f.close();}
});

async function evidence(db,scope){
  const row=(await db.execute(`SELECT strftime('%Y-%m-%dT00:00:00.000Z','now','-90 days') AS cutoff,
    strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AS exported_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') AS backup_at`)).rows[0];
  const high=Number((await db.execute({sql:'SELECT MAX(id) AS id FROM pair_messages WHERE week_id=? AND pair_group_id=?',args:[scope.weekId,scope.pairGroupId]})).rows[0].id);
  const backup={digest:'a'.repeat(64),throughAt:row.cutoff,completedAt:row.backup_at,sourceMaxMessageId:high},exported={digest:'b'.repeat(64),throughAt:row.cutoff,completedAt:row.exported_at,sourceMaxMessageId:high};
  return {scope,backup:{...backup,scopeBindingDigest:chatRetentionEvidenceBindingDigest({kind:'backup',scope,...backup})},exported:{...exported,scopeBindingDigest:chatRetentionEvidenceBindingDigest({kind:'export',scope,...exported})}};
}
test('parallel retention: colliding primary and secondary group IDs have independent scopes, holds, leases and purges',async()=>{
  const f=await fixture();try{
    await sendSecondaryMessage(f.client,f.room,{room_id:f.room.roomId,message:'secondary expired'});
    await f.db.execute(`UPDATE circle_pair_messages SET created_at='2000-01-01T00:00:00.000Z'`);
    await f.db.execute({sql:`INSERT INTO chat_retention_scopes(week_id,pair_group_id,scope_key,circle_id) VALUES(10,?,'circle:1',1)`,args:[f.room.groupId]});
    await f.db.execute({sql:`INSERT INTO pair_messages(week_id,pair_group_id,sender_id,message,created_at) VALUES(10,?,1,'primary expired','2000-01-01T00:00:00.000Z')`,args:[f.room.groupId]});
    const worker=secondaryChatRetentionClient(f.db),secondaryScope={scopeKey:'circle:20',circleId:20,weekId:f.room.publicationId,pairGroupId:f.room.groupId},primaryScope={scopeKey:'circle:1',circleId:1,weekId:10,pairGroupId:f.room.groupId};
    assert.deepEqual(await adoptChatRetentionScope(worker,{scope:secondaryScope}),{created:false});
    await setChatRetentionControl(worker,{enabled:true,expectedGeneration:0});await setChatRetentionControl(f.db,{enabled:true,expectedGeneration:0});
    await enqueueNextChatRetentionRun(worker,{mode:'dry_run',...await evidence(worker,secondaryScope)});
    await runChatRetentionWorker({db:worker,workerId:'secondary-dry',enabled:true,mode:'dry_run'});
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM circle_pair_messages')).rows[0].count,1);
    await enqueueNextChatRetentionRun(worker,{mode:'purge',...await evidence(worker,secondaryScope)});
    const hold={...secondaryScope,holdLevel:'room'};
    await placeChatRetentionHold(worker,{hold,reason:'EXPORT_PENDING'});
    await runChatRetentionWorker({db:worker,workerId:'secondary-held',enabled:true,mode:'purge'});
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM circle_pair_messages')).rows[0].count,1);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM chat_retention_legal_holds')).rows[0].count,0);
    assert.equal((await f.db.execute("SELECT status FROM circle_chat_retention_runs WHERE mode='purge'")).rows[0].status,'held');
    await releaseChatRetentionHold(worker,{hold});
    await runChatRetentionWorker({db:worker,workerId:'secondary-purge',enabled:true,mode:'purge'});
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM circle_pair_messages')).rows[0].count,0);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM pair_messages')).rows[0].count,1);
    await enqueueNextChatRetentionRun(f.db,{mode:'purge',...await evidence(f.db,primaryScope)});
    await runChatRetentionWorker({db:f.db,workerId:'primary-purge',enabled:true,mode:'purge'});
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM pair_messages')).rows[0].count,0);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM circle_chat_retention_runs')).rows[0].count,2);
    assert.equal((await f.db.execute('SELECT COUNT(*) AS count FROM chat_retention_runs')).rows[0].count,1);
  }finally{f.close();}
});
