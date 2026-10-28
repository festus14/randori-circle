import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';

import {
  changeCircleMemberStatus,
  leaveCircle,
  listCircleMembersForOwner,
  MEMBER_SCAN_LIMIT,
  MemberRosterQueryError,
  normalizeMemberSearch,
  transferCircleOwnership,
} from '../../api/_member-lifecycle.js';

const SECRET='member-lifecycle-cursor-secret-at-least-32-bytes';
const HASH='a'.repeat(64);
const SESSION=Object.freeze({id:1,sessionHash:HASH});
const RECENT={rows:[{authenticated_at:1_795_000_000-5,method:'password'}]};

// Mirrors the documented cursor envelope so authenticated-but-malformed payloads can be exercised.
function sealCursor(payload,secret=SECRET){
  const key=createHash('sha256').update('randori-owner-roster-cursor-key-v1\0').update(secret).digest();
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from('randori-owner-roster-cursor-v1','utf8'));
  const body=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return `r1.${Buffer.concat([nonce,cipher.getAuthTag(),body]).toString('base64url')}`;
}

// Flips every bit of the last ciphertext byte, so the result always differs
// from the sealed cursor. For this test's payload, the sealed cursor is
// 67 bytes, so 67 mod 3 = 1: the last two base64url chars encode only the
// final ciphertext byte, and `AA` means that byte is 0x00 — probability
// 1/256. The last char carries only 2 data bits plus 4 fixed padding bits,
// so char-level tampering is length-dependent and fragile; flip the byte
// itself instead.
function tamperCursor(cursor){
  const raw=Buffer.from(cursor.slice('r1.'.length),'base64url');
  raw[raw.length-1]^=0xff;
  return `r1.${raw.toString('base64url')}`;
}

function rosterDb({scope=[{circle_id:20}],max=[{user_id:9}],page=[]}={}){
  const statements=[];
  const responses=[{rows:scope},{rows:max},{rows:page}];
  return {statements,async execute(statement){
    statements.push(statement);
    const sql=String(statement.sql);
    if(sql.includes('WITH owner AS')) return responses[2];
    if(sql.includes('ORDER BY membership.user_id DESC')) return responses[1];
    return responses[0];
  }};
}

function member(id,overrides={}){
  return {authorized_circle_id:20,user_id:id,account_id:id,display_name:`Member ${id}`,color:'#123456',is_demo:0,
    role:'member',status:'active',joined_at:'j',updated_at:'u',...overrides};
}

function transactionDb(script){
  const log=[];
  const statements=[];
  const queue=[...script];
  return {
    log,statements,
    async transaction(mode){
      log.push(`begin:${mode}`);
      return {
        async execute(statement){
          statements.push(statement);
          const next=queue.shift();
          if(next instanceof Error) throw next;
          return next||{rows:[]};
        },
        async commit(){ log.push('commit'); },
        async rollback(){ log.push('rollback'); throw new Error('ignored'); },
      };
    },
  };
}

test('member search normalization is bounded and rejects non-strings and control characters',()=>{
  assert.equal(normalizeMemberSearch(null),'');
  assert.equal(normalizeMemberSearch(undefined),'');
  assert.equal(normalizeMemberSearch('  ＡLICE   Smith '),'alice smith');
  for(const value of [42,'x'.repeat(81),'a\u0001b']){
    assert.throws(()=>normalizeMemberSearch(value),error=>error instanceof MemberRosterQueryError
      &&error.code==='invalid_search');
  }
});

test('roster queries validate actor, circle, and page bounds before reading',async()=>{
  const db=rosterDb();
  for(const options of [{actorUserId:0,circleId:20},{actorUserId:1,circleId:'20'},
    {actorUserId:1,circleId:20,limit:0},{actorUserId:1,circleId:20,limit:101},{actorUserId:1,circleId:20,limit:1.5}]){
    await assert.rejects(listCircleMembersForOwner(db,{cursorSecret:SECRET,...options}),TypeError);
  }
  await assert.rejects(listCircleMembersForOwner(null,{actorUserId:1,circleId:20}),TypeError);
  assert.equal(db.statements.length,0);
});

