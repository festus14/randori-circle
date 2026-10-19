// Primary-circle schedule email: notification intent rules, strict v1 payload
// parsing, freshness/supersession suppression, rendering, provider error
// classification, and v2 routing to the secondary handler.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createScheduleEmailHandler,
  SCHEDULE_REMINDER_LEAD_MS,
  scheduleNotificationEvents,
} from '../../api/_schedule-email.js';
import { OutboxDeliveryError } from '../../api/_outbox.js';
import { projectSchedule, readScheduleState } from '../../api/_schedule.js';

const INSTANT='2098-09-20T09:00:00.000Z';
const PREVIOUS='2098-09-19T09:00:00.000Z';
const NOW='2098-09-18T09:00:00.000Z';
const VERSION='a'.repeat(64);

function schedule({proposals=[],agreedTime=null}={}){
  return projectSchedule(readScheduleState({proposed_times:JSON.stringify(proposals),agreed_time:agreedTime,updated_at:NOW}));
}
const payloadOf=statement=>JSON.parse(statement.args[3]);

test('notification context and participants are validated',()=>{
  const base={weekId:10,pairGroupId:20,actorUserId:1,participants:[1,2],mutation:{action:'propose',instant:INSTANT},
    currentSchedule:schedule(),nextSchedule:{...schedule(),version:VERSION}};
  assert.equal(scheduleNotificationEvents(base).length,1);
  for(const participants of [[],[0,'x'],[1,2,3,4],undefined]){
    assert.throws(()=>scheduleNotificationEvents({...base,participants}),/participants/);
  }
  // Duplicates and invalid entries are ignored, not double-notified.
  const deduped=scheduleNotificationEvents({...base,participants:[1,2,2,'2',null]});
  assert.deepEqual(deduped.map(payloadOf).map(item=>item.recipient_user_id),[2]);
  for(const bad of [{weekId:0},{pairGroupId:null},{actorUserId:-1},{mutation:null},{currentSchedule:null},
    {nextSchedule:null},{nextSchedule:{version:'short'}},{nextSchedule:{}}]){
    assert.throws(()=>scheduleNotificationEvents({...base,...bad}),/notification context/);
  }
});

test('accept, change, clear and no-op mutations produce the exact intent set',()=>{
  const common={weekId:10,pairGroupId:20,actorUserId:2,participants:[1,2,3]};
  const accepted=scheduleNotificationEvents({...common,mutation:{action:'accept'},
    currentSchedule:{agreed_time:null},nextSchedule:{agreed_time:INSTANT,version:VERSION}});
  assert.deepEqual(accepted.map(payloadOf).map(item=>[item.kind,item.recipient_user_id]),
    [['accepted',1],['reminder',1],['accepted',2],['reminder',2],['accepted',3],['reminder',3]]);
  assert.equal(accepted[1].args[4],new Date(Date.parse(INSTANT)-SCHEDULE_REMINDER_LEAD_MS).toISOString());
  const changed=scheduleNotificationEvents({...common,mutation:{action:'accept'},
    currentSchedule:{agreed_time:PREVIOUS},nextSchedule:{agreed_time:INSTANT,version:VERSION}});
  assert.equal(payloadOf(changed[0]).kind,'changed');
  assert.equal(payloadOf(changed[0]).previous_instant,PREVIOUS);
  assert.deepEqual(scheduleNotificationEvents({...common,mutation:{action:'accept'},
    currentSchedule:{agreed_time:INSTANT},nextSchedule:{agreed_time:INSTANT,version:VERSION}}),[]);
  const cleared=scheduleNotificationEvents({...common,mutation:{action:'clear'},
    currentSchedule:{agreed_time:PREVIOUS},nextSchedule:{agreed_time:null,version:VERSION}});
  assert.deepEqual(cleared.map(payloadOf).map(item=>[item.kind,item.instant,item.previous_instant]),
    [['changed',null,PREVIOUS],['changed',null,PREVIOUS],['changed',null,PREVIOUS]]);
  assert.deepEqual(scheduleNotificationEvents({...common,mutation:{action:'clear'},
    currentSchedule:{},nextSchedule:{version:VERSION}}),[]);
  assert.deepEqual(scheduleNotificationEvents({...common,mutation:{action:'remove'},
    currentSchedule:{agreed_time:PREVIOUS},nextSchedule:{agreed_time:PREVIOUS,version:VERSION}}),[]);
});

test('the handler factory validates database, provider, runtime, and base URL',()=>{
  const db={execute(){}};
  const send=()=>{};
  assert.throws(()=>createScheduleEmailHandler({send,baseUrl:'https://x.test'}),/database and provider/);
  assert.throws(()=>createScheduleEmailHandler({db,baseUrl:'https://x.test'}),/database and provider/);
  assert.throws(()=>createScheduleEmailHandler({db,send,baseUrl:'https://x.test',localRuntime:'no'}),/runtime/);
  assert.throws(()=>createScheduleEmailHandler({db,send,baseUrl:'not a url'}),/base URL/);
  assert.equal(typeof createScheduleEmailHandler({db,send,baseUrl:'https://x.test/path?q=1'}),'function');
});

