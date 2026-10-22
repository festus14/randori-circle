// A managed database is judged by steady-state membership readiness, the
// same rule as /api/health/ready: after an owner removes a member, a no-op
// applyMigrations, the backup rehearsal's source detection and evidence
// collection all still pass. Only adopting an unmanaged database keeps the
// one-time rule that every non-demo account has an active primary membership.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { changeCircleMemberStatus, leaveCircle } from '../../api/_member-lifecycle.js';
import { pairingSchemaV6Ready } from '../../api/_pairing-readiness.js';
import { collectDatabaseEvidence } from '../../db/backup-evidence.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { LATEST_MIGRATION_VERSION } from '../../db/migration-contract.js';
import {
  inspectCompletedMembershipRollout,
  inspectMembershipAdoptionReadiness,
} from '../../db/membership-readiness.js';
import {
  adoptMigrations,
  applyMigrations,
  inspectMembershipAdoption,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import { detectEvidenceMigration } from '../../scripts/turso-backup-restore-rehearsal.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const NO_RETRY={maxAttempts:1,baseDelayMs:0,maxDelayMs:0};
const resources=[];

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

// Owner 1 initializes the primary circle; members 2 and 3 are backfilled.
async function closedRollout(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-steady-state-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo) VALUES
      (1,'owner@example.test','!oauth:owner','Owner','#111111',1,0),
      (2,'removed@example.test','!oauth:removed','Removed','#222222',0,0),
      (3,'leaver@example.test','!oauth:leaver','Leaver','#333333',0,0)`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=> '11111111-1111-4111-8111-111111111111'});
  return db;
}

function evidenceOptions(){
  return {
    role:'source',identity:'provider-production-database-001',backupRef:'provider-backup-opaque-001',
    hmacKey:Buffer.from('evidence-key-alpha-32-bytes-value!','utf8'),repoCommit:'0123456789abcdef0123456789abcdef01234567',
    pitrAt:new Date(Date.now()-60_000).toISOString(),maxSnapshotAgeMs:3*60*60*1000,maxEvidenceAgeMs:3*60*60*1000,
    rpoTargetMs:3*60*60*1000,rtoTargetMs:15*60*1000,
  };
}

test('removing and losing members keeps a managed database migratable and rehearsable',async()=>{
  const db=await closedRollout();
  const owner=1;
  const primary=Number((await db.execute(`SELECT id FROM circles WHERE is_primary=1`)).rows[0].id);
  // The owner removes one member; another leaves on their own.
  assert.equal((await changeCircleMemberStatus(db,{actorUserId:owner,targetUserId:2,circleId:primary,action:'deactivate'})).ok,true);
  assert.equal((await leaveCircle(db,{actorUserId:3,circleId:primary})).ok,true);

  // The one-time adoption rule still notices the uncovered accounts...
  const strict=await inspectMembershipAdoptionReadiness(db);
  assert.equal(strict.ok,false);
  assert.ok(strict.blockers.includes('closed_rollout_has_uncovered_accounts'));
  assert.equal((await inspectMembershipAdoption(db,{managed:false})).ok,false,'unmanaged-style inspection stays strict');
  await assert.rejects(inspectMembershipAdoption(db),TypeError,'the caller must say which rule applies');
  // ...but steady-state readiness, health and pairing do not, and neither do
  // the migration runner and the backup rehearsal any more.
  assert.equal((await inspectCompletedMembershipRollout(db)).ok,true);
  assert.equal((await inspectMembershipAdoption(db,{managed:true})).ok,true);
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true);

  const state=await inspectMigrationState(db);
  assert.equal(state.classification,'managed');
  assert.equal(state.currentVersion,LATEST_MIGRATION_VERSION);
  assert.equal(state.ready,true);
  assert.deepEqual(state.adoption.membership.blockers,[]);
  const applied=await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  assert.deepEqual(applied.applied,[]);
  assert.equal(applied.toVersion,LATEST_MIGRATION_VERSION);

  const contract=await detectEvidenceMigration(db);
  assert.equal(contract.version,LATEST_MIGRATION_VERSION);
  assert.equal(contract.classification,'managed');
  assert.equal(contract.expectedLedger,'present');
  const evidence=await collectDatabaseEvidence(db,evidenceOptions());
  assert.deepEqual([evidence.migration.classification,evidence.migration.currentVersion],['managed',LATEST_MIGRATION_VERSION]);

  // A real steady-state defect still blocks: an account loses its provenance.
  await db.execute(`DELETE FROM circle_audit_events WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  const broken=await inspectMigrationState(db);
  assert.equal(broken.ready,false);
  assert.ok(broken.adoption.membership.blockers.includes('closed_rollout_account_audit_invalid'));
  await assert.rejects(applyMigrations(db,{expectedStateFingerprint:broken.stateFingerprint,retry:NO_RETRY}),
    error=>error.code==='MIGRATION_SCHEMA_INVALID');
  await assert.rejects(detectEvidenceMigration(db),error=>error.code==='REHEARSAL_MIGRATION_STATE_INVALID');
});

