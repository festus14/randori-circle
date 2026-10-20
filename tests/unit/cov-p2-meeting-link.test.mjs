import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_MEETING_URL_BYTES,
  MeetingLinkConflictError,
  MeetingLinkDataError,
  MeetingLinkInputError,
  mutateAuthorizedMeetingLink,
  normalizeMeetingUrl,
  parseMeetingLinkMutation,
  parseMeetingLinkQuery,
  readAuthorizedMeetingLink,
  validateMeetingLinkPostQuery,
} from '../../api/_meeting-link.js';

const KEY='meeting-link-coverage-key-at-least-32-characters';
const V='b'.repeat(64);
const ROOM='week_10_pair_20';
const AGREED='2026-06-01T15:00:00.000Z';
const CLOCK='2026-05-20T08:00:00.000Z';

test('query parsing accepts only endpoint and canonical room once',()=>{
  assert.deepEqual(parseMeetingLinkQuery({url:`/x?endpoint=meeting-link&room_id=${ROOM}`}),
    {roomId:ROOM,weekId:10,pairGroupId:20});
  assert.equal(parseMeetingLinkQuery({query:{room_id:ROOM},url:`/x?room_id=${ROOM}`}).pairGroupId,20);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:ROOM},url:'/x?room_id=week_1_pair_1'}),MeetingLinkInputError);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:[ROOM]},url:`/x?room_id=${ROOM}`}),/unsupported query/);
  assert.throws(()=>parseMeetingLinkQuery({url:`/x?room_id=${ROOM}&room_id=${ROOM}`}),/unsupported query/);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:ROOM,endpoint:'schedule'}}),/unsupported query/);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:ROOM,url:'https://x'}}),/unsupported query/);
  assert.throws(()=>parseMeetingLinkQuery({query:['a'],url:'http://[bad'}),/canonical room_id required/);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:5}}),/canonical room_id required/);
  assert.throws(()=>parseMeetingLinkQuery({query:{room_id:'week_10_pair_20/x'}}),/canonical room_id required/);
});

test('POST query validation rejects any key other than the meeting-link endpoint',()=>{
  assert.equal(validateMeetingLinkPostQuery({url:'/x?endpoint=meeting-link'}),true);
  assert.equal(validateMeetingLinkPostQuery(undefined),true);
  assert.throws(()=>validateMeetingLinkPostQuery({query:{room_id:ROOM}}),MeetingLinkInputError);
  assert.throws(()=>validateMeetingLinkPostQuery({query:{endpoint:'other'}}),MeetingLinkInputError);
  assert.throws(()=>validateMeetingLinkPostQuery({url:'/x?endpoint=meeting-link&endpoint=meeting-link'}),MeetingLinkInputError);
});

test('URL normalization rejects non-HTTPS, credentials, whitespace, control bytes and oversize input',()=>{
  assert.deepEqual({...normalizeMeetingUrl('https://Meet.Example.com/abc')},
    {url:'https://meet.example.com/abc',hostname:'meet.example.com'});
  for(const bad of [7,'',' https://a.test','https://a.test/\u0001','x'.repeat(MAX_MEETING_URL_BYTES+1),'not a url']){
    assert.throws(()=>normalizeMeetingUrl(bad),/bounded HTTPS URL/);
  }
  for(const bad of ['http://a.test','https://user:pw@a.test','https://user@a.test']){
    assert.throws(()=>normalizeMeetingUrl(bad),/without embedded credentials/);
  }
  // Input under the limit whose percent-encoded href expands past it is rejected.
  const expanding=`https://a.test/${'é'.repeat(Math.floor((MAX_MEETING_URL_BYTES-20)/2))}`;
  assert.ok(Buffer.byteLength(expanding)<=MAX_MEETING_URL_BYTES);
  assert.throws(()=>normalizeMeetingUrl(expanding),/without embedded credentials/);
});

