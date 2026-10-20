// Secondary-circle schedule email: intent construction for every CAS action,
// strict v2 payload parsing, fail-closed delivery suppression against the live
// authority row, rendering, and provider error classification.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  createSecondaryScheduleEmailHandler,
  SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION,
  SECONDARY_SCHEDULE_REMINDER_LEAD_MS,
  secondaryScheduleInstantFingerprint,
  secondaryScheduleNotificationEvents,
} from '../../api/_secondary-schedule-email.js';
import { OutboxDeliveryError } from '../../api/_outbox.js';

const FLAGS=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_SCHEDULING_ENABLED','SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED'];
const SCHEDULE='a'.repeat(64);
const PROPOSAL='b'.repeat(64);
const OTHER_PROPOSAL='c'.repeat(64);
const CYCLE='d'.repeat(64);
const INSTANT='2098-09-20T09:00:00.000Z';
const LATER='2098-09-21T09:00:00.000Z';
const NOW='2098-09-18T09:00:00.000Z';

beforeEach(()=>{ for(const key of FLAGS) process.env[key]='true'; });
afterEach(()=>{ for(const key of FLAGS) delete process.env[key]; });

const scope=Object.freeze({scheduleKey:SCHEDULE,userAId:1,userBId:2});
const proposal=(id=PROPOSAL,instant=INSTANT,proposedBy=1)=>({proposalId:id,instant,proposedBy});
const state=(proposals=[],agreedTime=null,revision=1)=>({proposals,agreedTime,revision});
const payloadOf=statement=>JSON.parse(statement.args[3]);

test('instant fingerprints accept only already-normalized instants',()=>{
  assert.match(secondaryScheduleInstantFingerprint(INSTANT),/^[a-f0-9]{64}$/);
  assert.notEqual(secondaryScheduleInstantFingerprint(INSTANT),secondaryScheduleInstantFingerprint(LATER));
  for(const value of ['2098-09-20T10:00:00+01:00','2098-09-20T09:00:00Z','nope',null]){
    assert.throws(()=>secondaryScheduleInstantFingerprint(value),TypeError);
  }
});

test('notification context is validated before any intent is built',()=>{
  const ok={scope,currentState:state(),nextState:state([proposal()],null,1),mutation:{action:'propose'},actorUserId:1};
  assert.equal(secondaryScheduleNotificationEvents(ok).length,1);
  for(const bad of [
    {...ok,actorUserId:0},{...ok,actorUserId:3},{...ok,nextState:{...ok.nextState,revision:0}},
    {...ok,scope:{...scope,scheduleKey:'short'}},{...ok,scope:{...scope,userBId:null}},
    {...ok,scope:{...scope,userBId:1}},{...ok,currentState:null},{...ok,mutation:null},{...ok,nextState:null},
  ]) assert.throws(()=>secondaryScheduleNotificationEvents(bad),TypeError);
  assert.throws(()=>secondaryScheduleNotificationEvents(),TypeError);
  assert.throws(()=>secondaryScheduleNotificationEvents({...ok,mutation:{action:'archive'}}),/unsupported/);
});

test('propose notifies only the partner and re-arms reminders for an existing agreed time',()=>{
  const intents=secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'propose'},
    currentState:state([proposal()],INSTANT,3),
    nextState:state([proposal(),proposal(OTHER_PROPOSAL,LATER,2)],INSTANT,4)});
  assert.equal(intents.length,3);
  const [first,...reminders]=intents.map(payloadOf);
  assert.deepEqual([first.kind,first.recipient_user_id,first.actor_user_id,first.proposal_id,first.schedule_revision],
    ['proposal',1,2,OTHER_PROPOSAL,4]);
  assert.equal(first.instant_fingerprint,secondaryScheduleInstantFingerprint(LATER));
  assert.deepEqual(reminders.map(item=>[item.kind,item.recipient_user_id,item.proposal_id]),[['reminder',1,null],['reminder',2,null]]);
  assert.equal(intents[1].args[4],new Date(Date.parse(INSTANT)-SECONDARY_SCHEDULE_REMINDER_LEAD_MS).toISOString());
  assert.match(intents[0].args[2],/^secondary-schedule-email\/v1\/a{64}\/4\/proposal\/1$/);
  // A proposal not authored by the actor, or no new proposal at all, is rejected.
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'propose'},
    currentState:state(),nextState:state([proposal(PROPOSAL,INSTANT,2)])}),/proposed/);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'propose'},
    currentState:state([proposal()]),nextState:state([proposal()],null,2)}),/proposed/);
});

