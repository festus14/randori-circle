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
let creationResult={ok:true,circle:{public_id:'circle-created',name:'Created',role:'owner',is_primary:false},context_version:2,created:true};
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
  creationResult={ok:true,circle:{public_id:'circle-created',name:'Created',role:'owner',is_primary:false},context_version:2,created:true};
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
  listSessionCircleContexts:async(_db,payload)=>{ calls.push(['list',_db,payload]); return listed; },
  selectActiveCircleContext:async(_db,payload,input)=>{ calls.push(['select',_db,payload,input]); return selected; },
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
