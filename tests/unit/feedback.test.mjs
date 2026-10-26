// Product feedback (#353) against a real migrated SQLite database:
// validation, redaction, rate limits, idempotency, /mine pagination,
// retention, the admin notification event, and schema gating.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import {
  FEEDBACK_LIST_MAX_LIMIT,
  FEEDBACK_RATE_LIMITS,
  decodeFeedbackCursor,
  encodeFeedbackCursor,
  ensureFeedbackReadiness,
  feedbackEnabled,
  feedbackNow,
  feedbackSchemaNotInstalled,
  validateFeedbackInput,
} from '../../api/_feedback-config.js';
import {
  FeedbackConflictError,
  FeedbackInputError,
  consumeFeedbackRateLimits,
  listMyFeedback,
  lookupFeedbackReplay,
  submitFeedback,
} from '../../api/_feedback.js';
import {
  FEEDBACK_SUBMITTED_EVENT_TYPE,
  createFeedbackSubmittedEvent,
  createFeedbackSubmittedHandler,
  feedbackNotificationConfiguration,
} from '../../api/_feedback-notification.js';
import { outboxDeliveryPlan } from '../../api/_outbox-delivery.js';
import { OutboxDeliveryError, runOutboxInvocation } from '../../api/_outbox.js';
import { readOutboxDeliveryHealth } from '../../api/_outbox-health.js';
import {
  purgeClosedFeedback,
  runFeedbackRetention,
} from '../../api/_feedback-retention.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const JWT_SECRET='feedback-test-secret-at-least-32-bytes';
const NOW=Math.floor(Date.now()/1000);
const resources=[];
const originalSecret=process.env.JWT_SECRET;
const originalAdmins=process.env.ADMIN_EMAILS;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
  if(originalAdmins===undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS=originalAdmins;
  for(const key of ['FEEDBACK_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','APP_URL','RESEND_API_KEY','RESEND_FROM','NODE_ENV']) delete process.env[key];
});

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-feedback-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return db;
}

