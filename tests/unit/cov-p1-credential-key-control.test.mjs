import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';

import {
  CredentialKeyControlError,
  assertCredentialKeyControl,
  credentialKeyControlStatus,
  transitionCredentialKeyControl,
  withCredentialKeyControlStatus,
} from '../../api/_credential-key-control.js';
import {
  credentialKeyControlPurpose,
  parseCredentialKeyControlRow,
  readCredentialKeyControlRows,
  inspectCredentialKeyControlReadiness,
} from '../../db/credential-key-control.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import {
  CredentialKeyControlCommandError,
  configuredPurposeRing,
  publicCredentialKeyControlResult,
  runCredentialKeyControl,
  validateCredentialKeyControlRuntime,
} from '../../scripts/credential-key-control.mjs';

const NO_RETRY={maxAttempts:1,baseDelayMs:0,maxDelayMs:0};
const ENV_KEYS=['IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION',
  'IDENTITY_EMAIL_HASH_PREVIOUS_KEYS','JWT_SECRET','EMAIL_VERIFICATION_ENCRYPTION_KEY'];
const resources=[];

afterEach(async()=>{
  for(const name of ENV_KEYS) delete process.env[name];
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

const fp=character=>character.repeat(64);
const key=byte=>Buffer.alloc(32,byte).toString('base64url');
const TS='2026-01-01T00:00:00.000Z';
const LATER='2026-01-02T00:00:00.000Z';

function ring(purpose,version,fingerprint,{previous=[]}={}){
  const active=Object.freeze({version,fingerprint});
  const ordered=Object.freeze([active,...previous]);
  return Object.freeze({purpose,active,previous:Object.freeze(previous),ordered,
    byVersion:new Map(ordered.map(item=>[item.version,item]))});
}

function row(overrides={}){
  return {purpose:'email-activation',control_version:1,state:'accepted',highest_key_version:2,
    highest_key_fingerprint:fp('a'),generation:3,installed_by_migration:15,installed_at:TS,
    updated_at:LATER,...overrides};
}

async function database(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-key-control-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,
    expectedStateFingerprint:initial.stateFingerprint,retry:NO_RETRY});
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

const controlError=code=>error=>error instanceof CredentialKeyControlError&&error.code===code;
const commandError=code=>error=>error instanceof CredentialKeyControlCommandError&&error.code===code;

// Wraps a real client so individual transaction behaviours can be injected.
function wrapped(db,{onTransaction,transactionExecute,commit,rollback,close}={}){
  return {
    execute:statement=>db.execute(statement),
    async transaction(mode){
      await onTransaction?.();
      const transaction=await db.transaction(mode);
      return {
        execute:statement=>transactionExecute
          ?transactionExecute(statement,transaction)
          :transaction.execute(statement),
        commit:()=>commit?commit(transaction):transaction.commit(),
        rollback:()=>rollback?rollback(transaction):transaction.rollback(),
        close:()=>close?close(transaction):transaction.close?.(),
      };
    },
  };
}

test('stored control rows parse only exact uninitialized or accepted shapes',()=>{
  assert.equal(credentialKeyControlPurpose(undefined),null);
  assert.equal(credentialKeyControlPurpose('session-signing'),null);
  assert.equal(credentialKeyControlPurpose('password-reset'),'password-reset');

  assert.deepEqual(parseCredentialKeyControlRow(row()),{purpose:'email-activation',state:'accepted',
    controlVersion:1,generation:3,installedByMigration:15,installedAt:TS,updatedAt:LATER,
    highestKeyVersion:2,highestKeyFingerprint:fp('a')});
  const uninitialized=parseCredentialKeyControlRow(row({state:'uninitialized',generation:0,
    highest_key_version:null,highest_key_fingerprint:null}));
  assert.equal(uninitialized.state,'uninitialized');
  assert.equal(uninitialized.highestKeyVersion,null);

  for(const bad of [null,'row',[row()]]) assert.equal(parseCredentialKeyControlRow(bad),null);
  const rejected=[
    {purpose:'unknown'},
    {control_version:2},
    {generation:'not-a-number'},
    {generation:2147483648},
    {installed_by_migration:14},
    {installed_at:undefined},
    {updated_at:null},
    {installed_at:'2026-01-01T00:00:00Z'},
    {installed_at:'XXXX-01-01T00:00:00.000Z'},
    {installed_at:LATER,updated_at:TS},
    {state:undefined},
    {state:'pending'},
    {generation:0},
    {highest_key_version:0},
    {highest_key_fingerprint:undefined},
    {highest_key_fingerprint:fp('A')},
    // An uninitialized row may not carry a key pair or a generation.
    {state:'uninitialized',generation:0,highest_key_version:1,highest_key_fingerprint:null},
    {state:'uninitialized',generation:1,highest_key_version:null,highest_key_fingerprint:null},
  ];
  for(const overrides of rejected){
    assert.equal(parseCredentialKeyControlRow(row(overrides)),null,JSON.stringify(overrides));
  }
});

test('control readiness requires exactly the four ordered valid purposes',async()=>{
  await assert.rejects(readCredentialKeyControlRows(null),TypeError);
  await assert.rejects(readCredentialKeyControlRows({}),TypeError);
  const purposes=['email-activation','identity-email-observation','invitation-email','password-reset'];
  const exact=purposes.map(purpose=>row({purpose}));
  const fake=rows=>({execute:async()=>({rows})});

  const ready=await inspectCredentialKeyControlReadiness(fake(exact));
  assert.deepEqual({ok:ready.ok,initialized:ready.initialized,total:ready.total,blockers:ready.blockers},
    {ok:true,initialized:4,total:4,blockers:[]});
  assert.match(ready.stateDigest,/^[a-f0-9]{64}$/);
  const changed=await inspectCredentialKeyControlReadiness(fake(exact.map((item,index)=>index===0
    ?{...item,generation:4}:item)));
  assert.notEqual(changed.stateDigest,ready.stateDigest,'digest binds the generation');

  const closed={ok:false,rows:[],blockers:['credential_key_controls_invalid']};
  assert.deepEqual(await readCredentialKeyControlRows({execute:async()=>({})}),closed);
  assert.deepEqual(await readCredentialKeyControlRows(fake([...exact].reverse())),closed);
  assert.deepEqual(await readCredentialKeyControlRows(fake(exact.slice(0,3))),closed);
  assert.deepEqual(await readCredentialKeyControlRows(fake([...exact.slice(0,3),
    row({purpose:'password-reset',state:'pending'})])),closed);
});

test('status rejects malformed rings and inconsistent stored records',async()=>{
  const valid=ring('email-activation',1,fp('a'));
  const badRings=[
    null,
    {...valid,purpose:'other'},
    {...valid,active:{version:0,fingerprint:fp('a')}},
    {...valid,active:{version:2147483648,fingerprint:fp('a')}},
    {...valid,active:{version:1}},
    {...valid,active:{version:1,fingerprint:'abc'}},
    {...valid,byVersion:{}},
    {...valid,byVersion:new Map()},
    {...valid,byVersion:new Map([[1,{version:1,fingerprint:fp('b')}]])},
    {...valid,byVersion:new Map([[1,{version:'1',fingerprint:fp('a')}]])},
  ];
  const db=await database();
  for(const bad of badRings) await assert.rejects(credentialKeyControlStatus(db,bad),TypeError);
  await assert.rejects(credentialKeyControlStatus(null,valid),TypeError);
  await assert.rejects(credentialKeyControlStatus({execute:async()=>({rows:[]})},valid),
    controlError('KEY_CONTROL_STATE_INVALID'));
  await assert.rejects(credentialKeyControlStatus({execute:async()=>({})},valid),
    controlError('KEY_CONTROL_STATE_INVALID'));
  await assert.rejects(credentialKeyControlStatus({execute:async()=>({rows:[row(),row()]})},valid),
    controlError('KEY_CONTROL_STATE_INVALID'));
  // A row for a different purpose must never satisfy this purpose.
  await assert.rejects(credentialKeyControlStatus({execute:async()=>({
    rows:[row({purpose:'password-reset'})]})},valid),controlError('KEY_CONTROL_STATE_INVALID'));
  await assert.rejects(credentialKeyControlStatus({execute:async()=>({
    rows:[row({state:'pending'})]})},valid),controlError('KEY_CONTROL_STATE_INVALID'));
});

test('assertCredentialKeyControl fails closed with the evaluated reason and passes only accepted pairs',async()=>{
  const db=await database();
  const configured=ring('password-reset',2,fp('b'));
  await assert.rejects(assertCredentialKeyControl(db,configured),
    controlError('KEY_CONTROL_UNINITIALIZED'));
  await transitionCredentialKeyControl(db,{operation:'adopt',ring:configured});
  assert.deepEqual(await assertCredentialKeyControl(db,configured),{ready:true,state:'accepted',
    reason:null,configured_version:2,accepted_version:2,generation:1});
  await assert.rejects(assertCredentialKeyControl(db,ring('password-reset',2,fp('c'))),
    controlError('KEY_CONTROL_SUBSTITUTION'));
  await assert.rejects(assertCredentialKeyControl(db,ring('password-reset',1,fp('a'))),
    controlError('KEY_CONTROL_DOWNGRADE'));
});

test('rotation metrics are ready only when both material and control are ready',()=>{
  for(const [metrics,status] of [[null,{}],[{},null],['x',{}],[{},'x']]){
    assert.throws(()=>withCredentialKeyControlStatus(metrics,status),TypeError);
  }
  const status={ready:true,state:'accepted',reason:null,accepted_version:3,generation:2};
  assert.deepEqual(withCredentialKeyControlStatus({ready:true,malformed:0},status),{ready:true,
    malformed:0,control_state:'accepted',control_reason:null,accepted_version:3,control_generation:2});
  assert.equal(withCredentialKeyControlStatus({ready:true},{...status,ready:false}).ready,false);
  assert.equal(withCredentialKeyControlStatus({ready:'true'},status).ready,false,
    'only a strict boolean material ready counts');
});

test('transition rejects invalid requests before opening a transaction',async()=>{
  const configured=ring('email-activation',1,fp('a'));
  let opened=0;
  const db={transaction:async()=>{ opened+=1; throw new Error('unreachable'); }};
  await assert.rejects(transitionCredentialKeyControl(null,{operation:'adopt',ring:configured}),TypeError);
  await assert.rejects(transitionCredentialKeyControl(db),TypeError);
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'reset',ring:configured}),TypeError);
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'adopt',ring:{}}),TypeError);
  for(const [expectedVersion,expectedGeneration] of [[null,1],[1,null],[0,1],[1,0],
    [2147483648,1],[1,2147483648],[1.5,1]]){
    await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',ring:configured,
      expectedVersion,expectedGeneration}),/valid expected credential key control state required/);
  }
  assert.equal(opened,0);
});

