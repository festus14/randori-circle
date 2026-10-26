// Issue #366: restore re-application of account deletions, against real
// migrated SQLite databases. The "restored" database is a second database
// seeded identically but without the deletion — the state a point-in-time
// restore to before the deletion would bring back. The ledger built from
// the source (post-deletion) database must re-apply the deletion to it,
// and verification must catch a database where it was not re-applied.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  ACCOUNT_DELETED_AUDIT_EVENT,
  DELETED_ACCOUNT_EMAIL_DOMAIN,
  DELETED_MESSAGE_TEXT,
  buildDeletionLedger,
  deleteAccount,
  deletionLedgerEntriesAfter,
  isDeletedAccount,
  parseDeletionLedger,
  reapplyAccountDeletion,
  verifyDeletionLedger,
} from '../../api/_account-deletion.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const JWT_SECRET='account-deletion-restore-test-secret-at-least-32-bytes';
const NOW=Math.floor(Date.now()/1000);
const DELETED_AT=new Date(NOW*1000).toISOString();
// The restore point is an hour before the deletion: the restored database
// holds the member live, with their personal data.
const RESTORE_POINT=new Date((NOW-3600)*1000).toISOString();
const BEFORE='2026-01-01T00:00:00.000Z';
const HEX=character=>character.repeat(64);
const resources=[];
const originalSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
});

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-restore-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return db;
}

// Owner 1, member 2 (the account that will be deleted), partner 3. Member 2
// has a chat message, a live session, an availability decision, notification
// preferences and a solo run: the deletion must scrub all of them on the
// restored database. With `soleOwner20`, circle 20 is owned solely by
// member 2: the re-application must succeed there even though a
// self-service deletion would be refused as last_owner, because the
// original deletion already passed that gate.
async function seed(db,{soleOwner20=false}={}){
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at) VALUES
      (1,'circle-one','one','Circle One',1,1,NULL),
      (20,'circle-twenty','twenty','Night Owls',0,2,NULL)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone,google_sub,created_at)
      VALUES (1,'owner@example.test','$2a$10$owner','Owner','#111111',1,0,NULL,NULL,NULL,'${BEFORE}'),
        (2,'member@example.test','$2a$10$member','Member','#222222',0,0,'Member bio','+44 7700 900222','member-google-sub','${BEFORE}'),
        (3,'partner@example.test','$2a$10$partner','Partner','#333333',0,0,NULL,NULL,NULL,'${BEFORE}')`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES
      (1,1,'owner','active',NULL),(1,2,'member','active',1),(1,3,'member','active',1),
      (20,2,'owner','active',NULL)${soleOwner20?'':`,(20,3,'owner','active',2)`}`,
    `INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message) VALUES
      (1,10,1,2,'Member secret message'),(2,10,1,3,'Partner message')`,
    `INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('circle:1',1,'${HEX('c')}','2098-W38','2098-09-14T07:00:00.000Z','2098-09-21T07:00:00.000Z','2098-09-14T07:00:00.000Z','Europe/London','cycle_default')`,
    `INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,decision_source)
      VALUES ('circle:1','${HEX('c')}',2,1,'user')`,
    `INSERT INTO user_notification_prefs (user_id,email_enabled,phone,email) VALUES (2,1,'+44 7700 900222','member@example.test')`,
    `INSERT INTO session_runs (id,user_id,code) VALUES (1,2,'secret code')`,
  ],'write');
  const token=await issueSession(db,{id:2,email:'member@example.test',name:'Member'},{
    recentAuthMethod:'password',nowSeconds:NOW,
  });
  const auth=await verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:NOW});
  return {sessionHash:auth.sessionHash};
}

async function one(db,sql,args=[]){
  const result=await db.execute({sql,args});
  return result.rows[0]||null;
}

async function member(db){
  return one(db,`SELECT * FROM auth_accounts WHERE id=2`);
}