test('mutation parsing enforces action-specific exact fields and three opaque versions',()=>{
  const base={room_id:ROOM,base_version:V,schedule_version:V,completion_version:V};
  assert.throws(()=>parseMeetingLinkMutation(undefined),/must be an object/);
  assert.throws(()=>parseMeetingLinkMutation([1]),/must be an object/);
  assert.throws(()=>parseMeetingLinkMutation({...base,action:'rename'}),/unsupported meeting-link action/);
  assert.throws(()=>parseMeetingLinkMutation({...base,action:'clear',url:'https://a.test'}),/unexpected or missing/);
  assert.throws(()=>parseMeetingLinkMutation({...base,action:'set'}),/unexpected or missing/);
  assert.throws(()=>parseMeetingLinkMutation({...base,room_id:'nope',action:'clear'}),/canonical room_id/);
  assert.throws(()=>parseMeetingLinkMutation({...base,schedule_version:'z',action:'clear'}),/valid schedule_version/);
  assert.throws(()=>parseMeetingLinkMutation({...base,completion_version:null,action:'clear'}),/valid completion_version/);
  const cleared=parseMeetingLinkMutation({...base,action:'clear'});
  assert.equal(cleared.normalizedUrl,null);
  assert.equal(parseMeetingLinkMutation({...base,action:'set',url:'https://a.test/r'}).normalizedUrl.url,'https://a.test/r');
  assert.throws(()=>parseMeetingLinkMutation({...base,action:'set',url:'http://a.test'}),MeetingLinkInputError);
});

function pairRow(){
  return {pair_group_id:20,week_id:10,is_ai_pair:0,user_a_id:2,user_a_source:'auth',
    user_b_id:4,user_b_source:'auth',user_c_id:null,user_c_source:null};
}

function linkRow(overrides={}){
  return {week_id:10,pair_group_id:20,accepted_schedule_at:AGREED,meeting_url:'https://meet.test/a',revision:1,
    updated_by:2,updated_by_source:'auth',created_at:CLOCK,updated_at:CLOCK,...overrides};
}

// An in-memory transactional fake routed by SQL shape; mutations are visible only after commit.
function fakeDb({pair=true,receipts=[],schedule={proposed_times:'[]',agreed_time:AGREED,updated_at:CLOCK},link=null,
  scheduleRows,linkRows,writeEmpty=false,loseAfterWrite=false,clock=CLOCK,failures=[],onCommit,rollbackThrows=true}={}){
  const state={link,transactions:0,commits:0,rollbacks:0};
  const client=(working,ctx)=>({
    async execute(stmt){
      const sql=typeof stmt==='string'?stmt:stmt.sql;
      const failure=ctx?.failure;
      if(failure&&sql.includes(failure.on)) throw failure.error;
      if(sql.includes('now_utc')) return {rows:[{now_utc:clock}]};
      if(sql.includes('INSERT INTO pair_meeting_links')){
        if(writeEmpty) return {rows:[]};
        const revision=(working.link?.revision||0)+1;
        working.link=linkRow({meeting_url:stmt.args.at(-8),revision,updated_by:stmt.args.at(-6),updated_at:clock});
        ctx.wrote=true;
        return {rows:[{revision}]};
      }
      if(sql.includes('UPDATE pair_meeting_links')){
        if(writeEmpty) return {rows:[]};
        working.link={...working.link,meeting_url:null,revision:working.link.revision+1,updated_at:clock};
        ctx.wrote=true;
        return {rows:[{revision:working.link.revision}]};
      }
      if(sql.includes('FROM pair_meeting_links')){
        if(linkRows!==undefined) return linkRows;
        return {rows:working.link?[working.link]:[]};
      }
      if(sql.includes('pair_schedules')){
        if(scheduleRows!==undefined) return scheduleRows;
        return {rows:schedule?[{...schedule,data_present:1}]:[{proposed_times:null,agreed_time:null,updated_at:null,data_present:0}]};
      }
      if(sql.includes('session_completion_receipts')) return {rows:receipts};
      if(ctx?.wrote&&loseAfterWrite) return {rows:[]};
      return {rows:pair?[pairRow()]:[]};
    },
  });
  return {
    state,
    reader:()=>client({link:state.link},{}),
    async transaction(){
      state.transactions+=1;
      const working={link:state.link};
      const ctx={failure:failures.shift(),wrote:false};
      return {
        ...client(working,ctx),
        async commit(){ if(onCommit) await onCommit(); state.commits+=1; state.link=working.link; },
        async rollback(){ state.rollbacks+=1; if(rollbackThrows) throw new Error('rollback noise after a failed attempt is swallowed'); },
        async close(){ throw new Error('ignored'); },
      };
    },
  };
}

const read=(db)=>readAuthorizedMeetingLink(db,{viewerId:2,weekId:10,pairGroupId:20,versionKey:KEY});