test('roster scope fails closed for non-owners, corrupt scope rows, and empty pages',async()=>{
  const base={actorUserId:1,circleId:20,cursorSecret:SECRET};
  assert.deepEqual(await listCircleMembersForOwner(rosterDb({scope:[]}),base),{ok:false,reason:'owner_required'});
  await assert.rejects(listCircleMembersForOwner(rosterDb({scope:[{circle_id:0}]}),base),/invalid owner roster scope/);
  await assert.rejects(listCircleMembersForOwner(rosterDb({max:[{user_id:-1}]}),base),/invalid owner roster scope/);
  // The owner CTE yields no row at all when ownership changed between reads.
  assert.deepEqual(await listCircleMembersForOwner(rosterDb({page:[]}),base),{ok:false,reason:'owner_required'});
  // A circle with no memberships has an empty snapshot and no cursor.
  const empty=await listCircleMembersForOwner(rosterDb({max:[],page:[{authorized_circle_id:20,user_id:null}]}),base);
  assert.deepEqual(empty,{ok:true,members:[],has_more:false,next_cursor:null,scanned:0});
});

test('roster pages hide demo, orphaned, and malformed rows and normalize display fields',async()=>{
  const page=[
    member(2,{display_name:'   ',color:null}),
    member(3,{is_demo:1}),
    member(4,{account_id:null}),
    member(5,{role:'admin'}),
    member(6,{status:'removed'}),
    member(7,{role:'owner',status:'inactive',display_name:null,joined_at:null,updated_at:null}),
  ];
  const result=await listCircleMembersForOwner(rosterDb({page}),{actorUserId:1,circleId:20,cursorSecret:SECRET});
  assert.deepEqual(result.members.map(entry=>[entry.id,entry.display_name,entry.role,entry.status]),
    [[2,'Member','member','active'],[7,'Member','owner','inactive']]);
  assert.equal(result.members[0].color,'');
  assert.equal(result.members[1].joined_at,'');
  assert.equal(result.scanned,6);
  assert.equal(result.has_more,false);
});

test('search pagination issues an opaque cursor that is bound to actor, circle, and query',async()=>{
  const page=[member(2,{display_name:'Ann A'}),member(3,{display_name:'Bob'}),member(4,{display_name:'Ann B'}),
    member(5,{display_name:'Ann C'})];
  const db=rosterDb({page});
  const first=await listCircleMembersForOwner(db,{actorUserId:1,circleId:20,search:' ANN ',limit:2,cursorSecret:SECRET});
  assert.deepEqual(first.members.map(entry=>entry.id),[2,4]);
  assert.equal(first.has_more,true);
  assert.match(first.next_cursor,/^r1\.[A-Za-z0-9_-]+$/);

  const resumed=rosterDb({page:[member(5,{display_name:'Ann C'})]});
  const second=await listCircleMembersForOwner(resumed,{actorUserId:1,circleId:20,search:'ann',limit:2,
    cursor:first.next_cursor,cursorSecret:SECRET});
  assert.deepEqual(second.members.map(entry=>entry.id),[5]);
  // The snapshot maximum and offset come from the cursor; no new max read happens.
  // The third statement is the grace-period schema probe (migration v23); the
  // fake database answers it with a non-matching row, so no leaving lookup runs.
  assert.equal(resumed.statements.length,3);
  assert.deepEqual(resumed.statements[1].args.slice(3,5),[4,9]);

  for(const options of [{actorUserId:2,search:'ann'},{actorUserId:1,search:'bob'}]){
    await assert.rejects(listCircleMembersForOwner(rosterDb({page}),{circleId:20,limit:2,cursor:first.next_cursor,
      cursorSecret:SECRET,...options}),error=>error.code==='invalid_cursor');
  }
  // A cursor replayed against a different owned circle is rejected.
  await assert.rejects(listCircleMembersForOwner(rosterDb({scope:[{circle_id:21}],page}),{actorUserId:1,circleId:21,
    search:'ann',limit:2,cursor:first.next_cursor,cursorSecret:SECRET}),error=>error.code==='invalid_cursor');
  // A different secret cannot open the cursor.
  await assert.rejects(listCircleMembersForOwner(rosterDb({page}),{actorUserId:1,circleId:20,search:'ann',limit:2,
    cursor:first.next_cursor,cursorSecret:'another-cursor-secret-that-is-at-least-32-bytes'}),
  error=>error.code==='invalid_cursor');
});

