// Issue #383: simulated restore from a DESTROYED source. The source
// app database is deleted (its file removed); the separate ledger
// database survives. Re-applying from the ledger DB must tombstone the
// resurrected account on the restored database and pass `verify`, and
// the ledger's own retention (purge) and destruction (destroy) must work
// through the operator CLI. Output stays counts-only throughout.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  deleteAccount,
} from '../../api/_account-deletion.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import {
  DELETION_LEDGER_DB_SCHEMA,
  main,
  publicCliError,
} from '../../scripts/deletion-ledger.mjs';
import { readDeletionLedgerEntries } from '../../api/_deletion-ledger-db.js';

const JWT_SECRET='deletion-ledger-destroyed-source-secret-at-least-32-bytes';
const NOW=Math.floor(Date.now()/1000);
const DELETED_AT=new Date(NOW*1000).toISOString();
// Restore point an hour before the deletion: the restored database
// holds the member live, with their personal data.
const RESTORE_POINT=new Date((NOW-3600)*1000).toISOString();
const BEFORE='2026-01-01T00:00:00.000Z';
const MEMBER=2;
const MEMBER_EMAIL='member@example.test';
const resources=[];
const originalSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
});

async function migratedAppDb(prefix){
  const {directory,url,path}=await createMigratedDatabase({prefix});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return {db,url,path,directory};
}

async function ledgerDb(){
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-destroyed-'));
  const path=join(directory,'ledger.db');
  const client=createClient({url:`file:${path}`});
  await client.execute({sql:DELETION_LEDGER_DB_SCHEMA,args:[]});
  resources.push(async()=>{ client.close(); rmSync(directory,{recursive:true,force:true}); });
  return {client,url:`file:${path}`,path};
}

// Owner 1, member 2 (deleted, then resurrected by the restore),
// partner 3. Member 2 starts with personal data a restore would
// resurrect: a bio, a phone number, a chat message and a solo run.
async function seed(db){
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone,created_at)
      VALUES (1,'owner@example.test','$2a$10$owner','Owner','#111111',1,0,NULL,NULL,'${BEFORE}'),
        (2,'member@example.test','$2a$10$member','Member','#222222',0,0,'Member bio','+44 7700 900222','${BEFORE}'),
        (3,'partner@example.test','$2a$10$partner','Partner','#333333',0,0,NULL,NULL,'${BEFORE}')`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES
      (1,1,'owner','active',NULL),(1,2,'member','active',1),(1,3,'member','active',1)`,
    `INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message) VALUES
      (1,10,1,2,'Member secret message')`,
    `INSERT INTO session_runs (id,user_id,code) VALUES (1,2,'secret code')`,
  ],'write');
  const token=await issueSession(db,{id:MEMBER,email:MEMBER_EMAIL,name:'Member'},{
    recentAuthMethod:'password',nowSeconds:NOW,
  });
  const auth=await verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:NOW});
  return auth;
}

function stdoutCapture(){
  const chunks=[];
  return {chunks,stdout:{write(chunk){ chunks.push(String(chunk)); return true; }}};
}

async function run({argv,env}){
  const {chunks,stdout}=stdoutCapture();
  const {result,exitCode}=await main({
    argv,stdout,env,createDatabaseClient:config=>createClient(config),
  });
  return {result,exitCode,output:chunks.join('')};
}

function appEnv(url){
  return {TURSO_DATABASE_URL:url,JWT_SECRET};
}

function ledgerEnv(url){
  return {DELETION_LEDGER_DATABASE_URL:url};
}

