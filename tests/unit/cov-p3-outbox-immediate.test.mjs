// P3 coverage: the post-commit immediate delivery scheduler. Its lazily
// imported collaborators are replaced so each early return and the platform
// deadline arithmetic can be observed exactly; the request-context symbol is
// the real @vercel/functions integration point.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const REQUEST_CONTEXT=Symbol.for('@vercel/request-context');
const state={};

function resetState(){
  Object.assign(state,{
    localAdapter:false,baseUrl:'https://randori.example.test',
    plan:{local:false,handlers:new Map([['invitation.email.requested',()=>{}]])},
    planCalls:[],deliverCalls:[],deliverImpl:null,
  });
}
resetState();

mock.module('../../api/_local-runtime.js',{exports:{
  localIdentityAdapterEnabled:()=>state.localAdapter,
}});
mock.module('../../api/_outbox-delivery.js',{exports:{
  configuredOutboxBaseUrl:()=>state.baseUrl,
  outboxDeliveryPlan:async(db,baseUrl,req,options)=>{
    state.planCalls.push({db,baseUrl,req,options});
    return state.plan;
  },
}});
mock.module('../../api/_db.js',{exports:{getClient:()=>'db-client'}});
mock.module('../../api/_outbox.js',{exports:{
  deliverOutboxEventsNow:async options=>{
    state.deliverCalls.push(options);
    if(state.deliverImpl) return state.deliverImpl(options);
    return {claimed:options.events.length,delivered:options.events.length};
  },
}});

const {
  deliverCommittedOutboxEvents,
  OUTBOX_IMMEDIATE_BUDGET_MS,
  outboxEventsFromStatements,
  outboxImmediateDeliveryEnabled,
} = await import('../../api/_outbox-immediate.js');
// _outbox.js is mocked here, so register an identity the way its statement
// builder does.
const { rememberOutboxStatement } = await import('../../api/_outbox-identity.js');
const createOutboxEventStatement=(eventType,idempotencyKey)=>rememberOutboxStatement(
  {sql:'INSERT INTO outbox_events',args:[]},{eventType,idempotencyKey});

const previousContext=globalThis[REQUEST_CONTEXT];
const ENV_KEYS=['OUTBOX_IMMEDIATE_DELIVERY','VERCEL'];
const previousEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));

function installContext(context){
  const registered=[];
  globalThis[REQUEST_CONTEXT]={get:()=>{
    if(context?.throws) throw new Error('request context unavailable');
    return {...context,waitUntil(promise){ registered.push(promise); if(context?.waitUntilThrows) throw new Error('no runtime'); }};
  }};
  return registered;
}

afterEach(()=>{
  resetState();
  if(previousContext===undefined) delete globalThis[REQUEST_CONTEXT];
  else globalThis[REQUEST_CONTEXT]=previousContext;
  for(const key of ENV_KEYS){
    if(previousEnv[key]===undefined) delete process.env[key];
    else process.env[key]=previousEnv[key];
  }
});

const INVITE={eventType:'invitation.email.requested',idempotencyKey:'invitation/v1/abc'};
const req={headers:{host:'randori.example.test'}};

test('immediate delivery is enabled on Vercel or by explicit opt-in, and the kill switch always wins',()=>{
  delete process.env.VERCEL;
  delete process.env.OUTBOX_IMMEDIATE_DELIVERY;
  assert.equal(outboxImmediateDeliveryEnabled(),false);
  process.env.OUTBOX_IMMEDIATE_DELIVERY=' TRUE ';
  assert.equal(outboxImmediateDeliveryEnabled(),true);
  process.env.OUTBOX_IMMEDIATE_DELIVERY='yes';
  assert.equal(outboxImmediateDeliveryEnabled(),false,'only the literal true opts in');
  process.env.VERCEL='1';
  assert.equal(outboxImmediateDeliveryEnabled(),true);
  process.env.OUTBOX_IMMEDIATE_DELIVERY='False';
  assert.equal(outboxImmediateDeliveryEnabled(),false);
});

test('only statements built by the outbox builder yield delivery identities',()=>{
  const registered=createOutboxEventStatement(INVITE.eventType,INVITE.idempotencyKey);
  assert.deepEqual(outboxEventsFromStatements([{sql:'UPDATE users'},registered,null,'raw sql']),[INVITE]);
  assert.deepEqual(outboxEventsFromStatements(undefined),[]);
});

test('nothing is scheduled without valid targets or when delivery is disabled',async()=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  const registered=installContext({});
  assert.equal(await deliverCommittedOutboxEvents(req,[]),null);
  assert.equal(await deliverCommittedOutboxEvents(req,[null,{eventType:INVITE.eventType},{idempotencyKey:'x'}]),null);
  assert.equal(await deliverCommittedOutboxEvents(req,{not:'an array'}),null,'malformed input never throws');
  process.env.OUTBOX_IMMEDIATE_DELIVERY='false';
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  assert.equal(registered.length,0);
  assert.equal(state.deliverCalls.length,0);
});