test('a full scan window continues from the last scanned member even when nothing matches',async()=>{
  const page=Array.from({length:MEMBER_SCAN_LIMIT+1},(_,index)=>member(index+2,{display_name:'Zed'}));
  const result=await listCircleMembersForOwner(rosterDb({max:[{user_id:500}],page}),{actorUserId:1,circleId:20,
    search:'ann',cursorSecret:SECRET});
  assert.deepEqual(result.members,[]);
  assert.equal(result.scanned,MEMBER_SCAN_LIMIT);
  assert.equal(result.has_more,true);
  const next=rosterDb({page:[]});
  await listCircleMembersForOwner(next,{actorUserId:1,circleId:20,search:'ann',cursor:result.next_cursor,cursorSecret:SECRET});
  assert.equal(next.statements[1].args[3],MEMBER_SCAN_LIMIT+1);
});

test('tampered, malformed, and wrongly shaped cursors are rejected opaquely',async()=>{
  const base={actorUserId:1,circleId:20,cursorSecret:SECRET};
  const valid={v:1,a:1,c:20,m:9,n:2,q:''};
  const cursors=[
    'r1.short',
    `r2.${'A'.repeat(40)}`,
    `r1.${'A'.repeat(38)}+=`,
    `r1.${'A'.repeat(700)}`,
    `r1.${'B'.repeat(39)}`,
    `r1.${'A'.repeat(36)}`,
    tamperCursor(sealCursor(valid)),
    sealCursor([1,2]),
    sealCursor({...valid,extra:true}),
    sealCursor({...valid,v:2}),
    sealCursor({...valid,a:0}),
    sealCursor({...valid,c:-1}),
    sealCursor({...valid,m:-1}),
    sealCursor({...valid,n:-1}),
    sealCursor({...valid,n:10}),
    sealCursor({...valid,q:7}),
    sealCursor({...valid,q:' Not Normalized '}),
  ];
  for(const cursor of cursors){
    await assert.rejects(listCircleMembersForOwner(rosterDb(),{...base,cursor}),
      error=>error instanceof MemberRosterQueryError&&error.code==='invalid_cursor',cursor);
  }
  const accepted=await listCircleMembersForOwner(rosterDb({page:[member(3)]}),{...base,cursor:sealCursor(valid)});
  assert.equal(accepted.ok,true);
  // A missing or short secret is a configuration error, not an opaque cursor failure.
  await assert.rejects(listCircleMembersForOwner(rosterDb(),{...base,cursor:sealCursor(valid),cursorSecret:'short'}),
    /cursor secret/);
});

test('status changes validate input, reject self-transitions, and honour a stale selected context',async()=>{
  const db=transactionDb([]);
  for(const options of [{actorUserId:0,targetUserId:2,circleId:20,action:'deactivate'},
    {actorUserId:1,targetUserId:2,circleId:20,action:'remove'},{actorUserId:1,targetUserId:null,circleId:20,action:'reactivate'}]){
    await assert.rejects(changeCircleMemberStatus(db,options),TypeError);
  }
  await assert.rejects(changeCircleMemberStatus({},{actorUserId:1,targetUserId:2,circleId:20,action:'deactivate'}),TypeError);
  assert.deepEqual(await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:1,circleId:20,action:'deactivate'}),
    {ok:false,reason:'self_transition'});
  assert.equal(db.log.length,0);

  const stale=transactionDb([{rows:[]}]);
  assert.deepEqual(await changeCircleMemberStatus(stale,{actorUserId:1,targetUserId:2,circleId:20,action:'reactivate',
    circleContext:{payload:SESSION,contextVersion:3}}),{ok:false,reason:'context_changed'});
  assert.deepEqual(stale.log,['begin:write','rollback']);
  assert.deepEqual(stale.statements[0].args,[HASH,1,20,3]);
});

