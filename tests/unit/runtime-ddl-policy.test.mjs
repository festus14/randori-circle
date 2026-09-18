import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuntimeDdl, normalizeDdl, RUNTIME_DDL_ALLOWLIST } from '../../scripts/check-runtime-ddl.mjs';

test('runtime DDL debt matches its deterministic reviewed allowlist',()=>{
  const result=checkRuntimeDdl('api');
  assert.equal(result.ok,true);
  assert.equal(result.snapshots.length,RUNTIME_DDL_ALLOWLIST.length);
  assert.ok(result.entries.length>80);
});

test('runtime DDL policy detects new and assembled schema writes',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-'));
  const api=join(root,'api');
  mkdirSync(api);
  writeFileSync(join(api,'new.js'),`export const sql = 'CREATE TABLE surprise (id INTEGER)';\n`);
  let result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.equal(result.unexpected.length,1);
  writeFileSync(join(api,'new.js'),`export const sql = 'CREATE ' + 'TABLE surprise (id INTEGER)';\n`);
  result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.ok(result.assemblyViolations.some(item=>item.code==='assembled_ddl'));
  assert.ok(result.assemblyViolations.some(item=>item.code==='dynamic_ddl'));
  writeFileSync(join(api,'new.js'),"export const sql = `CREATE ${kind} surprise`;\n");
  result=checkRuntimeDdl(api,[]);
  assert.ok(result.assemblyViolations.some(item=>item.code==='dynamic_ddl'));
  for(const sql of [
    'CREATE TEMP TABLE surprise (id INTEGER)',
    'CREATE VIRTUAL TABLE surprise USING fts5(body)',
  ]){
    writeFileSync(join(api,'new.js'),`export const sql = ${JSON.stringify(sql)};\n`);
    result=checkRuntimeDdl(api,[]);
    assert.equal(result.unexpected.length,1);
  }
  writeFileSync(join(api,'new.js'),"export const sql = `${verb} ${kind} surprise(id)`;\n");
  result=checkRuntimeDdl(api,[]);
  assert.ok(result.assemblyViolations.some(item=>item.code==='dynamic_ddl'));
  writeFileSync(join(api,'new.js'),`export const sql = ['CREATE','TABLE','surprise(id)'].join(' ');\n`);
  result=checkRuntimeDdl(api,[]);
  assert.ok(result.assemblyViolations.some(item=>item.code==='dynamic_ddl'));
  writeFileSync(join(root,'helper.js'),`export const sql = 'CREATE TABLE imported_surprise (id INTEGER)';\n`);
  writeFileSync(join(api,'new.js'),`export { sql } from '../helper.js';\n`);
  result=checkRuntimeDdl(api,[]);
  assert.equal(result.unexpected.length,1);
  assert.ok(result.unexpected[0].file.endsWith('/helper.js'));
});

test('DDL normalization ignores formatting but preserves semantic text',()=>{
  assert.equal(normalizeDdl(' CREATE  INDEX x ON t ( a, b DESC ) '),'create index x on t(a,b desc)');
  assert.notEqual(normalizeDdl('CREATE INDEX x ON t(a)'),normalizeDdl('CREATE UNIQUE INDEX x ON t(a)'));
  assert.notEqual(normalizeDdl("CREATE TABLE x (mode TEXT DEFAULT 'Medium')"),normalizeDdl("CREATE TABLE x (mode TEXT DEFAULT 'medium')"));
});