test('a committed batch is capped, registered with waitUntil, and delivered with deduplicated plan types',async()=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  const registered=installContext({});
  const events=Array.from({length:10},(_,index)=>({eventType:index%2?'pairing.email.requested':INVITE.eventType,
    idempotencyKey:`key-${index}-padding`}));
  const before=performance.now();
  const work=deliverCommittedOutboxEvents(req,events);
  assert.equal(registered.length,1);
  assert.equal(registered[0],work,'the background promise is the one handed to the runtime');
  assert.equal(state.planCalls.length,0,'no delivery work starts before the response tick');
  const result=await work;
  assert.deepEqual(result,{claimed:8,delivered:8});
  assert.equal(state.planCalls.length,1);
  assert.equal(state.planCalls[0].db,'db-client');
  assert.equal(state.planCalls[0].baseUrl,'https://randori.example.test');
  assert.equal(state.planCalls[0].req,req);
  assert.deepEqual(state.planCalls[0].options.types,[INVITE.eventType,'pairing.email.requested']);
  const [call]=state.deliverCalls;
  assert.equal(call.events.length,8);
  assert.match(call.workerId,/^inline-[0-9a-f-]{36}$/);
  assert.equal(call.handlers,state.plan.handlers);
  assert.ok(call.deadlineAtMs>before&&call.deadlineAtMs<=performance.now()+OUTBOX_IMMEDIATE_BUDGET_MS,
    'the deadline is the local budget when the platform has no deadline');
});

test('the platform invocation deadline shortens the budget and leaves finalization headroom',async()=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  installContext({deadline:Date.now()+3_000});
  const before=performance.now();
  await deliverCommittedOutboxEvents(req,[INVITE]);
  const near=state.deliverCalls[0].deadlineAtMs;
  assert.ok(near-before<=1_000+50,`deadline ${near-before}ms keeps two seconds of platform headroom`);

  installContext({deadline:Date.now()-1_000});
  const expiredBefore=performance.now();
  await deliverCommittedOutboxEvents(req,[INVITE]);
  const expired=state.deliverCalls[1].deadlineAtMs;
  assert.ok(expired>=expiredBefore&&expired<=performance.now(),'an elapsed platform deadline leaves no budget');
});

test('an unavailable request context neither blocks delivery nor throws to the caller',async()=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  installContext({throws:true});
  const before=performance.now();
  const result=await deliverCommittedOutboxEvents(req,[INVITE]);
  assert.deepEqual(result,{claimed:1,delivered:1});
  assert.ok(state.deliverCalls[0].deadlineAtMs-before>OUTBOX_IMMEDIATE_BUDGET_MS-1_000,
    'the local budget applies when the platform deadline cannot be read');
  const registered=installContext({waitUntilThrows:true});
  assert.deepEqual(await deliverCommittedOutboxEvents(req,[INVITE]),{claimed:1,delivered:1});
  assert.equal(registered.length,1);
});

test('local capture, a missing origin, and an empty plan all leave the row for the scheduled worker',async()=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  installContext({});
  state.localAdapter=true;
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  assert.equal(state.planCalls.length,0,'local development mail stays in the cron capture');
  state.localAdapter=false;
  state.baseUrl=null;
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  assert.equal(state.planCalls.length,0);
  state.baseUrl='https://randori.example.test';
  state.plan={local:true,handlers:new Map([[INVITE.eventType,()=>{}]])};
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  state.plan={local:false,handlers:new Map()};
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  assert.equal(state.planCalls.length,2);
  assert.equal(state.deliverCalls.length,0);
});

test('background failures are logged with a bounded code and resolve to null',async t=>{
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  installContext({});
  const warnings=[];
  t.mock.method(console,'warn',(...args)=>{ warnings.push(args); });
  state.deliverImpl=()=>{ throw Object.assign(new Error('private provider text'),{code:'SQLITE_BUSY'}); };
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE,{...INVITE,idempotencyKey:'invitation/v1/def'}]),null);
  state.deliverImpl=()=>{ throw new RangeError('x'.repeat(10)); };
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  state.deliverImpl=()=>{ throw 'bare string'; };
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  state.deliverImpl=()=>{ throw Object.assign(new Error('long'),{code:'C'.repeat(100)}); };
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null);
  const logged=warnings.map(([label,body])=>[label,JSON.parse(body)]);
  assert.deepEqual(logged,[
    ['[outbox_immediate_fail]',{types:[INVITE.eventType],code:'SQLITE_BUSY'}],
    ['[outbox_immediate_fail]',{types:[INVITE.eventType],code:'RangeError'}],
    ['[outbox_immediate_fail]',{types:[INVITE.eventType],code:'ERROR'}],
    ['[outbox_immediate_fail]',{types:[INVITE.eventType],code:'C'.repeat(64)}],
  ]);
  assert.ok(!warnings.flat().join(' ').includes('private provider text'));

  t.mock.method(console,'warn',()=>{ throw new Error('log sink down'); });
  state.deliverImpl=()=>{ throw new Error('again'); };
  assert.equal(await deliverCommittedOutboxEvents(req,[INVITE]),null,'a failing log sink is contained');
});
