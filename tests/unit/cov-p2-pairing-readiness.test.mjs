// Fail-closed behaviour of the managed-v6 pairing readiness check: ledger
// tampering, bounded schema inspection, identifier safety, and the execute-only
// client fallback. A real migrated database provides the baseline.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import {
  PAIRING_SCHEMA_V6_FINGERPRINT,
  pairingSchemaV6Fingerprint,
  pairingSchemaV6Ready,
} from '../../api/_pairing-readiness.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

async function withDatabase(run){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-pairing-readiness-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  try{
    await prepareMigrationConnection(db);
    const before=await inspectMigrationState(db);
    await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    await run(db);
  }finally{
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }
}

function sqlOf(statement){ return typeof statement==='string'?statement:String(statement?.sql||''); }

// Execute-only view of the database that lets a test rewrite chosen results.
function executeOnly(db,rewrite=()=>undefined){
  return {
    async execute(statement){
      const result=await db.execute(statement);
      return (await rewrite(sqlOf(statement),result))??result;
    },
  };
}

function ledgerRewrite(mutate){
  return (sql,result)=>sql.includes('FROM schema_migrations ORDER BY version')
    ?{...result,rows:mutate(result.rows.map(row=>({...row})))}:undefined;
}

test('a migrated database is ready and execute-only clients produce the same fingerprint',async()=>{
  await withDatabase(async db=>{
    assert.equal(await pairingSchemaV6Fingerprint(db),PAIRING_SCHEMA_V6_FINGERPRINT);
    assert.equal(await pairingSchemaV6Fingerprint(executeOnly(db)),PAIRING_SCHEMA_V6_FINGERPRINT);
    assert.equal(await pairingSchemaV6Ready(executeOnly(db)),true);
    // An open membership rollout is not acceptable for production publication.
    assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),false);
  });
});

test('readiness rejects missing clients and swallows inspection errors as not ready',async()=>{
  assert.equal(await pairingSchemaV6Ready(null),false);
  assert.equal(await pairingSchemaV6Ready({}),false);
  assert.equal(await pairingSchemaV6Ready({execute:async()=>{ throw new Error('disk'); }}),false);
  assert.equal(await pairingSchemaV6Ready({execute:async()=>({})}),false);
  await assert.rejects(pairingSchemaV6Fingerprint(null),TypeError);
  await assert.rejects(pairingSchemaV6Fingerprint({batch(){}}),TypeError);
});

test('ledger tampering fails closed',async()=>{
  await withDatabase(async db=>{
    const cases={
      'too few rows':rows=>rows.slice(0,3),
      'too many rows':rows=>[...rows,{...rows.at(-1),version:rows.length+1}],
      'renamed migration':rows=>rows.map((row,index)=>index===0?{...row,name:'other'}:row),
      'bad checksum':rows=>rows.map((row,index)=>index===1?{...row,checksum:'0'.repeat(64)}:row),
      'iso timestamp':rows=>rows.map((row,index)=>index===0?{...row,applied_at:'2026-01-01T00:00:00Z'}:row),
      'missing timestamp':rows=>rows.map((row,index)=>index===0?{...row,applied_at:null}:row),
      'negative duration':rows=>rows.map((row,index)=>index===0?{...row,execution_ms:-1}:row),
      'fractional duration':rows=>rows.map((row,index)=>index===0?{...row,execution_ms:1.5}:row),
      'unknown disposition':rows=>rows.map((row,index)=>index===0?{...row,disposition:'skipped'}:row),
      'missing disposition':rows=>rows.map((row,index)=>index===0?{...row,disposition:null}:row),
      'adopted with duration':rows=>rows.map((row,index)=>index===0?{...row,disposition:'adopted',execution_ms:5}:row),
      'adopted after applied':rows=>rows.map((row,index)=>({...row,
        disposition:index===0?'applied':index===1?'adopted':row.disposition,
        execution_ms:index===1?0:row.execution_ms})),
    };
    for(const [name,mutate] of Object.entries(cases)){
      assert.equal(await pairingSchemaV6Ready(executeOnly(db,ledgerRewrite(mutate))),false,name);
    }
    // Adoption that precedes every applied migration is a legitimate history.
    const adoptedPrefix=ledgerRewrite(rows=>rows.map((row,index)=>index===0
      ?{...row,disposition:'adopted',execution_ms:0}:{...row,disposition:'applied'}));
    assert.equal(await pairingSchemaV6Ready(executeOnly(db,adoptedPrefix)),true);
    const emptyLedger=(sql,result)=>sql.includes('FROM schema_migrations ORDER BY version')?{}:result;
    assert.equal(await pairingSchemaV6Ready(executeOnly(db,emptyLedger)),false);
  });
});

