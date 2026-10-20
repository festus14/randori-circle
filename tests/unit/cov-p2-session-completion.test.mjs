import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalCompletionPair,
  mutateAuthorizedSessionCompletion,
  parseSessionCompletionMutation,
  parseSessionCompletionQuery,
  projectSessionCompletion,
  readAuthorizedSessionCompletion,
  readCompletionDatabaseNow,
  SessionCompletionConflictError,
  SessionCompletionDataError,
  SessionCompletionInputError,
  sourceTaggedPairAccessSql,
  validateSessionCompletionPostQuery,
} from '../../api/_session-completion.js';

const KEY='session-completion-coverage-key-32-chars-minimum';
const VERSION='a'.repeat(64);
const ROOM='week_10_pair_20';

function pairRow(overrides={}){
  return {
    pair_group_id:20,week_id:10,is_ai_pair:0,
    user_a_id:2,user_a_source:'auth',user_b_id:4,user_b_source:'auth',user_c_id:null,user_c_source:null,
    ...overrides,
  };
}

test('query parsing merges req.query and URL search params and rejects duplicates or extras',()=>{
  assert.deepEqual(
    parseSessionCompletionQuery({url:`/api/x?endpoint=session-completion&room_id=${ROOM}`}),
    {roomId:ROOM,weekId:10,pairGroupId:20},
  );
  // URL value equal to req.query value is not a duplicate.
  assert.equal(parseSessionCompletionQuery({query:{room_id:ROOM},url:`/x?room_id=${ROOM}`}).roomId,ROOM);
  // Conflicting values between req.query and URL become a duplicate.
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:ROOM},url:'/x?room_id=week_1_pair_2'}),
    /provided once/);
  // Repeated URL keys are rejected; an existing array is kept as a duplicate.
  assert.throws(()=>parseSessionCompletionQuery({url:`/x?room_id=${ROOM}&room_id=${ROOM}`}),/provided once/);
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:[ROOM,ROOM]},url:`/x?room_id=${ROOM}`}),
    /provided once/);
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:ROOM,extra:'1'}}),/unsupported query parameter/);
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:ROOM,endpoint:'other'}}),/unsupported session completion endpoint/);
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:'week_10_pair_20x'}}),SessionCompletionInputError);
  assert.throws(()=>parseSessionCompletionQuery({query:{room_id:42}}),/canonical room_id required/);
  // Array query object and malformed URL do not crash the parser.
  assert.throws(()=>parseSessionCompletionQuery({query:['x'],url:'http://[bad'}),/canonical room_id required/);
  assert.throws(()=>parseSessionCompletionQuery(undefined),/canonical room_id required/);
});

test('mutation parsing requires an object, known action, exact fields, canonical room and opaque version',()=>{
  assert.throws(()=>parseSessionCompletionMutation(null),/must be an object/);
  assert.throws(()=>parseSessionCompletionMutation([]),/must be an object/);
  assert.throws(()=>parseSessionCompletionMutation({action:'delete'}),/unsupported session completion action/);
  assert.throws(()=>parseSessionCompletionMutation({action:'confirm',room_id:ROOM}),/unexpected or missing/);
  assert.throws(()=>parseSessionCompletionMutation({action:'confirm',room_id:'bad',base_version:VERSION}),
    /canonical room_id/);
  assert.throws(()=>parseSessionCompletionMutation({action:'withdraw',room_id:ROOM,base_version:'A'.repeat(64)}),
    /valid base_version/);
  assert.throws(()=>parseSessionCompletionMutation({action:'withdraw',room_id:ROOM,base_version:7}),
    /valid base_version/);
  assert.deepEqual(parseSessionCompletionMutation({action:'withdraw',room_id:ROOM,base_version:VERSION}),
    {roomId:ROOM,weekId:10,pairGroupId:20,action:'withdraw',baseVersion:VERSION});
});

test('POST query validation only permits the session-completion endpoint key',()=>{
  assert.equal(validateSessionCompletionPostQuery({url:'/x'}),true);
  assert.equal(validateSessionCompletionPostQuery({query:{endpoint:'session-completion'}}),true);
  assert.throws(()=>validateSessionCompletionPostQuery({query:{room_id:ROOM}}),SessionCompletionInputError);
  assert.throws(()=>validateSessionCompletionPostQuery({query:{endpoint:'nope'}}),SessionCompletionInputError);
  assert.throws(()=>validateSessionCompletionPostQuery({url:'/x?endpoint=a&endpoint=a'}),SessionCompletionInputError);
});