test('advance refuses uninitialized controls, substitution, and downgrade without writing',async()=>{
  const db=await database();
  const v2=ring('invitation-email',2,fp('b'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',ring:v2,
    expectedVersion:1,expectedGeneration:1}),controlError('KEY_CONTROL_UNINITIALIZED'));
  await transitionCredentialKeyControl(db,{operation:'adopt',ring:v2});
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',
    ring:ring('invitation-email',2,fp('c')),expectedVersion:2,expectedGeneration:1}),
  controlError('KEY_CONTROL_SUBSTITUTION'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',
    ring:ring('invitation-email',1,fp('a')),expectedVersion:2,expectedGeneration:1}),
  controlError('KEY_CONTROL_DOWNGRADE'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',
    ring:ring('invitation-email',3,fp('c'),{previous:[v2.active]}),expectedVersion:2,
    expectedGeneration:2}),controlError('KEY_CONTROL_STATE_CHANGED'));
  assert.deepEqual(await credentialKeyControlStatus(db,v2),{ready:true,state:'accepted',reason:null,
    configured_version:2,accepted_version:2,generation:1});
});

test('a candidate validator veto and a lost compare-and-swap both roll back',async()=>{
  const db=await database();
  const configured=ring('email-activation',1,fp('a'));
  const veto=Object.assign(new Error('material vetoed'),{code:'VETO'});
  let validated=null;
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'adopt',ring:configured,
    validateCandidate:async(transaction,candidate,context)=>{
      validated={candidate,context,hasExecute:typeof transaction.execute==='function'};
      throw veto;
    }}),error=>error===veto);
  assert.deepEqual(validated,{candidate:configured,context:{operation:'adopt'},hasExecute:true});
  assert.equal((await credentialKeyControlStatus(db,configured)).state,'uninitialized');

  const lostRace=wrapped(db,{transactionExecute:(statement,transaction)=>
    /^UPDATE credential_key_controls/.test(statement.sql||'')
      ?Promise.resolve({rows:[]})
      :transaction.execute(statement)});
  await assert.rejects(transitionCredentialKeyControl(lostRace,{operation:'adopt',ring:configured}),
    controlError('KEY_CONTROL_STATE_CHANGED'));
  const wrongGeneration=wrapped(db,{transactionExecute:(statement,transaction)=>
    /^UPDATE credential_key_controls/.test(statement.sql||'')
      ?Promise.resolve({rows:[{generation:7}]})
      :transaction.execute(statement)});
  await assert.rejects(transitionCredentialKeyControl(wrongGeneration,{operation:'adopt',ring:configured}),
    controlError('KEY_CONTROL_STATE_CHANGED'));
  assert.equal((await credentialKeyControlStatus(db,configured)).state,'uninitialized');
});