test('deactivation scopes the target to the owner circle and requires recent auth for owners',async()=>{
  const options={actorUserId:1,targetUserId:2,circleId:20,action:'deactivate',session:SESSION,nowSeconds:1_795_000_000};
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{},{rows:[]}]),options),{ok:false,reason:'not_found'});

  const stale=transactionDb([{},{rows:[{user_id:2,role:'owner',status:'active',active_owner_count:2}]},{rows:[]}]);
  await assert.rejects(changeCircleMemberStatus(stale,options),error=>error.code==='RECENT_AUTH_REQUIRED');
  assert.ok(stale.log.includes('rollback'));
  // A session belonging to someone else is never accepted as the actor's proof.
  const foreign=transactionDb([{},{rows:[{user_id:2,role:'owner',status:'active',active_owner_count:2}]}]);
  await assert.rejects(changeCircleMemberStatus(foreign,{...options,session:{id:9,sessionHash:HASH}}),
    error=>error.code==='RECENT_AUTH_REQUIRED');
  assert.equal(foreign.statements.length,2);

  const owner={rows:[{user_id:2,role:'owner',status:'active',active_owner_count:2}]};
  const deactivated=transactionDb([{},owner,RECENT,{rows:[{circle_id:20,user_id:2,role:'owner',status:'inactive'}]},
    {rows:[{id:1}]},{rows:[]},{rows:[{circle_id:30}]}]);
  assert.deepEqual(await changeCircleMemberStatus(deactivated,options),
    {ok:true,member:{id:2,role:'owner',status:'inactive'},revoked_sessions:0});
  assert.deepEqual(deactivated.log,['begin:write','commit']);
});

test('failed status updates explain not-found, last-owner, and state conflicts',async()=>{
  const reactivate={actorUserId:1,targetUserId:2,circleId:20,action:'reactivate'};
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{rows:[]},{rows:[]}]),reactivate),
    {ok:false,reason:'not_found'});
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{rows:[{user_id:2,status:'inactive'}]},
    {rows:[{user_id:2,role:'member',status:'active'}]}]),reactivate),{ok:false,reason:'state_conflict'});
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{rows:[{user_id:3,status:'active'}]},
    {rows:[{user_id:2,role:'member',status:'active'}]}]),reactivate),{ok:false,reason:'state_conflict'});

  const deactivate={...reactivate,action:'deactivate',session:SESSION,nowSeconds:1_795_000_000};
  const lastOwner={rows:[{user_id:2,role:'owner',status:'active',active_owner_count:1}]};
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{},lastOwner,RECENT,{rows:[]},lastOwner]),deactivate),
    {ok:false,reason:'last_owner'});
  const member={rows:[{user_id:2,role:'member',status:'inactive',active_owner_count:1}]};
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{},member,{rows:[]},member]),deactivate),
    {ok:false,reason:'state_conflict'});
  assert.deepEqual(await changeCircleMemberStatus(transactionDb([{},member,{rows:[]},{rows:[]}]),deactivate),
    {ok:false,reason:'not_found'});

  const noAudit=transactionDb([{rows:[{circle_id:20,user_id:2,role:'member',status:'active'}]},{rows:[]}]);
  await assert.rejects(changeCircleMemberStatus(noAudit,reactivate),/membership audit unavailable/);
  assert.deepEqual(noAudit.log,['begin:write','rollback']);
});

