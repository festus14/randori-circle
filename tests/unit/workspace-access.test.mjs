import assert from 'node:assert/strict';
import {test} from 'node:test';
import {secondaryRoomId,parseSecondaryRoomPath,workspaceEnvelope,secondaryPairAccessSql,secondaryPairAccessArgs,
  workspaceSessionPredicate,withWorkspaceRetry,stableWorkspaceRead,WorkspaceContextError} from '../../api/_workspace-access.js';
import {secondaryCircleWorkspaceEnabled} from '../../api/_active-circle.js';
const context={membership:{id:20,public_id:'dojo-public',name:'Dojo',is_primary:false},payload:{id:1,sessionHash:'a'.repeat(64)},implicit:false,context_version:7};

test('secondary namespace cannot alias a primary room and strictly validates every ID',()=>{
  assert.equal(secondaryRoomId({circleId:20,publicationId:3,groupId:4}),'circle_20_publication_3_group_4');
  assert.deepEqual(parseSecondaryRoomPath('/join/circle_20_publication_3_group_4'),{circleId:20,publicationId:3,groupId:4,roomId:'circle_20_publication_3_group_4'});
  for(const path of ['/join/week_3_pair_4','/join/circle_020_publication_3_group_4','/join/circle_20_publication_0_group_4','/join/circle_20_publication_3_group_9007199254740992','/join/circle_20_publication_3_group_4/'])assert.equal(parseSecondaryRoomPath(path),null);
  assert.throws(()=>secondaryRoomId({circleId:0,publicationId:3,groupId:4}),TypeError);
  assert.deepEqual(workspaceEnvelope(context),{circle:{public_id:'dojo-public',name:'Dojo',is_primary:false},circle_public_id:'dojo-public',circle_context_version:7});
});
test('access embeds live context and snapshot eligibility, with two-human document restriction',()=>{
  const sql=secondaryPairAccessSql(context,{pairedOnly:true});
  for(const evidence of ['viewer.is_available=1','viewer.group_position=pg.position','viewer.group_size=pg.member_count',"viewer_membership.status='active'",'viewer_circle.archived_at IS NULL','ctx.context_version=7','pg.is_solo=0 AND pg.member_count=2'])assert.ok(sql.includes(evidence),evidence);
  assert.deepEqual(secondaryPairAccessArgs({userId:1,publicationId:3,groupId:4}),[1,4,3,1,1,1]);
  assert.ok(workspaceSessionPredicate({...context,implicit:true},'pg.circle_id').includes('NOT EXISTS'));
  assert.throws(()=>workspaceSessionPredicate({...context,payload:{id:1,sessionHash:'bad'}},'pg.circle_id'),TypeError);
});
test('flag is default off and requires every parent, without depending on scheduling',()=>{
  const keys=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_WORKSPACE_ENABLED'];
  const previous=new Map(keys.map(key=>[key,process.env[key]]));
  try{for(const key of keys)delete process.env[key];assert.equal(secondaryCircleWorkspaceEnabled(),false);
    for(const key of keys)process.env[key]='true';assert.equal(secondaryCircleWorkspaceEnabled(),true);
    for(const key of keys){process.env[key]='false';assert.equal(secondaryCircleWorkspaceEnabled(),false);process.env[key]='true';}
  }finally{for(const [key,value]of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
test('bounded retry replays rolled-back busy work and never an ambiguous commit or context failure',async()=>{
  let attempts=0;assert.equal(await withWorkspaceRetry(async()=>{if(++attempts<3)throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'});return 42;}),42);assert.equal(attempts,3);
  for(const error of [Object.assign(new Error('commit'),{code:'SQLITE_BUSY',workspaceCommitAmbiguous:true}),new WorkspaceContextError('circle_context_changed'),new Error('transport')]){
    attempts=0;await assert.rejects(withWorkspaceRetry(async()=>{attempts++;throw error;}),error);assert.equal(attempts,1);
  }
  attempts=0;await assert.rejects(withWorkspaceRetry(async()=>{attempts++;throw Object.assign(new Error('busy'),{code:'SQLITE_LOCKED'});}));assert.equal(attempts,3);
});
test('stable reads close their transaction and rollback failed projections',async()=>{
  const events=[],tx={commit:async()=>events.push('commit'),rollback:async()=>events.push('rollback'),close:async()=>events.push('close')};
  const db={transaction:async mode=>{events.push(mode);return tx;}};
  assert.equal(await stableWorkspaceRead(db,async value=>{assert.equal(value,tx);return 42;}),42);assert.deepEqual(events,['read','commit','close']);
  events.length=0;await assert.rejects(stableWorkspaceRead(db,async()=>{throw new Error('projection');}));assert.deepEqual(events,['read','rollback','close']);
});