test('cleanup failures never mask a committed result and ambiguous commits reconcile fail closed',async()=>{
  const db=await database();
  const configured=ring('password-reset',1,fp('a'));
  const noisyClose=wrapped(db,{close:async transaction=>{
    transaction.close?.();
    throw new Error('close failed');
  }});
  assert.equal((await transitionCredentialKeyControl(noisyClose,{operation:'adopt',ring:configured})).changed,
    true);

  // Ambiguous commit where the read-back itself fails must not claim success.
  const other=ring('invitation-email',1,fp('b'));
  let commits=0;
  const unreadable={
    execute:async()=>{ throw new Error('read-back unavailable'); },
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {execute:statement=>transaction.execute(statement),
        rollback:async()=>{ await transaction.rollback(); throw new Error('rollback failed'); },
        close:()=>transaction.close?.(),
        async commit(){ commits+=1; throw Object.assign(new Error('socket closed'),{code:'ECONNRESET'}); }};
    },
  };
  await assert.rejects(transitionCredentialKeyControl(unreadable,{operation:'adopt',ring:other}),
    controlError('KEY_CONTROL_COMMIT_UNKNOWN'));
  assert.equal(commits,1,'an ambiguous commit is never replayed');
});

test('transient lock conflicts are retried with bounded attempts; other errors are not',async()=>{
  const db=await database();
  const lockErrors=[
    Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}),
    Object.assign(new Error('busy'),{rawCode:'libsql_transaction_busy'}),
    new Error('SQLITE_LOCKED: database table is locked'),
    new Error('wrapped',{cause:new Error('database is locked')}),
  ];
  for(const [index,lock] of lockErrors.entries()){
    let attempts=0;
    const flaky=wrapped(db,{onTransaction:()=>{ attempts+=1; if(attempts===1) throw lock; }});
    const purpose=['email-activation','password-reset','invitation-email','identity-email-observation'][index];
    const result=await transitionCredentialKeyControl(flaky,{operation:'adopt',ring:ring(purpose,1,fp('a'))});
    assert.equal(result.changed,true);
    assert.equal(attempts,2,`retried ${lock.message}`);
  }

  let attempts=0;
  const alwaysBusy={transaction:async()=>{
    attempts+=1;
    throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY_SNAPSHOT'});
  }};
  await assert.rejects(transitionCredentialKeyControl(alwaysBusy,{operation:'adopt',
    ring:ring('email-activation',2,fp('b'))}),error=>error.code==='SQLITE_BUSY_SNAPSHOT');
  assert.equal(attempts,5);

  attempts=0;
  const deepLock={transaction:async()=>{
    attempts+=1;
    let error=Object.assign(new Error('busy'),{code:'SQLITE_BUSY'});
    for(let depth=0;depth<6;depth+=1) error=new Error(`layer ${depth}`,{cause:error});
    throw error;
  }};
  await assert.rejects(transitionCredentialKeyControl(deepLock,{operation:'adopt',
    ring:ring('email-activation',2,fp('b'))}),/layer 5/);
  assert.equal(attempts,1,'lock codes buried beyond six causes are not retried');

  attempts=0;
  const fatal={transaction:async()=>{ attempts+=1; throw new Error('disk I/O error'); }};
  await assert.rejects(transitionCredentialKeyControl(fatal,{operation:'adopt',
    ring:ring('email-activation',2,fp('b'))}),/disk I\/O error/);
  assert.equal(attempts,1);
});

