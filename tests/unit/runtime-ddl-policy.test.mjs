import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuntimeDdl, normalizeDdl, RUNTIME_DDL_ALLOWLIST, stringLiterals } from '../../scripts/check-runtime-ddl.mjs';

test('runtime DDL debt matches its deterministic reviewed allowlist',()=>{
  const result=checkRuntimeDdl('api');
  assert.equal(result.ok,true);
  assert.equal(result.snapshots.length,RUNTIME_DDL_ALLOWLIST.length);
  assert.equal(result.snapshots.reduce((total,item)=>total+item.statementCount,0),24);
  assert.equal(result.snapshots.some(item=>item.file==='api/auth.js'),false);
  assert.equal(result.snapshots.some(item=>item.file==='api/data.js'),false);
  assert.equal(result.snapshots.some(item=>item.file==='api/_circle-membership.js'),false);
});

test('notification-preference requests and readiness contain no runtime DDL',()=>{
  const opsSource=readFileSync(new URL('../../api/ops.js',import.meta.url),'utf8');
  const readinessSource=readFileSync(new URL('../../api/_ops-readiness.js',import.meta.url),'utf8');
  const preferenceTableDdl=stringLiterals(opsSource).filter(({value})=>
    /\b(?:CREATE|ALTER|DROP)\b[\s\S]*\buser_notification_prefs\b/iu.test(value)
  );
  const readinessDdl=stringLiterals(readinessSource).filter(({value})=>
    /\b(?:CREATE\s+(?:(?:UNIQUE|TEMP(?:ORARY)?|VIRTUAL|OR\s+REPLACE)\s+)*(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/iu.test(value)
  );
  assert.deepEqual(preferenceTableDdl,[],'notification preferences must not regain schema mutation');
  assert.deepEqual(readinessDdl,[],'ops readiness must remain read-only');
});

test('data routes, including admin init, contain no runtime DDL',()=>{
  const source=readFileSync(new URL('../../api/data.js',import.meta.url),'utf8');
  const ddl=stringLiterals(source).filter(({value})=>
    /\b(?:CREATE\s+(?:(?:UNIQUE|TEMP(?:ORARY)?|VIRTUAL|OR\s+REPLACE)\s+)*(?:TABLE|INDEX|VIEW|TRIGGER)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER))\b/iu.test(value)
  );
  assert.deepEqual(ddl,[],'api/data.js must not regain schema mutation');
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

test('JavaScript regex literals cannot hide a following DDL string',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-regex-'));
  const api=join(root,'api');
  mkdirSync(api);
  const source=`const apostrophe = /'/;\nexport const sql = 'CREATE TABLE surprise (id INTEGER)';\n`;
  writeFileSync(join(api,'regex-before-ddl.js'),source);
  assert.deepEqual(stringLiterals(source).map(item=>item.value),['CREATE TABLE surprise (id INTEGER)']);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.equal(result.unexpected.length,1);
});

test('escaped JavaScript string contents are decoded before DDL matching',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-escape-'));
  const api=join(root,'api');
  mkdirSync(api);
  const source=[
    "export const escapedVerb = '\\x43REATE TABLE escaped_surprise (id INTEGER)';",
    "export const escapedSpace = 'CREATE\\x20TABLE spaced_surprise (id INTEGER)';",
    '',
  ].join('\n');
  writeFileSync(join(api,'escaped-ddl.js'),source);
  assert.deepEqual(stringLiterals(source).map(item=>item.value),[
    'CREATE TABLE escaped_surprise (id INTEGER)',
    'CREATE TABLE spaced_surprise (id INTEGER)',
  ]);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.equal(result.entries.length,2);
  assert.equal(result.unexpected[0].statementCount,2);
});

test('concat-assembled DDL fails the runtime boundary',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-concat-'));
  const api=join(root,'api');
  mkdirSync(api);
  writeFileSync(join(api,'concat-ddl.js'),`export const sql = 'CREATE'.concat(' TABLE concat_surprise (id INTEGER)');\n`);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.ok(result.assemblyViolations.some(item=>item.code==='dynamic_ddl'));
});

