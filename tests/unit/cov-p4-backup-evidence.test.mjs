import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  BackupEvidenceError,
  collectDatabaseEvidence,
  compareBackupRestoreEvidence,
  publicBackupEvidenceError,
  publicBackupEvidenceResult,
} from '../../db/backup-evidence.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { stableJson } from '../../db/stable-checksum.js';

const KEY=Buffer.from('evidence-key-alpha-32-bytes-value!','utf8');
const REPO_COMMIT='0123456789abcdef0123456789abcdef01234567';
const OTHER_COMMIT='fedcba9876543210fedcba9876543210fedcba98';
const SOURCE_ID='provider-production-database-001';
const RESTORE_ID='provider-disposable-restore-001';
const BACKUP_REF='provider-backup-opaque-001';
const NOW=Date.parse('2026-09-18T12:00:00.000Z');
const PITR='2026-09-18T10:00:00.000Z';
const HOUR=60*60*1000;
const RANDOM_DIGEST='f'.repeat(64);

const directory=mkdtempSync(join(tmpdir(),'randori-cov-evidence-'));
const sourcePath=join(directory,'source.sqlite');
const restorePath=join(directory,'restore.sqlite');
const clients=[];
function open(path,options={}){
  const db=createClient({url:`file:${path}`,intMode:'bigint',...options});
  clients.push(db);
  return db;
}

let sourceDb;
let restoreDb;
let source;
let restored;

function evidenceOptions(overrides={}){
  return {
    role:'source', identity:SOURCE_ID, hmacKey:KEY, backupRef:BACKUP_REF, repoCommit:REPO_COMMIT,
    pitrAt:PITR, maxSnapshotAgeMs:3*HOUR, maxEvidenceAgeMs:3*HOUR, rpoTargetMs:3*HOUR, rtoTargetMs:15*60*1000,
    clock:()=>Date.parse('2026-09-18T11:45:00.000Z'),
    ...overrides,
  };
}

function restoreOptions(overrides={}){
  return evidenceOptions({
    role:'restore', identity:RESTORE_ID, clock:()=>NOW,
    restoreStartedAt:'2026-09-18T11:50:00.000Z', restoreCompletedAt:'2026-09-18T11:58:00.000Z',
    ...overrides,
  });
}

function comparisonOptions(sourceEvidence,restoredEvidence,overrides={}){
  return {
    sourceEvidence, restoredEvidence, hmacKey:KEY, sourceIdentity:SOURCE_ID, restoreIdentity:RESTORE_ID,
    backupRef:BACKUP_REF, repoCommit:REPO_COMMIT, pitrAt:PITR, maxSnapshotAgeMs:3*HOUR,
    maxEvidenceAgeMs:3*HOUR, rpoTargetMs:3*HOUR, rtoTargetMs:15*60*1000, clock:()=>NOW,
    ...overrides,
  };
}

// Mirrors the module's keyed HMAC so tests can produce *authentic* evidence whose
// contents are internally inconsistent. Without this, every tamper would stop at
// the binding check and the shape validation would never be exercised.
function keyedJsonDigest(label,value){
  const derived=createHmac('sha256',KEY).update(`randori-backup-evidence-key:v1:${label}`,'utf8').digest();
  return createHmac('sha256',derived).update(stableJson(value)).digest('hex');
}

function resign(evidence,mutate){
  const copy=structuredClone(evidence);
  delete copy.bindingDigest;
  mutate(copy);
  return {...copy,bindingDigest:keyedJsonDigest('evidence-binding',copy)};
}

function compareError(sourceEvidence,restoredEvidence,overrides){
  try{
    compareBackupRestoreEvidence(comparisonOptions(sourceEvidence,restoredEvidence,overrides));
  }catch(error){
    assert.ok(error instanceof BackupEvidenceError,`unexpected ${error}`);
    return {code:error.code,reason:error.details?.reason,error};
  }
  assert.fail('comparison unexpectedly succeeded');
}