test('operator options validate operation, purpose, confirmation, mutation gate, and CAS input',async()=>{
  process.env.JWT_SECRET='credential-control-test-secret-at-least-32-bytes';
  const db=await database();
  const base={operation:'adopt',purpose:'email-activation',
    confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',mutationsEnabled:'true'};
  const cases=[
    [{},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'delete'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,purpose:'session-signing'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,confirmation:undefined},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,confirmation:'INSPECT_CREDENTIAL_KEY_CONTROL'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'status'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,mutationsEnabled:'false'},'KEY_CONTROL_DISABLED'],
    [{...base,mutationsEnabled:undefined},'KEY_CONTROL_DISABLED'],
    [{...base,expectedVersion:'1'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,expectedGeneration:' 2 '},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance',expectedVersion:'01',expectedGeneration:'1'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance',expectedVersion:'0',expectedGeneration:'1'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance',expectedVersion:'1',expectedGeneration:'2147483648'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance',expectedVersion:'99999999999999999999',expectedGeneration:'1'},'KEY_CONTROL_INPUT_INVALID'],
    [{...base,operation:'advance',expectedVersion:'-1',expectedGeneration:'1'},'KEY_CONTROL_INPUT_INVALID'],
    [{operation:'status',purpose:'identity-email-observation',confirmation:'INSPECT_CREDENTIAL_KEY_CONTROL'},
      'KEY_CONTROL_CONFIGURATION_INVALID'],
  ];
  for(const [input,code] of cases){
    await assert.rejects(runCredentialKeyControl(db,input),commandError(code),JSON.stringify(input));
  }
  // The boolean form of the mutation gate is accepted, and no rejected attempt wrote anything.
  const adopted=await runCredentialKeyControl(db,{...base,mutationsEnabled:true});
  assert.deepEqual({...adopted},{ok:true,purpose:'email-activation',version:1,generation:1,
    changed:true,reconciled:false,operation:'adopt'});
  assert.throws(()=>configuredPurposeRing('session-signing'),
    commandError('KEY_CONTROL_CONFIGURATION_INVALID'));
  const error=new CredentialKeyControlCommandError('X','message');
  assert.equal(error.cause,undefined);
  assert.equal(error.name,'CredentialKeyControlCommandError');
});

