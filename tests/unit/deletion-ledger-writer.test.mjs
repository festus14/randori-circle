// Issue #383: the deletion path writes the durable ledger at EXECUTION
// time, never at request time. A cancelled or blocked grace request
// leaves NO ledger entry; an immediate deletion and a scheduled
// execution each write exactly one. A ledger-write failure surfaces
// (the deletion stands) and a retry backfills the entry from the audit
// trail.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  deleteAccount,
  executeScheduledAccountDeletion,
} from '../../api/_account-deletion.js';
import {
  DELETION_GRACE_SECONDS,
  cancelAccountDeletion,
  requestAccountDeletion,
} from '../../api/_account-deletion-grace.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import { issueSession, verifyRequestAuth, verifySignedRequestAuth } from '../../api/_db.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { DELETION_LEDGER_DB_SCHEMA } from '../../scripts/deletion-ledger.mjs';
import {
  destroyDeletionLedger,
  readDeletionLedgerEntries,
} from '../../api/_deletion-ledger-db.js';

const JWT_SECRET='deletion-ledger-writer-test-secret-at-least-32-bytes';
const NOW=1_750_000_000;
const ISO=new Date(NOW*1000).toISOString();
const MEMBER=2;
const MEMBER_EMAIL='member@example.test';
const HEX=character=>character.repeat(64);
const resources=[];
const originalSecret=process.env.JWT_SECRET;
const originalLedgerUrl=process.env.DELETION_LEDGER_DATABASE_URL;
const originalLedgerToken=process.env.DELETION_LEDGER_AUTH_TOKEN;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
  if(originalLedgerUrl===undefined) delete process.env.DELETION_LEDGER_DATABASE_URL;
  else process.env.DELETION_LEDGER_DATABASE_URL=originalLedgerUrl;
  if(originalLedgerToken===undefined) delete process.env.DELETION_LEDGER_AUTH_TOKEN;
  else process.env.DELETION_LEDGER_AUTH_TOKEN=originalLedgerToken;
});

async function ledger(){
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-writer-'));
  const path=join(directory,'ledger.db');
  const client=createClient({url:`file:${path}`});
  await client.execute({sql:DELETION_LEDGER_DB_SCHEMA,args:[]});
  resources.push(async()=>{ client.close(); rmSync(directory,{recursive:true,force:true}); });
  return {client,url:`file:${path}`};
}

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-deletion-ledger-writer-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return db;
}

