// The cached schema-capability check that gates code using an additive
// migration's new tables (ID-87, #371). Real-database behaviour across the
// N-1 -> N cutover is in migration-additive-release.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  SCHEMA_CAPABILITY_AVAILABLE_TTL_MS,
  SCHEMA_CAPABILITY_PENDING_TTL_MS,
  schemaCapabilityAvailable,
  schemaFeatureAvailable,
} from '../../api/_schema-capability.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

const LATEST=MIGRATION_CONTRACTS.at(-1);

// A ledger with the given rows that counts and records every statement.
function fakeLedger(rows=()=>[]){
  const statements=[];
  return {
    statements,
    execute:async statement=>{
      statements.push(statement);
      return {rows:typeof rows==='function'?rows(statement):rows};
    },
  };
}

const ledgerRow=(contract,extra={})=>({version:contract.version,name:contract.name,checksum:contract.checksum,...extra});

test('the capability needs the exact ledger row for the version, read-only',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-schema-capability-'));
  const path=join(directory,'database.sqlite');
  await copyMigratedDatabase(path);
  const db=createClient({url:`file:${path}`});
  try{
    assert.equal(await schemaCapabilityAvailable(db,{version:LATEST.version,env:{}}),true);
    assert.equal(await schemaCapabilityAvailable(db,{version:1,env:{}}),true);
  }finally{
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }

  const db2=fakeLedger([ledgerRow(LATEST)]);
  assert.equal(await schemaCapabilityAvailable(db2,{version:LATEST.version,env:{}}),true);
  assert.deepEqual(db2.statements,[{
    sql:'SELECT version,name,checksum FROM schema_migrations WHERE version=? LIMIT 2',
    args:[LATEST.version],
  }]);
  for(const rows of [
    [],
    [ledgerRow(LATEST,{checksum:'f'.repeat(64)})],
    [ledgerRow(LATEST,{name:'renamed'})],
    [ledgerRow(LATEST,{version:LATEST.version+1})],
    [ledgerRow(LATEST),ledgerRow(LATEST)],
  ]){
    assert.equal(await schemaCapabilityAvailable(fakeLedger(rows),{version:LATEST.version,env:{}}),false,JSON.stringify(rows));
  }
  assert.equal(await schemaCapabilityAvailable({execute:async()=>({})},{version:LATEST.version,env:{}}),false);
});

test('answers are cached per database: briefly while pending, longer once available',async()=>{
  let now=1_000_000;
  let present=false;
  const db=fakeLedger(()=>present?[ledgerRow(LATEST)]:[]);
  const options={version:LATEST.version,env:{},now:()=>now};
  assert.equal(await schemaCapabilityAvailable(db,options),false);
  present=true;
  now+=SCHEMA_CAPABILITY_PENDING_TTL_MS-1;
  assert.equal(await schemaCapabilityAvailable(db,options),false,'still within the pending TTL');
  assert.equal(db.statements.length,1);
  now+=2;
  assert.equal(await schemaCapabilityAvailable(db,options),true);
  assert.equal(db.statements.length,2);
  present=false;
  now+=SCHEMA_CAPABILITY_AVAILABLE_TTL_MS-1;
  assert.equal(await schemaCapabilityAvailable(db,options),true,'still within the available TTL');
  now+=2;
  assert.equal(await schemaCapabilityAvailable(db,options),false,'a restored older database is noticed after the TTL');
  assert.equal(db.statements.length,3);

  // The cache is shared by every client of one configured database URL.
  const env={TURSO_DATABASE_URL:`libsql://capability-${Date.now()}.example.test`};
  const first=fakeLedger([ledgerRow(LATEST)]);
  const second=fakeLedger([]);
  assert.equal(await schemaCapabilityAvailable(first,{version:LATEST.version,env}),true);
  assert.equal(await schemaCapabilityAvailable(second,{version:LATEST.version,env}),true);
  assert.equal(second.statements.length,0);
});

test('concurrent checks share one probe, and failures are not cached',async()=>{
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  let calls=0;
  const db={execute:async()=>{ calls+=1; await gate; return {rows:[ledgerRow(LATEST)]}; }};
  const options={version:LATEST.version,env:{}};
  const pending=[schemaCapabilityAvailable(db,options),schemaCapabilityAvailable(db,options)];
  release();
  assert.deepEqual(await Promise.all(pending),[true,true]);
  assert.equal(calls,1);

  let failures=0;
  const flaky={execute:async()=>{
    failures+=1;
    if(failures===1) throw new Error('libsql://private.example/token=secret');
    return {rows:[ledgerRow(LATEST)]};
  }};
  assert.equal(await schemaCapabilityAvailable(flaky,options),false,'a failure reads as unavailable');
  assert.equal(await schemaCapabilityAvailable(flaky,options),true,'and is retried on the next call');
  const throwing={execute:()=>{ throw new Error('synchronous client failure'); }};
  assert.equal(await schemaCapabilityAvailable(throwing,options),false);
});

test('the version must be a known migration, and the flag is checked before the database',async()=>{
  const db=fakeLedger([]);
  for(const version of [0,-1,1.5,'21',MIGRATION_CONTRACTS.length+1,undefined]){
    await assert.rejects(schemaCapabilityAvailable(db,{version,env:{}}),/known migration version/);
  }
  await assert.rejects(schemaCapabilityAvailable(db,{version:2,env:{},contracts:[{version:1}]}),/known migration version/);
  await assert.rejects(schemaCapabilityAvailable(db,{version:1,env:{},contracts:'nope'}),/known migration version/);
  await assert.rejects(schemaCapabilityAvailable(db,{version:2,env:{},contracts:[{version:1},{version:3}]}),
    /known migration version/);
  await assert.rejects(schemaCapabilityAvailable(null,{version:1}),/database client is required/);
  for(const enabled of [false,undefined,'true',1]){
    assert.equal(await schemaFeatureAvailable(db,{enabled,version:LATEST.version,env:{}}),false);
  }
  assert.equal(await schemaFeatureAvailable(db),false);
  assert.equal(db.statements.length,0,'a disabled feature never reads the ledger');
  assert.equal(await schemaFeatureAvailable(fakeLedger([ledgerRow(LATEST)]),{enabled:true,version:LATEST.version,env:{}}),true);
});