test('remove notifies the partner and validates the removal actually happened',()=>{
  const intents=secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'remove',proposalId:PROPOSAL},
    currentState:state([proposal()]),nextState:state([],null,2)});
  assert.deepEqual(intents.map(payloadOf).map(item=>[item.kind,item.recipient_user_id,item.instant_fingerprint]),
    [['removed',2,null]]);
  const withAgreed=secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'remove',proposalId:PROPOSAL},
    currentState:state([proposal()],LATER),nextState:state([],LATER,2)});
  assert.equal(withAgreed.length,3);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'remove',proposalId:OTHER_PROPOSAL},
    currentState:state([proposal()]),nextState:state([],null,2)}),/removed/);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'remove',proposalId:PROPOSAL},
    currentState:state([proposal()]),nextState:state([proposal()],null,2)}),/removed/);
});

test('clear notifies both members only when an agreed time existed',()=>{
  assert.deepEqual(secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'clear'},
    currentState:state(),nextState:state([],null,2)}),[]);
  const intents=secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'clear'},
    currentState:state([],INSTANT),nextState:state([],null,2)});
  assert.deepEqual(intents.map(payloadOf).map(item=>[item.kind,item.recipient_user_id]),[['cleared',1],['cleared',2]]);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'clear'},
    currentState:state([],INSTANT),nextState:state([],LATER,2)}),/cleared/);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:1,mutation:{action:'clear'},
    currentState:state([],null),nextState:state([],LATER,2)}),/cleared/);
});

test('accept distinguishes first agreement from a change and skips idempotent re-accepts',()=>{
  const accepted=secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'accept',proposalId:PROPOSAL},
    currentState:state([proposal()]),nextState:state([proposal()],INSTANT,2)});
  assert.deepEqual(accepted.map(payloadOf).map(item=>[item.kind,item.recipient_user_id]),
    [['accepted',1],['accepted',2],['reminder',1],['reminder',2]]);
  const changed=secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'accept',proposalId:OTHER_PROPOSAL},
    currentState:state([proposal(),proposal(OTHER_PROPOSAL,LATER)],INSTANT,2),
    nextState:state([proposal(),proposal(OTHER_PROPOSAL,LATER)],LATER,3)});
  assert.equal(payloadOf(changed[0]).kind,'changed');
  assert.deepEqual(secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'accept',proposalId:PROPOSAL},
    currentState:state([proposal()],INSTANT),nextState:state([proposal()],INSTANT,2)}),[]);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'accept',proposalId:OTHER_PROPOSAL},
    currentState:state([proposal()]),nextState:state([proposal()],INSTANT,2)}),/accepted/);
  assert.throws(()=>secondaryScheduleNotificationEvents({scope,actorUserId:2,mutation:{action:'accept',proposalId:PROPOSAL},
    currentState:state([proposal()]),nextState:state([proposal()],LATER,2)}),/accepted/);
});

function validRow(overrides={}){
  return {
    schedule_key:SCHEDULE,schedule_revision:4,publication_id:7,scope_key:'circle:20',circle_id:20,cycle_key:CYCLE,
    group_id:9,member_count:2,user_a_id:1,user_b_id:2,is_solo:0,agreed_time:null,
    publication_join_id:7,publication_scope_key:'circle:20',publication_circle_id:20,publication_cycle_key:CYCLE,
    publication_cycle_id:'2098-W38',publication_starts_at:'2098-09-14T00:00:00.000Z',
    publication_ends_at:'2098-09-28T00:00:00.000Z',publication_cutoff_at:'2098-09-14T00:00:00.000Z',
    publication_time_zone:'Europe/London',group_join_id:9,group_scope_key:'circle:20',group_circle_id:20,
    group_cycle_key:CYCLE,group_member_count:2,group_user_a_id:1,group_user_b_id:2,group_is_solo:0,
    cycle_scope_key:'circle:20',cycle_circle_id:20,cycle_join_key:CYCLE,cycle_id:'2098-W38',
    cycle_starts_at:'2098-09-14T00:00:00.000Z',cycle_ends_at:'2098-09-28T00:00:00.000Z',
    cycle_cutoff_at:'2098-09-14T00:00:00.000Z',cycle_time_zone:'Europe/London',circle_name:'Night <Owls>',
    is_primary:0,archived_at:null,actor_membership_status:'active',actor_is_demo:0,actor_name:'Ada & Co',
    recipient_membership_status:'active',recipient_is_demo:0,recipient_email:' Two@Example.Test ',
    partner_membership_status:'active',partner_is_demo:0,email_enabled:null,proposal_key:PROPOSAL,
    proposal_instant:INSTANT,proposed_by:1,current_publication_count:1,now_utc:NOW,
    ...overrides,
  };
}