test('reads fail closed: client required, unauthorized hidden, malformed result sets rejected',async()=>{
  await assert.rejects(readAuthorizedMeetingLink(undefined,{}),TypeError);
  assert.equal(await read(fakeDb({pair:false}).reader()),null);
  let n=0;
  await assert.rejects(read({execute:async()=>(n++===0?{rows:[pairRow()]}:{})}),
    error=>error instanceof MeetingLinkDataError&&/completion state is invalid/.test(error.message));
  assert.equal(await read(fakeDb({scheduleRows:{rows:[]}}).reader()),null,'schedule access revoked mid-read');
  await assert.rejects(read(fakeDb({linkRows:{}}).reader()),/meeting-link state is invalid/);
});

test('completed sessions and unscheduled rooms hide any stored link and have no version',async()=>{
  const at='2026-05-01T00:00:00.000Z';
  const done=await read(fakeDb({link:linkRow(),receipts:[{user_id:2,confirmed_at:at},{user_id:4,confirmed_at:at}]}).reader());
  assert.equal(done.state.lifecycle,'completed');
  assert.equal(done.state.url,null);
  assert.equal(done.state.version,null);
  assert.equal(done.state.accepted_schedule_at,AGREED);
  const unscheduled=await read(fakeDb({schedule:null}).reader());
  assert.equal(unscheduled.state.lifecycle,'unscheduled');
  assert.equal(unscheduled.state.accepted_schedule_at,null);
  assert.equal(typeof unscheduled.state.schedule_version,'string');
});

test('active projection validates the stored binding, revision, actor, timestamp and URL',async()=>{
  const ok=await read(fakeDb({link:linkRow()}).reader());
  assert.equal(ok.state.lifecycle,'active');
  assert.equal(ok.state.hostname,'meet.test');
  assert.match(ok.state.version,/^[a-f0-9]{64}$/);
  const tombstone=await read(fakeDb({link:linkRow({meeting_url:null,revision:2})}).reader());
  assert.equal(tombstone.state.url,null);
  assert.equal(tombstone.state.updated_at,CLOCK);
  assert.notEqual(tombstone.state.version,ok.state.version);
  const cases=[
    [{week_id:11},/binding is invalid/],
    [{pair_group_id:21},/binding is invalid/],
    [{accepted_schedule_at:'2026-06-02T15:00:00.000Z'},/binding is invalid/],
    [{revision:0},/record is invalid/],
    [{updated_by:'x'},/record is invalid/],
    [{updated_by_source:'users'},/record is invalid/],
    [{updated_at:12},/timestamp is invalid/],
    [{updated_at:'2026-05-20T08:00:00Z'},/timestamp is invalid/],
    [{meeting_url:'http://insecure.test'},/HTTPS/],
    [{revision:1.5},/record is invalid/],
  ];
  for(const [overrides,pattern] of cases){
    await assert.rejects(read(fakeDb({linkRows:{rows:[linkRow(overrides)]}}).reader()),pattern,JSON.stringify(overrides));
  }
  await assert.rejects(readAuthorizedMeetingLink(fakeDb().reader(),{viewerId:2,weekId:10,pairGroupId:20,versionKey:'short'}),
    /version key is unavailable/);
});

async function currentState(options){
  return (await read(fakeDb(options).reader())).state;
}
const setMutation=(state,url='https://meet.test/new',overrides={})=>({
  weekId:10,pairGroupId:20,action:'set',baseVersion:state.version,scheduleVersion:state.schedule_version,
  completionVersion:state.completion_version,normalizedUrl:normalizeMeetingUrl(url),...overrides,
});
const clearMutation=(state,overrides={})=>({...setMutation(state),action:'clear',normalizedUrl:null,...overrides});

test('mutation requires a transactional client and hides unauthorized rooms',async()=>{
  await assert.rejects(mutateAuthorizedMeetingLink({execute(){}},{}),TypeError);
  const state=await currentState();
  const db=fakeDb({pair:false,rollbackThrows:false});
  assert.deepEqual(await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:setMutation(state),versionKey:KEY}),{notFound:true});
  assert.equal(db.state.commits,0);
  assert.equal(db.state.rollbacks,1);
});

test('set creates the link, repeats are idempotent, and clear writes a tombstone',async()=>{
  const db=fakeDb();
  const initial=(await read(db.reader())).state;
  const created=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:setMutation(initial),versionKey:KEY});
  assert.equal(created.idempotent,false);
  assert.equal(created.state.url,'https://meet.test/new');
  assert.equal(db.state.link.revision,1);
  const repeat=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:setMutation(initial),versionKey:KEY});
  assert.equal(repeat.idempotent,true,'same URL needs no base version');
  const cleared=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:clearMutation(created.state),versionKey:KEY});
  assert.equal(cleared.state.url,null);
  assert.equal(db.state.link.revision,2);
  const clearAgain=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:clearMutation(cleared.state),versionKey:KEY});
  assert.equal(clearAgain.idempotent,true);
});

