import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  mutateAuthorizedSessionControls,
  parseSessionControlsMutation,
  parseSessionControlsQuery,
  projectSessionControls,
  readAuthorizedSessionControls,
  readSessionControlsDatabaseNow,
  SESSION_TIMER_DURATION_MS,
  SessionControlsConflictError,
  SessionControlsDataError,
  SessionControlsInputError,
  validateSessionControlsPostQuery,
} from '../../api/_session-controls.js';

const VERSION_KEY='session-controls-cov-secret-at-least-thirty-two-chars';
const NOW='2026-09-20T10:05:00.000Z';
const PAIR={weekId:10,pairGroupId:20,viewerId:2,userAId:2,userBId:4};
const NOT_DONE={state:'not_recorded',version:'d'.repeat(64),completed_at:null};

function controlRow(overrides={}){
  return {
    week_id:10,pair_group_id:20,pair_user_a_id:2,pair_user_a_source:'auth',
    pair_user_b_id:4,pair_user_b_source:'auth',pair_user_c_id:null,
    candidate_user_id:2,candidate_source:'auth',timer_state:'paused',remaining_ms:60_000,
    anchor_at:null,revision:2,updated_by:2,updated_by_source:'auth',
    created_at:'2026-09-20T09:00:00.000Z',updated_at:'2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

function project(row,options={}){
  return projectSessionControls(PAIR,row,{databaseNow:NOW,completion:NOT_DONE,versionKey:VERSION_KEY,...options});
}

test('query parsing merges req.query and URL search params and rejects ambiguity',()=>{
  // URL-only query string (no req.query object) is accepted.
  assert.deepEqual(parseSessionControlsQuery({url:'/api/data?endpoint=session-controls&room_id=week_3_pair_7'}),
    {roomId:'week_3_pair_7',weekId:3,pairGroupId:7});
  // Identical duplicate in req.query and URL is tolerated.
  assert.equal(parseSessionControlsQuery({url:'/x?room_id=week_3_pair_7',query:{room_id:'week_3_pair_7'}}).pairGroupId,7);
  for(const req of [
    {url:'/x?room_id=week_3_pair_7&room_id=week_3_pair_8'},          // repeated in URL
    {url:'/x?room_id=week_3_pair_8',query:{room_id:'week_3_pair_7'}}, // conflicting sources
    {url:'/x',query:{room_id:['week_3_pair_7']}},                     // array in req.query
    {url:'/x?room_id=week_3_pair_7&debug=1'},                         // unknown key
    {url:'/x?room_id=week_3_pair_7&endpoint=ops'},                    // wrong endpoint
  ]) assert.throws(()=>parseSessionControlsQuery(req),/unsupported query parameter/);
  // Array value already present stays an array (and is rejected).
  assert.throws(()=>parseSessionControlsQuery({url:'/x?room_id=week_3_pair_7',query:{room_id:['a','b']}}),SessionControlsInputError);
  for(const room of [undefined,'week_03_pair_7','week_3_pair_7/','week_0_pair_1',42]){
    assert.throws(()=>parseSessionControlsQuery({url:'/x',query:room===undefined?{}:{room_id:room}}),/canonical room_id required/);
  }
  // A malformed URL is ignored rather than crashing; req.query still drives validation.
  assert.equal(parseSessionControlsQuery({url:'http://[bad',query:{room_id:'week_1_pair_2'}}).weekId,1);
  assert.throws(()=>parseSessionControlsQuery(null),/canonical room_id required/);
});

test('POST query accepts only the endpoint selector',()=>{
  assert.equal(validateSessionControlsPostQuery({url:'/api/data?endpoint=session-controls'}),true);
  assert.equal(validateSessionControlsPostQuery({url:'/api/data'}),true);
  for(const req of [
    {url:'/api/data?endpoint=session-controls&room_id=week_1_pair_2'},
    {url:'/api/data?endpoint=other'},
    {url:'/api/data?endpoint=session-controls&endpoint=session-controls'},
  ]) assert.throws(()=>validateSessionControlsPostQuery(req),SessionControlsInputError);
});

test('mutation body validation rejects non-objects, extra keys, and bad rooms',()=>{
  for(const body of [null,'start',[],5]) assert.throws(()=>parseSessionControlsMutation(body),/must be an object/);
  assert.throws(()=>parseSessionControlsMutation({room_id:'week_1_pair_2',action:'start',base_version:'a'.repeat(64),extra:1}),/unexpected or missing/);
  assert.throws(()=>parseSessionControlsMutation({room_id:'week_1_pair_02',action:'start',base_version:'a'.repeat(64)}),/canonical room_id/);
  assert.throws(()=>parseSessionControlsMutation({room_id:'week_1_pair_2',action:'start',base_version:'A'.repeat(64)}),/base_version/);
  assert.throws(()=>parseSessionControlsMutation({room_id:'week_1_pair_2',action:'set_candidate',base_version:'a'.repeat(64),candidate_user_id:0}),/candidate_user_id/);
  const parsed=parseSessionControlsMutation({room_id:'week_1_pair_2',action:'reset',base_version:'b'.repeat(64)});
  assert.equal(parsed.candidateUserId,null);
  assert.ok(Object.isFrozen(parsed));
});

test('projection of a missing row is the paused default with the viewer as candidate',()=>{
  const state=project(null);
  assert.equal(state.timer_state,'paused');
  assert.equal(state.remaining_ms,SESSION_TIMER_DURATION_MS);
  assert.equal(state.viewer_role,'candidate');
  assert.equal(state.partner_user_id,4);
  assert.equal(state.updated_at,null);
  assert.equal(state.terminal,false);
  // Partner-side view flips roles and partner id.
  const partnerView=projectSessionControls({...PAIR,viewerId:4},null,{databaseNow:NOW,completion:NOT_DONE,versionKey:VERSION_KEY});
  assert.equal(partnerView.viewer_role,'interviewer');
  assert.equal(partnerView.partner_user_id,2);
});

test('projection expires a running timer once elapsed time exceeds remaining time',()=>{
  const state=project(controlRow({timer_state:'running',remaining_ms:1000,anchor_at:'2026-09-20T10:00:00.000Z'}));
  assert.equal(state.timer_state,'expired');
  assert.equal(state.remaining_ms,0);
});

test('projection fails closed on missing inputs and a short version key',()=>{
  assert.throws(()=>projectSessionControls(null,null,{databaseNow:NOW,completion:NOT_DONE,versionKey:VERSION_KEY}),/projection is invalid/);
  assert.throws(()=>projectSessionControls(PAIR,null,{databaseNow:NOW,completion:null,versionKey:VERSION_KEY}),/projection is invalid/);
  assert.throws(()=>project(null,{versionKey:'short'}),/version key is unavailable/);
  assert.throws(()=>project(null,{versionKey:undefined}),/version key is unavailable/);
  for(const databaseNow of [undefined,'not a date','2026-09-20T10:05:00Z']){
    assert.throws(()=>project(null,{databaseNow}),SessionControlsDataError);
  }
});

test('projection rejects every corrupt stored row shape',()=>{
  const corrupt=[
    {week_id:11},{pair_group_id:21},{pair_user_a_id:3},{pair_user_b_id:5},
    {pair_user_a_source:'users'},{pair_user_b_source:'users'},{pair_user_c_id:6},
    {candidate_source:'users'},{candidate_user_id:9},{timer_state:'stopped'},{timer_state:null},
    {remaining_ms:-1},{remaining_ms:SESSION_TIMER_DURATION_MS+1},{remaining_ms:1.5},
    {revision:0},{revision:'x'},{updated_by_source:'users'},{updated_by:9},
  ];
  for(const overrides of corrupt){
    assert.throws(()=>project(controlRow(overrides)),/stored session controls are invalid/,JSON.stringify(overrides));
  }
  // Timer/anchor consistency.
  assert.throws(()=>project(controlRow({anchor_at:'2026-09-20T09:30:00.000Z'})),/stored session timer is invalid/);
  assert.throws(()=>project(controlRow({timer_state:'running',anchor_at:null})),/stored session timer is invalid/);
  assert.throws(()=>project(controlRow({timer_state:'running',remaining_ms:0,anchor_at:'2026-09-20T09:30:00.000Z'})),/stored session timer is invalid/);
  // Timestamp formats and ordering.
  assert.throws(()=>project(controlRow({anchor_at:12345,timer_state:'running'})),/anchor is invalid/);
  assert.throws(()=>project(controlRow({created_at:'yesterday'})),/created timestamp is invalid/);
  assert.throws(()=>project(controlRow({updated_at:'2026-09-20T10:00:00Z'})),/updated timestamp is invalid/);
  assert.throws(()=>project(controlRow({created_at:'2026-09-20T10:00:00.001Z'})),/timestamps are invalid/);
  assert.throws(()=>project(controlRow({timer_state:'running',anchor_at:'2026-09-20T10:00:00.001Z'})),/timestamps are invalid/);
  assert.throws(()=>project(controlRow({}),{completion:{state:'completed',version:'c'.repeat(64),completed_at:'bad'}}),/completion timestamp is invalid/);
});

test('database clock reads fail closed on driver errors and malformed rows',async()=>{
  const failing={execute:async()=>{ throw new Error('socket closed'); }};
  await assert.rejects(readSessionControlsDatabaseNow(failing),error=>{
    assert.ok(error instanceof SessionControlsDataError);
    assert.match(error.message,/clock is unavailable/);
    assert.equal(error.cause.message,'socket closed');
    return true;
  });
  for(const result of [null,{rows:[]},{rows:[{now_utc:NOW},{now_utc:NOW}]},{rows:[{now_utc:null}]},{rows:[{now_utc:'2026-09-20 10:00:00'}]}]){
    await assert.rejects(readSessionControlsDatabaseNow({execute:async()=>result}),/database session-controls clock is invalid/);
  }
  assert.equal(await readSessionControlsDatabaseNow({execute:async()=>({rows:[{now_utc:NOW}]})}),NOW);
  // Data errors without a cause keep the cause property absent.
  assert.equal('cause' in new SessionControlsDataError('x'),false);
});

function pairRow(overrides={}){
  return {
    week_id:10,pair_group_id:20,user_a_id:2,user_a_source:'auth',user_b_id:4,user_b_source:'auth',
    user_c_id:null,user_c_source:null,is_ai_pair:0,...overrides,
  };
}

// Scripted fake libSQL client: routes statements by SQL shape.
function fakeDb({pair=pairRow(),receipts=[],controls=[],clock=NOW,write,onCommit,onRollback,controlsResult}={}){
  const calls=[];
  const client={
    calls,
    async execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      calls.push(sql);
      if(sql.includes('strftime')) return {rows:[{now_utc:clock}]};
      if(/^\s*WITH access AS[\s\S]*(INSERT INTO|UPDATE) pair_session_controls/.test(sql)) return write?write(sql,statement.args):{rows:[{revision:1}]};
      if(sql.includes('session_completion_receipts')) return typeof receipts==='function'?receipts():{rows:receipts};
      if(sql.includes('FROM pair_session_controls')) return controlsResult?controlsResult():{rows:typeof controls==='function'?controls():controls};
      return {rows:typeof pair==='function'?pair():(pair?[pair]:[])};
    },
  };
  client.transaction=async()=>({
    execute:client.execute,
    commit:async()=>{ calls.push('COMMIT'); await onCommit?.(); },
    rollback:async()=>{ calls.push('ROLLBACK'); await onRollback?.(); },
    close:()=>{ calls.push('CLOSE'); },
  });
  return client;
}

test('authorized read hides non-human or mismatched pairs and fails closed on missing result sets',async()=>{
  await assert.rejects(readAuthorizedSessionControls(null,{viewerId:2,weekId:10,pairGroupId:20}),TypeError);
  const args={viewerId:2,weekId:10,pairGroupId:20,versionKey:VERSION_KEY};
  assert.equal(await readAuthorizedSessionControls(fakeDb({pair:null}),args),null);
  for(const overrides of [
    {is_ai_pair:1},{is_ai_pair:null},{user_c_id:6,user_c_source:'auth'},{user_b_source:'users'},
    {user_a_source:'users'},{user_c_source:'auth'},{user_b_id:2},{user_a_id:0},
  ]){
    assert.equal(await readAuthorizedSessionControls(fakeDb({pair:pairRow(overrides)}),args),null,JSON.stringify(overrides));
  }
  await assert.rejects(readAuthorizedSessionControls(fakeDb({receipts:()=>({})}),args),/stored completion state is invalid/);
  await assert.rejects(readAuthorizedSessionControls(fakeDb({controlsResult:()=>({})}),args),/stored session-controls state is invalid/);
  const ok=await readAuthorizedSessionControls(fakeDb(),args);
  assert.equal(ok.row,null);
  assert.equal(ok.state.timer_state,'paused');
  assert.equal(ok.databaseNow,NOW);
});

function mutation(action,overrides={}){
  return {roomId:'week_10_pair_20',weekId:10,pairGroupId:20,action,baseVersion:'0'.repeat(64),candidateUserId:null,...overrides};
}

async function currentVersion(db){
  return (await readAuthorizedSessionControls(db,{viewerId:2,weekId:10,pairGroupId:20,versionKey:VERSION_KEY})).state.version;
}

test('mutation requires a transactional client and hides unauthorized rooms',async()=>{
  await assert.rejects(mutateAuthorizedSessionControls({execute(){}},{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),TypeError);
  const db=fakeDb({pair:null});
  assert.deepEqual(await mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),{notFound:true});
  assert.ok(db.calls.includes('ROLLBACK'));
  assert.ok(db.calls.includes('CLOSE'));
});

test('no-op transitions commit idempotently without writes or version checks',async()=>{
  const running=controlRow({timer_state:'running',remaining_ms:600_000,anchor_at:'2026-09-20T10:00:00.000Z'});
  for(const [action,rows,extra] of [
    ['reset',[],{}],
    ['pause',[],{}],
    ['start',[running],{}],
    ['set_candidate',[],{candidateUserId:2}],
  ]){
    const db=fakeDb({controls:rows});
    const result=await mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation(action,extra),versionKey:VERSION_KEY});
    assert.equal(result.idempotent,true,action);
    assert.ok(db.calls.includes('COMMIT'));
    assert.equal(db.calls.some(sql=>/INSERT INTO|UPDATE pair_session/.test(sql)),false);
  }
});

