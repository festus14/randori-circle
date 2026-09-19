import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let enabled=true;
let authPayload={id:1,sessionHash:'a'.repeat(64)};
let authError=null;
let readinessError=null;
let listResult={ok:true,members:[],has_more:false,next_cursor:null,scanned:0};
let statusResult={ok:true,member:{id:2,role:'member',status:'inactive'},revoked_sessions:1};
let leaveResult={ok:true,member:{id:1,role:'member',status:'inactive'},revoked_sessions:1};
let transferResult={ok:true,previous_owner_id:1,owner_id:2};
let transitionError=null;
let multiEnabled=false;
let activeContext={ok:true,membership:{id:20,public_id:'circle-secondary',role:'owner'},context_version:3};
const calls=[];
const captured=[];
const db={};

mock.module('../../api/_db.js',{exports:{
  captureSentryException:(error,context)=>captured.push({error,context}),
  getClient:()=>db,
  getJwtSecret:()=> 'member-lifecycle-api-secret-at-least-thirty-two-bytes',
  verifyMutationOrigin:req=>req.headers?.origin!=='https://cross-origin.example',
  verifyRequestAuth:async()=>{
    if(authError) throw authError;
    return authPayload;
  },
}});

mock.module('../../api/_circle-membership.js',{exports:{
  circleMembershipEnabled:()=>enabled,
  getActivePrimaryCircleMembership:async()=>({circle_id:10,role:'owner'}),
  ensureCircleMembershipReadiness:async()=>{
    if(readinessError) throw readinessError;
  },
}});

mock.module('../../api/_member-lifecycle.js',{exports:{
  MEMBER_PAGE_DEFAULT:50,
  MEMBER_PAGE_MAX:100,
  MemberRosterQueryError:class MemberRosterQueryError extends Error{},
  listCircleMembersForOwner:async(_db,input)=>{ calls.push(['list',_db,input]); return listResult; },
  changeCircleMemberStatus:async(_db,input)=>{ calls.push(['status',_db,input]); if(transitionError) throw transitionError; return statusResult; },
  leaveCircle:async(_db,input)=>{ calls.push(['leave',_db,input]); return leaveResult; },
  transferCircleOwnership:async(_db,input)=>{ calls.push(['transfer',_db,input]); if(transitionError) throw transitionError; return transferResult; },
}});

mock.module('../../api/_active-circle.js',{exports:{
  multiCircleControlPlaneEnabled:()=>multiEnabled,
  requestMatchesCircleContext:req=>req.headers?.['x-context-valid']!=='0',
  resolveActiveCircleContext:async()=>activeContext,
}});

const {default:handler}=await import('../../api/members.js');

function invoke({method='GET',query={},headers={},body={}}={}){
  return new Promise((resolve,reject)=>{
    let status=200;
    let settled=false;
    const responseHeaders={};
    const finish=value=>{
      if(settled) return;
      settled=true;
      resolve({status,headers:responseHeaders,body:value});
    };
    const response={
      status(value){ status=value; return this; },
      json(value){ finish(value); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
    };
    Promise.resolve(handler({method,query,headers,body},response)).then(()=>finish(undefined)).catch(reject);
  });
}

beforeEach(()=>{
  enabled=true;
  authPayload={id:1,sessionHash:'a'.repeat(64)};
  authError=null;
  readinessError=null;
  listResult={ok:true,members:[],has_more:false,next_cursor:null,scanned:0};
  statusResult={ok:true,member:{id:2,role:'member',status:'inactive'},revoked_sessions:1};
  leaveResult={ok:true,member:{id:1,role:'member',status:'inactive'},revoked_sessions:1};
  transferResult={ok:true,previous_owner_id:1,owner_id:2};
  transitionError=null;
  multiEnabled=false;
  activeContext={ok:true,membership:{id:20,public_id:'circle-secondary',role:'owner'},context_version:3};
  calls.length=0;
  captured.length=0;
  delete process.env.NODE_ENV;
});

test('member listing requires the enabled lifecycle and an active owner',async()=>{
  let response=await invoke();
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{ok:true,members:[],count:0,has_more:false,next_cursor:null,scanned:0});
  assert.deepEqual(calls,[['list',db,{
    actorUserId:1,circleId:10,cursor:null,search:'',limit:50,
    cursorSecret:'member-lifecycle-api-secret-at-least-thirty-two-bytes',
  }]]);
  assert.equal(response.headers['cache-control'],'private, no-store');

  calls.length=0;
  listResult={ok:true,members:[{id:1}],has_more:true,next_cursor:'r1.opaque',scanned:51};
  response=await invoke();
  assert.deepEqual(response.body,{ok:true,members:[{id:1}],count:1,has_more:true,next_cursor:'r1.opaque',scanned:51});

  calls.length=0;
  listResult={ok:false,reason:'owner_required'};
  response=await invoke();
  assert.deepEqual(response,{status:403,headers:{'cache-control':'private, no-store',pragma:'no-cache'},body:{error:'circle owner required'}});

  calls.length=0;
  enabled=false;
  response=await invoke();
  assert.equal(response.status,404);
  assert.equal(calls.length,0);
});

