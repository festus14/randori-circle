import assert from 'node:assert/strict';
import {test} from 'node:test';

import {
  assertCredentialEnvelopeKey,
  assertPurposeKeyIsolation,
  credentialEnvelopeHeader,
  credentialRotationMetricsFromEnvelopes,
  CredentialEnvelopeError,
  MAX_PREVIOUS_KEYS,
  openCredentialEnvelope,
  parseKeyRing,
  readCredentialRotationMetrics,
  rotationKeyFingerprint,
  sealCredentialEnvelope,
} from '../../api/_key-rotation.js';

const KEY=(fill)=>Buffer.alloc(32,fill).toString('base64url');
const RING_ENV=Object.freeze({
  keyEnv:'K',versionEnv:'KV',previousKeysEnv:'KP',writeVersionEnv:'KW',
});
const legacyAad=()=>Buffer.from('legacy-aad');

function ring(env,{purpose='password-reset',...overrides}={}){
  return parseKeyRing({env,purpose,...RING_ENV,...overrides});
}

function configError(fn,code){
  assert.throws(fn,error=>error.code===code&&!(error instanceof TypeError));
}

function envelopeError(fn,code,retryable){
  assert.throws(fn,error=>error instanceof CredentialEnvelopeError
    &&error.code===code&&error.retryable===retryable);
}

test('parseKeyRing rejects malformed definitions, active keys and versions',()=>{
  assert.throws(()=>parseKeyRing(),TypeError);
  assert.throws(()=>parseKeyRing({env:{},purpose:'',...RING_ENV}),TypeError);
  assert.throws(()=>parseKeyRing({env:{},purpose:'p',...RING_ENV,keyEnv:1}),TypeError);
  assert.throws(()=>parseKeyRing({env:{},purpose:'p',...RING_ENV,versionEnv:null}),TypeError);
  assert.throws(()=>parseKeyRing({env:{},purpose:'p',...RING_ENV,previousKeysEnv:{}}),TypeError);

  // Missing key with no fallback, a fallback returning a short buffer, and a
  // non-canonical base64url encoding (43 chars whose last char carries extra bits).
  configError(()=>ring({}),'KEY_RING_ACTIVE_INVALID');
  configError(()=>ring({},{fallbackKey:()=>Buffer.alloc(16)}),'KEY_RING_ACTIVE_INVALID');
  configError(()=>ring({K:'not-a-key'}),'KEY_RING_ACTIVE_INVALID');
  const canonical=KEY(7);
  const nonCanonical=canonical.slice(0,42)+(canonical.at(-1)==='B'?'C':'B');
  configError(()=>ring({K:nonCanonical}),'KEY_RING_ACTIVE_INVALID');

  // A fallback key is accepted only when no explicit key is set.
  const fallback=ring({},{fallbackKey:()=>Buffer.alloc(32,9)});
  assert.equal(fallback.active.version,1);
  assert.equal(fallback.active.key.equals(Buffer.alloc(32,9)),true);

  for(const bad of ['0','-1','1.5','01','abc','2147483647','1000000000']){
    configError(()=>ring({K:KEY(1),KV:bad}),'KEY_RING_VERSION_INVALID');
  }
  // The pattern caps versions at nine digits.
  assert.equal(ring({K:KEY(1),KV:' 999999999 '}).active.version,999999999);
});