test('canonical pair projection fails closed on corrupt membership and authorization',()=>{
  assert.throws(()=>canonicalCompletionPair(null,2),/stored pair is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({pair_group_id:0}),2),/stored pair is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({is_ai_pair:2}),2),/stored pair is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow(),'x'),/stored pair is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({user_b_id:-1}),2),/participant is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({user_b_source:'guest'}),2),/participant is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({user_b_id:2,user_b_source:'users'}),2),
    /participant is invalid/);
  // Viewer not a member, viewer non-auth.
  assert.throws(()=>canonicalCompletionPair(pairRow(),9),/authorization is invalid/);
  assert.throws(()=>canonicalCompletionPair(pairRow({user_a_source:'users'}),2),/authorization is invalid/);
  // AI pair must have exactly one member.
  assert.throws(()=>canonicalCompletionPair(pairRow({is_ai_pair:1}),2),/AI pair is invalid/);
  // A duplicated same-source id collapses to one member: invalid for a human pair.
  assert.throws(()=>canonicalCompletionPair(pairRow({user_b_id:2}),2),/membership is invalid/);
  const ai=canonicalCompletionPair(pairRow({is_ai_pair:1,user_b_id:null,user_b_source:null}),2);
  assert.equal(ai.isAi,true);
  assert.deepEqual(ai.requiredUserIds,[2]);
  const mixed=canonicalCompletionPair(pairRow({user_a_id:7,user_a_source:'users',user_b_id:2,
    user_c_id:5,user_c_source:'auth'}),2);
  assert.deepEqual(mixed.requiredUserIds,[2,5]);
  assert.ok(Object.isFrozen(mixed));
});

test('completion projection validates receipts, version key and reports latest completion time',()=>{
  const pair=canonicalCompletionPair(pairRow(),2);
  assert.throws(()=>projectSessionCompletion(null,[],KEY),/session completion is invalid/);
  assert.throws(()=>projectSessionCompletion(pair,'rows',KEY),/session completion is invalid/);
  assert.throws(()=>projectSessionCompletion(pair,[],'short'),/version key is unavailable/);
  assert.throws(()=>projectSessionCompletion(pair,[],undefined),/version key is unavailable/);
  assert.throws(()=>projectSessionCompletion(pair,[{user_id:2,confirmed_at:5}],KEY),/timestamp is invalid/);
  assert.throws(()=>projectSessionCompletion(pair,[{user_id:2,confirmed_at:'nope'}],KEY),/timestamp is invalid/);
  assert.throws(()=>projectSessionCompletion(pair,[{user_id:2,confirmed_at:'2026-01-01T00:00:00Z'}],KEY),
    /timestamp is invalid/);
  const at='2026-01-01T00:00:00.000Z';
  assert.throws(()=>projectSessionCompletion(pair,[{user_id:9,confirmed_at:at}],KEY),/session completion is invalid/);
  assert.throws(()=>projectSessionCompletion(pair,[{user_id:2,confirmed_at:at},{user_id:2,confirmed_at:at}],KEY),
    /session completion is invalid/);
  const later='2026-01-02T00:00:00.000Z';
  const done=projectSessionCompletion(pair,[{user_id:4,confirmed_at:later},{user_id:2,confirmed_at:at}],KEY);
  assert.equal(done.state,'completed');
  assert.equal(done.completed_at,later);
  const doneReverse=projectSessionCompletion(pair,[{user_id:4,confirmed_at:at},{user_id:2,confirmed_at:later}],KEY);
  assert.equal(doneReverse.completed_at,later);
  const partial=projectSessionCompletion(pair,[{user_id:4,confirmed_at:at}],KEY);
  assert.equal(partial.state,'awaiting_participants');
  assert.equal(partial.viewer_confirmed,false);
  assert.equal(partial.completed_at,null);
  assert.notEqual(partial.version,done.version);
  assert.equal(projectSessionCompletion(pair,undefined,KEY).state,'not_recorded');
});

test('access SQL joins primary-circle membership only when circle membership is enabled',()=>{
  const previous=process.env.CIRCLE_MEMBERSHIP_ENABLED;
  try{
    process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
    assert.match(sourceTaggedPairAccessSql(),/viewer_circle\.is_primary=1/);
    process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
    assert.doesNotMatch(sourceTaggedPairAccessSql(),/circle_memberships/);
  }finally{
    if(previous===undefined) delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
    else process.env.CIRCLE_MEMBERSHIP_ENABLED=previous;
  }
});

