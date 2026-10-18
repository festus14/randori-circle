import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { LibsqlError, createClient } from '@libsql/client';

import { inspectDatabaseReadiness } from '../../api/_health.js';
import { pairingSchemaV6Ready } from '../../api/_pairing-readiness.js';
import {
  enforceCheckConstraints,
  isTursoDisallowedCheckConstraintPragma,
  readCheckConstraintsEnforced,
} from '../../db/check-constraint-state.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import { inspectSchema } from '../../db/schema-inspector.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){
    try{ await cleanup.pop()(); }catch{}
  }
});

// Mirrors @libsql/client's mapping of a Hrana ResponseError from Turso.
function tursoDisallowedError(statement='PRAGMA ignore_check_constraints'){
  const cause=Object.assign(new Error(`SQL not allowed statement: ${statement}`),{code:'SQL_PARSE_ERROR'});
  return new LibsqlError(`SQL not allowed statement: ${statement}`,'SQL_PARSE_ERROR',undefined,cause);
}

function isCheckPragma(statement){
  const sql=typeof statement==='string'?statement:statement?.sql;
  return /^PRAGMA\s+ignore_check_constraints\b/i.test(String(sql||'').trim());
}

/** Delegates to a real database but answers the CHECK pragma like Turso, or with an override. */
function remoteLike(db,respond=statement=>{ throw tursoDisallowedError(String(statement)); }){
  const wrapTransaction=transaction=>new Proxy(transaction,{
    get(target,property){
      if(property==='execute') return statement=>isCheckPragma(statement)
        ?Promise.resolve().then(()=>respond(typeof statement==='string'?statement:statement.sql))
        :target.execute(statement);
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  return new Proxy(db,{
    get(target,property){
      if(property==='execute') return statement=>isCheckPragma(statement)
        ?Promise.resolve().then(()=>respond(typeof statement==='string'?statement:statement.sql))
        :target.execute(statement);
      if(property==='transaction') return async(...args)=>wrapTransaction(await target.transaction(...args));
      const value=Reflect.get(target,property,target);
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

async function migratedDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-check-state-'));
  const db=createClient({url:`file:${join(directory,'state.sqlite')}`});
  cleanup.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{
    expectedStateFingerprint:initial.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY,
  });
  return db;
}

test('only the exact Turso disallowed-pragma rejection is recognized',()=>{
  assert.equal(isTursoDisallowedCheckConstraintPragma(tursoDisallowedError()),true);
  assert.equal(isTursoDisallowedCheckConstraintPragma(
    tursoDisallowedError('PRAGMA ignore_check_constraints=OFF')),true);
  assert.equal(isTursoDisallowedCheckConstraintPragma(
    Object.assign(new Error('SQL not allowed statement: PRAGMA ignore_check_constraints'),{code:'SQL_PARSE_ERROR'})),true);
  for(const error of [
    new LibsqlError('SQL not allowed statement: PRAGMA ignore_check_constraints','SQLITE_ERROR'),
    new Error('SQL not allowed statement: PRAGMA ignore_check_constraints'),
    new LibsqlError('SQL not allowed statement: PRAGMA foreign_keys','SQL_PARSE_ERROR'),
    new LibsqlError('SQL not allowed statement: PRAGMA ignore_check_constraints; DROP TABLE x','SQL_PARSE_ERROR'),
    new LibsqlError('near "PRAGMA": syntax error','SQL_PARSE_ERROR'),
    new LibsqlError('fetch failed','HRANA_WEBSOCKET_ERROR'),
    null,undefined,'SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA ignore_check_constraints',
  ]){
    assert.equal(isTursoDisallowedCheckConstraintPragma(error),false,String(error?.message??error));
  }
});

test('CHECK enforcement reader treats 0 and the Turso rejection as enforced, everything else fails closed',async()=>{
  const reader=respond=>readCheckConstraintsEnforced({execute:async()=>respond()});
  assert.equal(await reader(()=>({rows:[{ignore_check_constraints:0}]})),true);
  assert.equal(await reader(()=>({rows:[{ignore_check_constraints:0n}]})),true);
  assert.equal(await reader(()=>{ throw tursoDisallowedError(); }),true);
  assert.equal(await reader(()=>({rows:[{ignore_check_constraints:1}]})),false);
  assert.equal(await reader(()=>({rows:[{ignore_check_constraints:null}]})),false);
  assert.equal(await reader(()=>({rows:[]})),false);
  assert.equal(await reader(()=>({rows:[{ignore_check_constraints:0},{ignore_check_constraints:0}]})),false);
  await assert.rejects(reader(()=>{ throw new LibsqlError('connection reset','HRANA_WEBSOCKET_ERROR'); }),/connection reset/);
  await assert.rejects(reader(()=>{ throw new LibsqlError('SQL not allowed statement: PRAGMA foreign_keys','SQL_PARSE_ERROR'); }),
    /foreign_keys/);

  const local=createClient({url:'file::memory:'});
  cleanup.push(()=>local.close());
  assert.equal(await readCheckConstraintsEnforced(local),true);
  await local.execute('PRAGMA ignore_check_constraints=ON');
  assert.equal(await readCheckConstraintsEnforced(local),false);
  await enforceCheckConstraints(local);
  assert.equal(await readCheckConstraintsEnforced(local),true);
});

test('enforcing CHECK constraints tolerates only the Turso rejection',async()=>{
  const statements=[];
  await enforceCheckConstraints({execute:async sql=>{ statements.push(sql); throw tursoDisallowedError(sql); }});
  assert.deepEqual(statements,['PRAGMA ignore_check_constraints=OFF']);
  await assert.rejects(enforceCheckConstraints({execute:async()=>{ throw new LibsqlError('boom','SERVER_ERROR'); }}),/boom/);
  const calls=[];
  await prepareMigrationConnection({execute:async sql=>{
    calls.push(sql);
    if(isCheckPragma(sql)) throw tursoDisallowedError(sql);
    return {rows:[]};
  }});
  assert.deepEqual(calls,['PRAGMA foreign_keys=ON','PRAGMA ignore_check_constraints=OFF']);
  await assert.rejects(prepareMigrationConnection({execute:async sql=>{
    if(isCheckPragma(sql)) throw new LibsqlError('unavailable','SERVER_ERROR');
    return {rows:[]};
  }}),/unavailable/);
});

test('remote-style schema inspection, health readiness, pairing readiness and migration pass with the Turso rejection',async()=>{
  const db=await migratedDatabase();
  const remote=remoteLike(db);
  const status=await inspectSchema(remote,{manifest:SCHEMA_MANIFEST});
  assert.equal(status.checkConstraintsEnabled,true);
  assert.equal(status.ready,true);
  assert.equal(await inspectDatabaseReadiness(remote),true);
  assert.equal(await pairingSchemaV6Ready(remote),true);
  const state=await inspectMigrationState(remote);
  assert.equal(state.ready,true);
  const result=await applyMigrations(remote,{
    expectedStateFingerprint:state.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY,
  });
  assert.deepEqual(result.applied,[]);
});

test('remote-style readers fail closed for other pragma errors and for a non-zero value',async()=>{
  const db=await migratedDatabase();
  for(const respond of [
    ()=>({rows:[{ignore_check_constraints:1}]}),
    ()=>({rows:[]}),
  ]){
    const remote=remoteLike(db,respond);
    const status=await inspectSchema(remote,{manifest:SCHEMA_MANIFEST});
    assert.equal(status.checkConstraintsEnabled,false);
    assert.ok(status.blockers.some(item=>item.code==='check_constraints_disabled'));
    assert.equal(await inspectDatabaseReadiness(remote),false);
    assert.equal(await pairingSchemaV6Ready(remote),false);
  }
  for(const error of [
    new LibsqlError('SQL not allowed statement: PRAGMA something_else','SQL_PARSE_ERROR'),
    new LibsqlError('SQL not allowed statement: PRAGMA ignore_check_constraints','SERVER_ERROR'),
    new LibsqlError('fetch failed','HRANA_WEBSOCKET_ERROR'),
  ]){
    const remote=remoteLike(db,()=>{ throw error; });
    await assert.rejects(inspectSchema(remote,{manifest:SCHEMA_MANIFEST}),error);
    await assert.rejects(inspectDatabaseReadiness(remote),error);
    assert.equal(await pairingSchemaV6Ready(remote),false);
    await assert.rejects(prepareMigrationConnection(remote),error);
  }
});
