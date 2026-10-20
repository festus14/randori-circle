// Pairing email outbox handler: payload contracts, suppression of revoked or
// changed recipients, secondary-publication integrity checks, provider error
// classification, and the legacy-row bridge into the durable worker.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  classifyPairingProviderError,
  createPairingEmailHandler,
  createResendEmailSender,
  deliverPairingEmails,
  migrateLegacyPairingEmails,
  PAIRING_EMAIL_EVENT_TYPE,
  PAIRING_EMAIL_EVENT_VERSION,
  SECONDARY_PAIRING_EMAIL_EVENT_VERSION,
} from '../../api/_pairing-email.js';
import { OutboxDeliveryError } from '../../api/_outbox.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const BASE_URL='https://randori.example.test/ignored/path';
const FLAGS=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED'];
const saved={};

beforeEach(()=>{
  for(const flag of FLAGS){ saved[flag]=process.env[flag]; process.env[flag]='true'; }
});
afterEach(()=>{
  for(const flag of FLAGS){
    if(saved[flag]===undefined) delete process.env[flag]; else process.env[flag]=saved[flag];
  }
});

function sqlOf(statement){ return typeof statement==='string'?statement:String(statement?.sql||''); }

function primaryDb(overrides={}){
  const calls=[];
  return {
    calls,
    async execute(statement){
      const sql=sqlOf(statement);
      calls.push(sql);
      if(sql.includes('SELECT email,is_demo FROM auth_accounts')) return overrides.localAccount?.()??{rows:[{email:'ada@example.test',is_demo:0}]};
      if(sql.includes('account.email,account.is_demo,membership.circle_id')) return overrides.account?.()??{rows:[{email:' ADA@example.test ',is_demo:0,circle_id:1}]};
      if(sql.includes('user_notification_prefs')) return overrides.prefs?.()??{rows:[]};
      if(sql.includes('week_label FROM pairing_weeks')) return overrides.week?.()??{rows:[{week_label:'2026-W39'}]};
      if(sql.includes('FROM pairing_groups')) return overrides.group?.()??{rows:[{id:9,user_a_id:1,user_b_id:2,is_ai_pair:0}]};
      if(sql.includes('display_name AS name')) return overrides.name?.(statement)??{rows:[{name:'Grace <Hopper>'}]};
      throw new Error(`unexpected SQL ${sql.slice(0,50)}`);
    },
  };
}

function primaryEvent(payload={}){
  return {
    eventVersion:PAIRING_EMAIL_EVENT_VERSION,idempotencyKey:'randori/3/paired/1',
    payload:{week_id:3,user_id:1,kind:'paired',recipient_email:'ada@example.test',...payload},
  };
}

function recordingSend(result={providerName:'test',providerMessageId:'m-1'}){
  const messages=[];
  const send=async message=>{ messages.push(message); return typeof result==='function'?result(message):result; };
  send.messages=messages;
  return send;
}

async function rejectsDelivery(promise,code,retryable){
  await assert.rejects(promise,error=>{
    assert.ok(error instanceof OutboxDeliveryError,String(error));
    assert.equal(error.code,code);
    if(retryable!==undefined) assert.equal(error.retryable,retryable);
    return true;
  });
}

test('handler construction validates the database, provider, runtime, and base URL',()=>{
  const send=recordingSend();
  assert.throws(()=>createPairingEmailHandler(),TypeError);
  assert.throws(()=>createPairingEmailHandler({db:{},send,baseUrl:BASE_URL}),TypeError);
  assert.throws(()=>createPairingEmailHandler({db:primaryDb(),baseUrl:BASE_URL}),TypeError);
  assert.throws(()=>createPairingEmailHandler({db:primaryDb(),send,baseUrl:BASE_URL,localRuntime:'yes'}),/runtime/);
  assert.throws(()=>createPairingEmailHandler({db:primaryDb(),send,baseUrl:'not a url'}),/base URL/);
  assert.equal(typeof createPairingEmailHandler({db:primaryDb(),send,baseUrl:BASE_URL}),'function');
});