// Wraps the read transaction so individual statements can be observed or rewritten.
function proxied(db,onExecute,{rollback,close}={}){
  return {
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return new Proxy(transaction,{
        get(target,property){
          if(property==='execute') return statement=>onExecute(statement,target);
          if(property==='rollback'&&rollback) return async()=>{ await target.rollback(); return rollback(); };
          if(property==='close'&&close) return ()=>{ target.close(); return close(); };
          const value=target[property];
          return typeof value==='function'?value.bind(target):value;
        },
      });
    },
  };
}

function sqlOf(statement){ return typeof statement==='string'?statement:statement.sql; }

// Rewrites results of statements matching `pattern`. With `afterPattern`, rewriting
// starts only once that statement has been seen, so the schema inspector's own
// PRAGMA reads (which run first) are left untouched.
function rewriting(db,pattern,rewrite,{afterPattern}={}){
  let armed=!afterPattern;
  return proxied(db,async(statement,target)=>{
    const result=await target.execute(statement);
    const sql=sqlOf(statement);
    if(!armed&&afterPattern.test(sql)) armed=true;
    if(armed&&pattern.test(sql)) return rewrite(result,statement);
    return result;
  });
}

const ROLLOUT_VALUES=/^SELECT "id" AS "__evidence_value_0".* FROM "circle_membership_rollout"/s;
const ROLLOUT_LENGTHS=/__evidence_length_0.* FROM "circle_membership_rollout"/s;

async function rejects(promise,code,pattern){
  let observed;
  await assert.rejects(promise,error=>{ observed=error; return error instanceof BackupEvidenceError&&error.code===code; });
  if(pattern) assert.match(observed.message,pattern);
  return observed;
}

