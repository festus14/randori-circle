import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createClient} from '@libsql/client';

import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-provider-identities-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const db=createClient({url});
  return {db,url,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
}

function isConstraint(error){ return String(error?.code||'').startsWith('SQLITE_CONSTRAINT'); }

test('v4 persists issuer-scoped subjects with provider and account uniqueness',async()=>{
  const item=fixture();
  try{
    await apply(item.db,EXECUTABLE_MIGRATIONS.slice(0,3));
    await item.db.batch([
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
        (1,'one@example.test','!oauth:one','One','#123456'),
        (2,'two@example.test','!oauth:two','Two','#654321')`,
    ],'write');
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,3);
    const result=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY,
    });
    assert.deepEqual(result.applied.map(item=>item.version),[4]);

    await item.db.execute({
      sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
      args:['https://accounts.google.com','google-subject-1',1],
    });
    for(const operation of [
      ()=>item.db.execute({
        sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
        args:['https://accounts.google.com','google-subject-1',2],
      }),
      ()=>item.db.execute({
        sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
        args:['https://accounts.google.com','google-subject-2',1],
      }),
      ()=>item.db.execute({
        sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
        args:['https://evil.example','google-subject-3',2],
      }),
      ()=>item.db.execute({
        sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,?)`,
        args:['https://accounts.google.com','invalid subject',2],
      }),
    ]) await assert.rejects(operation,isConstraint);

    const reopened=createClient({url:item.url});
    try{
      await prepareMigrationConnection(reopened);
      const state=await inspectMigrationState(reopened);
      assert.equal(state.currentVersion,4);
      assert.equal(state.ready,true);
      const identities=await reopened.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities`);
      assert.deepEqual(identities.rows.map(row=>[String(row.issuer),String(row.subject),Number(row.user_id)]),[
        ['https://accounts.google.com','google-subject-1',1],
      ]);
    }finally{ reopened.close(); }
  }finally{ item.close(); }
});