test('unresolved DDL-shaped execute and batch assemblies fail closed',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-dynamic-'));
  const api=join(root,'api');
  mkdirSync(api);
  const sources={
    'binary.js':`db.execute('CREATE ' + process.env.KIND + ' binary_surprise(id INTEGER)');\n`,
    'concat.js':`db.execute('DROP'.concat(process.env.GAP, 'TABLE concat_surprise'));\n`,
    'join.js':`db.execute(['ALTER', process.env.OBJECT, 'join_surprise ADD COLUMN x'].join(' '));\n`,
    'batch.js':`db.batch([{sql:'CREATE ' + process.env.KIND + ' batch_surprise(id INTEGER)'}]);\n`,
  };
  Object.entries(sources).forEach(([name,source])=>writeFileSync(join(api,name),source));
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  const dynamicFiles=new Set(result.assemblyViolations
    .filter(item=>item.code==='dynamic_ddl')
    .map(item=>item.file.split('/').pop()));
  assert.deepEqual([...dynamicFiles].sort(),Object.keys(sources).sort());
});

test('SQL comments cannot split DDL tokens past the boundary',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-comments-'));
  const api=join(root,'api');
  mkdirSync(api);
  const statements=[
    'CREATE/**/TABLE comment_surprise_a(id INTEGER)',
    'CREATE /*x*/ TABLE comment_surprise_b(id INTEGER)',
    'DROP/**/TABLE comment_surprise_c',
  ];
  writeFileSync(join(api,'comment-ddl.js'),statements
    .map((sql,index)=>`export const sql${index}=${JSON.stringify(sql)};`)
    .join('\n'));
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.equal(result.entries.length,3);
  assert.equal(result.unexpected[0].statementCount,3);
});

test('computed database methods and SQL properties retain the DDL boundary',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-computed-'));
  const api=join(root,'api');
  mkdirSync(api);
  const sources={
    'execute.js':`db['execute']('CREATE ' + process.env.KIND + ' computed_execute(id INTEGER)');\n`,
    'batch.js':`db['batch']([{['sql']:'DROP ' + process.env.KIND + ' computed_batch'}]);\n`,
  };
  Object.entries(sources).forEach(([name,source])=>writeFileSync(join(api,name),source));
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  const dynamicFiles=new Set(result.assemblyViolations
    .filter(item=>item.code==='dynamic_ddl')
    .map(item=>item.file.split('/').pop()));
  assert.deepEqual([...dynamicFiles].sort(),Object.keys(sources).sort());
});

test('global assembly checks survive reassignment, shadowing, and conditional values',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-scope-'));
  const api=join(root,'api');
  mkdirSync(api);
  const source=`
    let sql = 'SELECT 1';
    sql = 'CREATE ' + process.env.KIND + ' reassigned_surprise(id INTEGER)';
    db.execute(sql);
    function harmless(){ const statement = 'SELECT 2'; return statement; }
    function shadowed(){
      const statement = 'DROP'.concat(process.env.GAP, 'TABLE shadowed_surprise');
      db.execute(statement);
    }
    const conditional = process.env.MODE
      ? 'ALTER ' + process.env.KIND + ' conditional_surprise RENAME TO renamed'
      : 'SELECT 3';
  `;
  writeFileSync(join(api,'scopes.js'),source);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  const dynamicLines=new Set(result.assemblyViolations
    .filter(item=>item.code==='dynamic_ddl')
    .map(item=>item.line));
  const lineOf=needle=>source.slice(0,source.indexOf(needle)).split('\n').length;
  assert.ok(dynamicLines.has(lineOf("sql = 'CREATE '")),'reassigned binary DDL must be reported');
  assert.ok(dynamicLines.has(lineOf("const statement = 'DROP'")),'shadowed concat DDL must be reported');
  assert.ok(dynamicLines.has(lineOf('const conditional =')),'conditional DDL must be reported independently');
});

test('AST import traversal follows a statically resolved dynamic-import variable',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-import-'));
  const api=join(root,'api');
  mkdirSync(api);
  writeFileSync(join(root,'helper.js'),`export const sql='CREATE TABLE dynamic_import_surprise(id INTEGER)';\n`);
  writeFileSync(join(api,'entry.js'),`const helper='../helper.js';\nvoid import(helper);\n`);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.equal(result.unexpected.length,1);
  assert.ok(result.unexpected[0].file.endsWith('/helper.js'));
  assert.ok(!result.assemblyViolations.some(item=>item.code==='unresolved_dynamic_import'));
});

test('unresolved request-reachable dynamic imports fail closed',()=>{
  const root=mkdtempSync(join(tmpdir(),'randori-ddl-import-unknown-'));
  const api=join(root,'api');
  mkdirSync(api);
  writeFileSync(join(api,'entry.js'),`void import(process.env.REQUEST_HELPER);\n`);
  const result=checkRuntimeDdl(api,[]);
  assert.equal(result.ok,false);
  assert.ok(result.assemblyViolations.some(item=>item.code==='unresolved_dynamic_import'));
});