before(async()=>{
  sourceDb=open(sourcePath);
  await prepareMigrationConnection(sourceDb);
  const state=await inspectMigrationState(sourceDb);
  await applyMigrations(sourceDb,{expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await sourceDb.execute({sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',args:['k1',1n,2n]});
  await sourceDb.execute({sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',args:['k2',3n,4n]});
  source=await collectDatabaseEvidence(sourceDb,evidenceOptions());
  copyFileSync(sourcePath,restorePath);
  restoreDb=open(restorePath);
  restored=await collectDatabaseEvidence(restoreDb,restoreOptions());
  assert.equal(compareBackupRestoreEvidence(comparisonOptions(source,restored)).ok,true);
});

after(()=>{
  for(const db of clients){ try{ db.close(); }catch{} }
  rmSync(directory,{recursive:true,force:true});
});

test('the re-signing helper reproduces the module binding exactly', ()=>{
  assert.equal(resign(source,()=>{}).bindingDigest,source.bindingDigest);
  assert.equal(compareBackupRestoreEvidence(comparisonOptions(resign(source,()=>{}),resign(restored,()=>{}))).ok,true);
});

test('authentic but internally inconsistent evidence is rejected with a specific reason', ()=>{
  const cases=[
    ['integrity', e=>{ e.checks.integrity=false; }],
    ['integrity', e=>{ e.checks.foreignKeys='yes'; }],
    ['migration', e=>{ e.migration.selectedVersion=0; }],
    ['migration', e=>{ e.migration.selectedVersion=EXECUTABLE_MIGRATIONS.length+1; }],
    ['schema', e=>{ e.schema.manifestVersion+=1; }],
    ['schema', e=>{ e.schema.schemaDigest='not-a-digest'; }],
    ['sequence', e=>{ e.storage.sequenceRows=-1; }],
    ['sequence', e=>{ e.storage.sequenceDigest=null; }],
    ['migration', e=>{ e.migration.classification='unmanaged'; }],
    ['migration', e=>{ e.migration.applicationLatestVersion-=1; }],
    ['migration', e=>{ e.migration.stateDigest='x'; }],
    ['table_set', e=>{ [e.tables[0],e.tables[1]]=[e.tables[1],e.tables[0]]; }],
    ['table_set', e=>{ e.tables.push({name:'not_a_tolerated_table',count:0,digest:RANDOM_DIGEST}); }],
    ['table_set', e=>{ e.tables[0].count=-1; }],
    ['table_set', e=>{
      e.tables.push({name:'ai_monthly_usage',count:0,digest:RANDOM_DIGEST},{name:'ai_monthly_usage',count:0,digest:RANDOM_DIGEST});
      e.totals.tableCount+=2; e.totals.legacyTableCount+=2;
    }],
    ['row_count', e=>{ e.totals.rowCount+=1; }],
    ['row_count', e=>{ e.totals.valueBytes=-1; }],
    ['policy', e=>{ e.policy.rpoTargetMs=0; }],
    ['binding', e=>{ e.bindings.repoCommit='HEAD'; }],
    ['binding', e=>{ e.bindings.identityDigest='short'; }],
    ['timestamp', e=>{ e.timings.snapshotAgeMs+=1; }],
    ['timestamp', e=>{ e.timings.rpoMet=!e.timings.rpoMet; }],
    ['timestamp', e=>{ e.timings.restoreStartedAt='2026-09-18T11:00:00.000Z'; }],
  ];
  for(const [reason,mutate] of cases){
    const result=compareError(resign(source,mutate),restored);
    assert.equal(result.code,'BACKUP_EVIDENCE_MISMATCH',`${reason}: ${result.error.message}`);
    assert.equal(result.reason,reason,mutate.toString());
  }

  const restoreCases=[
    ['timestamp', e=>{ e.timings.restoreDurationMs+=1; }],
    ['timestamp', e=>{ e.timings.rtoMet=false; }],
    // Restore start before the PITR, with duration and RTO kept consistent so only that check fails.
    ['timestamp', e=>{
      e.timings.restoreStartedAt='2026-09-18T09:00:00.000Z';
      e.timings.restoreDurationMs=Date.parse(e.timings.restoreCompletedAt)-Date.parse('2026-09-18T09:00:00.000Z');
      e.timings.rtoMet=false;
    }],
  ];
  for(const [reason,mutate] of restoreCases){
    const result=compareError(source,resign(restored,mutate));
    assert.equal(result.reason,reason,mutate.toString());
  }
});

test('evidence envelopes that cannot be projected fail authentication rather than crashing', ()=>{
  const projected=resign(source,()=>{});
  const unprojectable={...projected,tables:null};
  const result=compareError(unprojectable,restored);
  assert.equal(result.code,'BACKUP_EVIDENCE_AUTHENTICATION_FAILED');
  assert.equal(result.reason,'binding');

  assert.equal(compareError(restored,restored).code,'BACKUP_EVIDENCE_AUTHENTICATION_FAILED');
  assert.equal(compareError({...source,format:'v0'},restored).reason,'binding');
  assert.equal(compareError(null,restored).reason,'binding');
});

test('an absent-ledger claim must carry the keyed absence sentinel', ()=>{
  const unmanaged=e=>{
    e.migration.classification='unmanaged';
    e.migration.ledgerPresent=false;
    e.migration.currentVersion=0;
    e.migration.ledgerRows=0;
  };
  const forged=resign(source,e=>{ unmanaged(e); e.migration.ledgerDigest=RANDOM_DIGEST; });
  assert.equal(compareError(forged,restored).reason,'ledger');
  const sentinel=keyedJsonDigest('migration-ledger-absence',{present:false,selectedVersion:source.migration.selectedVersion});
  const honest=resign(source,e=>{ unmanaged(e); e.migration.ledgerDigest=sentinel; });
  // The sentinel is accepted; the comparison then fails because the restore is still managed.
  assert.equal(compareError(honest,restored).reason,'migration');
});

test('cross-evidence bindings, ordering and per-section digests must agree', ()=>{
  const both=(mutate)=>[resign(source,mutate),resign(restored,mutate)];
  assert.equal(compareError(...both(e=>{ e.bindings.repoCommit=OTHER_COMMIT; })).reason,'repo_commit');

  const shiftedPitr=resign(source,e=>{ e.pitrAt='2026-09-18T10:30:00.000Z'; e.timings.snapshotAgeMs-=30*60*1000; });
  assert.equal(compareError(shiftedPitr,restored).reason,'pitr');

  const early=resign(restored,e=>{
    e.timings.restoreStartedAt='2026-09-18T11:40:00.000Z';
    e.timings.restoreDurationMs=18*60*1000;
    e.timings.rtoMet=false;
  });
  assert.equal(compareError(source,early).reason,'ordering');

  assert.equal(compareError(source,resign(restored,e=>{ e.schema.schemaDigest=RANDOM_DIGEST; })).reason,'schema');
  assert.equal(compareError(source,resign(restored,e=>{ e.migration.stateDigest=RANDOM_DIGEST; })).reason,'migration');
  assert.equal(compareError(source,resign(restored,e=>{ e.storage.sequenceDigest=RANDOM_DIGEST; })).reason,'sequence');
  const extraLegacy=resign(restored,e=>{
    e.tables.push({name:'ai_monthly_usage',count:0,digest:RANDOM_DIGEST});
    e.totals.tableCount+=1; e.totals.legacyTableCount+=1;
  });
  assert.equal(compareError(source,extraLegacy).reason,'table_set');
});

test('comparison input validation and unexpected failures are sanitized', ()=>{
  assert.equal(compareError(source,restored,{restoreIdentity:SOURCE_ID}).code,'BACKUP_EVIDENCE_IDENTITY_INVALID');
  assert.equal(compareError(source,restored,{pitrAt:'2026-09-18T10:00:00Z'}).code,'BACKUP_EVIDENCE_INVALID');
  assert.equal(compareError(source,restored,{pitrAt:Date.parse(PITR)}).code,'BACKUP_EVIDENCE_INVALID');
  assert.equal(compareError(source,restored,{clock:()=>{ throw new Error('clock offline'); }}).code,'BACKUP_EVIDENCE_FAILED');
  assert.equal(compareError(source,restored,{clock:()=>new Date(-1)}).code,'BACKUP_EVIDENCE_INVALID');
  assert.equal(compareBackupRestoreEvidence(comparisonOptions(source,restored,{clock:()=>new Date(NOW)})).ok,true);

  // Without an injected clock the real time is used, so year-old evidence is stale.
  assert.equal(compareError(source,restored,{clock:undefined}).reason,'evidence_age');

  const options=comparisonOptions(source,restored);
  Object.defineProperty(options,'sourceIdentity',{get(){ throw new RangeError('getter exploded'); }});
  let wrapped;
  assert.throws(()=>compareBackupRestoreEvidence(options),error=>{ wrapped=error; return true; });
  assert.equal(wrapped.code,'BACKUP_EVIDENCE_FAILED');
  assert.equal(wrapped.message,'Backup evidence comparison failed');
  assert.equal(wrapped.cause.message,'getter exploded');
  assert.deepEqual(publicBackupEvidenceError(wrapped),{ok:false,error:'BACKUP_EVIDENCE_FAILED',message:'Backup evidence verification failed.'});
});

test('public helpers reject unknown results and expose only allow-listed reasons and tables', ()=>{
  for(const value of [null,{kind:'database-evidence'},{kind:'restore-verification',comparisonDigest:1},{kind:'other'}]){
    assert.throws(()=>publicBackupEvidenceResult(value),error=>error.code==='BACKUP_EVIDENCE_INVALID');
  }
  const known=new BackupEvidenceError('BACKUP_EVIDENCE_RESOURCE_LIMIT','x',{details:{reason:'resource_limit',table:'auth_accounts'}});
  assert.deepEqual(publicBackupEvidenceError(known),{
    ok:false,error:'BACKUP_EVIDENCE_RESOURCE_LIMIT',message:'Database evidence exceeded a configured resource limit.',
    reason:'resource_limit',table:'auth_accounts',
  });
  const unknown=new BackupEvidenceError('SOMETHING_ELSE','x',{details:{reason:'stack trace',table:'secret_table'}});
  assert.deepEqual(publicBackupEvidenceError(unknown),{ok:false,error:'BACKUP_EVIDENCE_FAILED',message:'Backup evidence verification failed.'});
  assert.equal(new BackupEvidenceError('X','y',{cause:new Error('inner')}).cause.message,'inner');
});

test('collection validates its client, key, role, ledger expectation, limits and clock before reading', async ()=>{
  await rejects(collectDatabaseEvidence(null,evidenceOptions()),'BACKUP_EVIDENCE_INVALID',/transactional database client/);
  await rejects(collectDatabaseEvidence({},evidenceOptions()),'BACKUP_EVIDENCE_INVALID');
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({hmacKey:42})),'BACKUP_EVIDENCE_INVALID',/HMAC key is invalid/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({hmacKey:new Uint8Array(8)})),'BACKUP_EVIDENCE_INVALID',/length/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({role:'replica'})),'BACKUP_EVIDENCE_INVALID',/role/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({identity:' padded'})),'BACKUP_EVIDENCE_INVALID',/identity/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({backupRef:'ref\u0007'})),'BACKUP_EVIDENCE_INVALID',/backup reference/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({repoCommit:'main'})),'BACKUP_EVIDENCE_INVALID',/commit/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({migrations:[]})),'BACKUP_EVIDENCE_INVALID',/Migration selection/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({expectedLedger:'absent'})),'BACKUP_EVIDENCE_INVALID',/ledger state/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({expectedLedger:'maybe'})),'BACKUP_EVIDENCE_INVALID',/ledger state/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({limits:[]})),'BACKUP_EVIDENCE_INVALID',/resource limits/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({limits:{pageSize:0}})),'BACKUP_EVIDENCE_INVALID',/pageSize/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({clock:()=>{ throw new Error('ntp'); }})),'BACKUP_EVIDENCE_FAILED',/clock failed/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({clock:()=>'soon'})),'BACKUP_EVIDENCE_INVALID',/clock/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({pitrAt:Date.parse(PITR)})),'BACKUP_EVIDENCE_INVALID',/PITR/);
  await rejects(collectDatabaseEvidence(sourceDb,evidenceOptions({pitrAt:'2026-09-18T12:00:00.000Z'})),'BACKUP_EVIDENCE_STALE_SNAPSHOT');
  await rejects(
    collectDatabaseEvidence(sourceDb,evidenceOptions({restoreCompletedAt:'2026-09-18T11:00:00.000Z'})),
    'BACKUP_EVIDENCE_INVALID',/Source evidence cannot include restore timing/,
  );
  await rejects(
    collectDatabaseEvidence(restoreDb,restoreOptions({restoreCompletedAt:'2026-09-18T11:49:00.000Z'})),
    'BACKUP_EVIDENCE_INVALID',/Restore timing/,
  );
  await rejects(
    collectDatabaseEvidence(restoreDb,restoreOptions({restoreCompletedAt:'2026-09-18T12:30:00.000Z'})),
    'BACKUP_EVIDENCE_INVALID',/Restore timing/,
  );
});

