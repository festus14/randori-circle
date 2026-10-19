// Handler-level branches for api/code-document.js: method and origin gates,
// identity extraction, readiness and multi-circle gating, and how domain
// results and errors map onto HTTP statuses. The domain module is replaced so
// each branch can be driven directly; its behaviour is covered elsewhere.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

class CodeDocumentInputError extends Error{
  constructor(message,{status}={}){ super(message); this.status=status; }
}
class CodeDocumentDataError extends Error{}

const state={};
function reset(){
  Object.assign(state,{
    originOk:true,originCalls:[],auth:{id:1},authThrows:false,readinessThrows:false,
    multiCircle:false,legacyAllowed:true,getResult:null,mergeResult:null,throwFrom:null,calls:[],
  });
}
reset();

mock.module('../../api/_db.js',{exports:{
  getClient:()=>({fake:true}),
  verifyMutationOrigin:req=>{ state.originCalls.push(req.method); return state.originOk; },
  verifyRequestAuth:async()=>{ if(state.authThrows) throw new Error('auth store down'); return state.auth; },
}});
mock.module('../../api/_active-circle.js',{exports:{
  multiCircleControlPlaneEnabled:()=>state.multiCircle,
  canUseLegacySinglePrimaryCircleFeatures:async(db,auth)=>{ state.calls.push(['legacy',auth]); return state.legacyAllowed; },
  sendMultiCircleFeatureUnavailable:res=>res.status(409).json({code:'circle_feature_unavailable'}),
}});
mock.module('../../api/_data-readiness.js',{exports:{
  ensureCodeDocumentReadiness:async()=>{ if(state.readinessThrows) throw new Error('schema not ready'); },
}});
mock.module('../../api/_code-document.js',{exports:{
  CodeDocumentInputError,CodeDocumentDataError,
  parseCodeDocumentQuery:()=>{ if(state.throwFrom==='parse') throw state.error; return {afterRevision:2,roomId:'r'}; },
  parseCodeDocumentMutation:body=>{ if(state.throwFrom==='parse') throw state.error; return {clientId:body.client_id}; },
  getAuthorizedCodeDocument:async(db,request)=>{ state.calls.push(['get',request]); if(state.throwFrom==='domain') throw state.error; return state.getResult; },
  mergeAuthorizedCodeDocument:async(db,request)=>{ state.calls.push(['merge',request]); if(state.throwFrom==='domain') throw state.error; return state.mergeResult; },
  codeDocumentResponse:(result,options={})=>({ok:true,revision:result.document.revision,after:options.afterRevision??0}),
}});

const {default:handler}=await import('../../api/code-document.js');

async function invoke({method='GET',headers={},body={}}={}){
  const response={status:200,headers:{},body:undefined};
  const res={
    status(value){ response.status=value; return this; },
    setHeader(name,value){ response.headers[name.toLowerCase()]=value; },
    json(value){ response.body=value; return this; },
  };
  await handler({method,headers,body,url:'/api/code-document'},res);
  return response;
}

beforeEach(reset);

test('only GET and POST are allowed and every response is private and no-store',async()=>{
  const response=await invoke({method:'DELETE'});
  assert.equal(response.status,405); assert.equal(response.headers.allow,'GET, POST');
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.equal(response.headers['x-content-type-options'],'nosniff');
  // A response object without setHeader is tolerated.
  let status;
  await handler({method:'PUT',headers:{}},{status(value){ status=value; return this; },json(){ return this; }});
  assert.equal(status,405);
});

test('cross-origin POSTs are rejected before authentication',async()=>{
  state.originOk=false;
  const response=await invoke({method:'POST'});
  assert.equal(response.status,403); assert.equal(response.body.error,'cross-origin mutation rejected');
  assert.equal(state.calls.length,0);
});