test('deletion ledger: built from tombstones, with the earliest audit time and null when no audit row exists',async()=>{
  const db=await database();
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (1,'owner@example.test','$2a$10$owner','Owner','#111111'),
      (2,'deleted-2@${DELETED_ACCOUNT_EMAIL_DOMAIN}','!account-deleted','Deleted member','#9aa0a6'),
      (3,'deleted-3@${DELETED_ACCOUNT_EMAIL_DOMAIN}','!account-deleted','Deleted member','#9aa0a6'),
      (4,'live@example.test','$2a$10$live','Live','#444444')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key,created_at) VALUES
      (1,'${ACCOUNT_DELETED_AUDIT_EVENT}',2,2,'account.deleted:2:1:2026-10-20T10:00:00.000Z','2026-10-20T10:00:00.000Z'),
      (1,'${ACCOUNT_DELETED_AUDIT_EVENT}',2,2,'account.deleted:2:1:2026-10-20T11:00:00.000Z','2026-10-20T11:00:00.000Z')`,
  ],'write');
  const ledger=await buildDeletionLedger(db);
  const createdAt=timestamp=>{
    // The database stores SQLite `YYYY-MM-DD HH:MM:SS`; the ledger normalises it to canonical ISO.
    const raw=String(timestamp);
    return raw.includes('T')?raw:`${raw.replace(' ','T')}.000Z`;
  };
  assert.deepEqual(ledger,[
    {account_id:2,created_at:createdAt((await member(db)).created_at),deleted_at:'2026-10-20T10:00:00.000Z'},
    {account_id:3,created_at:createdAt((await one(db,`SELECT created_at FROM auth_accounts WHERE id=3`)).created_at),deleted_at:null},
  ]);
  // The live account is never listed.
  assert.equal(ledger.some(entry=>entry.account_id===4),false);
});

test('deletion ledger parsing rejects non-arrays, wrong keys, duplicates and non-canonical timestamps',()=>{
  assert.throws(()=>parseDeletionLedger(null),TypeError);
  assert.throws(()=>parseDeletionLedger([{
    account_id:2,created_at:BEFORE,deleted_at:DELETED_AT,extra:1,
  }]),TypeError);
  assert.throws(()=>parseDeletionLedger([
    {account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},
    {account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},
  ]),TypeError);
  assert.throws(()=>parseDeletionLedger([
    {account_id:0,created_at:BEFORE,deleted_at:DELETED_AT},
  ]),TypeError);
  assert.throws(()=>parseDeletionLedger([
    {account_id:2,created_at:'2026-10-20 10:00:00',deleted_at:DELETED_AT},
  ]),TypeError);
  assert.throws(()=>parseDeletionLedger([
    {account_id:2,created_at:BEFORE,deleted_at:'not-a-time'},
  ]),TypeError);
  // A valid ledger sorts by account id and freezes.
  assert.deepEqual(parseDeletionLedger([
    {account_id:3,created_at:BEFORE,deleted_at:null},
    {account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},
  ]),[
    {account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},
    {account_id:3,created_at:BEFORE,deleted_at:null},
  ]);
  assert.throws(()=>deletionLedgerEntriesAfter([], 'not-a-time'),TypeError);
});

test('restore-point filter keeps only deletions after the restore point, plus unknown-time entries',()=>{
  const ledger=[
    {account_id:2,created_at:BEFORE,deleted_at:'2026-10-20T10:00:00.000Z'},
    {account_id:3,created_at:BEFORE,deleted_at:'2026-10-20T10:00:00.000Z'},
    {account_id:4,created_at:BEFORE,deleted_at:null},
  ];
  // At exactly the restore point the deletion is already in the restore: excluded.
  assert.deepEqual(deletionLedgerEntriesAfter(ledger,'2026-10-20T10:00:00.000Z'),[
    {account_id:4,created_at:BEFORE,deleted_at:null},
  ]);
  assert.deepEqual(deletionLedgerEntriesAfter(ledger,'2026-10-20T09:59:59.999Z').map(entry=>entry.account_id),[2,3,4]);
});

test('re-applying a ledger entry tombstones a live account and keeps the original deletion time in the audit trail',async()=>{
  const db=await database();
  await seed(db,{soleOwner20:true});
  const entry={account_id:2,created_at:BEFORE,deleted_at:DELETED_AT};
  const result=await reapplyAccountDeletion(db,{entry,restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW});
  assert.equal(result.ok,true);
  assert.equal(result.status,'reapplied');
  assert.equal(result.summary.circles_audited,2);
  const tombstone=await member(db);
  assert.equal(isDeletedAccount(tombstone),true);
  assert.equal(tombstone.email,`deleted-2@${DELETED_ACCOUNT_EMAIL_DOMAIN}`);
  assert.equal(tombstone.bio,null);
  assert.equal(tombstone.phone,null);
  assert.equal(tombstone.google_sub,null);
  // The rebuilt audit trail carries the original deletion time, not the
  // re-application time, so it matches the real timeline.
  const audit=await one(db,
    `SELECT created_at FROM circle_audit_events WHERE event_type=? AND subject_user_id=2 ORDER BY created_at LIMIT 1`,
    [ACCOUNT_DELETED_AUDIT_EVENT]);
  assert.equal(audit.created_at,DELETED_AT);
  // Personal rows are scrubbed, partners' rows untouched.
  assert.equal((await one(db,`SELECT message FROM pair_messages WHERE id=1`)).message,DELETED_MESSAGE_TEXT);
  assert.equal((await one(db,`SELECT message FROM pair_messages WHERE id=2`)).message,'Partner message');
  assert.equal((await one(db,`SELECT COUNT(*) AS count FROM pairing_cycle_availability WHERE user_id=2`)).count,0);
  assert.equal((await one(db,`SELECT COUNT(*) AS count FROM user_notification_prefs WHERE user_id=2`)).count,0);
  assert.equal((await one(db,`SELECT COUNT(*) AS count FROM session_runs WHERE user_id=2`)).count,0);
  assert.equal((await one(db,`SELECT status,role FROM circle_memberships WHERE circle_id=1 AND user_id=2`)).status,'inactive');
  assert.equal((await one(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=2 AND revoked_at IS NULL`)).count,0);
  // A retry is a no-op, not a second deletion.
  assert.deepEqual(
    await reapplyAccountDeletion(db,{entry,restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW}),
    {ok:true,status:'already_deleted'});
  // Verification passes once the deletion is re-applied.
  assert.deepEqual(
    await verifyDeletionLedger(db,{ledger:[entry],restorePoint:RESTORE_POINT}),
    {ok:true,checked:1,missing:[]});
});