test('a Date clock and a non-bigint client produce the same canonical digests', async ()=>{
  const numeric=open(sourcePath,{intMode:'number'});
  const evidence=await collectDatabaseEvidence(numeric,evidenceOptions({clock:()=>new Date('2026-09-18T11:45:00.000Z')}));
  assert.deepEqual(evidence.tables,source.tables);
  assert.equal(evidence.bindingDigest,source.bindingDigest);
});

test('the default clock is the real time', async ()=>{
  const pitrAt=new Date(Math.floor(Date.now()/1000)*1000-60_000).toISOString();
  const evidence=await collectDatabaseEvidence(sourceDb,evidenceOptions({clock:undefined,pitrAt}));
  assert.ok(evidence.timings.snapshotAgeMs>=60_000);
});

test('integrity, foreign-key and transaction-close failures are handled fail closed', async ()=>{
  await rejects(
    collectDatabaseEvidence(rewriting(sourceDb,/integrity_check/,()=>({})),evidenceOptions()),
    'BACKUP_EVIDENCE_INTEGRITY_FAILED',
  );
  await rejects(
    collectDatabaseEvidence(rewriting(sourceDb,/integrity_check/,()=>({rows:[null]})),evidenceOptions()),
    'BACKUP_EVIDENCE_INTEGRITY_FAILED',
  );
  // A driver that omits rows for the FK probe means "no violations".
  const noRows=await collectDatabaseEvidence(rewriting(sourceDb,/pragma_foreign_key_check/,()=>({})),evidenceOptions());
  assert.equal(noRows.bindingDigest,source.bindingDigest);

  let rollbacks=0;
  let closes=0;
  const flaky=proxied(sourceDb,(statement,target)=>target.execute(statement),{
    rollback(){ rollbacks+=1; throw new Error('rollback failed'); },
    close(){ closes+=1; throw new Error('close failed'); },
  });
  const evidence=await collectDatabaseEvidence(flaky,evidenceOptions());
  assert.equal(evidence.bindingDigest,source.bindingDigest);
  assert.equal(rollbacks,1);
  assert.equal(closes,1);

  const broken={async transaction(){ throw new Error('database is locked'); }};
  const failure=await rejects(collectDatabaseEvidence(broken,evidenceOptions()),'BACKUP_EVIDENCE_FAILED',/collection failed/);
  assert.equal(failure.cause.message,'database is locked');
});