async function fixture(){
  const db=await database();
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo) VALUES
      (1,'admin@example.test','hash','Admin','#111111',1,0),
      (2,'member@example.test','hash','Member','#222222',0,0),
      (3,'other@example.test','hash','Other','#333333',0,0),
      (4,'envadmin@example.test','hash','Env Admin','#444444',0,0)`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['admin@example.test'],
    randomUuid:()=>'11111111-1111-4111-8111-111111111111'});
  // initializeLocalPrimaryCircleData already seats every account in the
  // primary circle (owner 1, members 2-4).
  return {db};
}

function validInput(overrides={}){
  return {kind:'feedback',title:'A suggestion',body:'Please add dark mode.',diagnostics:null,
    idempotency_key:'feedback-key-12345678',...overrides};
}

test('flag: feedback needs FEEDBACK_ENABLED and CIRCLE_MEMBERSHIP_ENABLED',()=>{
  assert.equal(feedbackEnabled({}),false);
  assert.equal(feedbackEnabled({FEEDBACK_ENABLED:'true'}),false);
  assert.equal(feedbackEnabled({CIRCLE_MEMBERSHIP_ENABLED:'true'}),false);
  assert.equal(feedbackEnabled({FEEDBACK_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true'}),true);
  assert.equal(feedbackEnabled({FEEDBACK_ENABLED:'yes',CIRCLE_MEMBERSHIP_ENABLED:'true'}),false);
});

test('validation: kinds, sizes, diagnostics gating, idempotency key and unknown fields',()=>{
  assert.equal(validateFeedbackInput(validInput()).ok,true);
  assert.equal(validateFeedbackInput(validInput({kind:'bug',diagnostics:{browser:'Chrome'}})).ok,true);
  assert.equal(validateFeedbackInput(validInput({kind:'feature_request'})).ok,true);
  for(const [body,field] of [
    [null,'form'],
    [[],'form'],
    [validInput({kind:'idea'}),'kind'],
    [validInput({kind:1}),'kind'],
    [validInput({title:''}),'title'],
    [validInput({title:'x'.repeat(121)}),'title'],
    [validInput({title:'a\nb'}),'title'],
    [validInput({title:'a\u202eb'}),'title'],
    [validInput({body:''}),'body'],
    [validInput({body:'x'.repeat(4001)}),'body'],
    [validInput({body:'a\u0007b'}),'body'],
    [validInput({body:'ok',diagnostics:{browser:'Chrome'}}),'diagnostics'],
    [validInput({kind:'bug',diagnostics:['Chrome']}),'diagnostics'],
    [validInput({kind:'bug',diagnostics:{nested:{deep:1}}}),'diagnostics'],
    [validInput({kind:'bug',diagnostics:{field:'x'.repeat(501)}}),'diagnostics'],
    [validInput({kind:'bug',diagnostics:Object.fromEntries(Array.from({length:21},(_,i)=>[`f${i}`,1]))}),'diagnostics'],
    [validInput({idempotency_key:'short'}),'idempotency_key'],
    [validInput({idempotency_key:'x'.repeat(129)}),'idempotency_key'],
    [validInput({idempotency_key:undefined}),'idempotency_key'],
    [validInput({surprise:1}),'form'],
  ]){
    const result=validateFeedbackInput(body);
    assert.equal(result.ok,false,JSON.stringify(body));
    assert.ok(result.fields[field],`${field}: ${JSON.stringify(result.fields)}`);
  }
  // Body newlines and tabs are allowed; diagnostics null is the same as absent.
  assert.equal(validateFeedbackInput(validInput({body:'line one\nline two\tindented'})).ok,true);
  assert.equal(validateFeedbackInput(validInput({diagnostics:undefined})).value.diagnostics,null);
});

test('readiness probe passes on a migrated database and reports the pre-v22 state',async()=>{
  const {db}=await fixture();
  assert.equal(await ensureFeedbackReadiness(db),true);
  const empty=createClient({url:':memory:'});
  resources.push(async()=>{ empty.close(); });
  await assert.rejects(ensureFeedbackReadiness(empty),error=>feedbackSchemaNotInstalled(error));
  assert.equal(feedbackSchemaNotInstalled(new Error('no such table: feedback_items')),true);
  assert.equal(feedbackSchemaNotInstalled(new Error('no such table: other')),false);
});

test('submit: redacts emails, secrets, tokens, JWTs and URLs before storage; diagnostics survive',async()=>{
  const {db}=await fixture();
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({
      kind:'bug',
      title:'Login fails for ada@example.test, api_key=shh-secret',
      body:'Bearer abc.def.ghi and token=abc123, see https://example.com/reset#token=abc — mail me at ada@example.test',
      diagnostics:{browser:'Chrome',version:131,console:'api_key=shh-secret'},
      idempotency_key:'redact-key-12345678',
    })).value,
    adminEmails:[],notify:false});
  assert.equal(submitted.replayed,false);
  assert.equal(submitted.item.title,'Login fails for [email], api_key=[redacted]');
  assert.equal(submitted.item.body,'Bearer [redacted] and token=[redacted], see https://example.com/reset — mail me at [email]');
  assert.equal(submitted.item.diagnostics.browser,'Chrome');
  assert.equal(submitted.item.diagnostics.console,'api_key=[redacted]');
  assert.equal(submitted.item.status,'open');
  assert.equal(submitted.item.visibility,'private');
  assert.equal(submitted.item.vote_count,0);
  const events=await db.execute(`SELECT event_type,actor_user_id FROM feedback_events WHERE feedback_id=?`,[submitted.item.id]);
  assert.deepEqual(events.rows,[{event_type:'feedback.created',actor_user_id:2}]);
  assert.equal(submitted.outboxEvents.length,0);
});

test('submit: one outbox event per admin (db admin + configured admin), none for members',async()=>{
  const {db}=await fixture();
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'admin-notify-key-1'})).value,
    adminEmails:['envadmin@example.test']});
  assert.equal(submitted.outboxEvents.length,2);
  const rows=await db.execute(`SELECT event_type,idempotency_key,payload_json FROM outbox_events ORDER BY id`);
  assert.equal(rows.rows.length,2);
  assert.ok(rows.rows.every(row=>row.event_type===FEEDBACK_SUBMITTED_EVENT_TYPE));
  const payloads=rows.rows.map(row=>JSON.parse(String(row.payload_json)));
  assert.deepEqual(payloads.map(payload=>payload.recipient_user_id).sort(),[1,4]);
  assert.ok(payloads.every(payload=>payload.feedback_id===submitted.item.id
    &&payload.kind==='feedback'&&payload.title==='A suggestion'));
  assert.ok(payloads.every(payload=>!('body' in payload)&&!('diagnostics' in payload)));
  assert.deepEqual(submitted.outboxEvents.map(event=>event.idempotencyKey).sort(),
    rows.rows.map(row=>String(row.idempotency_key)).sort());
});

test('submit: same key and payload replays without a second row or email; same key, different payload conflicts',async()=>{
  const {db}=await fixture();
  const input=validateFeedbackInput(validInput({idempotency_key:'replay-key-12345678'})).value;
  const first=await submitFeedback(db,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false});
  const replay=await submitFeedback(db,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false});
  assert.equal(replay.replayed,true);
  assert.equal(replay.item.id,first.item.id);
  assert.equal(replay.outboxEvents.length,0);
  const other=validateFeedbackInput(validInput({idempotency_key:'replay-key-12345678',title:'Different title'})).value;
  await assert.rejects(submitFeedback(db,{circleId:1,authorUserId:2,input:other,adminEmails:[],notify:false}),
    error=>error instanceof FeedbackConflictError);
  assert.equal((await db.execute(`SELECT COUNT(*) AS c FROM feedback_items`)).rows[0].c,1);
  // A different member may reuse the same key: idempotency is per author.
  const third=await submitFeedback(db,{circleId:1,authorUserId:3,input,adminEmails:[],notify:false});
  assert.equal(third.replayed,false);
  assert.notEqual(third.item.id,first.item.id);
});

test('submit: the insert fails closed on a missing circle',async()=>{
  const {db}=await fixture();
  await assert.rejects(submitFeedback(db,{circleId:99,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'bad-circle-key-1'})).value,
    adminEmails:[],notify:false}),/FOREIGN KEY|constraint/i);
});

test('rate limits: 10/hour and 30/day per user and per IP; the first exhausted dimension stops',async()=>{
  const {db}=await fixture();
  process.env.JWT_SECRET=JWT_SECRET;
  const at=1000*3600;
  for(let n=0;n<10;n+=1){
    const result=await consumeFeedbackRateLimits(db,{userId:2,ip:'203.0.113.7',nowSeconds:at+n});
    assert.equal(result.allowed,true);
  }
  const hour=await consumeFeedbackRateLimits(db,{userId:2,ip:'203.0.113.7',nowSeconds:at+10});
  assert.deepEqual({allowed:hour.allowed,dimension:hour.dimension},{allowed:false,dimension:'user-hour'});
  assert.ok(hour.retryAfter>0);
  // A different user on the same IP is blocked by the per-IP hour limit,
  // and the per-IP counter did not advance past the block (the next call
  // from a fresh IP is still allowed).
  const ipBlocked=await consumeFeedbackRateLimits(db,{userId:3,ip:'203.0.113.7',nowSeconds:at+11});
  assert.equal(ipBlocked.allowed,false);
  assert.equal(ipBlocked.dimension,'ip-hour');
  const fresh=await consumeFeedbackRateLimits(db,{userId:3,ip:'198.51.100.9',nowSeconds:at+11});
  assert.equal(fresh.allowed,true);
  // Day limit: 30 submissions across three hours from a fresh user/IP,
  // then the 31st is blocked by the day dimension (not the hour one).
  for(let hour2=0;hour2<4;hour2+=1){
    for(let n=0;n<10;n+=1){
      const result=await consumeFeedbackRateLimits(db,{userId:4,ip:'192.0.2.55',nowSeconds:at+3600*hour2+n});
      if(hour2<3) assert.equal(result.allowed,true);
      else{
        assert.equal(result.allowed,false,'day limit blocks in the fourth hour');
        assert.equal(result.dimension,'user-day');
      }
    }
  }
  assert.equal(FEEDBACK_RATE_LIMITS.userHour.limit,10);
  assert.equal(FEEDBACK_RATE_LIMITS.userDay.limit,30);
  assert.equal(FEEDBACK_RATE_LIMITS.ipHour.limit,10);
  assert.equal(FEEDBACK_RATE_LIMITS.ipDay.limit,30);
});

test('list: newest first, only the caller\u2019s own items, cursor pagination',async()=>{
  const {db}=await fixture();
  const ids=[];
  for(let n=0;n<3;n+=1){
    const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
      input:validateFeedbackInput(validInput({idempotency_key:`list-key-${n}-12345678`,title:`Item ${n}`})).value,
      adminEmails:[],notify:false,nowSeconds:NOW+n});
    ids.push(submitted.item.id);
  }
  await submitFeedback(db,{circleId:1,authorUserId:3,
    input:validateFeedbackInput(validInput({idempotency_key:'list-other-12345678'})).value,
    adminEmails:[],notify:false,nowSeconds:NOW+99});
  const first=await listMyFeedback(db,{authorUserId:2,limit:2});
  assert.deepEqual(first.items.map(item=>item.title),['Item 2','Item 1']);
  assert.ok(first.nextCursor);
  assert.deepEqual(decodeFeedbackCursor(first.nextCursor),{createdAt:NOW+1,id:ids[1]});
  const second=await listMyFeedback(db,{authorUserId:2,limit:2,cursor:first.nextCursor});
  assert.deepEqual(second.items.map(item=>item.title),['Item 0']);
  assert.equal(second.nextCursor,null);
  assert.equal((await listMyFeedback(db,{authorUserId:3})).items.length,1);
  assert.equal((await listMyFeedback(db,{authorUserId:99})).items.length,0);
  await assert.rejects(listMyFeedback(db,{authorUserId:2,limit:0}),TypeError);
  await assert.rejects(listMyFeedback(db,{authorUserId:2,limit:FEEDBACK_LIST_MAX_LIMIT+1}),TypeError);
  await assert.rejects(listMyFeedback(db,{authorUserId:2,cursor:'not-a-cursor!!'}),/invalid cursor/);
  assert.equal(encodeFeedbackCursor(123,'00000000-0000-4000-8000-000000000001'),
    Buffer.from('123.00000000-0000-4000-8000-000000000001','utf8').toString('base64url'));
});

test('retention: only closed items older than 12 months are purged, with their votes and events',async()=>{
  const {db}=await fixture();
  const keepOpen=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'ret-open-12345678'})).value,
    adminEmails:[],notify:false,nowSeconds:NOW-400*86400});
  const keepRecent=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'ret-recent-12345678'})).value,
    adminEmails:[],notify:false,nowSeconds:NOW-400*86400});
  const purge=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'ret-purge-12345678'})).value,
    adminEmails:[],notify:false,nowSeconds:NOW-400*86400});
  // Age the rows, then close two of them at different times.
  await db.execute({sql:`UPDATE feedback_items SET created_at=?,updated_at=? WHERE id IN (?,?,?)`,
    args:[NOW-400*86400,NOW-400*86400,keepOpen.item.id,keepRecent.item.id,purge.item.id]});
  await db.execute({sql:`UPDATE feedback_items SET status='closed',closed_at=? WHERE id=?`,
    args:[NOW-10*86400,keepRecent.item.id]});
  await db.execute({sql:`UPDATE feedback_items SET status='closed',closed_at=? WHERE id=?`,
    args:[NOW-400*86400,purge.item.id]});
  await db.execute({sql:`INSERT INTO feedback_votes (feedback_id,user_id,value,created_at) VALUES (?,?,1,?)`,
    args:[purge.item.id,3,NOW-400*86400]});
  const result=await purgeClosedFeedback(db,{nowSeconds:NOW});
  assert.deepEqual(result,{deleted:1,more:false});
  const remaining=await db.execute(`SELECT id FROM feedback_items ORDER BY id`);
  assert.deepEqual(remaining.rows.map(row=>row.id).sort(),[keepOpen.item.id,keepRecent.item.id].sort());
  assert.equal((await db.execute(`SELECT COUNT(*) AS c FROM feedback_votes`)).rows[0].c,0);
  assert.equal((await db.execute(`SELECT COUNT(*) AS c FROM feedback_events WHERE feedback_id=?`,[purge.item.id])).rows[0].c,0);
  // A second sweep finds nothing; batching stops at the cap.
  assert.deepEqual(await runFeedbackRetention(db,{nowSeconds:NOW}),{deleted:0,batches:1,more:false});
  await assert.rejects(purgeClosedFeedback(db,{limit:0}),TypeError);
  await assert.rejects(runFeedbackRetention(db,{maxBatches:0}),TypeError);
});

test('notification: configuration, event construction, and idempotency key shape',()=>{
  assert.equal(feedbackNotificationConfiguration({env:{}}),null);
  assert.equal(feedbackNotificationConfiguration({env:{FEEDBACK_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true'}}),null);
  assert.deepEqual(feedbackNotificationConfiguration({localRuntime:true,env:{FEEDBACK_ENABLED:'true',
    CIRCLE_MEMBERSHIP_ENABLED:'true',NODE_ENV:'development',APP_URL:'http://localhost:3000/'}}),
  {origin:'http://localhost:3000',localRuntime:true});
  const statement=createFeedbackSubmittedEvent({feedbackId:'00000000-0000-4000-8000-000000000001',
    circleId:1,authorUserId:2,recipientUserId:1,kind:'bug',title:'Login fails'});
  assert.match(statement.sql,/INSERT INTO outbox_events/);
  assert.ok(statement.args.includes('feedback-submitted/v1/00000000-0000-4000-8000-000000000001/1'));
  assert.throws(()=>createFeedbackSubmittedEvent({feedbackId:'nope',circleId:1,authorUserId:2,
    recipientUserId:1,kind:'bug',title:'x'}),TypeError);
  assert.throws(()=>createFeedbackSubmittedEvent({feedbackId:'00000000-0000-4000-8000-000000000001',
    circleId:1,authorUserId:2,recipientUserId:1,kind:'idea',title:'x'}),TypeError);
});

test('notification handler: delivers kind + title + link, never the body',async()=>{
  const {db}=await fixture();
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.ADMIN_EMAILS='';
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({kind:'feature_request',idempotency_key:'notify-key-12345678'})).value,
    adminEmails:[],notify:false});
  const sent=[];
  const handler=createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',
    send:async(message)=>{ sent.push(message); return {providerName:'test'}; }});
  const event={eventVersion:1,idempotencyKey:'feedback-submitted/v1/x/1',payload:{
    feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feature_request',title:'A suggestion',template_version:1}};
  const outcome=await handler(event,{});
  assert.deepEqual(outcome,{status:'delivered',providerName:'test',providerMessageId:null});
  assert.equal(sent.length,1);
  assert.equal(sent[0].to,'admin@example.test');
  assert.match(sent[0].subject,/feature request/);
  assert.match(sent[0].subject,/A suggestion/);
  assert.match(sent[0].html,new RegExp(`https://randoricircle\\.com/\\?view=feedback&amp;id=${submitted.item.id}`));
  assert.ok(!sent[0].html.includes('Please add dark mode'));
});