test('re-application skips entries at or before the restore point and accounts created after it',async()=>{
  const db=await database();
  await seed(db);
  const skipped=await reapplyAccountDeletion(db,{
    entry:{account_id:2,created_at:BEFORE,deleted_at:RESTORE_POINT},
    restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW,
  });
  assert.deepEqual(skipped,{ok:true,status:'skipped_before_restore_point'});
  assert.equal(isDeletedAccount(await member(db)),false);
  const neverExisted=await reapplyAccountDeletion(db,{
    entry:{account_id:99,created_at:DELETED_AT,deleted_at:DELETED_AT},
    restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW,
  });
  assert.deepEqual(neverExisted,{ok:true,status:'never_existed_in_restore'});
});

test('re-application fails closed for an account that should be in the restored database but is not',async()=>{
  const db=await database();
  await seed(db);
  const result=await reapplyAccountDeletion(db,{
    entry:{account_id:99,created_at:BEFORE,deleted_at:DELETED_AT},
    restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW,
  });
  assert.deepEqual(result,{ok:false,reason:'missing_in_restore'});
  await assert.rejects(reapplyAccountDeletion(null,{
    entry:{account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},restorePoint:RESTORE_POINT,hashInvitationEmail,
  }),TypeError);
  await assert.rejects(reapplyAccountDeletion(db,{
    entry:{account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},restorePoint:RESTORE_POINT,
  }),TypeError);
});

test('re-application fails closed for a demo account, whose tombstone statement cannot match',async()=>{
  const db=await database();
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES (5,'demo@example.test','demo','Demo','#555555',1)`,
  ],'write');
  await assert.rejects(reapplyAccountDeletion(db,{
    entry:{account_id:5,created_at:BEFORE,deleted_at:DELETED_AT},
    restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW,
  }),/account tombstone failed/);
  assert.equal(isDeletedAccount(await one(db,`SELECT * FROM auth_accounts WHERE id=5`)),false);
});

test('verification reports a due entry that was not re-applied, and ignores accounts created after the restore point',async()=>{
  const db=await database();
  await seed(db);
  const ledger=[
    {account_id:2,created_at:BEFORE,deleted_at:DELETED_AT},
    {account_id:99,created_at:DELETED_AT,deleted_at:DELETED_AT},
    {account_id:98,created_at:BEFORE,deleted_at:BEFORE},
  ];
  assert.deepEqual(
    await verifyDeletionLedger(db,{ledger,restorePoint:RESTORE_POINT}),
    {ok:false,checked:2,missing:[2]});
});

test('end to end: a real deletion, a ledger from the source, and re-application onto the pre-deletion database',async()=>{
  const source=await database();
  const restored=await database();
  const {sessionHash}=await seed(source);
  await seed(restored);
  const deleted=await deleteAccount(source,{hashInvitationEmail,userId:2,sessionHash,nowSeconds:NOW});
  assert.equal(deleted.status,'deleted');
  assert.equal(isDeletedAccount(await member(source)),true);

  const ledger=await buildDeletionLedger(source);
  assert.equal(ledger.length,1);
  assert.equal(ledger[0].account_id,2);
  assert.equal(ledger[0].deleted_at,DELETED_AT);

  // Before re-application the restored database still holds the member live.
  assert.equal(isDeletedAccount(await member(restored)),false);
  assert.deepEqual(
    await verifyDeletionLedger(restored,{ledger,restorePoint:RESTORE_POINT}),
    {ok:false,checked:1,missing:[2]});

  for(const entry of deletionLedgerEntriesAfter(ledger,RESTORE_POINT)){
    const applied=await reapplyAccountDeletion(restored,{entry,restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW});
    assert.equal(applied.ok,true);
    assert.equal(applied.status,'reapplied');
  }
  // The restored database now matches the source's tombstone for this account.
  assert.deepEqual(
    await verifyDeletionLedger(restored,{ledger,restorePoint:RESTORE_POINT}),
    {ok:true,checked:1,missing:[]});
  const tombstone=await member(restored);
  assert.equal(tombstone.email,(await member(source)).email);
  assert.equal((await one(restored,`SELECT message FROM pair_messages WHERE id=1`)).message,DELETED_MESSAGE_TEXT);
  // Re-running the whole ledger is a no-op.
  for(const entry of deletionLedgerEntriesAfter(ledger,RESTORE_POINT)){
    const again=await reapplyAccountDeletion(restored,{entry,restorePoint:RESTORE_POINT,hashInvitationEmail,nowSeconds:NOW});
    assert.equal(again.status,'already_deleted');
  }
});