test('column metadata from PRAGMA table_xinfo is validated', async ()=>{
  const xinfo=/PRAGMA table_xinfo\("circle_membership_rollout"\)/;
  const afterPattern=/__evidence_count/;
  const rewriteFirst=mutate=>rewriting(sourceDb,xinfo,result=>({rows:result.rows.map((row,index)=>index===0?mutate({...row}):row)}),{afterPattern});
  await rejects(collectDatabaseEvidence(rewriteFirst(row=>({...row,notnull:2})),evidenceOptions()),'BACKUP_EVIDENCE_MIGRATION_INVALID',/column metadata/);
  await rejects(collectDatabaseEvidence(rewriteFirst(row=>({...row,hidden:4})),evidenceOptions()),'BACKUP_EVIDENCE_MIGRATION_INVALID',/column metadata/);
  await rejects(collectDatabaseEvidence(rewriteFirst(row=>({...row,name:null})),evidenceOptions()),'BACKUP_EVIDENCE_MIGRATION_INVALID',/identifier/);
  await rejects(collectDatabaseEvidence(rewriteFirst(row=>({...row,cid:5n})),evidenceOptions()),'BACKUP_EVIDENCE_MIGRATION_INVALID',/table metadata/);
  await rejects(collectDatabaseEvidence(rewriteFirst(row=>({...row,cid:-1n})),evidenceOptions()),'BACKUP_EVIDENCE_RESOURCE_LIMIT',/count is outside/);
  await rejects(collectDatabaseEvidence(rewriting(sourceDb,xinfo,()=>({}),{afterPattern}),evidenceOptions()),'BACKUP_EVIDENCE_MIGRATION_INVALID',/table metadata/);

  // Missing optional metadata is canonicalised, so the digest changes but collection succeeds.
  const relaxed=await collectDatabaseEvidence(rewriteFirst(row=>{ delete row.hidden; row.type=null; return row; }),evidenceOptions());
  assert.notEqual(relaxed.schema.schemaDigest,source.schema.schemaDigest);
});