test('previous keys must be a bounded, strictly ordered, distinct JSON list',()=>{
  const base={K:KEY(1),KV:'5'};
  const prev=(value)=>({...base,KP:typeof value==='string'?value:JSON.stringify(value)});
  configError(()=>ring(prev('{oops')),'KEY_RING_PREVIOUS_INVALID');
  configError(()=>ring(prev({key:KEY(2),version:4})),'KEY_RING_PREVIOUS_INVALID');
  configError(()=>ring(prev(Array.from({length:MAX_PREVIOUS_KEYS+1},(_,i)=>(
    {key:KEY(10+i),version:4-i})))),'KEY_RING_PREVIOUS_INVALID');
  for(const entry of [null,'x',[KEY(2),4],{key:KEY(2)},{key:KEY(2),version:4,extra:1}]){
    configError(()=>ring(prev([entry])),'KEY_RING_PREVIOUS_INVALID');
  }
  configError(()=>ring(prev([{key:'short',version:4}])),'KEY_RING_PREVIOUS_INVALID');
  configError(()=>ring(prev([{key:null,version:4}])),'KEY_RING_PREVIOUS_INVALID');
  configError(()=>ring(prev([{key:KEY(2),version:0}])),'KEY_RING_PREVIOUS_INVALID');

  configError(()=>ring(prev([{key:KEY(2),version:5}])),'KEY_RING_PREVIOUS_UNORDERED');
  configError(()=>ring(prev([{key:KEY(2),version:3},{key:KEY(3),version:4}])),
    'KEY_RING_PREVIOUS_UNORDERED');
  configError(()=>ring(prev([{key:KEY(1),version:4}])),'KEY_RING_MATERIAL_DUPLICATE');

  // Strictly descending ordering means a repeated version is always reported
  // as unordered (the separate duplicate-version guard is defence in depth).
  configError(()=>ring(prev([{key:KEY(2),version:4},{key:KEY(3),version:4}])),
    'KEY_RING_PREVIOUS_UNORDERED');

  const ok=ring(prev([{key:KEY(2),version:4},{key:KEY(3),version:'2'}]));
  assert.deepEqual(ok.ordered.map(item=>item.version),[5,4,2]);
  assert.deepEqual(ok.previous.map(item=>item.position),[0,1]);
  assert.equal(ok.byVersion.get(2).key.equals(Buffer.alloc(32,3)),true);
  assert.equal(ring({...base,KP:'   '}).previous.length,0);
});

test('duplicate key material is detected by fingerprint, not raw bytes',()=>{
  // A fingerprint function that maps every key to the same digest proves the
  // material-duplicate check uses the fingerprint, not the raw key.
  configError(()=>parseKeyRing({env:{K:KEY(1),KV:'3',KP:JSON.stringify([{key:KEY(2),version:2}])},
    purpose:'p',...RING_ENV,fingerprint:()=>'f'.repeat(64)}),'KEY_RING_MATERIAL_DUPLICATE');
});

test('write envelope version defaults to v1 and only accepts 1 or 2',()=>{
  assert.equal(ring({K:KEY(1)}).writeEnvelopeVersion,1);
  assert.equal(ring({K:KEY(1),KW:'2'}).writeEnvelopeVersion,2);
  assert.equal(ring({K:KEY(1),KW:'3'},{writeVersionEnv:null}).writeEnvelopeVersion,1);
  configError(()=>ring({K:KEY(1),KW:'3'}),'KEY_RING_WRITE_VERSION_INVALID');
  configError(()=>ring({K:KEY(1),KW:'v2'}),'KEY_RING_WRITE_VERSION_INVALID');
});

test('purpose isolation validates env rings and rejects cross-purpose key reuse',()=>{
  assert.throws(()=>assertPurposeKeyIsolation({env:null}),TypeError);
  assert.throws(()=>assertPurposeKeyIsolation({env:{},rings:'x'}),TypeError);
  assert.equal(assertPurposeKeyIsolation({env:{}}),true);

  // Previous keys without an active key are a configuration error.
  configError(()=>assertPurposeKeyIsolation({env:{
    PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{key:KEY(2),version:1}]),
  }}),'KEY_RING_ACTIVE_INVALID');
  // The identity hash key requires an explicit version.
  configError(()=>assertPurposeKeyIsolation({env:{IDENTITY_EMAIL_HASH_KEY:KEY(3)}}),
    'KEY_RING_VERSION_INVALID');
  assert.equal(assertPurposeKeyIsolation({env:{
    IDENTITY_EMAIL_HASH_KEY:KEY(3),IDENTITY_EMAIL_HASH_KEY_VERSION:'1',
    PASSWORD_RESET_ENCRYPTION_KEY:KEY(4),
  }}),true);

  // An active key reused as another purpose's previous key is rejected.
  configError(()=>assertPurposeKeyIsolation({env:{
    PASSWORD_RESET_ENCRYPTION_KEY:KEY(4),
    EMAIL_VERIFICATION_ENCRYPTION_KEY:KEY(5),EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION:'2',
    EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS:JSON.stringify([{key:KEY(4),version:1}]),
  }}),'KEY_RING_CROSS_PURPOSE_REUSE');

  // Extra rings: shape is validated and reuse across purposes is rejected,
  // while the same purpose may legitimately list the same material twice.
  for(const bad of [null,{purpose:1,ordered:[]},{purpose:'x',ordered:null},
    {purpose:'x',ordered:[{key:'k'}]},{purpose:'x',ordered:[{key:Buffer.alloc(31)}]},
    {purpose:'x',ordered:[null]}]){
    assert.throws(()=>assertPurposeKeyIsolation({env:{},rings:[bad]}),TypeError);
  }
  const material=Buffer.alloc(32,4);
  configError(()=>assertPurposeKeyIsolation({env:{PASSWORD_RESET_ENCRYPTION_KEY:KEY(4)},
    rings:[{purpose:'invitation-email',ordered:[{key:material}]}]}),'KEY_RING_CROSS_PURPOSE_REUSE');
  assert.equal(assertPurposeKeyIsolation({env:{PASSWORD_RESET_ENCRYPTION_KEY:KEY(4)},
    rings:[{purpose:'password-reset',ordered:[{key:material}]}]}),true);
});

