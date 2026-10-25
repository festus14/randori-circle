#!/usr/bin/env node
// Operator CLI for the account-deletion ledger (issue #366, ID-89).
//
// A point-in-time restore to T brings back personal data deleted after T.
// Before cutting over to a restored database, the operator exports the
// ledger from the still-live SOURCE database, re-applies it to the RESTORED
// database, and verifies it there. The ledger file holds only opaque account
// ids and timestamps; keep it outside any database, never commit it, never
// upload it as a GitHub artifact, and destroy it once the cutover is
// verified. See docs/TURSO_BACKUP_RESTORE_REHEARSAL.md.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... JWT_SECRET=... node scripts/deletion-ledger.mjs export --out /operator/path/ledger.json [--restore-point 2026-10-25T10:00:00.000Z]
//   TURSO_DATABASE_URL=<restored> ... node scripts/deletion-ledger.mjs reapply --ledger /operator/path/ledger.json --restore-point 2026-10-25T10:00:00.000Z
//   TURSO_DATABASE_URL=<restored> ... node scripts/deletion-ledger.mjs verify --ledger /operator/path/ledger.json --restore-point 2026-10-25T10:00:00.000Z
//
// `export` reads the source database; `reapply` and `verify` run against
// the restored database. `reapply` stops on the first entry it cannot
// re-apply (fail closed, non-zero exit); `verify` exits non-zero while any
// due entry is not tombstoned. Output is counts only, never account ids.
//
// `export --out` must point outside this repository (a ledger must never
// be committed, and never land under `.git`), and refuses to overwrite an
// existing file or follow a symlink. `export --restore-point` only
// minimises what is written to the file: `reapply` and `verify` still
// filter by their own `--restore-point`, which is the gate that decides
// what is re-applied, so export-time filtering is never a substitute for
// reapply-time filtering. `JWT_SECRET` for `export`/`reapply` must be the
// secret in effect when the deletions were made, not a rotated
// replacement: re-application re-hashes invitation emails with it, so a
// different secret produces different hashes. `verify` needs no secret.
import { closeSync, fchmodSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';

import {
  DELETION_LEDGER_VERSION,
  buildDeletionLedger,
  deletionLedgerEntriesAfter,
  parseDeletionLedger,
  reapplyAccountDeletion,
  verifyDeletionLedger,
} from '../api/_account-deletion.js';
import { hashInvitationEmail } from '../api/_circle-membership.js';

const COMMANDS=new Set(['export','reapply','verify']);

function fail(message,code){
  throw Object.assign(new Error(message),{code});
}

function parseArgs(argv){
  const [command,...rest]=argv;
  if(!COMMANDS.has(command)) fail('Usage: node scripts/deletion-ledger.mjs <export|reapply|verify> [--out FILE | --ledger FILE] --restore-point ISO', 'DELETION_LEDGER_USAGE');
  const options={};
  for(let index=0;index<rest.length;index+=1){
    const flag=rest[index];
    if((flag==='--out'||flag==='--ledger'||flag==='--restore-point')&&index+1<rest.length){
      options[flag.slice(2)]=rest[index+1];
      index+=1;
    }else{
      fail(`Usage: node scripts/deletion-ledger.mjs <export|reapply|verify> [--out FILE | --ledger FILE] --restore-point ISO`, 'DELETION_LEDGER_USAGE');
    }
  }
  if(command==='export'&&(!options.out||options.ledger)) {
    fail('Usage: node scripts/deletion-ledger.mjs export --out FILE [--restore-point ISO]', 'DELETION_LEDGER_USAGE');
  }
  if(command!=='export'&&(!options.ledger||!options['restore-point']||options.out)){
    fail('Usage: node scripts/deletion-ledger.mjs <reapply|verify> --ledger FILE --restore-point ISO', 'DELETION_LEDGER_USAGE');
  }
  return {command,...options};
}

export function databaseConfig(env){
  const url=String(env.TURSO_DATABASE_URL||'').trim();
  if(!url) fail('TURSO_DATABASE_URL is required','DELETION_LEDGER_CONFIG');
  return {url,authToken:String(env.TURSO_AUTH_TOKEN||'').trim()||undefined};
}

// `export` and `reapply` both run under the secret that hashed invitation
// emails at deletion time; `verify` never hashes, so it needs no secret.
// Checked before any database connection, so a missing secret is a typed
// config error, not a mid-run generic failure.
function requireJwtSecret(env,command){
  if(command!=='export'&&command!=='reapply') return;
  if(!String(env.JWT_SECRET||'').trim()) fail('JWT_SECRET is required','DELETION_LEDGER_CONFIG');
}

const REPOSITORY_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

function assertOutOutsideRepository(out){
  const resolved=resolve(out);
  if(resolved===REPOSITORY_ROOT||resolved.startsWith(REPOSITORY_ROOT+sep)){
    fail('deletion ledger --out must be outside the repository (never commit a ledger, and never write under .git)','DELETION_LEDGER_FILE');
  }
}

// Creates the ledger file atomically with mode 0600: 'wx' refuses to
// overwrite an existing file and refuses to follow a symlink, and the
// defensive fchmod covers a umask that would otherwise widen the mode.
// A failed write removes the file this call created, so a retry is not
// blocked by a partial ledger.
function writeLedgerFileExclusive(out,contents){
  let fd;
  try{
    fd=openSync(out,'wx',0o600);
  }catch(error){
    if(error?.code==='EEXIST') fail('deletion ledger file already exists; refusing to overwrite','DELETION_LEDGER_FILE');
    fail('deletion ledger file could not be created','DELETION_LEDGER_FILE');
  }
  try{
    fchmodSync(fd,0o600);
    writeFileSync(fd,contents,'utf8');
  }catch(error){
    try{ unlinkSync(out); }catch{}
    if(error?.code?.startsWith('DELETION_LEDGER_')) throw error;
    fail('deletion ledger file could not be written','DELETION_LEDGER_FILE');
  }finally{
    closeSync(fd);
  }
}

function readLedger(path){
  let parsed;
  try{
    parsed=JSON.parse(readFileSync(path,'utf8'));
  }catch{
    fail('deletion ledger file is not valid JSON','DELETION_LEDGER_FILE');
  }
  if(!parsed||typeof parsed!=='object'||parsed.version!==DELETION_LEDGER_VERSION||!Array.isArray(parsed.entries)){
    fail('deletion ledger file has the wrong shape','DELETION_LEDGER_FILE');
  }
  return parseDeletionLedger(parsed.entries);
}

export function publicCliError(error){
  const code=String(error?.code||'');
  if(['DELETION_LEDGER_USAGE','DELETION_LEDGER_CONFIG','DELETION_LEDGER_FILE'].includes(code)){
    return {ok:false,error:code,message:String(error.message||'invalid deletion ledger request')};
  }
  return {ok:false,error:'DELETION_LEDGER_FAILED',message:'deletion ledger operation failed'};
}

export async function main({
  argv=process.argv.slice(2),
  env=process.env,
  stdout=process.stdout,
  createDatabaseClient=createClient,
}={}){
  const {command,out,ledger:ledgerPath,'restore-point':restorePoint}=parseArgs(argv);
  const config=databaseConfig(env);
  requireJwtSecret(env,command);
  if(command==='export') assertOutOutsideRepository(out);
  const client=createDatabaseClient(config);
  try{
    if(command==='export'){
      const allEntries=await buildDeletionLedger(client);
      // Export-time filtering is minimisation only: it shrinks what is
      // written to the file. Reapply/verify re-filter by their own
      // --restore-point, which is the gate that decides what is re-applied.
      let entries=allEntries;
      if(restorePoint){
        try{
          entries=deletionLedgerEntriesAfter(allEntries,restorePoint);
        }catch{
          fail('valid --restore-point is required','DELETION_LEDGER_USAGE');
        }
      }
      const document=Object.freeze({
        version:DELETION_LEDGER_VERSION,
        exported_at:new Date().toISOString(),
        entries,
      });
      writeLedgerFileExclusive(out,`${JSON.stringify(document,null,2)}\n`);
      const result={command,entries:entries.length};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:0};
    }
    const ledger=readLedger(ledgerPath);
    if(command==='verify'){
      const verification=await verifyDeletionLedger(client,{ledger,restorePoint});
      const result={command,checked:verification.checked,missing:verification.missing.length};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:verification.ok?0:1};
    }
    const due=deletionLedgerEntriesAfter(ledger,restorePoint);
    const outcomes={};
    for(const entry of due){
      const applied=await reapplyAccountDeletion(client,{
        entry,restorePoint,hashInvitationEmail,nowSeconds:Math.floor(Date.now()/1000),
      });
      outcomes[applied.status]=(outcomes[applied.status]||0)+1;
      if(!applied.ok){
        const result={command,reapplied:outcomes.reapplied||0,failed:1,status:applied.reason};
        stdout.write(`${JSON.stringify(result)}\n`);
        return {result,exitCode:1};
      }
    }
    const result={command,entries:due.length,...outcomes};
    stdout.write(`${JSON.stringify(result)}\n`);
    return {result,exitCode:0};
  }finally{
    client.close?.();
  }
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  main().then(({exitCode})=>{ process.exitCode=exitCode; }).catch(error=>{
    process.stderr.write(`${JSON.stringify(publicCliError(error))}\n`);
    process.exitCode=1;
  });
}
