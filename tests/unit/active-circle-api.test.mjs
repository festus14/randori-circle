import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

let enabled=true;
let authPayload={id:1,sessionHash:'a'.repeat(64)};
let listed={
  circles:Object.freeze([
    Object.freeze({id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true}),
    Object.freeze({id:20,public_id:'circle-secondary',name:'Secondary',role:'member',is_primary:false}),
  ]),
  active:null,
  context_version:0,
  selection_required:true,
};
let selected={ok:true,membership:listed.circles[1],context_version:1,changed:true};
let readinessError=null;
let creationReadinessError=null;
let listError=null;
let creationResult={ok:true,circle:{public_id:'circle-created',name:'Created',role:'owner',is_primary:false},context_version:2,created:true};
let archiveResult={ok:true,changed:true,circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5};
let archiveError=null;
const calls=[];
const db={};

beforeEach(()=>{
  enabled=true;
  authPayload={id:1,sessionHash:'a'.repeat(64)};
  listed={
    circles:Object.freeze([
      Object.freeze({id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true}),
      Object.freeze({id:20,public_id:'circle-secondary',name:'Secondary',role:'member',is_primary:false}),
    ]),
    active:null,context_version:0,selection_required:true,
  };
  selected={ok:true,membership:listed.circles[1],context_version:1,changed:true};
  readinessError=null;
  creationReadinessError=null;
  listError=null;
  creationResult={ok:true,circle:{public_id:'circle-created',name:'Created',role:'owner',is_primary:false},context_version:2,created:true};
  archiveResult={ok:true,changed:true,circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5};
  archiveError=null;
  calls.length=0;
});

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>{},
  getClient:()=>db,
  getJwtSecret:()=> 'active-circle-api-secret-at-least-thirty-two-bytes',
  verifyMutationOrigin:req=>req.headers?.origin!=='https://cross-origin.example',
  verifyRequestAuth:async()=>authPayload,
}});

mock.module('../../api/_circle-membership.js',{exports:{
  ensureCircleMembershipReadiness:async()=>{ if(readinessError) throw readinessError; },
}});

mock.module('../../api/_active-circle.js',{exports:{
  multiCircleControlPlaneEnabled:()=>enabled,
  requestCircleContextVersion:req=>{
    const value=req.headers?.['x-randori-circle-context-version'];
    return typeof value==='string'&&/^(?:0|[1-9]\d*)$/.test(value)?Number(value):null;
  },
  listSessionCircleContexts:async(_db,payload)=>{
    calls.push(['list',_db,payload]);
    if(listError) throw listError;
    return listed;
  },
  selectActiveCircleContext:async(_db,payload,input)=>{ calls.push(['select',_db,payload,input]); return selected; },
}});

class MockCircleArchiveError extends Error{
  constructor(code){ super(code); this.code=code; }
}
mock.module('../../api/_circle-archive.js',{exports:{
  CircleArchiveError:MockCircleArchiveError,
  parseCircleArchive:body=>{
    if(!body||typeof body!=='object'||Array.isArray(body)
      ||Object.keys(body).sort().join(',')!=='circle_public_id,expected_context_version'
      ||typeof body.circle_public_id!=='string'||!body.circle_public_id
      ||!Number.isSafeInteger(body.expected_context_version)||body.expected_context_version<0){
      throw new MockCircleArchiveError('CIRCLE_ARCHIVE_INPUT_INVALID');
    }
    return {circlePublicId:body.circle_public_id,expectedContextVersion:body.expected_context_version};
  },
  archiveSecondaryCircle:async(_db,payload,input)=>{
    calls.push(['archive',_db,payload,input]);
    if(archiveError) throw archiveError;
    return archiveResult;
  },
}});

class MockCircleCreationError extends Error{
  constructor(code){ super(code); this.code=code; }
}
mock.module('../../api/_circle-creation.js',{exports:{
  CircleCreationError:MockCircleCreationError,
  ensureCircleCreationReadiness:async()=>{ calls.push(['creation-readiness']); if(creationReadinessError) throw creationReadinessError; },
  parseCircleCreation:body=>{
    if(!body||typeof body!=='object'||Array.isArray(body)
      ||Object.keys(body).sort().join(',')!=='name,request_id'
      ||typeof body.name!=='string'||!body.name||typeof body.request_id!=='string'){
      throw new MockCircleCreationError('CIRCLE_CREATE_INPUT_INVALID');
    }
    return {name:body.name,requestId:body.request_id};
  },
  createCircleAndSelect:async(_db,payload,input)=>{
    calls.push(['create',_db,payload,input]); return creationResult;
  },
}});