test('notification handler: suppresses when the item, admin status, or email preference is gone',async()=>{
  const {db}=await fixture();
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'suppress-key-12345678'})).value,
    adminEmails:[],notify:false});
  const eventFor=(recipient)=>({eventVersion:1,idempotencyKey:'k',payload:{
    feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:recipient,
    kind:'feedback',title:'A suggestion',template_version:1}});
  const handler=(sent)=>createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',
    send:async(message)=>{ sent.push(message); return {providerName:'test'}; }});
  // Non-admin recipient.
  assert.deepEqual(await handler([])(eventFor(2),{}),{status:'suppressed',reasonCode:'FEEDBACK_RECIPIENT_NOT_ADMIN'});
  // Admin with email notifications switched off.
  await db.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (1,0)`);
  assert.deepEqual(await handler([])(eventFor(1),{}),{status:'suppressed',reasonCode:'NOTIFICATIONS_DISABLED'});
  await db.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=1`);
  // Item deleted (account deletion / retention) before delivery.
  await db.execute(`DELETE FROM feedback_items WHERE id=?`,[submitted.item.id]);
  assert.deepEqual(await handler([])(eventFor(1),{}),{status:'suppressed',reasonCode:'FEEDBACK_RECIPIENT_OR_ITEM_GONE'});
  // Bad version and bad payload fail closed as delivery errors.
  await assert.rejects(handler([])({eventVersion:2,idempotencyKey:'k',payload:eventFor(1).payload},{}),
    /Outbox delivery failed/);
  await assert.rejects(handler([])({eventVersion:1,idempotencyKey:'k',payload:{...eventFor(1).payload,extra:1}},{}),
    /Outbox delivery failed/);
});