function eventFor(kind,overrides={}){
  const needsProposal=['proposal','removed','accepted','changed'].includes(kind);
  const needsFingerprint=['proposal','accepted','changed','reminder'].includes(kind);
  return {
    eventVersion:SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION,idempotencyKey:`key-${kind}`,
    payload:{schedule_id:SCHEDULE,proposal_id:needsProposal?PROPOSAL:null,schedule_revision:4,actor_user_id:1,
      recipient_user_id:2,kind,instant_fingerprint:needsFingerprint?secondaryScheduleInstantFingerprint(INSTANT):null,
      template_version:1,...overrides},
  };
}

function harness(rows=[validRow()],sendImpl){
  const sent=[];
  const queries=[];
  const db={async execute(statement){ queries.push(statement); return {rows:typeof rows==='function'?rows():rows}; }};
  const send=sendImpl||(async message=>{ sent.push(message); return {providerName:'resend',data:{id:'msg-1'}}; });
  return {sent,queries,handler:createSecondaryScheduleEmailHandler({db,origin:'https://randori.example',send})};
}

test('the handler factory requires a database and provider',()=>{
  assert.throws(()=>createSecondaryScheduleEmailHandler(),TypeError);
  assert.throws(()=>createSecondaryScheduleEmailHandler({db:{execute(){}}}),TypeError);
  assert.throws(()=>createSecondaryScheduleEmailHandler({db:{},send(){}}),TypeError);
});

test('v2 payloads are parsed strictly and rejected without retry',async()=>{
  const {handler,queries}=harness();
  const rejects=async(event,code)=>assert.rejects(handler(event),error=>
    error instanceof OutboxDeliveryError&&error.code===code&&error.retryable===false);
  await rejects({...eventFor('proposal'),eventVersion:1},'EVENT_VERSION_UNSUPPORTED');
  await rejects({eventVersion:2,payload:null},'PAYLOAD_INVALID');
  await rejects({eventVersion:2,payload:{...eventFor('proposal').payload,extra:1}},'PAYLOAD_INVALID');
  for(const overrides of [
    {schedule_id:'x'},{schedule_id:null},{schedule_revision:0},{actor_user_id:'a'},{recipient_user_id:-2},
    {kind:'digest'},{kind:null},{template_version:2},{proposal_id:null},{proposal_id:'x'},
    {instant_fingerprint:null},{instant_fingerprint:'zz'},
  ]) await rejects(eventFor('proposal',overrides),'PAYLOAD_INVALID');
  // Kinds without a proposal or fingerprint must carry explicit nulls.
  await rejects(eventFor('cleared',{proposal_id:PROPOSAL}),'PAYLOAD_INVALID');
  await rejects(eventFor('removed',{instant_fingerprint:secondaryScheduleInstantFingerprint(INSTANT)}),'PAYLOAD_INVALID');
  await rejects(eventFor('reminder',{proposal_id:''}),'PAYLOAD_INVALID');
  assert.equal(queries.length,0,'invalid payloads never reach the database');
});

test('delivery is suppressed when the feature flag is off',async()=>{
  delete process.env.SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED;
  const {handler,queries}=harness();
  assert.deepEqual(await handler(eventFor('proposal')),{status:'suppressed',reasonCode:'SECONDARY_SCHEDULE_EMAIL_DISABLED'});
  assert.equal(queries.length,0);
});

test('every authority drift between the schedule, publication, group, and cycle suppresses delivery',async()=>{
  const drifts=[
    {schedule_key:'e'.repeat(64)},{schedule_revision:5},{publication_id:0},{scope_key:'circle:21'},{circle_id:0},
    {cycle_key:null},{group_id:null},{member_count:3},{is_solo:1},{user_a_id:0},{user_b_id:'x'},
    {user_b_id:1,group_user_b_id:1},
    {publication_join_id:8},{publication_scope_key:'circle:21'},{publication_circle_id:21},{publication_cycle_key:'f'},
    {group_join_id:10},{group_scope_key:'x'},{group_circle_id:21},{group_cycle_key:'x'},{group_member_count:3},
    {group_user_a_id:5},{group_user_b_id:5},{group_is_solo:1},{cycle_scope_key:'x'},{cycle_circle_id:21},
    {cycle_join_key:'x'},{cycle_id:'2098-W39'},{cycle_starts_at:'x'},{cycle_ends_at:'x'},{cycle_cutoff_at:'x'},
    {cycle_time_zone:'UTC'},{is_primary:1},{archived_at:'2098-01-01'},{current_publication_count:2},
    {now_utc:null},{now_utc:'2098-09-13T00:00:00.000Z'},{now_utc:'2098-09-28T00:00:00.000Z'},
  ];
  for(const drift of drifts){
    const {handler,sent}=harness([validRow(drift)]);
    assert.deepEqual(await handler(eventFor('proposal')),{status:'suppressed',reasonCode:'SCHEDULE_INVALID'},JSON.stringify(drift));
    assert.equal(sent.length,0);
  }
  for(const rows of [[],[validRow(),validRow()]]){
    const {handler}=harness(rows);
    assert.equal((await handler(eventFor('proposal'))).reasonCode,'SCHEDULE_INVALID');
  }
  const {handler}=harness(()=>undefined);
  assert.equal((await handler(eventFor('proposal'))).reasonCode,'SCHEDULE_INVALID');
});