test('clearing when no link row exists is an idempotent no-op',async()=>{
  const db=fakeDb({linkRows:{rows:[]}});
  const state=await currentState();
  // url is null already, so the first idempotency fence short-circuits.
  const result=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:clearMutation(state),versionKey:KEY});
  assert.equal(result.idempotent,true);
  assert.equal(db.state.commits,1);
});

test('lifecycle, schedule, completion and base-version fences each raise a distinct conflict',async()=>{
  const at='2026-05-01T00:00:00.000Z';
  const active=await currentState({link:linkRow()});
  const expectConflict=async(options,mutation,code)=>{
    const db=fakeDb(options);
    await assert.rejects(mutateAuthorizedMeetingLink(db,{viewerId:2,mutation,versionKey:KEY}),
      error=>error instanceof MeetingLinkConflictError&&error.code===code&&error.state!==undefined);
    assert.equal(db.state.transactions,1,`${code} is not retried`);
    assert.equal(db.state.rollbacks,1);
  };
  await expectConflict({receipts:[{user_id:2,confirmed_at:at},{user_id:4,confirmed_at:at}]},setMutation(active),
    'meeting_link_session_completed');
  await expectConflict({schedule:null},setMutation(active),'meeting_link_schedule_required');
  await expectConflict({link:linkRow()},setMutation(active,undefined,{scheduleVersion:V}),'meeting_link_schedule_changed');
  await expectConflict({link:linkRow()},setMutation(active,undefined,{completionVersion:V}),'meeting_link_completion_changed');
  await expectConflict({link:linkRow()},setMutation(active,undefined,{baseVersion:V}),'meeting_link_changed');
});

test('unwritten rows, lost authorization and a bad database clock never commit',async()=>{
  const active=await currentState({link:linkRow()});
  const fresh=await currentState();
  for(const [options,mutation,pattern] of [
    [{writeEmpty:true},setMutation(fresh),/did not commit/],
    [{writeEmpty:true,link:linkRow()},clearMutation(active),/did not commit/],
    [{loseAfterWrite:true},setMutation(fresh),/authorization changed/],
    [{clock:'yesterday'},setMutation(fresh),/clock is invalid/],
  ]){
    const db=fakeDb(options);
    await assert.rejects(mutateAuthorizedMeetingLink(db,{viewerId:2,mutation,versionKey:KEY}),pattern);
    assert.equal(db.state.commits,0);
  }
});

test('busy conflicts retry with backoff; a commit-phase conflict and fatal errors do not',async()=>{
  const fresh=await currentState();
  const db=fakeDb({failures:[
    {on:'pairing_groups',error:Object.assign(new Error('x'),{code:'SQLITE_BUSY_SNAPSHOT'})},
    {on:'pairing_groups',error:new Error('outer',{cause:new Error('database is locked')})},
  ]});
  const ok=await mutateAuthorizedMeetingLink(db,{viewerId:2,mutation:setMutation(fresh),versionKey:KEY});
  assert.equal(ok.idempotent,false);
  assert.equal(db.state.transactions,3);

  const exhausted=fakeDb({failures:Array.from({length:4},()=>({on:'pairing_groups',error:new Error('database is busy')}))});
  await assert.rejects(mutateAuthorizedMeetingLink(exhausted,{viewerId:2,mutation:setMutation(fresh),versionKey:KEY}),/busy/);
  assert.equal(exhausted.state.transactions,4);

  const fatal=fakeDb({failures:[{on:'pairing_groups',error:new Error('constraint failed')}]});
  await assert.rejects(mutateAuthorizedMeetingLink(fatal,{viewerId:2,mutation:setMutation(fresh),versionKey:KEY}),/constraint/);
  assert.equal(fatal.state.transactions,1);

  const ambiguous=fakeDb({onCommit:async()=>{ throw Object.assign(new Error('x'),{rawCode:'SQLITE_LOCKED'}); }});
  await assert.rejects(mutateAuthorizedMeetingLink(ambiguous,{viewerId:2,mutation:setMutation(fresh),versionKey:KEY}),
    error=>error.rawCode==='SQLITE_LOCKED');
  assert.equal(ambiguous.state.transactions,1);
});