test('destroyed-source restore: ledger DB survives, re-apply re-deletes, verify passes',async()=>{
  const source=await migratedAppDb('randori-destroyed-source-');
  const ledger=await ledgerDb();
  const auth=await seed(source.db);
  // Real deletion, written to the ledger DB at execution time.
  const deleted=await deleteAccount(source.db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:ledger.client});
  assert.equal(deleted.status,'deleted');
  assert.deepEqual(await readDeletionLedgerEntries(ledger.client),[
    {account_id:MEMBER,deleted_at:DELETED_AT,created_at:BEFORE},
  ]);

  // The source database is DESTROYED: close it and remove its files.
  // There is nothing left to export a ledger from.
  source.db.close();
  rmSync(source.directory,{recursive:true,force:true});
  assert.equal(existsSync(source.path),false);

  // The restored database is the pre-deletion state (PITR to an hour
  // before the deletion): the member is live again, personal data back.
  const restored=await migratedAppDb('randori-destroyed-restored-');
  await seed(restored.db);
  const before=await restored.db.execute({sql:`SELECT bio,phone FROM auth_accounts WHERE id=?`,args:[MEMBER]});
  assert.equal(before.rows[0].bio,'Member bio');

  // Before re-application the restored database fails verification
  // against the ledger DB — the deletion is missing there.
  const failing=await run({argv:['verify','--from','ledger-db','--restore-point',RESTORE_POINT],
    env:{...appEnv(restored.url),...ledgerEnv(ledger.url)}});
  assert.equal(failing.exitCode,1);
  assert.equal(failing.result.missing,1);
  assert.equal(failing.output.includes(MEMBER_EMAIL),false);

  // Re-apply from the ledger DB (no ledger file involved).
  const reapplied=await run({argv:['reapply','--from','ledger-db','--restore-point',RESTORE_POINT],
    env:{...appEnv(restored.url),...ledgerEnv(ledger.url)}});
  assert.equal(reapplied.exitCode,0);
  assert.deepEqual(reapplied.result,{command:'reapply',entries:1,reapplied:1});
  assert.equal(reapplied.output.includes(MEMBER_EMAIL),false);

  // The resurrected personal data is scrubbed again.
  const after=await restored.db.execute({sql:`SELECT email,password_hash,bio,phone FROM auth_accounts WHERE id=?`,args:[MEMBER]});
  assert.deepEqual([after.rows[0].email,after.rows[0].password_hash,after.rows[0].bio,after.rows[0].phone],
    [`deleted-${MEMBER}@account-deleted.invalid`,DELETED_ACCOUNT_PASSWORD_HASH,null,null]);
  const message=await restored.db.execute({sql:`SELECT message FROM pair_messages WHERE id=1`,args:[]});
  assert.equal(message.rows[0].message,'Message deleted');
  const runRow=await restored.db.execute({sql:`SELECT COUNT(*) AS n FROM session_runs WHERE user_id=?`,args:[MEMBER]});
  assert.equal(Number(runRow.rows[0].n),0);

  // Verification now passes: the restore is cutover-ready.
  const verified=await run({argv:['verify','--from','ledger-db','--restore-point',RESTORE_POINT],
    env:{...appEnv(restored.url),...ledgerEnv(ledger.url)}});
  assert.equal(verified.exitCode,0);
  assert.deepEqual(verified.result,{command:'verify',checked:1,missing:0});
});

test('CLI export --from ledger-db writes the same file shape as source export',async()=>{
  const source=await migratedAppDb('randori-ledger-export-source-');
  const ledger=await ledgerDb();
  const auth=await seed(source.db);
  await deleteAccount(source.db,{userId:MEMBER,sessionHash:auth.sessionHash,
    hashInvitationEmail,nowSeconds:NOW,deletionLedgerClient:ledger.client});
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const out=join(directory,'ledger.json');
  const exported=await run({argv:['export','--from','ledger-db','--out',out],env:ledgerEnv(ledger.url)});
  assert.equal(exported.exitCode,0);
  assert.equal(exported.output,'{"command":"export","entries":1}\n');
  const document=JSON.parse(readFileSync(out,'utf8'));
  assert.deepEqual(document.entries,[
    {account_id:MEMBER,deleted_at:DELETED_AT,created_at:BEFORE},
  ]);
  // A file exported from the ledger DB re-applies exactly like a
  // source export: verify + reapply from the file against a restore.
  const restored=await migratedAppDb('randori-ledger-export-restored-');
  await seed(restored.db);
  const reapplied=await run({argv:['reapply','--ledger',out,'--restore-point',RESTORE_POINT],
    env:appEnv(restored.url)});
  assert.equal(reapplied.exitCode,0);
});

