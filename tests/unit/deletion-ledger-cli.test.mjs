// Issue #366: the deletion-ledger operator CLI, exercised against real
// migrated SQLite files through its injected database-client factory.
// Output is counts only: no account id may appear in stdout.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import {
  DELETION_LEDGER_VERSION,
  buildDeletionLedger,
} from '../../api/_account-deletion.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { main, publicCliError, writeLedgerFileExclusive } from '../../scripts/deletion-ledger.mjs';

const JWT_SECRET='deletion-ledger-cli-test-secret-at-least-32-bytes';
const RESTORE_POINT='2026-10-20T09:00:00.000Z';
const REPOSITORY_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const DELETED_AT='2026-10-20T10:00:00.000Z';
const resources=[];
const originalSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
});

async function database(){
  const {directory,url,path}=await createMigratedDatabase({prefix:'randori-deletion-ledger-cli-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return {db,url,path};
}

function stdoutCapture(){
  const chunks=[];
  return {chunks,stdout:{write(chunk){ chunks.push(String(chunk)); return true; }}};
}

async function run({argv,url}){
  const {chunks,stdout}=stdoutCapture();
  const {result,exitCode}=await main({
    argv,stdout,
    env:{TURSO_DATABASE_URL:url,JWT_SECRET},
    createDatabaseClient:config=>createClient(config),
  });
  return {result,exitCode,output:chunks.join('')};
}

test('CLI export writes a versioned, mode-0600 ledger and prints counts only',async()=>{
  const {db,url}=await database();
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (2,'deleted-2@account-deleted.invalid','!account-deleted','Deleted member','#9aa0a6')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key,created_at) VALUES
      (1,'account.deleted',2,2,'account.deleted:2:1:${DELETED_AT}','${DELETED_AT}')`,
  ],'write');
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const out=join(directory,'ledger.json');
  const {exitCode,output}=await run({argv:['export','--out',out],url});
  assert.equal(exitCode,0);
  assert.equal(output,'{"command":"export","entries":1}\n');
  assert.equal(output.includes('deleted-2'),false);
  const document=JSON.parse(readFileSync(out,'utf8'));
  assert.equal(document.version,DELETION_LEDGER_VERSION);
  assert.equal(document.entries.length,1);
  assert.equal(document.entries[0].account_id,2);
  assert.equal(document.entries[0].deleted_at,DELETED_AT);
  assert.equal(statSync(out).mode&0o777,0o600);
});

test('CLI reapply and verify drive a restore from export to cutover-ready',async()=>{
  const source=await database();
  const restored=await database();
  await source.db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,created_at) VALUES
      (2,'deleted-2@account-deleted.invalid','!account-deleted','Deleted member','#9aa0a6','2026-01-01T00:00:00.000Z')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key,created_at) VALUES
      (1,'account.deleted',2,2,'account.deleted:2:1:${DELETED_AT}','${DELETED_AT}')`,
  ],'write');
  await restored.db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,created_at) VALUES
      (2,'member@example.test','$2a$10$member','Member','#222222','2026-01-01T00:00:00.000Z')`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (1,2,'member','active',1)`,
  ],'write');
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const ledgerFile=join(directory,'ledger.json');
  await run({argv:['export','--out',ledgerFile],url:source.url});

  // Before re-application the restored database fails verification.
  const before=await run({argv:['verify','--ledger',ledgerFile,'--restore-point',RESTORE_POINT],url:restored.url});
  assert.equal(before.exitCode,1);
  assert.equal(before.result.missing,1);

  const reapplied=await run({argv:['reapply','--ledger',ledgerFile,'--restore-point',RESTORE_POINT],url:restored.url});
  assert.equal(reapplied.exitCode,0);
  assert.deepEqual(reapplied.result,{command:'reapply',entries:1,reapplied:1});
  assert.equal(reapplied.output.includes('member@example.test'),false);

  const after=await run({argv:['verify','--ledger',ledgerFile,'--restore-point',RESTORE_POINT],url:restored.url});
  assert.equal(after.exitCode,0);
  assert.deepEqual(after.result,{command:'verify',checked:1,missing:0});
});