function eventFor(kind,overrides={},id=50){
  const payload={kind,week_id:10,pair_group_id:20,actor_user_id:1,recipient_user_id:2,schedule_version:VERSION,
    template_version:1,instant:INSTANT,previous_instant:null,...overrides};
  return {id,eventVersion:1,idempotencyKey:`key-${kind}`,payload};
}

function row(overrides={}){
  return {proposed_times:JSON.stringify([{instant:INSTANT,proposed_by:1}]),agreed_time:INSTANT,updated_at:NOW,
    email:' Two@Example.Test ',display_name:'Two',is_demo:0,email_enabled:1,week_label:'Week <38>',
    actor_name:'Ada & Co',now_utc:NOW,...overrides};
}

function harness({rows=[row()],newer=false,send,localRuntime=false}={}){
  const sent=[];
  const queries=[];
  const db={async execute(statement){
    queries.push(statement);
    if(statement.sql.includes('FROM outbox_events')) return {rows:newer?[{newer:1}]:[]};
    return {rows};
  }};
  const provider=send||(async message=>{ sent.push(message); return {providerName:'resend',providerMessageId:'pm-1'}; });
  return {sent,queries,handler:createScheduleEmailHandler({db,baseUrl:'https://randori.example/app',send:provider,localRuntime})};
}

test('v1 payloads are parsed strictly and never retried when invalid',async()=>{
  const {handler,queries}=harness();
  const rejects=async(event,code='PAYLOAD_INVALID')=>assert.rejects(handler(event),error=>
    error instanceof OutboxDeliveryError&&error.code===code&&error.retryable===false);
  await rejects({...eventFor('proposal'),eventVersion:3},'EVENT_VERSION_UNSUPPORTED');
  await rejects({eventVersion:1,payload:null});
  await rejects({eventVersion:1,payload:{...eventFor('proposal').payload,extra:true}});
  for(const overrides of [{kind:'removed'},{kind:null},{week_id:0},{pair_group_id:'x'},{actor_user_id:null},{recipient_user_id:-1},
    {template_version:2},{schedule_version:'xyz'},{schedule_version:null},{instant:null},{instant:'2098-09-20T10:00:00+01:00'},
    {previous_instant:PREVIOUS},{previous_instant:'2098-09-19T10:00:00+01:00'}]){
    await rejects(eventFor('proposal',overrides));
  }
  await rejects(eventFor('changed',{previous_instant:null}));
  await rejects(eventFor('changed',{previous_instant:INSTANT}));
  // A non-object event surfaces as a payload error, not a crash.
  await rejects(null,'PAYLOAD_INVALID');
  assert.equal(queries.length,0);
});

test('recipient lookups scope by runtime and suppress revoked or opted-out recipients',async()=>{
  const revoked=harness({rows:[]});
  assert.deepEqual(await revoked.handler(eventFor('proposal')),{status:'suppressed',reasonCode:'PARTICIPANT_REVOKED'});
  assert.match(revoked.queries[0].sql,/circle\.is_primary=1/);
  const local=harness({rows:[row(),row()],localRuntime:true});
  assert.deepEqual(await local.handler(eventFor('proposal')),{status:'suppressed',reasonCode:'PARTICIPANT_INACTIVE'});
  assert.doesNotMatch(local.queries[0].sql,/circle_memberships/);
  const missingRows=harness({rows:null});
  assert.equal((await missingRows.handler(eventFor('proposal'))).reasonCode,'PARTICIPANT_REVOKED');
  const optedOut=harness({rows:[row({email_enabled:0})]});
  assert.deepEqual(await optedOut.handler(eventFor('proposal')),{status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  assert.deepEqual(revoked.queries[0].args,[2,1,10,20,2,2,2,1,1,1]);
});

test('freshness, supersession, recipient and elapsed checks fail closed',async()=>{
  const cases=[
    ['proposal',{},{proposed_times:'{not json'},false,'SCHEDULE_INVALID'],
    ['proposal',{},{proposed_times:JSON.stringify([{instant:INSTANT,proposed_by:2}])},false,'SCHEDULE_STALE'],
    ['proposal',{},{proposed_times:JSON.stringify([INSTANT])},false,'SCHEDULE_STALE'],
    ['accepted',{},{agreed_time:PREVIOUS},false,'SCHEDULE_STALE'],
    ['changed',{instant:null,previous_instant:PREVIOUS},{agreed_time:INSTANT},false,'SCHEDULE_STALE'],
    ['changed',{instant:null,previous_instant:PREVIOUS},{agreed_time:'next tuesday'},false,'SCHEDULE_STALE'],
    ['proposal',{},{},true,'SCHEDULE_SUPERSEDED'],
    ['reminder',{},{},true,'SCHEDULE_SUPERSEDED'],
    ['accepted',{},{},true,'SCHEDULE_SUPERSEDED'],
    ['proposal',{},{email:null},false,'RECIPIENT_INVALID'],
    ['proposal',{},{email:'nobody'},false,'RECIPIENT_INVALID'],
    ['proposal',{},{email:`${'x'.repeat(320)}@example.test`},false,'RECIPIENT_INVALID'],
    ['proposal',{},{now_utc:INSTANT},false,'SESSION_ELAPSED'],
  ];
  for(const [kind,payload,stored,newer,reason] of cases){
    const {handler,sent}=harness({rows:[row(stored)],newer});
    assert.deepEqual(await handler(eventFor(kind,payload)),{status:'suppressed',reasonCode:reason},`${kind} ${reason}`);
    assert.equal(sent.length,0);
  }
});

test('supersession queries are kind-specific and only look at newer events for the same recipient',async()=>{
  const proposal=harness();
  await proposal.handler(eventFor('proposal',{},77));
  const proposalQuery=proposal.queries.find(query=>query.sql.includes('FROM outbox_events'));
  assert.deepEqual(proposalQuery.args,[77,'schedule.email.requested',10,20,2,1,INSTANT,INSTANT]);
  assert.match(proposalQuery.sql,/'\$\.kind'\)='proposal'/);
  const reminder=harness();
  await reminder.handler(eventFor('reminder',{},78));
  const reminderQuery=reminder.queries.find(query=>query.sql.includes('FROM outbox_events'));
  assert.deepEqual(reminderQuery.args,[78,'schedule.email.requested',10,20,2]);
  assert.match(reminderQuery.sql,/'\$\.kind'\)='reminder'/);
  const accepted=harness();
  await accepted.handler(eventFor('accepted',{},79));
  assert.match(accepted.queries.find(query=>query.sql.includes('FROM outbox_events')).sql,/IN \('accepted','changed'\)/);
});