test('leaving checks context, protects the last owner, and reports the bumped context',async()=>{
  await assert.rejects(leaveCircle(transactionDb([]),{actorUserId:1,circleId:0}),TypeError);
  await assert.rejects(leaveCircle(null,{actorUserId:1,circleId:20}),TypeError);
  const context={payload:SESSION,contextVersion:0,implicit:true};
  assert.deepEqual(await leaveCircle(transactionDb([{rows:[]}]),{actorUserId:1,circleId:20,circleContext:context}),
    {ok:false,reason:'context_changed'});

  assert.deepEqual(await leaveCircle(transactionDb([{rows:[]},{rows:[{role:'owner',status:'active',active_owner_count:1}]}]),
    {actorUserId:1,circleId:20}),{ok:false,reason:'last_owner'});
  assert.deepEqual(await leaveCircle(transactionDb([{rows:[]},{rows:[{role:'owner',status:'active',active_owner_count:2}]}]),
    {actorUserId:1,circleId:20}),{ok:false,reason:'not_found'});
  assert.deepEqual(await leaveCircle(transactionDb([{rows:[{user_id:1,status:'active'}]},{rows:[]}]),
    {actorUserId:1,circleId:20}),{ok:false,reason:'not_found'});

  await assert.rejects(leaveCircle(transactionDb([{rows:[{circle_id:20,user_id:1,role:'member',status:'inactive'}]},{rows:[]}]),
    {actorUserId:1,circleId:20}),/membership audit unavailable/);

  const left=transactionDb([{rows:[{circle_id:20}]},{rows:[{circle_id:20,user_id:1,role:'member',status:'inactive'}]},
    {rows:[{id:4}]},{rows:[{session_hash:'b'.repeat(64),context_version:3},{session_hash:HASH,context_version:6}]},
    {rows:[{circle_id:30}]}]);
  assert.deepEqual(await leaveCircle(left,{actorUserId:1,circleId:20,circleContext:{payload:SESSION,contextVersion:5}}),
    {ok:true,member:{id:1,role:'member',status:'inactive'},revoked_sessions:0,signed_out:false,context_version:6});

  // Leaving the last active circle signs every session out and omits the context version.
  const lastCircle=transactionDb([{rows:[{circle_id:20,user_id:1,role:'member',status:'inactive'}]},{rows:[{id:5}]},
    {rows:[]},{rows:[]},{rows:[{session_hash:HASH},{session_hash:'c'.repeat(64)}]}]);
  assert.deepEqual(await leaveCircle(lastCircle,{actorUserId:1,circleId:20}),
    {ok:true,member:{id:1,role:'member',status:'inactive'},revoked_sessions:2,signed_out:true});
});

test('ownership transfer requires context, recent auth, a member target, and an atomic swap',async()=>{
  const options={actorUserId:1,targetUserId:2,circleId:20,session:SESSION,nowSeconds:1_795_000_000};
  await assert.rejects(transferCircleOwnership(transactionDb([]),{...options,targetUserId:0}),TypeError);
  await assert.rejects(transferCircleOwnership({},options),TypeError);
  assert.deepEqual(await transferCircleOwnership(transactionDb([]),{...options,targetUserId:1}),
    {ok:false,reason:'self_transfer'});
  assert.deepEqual(await transferCircleOwnership(transactionDb([{rows:[]}]),
    {...options,circleContext:{payload:SESSION,contextVersion:2}}),{ok:false,reason:'context_changed'});

  const noProof=transactionDb([{},{rows:[]}]);
  await assert.rejects(transferCircleOwnership(noProof,options),error=>error.code==='RECENT_AUTH_REQUIRED');
  assert.ok(noProof.log.includes('rollback'));

  assert.deepEqual(await transferCircleOwnership(transactionDb([{},RECENT,{rows:[]},{rows:[]}]),options),
    {ok:false,reason:'not_found'});
  assert.deepEqual(await transferCircleOwnership(transactionDb([{},RECENT,{rows:[{circle_id:20,user_id:3}]},
    {rows:[{user_id:2,role:'owner',status:'active'}]}]),options),{ok:false,reason:'state_conflict'});
  const demoteFails=transactionDb([{},RECENT,{rows:[{circle_id:20,user_id:2}]},{rows:[]}]);
  assert.deepEqual(await transferCircleOwnership(demoteFails,options),{ok:false,reason:'state_conflict'});
  assert.ok(demoteFails.log.includes('rollback'));
  assert.deepEqual(await transferCircleOwnership(transactionDb([{},RECENT,{rows:[{circle_id:20,user_id:2}]},
    {rows:[{user_id:9}]}]),options),{ok:false,reason:'state_conflict'});
  await assert.rejects(transferCircleOwnership(transactionDb([{},RECENT,{rows:[{circle_id:20,user_id:2}]},
    {rows:[{user_id:1}]},{rows:[]}]),options),/ownership transfer audit unavailable/);
  const done=transactionDb([{},RECENT,{rows:[{circle_id:20,user_id:2}]},{rows:[{user_id:1}]},{rows:[{id:8}]}]);
  assert.deepEqual(await transferCircleOwnership(done,options),{ok:true,previous_owner_id:1,owner_id:2});
  assert.deepEqual(done.log,['begin:write','commit']);
});