test('mutations enforce same-origin and exact action bodies before lifecycle work',async()=>{
  let response=await invoke({method:'PATCH',headers:{origin:'https://cross-origin.example'},body:{action:'leave'}});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);

  for(const body of [
    {},
    {action:'leave',member_id:2},
    {action:'deactivate'},
    {action:'deactivate',member_id:'2'},
    {action:'unknown',member_id:2},
  ]){
    response=await invoke({method:'PATCH',body});
    assert.equal(response.status,400);
  }
  assert.equal(calls.length,0);
});

test('deactivate, reactivate, and transfer use only the authenticated actor and exact target',async()=>{
  let response=await invoke({method:'PATCH',body:{action:'deactivate',member_id:2}});
  assert.equal(response.status,200);
  assert.deepEqual(calls.pop(),['status',db,{actorUserId:1,targetUserId:2,circleId:10,action:'deactivate',session:authPayload}]);

  response=await invoke({method:'PATCH',body:{action:'reactivate',member_id:3}});
  assert.equal(response.status,200);
  assert.deepEqual(calls.pop(),['status',db,{actorUserId:1,targetUserId:3,circleId:10,action:'reactivate',session:authPayload}]);

  response=await invoke({method:'PATCH',body:{action:'transfer',member_id:2}});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{ok:true,action:'transfer',member:{id:2,role:'owner',status:'active'}});
  assert.deepEqual(calls.pop(),['transfer',db,{actorUserId:1,targetUserId:2,circleId:10,session:authPayload}]);
});

test('cross-circle and missing targets share one opaque response while owner invariants stay actionable',async()=>{
  for(const result of [{ok:false,reason:'not_found'},{ok:false,reason:'state_conflict'}]){
    statusResult=result;
    const response=await invoke({method:'PATCH',body:{action:'deactivate',member_id:99}});
    assert.equal(response.status,result.reason==='not_found'?404:409);
    assert.deepEqual(response.body,{error:result.reason==='not_found'?'member not found':'membership state changed'});
  }
  transferResult={ok:false,reason:'not_found'};
  assert.deepEqual((await invoke({method:'PATCH',body:{action:'transfer',member_id:99}})).body,{error:'member not found'});
  transferResult={ok:false,reason:'self_transfer'};
  assert.deepEqual((await invoke({method:'PATCH',body:{action:'transfer',member_id:1}})).body,{error:'choose another active member'});
  statusResult={ok:false,reason:'last_owner'};
  assert.deepEqual((await invoke({method:'PATCH',body:{action:'deactivate',member_id:2}})).body,{error:'another active owner is required'});
});

