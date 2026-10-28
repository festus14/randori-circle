// Migration v23 (#372): account_deletion_requests is additive, empty,
// indexed and exact after v22, and only then passes grace readiness. On a
// v22 database the code stays ready (ID-87 pending-additive) while the
// feature stays gated off. The v22 feedback migration keeps its contract
// below as a regression pin.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { ledgerReadiness } from '../../db/migration-compatibility.js';
import { READINESS_SCHEMA_MANIFEST } from '../../db/schema-readiness-manifest.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';
import { graceSchemaAvailable } from '../../api/_account-deletion-grace.js';
import { schemaCapabilityAvailable } from '../../api/_schema-capability.js';

const V23=EXECUTABLE_MIGRATIONS[22];
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const HASH='a'.repeat(64);
const ID='00000000-0000-4000-8000-000000000001';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-feedback-migration-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const db=createClient({url});
  return {db,url,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
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

test('v23 is additive, empty, indexed, and exact after v22, and only then passes grace readiness',async()=>{
  const item=fixture();
  try{
    await apply(item.db,EXECUTABLE_MIGRATIONS.slice(0,22));
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,22);
    // The v22 feedback contract is unchanged by the v23 migration.
    assert.equal(MIGRATION_CONTRACTS[21].compatibility,'additive');
    assert.deepEqual(MIGRATION_CONTRACTS[21].introduces,{
      tables:['feedback_items','feedback_votes','feedback_events'],
      indexes:['idx_feedback_items_author','idx_feedback_items_circle_status',
        'idx_feedback_items_closed_retention','uq_feedback_items_author_idempotency',
        'idx_feedback_votes_feedback','idx_feedback_votes_user','idx_feedback_events_feedback'],
      triggers:[],
    });
    // Code at v23 is ready on a v22 database (pending additive), and the
    // feature capability is still off until the cutover applies v23.
    assert.deepEqual(ledgerReadiness({currentVersion:22,rows:Array.from({length:22},(_,i)=>({}))}),
      {currentVersion:22,expectedVersion:23,ready:true,state:'pending_additive',pendingVersion:23});
    // The capability cache is per client, so the pre-cutover check runs
    // on a second client and never warms this test client's cache.
    const probeClient=createClient({url:item.url});
    try{
      assert.equal(await schemaCapabilityAvailable(probeClient,{version:23}),false);
      assert.equal(await graceSchemaAvailable(probeClient),false,
        'grace paths fail closed on the pre-v23 schema without creating it');
    }finally{ probeClient.close(); }
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM sqlite_master WHERE name='account_deletion_requests'`)).rows[0].c,0,
      'the readiness probe never runs DDL');
    const result=await applyMigrations(item.db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(entry=>entry.version),[23]);
    assert.equal(V23.name,'account-deletion-grace-period');
    assert.equal(MIGRATION_CONTRACTS[22].checksum,V23.checksum);
    assert.equal(MIGRATION_CONTRACTS[22].compatibility,'additive');
    assert.deepEqual(MIGRATION_CONTRACTS[22].introduces,{
      tables:['account_deletion_requests'],
      indexes:['uq_account_deletion_requests_active_user','idx_account_deletion_requests_due'],
      triggers:[],
    });
    assert.deepEqual(V23.operations.map(operation=>operation.name),[
      'account_deletion_requests',
      'uq_account_deletion_requests_active_user',
      'idx_account_deletion_requests_due',
    ]);
    assert.ok(V23.operations.every(operation=>['ensure-table','ensure-index'].includes(operation.operation)),
      'v23 adds no triggers or state rows');
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM account_deletion_requests`)).rows[0].c,0);
    const state=await inspectMigrationState(item.db);
    assert.equal(state.currentVersion,23);
    assert.equal(state.schemaExact,true);
    assert.equal(await schemaCapabilityAvailable(item.db,{version:23}),true);
    assert.equal(await graceSchemaAvailable(item.db),true);
    assert.equal(READINESS_SCHEMA_MANIFEST.checksum,SCHEMA_MANIFEST.checksum);
    assert.ok(READINESS_SCHEMA_MANIFEST.tables.some(table=>table.name==='account_deletion_requests'));
  }finally{ item.close(); }
});