test('set_candidate rejects non-participants and expired timers require a reset',async()=>{
  const db=fakeDb();
  await assert.rejects(mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation('set_candidate',{candidateUserId:9}),versionKey:VERSION_KEY}),/candidate must be a participant/);
  assert.ok(db.calls.includes('ROLLBACK'));
  const expired=fakeDb({controls:[controlRow({timer_state:'running',remaining_ms:1000,anchor_at:'2026-09-20T10:00:00.000Z'})]});
  await assert.rejects(mutateAuthorizedSessionControls(expired,{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),error=>{
    assert.ok(error instanceof SessionControlsConflictError);
    assert.equal(error.code,'session_controls_reset_required');
    assert.equal(error.state.timer_state,'expired');
    return true;
  });
  const unknown=fakeDb();
  await assert.rejects(mutateAuthorizedSessionControls(unknown,{viewerId:2,mutation:mutation('tick'),versionKey:VERSION_KEY}),/unsupported session-controls action/);
});

test('a stale base version conflicts, and a lost CAS race reports the latest state or not-found',async()=>{
  const stale=fakeDb();
  await assert.rejects(mutateAuthorizedSessionControls(stale,{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),
    error=>error.code==='session_controls_changed');

  // CAS write affects nothing; the room is still visible -> conflict with latest state.
  const raced=fakeDb({controls:[controlRow()],write:()=>({rows:[]})});
  const baseVersion=await currentVersion(raced);
  await assert.rejects(mutateAuthorizedSessionControls(raced,{viewerId:2,mutation:mutation('start',{baseVersion}),versionKey:VERSION_KEY}),
    error=>error instanceof SessionControlsConflictError&&error.code==='session_controls_changed'&&error.state.timer_state==='paused');
  assert.ok(raced.calls.some(sql=>sql.includes('UPDATE pair_session_controls')),'existing row uses CAS update');

  // CAS write affects nothing and the viewer lost access in between -> not found.
  let pairReads=0;
  const revoked=fakeDb({pair:()=>(++pairReads<=2?[pairRow()]:[]),write:()=>({rows:[]})});
  const revokedVersion=await currentVersion(revoked);
  assert.deepEqual(await mutateAuthorizedSessionControls(revoked,{viewerId:2,mutation:mutation('start',{baseVersion:revokedVersion}),versionKey:VERSION_KEY}),{notFound:true});
  assert.ok(revoked.calls.some(sql=>sql.includes('INSERT INTO pair_session_controls')),'first write inserts');

  // Write succeeds but authorization disappears before commit -> data error, rolled back.
  pairReads=0;
  const vanished=fakeDb({pair:()=>(++pairReads<=2?[pairRow()]:[])});
  const vanishedVersion=await currentVersion(vanished);
  await assert.rejects(mutateAuthorizedSessionControls(vanished,{viewerId:2,mutation:mutation('start',{baseVersion:vanishedVersion}),versionKey:VERSION_KEY}),/authorization changed/);
  assert.ok(vanished.calls.includes('ROLLBACK'));
});

test('pause and reset write the expected transitions on a running timer',async()=>{
  const running=controlRow({timer_state:'running',remaining_ms:600_000,anchor_at:'2026-09-20T10:00:00.000Z'});
  for(const action of ['pause','reset']){
    const writes=[];
    const db=fakeDb({controls:[running],write:(sql,args)=>{ writes.push(args); return {rows:[{revision:3}]}; }});
    const baseVersion=await currentVersion(db);
    const result=await mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation(action,{baseVersion}),versionKey:VERSION_KEY});
    assert.equal(result.idempotent,false);
    assert.equal(writes.length,1);
    const args=writes[0];
    const tail=args.slice(-11);
    assert.equal(tail[1],'paused');
    assert.equal(tail[2],action==='pause'?600_000-5*60_000:SESSION_TIMER_DURATION_MS);
    assert.equal(tail[3],null);
  }
});