test('notification handler: flag off suppresses with FEEDBACK_DISABLED without sending',async()=>{
  const {db}=await fixture();
  delete process.env.FEEDBACK_ENABLED;
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'flagoff-key-12345678'})).value,
    adminEmails:[],notify:false});
  const sent=[];
  const handler=createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',
    send:async(message)=>{ sent.push(message); return {providerName:'test'}; }});
  const outcome=await handler({eventVersion:1,idempotencyKey:'k',payload:{
    feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feedback',title:'A suggestion',template_version:1}},{});
  assert.deepEqual(outcome,{status:'suppressed',reasonCode:'FEEDBACK_DISABLED'});
  assert.equal(sent.length,0);
});

test('outbox drain: a flag-off queued row drains to suppressed, never delivery_stale',async()=>{
  const {db}=await fixture();
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'drain-key-12345678'})).value,
    adminEmails:[],notify:true});
  assert.equal(submitted.outboxEvents.length,1);
  delete process.env.FEEDBACK_ENABLED;
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  process.env.RESEND_API_KEY='re_test_key';
  process.env.RESEND_FROM='Randori <noreply@example.test>';
  try{
    const plan=await outboxDeliveryPlan(db,'https://randoricircle.com',{});
    assert.equal(plan.handlers.has(FEEDBACK_SUBMITTED_EVENT_TYPE),true);
    await runOutboxInvocation({db,handlers:plan.handlers,eventTypes:[FEEDBACK_SUBMITTED_EVENT_TYPE]});
    const rows=await db.execute(`SELECT status FROM outbox_events WHERE event_type=?`,
      [FEEDBACK_SUBMITTED_EVENT_TYPE]);
    assert.deepEqual(rows.rows.map(row=>row.status),['suppressed']);
    const health=await readOutboxDeliveryHealth(db);
    assert.equal(health.dueCount,0);
    assert.equal(health.oldestDueAgeMs,null);
  }finally{
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
  }
});

