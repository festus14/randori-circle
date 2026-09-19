import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';

import {
  CredentialKeyControlError,
  credentialKeyControlStatus,
  transitionCredentialKeyControl,
} from '../../api/_credential-key-control.js';
import {
  EMAIL_ACTIVATION_EVENT_TYPE,
  activationKeyRing,
  ensureEmailActivationReadiness,
  sealEmailActivationToken,
} from '../../api/_email-activation.js';
import {ensurePasswordResetReadiness} from '../../api/_password-reset.js';
import {ensureInvitationEmailReadiness} from '../../api/_invitation-email.js';
import {ensureIdentityLinkingReadiness} from '../../api/_identity-linking.js';
import {createOutboxEventStatement} from '../../api/_outbox.js';
import {
  CREDENTIAL_KEY_PURPOSES,
  inspectCredentialKeyControlReadiness,
} from '../../db/credential-key-control.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import {
  publicCredentialKeyControlResult,
  runCredentialKeyControl,
  validateCredentialKeyControlRuntime,
} from '../../scripts/credential-key-control.mjs';

const NO_RETRY={maxAttempts:1,baseDelayMs:0,maxDelayMs:0};
const resources=[];

afterEach(async()=>{
  for(const key of ['EMAIL_VERIFICATION_ENCRYPTION_KEY','EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION',
    'EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS','EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION',
    'PASSWORD_RESET_ENCRYPTION_KEY','PASSWORD_RESET_ENCRYPTION_KEY_VERSION',
    'PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS','PASSWORD_RESET_ENVELOPE_WRITE_VERSION',
    'INVITATION_EMAIL_ENCRYPTION_KEY','INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
    'INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS','INVITATION_EMAIL_ENVELOPE_WRITE_VERSION',
    'IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION','IDENTITY_EMAIL_HASH_PREVIOUS_KEYS',
    'JWT_SECRET']){
    delete process.env[key];
  }
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

function key(byte){ return Buffer.alloc(32,byte).toString('base64url'); }
function fingerprint(character){ return character.repeat(64); }

function ring(purpose,version,activeFingerprint,{previous=[]}={}){
  const active=Object.freeze({version,fingerprint:activeFingerprint});
  const ordered=Object.freeze([active,...previous]);
  return Object.freeze({purpose,active,previous:Object.freeze(previous),ordered,
    byVersion:new Map(ordered.map(item=>[item.version,item]))});
}

async function database({clients=1,migrations=EXECUTABLE_MIGRATIONS}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-key-control-'));
  const path=join(directory,'database.sqlite');
  const url=`file:${path}`;
  const databases=Array.from({length:clients},()=>createClient({url}));
  for(const db of databases) await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(databases[0],{migrations});
  await applyMigrations(databases[0],{migrations,expectedStateFingerprint:initial.stateFingerprint,
    retry:NO_RETRY});
  resources.push(async()=>{
    for(const db of databases) await db.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {db:databases[0],databases,path,url,directory};
}

function expectControl(code){
  return error=>error instanceof CredentialKeyControlError&&error.code===code;
}

test('v15 seeds exactly four constrained uninitialized controls and deletion fails readiness closed',async()=>{
  const {db}=await database();
  const rows=(await db.execute(`SELECT purpose,state,highest_key_version,highest_key_fingerprint,
    generation,control_version,installed_by_migration FROM credential_key_controls ORDER BY purpose`)).rows;
  assert.deepEqual(rows.map(row=>row.purpose),CREDENTIAL_KEY_PURPOSES);
  assert.deepEqual(rows.map(row=>({state:row.state,version:row.highest_key_version,
    fingerprint:row.highest_key_fingerprint,generation:Number(row.generation),
    control:Number(row.control_version),migration:Number(row.installed_by_migration)})),
  Array(4).fill({state:'uninitialized',version:null,fingerprint:null,generation:0,control:1,migration:15}));
  const initialControl=await inspectCredentialKeyControlReadiness(db);
  assert.deepEqual({ok:initialControl.ok,initialized:initialControl.initialized,
    total:initialControl.total,blockers:initialControl.blockers},
  {ok:true,initialized:0,total:4,blockers:[]});
  assert.match(initialControl.stateDigest,/^[a-f0-9]{64}$/);
  assert.equal((await inspectMigrationState(db)).ready,true,
    'uninitialized purpose controls are structurally ready without enabling features');
  await assert.rejects(db.execute(`UPDATE credential_key_controls SET state='accepted'
    WHERE purpose='email-activation'`),error=>String(error?.code).startsWith('SQLITE_CONSTRAINT'));
  await db.execute(`DELETE FROM credential_key_controls WHERE purpose='email-activation'`);
  assert.deepEqual(await inspectCredentialKeyControlReadiness(db),{
    ok:false,initialized:0,total:0,stateDigest:null,
    blockers:['credential_key_controls_invalid'],
  });
  assert.equal((await inspectMigrationState(db)).ready,false);
});

test('a managed v14 restore advances to explicit uninitialized controls',async()=>{
  const {db}=await database({migrations:EXECUTABLE_MIGRATIONS.slice(0,14)});
  const before=await inspectMigrationState(db);
  assert.equal(before.currentVersion,14);
  const upgraded=await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,
    retry:NO_RETRY});
  assert.deepEqual(upgraded.applied.map(migration=>migration.version),[15]);
  const controls=await inspectCredentialKeyControlReadiness(db);
  assert.deepEqual({ok:controls.ok,initialized:controls.initialized,total:controls.total,
    blockers:controls.blockers},{ok:true,initialized:0,total:4,blockers:[]});
});

test('every uninitialized purpose is unavailable without coupling unrelated password auth state',async()=>{
  const {db}=await database();
  process.env.JWT_SECRET='credential-control-test-secret-at-least-32-bytes';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=key(7);
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=key(8);
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=key(9);
  process.env.IDENTITY_EMAIL_HASH_KEY=key(10);
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='1';
  await assert.rejects(ensureEmailActivationReadiness(db),expectControl('KEY_CONTROL_UNINITIALIZED'));
  await assert.rejects(ensurePasswordResetReadiness(db,{requireDeliveryKey:true}),
    expectControl('KEY_CONTROL_UNINITIALIZED'));
  await assert.rejects(ensureInvitationEmailReadiness(db),expectControl('KEY_CONTROL_UNINITIALIZED'));
  await assert.rejects(ensureIdentityLinkingReadiness(db),expectControl('KEY_CONTROL_UNINITIALIZED'));
  await assert.doesNotReject(ensurePasswordResetReadiness(db,{requireDeliveryKey:false}));
});

test('first adoption is idempotent and survives empty state, restart, and isolated restore',async()=>{
  const item=await database();
  const configured=ring('email-activation',3,fingerprint('a'));
  const migrationStateBefore=await inspectMigrationState(item.db);
  assert.deepEqual(await credentialKeyControlStatus(item.db,configured),{
    ready:false,state:'uninitialized',reason:'KEY_CONTROL_UNINITIALIZED',configured_version:3,
    accepted_version:null,generation:0,
  });
  const adopted=await transitionCredentialKeyControl(item.db,{operation:'adopt',ring:configured});
  assert.deepEqual(adopted,{ok:true,purpose:'email-activation',version:3,generation:1,
    changed:true,reconciled:false});
  assert.notEqual((await inspectMigrationState(item.db)).stateFingerprint,
    migrationStateBefore.stateFingerprint,'migration authorization binds control changes opaquely');
  assert.equal((await transitionCredentialKeyControl(item.db,{operation:'adopt',ring:configured})).changed,false);
  const restorePath=join(item.directory,'restored.sqlite');
  await item.db.close();
  copyFileSync(item.path,restorePath);
  const reopened=createClient({url:item.url});
  const restored=createClient({url:`file:${restorePath}`});
  resources.push(()=>reopened.close(),()=>restored.close());
  assert.equal((await credentialKeyControlStatus(reopened,configured)).ready,true);
  assert.equal((await credentialKeyControlStatus(restored,
    ring('email-activation',4,fingerprint('b'),{previous:[configured.active]}))).state,
  'advance_required');
});

test('durable status distinguishes downgrade, substitution, and explicit advance',async()=>{
  const {db}=await database();
  const v2=ring('password-reset',2,fingerprint('b'));
  await transitionCredentialKeyControl(db,{operation:'adopt',ring:v2});
  assert.equal((await credentialKeyControlStatus(db,ring('password-reset',1,fingerprint('a')))).state,
    'downgrade');
  const substituted=await credentialKeyControlStatus(db,ring('password-reset',2,fingerprint('c')));
  assert.deepEqual(substituted,{ready:false,state:'substitution',reason:'KEY_CONTROL_SUBSTITUTION',
    configured_version:2,accepted_version:2,generation:1});
  assert.doesNotMatch(JSON.stringify(substituted),new RegExp(fingerprint('b')));
  assert.equal((await credentialKeyControlStatus(db,
    ring('password-reset',5,fingerprint('e'),{previous:[v2.active]}))).state,'advance_required');
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'adopt',
    ring:ring('password-reset',2,fingerprint('c'))}),expectControl('KEY_CONTROL_SUBSTITUTION'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'adopt',
    ring:ring('password-reset',1,fingerprint('a'))}),expectControl('KEY_CONTROL_DOWNGRADE'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'adopt',
    ring:ring('password-reset',5,fingerprint('e'),{previous:[v2.active]})}),
  expectControl('KEY_CONTROL_ADVANCE_REQUIRED'));
});

