import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';
import {createClient} from '@libsql/client';

import {
  assertPurposeKeyIsolation,
  CredentialEnvelopeError,
  openCredentialEnvelope,
  parseKeyRing,
  readCredentialRotationMetrics,
  sealCredentialEnvelope,
} from '../../api/_key-rotation.js';
import {
  createEmailActivationHandler,
  emailActivationConfiguration,
  hashEmailActivationToken,
  openEmailActivationToken,
  sealEmailActivationToken,
} from '../../api/_email-activation.js';
import {
  createPasswordResetHandler,
  passwordResetConfiguration,
  hashPasswordResetToken,
  openPasswordResetToken,
  sealPasswordResetToken,
} from '../../api/_password-reset.js';
import {
  createInvitationEmailEvent,
  invitationEmailConfiguration,
  openInvitationEmailCredential,
  sealInvitationEmailCredential,
} from '../../api/_invitation-email.js';
import {createInvitationToken,hashInvitationEmail,hashInvitationToken} from '../../api/_circle-membership.js';
import {identityEmailHashConfigured} from '../../api/_identity-linking.js';

const ENV_KEYS=[
  'NODE_ENV','JWT_SECRET','APP_URL','CIRCLE_MEMBERSHIP_ENABLED','EMAIL_PASSWORD_ACTIVATION_ENABLED',
  'PASSWORD_RESET_ENABLED','RESEND_API_KEY','RESEND_FROM',
  'EMAIL_VERIFICATION_ENCRYPTION_KEY','EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION',
  'EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS','EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION',
  'PASSWORD_RESET_ENCRYPTION_KEY','PASSWORD_RESET_ENCRYPTION_KEY_VERSION',
  'PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS','PASSWORD_RESET_ENVELOPE_WRITE_VERSION',
  'INVITATION_EMAIL_ENCRYPTION_KEY','INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
  'INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS','INVITATION_EMAIL_ENVELOPE_WRITE_VERSION',
  'IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION','IDENTITY_EMAIL_HASH_PREVIOUS_KEYS',
];
const ORIGINAL=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const KEY_1=Buffer.alloc(32,21).toString('base64url');
const KEY_2=Buffer.alloc(32,22).toString('base64url');
const KEY_3=Buffer.alloc(32,23).toString('base64url');
const KEY_4=Buffer.alloc(32,24).toString('base64url');
const KEY_5=Buffer.alloc(32,25).toString('base64url');
const KEY_6=Buffer.alloc(32,26).toString('base64url');
const KEY_7=Buffer.alloc(32,27).toString('base64url');
const KEY_8=Buffer.alloc(32,28).toString('base64url');
const TOKEN='A'.repeat(43);
const INVITATION_ID='22222222-2222-4222-8222-222222222222';

afterEach(()=>{
  for(const key of ENV_KEYS){
    if(ORIGINAL[key]===undefined) delete process.env[key];
    else process.env[key]=ORIGINAL[key];
  }
});

function ring(env){
  return parseKeyRing({env,purpose:'test-credential',keyEnv:'ACTIVE',versionEnv:'VERSION',
    previousKeysEnv:'PREVIOUS',writeVersionEnv:'WRITE'});
}