test('disabled foreign keys make readiness fail closed',async()=>{
  await withDatabase(async db=>{
    const rewrite=sql=>sql==='PRAGMA foreign_keys'?{rows:[{foreign_keys:0}]}:undefined;
    assert.equal(await pairingSchemaV6Ready(executeOnly(db,rewrite)),false);
  });
});

test('schema inspection is bounded in objects and per-table indexes',async()=>{
  const tooMany={execute:async()=>({rows:Array.from({length:256},(_,index)=>({type:'table',name:`t${index}`}))})};
  await assert.rejects(pairingSchemaV6Fingerprint(tooMany),/schema object limit exceeded/);
  await withDatabase(async db=>{
    const wideIndexes=(sql,result)=>sql.startsWith('PRAGMA index_list("users")')
      ?{rows:Array.from({length:65},(_,index)=>({name:`ix${index}`,origin:'c',unique:1,partial:0}))}:undefined;
    await assert.rejects(pairingSchemaV6Fingerprint(executeOnly(db,wideIndexes)),/schema index limit exceeded/);
    assert.equal(await pairingSchemaV6Ready(executeOnly(db,wideIndexes)),false);
  });
});

test('unsafe index identifiers are refused instead of interpolated into PRAGMA',async()=>{
  await withDatabase(async db=>{
    const injected=(sql,result)=>sql.startsWith('PRAGMA index_list("users")')
      ?{rows:[{name:'x"); DROP TABLE users; --',origin:'c',unique:1,partial:0}]}:undefined;
    await assert.rejects(pairingSchemaV6Fingerprint(executeOnly(db,injected)),/invalid schema identifier/);
    const unnamed=(sql,result)=>sql.startsWith('PRAGMA index_list("users")')
      ?{rows:[{origin:'pk',unique:1,partial:0}]}:undefined;
    await assert.rejects(pairingSchemaV6Fingerprint(executeOnly(db,unnamed)),/invalid schema identifier/);
    const users=await db.execute(`SELECT COUNT(*) AS c FROM sqlite_schema WHERE name='users'`);
    assert.equal(Number(users.rows[0].c),1);
  });
});

test('structural drift changes the fingerprint while non-unique ad hoc indexes are ignored',async()=>{
  await withDatabase(async db=>{
    await db.execute(`CREATE INDEX idx_cov_adhoc_users ON users(id)`);
    assert.equal(await pairingSchemaV6Fingerprint(db),PAIRING_SCHEMA_V6_FINGERPRINT);
    await db.execute(`CREATE UNIQUE INDEX uq_cov_adhoc_users ON users(id)`);
    assert.notEqual(await pairingSchemaV6Fingerprint(db),PAIRING_SCHEMA_V6_FINGERPRINT);
    assert.equal(await pairingSchemaV6Ready(db),false);
  });
});

test('an empty schema has a stable fingerprint without metadata reads',async()=>{
  const calls=[];
  const empty={execute:async statement=>{ calls.push(sqlOf(statement)); return {rows:[{type:'table',name:'sqlite_sequence',sql:null}]}; }};
  const first=await pairingSchemaV6Fingerprint(empty);
  assert.equal(first,await pairingSchemaV6Fingerprint({execute:async()=>({})}));
  assert.equal(calls.length,1);
  assert.notEqual(first,PAIRING_SCHEMA_V6_FINGERPRINT);
});
