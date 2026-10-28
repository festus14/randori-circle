#!/usr/bin/env node
// Operator CLI for the account-deletion ledger (issue #366, ID-89;
// durable ledger database in #383).
//
// A point-in-time restore to T brings back personal data deleted after T.
// Before cutting over to a restored database, the operator re-applies
// the ledger to the RESTORED database and verifies it there. The ledger
// holds only opaque account ids and timestamps; a ledger file is kept
// outside any database, never committed, never uploaded as a GitHub
// artifact, and destroyed once the cutover is verified.
// See docs/TURSO_BACKUP_RESTORE_REHEARSAL.md.
//
// Ledger sources:
//   * `--from source` (default for `export`): build the ledger from the
//     still-live SOURCE app database (PITR never deletes the source).
//   * `--from ledger-db` (#383): read the durable ledger from its
//     SEPARATE Turso database, written at deletion time by
//     api/_account-deletion.js. This is the branch for a restore from a
//     DESTROYED source, where the source database is gone and there is
//     no source to export from. `reapply`/`verify --from ledger-db`
//     need no ledger file: they read the ledger DB directly, plus the
//     restored app database as their target.
//
//   DELETION_LEDGER_DATABASE_URL=... DELETION_LEDGER_AUTH_TOKEN=... node scripts/deletion-ledger.mjs init
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... JWT_SECRET=... node scripts/deletion-ledger.mjs export --out /operator/path/ledger.json [--restore-point 2026-10-25T10:00:00.000Z]
//   DELETION_LEDGER_DATABASE_URL=... DELETION_LEDGER_AUTH_TOKEN=... node scripts/deletion-ledger.mjs export --from ledger-db --out /operator/path/ledger.json [--restore-point 2026-10-25T10:00:00.000Z]
//   TURSO_DATABASE_URL=<restored> ... node scripts/deletion-ledger.mjs reapply --ledger /operator/path/ledger.json --restore-point 2026-10-25T10:00:00.000Z
//   TURSO_DATABASE_URL=<restored> ... DELETION_LEDGER_DATABASE_URL=... DELETION_LEDGER_AUTH_TOKEN=... node scripts/deletion-ledger.mjs reapply --from ledger-db --restore-point 2026-10-25T10:00:00.000Z
//   TURSO_DATABASE_URL=<restored> ... node scripts/deletion-ledger.mjs verify --ledger /operator/path/ledger.json --restore-point 2026-10-25T10:00:00.000Z
//   DELETION_LEDGER_DATABASE_URL=... DELETION_LEDGER_AUTH_TOKEN=... node scripts/deletion-ledger.mjs purge --before 2026-10-26T10:00:00.000Z
//   DELETION_LEDGER_DATABASE_URL=... DELETION_LEDGER_AUTH_TOKEN=... node scripts/deletion-ledger.mjs destroy --confirm DESTROY_DELETION_LEDGER
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
// reapply-time filtering. `JWT_SECRET` for `export` from the source and
// for `reapply` must be the secret in effect when the deletions were
// made, not a rotated replacement: re-application re-hashes invitation
// emails with it, so a different secret produces different hashes.
// `export --from ledger-db`, `verify`, `init`, `purge` and `destroy`
// need no secret (reading or deleting ledger entries hashes nothing).
//
// `init` creates the ledger database's own schema (one table, the
// minimal ledger shape). It is an operator step, run once per ledger
// database — the production ledger database is provisioned and
// initialised by the owner (#440), never by this PR and never from the
// API request path. `purge --before <cutoff>` destroys entries deleted
// before the cutoff (retention: the cutoff is now minus the provider
// backup window; entries with an unknown deletion time are never
// purged). `destroy` deletes every entry; it needs the exact
// confirmation phrase and is only for a verified cutover past the
// backup window or for retiring the ledger database.
import { closeSync, fchmodSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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
import {
  DELETION_LEDGER_DB_SCHEMA_VERSION,
  DELETION_LEDGER_TABLE,
  deletionLedgerDbConfig,
  destroyDeletionLedger,
  purgeDeletionLedgerEntries,
  readDeletionLedgerEntries,
} from '../api/_deletion-ledger-db.js';
import { hashInvitationEmail } from '../api/_circle-membership.js';

// The ledger database's own schema. One table, the minimal ledger
// shape, nothing else. Versioned by
// DELETION_LEDGER_DB_SCHEMA_VERSION in api/_deletion-ledger-db.js.
// Created only by `init` (operator CLI), never from the API request
// path, and never as an app-DB migration: the ledger DB is a separate
// database with its own schema.
export const DELETION_LEDGER_DB_SCHEMA=`CREATE TABLE IF NOT EXISTS ${DELETION_LEDGER_TABLE} (
  account_id INTEGER PRIMARY KEY CHECK(account_id>0),
  deleted_at TEXT CHECK(deleted_at IS NULL OR length(deleted_at)=24),
  created_at TEXT NOT NULL CHECK(length(created_at)=24)
)`;

const COMMANDS=new Set(['export','reapply','verify','init','purge','destroy']);
export const DESTROY_DELETION_LEDGER_CONFIRM='DESTROY_DELETION_LEDGER';

function fail(message,code){
  throw Object.assign(new Error(message),{code});
}

const USAGE='Usage: node scripts/deletion-ledger.mjs <export|reapply|verify|init|purge|destroy> [--out FILE | --ledger FILE | --from source|ledger-db] --restore-point ISO [--before ISO] [--confirm DESTROY_DELETION_LEDGER]';

function parseArgs(argv){
  const [command,...rest]=argv;
  if(!COMMANDS.has(command)) fail(USAGE,'DELETION_LEDGER_USAGE');
  const options={};
  for(let index=0;index<rest.length;index+=1){
    const flag=rest[index];
    if((flag==='--out'||flag==='--ledger'||flag==='--restore-point'||flag==='--from'||flag==='--before'||flag==='--confirm')&&index+1<rest.length){
      options[flag.slice(2)]=rest[index+1];
      index+=1;
    }else{
      fail(USAGE,'DELETION_LEDGER_USAGE');
    }
  }
  if(options.from!==undefined&&options.from!=='source'&&options.from!=='ledger-db'){
    fail(USAGE,'DELETION_LEDGER_USAGE');
  }
  const fromLedgerDb=options.from==='ledger-db';
  if(command==='export'){
    if(!options.out||options.ledger||options.before||options.confirm) fail(USAGE,'DELETION_LEDGER_USAGE');
  }else if(command==='reapply'||command==='verify'){
    if(!options['restore-point']||options.out||options.before||options.confirm) fail(USAGE,'DELETION_LEDGER_USAGE');
    // Either a ledger file, or the ledger database — never both.
    if(fromLedgerDb&&options.ledger) fail(USAGE,'DELETION_LEDGER_USAGE');
    if(!fromLedgerDb&&!options.ledger) fail(USAGE,'DELETION_LEDGER_USAGE');
  }else if(command==='init'){
    if(Object.keys(options).length) fail(USAGE,'DELETION_LEDGER_USAGE');
  }else if(command==='purge'){
    if(!options.before||options.out||options.ledger||options['restore-point']||options.from||options.confirm){
      fail(USAGE,'DELETION_LEDGER_USAGE');
    }
  }else if(command==='destroy'){
    if(options.confirm!==DESTROY_DELETION_LEDGER_CONFIRM
      ||options.out||options.ledger||options['restore-point']||options.from||options.before){
      fail(USAGE,'DELETION_LEDGER_USAGE');
    }
  }
  return {command,from:options.from,...options};
}

export function databaseConfig(env){
  const url=String(env.TURSO_DATABASE_URL||'').trim();
  if(!url) fail('TURSO_DATABASE_URL is required','DELETION_LEDGER_CONFIG');
  return {url,authToken:String(env.TURSO_AUTH_TOKEN||'').trim()||undefined};
}

export function ledgerDatabaseConfig(env){
  try{
    const config=deletionLedgerDbConfig(env);
    if(!config) fail('DELETION_LEDGER_DATABASE_URL is required','DELETION_LEDGER_CONFIG');
    return config;
  }catch(error){
    if(error?.code==='DELETION_LEDGER_CONFIG') throw error;
    fail('DELETION_LEDGER_DATABASE_URL is required','DELETION_LEDGER_CONFIG');
  }
}

// `export` from the source and `reapply` both run under the secret that
// hashed invitation emails at deletion time; `export --from ledger-db`
// and `verify` never hash, so they need no secret. Checked before any
// database connection, so a missing secret is a typed config error,
// not a mid-run generic failure.
function requireJwtSecret(env,command,fromLedgerDb){
  if(command==='reapply'||(command==='export'&&!fromLedgerDb)){
    if(!String(env.JWT_SECRET||'').trim()) fail('JWT_SECRET is required','DELETION_LEDGER_CONFIG');
  }
}

const REPOSITORY_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

// Resolves `path` through symlinks, walking up to the nearest existing
// ancestor when `path` itself does not exist yet and re-appending the
// not-yet-existing suffix, so a symlinked parent is resolved too.
function realpathThroughNearestExistingAncestor(path){
  let current=path;
  const suffix=[];
  for(;;){
    try{
      return join(realpathSync(current),...suffix);
    }catch(error){
      if(error?.code!=='ENOENT') throw error;
      const parent=dirname(current);
      if(parent===current) fail('deletion ledger --out parent could not be resolved','DELETION_LEDGER_FILE');
      suffix.unshift(basename(current));
      current=parent;
    }
  }
}

function assertOutOutsideRepository(out){
  const resolved=resolve(out);
  // Compare real paths, not lexical ones: a symlinked parent pointing
  // into the repository must be rejected even though the lexical path
  // looks outside it.
  const realOut=join(
    realpathThroughNearestExistingAncestor(dirname(resolved)),
    basename(resolved),
  );
  const realRoot=realpathSync(REPOSITORY_ROOT);
  if(realOut===realRoot||realOut.startsWith(realRoot+sep)){
    fail('deletion ledger --out must be outside the repository (never commit a ledger, and never write under .git)','DELETION_LEDGER_FILE');
  }
}

// Creates the ledger file exclusively with mode 0600: 'wx' refuses to
// overwrite an existing file and refuses to follow a symlink, and the
// defensive fchmod covers a umask that would otherwise widen the mode.
// A failed write removes the file this call created, so a retry is not
// blocked by a partial ledger.
export function writeLedgerFileExclusive(out,contents,fileSystem={}){
  const open=fileSystem.openSync??openSync;
  const chmod=fileSystem.fchmodSync??fchmodSync;
  const write=fileSystem.writeFileSync??writeFileSync;
  const unlink=fileSystem.unlinkSync??unlinkSync;
  const close=fileSystem.closeSync??closeSync;
  let fd;
  try{
    fd=open(out,'wx',0o600);
  }catch(error){
    if(error?.code==='EEXIST') fail('deletion ledger file already exists; refusing to overwrite','DELETION_LEDGER_FILE');
    fail('deletion ledger file could not be created','DELETION_LEDGER_FILE');
  }
  try{
    chmod(fd,0o600);
    write(fd,contents,'utf8');
  }catch(error){
    try{ unlink(out); }catch{}
    if(error?.code?.startsWith('DELETION_LEDGER_')) throw error;
    fail('deletion ledger file could not be written','DELETION_LEDGER_FILE');
  }finally{
    close(fd);
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

// A malformed --restore-point is a usage error, not a generic failure:
// deletionLedgerEntriesAfter throws a bare TypeError for it, so map
// that (and only that) to DELETION_LEDGER_USAGE. Any other error —
// notably a corrupt ledger entry, which parseDeletionLedger also
// reports as a TypeError — is rethrown, so it surfaces as a
// DELETION_LEDGER_FAILED database failure instead of a bogus usage
// error (same pattern as verifyDeletionLedgerOrUsage below).
export function deletionLedgerEntriesAfterOrUsage(ledger,restorePoint){
  try{
    return deletionLedgerEntriesAfter(ledger,restorePoint);
  }catch(error){
    if(error instanceof TypeError&&/valid restore point/.test(error.message)){
      fail('valid --restore-point is required','DELETION_LEDGER_USAGE');
    }
    throw error;
  }
}

async function verifyDeletionLedgerOrUsage(client,{ledger,restorePoint}){
  try{
    return await verifyDeletionLedger(client,{ledger,restorePoint});
  }catch(error){
    if(error instanceof TypeError&&/valid restore point/.test(error.message)){
      fail('valid --restore-point is required','DELETION_LEDGER_USAGE');
    }
    throw error;
  }
}

// A malformed --before is a usage error, not a generic failure:
// purgeDeletionLedgerEntries throws a bare TypeError for it
// (`valid purge cutoff is required`), so map that (and only that) to
// DELETION_LEDGER_USAGE. Any other error — e.g. purging a ledger
// database whose table was never created (`init` not run), which the
// database reports as a missing-table failure — is rethrown, so it
// surfaces as DELETION_LEDGER_FAILED instead of a bogus usage error.
export async function purgeDeletionLedgerOrUsage(client,{before}){
  try{
    return await purgeDeletionLedgerEntries(client,{before});
  }catch(error){
    if(error instanceof TypeError&&/valid purge cutoff/.test(error.message)){
      fail('valid --before is required','DELETION_LEDGER_USAGE');
    }
    throw error;
  }
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
  const {command,out,ledger:ledgerPath,'restore-point':restorePoint,from,before}=parseArgs(argv);
  const fromLedgerDb=from==='ledger-db';
  const needsAppDb=command==='export'?!fromLedgerDb:(command==='reapply'||command==='verify');
  const needsLedgerDb=fromLedgerDb||['init','purge','destroy'].includes(command);
  const appConfig=needsAppDb?databaseConfig(env):null;
  const ledgerConfig=needsLedgerDb?ledgerDatabaseConfig(env):null;
  requireJwtSecret(env,command,fromLedgerDb);
  if(command==='export') assertOutOutsideRepository(out);
  const appClient=appConfig?createDatabaseClient(appConfig):null;
  const ledgerClient=ledgerConfig?createDatabaseClient(ledgerConfig):null;
  try{
    if(command==='init'){
      await ledgerClient.execute({sql:DELETION_LEDGER_DB_SCHEMA,args:[]});
      const result={command,schema_version:DELETION_LEDGER_DB_SCHEMA_VERSION};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:0};
    }
    if(command==='purge'){
      const purged=await purgeDeletionLedgerOrUsage(ledgerClient,{before});
      const result={command,purged:purged.purged};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:0};
    }
    if(command==='destroy'){
      const destroyed=await destroyDeletionLedger(ledgerClient);
      const result={command,deleted:destroyed.deleted};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:0};
    }
    if(command==='export'){
      const allEntries=fromLedgerDb
        ?await readDeletionLedgerEntries(ledgerClient)
        :await buildDeletionLedger(appClient);
      // Export-time filtering is minimisation only: it shrinks what is
      // written to the file. Reapply/verify re-filter by their own
      // --restore-point, which is the gate that decides what is re-applied.
      let entries=allEntries;
      if(restorePoint){
        entries=deletionLedgerEntriesAfterOrUsage(allEntries,restorePoint);
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
    const ledger=fromLedgerDb
      ?await readDeletionLedgerEntries(ledgerClient)
      :readLedger(ledgerPath);
    if(command==='verify'){
      const verification=await verifyDeletionLedgerOrUsage(appClient,{ledger,restorePoint});
      const result={command,checked:verification.checked,missing:verification.missing.length};
      stdout.write(`${JSON.stringify(result)}\n`);
      return {result,exitCode:verification.ok?0:1};
    }
    const due=deletionLedgerEntriesAfterOrUsage(ledger,restorePoint);
    const outcomes={};
    for(const entry of due){
      const applied=await reapplyAccountDeletion(appClient,{
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
    try{ await appClient?.close?.(); }catch{}
    try{ await ledgerClient?.close?.(); }catch{}
  }
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  main().then(({exitCode})=>{ process.exitCode=exitCode; }).catch(error=>{
    process.stderr.write(`${JSON.stringify(publicCliError(error))}\n`);
    process.exitCode=1;
  });
}