test('key rings reject ambiguous, unordered, duplicated, and oversized prior-key configuration',()=>{
  assert.equal(ring({ACTIVE:KEY_2,VERSION:'2'}).writeEnvelopeVersion,1,
    'compatibility rollout continues writing v1 by default');
  const fallbackKey=Buffer.alloc(32,20);
  const withFallback=parseKeyRing({env:{},purpose:'test-credential',keyEnv:'ACTIVE',
    versionEnv:'VERSION',previousKeysEnv:'PREVIOUS',fallbackKey:()=>fallbackKey});
  assert.deepEqual(withFallback.active.key,fallbackKey,
    'a genuinely missing local key may use the compatibility fallback');
  assert.throws(()=>parseKeyRing({env:{ACTIVE:'malformed'},purpose:'test-credential',
    keyEnv:'ACTIVE',versionEnv:'VERSION',previousKeysEnv:'PREVIOUS',
    fallbackKey:()=>fallbackKey}),error=>error?.code==='KEY_RING_ACTIVE_INVALID',
  'a non-empty malformed key must fail closed instead of using the fallback');
  for(const [env,code] of [
    [{ACTIVE:KEY_2,VERSION:'x'},'KEY_RING_VERSION_INVALID'],
    [{ACTIVE:KEY_2,VERSION:'2',WRITE:'3'},'KEY_RING_WRITE_VERSION_INVALID'],
    [{ACTIVE:KEY_2,VERSION:'2',PREVIOUS:'not-json'},'KEY_RING_PREVIOUS_INVALID'],
    [{ACTIVE:KEY_2,VERSION:'2',PREVIOUS:JSON.stringify([{version:2,key:KEY_1}])},
      'KEY_RING_PREVIOUS_UNORDERED'],
    [{ACTIVE:KEY_3,VERSION:'3',PREVIOUS:JSON.stringify([
      {version:1,key:KEY_1},{version:2,key:KEY_2}])},'KEY_RING_PREVIOUS_UNORDERED'],
    [{ACTIVE:KEY_2,VERSION:'2',PREVIOUS:JSON.stringify([{version:1,key:KEY_2}])},
      'KEY_RING_MATERIAL_DUPLICATE'],
    [{ACTIVE:KEY_3,VERSION:'5',PREVIOUS:JSON.stringify([
      {version:4,key:KEY_2},{version:3,key:KEY_1},{version:2,key:Buffer.alloc(32,24).toString('base64url')},
      {version:1,key:Buffer.alloc(32,25).toString('base64url')},
    ])},'KEY_RING_PREVIOUS_INVALID'],
  ]) assert.throws(()=>ring(env),error=>error?.code===code,`expected ${code}`);
});

test('local credential fallbacks apply only when the configured key is genuinely empty',()=>{
  process.env.NODE_ENV='development';
  process.env.JWT_SECRET='key-fallback-test-secret-at-least-32-characters';
  process.env.APP_URL='http://localhost:5173';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  process.env.PASSWORD_RESET_ENABLED='true';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY='';
  process.env.PASSWORD_RESET_ENCRYPTION_KEY='';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY='';
  assert.equal(emailActivationConfiguration()?.origin,'http://localhost:5173');
  assert.equal(passwordResetConfiguration()?.origin,'http://localhost:5173');
  assert.equal(invitationEmailConfiguration({localRuntime:true})?.origin,'http://localhost:5173');
  assert.match(sealEmailActivationToken(TOKEN),/^[^.]+\.[^.]+\.[^.]+$/);
  assert.match(sealPasswordResetToken(TOKEN),/^[^.]+\.[^.]+\.[^.]+$/);
  assert.match(sealInvitationEmailCredential({invitationId:INVITATION_ID,
    email:'member@example.test',token:createInvitationToken(),localRuntime:true}),
  /^[^.]+\.[^.]+\.[^.]+$/);

  for(const [key,configuration,seal] of [
    ['EMAIL_VERIFICATION_ENCRYPTION_KEY',emailActivationConfiguration,
      ()=>sealEmailActivationToken(TOKEN)],
    ['PASSWORD_RESET_ENCRYPTION_KEY',passwordResetConfiguration,
      ()=>sealPasswordResetToken(TOKEN)],
    ['INVITATION_EMAIL_ENCRYPTION_KEY',()=>invitationEmailConfiguration({localRuntime:true}),
      ()=>sealInvitationEmailCredential({
      invitationId:INVITATION_ID,email:'member@example.test',token:createInvitationToken(),
      localRuntime:true})],
  ]){
    process.env[key]='malformed-non-empty-key';
    assert.equal(configuration(),null,`${key} must disable its configuration entry point`);
    assert.throws(seal,error=>error?.code==='KEY_RING_ACTIVE_INVALID',
      `${key} must fail closed instead of using its local fallback`);
    process.env[key]='';
  }
});