test('v22 constraints keep one vote per member, one idempotency key per author, and closed items dated',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    await seedCircle(item.db);
    const insertItem=(overrides={})=>{
      const row={id:ID,circle_id:10,author_user_id:1,kind:'bug',title:'Broken',body:'It breaks.',
        status:'open',visibility:'private',diagnostics_json:null,idempotency_key:'key-12345678',
        created_at:100,updated_at:100,closed_at:null,...overrides};
      return item.db.execute({sql:`INSERT INTO feedback_items
          (id,circle_id,author_user_id,kind,title,body,status,visibility,diagnostics_json,
           idempotency_key,created_at,updated_at,closed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:Object.values(row)});
    };
    await insertItem();
    await assert.rejects(insertItem({id:'00000000-0000-4000-8000-000000000002'}),
      /UNIQUE/,'one idempotency key per author');
    await insertItem({id:'00000000-0000-4000-8000-000000000002',author_user_id:1,
      idempotency_key:'key-87654321'});
    // A different author may reuse the same key.
    await item.db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
      VALUES (2,'other@example.test','hash','Other','#222222')`);
    await insertItem({id:'00000000-0000-4000-8000-000000000003',author_user_id:2});
    const rejected=[
      {kind:'idea'},
      {title:''},
      {title:'x'.repeat(121)},
      {title:' Broken'},
      {body:''},
      {body:'x'.repeat(4001)},
      {status:'triaged'},
      {visibility:'circle'},
      {kind:'feedback',diagnostics_json:'{"browser":"Chrome"}'},
      {kind:'bug',diagnostics_json:'[1]'},
      {kind:'bug',diagnostics_json:'not json'},
      {idempotency_key:'short'},
      {status:'closed'},
      {status:'closed',closed_at:50},
      {closed_at:150},
      {created_at:0},
      {circle_id:99},
      {author_user_id:99},
    ];
    for(const [index,overrides] of rejected.entries()){
      await assert.rejects(insertItem({id:`00000000-0000-4000-8000-000000001${String(index).padStart(3,'0')}`,
        author_user_id:2,idempotency_key:`rejected-${index}-12345678`,...overrides}),
      /CHECK|FOREIGN KEY|constraint/i,JSON.stringify(overrides));
    }
    await insertItem({id:'00000000-0000-4000-8000-000000000004',author_user_id:2,
      idempotency_key:'closed-key-12345678',status:'closed',closed_at:150});
    // Votes: one per member per item, value 1 only.
    await item.db.execute(`INSERT INTO feedback_votes (feedback_id,user_id,value,created_at)
      VALUES (?,?,1,100)`,[ID,1]);
    await assert.rejects(item.db.execute(`INSERT INTO feedback_votes (feedback_id,user_id,value,created_at)
      VALUES (?,?,1,100)`,[ID,1]),/UNIQUE/);
    await assert.rejects(item.db.execute(`INSERT INTO feedback_votes (feedback_id,user_id,value,created_at)
      VALUES (?,?,0,100)`,[ID,2]),/CHECK/);
    await assert.rejects(item.db.execute(`INSERT INTO feedback_votes (feedback_id,user_id,value,created_at)
      VALUES (?,?,1,100)`,['00000000-0000-4000-8000-000000000099',2]),/FOREIGN KEY/);
    // Events: only the two known types.
    await item.db.execute(`INSERT INTO feedback_events (feedback_id,event_type,actor_user_id,detail_json,created_at)
      VALUES (?, 'feedback.created',1,NULL,100)`,[ID]);
    await assert.rejects(item.db.execute(`INSERT INTO feedback_events (feedback_id,event_type,actor_user_id,detail_json,created_at)
      VALUES (?, 'feedback.deleted',1,NULL,100)`,[ID]),/CHECK/);
    // Deleting an item cascades its votes and events.
    await item.db.execute(`DELETE FROM feedback_items WHERE id=?`,[ID]);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM feedback_votes WHERE feedback_id=?`,[ID])).rows[0].c,0);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM feedback_events WHERE feedback_id=?`,[ID])).rows[0].c,0);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM feedback_items`)).rows[0].c,3);
    assert.equal(HASH.length,64);
  }finally{ item.close(); }
});