test('validation: diagnostics keys that are emails, IPs, JWTs or tokens are rejected',()=>{
  for(const key of ['user@example.test','192.168.1.1',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature','tok_live_example_1234567890abcdef','a'.repeat(40),
    'sk_live_abc','sk_test_abc','ghp_abcdef','gho_abcdef','github_pat_abcdef','xoxb-12345']){
    const result=validateFeedbackInput(validInput({kind:'bug',diagnostics:{[key]:'Chrome'}}));
    assert.equal(result.ok,false,key);
    assert.ok(result.fields.diagnostics,key);
  }
  assert.equal(validateFeedbackInput(validInput({kind:'bug',
    diagnostics:{browser:'Chrome','os.version':'macOS'}})).ok,true);
});

test('submit: an unsafe diagnostics key is collapsed to [redacted], never stored verbatim',async()=>{
  const {db}=await fixture();
  const value={...validateFeedbackInput(validInput({kind:'bug'})).value,
    diagnostics:{'user@example.test':'x','192.168.0.1':'y','tok_live_example_1234567890abcdef':'z',browser:'Chrome'}};
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,input:value,adminEmails:[],notify:false});
  const stored=await db.execute(`SELECT diagnostics_json FROM feedback_items WHERE id=?`,[submitted.item.id]);
  const diagnostics=JSON.parse(stored.rows[0].diagnostics_json);
  assert.ok(!Object.keys(diagnostics).some(key=>key.includes('@')||key.includes('192.168')||key.includes('tok_live_example')));
  assert.equal(diagnostics['[redacted]'],'z');
  assert.equal(diagnostics.browser,'Chrome');
});

test('submit: diagnostics too large after redaction fail closed',async()=>{
  const {db}=await fixture();
  const big=Object.fromEntries(Array.from({length:20},(_,i)=>[`field${i}`,'x'.repeat(300)]));
  await assert.rejects(submitFeedback(db,{circleId:1,authorUserId:2,
    input:{kind:'bug',title:'Too big',body:'Body',diagnostics:big,idempotencyKey:'too-big-key-12345678'},
    adminEmails:[],notify:false}),/diagnostics are too large after redaction/);
});