async function fixture(){
  const db=await database();
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone,created_at)
      VALUES (1,'owner@example.test','$2a$10$owner','Owner','#111111',1,0,NULL,NULL,'2026-01-01T00:00:00.000Z'),
      (3,'partner@example.test','$2a$10$partner','Partner','#333333',0,0,NULL,NULL,'2026-01-01T00:00:00.000Z'),
      (4,'zoe@example.test','$2a$10$zoe','Zoe','#444444',0,0,NULL,NULL,'2026-01-01T00:00:00.000Z'),
      (5,'demo@example.test','demo','Demo','#555555',0,1,NULL,NULL,'2026-01-01T00:00:00.000Z')`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=>'11111111-1111-4111-8111-111111111111'});
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone,created_at)
      VALUES (2,?,'$2a$10$member','Member','#222222',0,0,'Keeps notes','+44 7700 900123','2026-01-01T00:00:00.000Z')`,args:[MEMBER_EMAIL]},
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (1,2,'member','active',1)`,
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by)
      VALUES ('22222222-2222-4222-8222-222222222222',1,?,?,1,?,'2098-09-20T12:00:00.000Z',?,2)`,
    args:[HEX('a'),hashInvitationEmail(MEMBER_EMAIL),ISO,ISO]},
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at) VALUES
      (20,'circle-twenty','twenty','Night Owls',0,4,NULL)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES
      (20,4,'owner','active',NULL),(20,3,'member','active',4),(20,2,'member','active',4)`,
  ],'write');
  return db;
}

async function verifiedSession(db,{at=NOW}={}){
  const token=await issueSession(db,{id:MEMBER,email:MEMBER_EMAIL,name:'Member'},
    {recentAuthMethod:'password',nowSeconds:at});
  return verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:at});
}

async function signedSession(db,{at=NOW}={}){
  const token=await issueSession(db,{id:MEMBER,email:MEMBER_EMAIL,name:'Member'},
    {recentAuthMethod:'password',nowSeconds:at});
  return verifySignedRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},{nowSeconds:at});
}

async function requestDeletion(db){
  const payload=await signedSession(db);
  return requestAccountDeletion(db,{userId:MEMBER,sessionHash:payload.sessionHash,
    adminEmails:[],nowSeconds:NOW});
}

test('immediate deletion writes one ledger entry at deletion time, with no personal data',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  const auth=await verifiedSession(db);
  const result=await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:ledgerClient});
  assert.equal(result.status,'deleted');
  assert.deepEqual(result.ledger,{ok:true,recorded:true});
  const entries=await readDeletionLedgerEntries(ledgerClient);
  assert.deepEqual(entries,[
    {account_id:MEMBER,deleted_at:ISO,created_at:'2026-01-01T00:00:00.000Z'},
  ]);
  assert.equal(JSON.stringify(entries).includes(MEMBER_EMAIL),false);
});

test('scheduled execution writes one ledger entry; a cancelled request writes none',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  assert.equal((await requestDeletion(db)).ok,true);
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
  const cancelPayload=await signedSession(db,{at:NOW+60});
  const cancelled=await cancelAccountDeletion(db,{userId:MEMBER,sessionHash:cancelPayload.sessionHash,
    nowSeconds:NOW+60});
  assert.equal(cancelled.ok,true);
  // Cancelling leaves no entry, and the now-cancelled request cannot execute.
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
  const executed=await executeScheduledAccountDeletion(db,{userId:MEMBER,adminEmails:[],
    hashInvitationEmail,nowSeconds:NOW+DELETION_GRACE_SECONDS,deletionLedgerClient:ledgerClient});
  assert.deepEqual({ok:executed.ok,reason:executed.reason},{ok:false,reason:'not_pending'});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
});

test('scheduled execution writes one entry; blocked execution writes none',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  assert.equal((await requestDeletion(db)).ok,true);
  // After the request the member becomes the only owner of circle 20.
  await db.execute({sql:`UPDATE circle_memberships SET role='owner' WHERE circle_id=20 AND user_id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=4`});
  const blocked=await executeScheduledAccountDeletion(db,{userId:MEMBER,adminEmails:[],
    hashInvitationEmail,nowSeconds:NOW+DELETION_GRACE_SECONDS,deletionLedgerClient:ledgerClient});
  assert.deepEqual({ok:blocked.ok,reason:blocked.reason},{ok:false,reason:'last_owner'});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
  // Once a co-owner exists, the same request executes and writes the entry.
  await db.execute({sql:`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=4`});
  const executed=await executeScheduledAccountDeletion(db,{userId:MEMBER,adminEmails:[],
    hashInvitationEmail,nowSeconds:NOW+DELETION_GRACE_SECONDS,deletionLedgerClient:ledgerClient});
  assert.equal(executed.status,'deleted');
  assert.deepEqual(executed.ledger,{ok:true,recorded:true});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[
    {account_id:MEMBER,deleted_at:new Date((NOW+DELETION_GRACE_SECONDS)*1000).toISOString(),
      created_at:'2026-01-01T00:00:00.000Z'},
  ]);
});

test('not-due execution writes no entry',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  assert.equal((await requestDeletion(db)).ok,true);
  const early=await executeScheduledAccountDeletion(db,{userId:MEMBER,adminEmails:[],
    hashInvitationEmail,nowSeconds:NOW+60,deletionLedgerClient:ledgerClient});
  assert.deepEqual({ok:early.ok,reason:early.reason},{ok:false,reason:'not_due'});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
});

test('ledger disabled (null client) or unconfigured: deletion succeeds and writes nothing',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  const auth=await verifiedSession(db);
  const disabled=await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:null});
  assert.equal(disabled.status,'deleted');
  assert.equal(disabled.ledger,undefined);
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);

  // Unconfigured: env has no ledger vars, no client passed.
  const db2=await fixture();
  const auth2=await verifiedSession(db2);
  const unconfigured=await deleteAccount(db2,{userId:MEMBER,sessionHash:auth2.sessionHash,
    hashInvitationEmail,nowSeconds:NOW});
  assert.equal(unconfigured.status,'deleted');
  assert.equal(unconfigured.ledger,undefined);
});

test('env-configured ledger: the default path writes without an injected client',async()=>{
  const db=await fixture();
  const {client:ledgerClient,url}=await ledger();
  process.env.DELETION_LEDGER_DATABASE_URL=url;
  delete process.env.DELETION_LEDGER_AUTH_TOKEN;
  const auth=await verifiedSession(db);
  const result=await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW});
  assert.equal(result.status,'deleted');
  assert.deepEqual(result.ledger,{ok:true,recorded:true});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[
    {account_id:MEMBER,deleted_at:ISO,created_at:'2026-01-01T00:00:00.000Z'},
  ]);
});

test('ledger-write failure surfaces, the deletion stands, and a retry backfills from the audit trail',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  const failing={execute:async()=>{ throw new Error('ledger database down'); }};
  const auth=await verifiedSession(db);
  await assert.rejects(deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:failing}),/ledger database down/);
  // The deletion itself committed despite the ledger failure.
  const tombstone=await db.execute({sql:`SELECT password_hash FROM auth_accounts WHERE id=?`,args:[MEMBER]});
  assert.equal(tombstone.rows[0].password_hash,DELETED_ACCOUNT_PASSWORD_HASH);
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
  // A retry re-enters as already_deleted and backfills the true
  // deletion time from the earliest account.deleted audit event.
  const retry=await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW+60,deletionLedgerClient:ledgerClient});
  assert.equal(retry.status,'already_deleted');
  assert.deepEqual(retry.ledger,{ok:true,recorded:true});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[
    {account_id:MEMBER,deleted_at:ISO,created_at:'2026-01-01T00:00:00.000Z'},
  ]);
});

test('a second deletion of an already-deleted account backfills a missing entry',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  const auth=await verifiedSession(db);
  // First deletion with no ledger at all.
  await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:null});
  const again=await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW+60,deletionLedgerClient:ledgerClient});
  assert.equal(again.status,'already_deleted');
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[
    {account_id:MEMBER,deleted_at:ISO,created_at:'2026-01-01T00:00:00.000Z'},
  ]);
});

test('destroying the ledger removes the writer entries (retention/destruction)',async()=>{
  const db=await fixture();
  const {client:ledgerClient}=await ledger();
  const auth=await verifiedSession(db);
  await deleteAccount(db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:ledgerClient});
  assert.equal((await readDeletionLedgerEntries(ledgerClient)).length,1);
  assert.deepEqual(await destroyDeletionLedger(ledgerClient),{ok:true,deleted:1});
  assert.deepEqual(await readDeletionLedgerEntries(ledgerClient),[]);
});