test('cookie-authenticated reads require a same-origin signal; bearer and cookieless reads do not',async()=>{
  state.getResult={document:{revision:1}};
  state.originOk=false;
  const bearer=await invoke({headers:{Authorization:'Bearer token-1',cookie:'randori_session=s'}});
  assert.equal(bearer.status,200);
  const cookieless=await invoke({headers:{cookie:'other=1'}});
  assert.equal(cookieless.status,200);
  assert.deepEqual(state.originCalls,[],'no origin check is needed without an ambient session cookie');

  const sameOrigin=await invoke({headers:{Cookie:'a=1; randori_session=s','Sec-Fetch-Site':'Same-Origin'}});
  assert.equal(sameOrigin.status,200);
  const sameSite=await invoke({headers:{cookie:'randori_session=s','sec-fetch-site':'same-site'}});
  assert.equal(sameSite.status,403); assert.equal(sameSite.body.error,'cross-origin read rejected');

  // Without Sec-Fetch-Site the handler falls back to the mutation-origin check as if it were a POST.
  const fallbackDenied=await invoke({headers:{cookie:'randori_session=s'}});
  assert.equal(fallbackDenied.status,403); assert.deepEqual(state.originCalls,['POST']);
  state.originOk=true;
  assert.equal((await invoke({headers:{cookie:'randori_session=s'}})).status,200);
});

test('authentication failures map to 503 and missing or invalid identities to 401',async()=>{
  state.authThrows=true;
  assert.equal((await invoke()).status,503);
  state.authThrows=false;
  for(const auth of [null,{},{id:0},{id:-3},{id:'abc'},{id:1.5}]){
    state.auth=auth;
    const response=await invoke();
    assert.equal(response.status,401,JSON.stringify(auth));
    assert.deepEqual(response.body,{ok:false,error:'authentication required'});
  }
  // A legacy `uid` claim identifies the viewer when `id` is absent.
  state.auth={uid:'7'}; state.getResult={document:{revision:1}};
  assert.equal((await invoke()).status,200);
  assert.equal(state.calls.find(([name])=>name==='get')[1].viewerId,7);
});

test('readiness failures and the multi-circle gate stop the request before domain access',async()=>{
  state.readinessThrows=true;
  const notReady=await invoke();
  assert.equal(notReady.status,503); assert.deepEqual(notReady.body,{ok:false,error:'code document unavailable'});
  state.readinessThrows=false;

  state.multiCircle=true; state.legacyAllowed=false;
  const gated=await invoke();
  assert.equal(gated.status,409); assert.equal(gated.body.code,'circle_feature_unavailable');
  assert.deepEqual(state.calls,[['legacy',{id:1}]]);

  state.legacyAllowed=true; state.getResult={document:{revision:4}};
  assert.equal((await invoke()).status,200);
});

test('GET returns 404 for denied rooms and passes the parsed cursor through to the response',async()=>{
  const denied=await invoke();
  assert.equal(denied.status,404); assert.deepEqual(denied.body,{ok:false,error:'code document not found'});
  state.getResult={document:{revision:9}};
  const found=await invoke();
  assert.deepEqual(found.body,{ok:true,revision:9,after:2});
  assert.deepEqual(state.calls.at(-1),['get',{viewerId:1,afterRevision:2,roomId:'r'}]);
});

test('POST maps denied, completed and merged outcomes',async()=>{
  const denied=await invoke({method:'POST',body:{client_id:'c1'}});
  assert.equal(denied.status,404);
  state.mergeResult={terminal:true};
  const completed=await invoke({method:'POST',body:{client_id:'c1'}});
  assert.equal(completed.status,409);
  assert.deepEqual(completed.body,{ok:false,code:'session_completed',error:'session is completed'});
  state.mergeResult={document:{revision:5},idempotent:true};
  const merged=await invoke({method:'POST',body:{client_id:'c1'}});
  assert.deepEqual(merged.body,{ok:true,revision:5,after:0,idempotent:true});
  assert.deepEqual(state.calls.at(-1),['merge',{viewerId:1,clientId:'c1'}]);
});

test('input errors keep their status, while data and unexpected errors are a generic 503',async()=>{
  const cases=[
    ['parse',new CodeDocumentInputError('bad room',{status:404}),404,{ok:false,error:'bad room'}],
    ['parse',new CodeDocumentInputError('bad field'),400,{ok:false,error:'bad field'}],
    ['domain',new CodeDocumentInputError('too large',{status:413}),413,{ok:false,error:'too large'}],
    ['domain',new CodeDocumentDataError('stored hash mismatch'),503,{ok:false,error:'code document unavailable'}],
    ['domain',new Error('SQLITE_IOERR secret path'),503,{ok:false,error:'code document unavailable'}],
  ];
  for(const method of ['GET','POST']){
    for(const [where,error,status,body] of cases){
      state.throwFrom=where; state.error=error;
      const response=await invoke({method});
      assert.equal(response.status,status,`${method} ${error.message}`);
      assert.deepEqual(response.body,body);
    }
  }
});