test('submit: a unique-constraint race re-reads and replays instead of 503',async()=>{
  const {db}=await fixture();
  const input=validateFeedbackInput(validInput({idempotency_key:'race-key-12345678'})).value;
  const first=await submitFeedback(db,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false});
  assert.equal(first.replayed,false);
  // Racing transaction: its snapshot predates the winner's commit, so its
  // SELECT sees nothing and its INSERT hits the unique index.
  const racingDb={execute:(...args)=>db.execute(...args),
    transaction:async()=>{
      const transaction=await db.transaction('write');
      const realExecute=transaction.execute.bind(transaction);
      transaction.execute=async(statement)=>{
        const sql=typeof statement==='string'?statement:statement?.sql||'';
        if(sql.includes('FROM feedback_items WHERE author_user_id=? AND idempotency_key=?')){
          return {rows:[]};
        }
        if(sql.includes('INSERT INTO feedback_items')){
          const error=new Error('UNIQUE constraint failed: feedback_items.author_user_id, feedback_items.idempotency_key');
          error.code='SQLITE_CONSTRAINT_UNIQUE';
          throw error;
        }
        return realExecute(statement);
      };
      return transaction;
    }};
  const raced=await submitFeedback(racingDb,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false});
  assert.equal(raced.replayed,true);
  assert.equal(raced.item.id,first.item.id);
  const other={...input,title:'Different title'};
  await assert.rejects(submitFeedback(racingDb,{circleId:1,authorUserId:2,input:other,
    adminEmails:[],notify:false}),FeedbackConflictError);
});

test('replay lookup: exact replay answers without the limiter; conflict is 409',async()=>{
  const {db}=await fixture();
  const input=validateFeedbackInput(validInput({idempotency_key:'lookup-key-12345678'})).value;
  assert.equal(await lookupFeedbackReplay(db,{circleId:1,authorUserId:2,input}),null);
  const first=await submitFeedback(db,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false});
  const replay=await lookupFeedbackReplay(db,{circleId:1,authorUserId:2,input});
  assert.equal(replay.replayed,true);
  assert.equal(replay.item.id,first.item.id);
  const other={...input,title:'Different title'};
  await assert.rejects(lookupFeedbackReplay(db,{circleId:1,authorUserId:2,input:other}),FeedbackConflictError);
});

