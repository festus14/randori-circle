import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { READINESS_SCHEMA_MANIFEST } from '../../db/schema-readiness-manifest.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';
import {
  ensureInviteRequestReadiness,
  inviteRequestSchemaNotInstalled,
} from '../../api/_invite-request-config.js';

const V21=EXECUTABLE_MIGRATIONS[20];
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const HASH='a'.repeat(64);
const ID='00000000-0000-4000-8000-000000000001';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-invite-request-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedCircle(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
    VALUES (1,'owner@example.test','hash','Owner','#111111')`);
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
    VALUES (10,'3c20c4da-1906-4ca4-b4fd-5971f1dd066d','randori-circle','Randori Circle',1,1)`);
}

test('v21 is additive, empty, indexed, and exact after v20, and only then passes request readiness',async()=>{
  const item=fixture();
  try{
    await apply(item.db,EXECUTABLE_MIGRATIONS.slice(0,20));
    const before=await inspectMigrationState(item.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,21)});
    assert.equal(before.currentVersion,20);
    await assert.rejects(ensureInviteRequestReadiness(item.db),error=>inviteRequestSchemaNotInstalled(error),
      'request paths fail closed on the pre-v21 schema without creating it');
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name='invite_requests'`)).rows[0].c,0,
      'the readiness probe never runs DDL');
    const result=await applyMigrations(item.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,21),expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(entry=>entry.version),[21]);
    assert.equal(V21.name,'public-invite-requests');
    assert.equal(MIGRATION_CONTRACTS[20].checksum,V21.checksum);
    assert.deepEqual(V21.operations.map(operation=>operation.name),[
      'invite_requests','uq_invite_requests_pending_email','idx_invite_requests_circle_status',
      'idx_invite_requests_email','idx_invite_requests_pending_expiry','idx_invite_requests_decided',
    ]);
    assert.ok(V21.operations.every(operation=>['ensure-table','ensure-index'].includes(operation.operation)),
      'v21 adds no triggers or state rows');
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM invite_requests`)).rows[0].c,0);
    const state=await inspectMigrationState(item.db);
    assert.equal(state.currentVersion,21);
    assert.equal(state.schemaExact,true);
    assert.equal(await ensureInviteRequestReadiness(item.db),true);
    assert.equal(READINESS_SCHEMA_MANIFEST.checksum,SCHEMA_MANIFEST.checksum);
    assert.ok(READINESS_SCHEMA_MANIFEST.tables.some(table=>table.name==='invite_requests'));
  }finally{ item.close(); }
});

test('v21 constraints keep one pending request per email and force decided rows to be scrubbed',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    await seedCircle(item.db);
    const insert=(overrides={})=>{
      const row={id:ID,circle_id:10,email_hash:HASH,email:'ada@example.test',name:'Ada',note:null,
        status:'pending',created_at:100,expires_at:200,decided_at:null,decided_by:null,invitation_id:null,...overrides};
      return item.db.execute({sql:`INSERT INTO invite_requests
          (id,circle_id,email_hash,email,name,note,status,created_at,expires_at,decided_at,decided_by,invitation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,args:Object.values(row)});
    };
    await insert();
    await assert.rejects(insert({id:'00000000-0000-4000-8000-000000000002'}),/UNIQUE/,'one pending row per email');
    await insert({id:'00000000-0000-4000-8000-000000000003',status:'declined',email:null,name:null,
      decided_at:150,decided_by:1});
    await insert({id:'00000000-0000-4000-8000-000000000004',status:'declined',email:null,name:null,
      decided_at:160,decided_by:1});
    const rejected=[
      {status:'approved',decided_at:150,decided_by:1,invitation_id:ID},
      {status:'approved',email:null,name:null,decided_at:150,decided_by:1},
      {status:'declined',email:null,name:null,note:'kept',decided_at:150,decided_by:1},
      {status:'expired',email:null,name:null,decided_at:150,decided_by:1},
      {status:'pending',decided_at:150},
      {status:'unknown'},
      {name:'A'},
      {name:' Ada'},
      {name:'x'.repeat(61)},
      {note:''},
      {note:'x'.repeat(281)},
      {email:'Ada@Example.test'},
      {email_hash:'not-a-hash'},
      {expires_at:100},
      {created_at:0},
      {circle_id:99},
    ];
    for(const [index,overrides] of rejected.entries()){
      await assert.rejects(insert({id:`00000000-0000-4000-8000-0000000001${String(index).padStart(2,'0')}`,
        email_hash:'b'.repeat(64),...overrides}),/CHECK|FOREIGN KEY|constraint/i,JSON.stringify(overrides));
    }
    await insert({id:'00000000-0000-4000-8000-000000000005',email_hash:'c'.repeat(64),status:'approved',
      email:null,name:null,decided_at:150,decided_by:1,invitation_id:ID});
    await insert({id:'00000000-0000-4000-8000-000000000006',email_hash:'d'.repeat(64),status:'expired',
      email:null,name:null,decided_at:250});
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM invite_requests`)).rows[0].c,5);
  }finally{ item.close(); }
});