test('participant, recipient, preference, and staleness checks fail closed',async()=>{
  const cases=[
    ['proposal',{actor_user_id:3},{},'PARTICIPANT_REVOKED'],
    ['proposal',{recipient_user_id:3},{},'PARTICIPANT_REVOKED'],
    ['proposal',{recipient_user_id:1},{},'RECIPIENT_INVALID'],
    ['removed',{recipient_user_id:1},{proposal_key:null},'RECIPIENT_INVALID'],
    ['proposal',{},{actor_membership_status:'removed'},'PARTICIPANT_REVOKED'],
    ['proposal',{},{actor_is_demo:1},'PARTICIPANT_REVOKED'],
    ['proposal',{},{recipient_membership_status:null},'PARTICIPANT_REVOKED'],
    ['proposal',{},{recipient_is_demo:1},'PARTICIPANT_REVOKED'],
    ['proposal',{},{partner_membership_status:'left'},'PARTICIPANT_REVOKED'],
    ['proposal',{},{partner_is_demo:1},'PARTICIPANT_REVOKED'],
    ['proposal',{},{email_enabled:0},'EMAIL_DISABLED'],
    ['proposal',{},{proposal_key:OTHER_PROPOSAL},'SCHEDULE_STALE'],
    ['proposal',{},{proposed_by:2},'SCHEDULE_STALE'],
    ['proposal',{},{proposal_instant:null},'SCHEDULE_STALE'],
    ['proposal',{},{proposal_instant:LATER},'SCHEDULE_STALE'],
    ['removed',{},{proposal_key:PROPOSAL},'SCHEDULE_STALE'],
    ['accepted',{},{agreed_time:null},'SCHEDULE_STALE'],
    ['accepted',{},{agreed_time:INSTANT,proposal_key:OTHER_PROPOSAL},'SCHEDULE_STALE'],
    ['changed',{},{agreed_time:INSTANT,proposal_instant:LATER},'SCHEDULE_STALE'],
    ['accepted',{},{agreed_time:LATER,proposal_instant:LATER},'SCHEDULE_STALE'],
    ['reminder',{},{agreed_time:null},'SCHEDULE_STALE'],
    ['reminder',{},{agreed_time:LATER},'SCHEDULE_STALE'],
    ['cleared',{},{agreed_time:INSTANT},'SCHEDULE_STALE'],
    ['proposal',{},{now_utc:INSTANT},'SESSION_ELAPSED'],
    ['reminder',{},{agreed_time:INSTANT,now_utc:'2098-09-20T09:00:00.001Z',publication_ends_at:'2098-09-28T00:00:00.000Z'},'SESSION_ELAPSED'],
    ['proposal',{},{recipient_email:''},'RECIPIENT_INVALID'],
    ['proposal',{},{recipient_email:null},'RECIPIENT_INVALID'],
    ['proposal',{},{recipient_email:'not-an-email'},'RECIPIENT_INVALID'],
    ['proposal',{},{recipient_email:`${'x'.repeat(320)}@example.test`},'RECIPIENT_INVALID'],
    ['proposal',{},{circle_name:'   '},'RECIPIENT_INVALID'],
    ['proposal',{},{circle_name:null},'RECIPIENT_INVALID'],
    ['proposal',{},{circle_name:'x'.repeat(121)},'RECIPIENT_INVALID'],
    ['proposal',{},{circle_name:'Bad\u0007Name'},'RECIPIENT_INVALID'],
  ];
  for(const [kind,payload,row,reason] of cases){
    const {handler,sent}=harness([validRow(row)]);
    assert.deepEqual(await handler(eventFor(kind,payload)),{status:'suppressed',reasonCode:reason},`${kind} ${JSON.stringify(row)}`);
    assert.equal(sent.length,0);
  }
});