test('purpose isolation rejects active-active, active-prior, and prior-prior material reuse',()=>{
  assert.throws(()=>assertPurposeKeyIsolation({env:{
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY_1,
    PASSWORD_RESET_ENCRYPTION_KEY:KEY_1,
  }}),error=>error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
  assert.throws(()=>assertPurposeKeyIsolation({env:{
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY_1,
    PASSWORD_RESET_ENCRYPTION_KEY:KEY_2,
    PASSWORD_RESET_ENCRYPTION_KEY_VERSION:'2',
    PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_1}]),
  }}),error=>error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
  assert.throws(()=>assertPurposeKeyIsolation({env:{
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY_2,
    EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION:'2',
    EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_1}]),
    IDENTITY_EMAIL_HASH_KEY:KEY_3,
    IDENTITY_EMAIL_HASH_KEY_VERSION:'2',
    IDENTITY_EMAIL_HASH_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_1}]),
  }}),error=>error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
  assert.equal(assertPurposeKeyIsolation({env:{
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY_1,
    EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION:'2',
    EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_2}]),
    PASSWORD_RESET_ENCRYPTION_KEY:KEY_3,
    PASSWORD_RESET_ENCRYPTION_KEY_VERSION:'2',
    PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_4}]),
    INVITATION_EMAIL_ENCRYPTION_KEY:KEY_5,
    INVITATION_EMAIL_ENCRYPTION_KEY_VERSION:'2',
    INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_6}]),
    IDENTITY_EMAIL_HASH_KEY:KEY_7,
    IDENTITY_EMAIL_HASH_KEY_VERSION:'2',
    IDENTITY_EMAIL_HASH_PREVIOUS_KEYS:JSON.stringify([{version:1,key:KEY_8}]),
  }}),true);
});