test('advance is a monotonic CAS and requires continuity with the accepted pair',async()=>{
  const {db}=await database();
  const v1=ring('invitation-email',1,fingerprint('a'));
  await transitionCredentialKeyControl(db,{operation:'adopt',ring:v1});
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',
    ring:ring('invitation-email',3,fingerprint('c')),expectedVersion:1,expectedGeneration:1}),
  expectControl('KEY_CONTROL_CONTINUITY_MISSING'));
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',ring:ring(
    'invitation-email',3,fingerprint('c'),{previous:[{version:1,fingerprint:fingerprint('b')}]}),
  expectedVersion:1,expectedGeneration:1}),expectControl('KEY_CONTROL_CONTINUITY_MISSING'));
  const v3=ring('invitation-email',3,fingerprint('c'),{previous:[v1.active]});
  assert.equal((await transitionCredentialKeyControl(db,{operation:'advance',ring:v3,
    expectedVersion:1,expectedGeneration:1})).generation,2);
  assert.equal((await transitionCredentialKeyControl(db,{operation:'advance',ring:v3,
    expectedVersion:1,expectedGeneration:1})).changed,false,'an exact retry is idempotent');
  await assert.rejects(transitionCredentialKeyControl(db,{operation:'advance',ring:ring(
    'invitation-email',4,fingerprint('d'),{previous:[v3.active]}),expectedVersion:1,
  expectedGeneration:1}),expectControl('KEY_CONTROL_STATE_CHANGED'));
});