test('each kind renders escaped content linking only to the private room',async()=>{
  const cases=[
    ['proposal',{},{},'Ada & Co proposed a Randori session time',/Ada &amp; Co proposed <b>Saturday, 20 September 2098, 09:00 UTC<\/b>/],
    ['accepted',{},{},'Your Randori session is scheduled',/Session scheduled for Week &lt;38&gt;/],
    ['reminder',{},{},'Reminder: your Randori session is coming up',/Your Week &lt;38&gt; session starts at/],
    ['changed',{previous_instant:PREVIOUS},{},'Your Randori session time changed',/moved from <s>Friday, 19 September 2098, 09:00 UTC<\/s> to <b>Saturday/],
    ['changed',{instant:null,previous_instant:PREVIOUS},{agreed_time:null},'Your Randori session time was cleared',/agreed time \(Friday, 19 September 2098, 09:00 UTC\) was cleared/],
  ];
  for(const [kind,payload,stored,subject,html] of cases){
    const {handler,sent}=harness({rows:[row(stored)]});
    assert.deepEqual(await handler(eventFor(kind,payload),{signal:'s'}),{status:'delivered',providerName:'resend',providerMessageId:'pm-1'});
    assert.equal(sent[0].to,'two@example.test');
    assert.equal(sent[0].subject,subject);
    assert.match(sent[0].html,html);
    assert.match(sent[0].html,/href="https:\/\/randori\.example\/join\/week_10_pair_20"/);
    assert.equal(sent[0].idempotencyKey,`key-${kind}`);
    assert.equal(sent[0].signal,'s');
  }
  // Missing labels and names fall back to neutral text.
  const fallback=harness({rows:[row({week_label:null,actor_name:'\u0001'})],send:async()=>({data:{id:'d-1'}})});
  assert.deepEqual(await fallback.handler(eventFor('accepted')),{status:'delivered',providerName:'email',providerMessageId:'d-1'});
  const nothing=harness({send:async()=>null});
  assert.deepEqual(await nothing.handler(eventFor('proposal')),{status:'delivered',providerName:'email',providerMessageId:null});
});

test('provider errors are classified, including errors returned rather than thrown',async()=>{
  const thrown=harness({send:async()=>{ throw Object.assign(new Error('rejected'),{statusCode:422}); }});
  await assert.rejects(thrown.handler(eventFor('proposal')),error=>error instanceof OutboxDeliveryError&&error.retryable===false);
  const returned=harness({send:async()=>({error:{statusCode:503}})});
  await assert.rejects(returned.handler(eventFor('proposal')),error=>error instanceof OutboxDeliveryError&&error.retryable===true);
});

test('v2 events are routed to the secondary-circle handler',async()=>{
  const {handler,queries}=harness();
  // With the secondary email flags off, the secondary handler suppresses without querying.
  const result=await handler({eventVersion:2,payload:{schedule_id:'a'.repeat(64),proposal_id:null,schedule_revision:1,
    actor_user_id:1,recipient_user_id:2,kind:'cleared',instant_fingerprint:null,template_version:1}});
  assert.deepEqual(result,{status:'suppressed',reasonCode:'SECONDARY_SCHEDULE_EMAIL_DISABLED'});
  assert.equal(queries.length,0);
});
