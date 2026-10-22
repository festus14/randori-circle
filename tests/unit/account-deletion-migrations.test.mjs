// Issue #339 x ID-85: after a member deletes their account, the managed
// ledger still migrates (a no-op applyMigrations) and the backup rehearsal
// still detects and fingerprints the source, exactly as health readiness does.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { deleteAccount } from '../../api/_account-deletion.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { LATEST_MIGRATION_VERSION } from '../../db/migration-contract.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { detectEvidenceMigration } from '../../scripts/turso-backup-restore-rehearsal.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const NOW=Math.floor(Date.now()/1000);
const resources=[];
const previousSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(previousSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=previousSecret;
});

test('deleting a member keeps the database migratable and the backup rehearsal working',async()=>{
  const {directory,url}=await createMigratedDatabase({prefix:'randori-deletion-migrations-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET='account-deletion-migrations-secret-32-bytes';
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin) VALUES
      (1,'owner@example.test','!oauth:owner','Owner','#111111',1),
      (2,'member@example.test','!oauth:member','Member','#222222',0)`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=> '11111111-1111-4111-8111-111111111111'});
  const token=await issueSession(db,{id:2,email:'member@example.test',name:'Member'},{recentAuthMethod:'password',nowSeconds:NOW});
  const session=await verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:NOW});
  assert.equal((await deleteAccount(db,{userId:2,sessionHash:session.sessionHash,hashInvitationEmail,nowSeconds:NOW})).status,'deleted');

  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  const state=await inspectMigrationState(db);
  assert.deepEqual([state.classification,state.currentVersion,state.ready],['managed',LATEST_MIGRATION_VERSION,true]);
  const applied=await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  assert.deepEqual([applied.applied,applied.toVersion],[[],LATEST_MIGRATION_VERSION]);
  const contract=await detectEvidenceMigration(db);
  assert.deepEqual([contract.classification,contract.version,contract.expectedLedger],['managed',LATEST_MIGRATION_VERSION,'present']);
});