test('every production key-ring entry point fails closed on cross-purpose reuse',()=>{
  Object.assign(process.env,{
    NODE_ENV:'production',APP_URL:'https://randori.example.test',CIRCLE_MEMBERSHIP_ENABLED:'true',
    JWT_SECRET:'key-isolation-test-secret-at-least-32-bytes',
    RESEND_API_KEY:'re_rotation_test',RESEND_FROM:'Randori <mail@randori.example.test>',
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY_1,EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION:'1',
    PASSWORD_RESET_ENCRYPTION_KEY:KEY_1,PASSWORD_RESET_ENCRYPTION_KEY_VERSION:'1',
    INVITATION_EMAIL_ENCRYPTION_KEY:KEY_1,INVITATION_EMAIL_ENCRYPTION_KEY_VERSION:'1',
    IDENTITY_EMAIL_HASH_KEY:KEY_1,IDENTITY_EMAIL_HASH_KEY_VERSION:'1',
  });
  assert.equal(emailActivationConfiguration(),null);
  assert.equal(passwordResetConfiguration(),null);
  assert.equal(invitationEmailConfiguration(),null);
  assert.equal(identityEmailHashConfigured(),false);
  assert.throws(()=>sealEmailActivationToken(TOKEN),error=>
    error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
  assert.throws(()=>sealPasswordResetToken(TOKEN),error=>
    error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
  assert.throws(()=>sealInvitationEmailCredential({invitationId:INVITATION_ID,
    email:'member@example.test',token:createInvitationToken()}),error=>
    error?.code==='KEY_RING_CROSS_PURPOSE_REUSE');
});

test('v2 binds purpose, version, key identity, and event idempotency while v1 reads prior keys',()=>{
  const legacyRing=ring({ACTIVE:KEY_1,VERSION:'1'});
  const legacy=sealCredentialEnvelope({plaintext:TOKEN,ring:legacyRing,
    legacyAad:()=>Buffer.from('legacy-aad')});
  assert.equal(legacy.split('.').length,3);

  const rotated=ring({ACTIVE:KEY_2,VERSION:'2',WRITE:'2',
    PREVIOUS:JSON.stringify([{version:1,key:KEY_1}])});
  assert.equal(openCredentialEnvelope({envelope:legacy,ring:rotated,
    legacyAad:()=>Buffer.from('legacy-aad')}).plaintext.toString(),TOKEN);
  const eventKey='credential/v1/id/1';
  const versioned=sealCredentialEnvelope({plaintext:TOKEN,idempotencyKey:eventKey,ring:rotated,
    legacyAad:()=>Buffer.from('legacy-aad')});
  assert.match(versioned,/^v2\.2\.[a-f0-9]{64}\./);
  assert.equal(openCredentialEnvelope({envelope:versioned,idempotencyKey:eventKey,ring:rotated,
    legacyAad:()=>Buffer.from('legacy-aad')}).plaintext.toString(),TOKEN);

  assert.throws(()=>openCredentialEnvelope({envelope:versioned,idempotencyKey:'credential/v1/id/2',
    ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error instanceof CredentialEnvelopeError&&error.code==='ENVELOPE_INVALID'&&!error.retryable);
  const otherPurpose=parseKeyRing({env:{ACTIVE:KEY_2,VERSION:'2',WRITE:'2'},purpose:'other-purpose',
    keyEnv:'ACTIVE',versionEnv:'VERSION',previousKeysEnv:'PREVIOUS',writeVersionEnv:'WRITE'});
  assert.throws(()=>openCredentialEnvelope({envelope:versioned,idempotencyKey:eventKey,
    ring:otherPurpose,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='KEY_FINGERPRINT_MISMATCH'&&error.retryable);

  const withoutV2=ring({ACTIVE:KEY_3,VERSION:'3',WRITE:'2'});
  assert.throws(()=>openCredentialEnvelope({envelope:versioned,idempotencyKey:eventKey,
    ring:withoutV2,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='KEY_VERSION_UNAVAILABLE'&&error.retryable);
  const fingerprintParts=versioned.split('.');
  fingerprintParts[2]='0'.repeat(64);
  assert.throws(()=>openCredentialEnvelope({envelope:fingerprintParts.join('.'),idempotencyKey:eventKey,
    ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='KEY_FINGERPRINT_MISMATCH'&&error.retryable);
  const tampered=versioned.split('.');
  const ciphertext=Buffer.from(tampered[4],'base64url');
  ciphertext[0]^=1;
  tampered[4]=ciphertext.toString('base64url');
  assert.throws(()=>openCredentialEnvelope({envelope:tampered.join('.'),idempotencyKey:eventKey,
    ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='ENVELOPE_INVALID'&&!error.retryable);
  assert.throws(()=>openCredentialEnvelope({envelope:'v3.future',idempotencyKey:eventKey,
    ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='ENVELOPE_VERSION_UNAVAILABLE'&&error.retryable);
  assert.throws(()=>openCredentialEnvelope({envelope:'v3.future.shape',idempotencyKey:eventKey,
    ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}),error=>
    error.code==='ENVELOPE_VERSION_UNAVAILABLE'&&error.retryable);
});

test('activation, reset, and invitation v2 readers retain v1 compatibility across rotation',()=>{
  process.env.NODE_ENV='production';
  process.env.JWT_SECRET='key-rotation-unit-secret-at-least-32-characters';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=KEY_1;
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=KEY_2;
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=KEY_3;
  const activationV1=sealEmailActivationToken(TOKEN);
  const resetV1=sealPasswordResetToken(TOKEN);
  const invitationToken=createInvitationToken();
  const invitationV1=sealInvitationEmailCredential({invitationId:INVITATION_ID,
    email:'member@example.test',token:invitationToken});

  for(const [prefix,active,previous] of [
    ['EMAIL_VERIFICATION',KEY_4,KEY_1],
    ['PASSWORD_RESET',KEY_5,KEY_2],
    ['INVITATION_EMAIL',KEY_6,KEY_3],
  ]){
    process.env[`${prefix}_ENCRYPTION_KEY`]=active;
    process.env[`${prefix}_ENCRYPTION_KEY_VERSION`]='2';
    process.env[`${prefix}_ENCRYPTION_PREVIOUS_KEYS`]=JSON.stringify([{version:1,key:previous}]);
    process.env[`${prefix}_ENVELOPE_WRITE_VERSION`]='2';
  }
  assert.equal(openEmailActivationToken(activationV1),TOKEN);
  assert.equal(openPasswordResetToken(resetV1),TOKEN);
  assert.deepEqual(openInvitationEmailCredential({invitationId:INVITATION_ID,envelope:invitationV1}),
    {email:'member@example.test',token:invitationToken});

  const activationKey='auth-activation/v1/22222222-2222-4222-8222-222222222222/1';
  const activationV2=sealEmailActivationToken(TOKEN,{idempotencyKey:activationKey});
  const resetKey='password-reset/v1/22222222-2222-4222-8222-222222222222/1';
  const resetV2=sealPasswordResetToken(TOKEN,{idempotencyKey:resetKey});
  const invitationKey=`invitation-email/v1/${INVITATION_ID}/1`;
  const invitationV2=sealInvitationEmailCredential({invitationId:INVITATION_ID,
    email:'member@example.test',token:invitationToken,idempotencyKey:invitationKey});
  assert.equal(openEmailActivationToken(activationV2,{idempotencyKey:activationKey}),TOKEN);
  assert.equal(openEmailActivationToken(activationV2,{idempotencyKey:`${activationKey}-replay`}),null);
  assert.equal(openPasswordResetToken(resetV2,{idempotencyKey:resetKey}),TOKEN);
  assert.equal(openPasswordResetToken(resetV2,{idempotencyKey:`${resetKey}-replay`}),null);
  assert.deepEqual(openInvitationEmailCredential({invitationId:INVITATION_ID,envelope:invitationV2,
    idempotencyKey:invitationKey}),{email:'member@example.test',token:invitationToken});
  assert.equal(openInvitationEmailCredential({invitationId:INVITATION_ID,envelope:invitationV2,
    idempotencyKey:`${invitationKey}-replay`}),null);
});

test('handlers retry missing keys, terminally reject tampering, and suppress inactive work before decrypt',async()=>{
  process.env.NODE_ENV='production';
  process.env.JWT_SECRET='key-rotation-unit-secret-at-least-32-characters';
  const activationId='22222222-2222-4222-8222-222222222222';
  const resetId='33333333-3333-4333-8333-333333333333';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=KEY_1;
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION='1';
  process.env.EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION='2';
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=KEY_2;
  process.env.PASSWORD_RESET_ENCRYPTION_KEY_VERSION='1';
  process.env.PASSWORD_RESET_ENVELOPE_WRITE_VERSION='2';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=KEY_3;
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY_VERSION='1';
  process.env.INVITATION_EMAIL_ENVELOPE_WRITE_VERSION='2';
  const activationKey=`auth-activation/v1/${activationId}/1`;
  const resetKey=`password-reset/v1/${resetId}/1`;
  const activationEnvelope=sealEmailActivationToken(TOKEN,{idempotencyKey:activationKey});
  const resetEnvelope=sealPasswordResetToken(TOKEN,{idempotencyKey:resetKey});
  const invitationToken=createInvitationToken();
  const invitationStatement=createInvitationEmailEvent({invitationId:INVITATION_ID,circleId:10,
    actorUserId:1,email:'member@example.test',token:invitationToken,sendSequence:1});
  const invitationEvent={eventVersion:Number(invitationStatement.args[1]),
    idempotencyKey:String(invitationStatement.args[2]),payload:JSON.parse(invitationStatement.args[3])};
  const activationEvent={eventVersion:1,idempotencyKey:activationKey,payload:{activation_id:activationId,
    recipient_email:'member@example.test',token_envelope:activationEnvelope}};
  const resetEvent={eventVersion:1,idempotencyKey:resetKey,payload:{reset_id:resetId,
    recipient_email:'member@example.test',token_envelope:resetEnvelope}};
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=KEY_4;
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION='2';
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=KEY_5;
  process.env.PASSWORD_RESET_ENCRYPTION_KEY_VERSION='2';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=KEY_6;
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY_VERSION='2';
  const activeDb={execute:async statement=>String(statement.sql).includes('auth_email_activations')
    ?{rows:[{id:activationId,token_hash:hashEmailActivationToken(TOKEN),send_count:1}]}
    :{rows:[{id:resetId,token_hash:hashPasswordResetToken(TOKEN)}]}};
  const activationHandler=createEmailActivationHandler({db:activeDb,baseUrl:'https://randori.example.test',
    send:async()=>assert.fail('missing key must not send')});
  const resetHandler=createPasswordResetHandler({db:activeDb,baseUrl:'https://randori.example.test',
    send:async()=>assert.fail('missing key must not send')});
  await assert.rejects(()=>activationHandler(activationEvent),error=>
    error.code==='KEY_VERSION_UNAVAILABLE'&&error.retryable);
  await assert.rejects(()=>resetHandler(resetEvent),error=>
    error.code==='KEY_VERSION_UNAVAILABLE'&&error.retryable);
  const invitationDb={execute:async()=>({rows:[{id:INVITATION_ID,circle_name:'Practice'}]})};
  const invitationHandler=(await import('../../api/_invitation-email.js')).createInvitationEmailHandler({
    db:invitationDb,baseUrl:'https://randori.example.test',send:async()=>assert.fail('missing key must not send')});
  await assert.rejects(()=>invitationHandler(invitationEvent),error=>
    error.code==='KEY_VERSION_UNAVAILABLE'&&error.retryable);

  const inactiveDb={execute:async()=>({rows:[]})};
  const inactiveActivation=createEmailActivationHandler({db:inactiveDb,
    baseUrl:'https://randori.example.test',send:async()=>assert.fail()});
  const inactiveReset=createPasswordResetHandler({db:inactiveDb,
    baseUrl:'https://randori.example.test',send:async()=>assert.fail()});
  assert.deepEqual(await inactiveActivation(activationEvent),
    {status:'suppressed',reasonCode:'ACTIVATION_INACTIVE'});
  assert.deepEqual(await inactiveReset(resetEvent),
    {status:'suppressed',reasonCode:'PASSWORD_RESET_INACTIVE'});
  const inactiveInvitation=(await import('../../api/_invitation-email.js')).createInvitationEmailHandler({
    db:inactiveDb,baseUrl:'https://randori.example.test',send:async()=>assert.fail()});
  assert.deepEqual(await inactiveInvitation(invitationEvent),
    {status:'suppressed',reasonCode:'INVITATION_INACTIVE'});

  process.env.EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS=JSON.stringify([{version:1,key:KEY_1}]);
  process.env.PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS=JSON.stringify([{version:1,key:KEY_2}]);
  process.env.INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS=JSON.stringify([{version:1,key:KEY_3}]);
  const tamper=event=>{
    const copy=structuredClone(event);
    const field=copy.payload.token_envelope?'token_envelope':'credential_envelope';
    const parts=copy.payload[field].split('.');
    const ciphertext=Buffer.from(parts[4],'base64url');
    ciphertext[0]^=1;
    parts[4]=ciphertext.toString('base64url');
    copy.payload[field]=parts.join('.');
    return copy;
  };
  await assert.rejects(()=>activationHandler(tamper(activationEvent)),error=>
    error.code==='ENVELOPE_INVALID'&&!error.retryable);
  await assert.rejects(()=>resetHandler(tamper(resetEvent)),error=>
    error.code==='ENVELOPE_INVALID'&&!error.retryable);
  await assert.rejects(()=>invitationHandler(tamper(invitationEvent)),error=>
    error.code==='ENVELOPE_INVALID'&&!error.retryable);
});

test('rotation metrics aggregate only key versions and readiness signals',async()=>{
  const db=createClient({url:'file::memory:'});
  try{
    await db.execute(`CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY,event_type TEXT,event_version INTEGER,idempotency_key TEXT,
      payload_json TEXT,status TEXT)`);
    const active=ring({ACTIVE:KEY_2,VERSION:'2',WRITE:'2',
      PREVIOUS:JSON.stringify([{version:1,key:KEY_1}])});
    const v2=sealCredentialEnvelope({plaintext:'hidden-token',idempotencyKey:'credential/v1/a/1',
      ring:active,legacyAad:()=>Buffer.from('legacy-aad')});
    const legacy=sealCredentialEnvelope({plaintext:'legacy-token',ring:ring({ACTIVE:KEY_1,VERSION:'1'}),
      legacyAad:()=>Buffer.from('legacy-aad')});
    for(const [id,status,envelope,email] of [[1,'pending',v2,'person@example.test'],
      [2,'dead_letter',legacy,'other@example.test'],[3,'delivered','malformed','done@example.test']]){
      await db.execute({sql:`INSERT INTO outbox_events VALUES (?,?,?,?,?,?)`,args:[id,'credential.test',1,
        `credential/v1/${id}/1`,JSON.stringify({credential_envelope:envelope,recipient_email:email}),status]});
    }
    const metrics=await readCredentialRotationMetrics(db,{eventType:'credential.test',
      envelopeField:'credential_envelope',ring:active});
    assert.deepEqual(metrics.versions,{2:1});
    assert.equal(metrics.legacy_v1,1);
    assert.equal(metrics.actionable,2);
    assert.equal(metrics.ready,true);
    const substituted=await readCredentialRotationMetrics(db,{eventType:'credential.test',
      envelopeField:'credential_envelope',ring:ring({ACTIVE:KEY_3,VERSION:'2',WRITE:'2',
        PREVIOUS:JSON.stringify([{version:1,key:KEY_1}])})});
    assert.equal(substituted.ready,false);
    assert.equal(substituted.fingerprint_mismatch,1);
    const downgraded=await readCredentialRotationMetrics(db,{eventType:'credential.test',
      envelopeField:'credential_envelope',ring:ring({ACTIVE:KEY_1,VERSION:'1',WRITE:'2'})});
    assert.equal(downgraded.ready,false);
    assert.equal(downgraded.key_version_ahead,1);
    const serialized=JSON.stringify(metrics);
    assert.doesNotMatch(serialized,/person@|other@|hidden-token|legacy-token|[A-Za-z0-9_-]{43}/);
  }finally{ db.close(); }
});

test('versioned envelopes survive restart and isolated restore while retired keys fail readiness',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-key-restore-'));
  const sourcePath=join(directory,'source.sqlite');
  const restorePath=join(directory,'restore.sqlite');
  let source=createClient({url:`file:${sourcePath}`});
  let restored;
  try{
    await source.execute(`CREATE TABLE outbox_events (
      id INTEGER PRIMARY KEY,event_type TEXT,event_version INTEGER,idempotency_key TEXT,
      payload_json TEXT,status TEXT)`);
    const first=ring({ACTIVE:KEY_1,VERSION:'1',WRITE:'2'});
    const idempotencyKey='credential/v1/restore/1';
    const envelope=sealCredentialEnvelope({plaintext:'restore-secret',idempotencyKey,ring:first,
      legacyAad:()=>Buffer.from('legacy-aad')});
    await source.execute({sql:`INSERT INTO outbox_events VALUES (1,'credential.test',1,?,?,'pending')`,
      args:[idempotencyKey,JSON.stringify({credential_envelope:envelope,
        recipient_email:'restore-person@example.test'})]});
    source.close(); source=null;
    copyFileSync(sourcePath,restorePath);
    restored=createClient({url:`file:${restorePath}`});
    const row=(await restored.execute(`SELECT idempotency_key,
      json_extract(payload_json,'$.credential_envelope') AS envelope FROM outbox_events`)).rows[0];
    const rotated=ring({ACTIVE:KEY_2,VERSION:'2',WRITE:'2',
      PREVIOUS:JSON.stringify([{version:1,key:KEY_1}])});
    assert.equal(openCredentialEnvelope({envelope:row.envelope,idempotencyKey:row.idempotency_key,
      ring:rotated,legacyAad:()=>Buffer.from('legacy-aad')}).plaintext.toString(),'restore-secret');
    const ready=await readCredentialRotationMetrics(restored,{eventType:'credential.test',
      envelopeField:'credential_envelope',ring:rotated});
    assert.equal(ready.ready,true);
    const retired=await readCredentialRotationMetrics(restored,{eventType:'credential.test',
      envelopeField:'credential_envelope',ring:ring({ACTIVE:KEY_2,VERSION:'2',WRITE:'2'})});
    assert.equal(retired.ready,false);
    assert.equal(retired.missing_key,1);
    assert.doesNotMatch(JSON.stringify(retired),/restore-person|restore-secret/);
  }finally{
    try{ source?.close(); }catch{}
    try{ restored?.close(); }catch{}
    rmSync(directory,{recursive:true,force:true});
  }
});