test('concurrent matching and conflicting adopters converge without silent substitution',async()=>{
  const matching=await database({clients:2});
  const identity=ring('identity-email-observation',1,fingerprint('a'));
  const matches=await Promise.all([
    transitionCredentialKeyControl(matching.databases[0],{operation:'adopt',ring:identity}),
    transitionCredentialKeyControl(matching.databases[1],{operation:'adopt',ring:identity}),
  ]);
  assert.equal(matches.filter(result=>result.changed).length,1);
  assert.equal((await credentialKeyControlStatus(matching.db,identity)).ready,true);

  const conflict=await database({clients:2});
  const results=await Promise.allSettled([
    transitionCredentialKeyControl(conflict.databases[0],{operation:'adopt',
      ring:ring('email-activation',1,fingerprint('b'))}),
    transitionCredentialKeyControl(conflict.databases[1],{operation:'adopt',
      ring:ring('email-activation',1,fingerprint('c'))}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected'
    &&result.reason?.code==='KEY_CONTROL_SUBSTITUTION').length,1);
});

test('an ambiguous commit reconciles only the exact intended state',async()=>{
  const {db}=await database();
  const configured=ring('email-activation',1,fingerprint('a'));
  const ambiguous={
    execute:statement=>db.execute(statement),
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        execute:statement=>transaction.execute(statement),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close?.(),
        async commit(){
          await transaction.commit();
          throw Object.assign(new Error('transport outcome unknown'),{code:'UNKNOWN'});
        },
      };
    },
  };
  const result=await transitionCredentialKeyControl(ambiguous,{operation:'adopt',ring:configured});
  assert.deepEqual(result,{ok:true,purpose:'email-activation',version:1,generation:1,
    changed:false,reconciled:true});

  const missing=await database();
  const notCommitted={
    execute:statement=>missing.db.execute(statement),
    async transaction(mode){
      const transaction=await missing.db.transaction(mode);
      return {
        execute:statement=>transaction.execute(statement),
        rollback:()=>transaction.rollback(),close:()=>transaction.close?.(),
        async commit(){ throw Object.assign(new Error('commit refused'),{code:'UNKNOWN'}); },
      };
    },
  };
  await assert.rejects(transitionCredentialKeyControl(notCommitted,{operation:'adopt',
    ring:ring('password-reset',1,fingerprint('b'))}),expectControl('KEY_CONTROL_COMMIT_UNKNOWN'));
  assert.equal((await credentialKeyControlStatus(missing.db,
    ring('password-reset',1,fingerprint('b')))).state,'uninitialized');
});