test('completed sessions are read-only',async()=>{
  const db=fakeDb({receipts:[{user_id:2,confirmed_at:'2026-09-20T10:01:00.000Z'},{user_id:4,confirmed_at:'2026-09-20T10:02:00.000Z'}]});
  await assert.rejects(mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),
    error=>error.code==='session_controls_completed'&&error.state.terminal===true);
});

test('retryable lock conflicts are retried; other errors and in-flight commits are not',async()=>{
  // First attempt hits a nested SQLITE_BUSY cause, second succeeds.
  let attempts=0;
  const busy=fakeDb();
  const baseTransaction=busy.transaction;
  busy.transaction=async()=>{
    attempts+=1;
    if(attempts===1){
      const tx=await baseTransaction();
      return {...tx,execute:async()=>{ throw new Error('wrapped',{cause:{rawCode:'sqlite_busy'}}); },rollback:async()=>{ throw new Error('rollback failed'); },close:()=>{ throw new Error('close failed'); }};
    }
    return baseTransaction();
  };
  const result=await mutateAuthorizedSessionControls(busy,{viewerId:2,mutation:mutation('reset'),versionKey:VERSION_KEY});
  assert.equal(result.idempotent,true);
  assert.equal(attempts,2);

  // Message-based lock detection also retries.
  for(const message of ['database is locked','SQLITE_LOCKED: database table is locked','database is busy']){
    let count=0;
    const db=fakeDb();
    const base=db.transaction;
    db.transaction=async()=>{ count+=1; if(count===1) throw new Error(message); return base(); };
    await mutateAuthorizedSessionControls(db,{viewerId:2,mutation:mutation('reset'),versionKey:VERSION_KEY});
    assert.equal(count,2,message);
  }

  // Non-retryable error surfaces immediately.
  let plainCount=0;
  const plain=fakeDb();
  plain.transaction=async()=>{ plainCount+=1; throw new Error('disk I/O error'); };
  await assert.rejects(mutateAuthorizedSessionControls(plain,{viewerId:2,mutation:mutation('reset'),versionKey:VERSION_KEY}),/disk I\/O error/);
  assert.equal(plainCount,1);

  // A lock error during COMMIT must not be retried (the write may have landed).
  let commitAttempts=0;
  const committing=fakeDb({onCommit:()=>{ commitAttempts+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); }});
  const baseVersion=await currentVersion(committing);
  await assert.rejects(mutateAuthorizedSessionControls(committing,{viewerId:2,mutation:mutation('start',{baseVersion}),versionKey:VERSION_KEY}),
    error=>error.code==='SQLITE_BUSY');
  assert.equal(commitAttempts,1);

  // Persistent lock conflicts give up after the bounded attempt budget.
  let lockedCount=0;
  const locked=fakeDb();
  locked.transaction=async()=>{ lockedCount+=1; throw Object.assign(new Error('x'),{code:'TRANSACTION_CONFLICT'}); };
  await assert.rejects(mutateAuthorizedSessionControls(locked,{viewerId:2,mutation:mutation('reset'),versionKey:VERSION_KEY}),error=>error.code==='TRANSACTION_CONFLICT');
  assert.equal(lockedCount,4);
});