const {default:handler}=await import('../../api/circles.js');

function invoke({method='GET',headers={},body={}}={}){
  return new Promise((resolve,reject)=>{
    let status=200;
    const responseHeaders={};
    let settled=false;
    const finish=value=>{
      if(settled) return;
      settled=true;
      resolve({status,headers:responseHeaders,body:value});
    };
    const response={
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      status(value){ status=value; return this; },
      json(value){ finish(value); return this; },
    };
    Promise.resolve(handler({method,headers,body},response)).then(()=>finish(undefined)).catch(reject);
  });
}

test('circle discovery lists only the authenticated session memberships and its selection state',async()=>{
  calls.length=0;
  const response=await invoke();
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{
    ok:true,circles:[
      {public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
      {public_id:'circle-secondary',name:'Secondary',role:'member',is_primary:false},
    ],active_circle:null,context_version:0,selection_required:true,
  });
  assert.deepEqual(calls,[['list',db,authPayload]]);
  assert.equal(response.headers['cache-control'],'private, no-store');
});

test('circle selection is same-origin, exact, and compare-and-swap protected',async()=>{
  calls.length=0;
  let response=await invoke({method:'PUT',headers:{origin:'https://cross-origin.example'},body:{
    circle_public_id:'circle-secondary',expected_context_version:0,
  }});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);

  for(const body of [
    {},
    {circle_public_id:'circle-secondary'},
    {circle_public_id:'circle-secondary',expected_context_version:'0'},
    {circle_public_id:'circle-secondary',expected_context_version:0,extra:true},
  ]){
    response=await invoke({method:'PUT',body});
    assert.equal(response.status,400);
  }

  calls.length=0;
  listed={...listed,active:listed.circles[1],context_version:1,selection_required:false};
  response=await invoke({method:'PUT',body:{circle_public_id:'circle-secondary',expected_context_version:0}});
  assert.equal(response.status,200);
  assert.equal(response.body.active_circle.public_id,'circle-secondary');
  assert.equal(response.body.context_version,1);
  assert.deepEqual(calls[0],['select',db,authPayload,{circlePublicId:'circle-secondary',expectedContextVersion:0}]);

  selected={ok:false,reason:'context_changed',context_version:2};
  response=await invoke({method:'PUT',body:{circle_public_id:'circle-primary',expected_context_version:1}});
  assert.equal(response.status,409);
  assert.deepEqual(response.body,{error:'circle context changed',code:'circle_context_changed'});
});

test('circle creation validates before storage, requires same origin, and projects only public result',async()=>{
  calls.length=0;
  let response=await invoke({method:'POST',headers:{origin:'https://cross-origin.example'},body:{
    name:'Created',request_id:'opaque_request_123456',
  }});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);
  for(const body of [{},{name:'Created'},{name:'Created',request_id:'opaque_request_123456',role:'owner'}]){
    response=await invoke({method:'POST',body});
    assert.equal(response.status,400);
    assert.equal(calls.length,0);
  }
  response=await invoke({method:'POST',body:{name:'Created',request_id:'opaque_request_123456'}});
  assert.equal(response.status,201);
  assert.deepEqual(response.body,{
    ok:true,circle:{public_id:'circle-created',name:'Created',role:'owner',is_primary:false},context_version:2,
  });
  assert.equal(Object.hasOwn(response.body,'created'),false);
  assert.deepEqual(calls.at(-1),['create',db,authPayload,{name:'Created',requestId:'opaque_request_123456'}]);

  creationResult={...creationResult,created:false};
  response=await invoke({method:'POST',body:{name:'Created',request_id:'opaque_request_123456'}});
  assert.equal(response.status,200);
  creationResult={ok:false,reason:'ownership_limit'};
  response=await invoke({method:'POST',body:{name:'Created',request_id:'opaque_request_123456'}});
  assert.equal(response.status,409);
  assert.equal(response.body.code,'circle_ownership_limit');
});