test('database clock read wraps provider failures and rejects malformed clock rows',async()=>{
  const cause=new Error('offline');
  await assert.rejects(readCompletionDatabaseNow({execute:async()=>{ throw cause; }}),error=>
    error instanceof SessionCompletionDataError&&error.cause===cause&&/clock is unavailable/.test(error.message));
  await assert.rejects(readCompletionDatabaseNow({execute:async()=>({rows:[]})}),/clock is invalid/);
  await assert.rejects(readCompletionDatabaseNow({execute:async()=>({rows:[{now_utc:null}]})}),/clock is invalid/);
  assert.equal(await readCompletionDatabaseNow({execute:async()=>({rows:[{now_utc:'2026-03-04T05:06:07.890Z'}]})}),
    '2026-03-04T05:06:07.890Z');
});

test('authorized read requires a client and valid ids, hides unauthorized pairs and rejects missing receipts',async()=>{
  await assert.rejects(readAuthorizedSessionCompletion(null,{}),TypeError);
  await assert.rejects(readAuthorizedSessionCompletion({execute:async()=>({rows:[]})},
    {viewerId:0,weekId:10,pairGroupId:20,versionKey:KEY}),/valid room and actor required/);
  assert.equal(await readAuthorizedSessionCompletion({execute:async()=>({rows:[]})},
    {viewerId:2,weekId:10,pairGroupId:20,versionKey:KEY}),null);
  assert.equal(await readAuthorizedSessionCompletion({execute:async()=>null},
    {viewerId:2,weekId:10,pairGroupId:20,versionKey:KEY}),null);
  let call=0;
  const db={execute:async()=>(call++===0?{rows:[pairRow()]}:{})};
  await assert.rejects(readAuthorizedSessionCompletion(db,{viewerId:2,weekId:10,pairGroupId:20,versionKey:KEY}),
    /stored session completion is invalid/);
});

// A scripted transactional fake that keeps receipts in memory and routes SQL by shape.
function fakeDb({receipts=[],failures=[],onCommit,writeEmpty=false,pairAfterWrite=true,clock='2026-05-01T10:00:00.000Z'}={}){
  const state={receipts:[...receipts],transactions:0,rollbacks:0,commits:0,closes:0};
  return {
    state,
    async transaction(){
      state.transactions+=1;
      const failure=failures.shift();
      let wrote=false;
      const working=[...state.receipts];
      return {
        async execute(stmt){
          const sql=typeof stmt==='string'?stmt:stmt.sql;
          if(failure&&failure.on&&sql.includes(failure.on)) throw failure.error;
          if(sql.includes('now_utc')) return {rows:[{now_utc:clock}]};
          if(sql.startsWith('WITH access')&&sql.includes('INSERT')){
            if(writeEmpty) return {rows:[]};
            working.push({user_id:stmt.args.at(-1),confirmed_at:clock}); wrote=true;
            return {rows:[{user_id:stmt.args.at(-1)}]};
          }
          if(sql.startsWith('WITH access')&&sql.includes('DELETE')){
            const viewer=stmt.args.at(-1);
            const index=working.findIndex(row=>row.user_id===viewer);
            if(index<0||writeEmpty) return {rows:[]};
            working.splice(index,1); wrote=true;
            return {rows:[{user_id:viewer}]};
          }
          if(sql.startsWith('WITH access')) return {rows:[...working].sort((a,b)=>a.user_id-b.user_id)};
          if(wrote&&!pairAfterWrite) return {rows:[]};
          return {rows:[pairRow()]};
        },
        async commit(){
          if(onCommit) await onCommit();
          state.commits+=1; state.receipts=working;
        },
        async rollback(){ state.rollbacks+=1; throw new Error('rollback noise is swallowed'); },
        async close(){ state.closes+=1; throw new Error('close noise is swallowed'); },
      };
    },
  };
}

async function versionFor(receipts){
  const db=fakeDb({receipts});
  const tx=await db.transaction();
  const result=await readAuthorizedSessionCompletion(tx,{viewerId:2,weekId:10,pairGroupId:20,versionKey:KEY});
  return result.completion.version;
}

const mutation=(action,baseVersion)=>({weekId:10,pairGroupId:20,action,baseVersion});

test('mutation requires a transactional client and reports unauthorized rooms as not found',async()=>{
  await assert.rejects(mutateAuthorizedSessionCompletion({execute(){}},{}),TypeError);
  const db={async transaction(){
    return {execute:async()=>({rows:[]}),rollback:async()=>{},commit:async()=>{}};
  }};
  assert.deepEqual(await mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',VERSION),versionKey:KEY}),
    {notFound:true});
});