test('a primary paired email names the partner, escapes HTML, and links only to the origin',async()=>{
  const send=recordingSend({data:{id:'resend-1'}});
  const handler=createPairingEmailHandler({db:primaryDb(),send,baseUrl:BASE_URL});
  const result=await handler(primaryEvent(),{signal:'sig'});
  assert.deepEqual(result,{status:'delivered',providerName:'email',providerMessageId:'resend-1'});
  const [message]=send.messages;
  assert.equal(message.to,'ada@example.test');
  assert.equal(message.subject,'Randori 2026-W39 — your pairing is ready');
  assert.match(message.html,/Grace &lt;Hopper&gt;/);
  assert.match(message.html,/href="https:\/\/randori\.example\.test\/join\//);
  assert.doesNotMatch(message.html,/ignored\/path/);
  assert.equal(message.signal,'sig');
  assert.equal(message.idempotencyKey,'randori/3/paired/1');
});

test('primary emails cover member B, solo practice, missing names, and the unavailable notice',async()=>{
  let partnerArgs;
  const send=recordingSend({});
  const asB=createPairingEmailHandler({db:primaryDb({
    account:()=>({rows:[{email:'bob@example.test',is_demo:0}]}),
    group:()=>({rows:[{id:9,user_a_id:1,user_b_id:2,is_ai_pair:0}]}),
    name:statement=>{ partnerArgs=statement.args; return {rows:[]}; },
  }),send,baseUrl:BASE_URL});
  const delivered=await asB(primaryEvent({user_id:2,recipient_email:'bob@example.test'}));
  assert.deepEqual(partnerArgs,[1]);
  assert.match(send.messages[0].html,/your partner/);
  assert.deepEqual(delivered,{status:'delivered',providerName:'email',providerMessageId:null});

  const solo=createPairingEmailHandler({db:primaryDb({group:()=>({rows:[{id:4,user_a_id:1,user_b_id:1,is_ai_pair:1}]})}),send,baseUrl:BASE_URL});
  await solo(primaryEvent());
  assert.match(send.messages[1].html,/Solo practice/);

  const away=createPairingEmailHandler({db:primaryDb({week:()=>({rows:[{week_label:'<W39>'}]})}),send,baseUrl:BASE_URL});
  await away(primaryEvent({kind:'unavailable'}));
  assert.equal(send.messages[2].subject,'You missed Randori <W39> — toggle back to available');
  assert.match(send.messages[2].html,/&lt;W39&gt;/);
});

test('primary emails are suppressed for revoked, demo, changed, or opted-out recipients',async()=>{
  const send=recordingSend();
  const run=(db,options={})=>createPairingEmailHandler({db,send,baseUrl:BASE_URL,...options})(primaryEvent());
  assert.deepEqual(await run(primaryDb({account:()=>({rows:[]})})),{status:'suppressed',reasonCode:'MEMBERSHIP_REVOKED'});
  assert.deepEqual(await run(primaryDb({account:()=>({})})),{status:'suppressed',reasonCode:'MEMBERSHIP_REVOKED'});
  assert.deepEqual(await run(primaryDb({localAccount:()=>({rows:[{},{}]})}),{localRuntime:true}),
    {status:'suppressed',reasonCode:'RECIPIENT_MISSING'});
  assert.deepEqual(await run(primaryDb({account:()=>({rows:[{email:'ada@example.test',is_demo:1}]})})),
    {status:'suppressed',reasonCode:'DEMO_ACCOUNT'});
  assert.deepEqual(await run(primaryDb({account:()=>({rows:[{email:'new@example.test',is_demo:0}]})})),
    {status:'suppressed',reasonCode:'RECIPIENT_CHANGED'});
  assert.deepEqual(await run(primaryDb({account:()=>({rows:[{email:null,is_demo:0}]})})),
    {status:'suppressed',reasonCode:'RECIPIENT_CHANGED'});
  assert.deepEqual(await run(primaryDb({prefs:()=>({rows:[{email_enabled:0}]})})),
    {status:'suppressed',reasonCode:'EMAIL_DISABLED'});
  assert.equal((await run(primaryDb(),{localRuntime:true})).status,'delivered');
  assert.equal(send.messages.length,1);
});

test('missing primary week or group rows are permanent, non-retryable failures',async()=>{
  const send=recordingSend();
  const run=db=>createPairingEmailHandler({db,send,baseUrl:BASE_URL})(primaryEvent());
  await rejectsDelivery(run(primaryDb({week:()=>({})})),'PAIRING_WEEK_MISSING',false);
  await rejectsDelivery(run(primaryDb({group:()=>({rows:[]})})),'PAIRING_GROUP_MISSING',false);
  await rejectsDelivery(run(primaryDb({group:()=>({})})),'PAIRING_GROUP_MISSING',false);
  assert.equal(send.messages.length,0);
});

test('primary payloads must match the exact v1 contract',async()=>{
  const handler=createPairingEmailHandler({db:primaryDb(),send:recordingSend(),baseUrl:BASE_URL});
  await rejectsDelivery(handler({eventVersion:3,payload:{}}),'EVENT_VERSION_UNSUPPORTED',false);
  for(const payload of [
    {extra:1},{week_id:0},{user_id:'x'},{kind:'solo'},{kind:null},{recipient_email:'no-at-sign'},
    {recipient_email:null},{recipient_email:`${'a'.repeat(316)}@x.io`},
  ]){
    await rejectsDelivery(handler(primaryEvent(payload)),'PAYLOAD_INVALID',false);
  }
  const missing=primaryEvent();
  delete missing.payload.kind;
  await rejectsDelivery(handler(missing),'PAYLOAD_INVALID',false);
});

// ---- secondary (v2) events ----

const CYCLE_KEY='c'.repeat(64);
const TOKEN='12345678-1234-4123-8123-123456789abc';

function secondaryRow(overrides={}){
  return {
    publication_id:5,publication_scope_key:'circle:20',publication_circle_id:20,publication_cycle_key:CYCLE_KEY,
    publication_cycle_id:'2026-W39',publication_starts_at:'s',publication_ends_at:'e',publication_cutoff_at:'c',
    publication_time_zone:'Europe/London',generation_token:TOKEN,algorithm_version:'fair-v1',
    algorithm_seed:`circle:20:${CYCLE_KEY}:weekly`,participant_count:3,
    cycle_scope_key:'circle:20',cycle_circle_id:20,cycle_cycle_key:CYCLE_KEY,cycle_cycle_id:'2026-W39',
    cycle_starts_at:'s',cycle_ends_at:'e',cycle_cutoff_at:'c',cycle_time_zone:'Europe/London',
    eligibility_scope_key:'circle:20',eligibility_circle_id:20,eligibility_cycle_key:CYCLE_KEY,user_id:1,
    is_available:1,group_position:0,group_size:2,member_position:0,group_id:50,group_position_stored:0,
    member_count:2,user_a_id:1,user_b_id:2,is_solo:0,
    partner_eligibility_user_id:2,partner_eligibility_available:1,partner_eligibility_group_position:0,
    partner_eligibility_group_size:2,partner_eligibility_member_position:1,
    circle_name:'Night Owls',is_primary:0,archived_at:null,email:' Ada@Example.test ',display_name:'Ada',is_demo:0,
    membership_status:'active',email_enabled:null,partner_id:2,partner_name:'Grace',partner_is_demo:0,
    partner_membership_status:'active',eligibility_count:3,available_count:2,group_count:1,
    ...overrides,
  };
}

const SOLO={kind:'solo'};
const SOLO_ROW={group_size:1,member_count:1,is_solo:1,user_b_id:null,available_count:1,group_count:1,
  partner_eligibility_user_id:null,partner_id:null};
const AWAY_ROW={is_available:0,group_position:null,group_size:null,member_position:null,group_id:null,
  group_position_stored:null,member_count:null,user_a_id:null,user_b_id:null,is_solo:null,partner_id:null};

function secondaryEvent(payload={}){
  return {
    eventVersion:SECONDARY_PAIRING_EMAIL_EVENT_VERSION,idempotencyKey:'randori/circle/20/publication/5/paired/1',
    payload:{publication_id:5,circle_id:20,user_id:1,kind:'paired',...payload},
  };
}

function secondaryHandler(rows,send=recordingSend()){
  const db={execute:async()=>(rows===undefined?{}:{rows})};
  return {handler:createPairingEmailHandler({db,send,baseUrl:BASE_URL}),send};
}

test('secondary paired, solo, and unavailable emails render from a validated publication row',async()=>{
  const {handler,send}=secondaryHandler([secondaryRow({partner_name:'<b>Grace</b>'})]);
  const paired=await handler(secondaryEvent());
  assert.equal(paired.status,'delivered');
  assert.equal(send.messages[0].to,'ada@example.test');
  assert.equal(send.messages[0].subject,'Night Owls — your Randori pairing is ready');
  assert.match(send.messages[0].html,/&lt;b&gt;Grace&lt;\/b&gt;/);

  const asB=secondaryHandler([secondaryRow({user_id:2,member_position:1,partner_eligibility_user_id:1,
    partner_eligibility_member_position:0,partner_name:null,email:'grace@example.test'})]);
  assert.equal((await asB.handler(secondaryEvent({user_id:2}))).status,'delivered');
  assert.match(asB.send.messages[0].html,/your partner/);

  const solo=secondaryHandler([secondaryRow(SOLO_ROW)]);
  assert.equal((await solo.handler(secondaryEvent(SOLO))).status,'delivered');
  assert.match(solo.send.messages[0].html,/solo practice/);

  const away=secondaryHandler([secondaryRow({...AWAY_ROW,email_enabled:1})]);
  assert.equal((await away.handler(secondaryEvent({kind:'unavailable'}))).status,'delivered');
  assert.equal(away.send.messages[0].subject,'Night Owls — update your Randori availability');
});

test('secondary emails are suppressed when the feature flag is off without reading the database',async()=>{
  process.env.SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED='false';
  let reads=0;
  const handler=createPairingEmailHandler({db:{execute:async()=>{ reads+=1; return {rows:[]}; }},send:recordingSend(),baseUrl:BASE_URL});
  assert.deepEqual(await handler(secondaryEvent()),{status:'suppressed',reasonCode:'SECONDARY_PAIRING_EMAIL_DISABLED'});
  assert.equal(reads,0);
});

test('secondary payloads must match the exact v2 contract',async()=>{
  const {handler}=secondaryHandler([secondaryRow()]);
  for(const payload of [{extra:1},{publication_id:0},{circle_id:-1},{user_id:1.5},{kind:'group'},{kind:''}]){
    await rejectsDelivery(handler(secondaryEvent(payload)),'PAYLOAD_INVALID',false);
  }
});

const invalidPublicationRows={
  'no row':undefined,
  'duplicate rows':'dup',
  'publication id':{publication_id:6},
  'circle id':{publication_circle_id:21},
  'scope key':{publication_scope_key:'circle:21'},
  'eligibility scope':{eligibility_scope_key:'circle:0'},
  'eligibility circle':{eligibility_circle_id:0},
  'eligibility cycle':{eligibility_cycle_key:'d'.repeat(64)},
  'cycle scope':{cycle_scope_key:null},
  'cycle circle':{cycle_circle_id:null},
  'cycle key':{cycle_cycle_key:null},
  'cycle id':{cycle_cycle_id:'2026-W40'},
  'cycle start':{cycle_starts_at:'x'},
  'cycle end':{cycle_ends_at:'x'},
  'cycle cutoff':{cycle_cutoff_at:'x'},
  'cycle zone':{cycle_time_zone:'UTC'},
  'user id':{user_id:3},
  'malformed cycle key':{publication_cycle_key:'xyz',cycle_cycle_key:'xyz',eligibility_cycle_key:'xyz'},
  'unavailable user':{is_available:0},
  'no group position':{group_position:null},
  'no member position':{member_position:null},
  'no group':{group_id:null},
  'stored position drift':{group_position_stored:1},
  'group size':{group_size:1},
  'member count':{member_count:1},
  'solo flag':{is_solo:1},
  'missing partner':{user_b_id:null},
  'self pair':{user_b_id:1},
  'wrong member slot':{member_position:1},
  'partner eligibility user':{partner_eligibility_user_id:3},
  'partner unavailable':{partner_eligibility_available:0},
  'partner group position':{partner_eligibility_group_position:1},
  'partner group size':{partner_eligibility_group_size:1},
  'partner member position':{partner_eligibility_member_position:0},
  'participant count':{participant_count:0},
  'eligibility count':{eligibility_count:2},
  'available count range':{available_count:4},
  'available count negative':{available_count:-1},
  'group count':{group_count:2},
  'generation token':{generation_token:'not-a-uuid'},
  'algorithm version':{algorithm_version:null},
  'algorithm seed':{algorithm_seed:'other'},
};

for(const [name,override] of Object.entries(invalidPublicationRows)){
  test(`a secondary paired email is suppressed for an invalid publication: ${name}`,async()=>{
    const rows=override===undefined?undefined:override==='dup'?[secondaryRow(),secondaryRow()]:[secondaryRow(override)];
    const {handler,send}=secondaryHandler(rows);
    assert.deepEqual(await handler(secondaryEvent()),{status:'suppressed',reasonCode:'PUBLICATION_INVALID'});
    assert.equal(send.messages.length,0);
  });
}

test('solo and unavailable rows must match their own shape exactly',async()=>{
  for(const override of [{...SOLO_ROW,member_position:1},{...SOLO_ROW,member_count:2},{...SOLO_ROW,is_solo:0},
    {...SOLO_ROW,user_a_id:2},{...SOLO_ROW,user_b_id:3},{...SOLO_ROW,group_size:2}]){
    const {handler}=secondaryHandler([secondaryRow(override)]);
    assert.equal((await handler(secondaryEvent(SOLO))).reasonCode,'PUBLICATION_INVALID');
  }
  for(const override of [{...AWAY_ROW,is_available:1},{...AWAY_ROW,group_position:0},{...AWAY_ROW,group_size:1},
    {...AWAY_ROW,member_position:0},{...AWAY_ROW,group_id:7}]){
    const {handler}=secondaryHandler([secondaryRow(override)]);
    assert.equal((await handler(secondaryEvent({kind:'unavailable'}))).reasonCode,'PUBLICATION_INVALID');
  }
});

test('secondary recipients are suppressed for unavailable circles, revoked members, opt-outs, and bad names',async()=>{
  const cases=[
    [{is_primary:1},'CIRCLE_UNAVAILABLE'],
    [{archived_at:'2026-09-01'},'CIRCLE_UNAVAILABLE'],
    [{membership_status:'removed'},'MEMBERSHIP_REVOKED'],
    [{is_demo:1},'MEMBERSHIP_REVOKED'],
    [{email_enabled:0},'EMAIL_DISABLED'],
    [{email:null},'RECIPIENT_INVALID'],
    [{email:'not-an-email'},'RECIPIENT_INVALID'],
    [{email:`${'a'.repeat(320)}@x.io`},'RECIPIENT_INVALID'],
    [{circle_name:null},'RECIPIENT_INVALID'],
    [{circle_name:' Night Owls'},'RECIPIENT_INVALID'],
    [{circle_name:'Café'},'RECIPIENT_INVALID'],
    [{circle_name:'x'.repeat(81)},'RECIPIENT_INVALID'],
    [{circle_name:'\u{1F989}'.repeat(61)},'RECIPIENT_INVALID'],
    [{circle_name:'Night\u0007Owls'},'RECIPIENT_INVALID'],
    [{partner_id:null},'PARTNER_REVOKED'],
    [{partner_membership_status:'left'},'PARTNER_REVOKED'],
    [{partner_is_demo:1},'PARTNER_REVOKED'],
  ];
  for(const [override,reasonCode] of cases){
    const {handler,send}=secondaryHandler([secondaryRow(override)]);
    assert.deepEqual(await handler(secondaryEvent()),{status:'suppressed',reasonCode},JSON.stringify(override));
    assert.equal(send.messages.length,0);
  }
  // A revoked partner does not block an unavailable notice.
  const {handler}=secondaryHandler([secondaryRow({...AWAY_ROW,partner_membership_status:'left'})]);
  assert.equal((await handler(secondaryEvent({kind:'unavailable'}))).status,'delivered');
});

test('provider failures are classified for retry by status and never leak raw errors',async()=>{
  const classify=classifyPairingProviderError;
  const limited=classify({statusCode:429,retryAfterMs:1500});
  assert.equal(limited.code,'PROVIDER_RATE_LIMITED');
  assert.equal(limited.retryable,true);
  assert.equal(limited.retryAfterMs,1500);
  // An unparseable hint carries no delay; the outbox then applies its own
  // exponential backoff (max(exponential, 0)).
  const unhinted=classify({status:429,retry_after_ms:'soon'});
  assert.equal(unhinted.code,'PROVIDER_RATE_LIMITED');
  assert.equal(unhinted.retryAfterMs,0);
  assert.equal(classify({response:{status:503}}).code,'PROVIDER_UNAVAILABLE');
  const rejected=classify({error:{statusCode:422}});
  assert.equal(rejected.code,'PROVIDER_REJECTED');
  assert.equal(rejected.retryable,false);
  const typed=new OutboxDeliveryError('CUSTOM',{retryable:false});
  assert.equal(classify(typed),typed);
  const unknown=classify(new Error('socket hang up'));
  assert.equal(unknown.code,'PROVIDER_FAILED');
  assert.equal(unknown.retryable,true);
  assert.equal(classify(undefined).code,'PROVIDER_FAILED');
  assert.equal(classify(undefined).providerReason,null);
  assert.equal(classify({statusCode:403,name:'validation_error',message:'You can only send testing emails to your own email address (owner@example.test). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.'}).providerReason,'403:validation_error:testing_recipient_restricted');
  assert.equal(classify({statusCode:429,name:'rate_limit_exceeded'}).providerReason,'429:rate_limit_exceeded:other');
  assert.equal(classify({statusCode:503,name:'application_error'}).providerReason,'503:application_error:other');
  assert.equal(limited.providerReason,'429:other:other');

  const primary=createPairingEmailHandler({db:primaryDb(),send:async()=>({error:{statusCode:500}}),baseUrl:BASE_URL});
  await rejectsDelivery(primary(primaryEvent()),'PROVIDER_UNAVAILABLE',true);
  const secondary=secondaryHandler([secondaryRow()],async()=>{ throw {status:400}; });
  await rejectsDelivery(secondary.handler(secondaryEvent()),'PROVIDER_REJECTED',false);
  const secondaryError=secondaryHandler([secondaryRow()],async()=>({error:{statusCode:429}}));
  await rejectsDelivery(secondaryError.handler(secondaryEvent()),'PROVIDER_RATE_LIMITED',true);
  const named=secondaryHandler([secondaryRow()],async()=>({providerName:'x'.repeat(150),providerMessageId:'id-1'}));
  const delivered=await named.handler(secondaryEvent());
  assert.equal(delivered.providerName.length,100);
  assert.equal(delivered.providerMessageId,'id-1');
  const bare=secondaryHandler([secondaryRow()],async()=>undefined);
  assert.deepEqual(await bare.handler(secondaryEvent()),{status:'delivered',providerName:'email',providerMessageId:null});
});

test('the Resend sender requires a client and sender, forwards idempotency, and surfaces errors',async()=>{
  assert.throws(()=>createResendEmailSender(),TypeError);
  assert.throws(()=>createResendEmailSender({resend:{emails:{send(){}}},from:'  '}),TypeError);
  const calls=[];
  const resend={emails:{send:async(message,options)=>{ calls.push([message,options]); return {data:{id:'r-1'}}; }}};
  const send=createResendEmailSender({resend,from:'Randori <noreply@example.test>'});
  assert.deepEqual(await send({to:'a@b.co',subject:'s',html:'h',idempotencyKey:'k',signal:'sig'}),
    {providerName:'resend',providerMessageId:'r-1'});
  assert.deepEqual(calls[0],[{from:'Randori <noreply@example.test>',to:'a@b.co',subject:'s',html:'h'},
    {idempotencyKey:'k',signal:'sig'}]);
  const empty=createResendEmailSender({resend:{emails:{send:async()=>null}},from:'x@y.z'});
  assert.deepEqual(await empty({}),{providerName:'resend',providerMessageId:null});
  const providerError={statusCode:422};
  const failing=createResendEmailSender({resend:{emails:{send:async()=>({error:providerError})}},from:'x@y.z'});
  await assert.rejects(failing({}),error=>error===providerError);
});

test('legacy migration validates its client and limit',async()=>{
  await assert.rejects(migrateLegacyPairingEmails(null),TypeError);
  for(const limit of [0,101,2.5,'x']){
    await assert.rejects(migrateLegacyPairingEmails({execute:async()=>({})},{limit}),/limit/);
  }
  assert.equal(await migrateLegacyPairingEmails({execute:async()=>({})}),0);
});

test('delivery bridges legacy rows once and suppresses a recipient without primary membership',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-pairing-email-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  try{
    await prepareMigrationConnection(db);
    const before=await inspectMigrationState(db);
    await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,
      retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
    await db.execute(`INSERT INTO pairing_email_outbox (week_id,user_id,kind,recipient_email,status,attempt_count)
      VALUES (3,1,'paired','ada@example.test','pending',0),(3,2,'paired','bob@example.test','exhausted',5)`);
    const send=recordingSend();
    const result=await deliverPairingEmails({db,baseUrl:BASE_URL,send,workerId:'cov-worker'});
    assert.equal(send.messages.length,0);
    assert.equal(result.status.suppressed,1);
    assert.equal(result.status.dead_letter,1);
    const events=await db.execute(`SELECT idempotency_key,status,last_error_code FROM outbox_events
      WHERE event_type=? ORDER BY idempotency_key`,[PAIRING_EMAIL_EVENT_TYPE]);
    assert.deepEqual(events.rows.map(row=>[row.idempotency_key,row.status]),[
      ['randori/3/paired/1','suppressed'],['randori/3/paired/2','dead_letter'],
    ]);
    // Re-running the bridge is idempotent.
    assert.equal(await migrateLegacyPairingEmails(db),0);
  }finally{
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