test('/mine: filters by the active circle, not just the author',async()=>{
  const {db}=await fixture();
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at)
    VALUES (2,'circle-two','two','Circle Two',0,1,NULL)`);
  const first=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'mine-c1-12345678'})).value,
    adminEmails:[],notify:false});
  const second=await submitFeedback(db,{circleId:2,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'mine-c2-12345678'})).value,
    adminEmails:[],notify:false});
  assert.deepEqual((await listMyFeedback(db,{authorUserId:2,circleId:1})).items.map(item=>item.id),
    [first.item.id]);
  assert.deepEqual((await listMyFeedback(db,{authorUserId:2,circleId:2})).items.map(item=>item.id),
    [second.item.id]);
  assert.deepEqual((await listMyFeedback(db,{authorUserId:2})).items.map(item=>item.id).sort(),
    [first.item.id,second.item.id].sort());
});

test('notification handler: provider failures classify retryable by status',async()=>{
  const {db}=await fixture();
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'provider-key-12345678'})).value,
    adminEmails:[],notify:false});
  const event={eventVersion:1,idempotencyKey:'k',payload:{
    feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feedback',title:'A suggestion',template_version:1}};
  const handlerFor=(send)=>createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',send});
  for(const [status,retryable,code] of [[429,true,'PROVIDER_RATE_LIMITED'],[400,false,'PROVIDER_REJECTED'],
    [500,true,'PROVIDER_FAILED'],[undefined,true,'PROVIDER_FAILED']]){
    const send=async()=>{ const error=new Error('provider down'); if(status!==undefined) error.statusCode=status; throw error; };
    await assert.rejects(handlerFor(send)(event,{}),error=>{
      assert.equal(error.code,code);
      assert.equal(error.retryable,retryable);
      return true;
    });
  }
  // A delivery result carrying an error takes the same path.
  await assert.rejects(handlerFor(async()=>({error:Object.assign(new Error('rejected'),{statusCode:403}) }))(event,{}),
    error=>error.code==='PROVIDER_REJECTED'&&error.retryable===false);
  // An OutboxDeliveryError from the provider passes through unchanged.
  const passthrough=new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false});
  await assert.rejects(handlerFor(async()=>{ throw passthrough; })(event,{}),
    error=>error===passthrough);
});

test('list: a malformed stored row fails closed, and a storage failure propagates',async()=>{
  const malformed={execute:async()=>({rows:[{id:null}]})};
  await assert.rejects(listMyFeedback(malformed,{authorUserId:2}),FeedbackInputError);
  assert.deepEqual(await listMyFeedback({execute:async()=>({rows:[]})},{authorUserId:2}),{items:[],nextCursor:null});
  const failing={execute:async()=>{ throw new Error('list storage down'); }};
  await assert.rejects(listMyFeedback(failing,{authorUserId:2}),/list storage down/);
  await assert.rejects(listMyFeedback({execute:async()=>({rows:[]})},{authorUserId:2,circleId:0}),TypeError);
  await assert.rejects(lookupFeedbackReplay(null,{circleId:1,authorUserId:2,input:{}}),TypeError);
});

test('rate limits: an invalid counter state fails closed',async()=>{
  process.env.JWT_SECRET=JWT_SECRET;
  const db={execute:async()=>({rows:[{attempts:0}]})};
  await assert.rejects(consumeFeedbackRateLimits(db,{userId:2}),/invalid rate limit state/);
});

test('validation: non-string title/body, and a 65-char diagnostics key are rejected',()=>{
  for(const [body,field] of [
    [validInput({title:1}),'title'],
    [validInput({body:1}),'body'],
    [validInput({kind:'bug',diagnostics:{['a'.repeat(65)]:'x'}}),'diagnostics'],
    [validInput({kind:'bug',diagnostics:{'a.b_c-d':'x'}}),'ok'],
  ]){
    const result=validateFeedbackInput(body);
    if(field==='ok') assert.equal(result.ok,true,JSON.stringify(body));
    else{ assert.equal(result.ok,false,JSON.stringify(body)); assert.ok(result.fields[field]); }
  }
});

test('readiness: the cached probe is reused',async()=>{
  const {db}=await fixture();
  assert.equal(await ensureFeedbackReadiness(db),true);
  assert.equal(await ensureFeedbackReadiness(db),true);
});

test('submit and replay lookup: invalid arguments fail closed',async()=>{
  const {db}=await fixture();
  const input=validateFeedbackInput(validInput()).value;
  await assert.rejects(lookupFeedbackReplay(db,{circleId:0,authorUserId:2,input}),TypeError);
  await assert.rejects(lookupFeedbackReplay(db,{circleId:1,authorUserId:2,input:null}),TypeError);
  await assert.rejects(submitFeedback(db,{circleId:0,authorUserId:2,input}),TypeError);
  await assert.rejects(submitFeedback(db,{circleId:1,authorUserId:2,input:null}),TypeError);
});

test('notification: configuration origins and handler construction guards',()=>{
  assert.throws(()=>createFeedbackSubmittedHandler({}),TypeError);
  assert.throws(()=>createFeedbackSubmittedHandler({db:{execute:async()=>({})},baseUrl:'https://randoricircle.com',
    send:null}),TypeError);
  assert.throws(()=>createFeedbackSubmittedHandler({db:{execute:async()=>({})},baseUrl:'not a url',
    send:async()=>({})}),TypeError);
  assert.throws(()=>createFeedbackSubmittedHandler({db:{execute:async()=>({})},baseUrl:'http://randoricircle.com',
    send:async()=>({})}),TypeError);
  assert.deepEqual(feedbackNotificationConfiguration({env:{FEEDBACK_ENABLED:'true',
    CIRCLE_MEMBERSHIP_ENABLED:'true',NODE_ENV:'production',APP_URL:'https://randoricircle.com/',
    RESEND_API_KEY:'re_x',RESEND_FROM:'Randori <noreply@example.test>'}}),
  {origin:'https://randoricircle.com',localRuntime:false});
  assert.equal(feedbackNotificationConfiguration({env:{FEEDBACK_ENABLED:'true',
    CIRCLE_MEMBERSHIP_ENABLED:'true',NODE_ENV:'production',APP_URL:'http://randoricircle.com/',
    RESEND_API_KEY:'re_x',RESEND_FROM:'Randori <noreply@example.test>'}}),null);
  assert.equal(feedbackNotificationConfiguration({localRuntime:true,env:{FEEDBACK_ENABLED:'true',
    CIRCLE_MEMBERSHIP_ENABLED:'true',NODE_ENV:'production',APP_URL:'http://localhost:3000/',
    RESEND_API_KEY:'re_x',RESEND_FROM:'Randori <noreply@example.test>'}}),null);
});

test('notification handler: invalid payloads and an invalid recipient email fail closed',async()=>{
  const {db}=await fixture();
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'payload-key-12345678'})).value,
    adminEmails:[],notify:false});
  const base={feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feedback',title:'A suggestion',template_version:1};
  const handler=createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',
    send:async()=>({providerName:'test'})});
  const variants=[
    {...base,feedback_id:'nope'},
    {...base,circle_id:0},
    {...base,author_user_id:0},
    {...base,recipient_user_id:0},
    {...base,kind:'idea'},
    {...base,title:''},
    {...base,title:'x'.repeat(121)},
    {...base,template_version:2},
    (({title,...rest})=>rest)(base),
    {...base,extra:1},
  ];
  for(const payload of variants){
    await assert.rejects(handler({eventVersion:1,idempotencyKey:'k',payload},{}),/Outbox delivery failed/);
  }
  await db.execute(`UPDATE auth_accounts SET email='not-an-email' WHERE id=1`);
  assert.deepEqual(await handler({eventVersion:1,idempotencyKey:'k',payload:base},{}),
    {status:'suppressed',reasonCode:'RECIPIENT_EMAIL_INVALID'});
});

test('notification handler: provider status is read from every error shape',async()=>{
  const {db}=await fixture();
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const submitted=await submitFeedback(db,{circleId:1,authorUserId:2,
    input:validateFeedbackInput(validInput({idempotency_key:'status-shape-12345678'})).value,
    adminEmails:[],notify:false});
  const event={eventVersion:1,idempotencyKey:'k',payload:{
    feedback_id:submitted.item.id,circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feedback',title:'A suggestion',template_version:1}};
  const cases=[
    [Object.assign(new Error('x'),{status:429}),'PROVIDER_RATE_LIMITED',true],
    [Object.assign(new Error('x'),{response:{status:503}}),'PROVIDER_FAILED',true],
    [Object.assign(new Error('x'),{error:{statusCode:400}}),'PROVIDER_REJECTED',false],
  ];
  for(const [thrown,code,retryable] of cases){
    const handler=createFeedbackSubmittedHandler({db,baseUrl:'https://randoricircle.com',
      send:async()=>{ throw thrown; }});
    await assert.rejects(handler(event,{}),error=>error.code===code&&error.retryable===retryable);
  }
});

test('retention: invalid arguments fail closed',async()=>{
  await assert.rejects(purgeClosedFeedback(null),TypeError);
  await assert.rejects(runFeedbackRetention(null),TypeError);
});

test('time and cursor: invalid overrides, unavailable database time, and malformed cursors fail closed',async()=>{
  const {db}=await fixture();
  assert.equal(await feedbackNow(db,123),123);
  await assert.rejects(feedbackNow(db,0),TypeError);
  await assert.rejects(feedbackNow(db,1.5),TypeError);
  assert.ok(Number.isSafeInteger(await feedbackNow(db))&&(await feedbackNow(db))>0);
  await assert.rejects(feedbackNow({execute:async()=>({rows:[{now_seconds:0}]})}),/database time unavailable/);
  assert.equal(decodeFeedbackCursor(undefined),null);
  assert.equal(decodeFeedbackCursor(''),null);
  assert.equal(decodeFeedbackCursor('a'.repeat(129)),false);
  assert.equal(decodeFeedbackCursor(Buffer.from('nope','utf8').toString('base64url')),false);
  assert.equal(decodeFeedbackCursor(Buffer.from('123.not-a-uuid','utf8').toString('base64url')),false);
  assert.equal(decodeFeedbackCursor(Buffer.from(`${'9'.repeat(17)}.00000000-0000-4000-8000-000000000001`,'utf8').toString('base64url')),false);
  assert.deepEqual(decodeFeedbackCursor(encodeFeedbackCursor(123,'00000000-0000-4000-8000-000000000001')),
    {createdAt:123,id:'00000000-0000-4000-8000-000000000001'});
});

test('list: stored diagnostics that parse to a non-object fail closed',async()=>{
  const bad={execute:async()=>({rows:[{id:'00000000-0000-4000-8000-000000000001',circle_id:1,
    author_user_id:2,kind:'feedback',title:'t',body:'b',status:'open',visibility:'private',
    diagnostics_json:'123',created_at:100,updated_at:100,closed_at:null,vote_count:0}]})};
  await assert.rejects(listMyFeedback(bad,{authorUserId:2}),FeedbackInputError);
});

test('notification handler: control-char title falls back, and the provider id falls back to data.id',async()=>{
  process.env.FEEDBACK_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const fakeDb={execute:async()=>({rows:[{item_kind:'bogus',item_title:'',
    email:'admin@example.test',is_admin:1,email_enabled:1}]})};
  const handler=createFeedbackSubmittedHandler({db:fakeDb,baseUrl:'https://randoricircle.com',
    send:async(message)=>{ assert.equal(message.subject,'New feedback: New feedback'); return {providerName:'test',data:{id:'msg-1'}}; }});
  assert.deepEqual(await handler({eventVersion:1,idempotencyKey:'k',payload:{
    feedback_id:'00000000-0000-4000-8000-000000000001',circle_id:1,author_user_id:2,recipient_user_id:1,
    kind:'feedback',title:'A suggestion',template_version:1}},{}),
  {status:'delivered',providerName:'test',providerMessageId:'msg-1'});
});

test('list: a missing rows array reads as an empty page',async()=>{
  assert.deepEqual(await listMyFeedback({execute:async()=>({})},{authorUserId:2}),{items:[],nextCursor:null});
});

test('submit: a unique-constraint failure with no row to re-read rethrows the original error',async()=>{
  const {db}=await fixture();
  const input=validateFeedbackInput(validInput({idempotency_key:'race-norow-12345678'})).value;
  const racingDb={execute:async(statement,...rest)=>{
    const sql=typeof statement==='string'?statement:statement?.sql||'';
    if(sql.includes('FROM feedback_items WHERE author_user_id=? AND idempotency_key=?')) return {rows:[]};
    return db.execute(statement,...rest);
  },
  transaction:async()=>{
    const transaction=await db.transaction('write');
    const realExecute=transaction.execute.bind(transaction);
    transaction.execute=async(statement,...rest)=>{
      const sql=typeof statement==='string'?statement:statement?.sql||'';
      if(sql.includes('INSERT INTO feedback_items')){
        const error=new Error('UNIQUE constraint failed: feedback_items.author_user_id, feedback_items.idempotency_key');
        error.code='SQLITE_CONSTRAINT_UNIQUE';
        throw error;
      }
      return realExecute(statement,...rest);
    };
    return transaction;
  }};
  await assert.rejects(submitFeedback(racingDb,{circleId:1,authorUserId:2,input,adminEmails:[],notify:false}),
    /UNIQUE constraint failed/);
});