test('sealing validates input and v1 envelopes open with any configured key',()=>{
  const current=ring({K:KEY(1),KV:'2',KP:JSON.stringify([{key:KEY(2),version:1}])});
  for(const input of [
    {plaintext:'x',legacyAad},
    {plaintext:'',ring:current,legacyAad},
    {plaintext:Buffer.alloc(4097),ring:current,legacyAad},
    {plaintext:'x',ring:current},
  ]){
    assert.throws(()=>sealCredentialEnvelope(input),TypeError);
  }
  assert.throws(()=>sealCredentialEnvelope(),TypeError);

  // Sealed by the previous key (as an older deployment would have done).
  const old=ring({K:KEY(2)});
  const sealed=sealCredentialEnvelope({plaintext:Buffer.from('secret'),ring:old,legacyAad});
  assert.equal(credentialEnvelopeHeader(sealed).kind,'legacy');
  const opened=openCredentialEnvelope({envelope:sealed,ring:current,legacyAad});
  assert.equal(opened.plaintext.toString(),'secret');
  assert.equal(opened.keyVersion,1);
  assert.equal(opened.envelopeVersion,1);

  // A retired key cannot be identified for v1, so failure is retryable.
  const retired=ring({K:KEY(9)});
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:retired,legacyAad}),
    'KEY_VERSION_UNAVAILABLE',true);
  // Different AAD (wrong binding) behaves the same way.
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:current,
    legacyAad:()=>Buffer.from('other')}),'KEY_VERSION_UNAVAILABLE',true);

  // Structural problems are final.
  const [iv,ct,tag]=sealed.split('.');
  for(const envelope of [`${iv}x.${ct}.${tag}`,`${iv}.${ct}.${tag.slice(0,-2)}`,
    `${iv}.${''}.${tag}`,`${iv}.${ct}=.${tag}`]){
    envelopeError(()=>openCredentialEnvelope({envelope,ring:current,legacyAad}),'ENVELOPE_INVALID',false);
  }
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:current,legacyAad,maxPlaintextBytes:3}),
    'ENVELOPE_INVALID',false);
});

test('v2 envelopes bind purpose, key version, fingerprint and idempotency key',()=>{
  const current=ring({K:KEY(1),KV:'3',KW:'2',KP:JSON.stringify([{key:KEY(2),version:2}])});
  assert.throws(()=>sealCredentialEnvelope({plaintext:'x',ring:current,legacyAad,idempotencyKey:'-bad'}),
    error=>error instanceof CredentialEnvelopeError&&error.code==='ENVELOPE_CONTEXT_INVALID');

  const sealed=sealCredentialEnvelope({plaintext:'token',ring:current,legacyAad,idempotencyKey:'evt:1'});
  const header=credentialEnvelopeHeader(sealed);
  assert.deepEqual({...header},{kind:'versioned',envelopeVersion:2,keyVersion:3,
    fingerprint:rotationKeyFingerprint(Buffer.alloc(32,1),'password-reset')});
  const opened=openCredentialEnvelope({envelope:sealed,ring:current,legacyAad,idempotencyKey:'evt:1'});
  assert.equal(opened.plaintext.toString(),'token');
  assert.equal(opened.envelopeVersion,2);

  // Wrong idempotency key or a ring for another purpose with the same key.
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:current,legacyAad,idempotencyKey:'evt:2'}),
    'ENVELOPE_INVALID',false);
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:current,legacyAad}),
    'ENVELOPE_CONTEXT_INVALID',false);
  const otherPurpose=ring({K:KEY(1),KV:'3',KW:'2'},{purpose:'email-activation'});
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:otherPurpose,legacyAad,idempotencyKey:'evt:1'}),
    'KEY_FINGERPRINT_MISMATCH',true);

  // Key version removed from the ring (retired too early) is retryable.
  const rolledBack=ring({K:KEY(2),KV:'2',KW:'2'});
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:rolledBack,legacyAad,idempotencyKey:'evt:1'}),
    'KEY_VERSION_UNAVAILABLE',true);

  // Plaintext bounds are enforced after authentication.
  envelopeError(()=>openCredentialEnvelope({envelope:sealed,ring:current,legacyAad,idempotencyKey:'evt:1',
    minPlaintextBytes:1,maxPlaintextBytes:4}),'ENVELOPE_INVALID',false);

  // Corrupt iv/ciphertext/tag segments.
  const parts=sealed.split('.');
  for(const index of [3,4,5]){
    const broken=[...parts];
    broken[index]=`${broken[index]}*`;
    envelopeError(()=>openCredentialEnvelope({envelope:broken.join('.'),ring:current,legacyAad,
      idempotencyKey:'evt:1'}),'ENVELOPE_INVALID',false);
  }
});