test('CLI reapply stops on the first entry it cannot re-apply',async()=>{
  const restored=await database();
  await restored.db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,created_at) VALUES
      (2,'member@example.test','$2a$10$member','Member','#222222','2026-01-01T00:00:00.000Z')`,
  ],'write');
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const ledgerFile=join(directory,'ledger.json');
  const {writeFileSync}=await import('node:fs');
  writeFileSync(ledgerFile,JSON.stringify({version:DELETION_LEDGER_VERSION,exported_at:DELETED_AT,entries:[
    {account_id:99,created_at:'2026-01-01T00:00:00.000Z',deleted_at:DELETED_AT},
  ]}),'utf8');
  const {exitCode,result}=await run({argv:['reapply','--ledger',ledgerFile,'--restore-point',RESTORE_POINT],url:restored.url});
  assert.equal(exitCode,1);
  assert.equal(result.status,'missing_in_restore');
});

test('CLI usage, config and ledger-file errors are typed and public errors stay generic',async()=>{
  const {url}=await database();
  await assert.rejects(run({argv:['frobnicate'],url}),/Usage:/);
  await assert.rejects(run({argv:['export'],url}),/Usage:/);
  await assert.rejects(run({argv:['export','--out'],url}),/Usage:/);
  await assert.rejects(run({argv:['export','--out','x','--ledger','y'],url}),/Usage:/);
  await assert.rejects(run({argv:['reapply','--ledger','x'],url}),/Usage:/);
  await assert.rejects(run({argv:['verify','--ledger','x','--restore-point',RESTORE_POINT,'--out','y'],url}),/Usage:/);
  const {chunks,stdout}=stdoutCapture();
  await assert.rejects(main({argv:['export','--out','x'],stdout,env:{},createDatabaseClient:()=>createClient({url})}),
    /TURSO_DATABASE_URL is required/);
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const bad=join(directory,'bad.json');
  const {writeFileSync}=await import('node:fs');
  writeFileSync(bad,'not json','utf8');
  await assert.rejects(run({argv:['verify','--ledger',bad,'--restore-point',RESTORE_POINT],url}),/not valid JSON/);
  const wrongVersion=join(directory,'wrong.json');
  writeFileSync(wrongVersion,JSON.stringify({version:99,entries:[]}),'utf8');
  await assert.rejects(run({argv:['verify','--ledger',wrongVersion,'--restore-point',RESTORE_POINT],url}),/wrong shape/);
  assert.deepEqual(publicCliError(Object.assign(new Error('x'),{code:'DELETION_LEDGER_USAGE'})),{
    ok:false,error:'DELETION_LEDGER_USAGE',message:'x',
  });
  assert.deepEqual(publicCliError(new Error('boom')),{
    ok:false,error:'DELETION_LEDGER_FAILED',message:'deletion ledger operation failed',
  });
  // The module's own builder is the export path: a database with no
  // tombstones exports an empty ledger.
  assert.deepEqual(await buildDeletionLedger((await database()).db),[]);
});

test('CLI export refuses to overwrite an existing file or follow a symlink',async()=>{
  const {url}=await database();
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const existing=join(directory,'ledger.json');
  writeFileSync(existing,'ORIGINAL\n','utf8');
  await assert.rejects(run({argv:['export','--out',existing],url}),/already exists/);
  assert.equal(readFileSync(existing,'utf8'),'ORIGINAL\n');
  const victim=join(directory,'victim.json');
  writeFileSync(victim,'VICTIM\n','utf8');
  const link=join(directory,'link.json');
  symlinkSync(victim,link);
  await assert.rejects(run({argv:['export','--out',link],url}),/already exists/);
  assert.equal(readFileSync(victim,'utf8'),'VICTIM\n');
  assert.equal(lstatSync(link).isSymbolicLink(),true);
});

test('CLI export rejects --out inside the repository and ledger files are gitignored',async()=>{
  const {url}=await database();
  const inside=join(REPOSITORY_ROOT,'deletion-ledger-do-not-commit.json');
  await assert.rejects(run({argv:['export','--out',inside],url}),/outside the repository/);
  assert.equal(existsSync(inside),false);
  const underGit=join(REPOSITORY_ROOT,'.git','deletion-ledger.json');
  await assert.rejects(run({argv:['export','--out',underGit],url}),/outside the repository/);
  const gitignore=readFileSync(join(REPOSITORY_ROOT,'.gitignore'),'utf8').split('\n');
  assert.equal(gitignore.includes('deletion-ledger*.json'),true);
  assert.equal(gitignore.includes('*deletion-ledger*.json'),true);
});

test('CLI export rejects --out under a symlinked parent pointing into the repository',async()=>{
  const {url}=await database();
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  // Symlink target is a scratch directory inside the repository, so a
  // buggy implementation that wrote through the link could only pollute
  // this directory, which the cleanup below removes.
  const inside=mkdtempSync(join(REPOSITORY_ROOT,'deletion-ledger-symlink-'));
  const link=join(directory,'repo-link');
  symlinkSync(inside,link);
  resources.push(async()=>{
    try{ unlinkSync(link); }catch{}
    rmSync(directory,{recursive:true,force:true});
    rmSync(inside,{recursive:true,force:true});
  });
  await assert.rejects(run({argv:['export','--out',join(link,'ledger.json')],url}),/outside the repository/);
  assert.equal(existsSync(join(inside,'ledger.json')),false);
  // The same rejection for a not-yet-existing parent under the link:
  // the realpath walk must resolve the symlinked ancestor, not the
  // missing leaf.
  await assert.rejects(run({argv:['export','--out',join(link,'missing','ledger.json')],url}),/outside the repository/);
  assert.equal(existsSync(join(inside,'missing','ledger.json')),false);
});

test('CLI export failed write leaves no partial file and a retry is unblocked',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const out=join(directory,'ledger.json');
  const failingWrite=()=>{ throw Object.assign(new Error('no space left on device'),{code:'ENOSPC'}); };
  assert.throws(()=>writeLedgerFileExclusive(out,'partial\n',{writeFileSync:failingWrite}),
    error=>{ assert.equal(error.code,'DELETION_LEDGER_FILE'); return /could not be written/.test(error.message); });
  assert.equal(existsSync(out),false);
  writeLedgerFileExclusive(out,'retry\n');
  assert.equal(readFileSync(out,'utf8'),'retry\n');
});

test('CLI reapply and verify map a malformed --restore-point to DELETION_LEDGER_USAGE',async()=>{
  const {url}=await database();
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const ledgerFile=join(directory,'ledger.json');
  writeFileSync(ledgerFile,JSON.stringify({version:DELETION_LEDGER_VERSION,exported_at:DELETED_AT,entries:[
    {account_id:2,created_at:'2026-01-01T00:00:00.000Z',deleted_at:DELETED_AT},
  ]}),'utf8');
  for(const command of ['reapply','verify']){
    let caught;
    try{
      await run({argv:[command,'--ledger',ledgerFile,'--restore-point','not-a-date'],url});
    }catch(error){ caught=error; }
    assert.equal(caught?.code,'DELETION_LEDGER_USAGE');
    assert.match(caught.message,/valid --restore-point/);
    assert.deepEqual(publicCliError(caught),{
      ok:false,error:'DELETION_LEDGER_USAGE',message:'valid --restore-point is required',
    });
  }
});

test('CLI export --restore-point writes only entries after the restore point, keeping null deleted_at',async()=>{
  const {db,url}=await database();
  await db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-one','one','Circle One',1,1)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (2,'deleted-2@account-deleted.invalid','!account-deleted','Deleted member','#9aa0a6'),
      (3,'deleted-3@account-deleted.invalid','!account-deleted','Deleted member','#9aa0a6'),
      (4,'deleted-4@account-deleted.invalid','!account-deleted','Deleted member','#9aa0a6')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key,created_at) VALUES
      (1,'account.deleted',2,2,'account.deleted:2:1:2026-10-20T08:00:00.000Z','2026-10-20T08:00:00.000Z'),
      (1,'account.deleted',3,3,'account.deleted:3:1:${DELETED_AT}','${DELETED_AT}')`,
  ],'write');
  const directory=mkdtempSync(join(tmpdir(),'randori-deletion-ledger-'));
  resources.push(async()=>{ rmSync(directory,{recursive:true,force:true}); });
  const out=join(directory,'ledger.json');
  const {exitCode,output}=await run({argv:['export','--out',out,'--restore-point',RESTORE_POINT],url});
  assert.equal(exitCode,0);
  assert.equal(output,'{"command":"export","entries":2}\n');
  const document=JSON.parse(readFileSync(out,'utf8'));
  // Account 2 was deleted before the restore point: minimised out.
  // Account 4 has no audit row (deleted_at null): always kept.
  assert.deepEqual(document.entries.map(entry=>entry.account_id),[3,4]);
  assert.equal(document.entries[0].deleted_at,DELETED_AT);
  assert.equal(document.entries[1].deleted_at,null);
  // A malformed restore point is a usage error, not a generic failure,
  // and writes no file.
  const badOut=join(directory,'bad.json');
  await assert.rejects(run({argv:['export','--out',badOut,'--restore-point','not-a-date'],url}),/valid --restore-point/);
  assert.equal(existsSync(badOut),false);
});

test('CLI validates JWT_SECRET up front with a typed config error',async()=>{
  const {url}=await database();
  let connected=false;
  const createDatabaseClient=()=>{ connected=true; return createClient({url}); };
  const {stdout}=stdoutCapture();
  await assert.rejects(main({argv:['reapply','--ledger','x','--restore-point',RESTORE_POINT],stdout,
    env:{TURSO_DATABASE_URL:url},createDatabaseClient}),/JWT_SECRET is required/);
  await assert.rejects(main({argv:['export','--out','x'],stdout,
    env:{TURSO_DATABASE_URL:url},createDatabaseClient}),/JWT_SECRET is required/);
  assert.equal(connected,false);
  assert.deepEqual(publicCliError(Object.assign(new Error('JWT_SECRET is required'),{code:'DELETION_LEDGER_CONFIG'})),{
    ok:false,error:'DELETION_LEDGER_CONFIG',message:'JWT_SECRET is required',
  });
});
