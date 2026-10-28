// P3 coverage: the single outbox delivery-adapter registry. Template modules
// are replaced by factories that expose the sender each handler receives, so
// the local development capture sender and provider gating are asserted
// directly without rendering real email.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const PAIRING='pairing.email.requested';
const SCHEDULE='schedule.email.requested';
const INVITATION='invitation.email.requested';
const ACTIVATION='auth.emailverification.requested';
const RESET='auth.passwordreset.requested';
const FEEDBACK='feedback.submitted';
const REMINDER='reminder.email.requested';
const DELETION_CONFIRMATION='account.deletion.confirmation';
const DELETION_REMINDER='account.deletion.reminder';
const DELETION_BLOCKED='account.deletion.blocked';

const state={};
function resetState(){
  Object.assign(state,{local:false,invitationConfig:{origin:'x'},activationConfig:{origin:'x'},
    resetConfig:{origin:'x'},invitationConfigCalls:[],senderCalls:[]});
}
resetState();

const factory=kind=>options=>({kind,...options});
mock.module('../../api/_pairing-email.js',{exports:{
  PAIRING_EMAIL_EVENT_TYPE:PAIRING,
  createPairingEmailHandler:factory('pairing'),
  createResendEmailSender:options=>{
    state.senderCalls.push(options);
    return async()=>({providerName:'resend',providerMessageId:'re_1'});
  },
}});
mock.module('../../api/_schedule-email.js',{exports:{
  SCHEDULE_EMAIL_EVENT_TYPE:SCHEDULE,createScheduleEmailHandler:factory('schedule'),
}});
mock.module('../../api/_invitation-email.js',{exports:{
  INVITATION_EMAIL_EVENT_TYPE:INVITATION,createInvitationEmailHandler:factory('invitation'),
  invitationEmailConfiguration:options=>{ state.invitationConfigCalls.push(options); return state.invitationConfig; },
}});
mock.module('../../api/_email-activation.js',{exports:{
  EMAIL_ACTIVATION_EVENT_TYPE:ACTIVATION,createEmailActivationHandler:factory('activation'),
  emailActivationConfiguration:()=>state.activationConfig,
}});
mock.module('../../api/_password-reset.js',{exports:{
  PASSWORD_RESET_EVENT_TYPE:RESET,createPasswordResetHandler:factory('reset'),
  passwordResetConfiguration:()=>state.resetConfig,
}});
mock.module('../../api/_reminders.js',{exports:{
  REMINDER_EMAIL_EVENT_TYPE:REMINDER,createReminderEmailHandler:factory('reminder'),
}});
mock.module('../../api/_feedback-notification.js',{exports:{
  FEEDBACK_SUBMITTED_EVENT_TYPE:FEEDBACK,createFeedbackSubmittedHandler:factory('feedback'),
}});
mock.module('../../api/_account-deletion-grace.js',{exports:{
  ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE:DELETION_CONFIRMATION,
  ACCOUNT_DELETION_REMINDER_EVENT_TYPE:DELETION_REMINDER,
  ACCOUNT_DELETION_BLOCKED_EVENT_TYPE:DELETION_BLOCKED,
  createAccountDeletionEmailHandler:factory('account-deletion'),
  // Imported by the real invite-request notification handler, which the
  // delivery registry loads. The mocked registry never delivers, so the
  // lock is always off here.
  isDeletionPending:async()=>false,
}});
mock.module('../../api/_local-runtime.js',{exports:{
  localIdentityAdapterEnabled:()=>state.local,
  strictLocalPairingRuntime:()=>state.local,
}});

const {
  configuredOutboxBaseUrl,
  outboxDeliveryPlan,
} = await import('../../api/_outbox-delivery.js');

const ENV_KEYS=['APP_URL','NODE_ENV','RANDORI_LOCAL_RUNTIME','RESEND_API_KEY','RESEND_FROM'];
const previousEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
afterEach(()=>{
  resetState();
  for(const key of ENV_KEYS){
    if(previousEnv[key]===undefined) delete process.env[key];
    else process.env[key]=previousEnv[key];
  }
});

function setEnv(values){
  for(const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env,values);
}