test('secondary archive is same-origin, exact, context-bound, and projects the safe fallback',async()=>{
  const body={circle_public_id:'circle-secondary',expected_context_version:4};
  let response=await invoke({method:'DELETE',headers:{origin:'https://cross-origin.example',
    'x-randori-circle-context-version':'4'},body});
  assert.equal(response.status,403);
  assert.equal(calls.length,0);

  for(const invalid of [{},{circle_public_id:'circle-secondary'},
    {...body,expected_context_version:'4'},{...body,extra:true}]){
    response=await invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'4'},body:invalid});
    assert.equal(response.status,400);
  }
  response=await invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'3'},body});
  assert.deepEqual(response.body,{error:'circle context changed',code:'circle_context_changed'});
  assert.equal(calls.length,0);

  listed={circles:[listed.circles[0]],active:listed.circles[0],context_version:5,selection_required:false};
  response=await invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'4'},body});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{
    ok:true,
    circles:[{public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true}],
    active_circle:{public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
    context_version:5,selection_required:false,
    archived_circle_public_id:'circle-secondary',archived:true,
  });
  assert.deepEqual(calls,[
    ['archive',db,authPayload,{circlePublicId:'circle-secondary',expectedContextVersion:4}],
    ['list',db,authPayload],
  ]);
});

test('archive failures are stable, non-leaking, and recent-auth remains actionable',async()=>{
  const request=()=>invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'4'},
    body:{circle_public_id:'circle-secondary',expected_context_version:4}});
  for(const [reason,status,body] of [
    ['circle_unavailable',404,{error:'circle unavailable'}],
    ['context_changed',409,{error:'circle context changed',code:'circle_context_changed'}],
    ['primary_circle',409,{error:'the primary circle cannot be archived',code:'primary_circle_required'}],
    ['last_circle',409,{error:'every active member needs another circle before archive',code:'member_last_circle'}],
    ['session_changed',401,{error:'authentication required'}],
  ]){
    archiveResult={ok:false,reason};
    const response=await request();
    assert.equal(response.status,status);
    assert.deepEqual(response.body,body);
  }
  archiveResult={ok:true,changed:true,circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5};
  archiveError=Object.assign(new Error('recent authentication required'),{code:'RECENT_AUTH_REQUIRED'});
  let response=await request();
  assert.equal(response.status,403);
  assert.deepEqual(response.body,{error:'recent authentication required',code:'recent_auth_required'});
  archiveError=new MockCircleArchiveError('CIRCLE_ARCHIVE_COMMIT_UNKNOWN');
  response=await request();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'circle archive status unknown; retry the same archive request',
    code:'circle_archive_status_unknown'});
});

test('a post-commit context refresh failure tells the browser that archive already succeeded',async()=>{
  listError=new Error('database refresh unavailable');
  const response=await invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'4'},
    body:{circle_public_id:'circle-secondary',expected_context_version:4}});
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{
    error:'circle archived; reload required',code:'circle_archive_refresh_required',
    archived_circle_public_id:'circle-secondary',context_version:5,
  });
  assert.deepEqual(calls.map(call=>call[0]),['archive','list']);
});

test('an unusable post-commit context projection also requires a browser refresh',async()=>{
  const unusable=[
    {...listed,active:null,selection_required:true,context_version:5},
    {...listed,circles:[...listed.circles,{public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false}],
      context_version:5},
    {...listed,context_version:4},
  ];
  for(const projection of unusable){
    listed=projection;
    calls.length=0;
    const response=await invoke({method:'DELETE',headers:{'x-randori-circle-context-version':'4'},
      body:{circle_public_id:'circle-secondary',expected_context_version:4}});
    assert.equal(response.status,503);
    assert.deepEqual(response.body,{
      error:'circle archived; reload required',code:'circle_archive_refresh_required',
      archived_circle_public_id:'circle-secondary',context_version:5,
    });
    assert.deepEqual(calls.map(call=>call[0]),['archive','list']);
  }
});

test('disabled, unauthenticated, and unavailable context paths fail closed',async()=>{
  enabled=false;
  assert.equal((await invoke()).status,404);
  enabled=true;
  authPayload=null;
  assert.equal((await invoke()).status,401);
  authPayload={id:1,sessionHash:'a'.repeat(64)};
  readinessError=new Error('secret database detail');
  const failed=await invoke();
  assert.equal(failed.status,503);
  assert.deepEqual(failed.body,{error:'circles unavailable'});
});