test('operator adoption permits legacy compatibility but advance waits for v1 drain',async()=>{
  const {db}=await database();
  const firstKey=key(7);
  process.env.JWT_SECRET='credential-control-test-secret-at-least-32-bytes';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=firstKey;
  const idempotencyKey='auth-activation/v1/11111111-1111-4111-8111-111111111111/1';
  await db.execute(createOutboxEventStatement({eventType:EMAIL_ACTIVATION_EVENT_TYPE,
    idempotencyKey,payload:{token_envelope:sealEmailActivationToken('A'.repeat(43),{idempotencyKey})},
    maxAttempts:1}));
  const adopted=await runCredentialKeyControl(db,{operation:'adopt',purpose:'email-activation',
    confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',mutationsEnabled:true});
  assert.equal(adopted.version,1);

  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=key(8);
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION='2';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS=JSON.stringify([{version:1,key:firstKey}]);
  process.env.EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION='2';
  await assert.rejects(runCredentialKeyControl(db,{operation:'advance',purpose:'email-activation',
    expectedVersion:1,expectedGeneration:1,confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',
    mutationsEnabled:true}),error=>error?.code==='KEY_CONTROL_MATERIAL_NOT_READY');
  await db.execute(`UPDATE outbox_events SET status='delivered'`);
  const advanced=await runCredentialKeyControl(db,{operation:'advance',purpose:'email-activation',
    expectedVersion:1,expectedGeneration:1,confirmation:'CHANGE_CREDENTIAL_KEY_CONTROL',
    mutationsEnabled:true});
  assert.equal(advanced.version,2);
  const status=await runCredentialKeyControl(db,{operation:'status',purpose:'email-activation',
    confirmation:'INSPECT_CREDENTIAL_KEY_CONTROL'});
  const projection=publicCredentialKeyControlResult(status);
  assert.equal(projection.control.ready,true);
  assert.deepEqual(projection.material,{
    ready:true,active_version:2,write_envelope_version:2,previous_versions:[1],
    actionable:0,retained:0,observations:null,legacy_v1:0,versions:{},
    malformed:0,future:0,missing_key:0,fingerprint_mismatch:0,
    key_version_ahead:0,future_version:null,
  });
  assert.doesNotMatch(JSON.stringify(projection),new RegExp(firstKey));
  assert.doesNotMatch(JSON.stringify(projection),/[a-f0-9]{64}/);
});

test('operator runtime requires the protected latest-main workflow identity',()=>{
  const base={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
    GITHUB_REPOSITORY:'festus14/randori-circle',
    GITHUB_WORKFLOW_REF:'festus14/randori-circle/.github/workflows/credential-key-control.yml@refs/heads/main',
    GITHUB_SHA:'a'.repeat(40),KEY_CONTROL_REPO_COMMIT:'a'.repeat(40),
    KEY_CONTROL_GITHUB_ENVIRONMENT:'credential-key-control',
    TURSO_DATABASE_URL:'libsql://randori.example.turso.io',
    TURSO_PRODUCTION_DATABASE_HOST:'randori.example.turso.io',TURSO_AUTH_TOKEN:'opaque-token'};
  assert.deepEqual(validateCredentialKeyControlRuntime(base),{
    url:base.TURSO_DATABASE_URL,authToken:base.TURSO_AUTH_TOKEN,
  });
  assert.throws(()=>validateCredentialKeyControlRuntime({...base,GITHUB_REF:'refs/heads/rolling'}),
    error=>error?.code==='KEY_CONTROL_RUNTIME_INVALID');
  assert.throws(()=>validateCredentialKeyControlRuntime({...base,KEY_CONTROL_REPO_COMMIT:'b'.repeat(40)}),
    error=>error?.code==='KEY_CONTROL_RUNTIME_INVALID');
  assert.throws(()=>validateCredentialKeyControlRuntime({...base,
    TURSO_PRODUCTION_DATABASE_HOST:'other.example.turso.io'}),
  error=>error?.code==='KEY_CONTROL_RUNTIME_INVALID');
});

test('operator workflow is manual, protected, latest-main-only, and shares database serialization',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/credential-key-control.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/pull_request:|\bpush:/);
  assert.match(workflow,/environment: credential-key-control/);
  assert.match(workflow,/group: turso-production-database-operations/);
  assert.match(workflow,/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow,/CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED: \$\{\{ vars\./);
  assert.match(workflow,/TURSO_PRODUCTION_DATABASE_HOST: \$\{\{ vars\./);
  assert.doesNotMatch(workflow,/continue-on-error:\s*true/);
  assert.doesNotMatch(workflow,/JWT_SECRET:/);
  const purposeSteps=[
    ['email activation','email-activation','EMAIL_VERIFICATION_ENCRYPTION'],
    ['password reset','password-reset','PASSWORD_RESET_ENCRYPTION'],
    ['invitation email','invitation-email','INVITATION_EMAIL_ENCRYPTION'],
    ['identity email observation','identity-email-observation','IDENTITY_EMAIL_HASH'],
  ];
  for(const [label,purpose,prefix] of purposeSteps){
    const start=workflow.indexOf(`      - name: Run ${label} key-control operation`);
    assert.notEqual(start,-1,`missing ${purpose} protected operation`);
    const next=workflow.indexOf('\n      - name:',start+1);
    const step=workflow.slice(start,next===-1?workflow.length:next);
    assert.match(step,new RegExp(`if: inputs\\.purpose == '${purpose}'`));
    assert.match(step,new RegExp(`KEY_CONTROL_PURPOSE: ${purpose}`));
    assert.match(step,new RegExp(`${prefix}_[A-Z_]+: \\$\\{\\{ secrets\\.`));
    for(const [,otherPurpose,otherPrefix] of purposeSteps){
      if(otherPurpose!==purpose) assert.doesNotMatch(step,new RegExp(`${otherPrefix}_[A-Z_]+:`),
        `${purpose} must not receive the ${otherPurpose} key ring`);
    }
  }
  const lines=workflow.split('\n');
  let runIndent=null;
  for(const line of lines){
    const indentation=line.length-line.trimStart().length;
    const declaration=/^\s*run:\s*(.*)$/.exec(line);
    if(declaration){
      const value=declaration[1].trim();
      if(/^[>|](?:[1-9][+-]?|[+-][1-9]?)?$/.test(value)) runIndent=indentation;
      else{
        runIndent=null;
        assert.doesNotMatch(value,/\$\{\{\s*inputs\./,
          'dispatch values must reach shell only through quoted environment variables');
      }
      continue;
    }
    if(runIndent!==null&&line.trim()&&indentation<=runIndent) runIndent=null;
    if(runIndent!==null) assert.doesNotMatch(line,/\$\{\{\s*inputs\./,
      'dispatch values must reach shell only through quoted environment variables');
  }
});