test('each kind renders escaped, dashboard-only content and returns provider receipts',async()=>{
  const expectations={
    proposal:[{},/proposed a session time$/,/Ada &amp; Co proposed <b>Saturday, 20 September 2098, 09:00 UTC<\/b>/],
    removed:[{proposal_key:null},/a proposed session time was removed$/,/removed a proposed time/],
    accepted:[{agreed_time:INSTANT,email_enabled:1},/your session is scheduled$/,/agreed on <b>Saturday/],
    changed:[{agreed_time:INSTANT},/your session time changed$/,/session rescheduled/],
    reminder:[{agreed_time:INSTANT},/your Randori session is coming up$/,/starts at <b>Saturday/],
    cleared:[{agreed_time:null},/your session time was cleared$/,/cleared the agreed time/],
  };
  for(const [kind,[row,subject,html]] of Object.entries(expectations)){
    const {handler,sent,queries}=harness([validRow(row)]);
    const result=await handler(eventFor(kind),{signal:'sig'});
    assert.deepEqual(result,{status:'delivered',providerName:'resend',providerMessageId:'msg-1'});
    assert.equal(sent.length,1);
    const [message]=sent;
    assert.equal(message.to,'two@example.test');
    assert.equal(message.kind,kind);
    assert.equal(message.idempotencyKey,`key-${kind}`);
    assert.equal(message.signal,'sig');
    assert.match(message.subject,subject);
    assert.match(message.subject,/^Night <Owls> — /,'subjects are plain text');
    assert.match(message.html,html);
    assert.match(message.html,/<h2>Night &lt;Owls&gt; — /);
    assert.match(message.html,/href="https:\/\/randori\.example\/\?view=dashboard"/);
    assert.doesNotMatch(message.html,/room|workspace|circle:20/);
    assert.deepEqual(queries[0].args.slice(-2),[kind==='cleared'||kind==='reminder'?null:PROPOSAL,SCHEDULE]);
  }
  // Missing or control-character display names fall back safely.
  const {handler,sent}=harness([validRow({actor_name:'\u0000\u0001'})]);
  await handler(eventFor('proposal'));
  assert.match(sent[0].subject,/Your partner proposed/);
  const fallback=harness([validRow({actor_name:null})],async()=>({providerMessageId:'pm-2'}));
  assert.deepEqual(await fallback.handler(eventFor('proposal')),{status:'delivered',providerName:'email',providerMessageId:'pm-2'});
  const noId=harness([validRow()],async()=>undefined);
  assert.deepEqual(await noId.handler(eventFor('proposal')),{status:'delivered',providerName:'email',providerMessageId:null});
});

test('provider failures are classified for retry policy',async()=>{
  const classify=async(failure,{returned=false}={})=>{
    const {handler}=harness([validRow()],async()=>{ if(returned) return {error:failure}; throw failure; });
    try{ await handler(eventFor('proposal')); }
    catch(error){ return error; }
    assert.fail('expected a delivery error');
  };
  const limited=await classify({statusCode:429,retryAfterMs:1500});
  assert.deepEqual([limited.code,limited.retryable,limited.retryAfterMs],['PROVIDER_RATE_LIMITED',true,1500]);
  const limitedNoHint=await classify({status:429});
  // No hint: the handler passes null, which OutboxDeliveryError normalizes to 0
  // (no extra delay beyond the exponential backoff).
  assert.deepEqual([limitedNoHint.code,limitedNoHint.retryAfterMs],['PROVIDER_RATE_LIMITED',0]);
  const snake=await classify({response:{status:429},retry_after_ms:'250'});
  assert.equal(snake.retryAfterMs,250);
  const unavailable=await classify({error:{statusCode:503}},{returned:true});
  assert.deepEqual([unavailable.code,unavailable.retryable],['PROVIDER_UNAVAILABLE',true]);
  const rejected=await classify({statusCode:422});
  assert.deepEqual([rejected.code,rejected.retryable],['PROVIDER_REJECTED',false]);
  assert.equal(rejected.providerReason,'422:other:other');
  assert.equal((await classify({statusCode:403,name:'validation_error',message:'You can only send testing emails to your own email address (owner@example.test). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.'})).providerReason,'403:validation_error:testing_recipient_restricted');
  assert.equal(limited.providerReason,'429:other:other');
  assert.equal(unavailable.providerReason,'503:other:other');
  const passthrough=new OutboxDeliveryError('CUSTOM_CODE',{retryable:false});
  assert.equal(await classify(passthrough),passthrough);
  const generic=await classify(new Error('socket hang up'));
  assert.deepEqual([generic.code,generic.retryable,generic.cause.message],['PROVIDER_FAILED',true,'socket hang up']);
  assert.equal(generic.providerReason,null);
});