test('envelope headers classify future, malformed and legacy shapes; open fails accordingly',()=>{
  const current=ring({K:KEY(1)});
  const fp='a'.repeat(64);
  assert.deepEqual({...credentialEnvelopeHeader(42)},{kind:'malformed'});
  assert.equal(credentialEnvelopeHeader('v3.1.x').kind,'future');
  assert.equal(credentialEnvelopeHeader('v3.1.x').envelopeVersion,3);
  assert.equal(credentialEnvelopeHeader(`v2.0.${fp}.a.b.c`).kind,'malformed');
  assert.equal(credentialEnvelopeHeader(`v2.1.${'A'.repeat(64)}.a.b.c`).kind,'malformed');
  assert.equal(credentialEnvelopeHeader(`v2.1.${fp}.a.b`).kind,'malformed');
  assert.equal(credentialEnvelopeHeader('v2').kind,'malformed');
  assert.equal(credentialEnvelopeHeader('a.b').kind,'malformed');
  assert.equal(credentialEnvelopeHeader('a.b.c').kind,'legacy');

  assert.throws(()=>openCredentialEnvelope({envelope:'a.b.c',legacyAad}),TypeError);
  assert.throws(()=>openCredentialEnvelope({envelope:'a.b.c',ring:current}),TypeError);
  assert.throws(()=>openCredentialEnvelope(),TypeError);
  envelopeError(()=>openCredentialEnvelope({envelope:'v9.1.x',ring:current,legacyAad}),
    'ENVELOPE_VERSION_UNAVAILABLE',true);
  envelopeError(()=>openCredentialEnvelope({envelope:null,ring:current,legacyAad}),'ENVELOPE_INVALID',false);
});

test('assertCredentialEnvelopeKey checks the key without decrypting',()=>{
  const current=ring({K:KEY(1),KV:'2',KW:'2'});
  const sealed=sealCredentialEnvelope({plaintext:'t',ring:current,legacyAad,idempotencyKey:'evt'});
  assert.equal(assertCredentialEnvelopeKey({envelope:sealed,ring:current}).keyVersion,2);
  assert.equal(assertCredentialEnvelopeKey({envelope:'a.b.c',ring:current}).kind,'legacy');
  envelopeError(()=>assertCredentialEnvelopeKey({envelope:'v7.1.x',ring:current}),
    'ENVELOPE_VERSION_UNAVAILABLE',true);
  envelopeError(()=>assertCredentialEnvelopeKey({envelope:'garbage',ring:current}),'ENVELOPE_INVALID',false);
  envelopeError(()=>assertCredentialEnvelopeKey({envelope:sealed,ring:ring({K:KEY(1),KV:'1'})}),
    'KEY_VERSION_UNAVAILABLE',true);
  envelopeError(()=>assertCredentialEnvelopeKey({envelope:sealed,ring:ring({K:KEY(5),KV:'2'})}),
    'KEY_FINGERPRINT_MISMATCH',true);
});