test('CLI init creates the ledger schema and is idempotent',async()=>{
  const ledger=await ledgerDb();
  // Start from an empty file database with no table at all.
  ledger.client.close();
  const freshDirectory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-init-'));
  resources.push(async()=>{ rmSync(freshDirectory,{recursive:true,force:true}); });
  const freshUrl=`file:${join(freshDirectory,'ledger.db')}`;
  const first=await run({argv:['init'],env:ledgerEnv(freshUrl)});
  assert.equal(first.exitCode,0);
  assert.deepEqual(first.result,{command:'init',schema_version:1});
  const second=await run({argv:['init'],env:ledgerEnv(freshUrl)});
  assert.equal(second.exitCode,0);
  const client=createClient({url:freshUrl});
  resources.push(async()=>{ client.close(); });
  assert.deepEqual(await readDeletionLedgerEntries(client),[]);
  // init needs no JWT_SECRET and no app database.
  const noSecret=await run({argv:['init'],env:{DELETION_LEDGER_DATABASE_URL:freshUrl}});
  assert.equal(noSecret.exitCode,0);
});

test('CLI purge destroys entries older than the cutoff and never null entries; destroy needs the exact confirmation',async()=>{
  const ledger=await ledgerDb();
  const client=ledger.client;
  await client.execute({sql:`INSERT INTO deletion_ledger (account_id,deleted_at,created_at) VALUES
    (2,'2026-10-20T10:00:00.000Z','${BEFORE}'),
    (3,'2026-10-27T10:00:00.000Z','${BEFORE}'),
    (4,NULL,'${BEFORE}')`,args:[]});
  // Retention: entries deleted before now-minus-backup-window go.
  const purged=await run({argv:['purge','--before','2026-10-27T00:00:00.000Z'],env:ledgerEnv(ledger.url)});
  assert.equal(purged.exitCode,0);
  assert.deepEqual(purged.result,{command:'purge',purged:1});
  assert.deepEqual((await readDeletionLedgerEntries(client)).map(entry=>entry.account_id),[3,4]);
  await assert.rejects(
    run({argv:['purge','--before','not-a-date'],env:ledgerEnv(ledger.url)}),/valid --before/);
  await assert.rejects(run({argv:['purge'],env:ledgerEnv(ledger.url)}),/Usage:/);
  // Destroy refuses without the exact confirmation phrase.
  await assert.rejects(run({argv:['destroy'],env:ledgerEnv(ledger.url)}),/Usage:/);
  await assert.rejects(run({argv:['destroy','--confirm','wrong'],env:ledgerEnv(ledger.url)}),/Usage:/);
  const destroyed=await run({argv:['destroy','--confirm','DESTROY_DELETION_LEDGER'],env:ledgerEnv(ledger.url)});
  assert.deepEqual(destroyed.result,{command:'destroy',deleted:2});
  assert.deepEqual(await readDeletionLedgerEntries(client),[]);
});

test('CLI ledger modes validate config: missing ledger URL is a typed config error, reapply from ledger-db needs JWT_SECRET',async()=>{
  const restored=await migratedAppDb('randori-ledger-config-');
  await assert.rejects(
    run({argv:['export','--from','ledger-db','--out','/tmp/x.json'],env:{}}),
    /DELETION_LEDGER_DATABASE_URL is required/);
  const ledger=await ledgerDb();
  await assert.rejects(
    run({argv:['reapply','--from','ledger-db','--restore-point',RESTORE_POINT],
      env:{TURSO_DATABASE_URL:restored.url,...ledgerEnv(ledger.url)}}),
    /JWT_SECRET is required/);
  // ...while verify --from ledger-db needs no secret.
  const verified=await run({argv:['verify','--from','ledger-db','--restore-point',RESTORE_POINT],
    env:{TURSO_DATABASE_URL:restored.url,...ledgerEnv(ledger.url)}});
  assert.equal(verified.exitCode,0);
  assert.deepEqual(verified.result,{command:'verify',checked:0,missing:0});
  // A file-mode reapply and a ledger-db reapply cannot be combined.
  await assert.rejects(run({argv:['reapply','--from','ledger-db','--ledger','x','--restore-point',RESTORE_POINT],
    env:{...appEnv(restored.url),...ledgerEnv(ledger.url)}}),/Usage:/);
  assert.deepEqual(publicCliError(Object.assign(new Error('x'),{code:'DELETION_LEDGER_CONFIG'})),{
    ok:false,error:'DELETION_LEDGER_CONFIG',message:'x',
  });
});

test('privacy wording: the policy describes the durable ledger and its bounded retention',async()=>{
  const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const privacy=readFileSync(join(repositoryRoot,'privacy.html'),'utf8');
  assert.match(privacy,/separate database/);
  assert.doesNotMatch(privacy,/that re-application is not yet possible/);
  assert.match(privacy,/no longer than the backup window/);
});