test('the outbox origin must be a bare https origin, or bare loopback http only in the local runtime',()=>{
  const cases=[
    [{},null],
    [{APP_URL:'not a url'},null],
    [{APP_URL:'https://randori.example.test'},'https://randori.example.test'],
    [{APP_URL:'https://randori.example.test/'},'https://randori.example.test'],
    [{APP_URL:'https://randori.example.test/app'},null],
    [{APP_URL:'https://randori.example.test/?x=1'},null],
    [{APP_URL:'https://randori.example.test/#frag'},null],
    [{APP_URL:'https://user:pass@randori.example.test'},null],
    [{APP_URL:'http://randori.example.test'},null],
    [{APP_URL:'https://localhost'},null],
    [{APP_URL:'https://127.0.0.1:8443'},null],
    [{APP_URL:'http://127.0.0.1:3000',NODE_ENV:'development'},null],
    [{APP_URL:'http://127.0.0.1:3000',NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true'},'http://127.0.0.1:3000'],
    [{APP_URL:'http://localhost:3000',NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true'},'http://localhost:3000'],
    [{APP_URL:'http://[::1]:3000',NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true'},'http://[::1]:3000'],
    [{APP_URL:'http://randori.example.test',NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true'},null],
    [{APP_URL:'https://127.0.0.1:3000',NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true'},null],
  ];
  for(const [env,expected] of cases){
    setEnv(env);
    assert.equal(configuredOutboxBaseUrl(),expected,JSON.stringify(env));
  }
});

test('local development captures every mail type with its kind and at most four links',async()=>{
  setEnv({});
  state.local=true;
  const plan=await outboxDeliveryPlan('db','http://127.0.0.1:3000',{});
  assert.equal(plan.local,true);
  assert.deepEqual([...plan.handlers.keys()],[PAIRING,SCHEDULE,INVITATION,ACTIVATION,RESET,FEEDBACK,REMINDER,
    DELETION_CONFIRMATION,DELETION_REMINDER,DELETION_BLOCKED]);
  assert.deepEqual(state.invitationConfigCalls,[{localRuntime:true}]);
  assert.equal(plan.handlers.get(PAIRING).localRuntime,true);
  assert.equal(plan.handlers.get(SCHEDULE).localRuntime,true);
  assert.equal(plan.handlers.get(FEEDBACK).localRuntime,true);
  assert.equal(plan.handlers.get(INVITATION).localRuntime,true);
  assert.equal(plan.handlers.get(REMINDER).localScope,true);
  assert.equal(state.senderCalls.length,0,'no provider client is created for local capture');

  const html=['a','b','c','d','e'].map(path=>`<a href="http://127.0.0.1:3000/${path}">${path}</a>`).join('');
  const send=(type,message)=>plan.handlers.get(type).send({to:'Member@Example.Test',subject:'Hello',html,...message});
  const receipt=await send(PAIRING,{kind:'solo'});
  assert.equal(receipt.providerName,'local-capture');
  assert.match(receipt.providerMessageId,/^local-[0-9a-f-]{36}$/);
  await send(PAIRING,{kind:'surprise',subject:'You missed this week'});
  await send(PAIRING,{subject:'Your pair'});
  await send(PAIRING,{kind:'unavailable'});
  await send(SCHEDULE,{});
  await send(INVITATION,{});
  await send(ACTIVATION,{});
  await send(RESET,{});
  await send(REMINDER,{kind:'availability_cutoff'});
  await send(REMINDER,{kind:'session_soon'});
  await send(FEEDBACK,{});
  await send(DELETION_CONFIRMATION,{});
  await send(DELETION_REMINDER,{});
  await send(DELETION_BLOCKED,{});
  assert.deepEqual(plan.captured.get(REMINDER).map(entry=>entry.kind),
    ['reminder-availability-cutoff','reminder-session-soon']);
  assert.deepEqual(plan.captured.get(FEEDBACK).map(entry=>entry.kind),['feedback']);
  assert.deepEqual(plan.captured.get(DELETION_CONFIRMATION).map(entry=>entry.kind),['account-deletion-confirmation']);
  assert.deepEqual(plan.captured.get(DELETION_REMINDER).map(entry=>entry.kind),['account-deletion-reminder']);
  assert.deepEqual(plan.captured.get(DELETION_BLOCKED).map(entry=>entry.kind),['account-deletion-blocked']);
  assert.deepEqual(plan.captured.get(PAIRING).map(entry=>entry.kind),['solo','unavailable','paired','unavailable']);
  assert.deepEqual([SCHEDULE,INVITATION,ACTIVATION,RESET].map(type=>plan.captured.get(type).map(entry=>entry.kind)),
    [['schedule'],['invitation'],['activation'],['password-reset']]);
  const [first]=plan.captured.get(SCHEDULE);
  assert.equal(first.recipient_email,'Member@Example.Test');
  assert.equal(first.subject,'Hello');
  assert.deepEqual(first.links,['a','b','c','d'].map(path=>`http://127.0.0.1:3000/${path}`));
});

test('a type filter builds only the requested handlers',async()=>{
  setEnv({});
  state.local=true;
  const plan=await outboxDeliveryPlan('db','http://127.0.0.1:3000',{},{types:[SCHEDULE,RESET]});
  assert.deepEqual([...plan.handlers.keys()],[SCHEDULE,RESET]);
  assert.deepEqual(state.invitationConfigCalls,[],'excluded types are not even configured');
});

test('without a configured provider nothing is deliverable outside local capture',async()=>{
  setEnv({RESEND_API_KEY:'re_test'});
  const plan=await outboxDeliveryPlan('db','https://randori.example.test',{});
  assert.equal(plan.local,false);
  assert.equal(plan.handlers.size,0);
  assert.equal(state.senderCalls.length,0);
});

test('a configured provider is shared across types and unconfigured flows are omitted',async()=>{
  setEnv({RESEND_API_KEY:'re_test',RESEND_FROM:'Randori <mail@randori.example.test>'});
  state.invitationConfig=null;
  state.resetConfig=null;
  const plan=await outboxDeliveryPlan('db','https://randori.example.test',{});
  assert.deepEqual([...plan.handlers.keys()],[PAIRING,SCHEDULE,ACTIVATION,FEEDBACK,REMINDER,
    DELETION_CONFIRMATION,DELETION_REMINDER,DELETION_BLOCKED]);
  assert.equal(state.senderCalls.length,1,'one provider client is created per plan');
  assert.equal(state.senderCalls[0].from,'Randori <mail@randori.example.test>');
  assert.equal(typeof state.senderCalls[0].resend.emails.send,'function');
  const send=plan.handlers.get(PAIRING).send;
  assert.equal(plan.handlers.get(SCHEDULE).send,send);
  assert.equal(plan.handlers.get(ACTIVATION).send,send);
  assert.equal(plan.handlers.get(FEEDBACK).send,send);
  assert.equal(plan.handlers.get(REMINDER).send,send);
  assert.equal(plan.handlers.get(DELETION_CONFIRMATION).send,send);
  assert.equal(plan.handlers.get(DELETION_REMINDER).send,send);
  assert.equal(plan.handlers.get(DELETION_BLOCKED).send,send);
  assert.equal(plan.handlers.get(PAIRING).localRuntime,false);
  assert.deepEqual(state.invitationConfigCalls,[{localRuntime:false}]);
});