test('preflight length pages must be well formed and stable', async ()=>{
  const lengths=mutate=>rewriting(sourceDb,ROLLOUT_LENGTHS,result=>mutate(result));
  await rejects(collectDatabaseEvidence(lengths(()=>({})),evidenceOptions()),'BACKUP_EVIDENCE_FAILED',/changed during evidence preflight/);
  await rejects(
    collectDatabaseEvidence(lengths(result=>({rows:[{...result.rows[0],__evidence_length_0:-1n}]})),evidenceOptions()),
    'BACKUP_EVIDENCE_FAILED',/length metadata/,
  );
  await rejects(
    collectDatabaseEvidence(lengths(result=>({rows:[{...result.rows[0],__evidence_length_0:1.5}]})),evidenceOptions()),
    'BACKUP_EVIDENCE_FAILED',/length metadata/,
  );
  // All-zero lengths are accepted by preflight but contradicted by the fetched values.
  await rejects(
    collectDatabaseEvidence(lengths(result=>({rows:result.rows.map(row=>Object.fromEntries(Object.keys(row).map(key=>[key,0n])))})),evidenceOptions()),
    'BACKUP_EVIDENCE_RESOURCE_LIMIT',/page limit/,
  );
  // A two-row table whose preflight reports a third row has changed underneath us.
  const rateLengths=/__evidence_length_0.* FROM "auth_rate_limits"/s;
  await rejects(
    collectDatabaseEvidence(rewriting(sourceDb,rateLengths,result=>({rows:[...result.rows,result.rows[0]]})),evidenceOptions()),
    'BACKUP_EVIDENCE_FAILED',/changed during evidence preflight/,
  );
});