test('identity adoption is refused while stored observations contradict the configured key',async()=>{
  const db=await database();
  process.env.IDENTITY_EMAIL_HASH_KEY=key(10);
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='2';
  const configured=configuredPurposeRing('identity-email-observation');
  const scenarios=[
    [{hash_key_version:3,hash_key_fingerprint:fp('a'),count:1},'future_version'],
    [{hash_key_version:2,hash_key_fingerprint:fp('f'),count:2},'fingerprint_mismatch'],
    [{hash_key_version:1,hash_key_fingerprint:fp('a'),count:1},'missing_key'],
  ];
  for(const [stored,label] of scenarios){
    const observed=wrapped(db,{transactionExecute:(statement,transaction)=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      return /FROM auth_provider_email_state/.test(sql)
        ?Promise.resolve({rows:[stored]})
        :transaction.execute(statement);
    }});
    await assert.rejects(runCredentialKeyControl(observed,{operation:'adopt',
      purpose:'identity-email-observation',confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',
      mutationsEnabled:'true'}),commandError('KEY_CONTROL_MATERIAL_NOT_READY'),label);
  }
  assert.equal((await credentialKeyControlStatus(db,configured)).state,'uninitialized');

  const adopted=await runCredentialKeyControl(db,{operation:'adopt',purpose:'identity-email-observation',
    confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',mutationsEnabled:'true'});
  assert.equal(adopted.version,2);
  const status=publicCredentialKeyControlResult(await runCredentialKeyControl(db,{operation:'status',
    purpose:'identity-email-observation',confirmation:'INSPECT_CREDENTIAL_KEY_CONTROL'}));
  assert.deepEqual(status.material,{ready:true,active_version:2,write_envelope_version:null,
    previous_versions:[],actionable:null,retained:null,observations:0,legacy_v1:null,versions:{},
    malformed:null,future:null,missing_key:0,fingerprint_mismatch:0,key_version_ahead:null,
    future_version:0});
  assert.doesNotMatch(JSON.stringify(status),new RegExp(key(10)));
  assert.doesNotMatch(JSON.stringify(status),/[a-f0-9]{64}/,'fingerprints are never projected');
});

test('public result projection passes mutation results through unchanged',()=>{
  const mutation=Object.freeze({ok:true,operation:'advance',purpose:'password-reset',version:2,
    generation:2,changed:true,reconciled:false});
  assert.equal(publicCredentialKeyControlResult(mutation),mutation);
});

test('operator runtime rejects every unprotected workflow or database configuration',()=>{
  const base={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
    GITHUB_REPOSITORY:'festus14/randori-circle',
    GITHUB_WORKFLOW_REF:'festus14/randori-circle/.github/workflows/credential-key-control.yml@refs/heads/main',
    GITHUB_SHA:'a'.repeat(40),KEY_CONTROL_REPO_COMMIT:'a'.repeat(40),
    KEY_CONTROL_GITHUB_ENVIRONMENT:'credential-key-control',
    TURSO_DATABASE_URL:'libsql://randori.example.turso.io',
    TURSO_PRODUCTION_DATABASE_HOST:'Randori.Example.Turso.io ',TURSO_AUTH_TOKEN:' opaque-token '};
  assert.deepEqual(validateCredentialKeyControlRuntime(base),
    {url:base.TURSO_DATABASE_URL,authToken:'opaque-token'});
  assert.equal(validateCredentialKeyControlRuntime({...base,
    TURSO_DATABASE_URL:'https://randori.example.turso.io/'}).url,'https://randori.example.turso.io/');
  const invalid=[
    {GITHUB_EVENT_NAME:'push'},
    {KEY_CONTROL_GITHUB_ENVIRONMENT:'production'},
    {GITHUB_WORKFLOW_REF:undefined},
    {GITHUB_WORKFLOW_REF:'attacker/fork/.github/workflows/credential-key-control.yml@refs/heads/main'},
    {GITHUB_SHA:'',KEY_CONTROL_REPO_COMMIT:''},
    {TURSO_DATABASE_URL:undefined},
    {TURSO_DATABASE_URL:'not a url'},
    {TURSO_DATABASE_URL:'file:/tmp/randori.sqlite'},
    {TURSO_DATABASE_URL:'http://randori.example.turso.io'},
    {TURSO_DATABASE_URL:'libsql://randori.example.turso.io:8080'},
    {TURSO_DATABASE_URL:'libsql://randori.example.turso.io/other'},
    {TURSO_DATABASE_URL:'libsql://user:pass@randori.example.turso.io'},
    {TURSO_DATABASE_URL:'libsql://randori.example.turso.io?authToken=x'},
    {TURSO_DATABASE_URL:'libsql://randori.example.turso.io#frag'},
    {TURSO_PRODUCTION_DATABASE_HOST:undefined},
    {TURSO_PRODUCTION_DATABASE_HOST:'-bad-.example'},
    {TURSO_AUTH_TOKEN:undefined},
    {TURSO_AUTH_TOKEN:'   '},
    {TURSO_AUTH_TOKEN:'x'.repeat(32769)},
  ];
  for(const overrides of invalid){
    assert.throws(()=>validateCredentialKeyControlRuntime({...base,...overrides}),
      commandError('KEY_CONTROL_RUNTIME_INVALID'),JSON.stringify(overrides).slice(0,120));
  }
});