test('adopting an unmanaged database with uncovered accounts is still refused',async()=>{
  const db=await closedRollout();
  const primary=Number((await db.execute(`SELECT id FROM circles WHERE is_primary=1`)).rows[0].id);
  await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:2,circleId:primary,action:'deactivate'});
  await db.execute(`DROP TABLE schema_migrations`);
  const state=await inspectMigrationState(db);
  assert.equal(state.classification,'unmanaged');
  assert.equal(state.adoption.eligible,false);
  assert.ok(state.adoption.blockers.includes('closed_rollout_has_uncovered_accounts'));
  await assert.rejects(adoptMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY}),
    error=>error.code==='MIGRATION_ADOPTION_BLOCKED');
  await assert.rejects(detectEvidenceMigration(db),error=>error.code==='REHEARSAL_MIGRATION_STATE_INVALID');

  // Once every account is covered again, the same database adopts and is
  // judged by the steady-state rule from then on.
  await db.execute(`UPDATE circle_memberships SET status='active' WHERE user_id=2`);
  const eligible=await inspectMigrationState(db);
  assert.equal(eligible.adoption.eligible,true);
  const adopted=await adoptMigrations(db,{expectedStateFingerprint:eligible.stateFingerprint,
    migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY});
  assert.deepEqual([adopted.mode,adopted.toVersion],['adopt',LATEST_MIGRATION_VERSION]);
  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=2`);
  assert.equal((await inspectMigrationState(db)).ready,true);
});

// Seeds what initializePrimaryCircleData writes, directly, on a schema below
// the latest version: a closed rollout, owner 1 backfilled as owner, member 2
// backfilled and then removed by the owner.
async function seedClosedRolloutWithRemovedMember(db){
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo) VALUES
      (1,'owner@example.test','!oauth:owner','Owner','#111111',1,0),
      (2,'removed@example.test','!oauth:removed','Removed','#222222',0,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'primary-public','randori-circle','Randori',1,1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,1,'owner','active'),(1,2,'member','inactive')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key) VALUES
      (1,'membership.backfilled',1,1,'membership-backfilled:1:1'),
      (1,'membership.backfilled',1,2,'membership-backfilled:1:2'),
      (1,'membership.backfill.completed',1,NULL,'primary-membership-backfill:1:v1'),
      (1,'membership.deactivated',1,2,'membership.deactivated:seed')`,
    `UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1`,
  ],'write');
}

test('applying the next migration to a managed database with a removed member passes its postcondition',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-steady-postcondition-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  const previous=EXECUTABLE_MIGRATIONS.slice(0,-1);
  const fresh=await inspectMigrationState(db,{migrations:previous});
  await applyMigrations(db,{expectedStateFingerprint:fresh.stateFingerprint,migrations:previous,retry:NO_RETRY});
  await seedClosedRolloutWithRemovedMember(db);
  const before=await inspectMigrationState(db);
  assert.equal(before.currentVersion,LATEST_MIGRATION_VERSION-1);
  assert.equal(before.ready,true,'the managed N-1 database is ready by the steady-state rule');
  // The latest migration's own membership postcondition runs on this state.
  const applied=await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
  assert.deepEqual(applied.applied.map(item=>item.version),[LATEST_MIGRATION_VERSION]);
  assert.equal((await inspectMigrationState(db)).ready,true);
});

test('steady-state readiness still blocks orphan active memberships and forged audits on a managed database',async()=>{
  const db=await closedRollout();
  const primary=Number((await db.execute(`SELECT id FROM circles WHERE is_primary=1`)).rows[0].id);
  await changeCircleMemberStatus(db,{actorUserId:1,targetUserId:2,circleId:primary,action:'deactivate'});
  assert.equal((await inspectMigrationState(db)).ready,true);

  // An active membership whose account does not exist.
  await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,999,'member','active')`,args:[primary]});
  let state=await inspectMigrationState(db);
  assert.equal(state.ready,false);
  assert.deepEqual(state.adoption.membership.blockers,['closed_rollout_has_orphan_memberships']);
  await assert.rejects(applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY}),
    error=>error.code==='MIGRATION_SCHEMA_INVALID');
  await assert.rejects(detectEvidenceMigration(db),error=>error.code==='REHEARSAL_MIGRATION_STATE_INVALID');
  await db.execute(`DELETE FROM circle_memberships WHERE user_id=999`);
  assert.equal((await inspectMigrationState(db)).ready,true);

  // An invitation.accepted audit whose invitation does not exist.
  await db.execute({sql:`INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key)
    VALUES (?,'invitation.accepted',3,3,'00000000-0000-4000-8000-000000000000','invite-accepted:00000000-0000-4000-8000-000000000000')`,args:[primary]});
  state=await inspectMigrationState(db);
  assert.equal(state.ready,false);
  assert.deepEqual(state.adoption.membership.blockers,['closed_rollout_account_audit_invalid']);
  await assert.rejects(detectEvidenceMigration(db),error=>error.code==='REHEARSAL_MIGRATION_STATE_INVALID');
});
