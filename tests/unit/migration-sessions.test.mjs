import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createClient} from '@libsql/client';

import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
}

function constraint(error){ return String(error?.code||'').startsWith('SQLITE_CONSTRAINT'); }

test('v5 adds only durable hashed sessions and remains exact after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-session-migration-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const db=createClient({url});
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,4));
    await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
      VALUES (1,'member@example.test','hash','Member','#123456')`);
    const before=await inspectMigrationState(db);
    assert.equal(before.currentVersion,4);
    assert.equal(before.latestVersion,5);
    assert.equal(before.ready,true);
    const result=await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(item=>item.version),[5]);

    const validHash='a'.repeat(64);
    await db.execute({
      sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
      args:[validHash,1,100,200],
    });
    for(const operation of [
      ()=>db.execute({
        sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
        args:[null,1,100,200],
      }),
      ()=>db.execute({
        sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
        args:['raw-session-id',1,100,200],
      }),
      ()=>db.execute({
        sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
        args:['b'.repeat(64),99,100,200],
      }),
      ()=>db.execute({
        sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
        args:['c'.repeat(64),1,200,200],
      }),
      ()=>db.execute({
        sql:`UPDATE auth_sessions SET revocation_reason='untrusted' WHERE session_hash=?`,args:[validHash],
      }),
    ]) await assert.rejects(operation,constraint);

    await db.close();
    const reopened=createClient({url});
    try{
      await prepareMigrationConnection(reopened);
      const state=await inspectMigrationState(reopened);
      assert.equal(state.currentVersion,5);
      assert.equal(state.ready,true);
      const rows=await reopened.execute(`SELECT session_hash,user_id,created_at,expires_at FROM auth_sessions`);
      assert.deepEqual(rows.rows.map(row=>({
        session_hash:String(row.session_hash),user_id:Number(row.user_id),
        created_at:Number(row.created_at),expires_at:Number(row.expires_at),
      })),[{session_hash:validHash,user_id:1,created_at:100,expires_at:200}]);
    }finally{ await reopened.close(); }
  }finally{
    try{ await db.close(); }catch{}
    rmSync(directory,{recursive:true,force:true});
  }
});