test('confirm with a matching base version writes once; a repeat is idempotent without a version check',async()=>{
  const db=fakeDb();
  const base=await versionFor([]);
  const first=await mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY});
  assert.equal(first.idempotent,false);
  assert.equal(first.completion.state,'awaiting_participants');
  assert.equal(first.completion.viewer_confirmed,true);
  assert.equal(db.state.receipts.length,1);
  const again=await mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',VERSION),versionKey:KEY});
  assert.equal(again.idempotent,true);
  assert.equal(db.state.receipts.length,1);
  assert.ok(db.state.closes>=2,'transactions are always closed');
});

test('stale base version is a CAS conflict carrying the latest completion and never writes',async()=>{
  const db=fakeDb({receipts:[{user_id:4,confirmed_at:'2026-04-01T00:00:00.000Z'}]});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',VERSION),versionKey:KEY}),
    error=>error instanceof SessionCompletionConflictError&&error.code==='session_completion_changed'
      &&error.completion.confirmed_count===1,
  );
  assert.equal(db.state.receipts.length,1);
  assert.equal(db.state.transactions,1,'conflicts are not retried');
  assert.equal(db.state.rollbacks,1);
});

test('withdraw removes an own receipt but a completed session is terminal',async()=>{
  const at='2026-04-01T00:00:00.000Z';
  const db=fakeDb({receipts:[{user_id:2,confirmed_at:at}]});
  const base=await versionFor([{user_id:2,confirmed_at:at}]);
  const result=await mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('withdraw',base),versionKey:KEY});
  assert.equal(result.completion.state,'not_recorded');
  assert.equal(db.state.receipts.length,0);

  const doneDb=fakeDb({receipts:[{user_id:2,confirmed_at:at},{user_id:4,confirmed_at:at}]});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(doneDb,{viewerId:2,mutation:mutation('withdraw',VERSION),versionKey:KEY}),
    error=>error instanceof SessionCompletionConflictError&&error.code==='session_completion_terminal',
  );
  assert.equal(doneDb.state.receipts.length,2);
});

test('a write that affects no row or loses authorization fails closed instead of committing',async()=>{
  const base=await versionFor([]);
  await assert.rejects(
    mutateAuthorizedSessionCompletion(fakeDb({writeEmpty:true}),{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY}),
    /did not commit/,
  );
  const lost=fakeDb({pairAfterWrite:false});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(lost,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY}),
    /authorization changed/,
  );
  assert.equal(lost.state.receipts.length,0);
});

test('busy and locked conflicts retry with backoff, nested causes included; other errors do not retry',async()=>{
  const base=await versionFor([]);
  const busy=Object.assign(new Error('x'),{code:'SQLITE_BUSY'});
  const lockedMessage=new Error('SQLITE_LOCKED: database table is locked');
  const nested=new Error('wrapper',{cause:Object.assign(new Error('inner'),{rawCode:'libsql_transaction_busy'})});
  const db=fakeDb({failures:[{on:'pairing_groups',error:busy},{on:'pairing_groups',error:lockedMessage},
    {on:'pairing_groups',error:nested}]});
  const result=await mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY});
  assert.equal(result.idempotent,false);
  assert.equal(db.state.transactions,4);

  const exhausted=fakeDb({failures:Array.from({length:4},()=>({on:'pairing_groups',error:new Error('database is busy')}))});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(exhausted,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY}),
    /database is busy/,
  );
  assert.equal(exhausted.state.transactions,4);

  const fatal=fakeDb({failures:[{on:'pairing_groups',error:new Error('disk I/O error')}]});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(fatal,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY}),
    /disk I\/O error/,
  );
  assert.equal(fatal.state.transactions,1);
});

test('a conflict raised during commit is never retried because the commit may have landed',async()=>{
  const base=await versionFor([]);
  let commits=0;
  const db=fakeDb({onCommit:async()=>{ commits+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); }});
  await assert.rejects(
    mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',base),versionKey:KEY}),
    error=>error.code==='SQLITE_BUSY',
  );
  assert.equal(commits,1);
  assert.equal(db.state.transactions,1);
});

test('a retryable failure opening the transaction is retried up to the attempt budget',async()=>{
  let calls=0;
  const db={async transaction(){ calls+=1; throw Object.assign(new Error('x'),{code:'SQLITE_BUSY'}); }};
  await assert.rejects(mutateAuthorizedSessionCompletion(db,{viewerId:2,mutation:mutation('confirm',VERSION),versionKey:KEY}),
    error=>error.code==='SQLITE_BUSY');
  assert.equal(calls,4);
});