test('page and total byte limits are enforced during preflight', async ()=>{
  // The rollout row holds several short cells; a small page budget trips on the row total.
  const page=await rejects(
    collectDatabaseEvidence(sourceDb,evidenceOptions({limits:{maxCellBytes:64,maxPageValueBytes:20}})),
    'BACKUP_EVIDENCE_RESOURCE_LIMIT',/page limit/,
  );
  assert.equal(page.details.reason,'resource_limit');
  // Rows that each fit the page budget, but whose running total across tables does not.
  const total=await rejects(
    collectDatabaseEvidence(sourceDb,evidenceOptions({limits:{maxCellBytes:64,maxPageValueBytes:64,maxTotalValueBytes:24}})),
    'BACKUP_EVIDENCE_RESOURCE_LIMIT',
  );
  assert.match(total.message,/total value limit/);
});

test('fetched values must match their storage class and preflight sizes', async ()=>{
  const values=mutate=>rewriting(sourceDb,ROLLOUT_VALUES,result=>mutate(result.rows[0]));
  const cell=(value,type)=>values(row=>({rows:[{...row,__evidence_value_0:value,__evidence_type_0:type}]}));

  // Equivalent integer encodings from different drivers produce the same digest.
  for(const value of [1,'1']){
    const evidence=await collectDatabaseEvidence(cell(value,'integer'),evidenceOptions());
    assert.equal(evidence.bindingDigest,source.bindingDigest,String(value));
  }
  // A blob of the preflight length is accepted from both ArrayBuffer and typed-array views.
  const asBuffer=await collectDatabaseEvidence(cell(new Uint8Array([0x31]).buffer,'blob'),evidenceOptions());
  const asView=await collectDatabaseEvidence(cell(new Uint8Array([9,0x31,9]).subarray(1,2),'blob'),evidenceOptions());
  assert.notEqual(asBuffer.bindingDigest,source.bindingDigest);
  assert.equal(asBuffer.tables.find(t=>t.name==='circle_membership_rollout').digest,asView.tables.find(t=>t.name==='circle_membership_rollout').digest);

  for(const [value,type,pattern] of [
    [1n,'null',/invalid null/],
    [1.5,'integer',/unsafe integer/],
    ['01','integer',/unsafe integer/],
    ['1','real',/invalid real/],
    [1n,'text',/invalid text/],
    ['1','blob',/invalid blob/],
    [1n,'json',/unknown storage class/],
    [1n,7,/invalid row metadata/],
  ]){
    await rejects(collectDatabaseEvidence(cell(value,type),evidenceOptions()),'BACKUP_EVIDENCE_FAILED',pattern);
  }

  await rejects(collectDatabaseEvidence(values(()=>({})),evidenceOptions()),'BACKUP_EVIDENCE_FAILED',/changed during evidence collection/);
  await rejects(
    collectDatabaseEvidence(cell(123456789n,'integer'),evidenceOptions()),
    'BACKUP_EVIDENCE_RESOURCE_LIMIT',/page limit/,
  );
  await rejects(
    collectDatabaseEvidence(cell('x'.repeat(65),'text'),evidenceOptions({limits:{maxCellBytes:64}})),
    'BACKUP_EVIDENCE_RESOURCE_LIMIT',/value limit/,
  );
  // An extra all-NULL row beyond COUNT(*) adds no bytes, so only the row count can catch it.
  const nullRow=row=>Object.fromEntries(Object.keys(row).map(key=>[key,key.startsWith('__evidence_type_')?'null':null]));
  await rejects(
    collectDatabaseEvidence(rewriting(sourceDb,/__evidence_value_0.* FROM "auth_rate_limits"/s,result=>({rows:[...result.rows,nullRow(result.rows[0])]})),evidenceOptions()),
    'BACKUP_EVIDENCE_FAILED',/changed during evidence collection/,
  );
});

test('legacy table discovery tolerates a driver that omits rows', async ()=>{
  const evidence=await collectDatabaseEvidence(rewriting(sourceDb,/FROM sqlite_schema WHERE type='table' AND name IN/,()=>({})),evidenceOptions());
  assert.equal(evidence.totals.legacyTableCount,0);
});