test('sensitive lifecycle mutations expose only the shared recent-auth challenge',async()=>{
  transitionError=Object.assign(new Error('recent authentication required'),{
    code:'RECENT_AUTH_REQUIRED',statusCode:403,
  });
  for(const body of [{action:'deactivate',member_id:3},{action:'transfer',member_id:2}]){
    const response=await invoke({method:'PATCH',body});
    assert.equal(response.status,403);
    assert.deepEqual(response.body,{error:'recent authentication required',code:'recent_auth_required'});
  }
  assert.equal(captured.length,0);
});

test('leave clears the cookie only after the transactional lifecycle succeeds',async()=>{
  process.env.NODE_ENV='production';
  let response=await invoke({method:'PATCH',body:{action:'leave'}});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{ok:true,action:'leave'});
  assert.match(response.headers['set-cookie'],/^randori_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  assert.deepEqual(calls.pop(),['leave',db,{actorUserId:1,circleId:10}]);

  leaveResult={ok:false,reason:'last_owner'};
  response=await invoke({method:'PATCH',body:{action:'leave'}});
  assert.equal(response.status,409);
  assert.equal(response.headers['set-cookie'],undefined);
});

test('authentication and storage failures fail closed without internal detail',async()=>{
  authPayload=null;
  let response=await invoke();
  assert.equal(response.status,401);
  assert.equal(calls.length,0);

  authError=new Error('database address and secret');
  response=await invoke();
  assert.deepEqual(response.body,{error:'membership unavailable'});
  assert.equal(response.status,503);
  assert.equal(JSON.stringify(response).includes('database address'),false);
  assert.equal(captured.length,1);

  authError=null;
  authPayload={id:1,sessionHash:'a'.repeat(64)};
  listResult=null;
  response=await invoke();
  assert.equal(response.status,503);
  assert.equal(captured.length,2);
});

test('unsupported methods and query parameters are rejected',async()=>{
  assert.equal((await invoke({query:{endpoint:'members'}})).status,200);
  calls.length=0;
  assert.equal((await invoke({query:{endpoint:'members',q:'Ada',limit:'25',cursor:'r1.cursor'}})).status,200);
  assert.deepEqual(calls[0][2],{
    actorUserId:1,circleId:10,cursor:'r1.cursor',search:'Ada',limit:25,
    cursorSecret:'member-lifecycle-api-secret-at-least-thirty-two-bytes',
  });
  assert.equal((await invoke({query:{id:'1'}})).status,400);
  assert.equal((await invoke({query:{endpoint:['members','members']}})).status,400);
  for(const query of [{limit:'0'},{limit:'101'},{limit:'1.5'},{limit:'01'},{cursor:''},{q:['a','b']}]){
    assert.equal((await invoke({query})).status,400);
  }
  const response=await invoke({method:'DELETE'});
  assert.equal(response.status,405);
  assert.equal(response.headers.allow,'GET, PATCH');
});

test('multi-circle requests require a selected context and pass only its internal id to lifecycle work',async()=>{
  multiEnabled=true;
  let response=await invoke();
  assert.equal(response.status,200);
  assert.equal(response.body.circle_context_version,3);
  assert.equal(calls.at(-1)[2].circleId,20);

  calls.length=0;
  activeContext={ok:false,reason:'selection_required'};
  response=await invoke();
  assert.equal(response.status,409);
  assert.deepEqual(response.body,{error:'select an active circle',code:'active_circle_required'});
  assert.equal(calls.length,0);

  activeContext={ok:true,membership:{id:20,public_id:'circle-secondary',role:'owner'},context_version:4};
  response=await invoke({headers:{'x-context-valid':'0'}});
  assert.equal(response.status,409);
  assert.deepEqual(response.body,{error:'circle context changed',code:'circle_context_changed'});

  activeContext={ok:true,membership:{id:10,public_id:'circle-primary',role:'owner'},
    context_version:0,implicit:true};
  response=await invoke({headers:{'x-context-valid':'0'}});
  assert.equal(response.status,200,'an implicit single-circle context needs no version header');
});
