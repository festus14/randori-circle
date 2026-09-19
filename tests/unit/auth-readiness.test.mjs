import assert from 'node:assert/strict';
import test from 'node:test';

import {ensureAuthReadiness} from '../../api/_auth-readiness.js';

const DDL=/^\s*(?:CREATE|ALTER|DROP|VACUUM|REINDEX|PRAGMA\s+writable_schema\b)/iu;

function database(execute){
  return {execute};
}

test('auth readiness coalesces read-only probes for the complete core contract',async()=>{
  const statements=[];
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const db=database(async statement=>{
    statements.push(String(statement));
    if(statements.length===1) await gate;
    return {rows:[],rowsAffected:0};
  });

  const first=ensureAuthReadiness(db);
  const second=ensureAuthReadiness(db);
  await Promise.resolve();
  assert.equal(statements.length,1,'concurrent requests share the readiness probe');
  release();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(statements.length,4);
  assert.deepEqual(statements.map(sql=>sql.match(/FROM\s+(\w+)\s+LIMIT\s+0/iu)?.[1]),[
    'auth_accounts','users','auth_rate_limits','auth_sessions',
  ]);
  assert.equal(statements.some(sql=>DDL.test(sql)),false);

  assert.equal(await ensureAuthReadiness(db),true);
  assert.equal(statements.length,4,'a ready client is not probed again');
});

test('auth readiness fails closed, performs no writes, and retries a rejected probe',async()=>{
  const statements=[];
  let failures=1;
  const db=database(async statement=>{
    const sql=String(statement);
    statements.push(sql);
    if(sql.includes('FROM auth_accounts LIMIT 0')&&failures-->0){
      throw new Error('missing auth_accounts');
    }
    return {rows:[],rowsAffected:0};
  });

  await assert.rejects(ensureAuthReadiness(db),/missing auth_accounts/);
  assert.equal(statements.length,1);
  assert.equal(statements.some(sql=>DDL.test(sql)),false);
  assert.equal(statements.some(sql=>/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)),false);

  assert.equal(await ensureAuthReadiness(db),true);
  assert.equal(statements.length,5,'a failed readiness promise is never cached');
});

test('auth readiness rejects invalid database clients before access',async()=>{
  await assert.rejects(ensureAuthReadiness(null),/database client is required/);
  await assert.rejects(ensureAuthReadiness({}),/database client is required/);
});