test('rotation metrics count every envelope class and are conservative about readiness',()=>{
  const current=ring({K:KEY(1),KV:'3',KW:'2',KP:JSON.stringify([{key:KEY(2),version:2}])});
  const seal=(r,key)=>sealCredentialEnvelope({plaintext:'t',ring:r,legacyAad,idempotencyKey:key});
  const v3=seal(current,'a');
  const v2=seal(ring({K:KEY(2),KV:'2',KW:'2'}),'b');
  const v1Missing=seal(ring({K:KEY(7),KV:'1',KW:'2'}),'c');
  const v4Ahead=seal(ring({K:KEY(8),KV:'4',KW:'2'}),'d');
  const v3Wrong=seal(ring({K:KEY(9),KV:'3',KW:'2'}),'e');

  assert.throws(()=>credentialRotationMetricsFromEnvelopes(),TypeError);
  assert.throws(()=>credentialRotationMetricsFromEnvelopes({ring:current,actionableEnvelopes:'x'}),TypeError);
  assert.throws(()=>credentialRotationMetricsFromEnvelopes({ring:current,retainedEnvelopes:null}),TypeError);
  assert.throws(()=>credentialRotationMetricsFromEnvelopes({ring:current,
    actionableEnvelopes:Array(10001).fill(v3)}),/limit exceeded/);
  assert.throws(()=>credentialRotationMetricsFromEnvelopes({ring:current,
    retainedEnvelopes:Array(10001).fill(v3)}),/limit exceeded/);
  assert.throws(()=>credentialRotationMetricsFromEnvelopes({ring:current,
    actionableEnvelopes:Array(6000).fill(v3),retainedEnvelopes:Array(4001).fill(v3)}),/limit exceeded/);

  const clean=credentialRotationMetricsFromEnvelopes({ring:current,actionableEnvelopes:[v3,v2]});
  assert.equal(clean.ready,true);
  assert.deepEqual({...clean.versions},{2:1,3:1});
  assert.deepEqual([...clean.previous_versions],[2]);

  const dirty=credentialRotationMetricsFromEnvelopes({ring:current,
    actionableEnvelopes:[v3,'a.b.c',null,'v5.1.x',v1Missing,v4Ahead],retainedEnvelopes:[v3Wrong]});
  assert.equal(dirty.ready,false);
  assert.equal(dirty.actionable,6);
  assert.equal(dirty.retained,1);
  assert.deepEqual([dirty.legacy_v1,dirty.malformed,dirty.future,dirty.missing_key,
    dirty.fingerprint_mismatch,dirty.key_version_ahead],[1,1,1,2,1,1]);
  assert.deepEqual({...dirty.versions},{1:1,3:2,4:1});

  // Each single defect alone is enough to block retirement.
  for(const envelope of ['a.b.c','junk','v5.1.x',v1Missing,v3Wrong]){
    assert.equal(credentialRotationMetricsFromEnvelopes({ring:current,retainedEnvelopes:[envelope]}).ready,false);
  }
});

test('readCredentialRotationMetrics validates its query and reads only actionable outbox rows',async()=>{
  const current=ring({K:KEY(1),KW:'2'});
  const db={calls:[],async execute(statement){ this.calls.push(statement); return {rows:[{envelope:'a.b.c'}]}; }};
  for(const options of [
    {eventType:1,envelopeField:'e',ring:current},
    {eventType:'t',envelopeField:'bad-field',ring:current},
    {eventType:'t',envelopeField:'e'},
    {eventType:'t',envelopeField:'e',ring:current,retainedEnvelopes:'x'},
  ]){
    await assert.rejects(readCredentialRotationMetrics(db,options),TypeError);
  }
  await assert.rejects(readCredentialRotationMetrics(null,{eventType:'t',envelopeField:'e',ring:current}),TypeError);
  await assert.rejects(readCredentialRotationMetrics({},{eventType:'t',envelopeField:'e',ring:current}),TypeError);
  assert.equal(db.calls.length,0);

  const metrics=await readCredentialRotationMetrics(db,{eventType:'password.reset',envelopeField:'token_envelope',ring:current});
  assert.equal(metrics.legacy_v1,1);
  assert.equal(metrics.ready,false);
  assert.deepEqual(db.calls[0].args,['$.token_envelope','password.reset']);
  assert.match(db.calls[0].sql,/status IN \('pending','processing','retry','dead_letter'\)/);

  const empty=await readCredentialRotationMetrics({async execute(){ return {}; }},
    {eventType:'t',envelopeField:'e',ring:current});
  assert.equal(empty.actionable,0);
  assert.equal(empty.ready,true);
});
