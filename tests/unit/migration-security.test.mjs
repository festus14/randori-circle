import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_LEDGER_SQL, MigrationLedgerError } from '../../db/migration-ledger.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMembershipAdoption,
  inspectMigrationState,
  prepareMigrationConnection,
  publicMigrationError,
} from '../../db/migration-runner.js';
import { localDatabaseTarget, main as migrateCli } from '../../scripts/db-migrate.mjs';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(t,clientCount=1){
  const directory=mkdtempSync(join(tmpdir(),'randori-migration-security-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  const clients=Array.from({length:clientCount},()=>createClient({url}));
  t.after(()=>{
    clients.forEach(client=>client.close());
    rmSync(directory,{recursive:true,force:true});
  });
  return {db:clients[0],clients,url};
}

function plainRows(rows){
  return (rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[
    key,typeof value==='bigint'?value.toString():value,
  ])));
}

async function snapshot(db){
  const objects=await db.execute(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  let ledger=[];
  try{ ledger=plainRows((await db.execute('SELECT * FROM schema_migrations ORDER BY version')).rows); }
  catch{}
  return {objects:plainRows(objects.rows),ledger};
}

async function state(db){
  await prepareMigrationConnection(db);
  return inspectMigrationState(db);
}

async function freshFingerprint(){
  const db=createClient({url:'file::memory:'});
  try{ return (await state(db)).stateFingerprint; }
  finally{ db.close(); }
}

async function applyCurrent(db,options={}){
  const before=await state(db);
  return applyMigrations(db,{
    expectedStateFingerprint:before.stateFingerprint,
    retry:NO_RETRY,
    ...options,
  });
}

async function installCurrentSchemaWithoutLedger(db){
  await prepareMigrationConnection(db);
  for(const migration of EXECUTABLE_MIGRATIONS){
    for(const operation of migration.operations) await db.execute(operation.sql);
  }
}

async function completeMembershipRollout(db){
  await db.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin,is_demo)
    VALUES (1,'owner@example.test','!oauth:test','Owner','#123456',1,0)`);
  await db.execute(`INSERT INTO circles
    (id,public_id,slug,name,is_primary,created_by)
    VALUES (1,'primary-public-id','randori-circle','Randori Circle',1,1)`);
  await db.execute(`INSERT INTO circle_memberships
    (circle_id,user_id,role,status,joined_at,updated_at)
    VALUES (1,1,'owner','active',datetime('now'),datetime('now'))`);
  await db.execute(`INSERT INTO circle_audit_events
    (circle_id,event_type,actor_user_id,dedupe_key)
    VALUES (1,'membership.backfill.completed',1,'primary-membership-backfill:1:v1')`);
  await db.execute(`INSERT INTO circle_audit_events
    (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
    VALUES (1,'membership.backfilled',1,1,'membership-backfilled:1:1')`);
  await db.execute(`UPDATE circle_membership_rollout
    SET registrations_closed=1,updated_at=datetime('now') WHERE id=1`);
}

async function addInvitedMember(db,{malformedAudit=false}={}){
  await db.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin,is_demo)
    VALUES (2,'member@example.test','!oauth:test','Member','#654321',0,0)`);
  await db.execute(`INSERT INTO circle_memberships
    (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
    VALUES (1,2,'member','active',1,datetime('now'),datetime('now'))`);
  await db.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by)
      VALUES ('invite-2',1,?,?,1,datetime('now'),datetime('now','+7 days'),datetime('now'),2)`,
    args:['a'.repeat(64),'b'.repeat(64)],
  });
  await db.execute({
    sql:`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key)
      VALUES (1,'invitation.accepted',?,2,'invite-2','invite-accepted:invite-2')`,
    args:[malformedAudit?1:2],
  });
}

function databaseProxy(db,{transaction}){
  return {
    execute:statement=>db.execute(statement),
    transaction:transaction||((mode)=>db.transaction(mode)),
  };
}

test('a stale state fingerprint causes no runner write',async t=>{
  const {clients}=fixture(t,2);
  const [db,other]=clients;
  const planned=await state(db);
  await other.execute('CREATE TABLE concurrent_unmanaged_write (id INTEGER PRIMARY KEY)');
  const before=await snapshot(db);
  await assert.rejects(
    applyMigrations(db,{expectedStateFingerprint:planned.stateFingerprint,retry:NO_RETRY}),
    error=>error instanceof MigrationError&&error.code==='MIGRATION_STATE_CHANGED',
  );
  assert.deepEqual(await snapshot(db),before);
  assert.ok(!before.objects.some(item=>item.name==='schema_migrations'));
});

test('ledger gaps, names, checksums, and future versions fail closed without further writes',async t=>{
  const mutations=[
    db=>db.execute('DELETE FROM schema_migrations WHERE version=1'),
    db=>db.execute("UPDATE schema_migrations SET name='wrong-name' WHERE version=1"),
    db=>db.execute({sql:'UPDATE schema_migrations SET checksum=? WHERE version=1',args:['0'.repeat(64)]}),
    db=>db.execute({
      sql:`INSERT INTO schema_migrations
        (version,name,checksum,execution_ms,disposition) VALUES (19,'future',?,0,'applied')`,
      args:['f'.repeat(64)],
    }),
  ];
  for(const mutate of mutations){
    const {db}=fixture(t);
    await applyCurrent(db);
    await mutate(db);
    const before=await snapshot(db);
    await assert.rejects(
      applyMigrations(db,{expectedStateFingerprint:'0'.repeat(64),retry:NO_RETRY}),
      error=>error instanceof MigrationLedgerError&&error.code==='MIGRATION_LEDGER_INVALID',
    );
    assert.deepEqual(await snapshot(db),before);
  }
});

test('ledger metadata participates in the state fingerprint',async t=>{
  const {db}=fixture(t);
  await applyCurrent(db);
  const planned=await inspectMigrationState(db);
  await db.execute('UPDATE schema_migrations SET execution_ms=execution_ms+1 WHERE version=1');
  const changed=await inspectMigrationState(db);
  assert.notEqual(changed.stateFingerprint,planned.stateFingerprint);
  const before=await snapshot(db);
  await assert.rejects(
    applyMigrations(db,{expectedStateFingerprint:planned.stateFingerprint,retry:NO_RETRY}),
    error=>error instanceof MigrationError&&error.code==='MIGRATION_STATE_CHANGED',
  );
  assert.deepEqual(await snapshot(db),before);
});

test('a failed migration rolls its schema and ledger row back atomically',async t=>{
  const {db}=fixture(t);
  const planned=await state(db);
  const wrapped=databaseProxy(db,{
    transaction:async mode=>{
      const transaction=await db.transaction(mode);
      return {
        execute:async statement=>{
          const result=await transaction.execute(statement);
          const sql=typeof statement==='string'?statement:statement.sql;
          if(/^CREATE TABLE IF NOT EXISTS users\b/i.test(sql)){
            throw new Error('forced failure after transactional DDL');
          }
          return result;
        },
        commit:()=>transaction.commit(),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close(),
      };
    },
  });
  await assert.rejects(
    applyMigrations(wrapped,{expectedStateFingerprint:planned.stateFingerprint,retry:NO_RETRY}),
    error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
  );
  assert.deepEqual((await snapshot(db)).objects,[]);
});

test('retry handling is bounded and never retries non-conflict failures',async t=>{
  {
    const {db}=fixture(t);
    const planned=await state(db);
    let attempts=0;
    const delays=[];
    const wrapped=databaseProxy(db,{
      transaction:async mode=>{
        attempts+=1;
        if(attempts<3) throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
        return db.transaction(mode);
      },
    });
    const result=await applyMigrations(wrapped,{
      expectedStateFingerprint:planned.stateFingerprint,
      retry:{maxAttempts:3,baseDelayMs:1,maxDelayMs:2,sleep:async delay=>delays.push(delay)},
    });
    assert.equal(result.toVersion,18);
    assert.equal(attempts,EXECUTABLE_MIGRATIONS.length+2);
    assert.deepEqual(delays,[1,2]);
  }
  {
    const {db}=fixture(t);
    const planned=await state(db);
    let attempts=0;
    const wrapped=databaseProxy(db,{
      transaction:async()=>{
        attempts+=1;
        throw new Error('write conflict while executing CREATE TABLE secret_data');
      },
    });
    await assert.rejects(
      applyMigrations(wrapped,{
        expectedStateFingerprint:planned.stateFingerprint,
        retry:{maxAttempts:4,baseDelayMs:0,maxDelayMs:0,sleep:async()=>assert.fail('must not retry')},
      }),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    assert.equal(attempts,1);
  }
  {
    const {db}=fixture(t);
    const planned=await state(db);
    let attempts=0;
    const wrapped=databaseProxy(db,{
      transaction:async()=>{
        attempts+=1;
        throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
      },
    });
    await assert.rejects(
      applyMigrations(wrapped,{
        expectedStateFingerprint:planned.stateFingerprint,
        retry:{maxAttempts:3,baseDelayMs:0,maxDelayMs:0,sleep:async()=>{}},
      }),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    assert.equal(attempts,3);
  }
});

test('concurrent runners allow one planned-state winner and converge without duplicate ledger work',async t=>{
  const {clients}=fixture(t,2);
  const [first,second]=clients;
  await Promise.all(clients.map(client=>prepareMigrationConnection(client)));
  await Promise.all(clients.map(client=>client.execute('PRAGMA busy_timeout=1')));
  const planned=await inspectMigrationState(first);
  let arrivals=0;
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const wrap=client=>databaseProxy(client,{
    transaction:async mode=>{
      arrivals+=1;
      if(arrivals===2) release();
      if(arrivals<=2) await gate;
      return client.transaction(mode);
    },
  });
  const retry={maxAttempts:6,baseDelayMs:1,maxDelayMs:4,sleep:delay=>new Promise(resolve=>setTimeout(resolve,delay))};
  const results=await Promise.allSettled([
    applyMigrations(wrap(first),{expectedStateFingerprint:planned.stateFingerprint,retry}),
    applyMigrations(wrap(second),{expectedStateFingerprint:planned.stateFingerprint,retry}),
  ]);
  assert.equal(results.filter(item=>item.status==='fulfilled').length,1);
  const rejected=results.find(item=>item.status==='rejected');
  assert.ok(rejected.reason instanceof MigrationError);
  assert.equal(rejected.reason.code,'MIGRATION_STATE_CHANGED');
  const ledger=await first.execute('SELECT version,COUNT(*) AS count FROM schema_migrations GROUP BY version ORDER BY version');
  assert.deepEqual(plainRows(ledger.rows),[
    {version:1,count:1},
    {version:2,count:1},
    {version:3,count:1},
    {version:4,count:1},
    {version:5,count:1},
    {version:6,count:1},
    {version:7,count:1},{version:8,count:1},{version:9,count:1},{version:10,count:1},
    {version:11,count:1},{version:12,count:1},{version:13,count:1},{version:14,count:1},
    {version:15,count:1},{version:16,count:1},{version:17,count:1},{version:18,count:1},
  ]);
  const finalState=await inspectMigrationState(first);
  assert.equal(finalState.classification,'managed');
  assert.equal(finalState.currentVersion,18);
  assert.equal(finalState.schemaExact,true);
});

test('an empty ledger plus application objects is invalid for apply and adoption',async t=>{
  const {db}=fixture(t);
  await prepareMigrationConnection(db);
  await db.execute(MIGRATION_LEDGER_SQL);
  await db.execute(EXECUTABLE_MIGRATIONS[0].operations.find(item=>item.name==='users').sql);
  const beforeState=await inspectMigrationState(db);
  assert.equal(beforeState.classification,'unmanaged');
  assert.equal(beforeState.adoption.eligible,false);
  const before=await snapshot(db);
  await assert.rejects(
    applyMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY}),
    error=>error instanceof MigrationError&&error.code==='MIGRATION_UNMANAGED',
  );
  await assert.rejects(
    adoptMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY}),
    error=>error instanceof MigrationError&&error.code==='MIGRATION_ADOPTION_BLOCKED',
  );
  assert.deepEqual(await snapshot(db),before);
});

test('schema-ahead and unexpected artifacts block managed and unmanaged mutation',async t=>{
  {
    const {db}=fixture(t);
    await applyCurrent(db);
    await db.execute('CREATE TABLE unexpected_managed_table (id INTEGER PRIMARY KEY)');
    const beforeState=await state(db);
    assert.equal(beforeState.classification,'managed');
    assert.equal(beforeState.schemaExact,false);
    const before=await snapshot(db);
    await assert.rejects(
      applyMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_SCHEMA_INVALID',
    );
    assert.deepEqual(await snapshot(db),before);
  }
  {
    const {db}=fixture(t);
    await installCurrentSchemaWithoutLedger(db);
    await db.execute('CREATE INDEX unexpected_unmanaged_index ON users(name)');
    const beforeState=await inspectMigrationState(db);
    assert.equal(beforeState.classification,'unmanaged');
    assert.equal(beforeState.adoption.eligible,false);
    assert.ok(beforeState.schemaStatus.warnings.some(item=>item.code==='unexpected_index'));
    const before=await snapshot(db);
    await assert.rejects(
      adoptMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_ADOPTION_BLOCKED',
    );
    assert.deepEqual(await snapshot(db),before);
  }
});

test('fresh migration creates only the valid pristine-open rollout state',async t=>{
  const {db}=fixture(t);
  const result=await applyCurrent(db);
  assert.equal(result.toVersion,18);
  const membership=await inspectMembershipAdoption(db);
  assert.equal(membership.ok,true);
  assert.equal(membership.registrationState,'open');
  assert.deepEqual(membership.counts,{
    rolloutRows:1,
    activePrimaryCircles:0,
    circles:0,
    memberships:0,
    invitations:0,
    auditEvents:0,
    completedBackfills:0,
  });
});

test('adoption accepts pristine-open and complete-closed states and writes only the ledger',async t=>{
  for(const completed of [false,true]){
    const {db}=fixture(t);
    await installCurrentSchemaWithoutLedger(db);
    if(completed){
      await completeMembershipRollout(db);
      await addInvitedMember(db);
    }else{
      await db.execute(`INSERT INTO auth_accounts
        (id,email,password_hash,display_name,color,is_admin,is_demo)
        VALUES (1,'local@example.test','!oauth:test','Local','#123456',1,0)`);
    }
    const cycleKey='c'.repeat(64);
    await db.execute({
      sql:`INSERT INTO pairing_cycles
        (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
        VALUES ('local',NULL,?,'2026-W39','2026-09-20T07:00:00.000Z',
          '2026-09-27T07:00:00.000Z','2026-09-20T07:00:00.000Z','Europe/London','legacy_bridge')`,
      args:[cycleKey],
    });
    await db.execute({
      sql:`INSERT INTO pairing_cycle_availability
        (scope_key,cycle_key,user_id,is_available,version,decision_source)
        VALUES ('local',?,1,0,1,'legacy_bridge')`,
      args:[cycleKey],
    });
    await db.execute("INSERT INTO users (id,name,color) VALUES (91,'Preserved User','#abcdef')");
    const beforeObjects=(await snapshot(db)).objects;
    const beforeUser=plainRows((await db.execute('SELECT * FROM users WHERE id=91')).rows);
    const beforeAvailability=plainRows((await db.execute(
      'SELECT * FROM pairing_cycle_availability ORDER BY scope_key,cycle_key,user_id',
    )).rows);
    const beforeMembership=await inspectMembershipAdoption(db);
    assert.equal(beforeMembership.ok,true);
    assert.equal(beforeMembership.registrationState,completed?'closed':'open');
    const beforeState=await inspectMigrationState(db);
    assert.equal(beforeState.adoption.eligible,true);
    const result=await adoptMigrations(db,{
      expectedStateFingerprint:beforeState.stateFingerprint,
      retry:NO_RETRY,
    });
    assert.equal(result.toVersion,18);
    const ledger=await db.execute('SELECT version,disposition FROM schema_migrations ORDER BY version');
    assert.deepEqual(plainRows(ledger.rows),[
      {version:1,disposition:'adopted'},
      {version:2,disposition:'adopted'},
      {version:3,disposition:'adopted'},
      {version:4,disposition:'adopted'},
      {version:5,disposition:'adopted'},
      {version:6,disposition:'adopted'},
      {version:7,disposition:'adopted'},{version:8,disposition:'adopted'},
      {version:9,disposition:'adopted'},{version:10,disposition:'adopted'},
      {version:11,disposition:'adopted'},{version:12,disposition:'adopted'},
      {version:13,disposition:'adopted'},{version:14,disposition:'adopted'},
      {version:15,disposition:'adopted'},{version:16,disposition:'adopted'},
      {version:17,disposition:'adopted'},{version:18,disposition:'adopted'},
    ]);
    assert.deepEqual(plainRows((await db.execute('SELECT * FROM users WHERE id=91')).rows),beforeUser);
    assert.deepEqual(plainRows((await db.execute(
      'SELECT * FROM pairing_cycle_availability ORDER BY scope_key,cycle_key,user_id',
    )).rows),beforeAvailability);
    assert.deepEqual((await snapshot(db)).objects.filter(item=>item.name!=='schema_migrations'),beforeObjects);
    assert.deepEqual(await inspectMembershipAdoption(db),beforeMembership);
  }
});

test('adoption rejects every mixed rollout state without creating a ledger',async t=>{
  const scenarios=[
    async db=>{
      await db.execute(`INSERT INTO circles
        (id,public_id,slug,name,is_primary) VALUES (1,'mixed','mixed','Mixed',1)`);
    },
    async db=>{
      await db.execute(`INSERT INTO circles
        (id,public_id,slug,name,is_primary) VALUES (9,'partial','partial','Partial',0)`);
      await db.execute(`INSERT INTO circle_audit_events
        (circle_id,event_type,dedupe_key) VALUES (9,'membership.backfilled','partial-backfill')`);
    },
    async db=>{
      await db.execute(`UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1`);
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute("INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES (2,'missing@example.test','!oauth:test','Missing','#654321',0)");
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute("DELETE FROM circle_audit_events WHERE event_type='membership.backfill.completed'");
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute("INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,999,'member','active')");
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute(`INSERT INTO circles
        (id,public_id,slug,name,is_primary) VALUES (2,'secondary','secondary','Secondary',0)`);
      await db.execute("INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (2,999,'member','active')");
    },
    async db=>{
      await completeMembershipRollout(db);
      await addInvitedMember(db,{malformedAudit:true});
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute(`UPDATE circle_audit_events SET actor_user_id=NULL
        WHERE event_type='membership.backfilled'`);
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute(`UPDATE circle_audit_events
        SET actor_user_id=NULL,subject_user_id=1,invitation_id='forged'
        WHERE event_type='membership.backfill.completed'`);
    },
    async db=>{
      await completeMembershipRollout(db);
      await db.execute(`INSERT INTO auth_accounts
        (id,email,password_hash,display_name,color,is_demo)
        VALUES (3,'demo-owner@example.test','!oauth:test','Demo owner','#abcdef',1)`);
      await db.execute(`INSERT INTO circle_memberships
        (circle_id,user_id,role,status) VALUES (1,3,'owner','active')`);
      await db.execute(`UPDATE circle_audit_events SET actor_user_id=3
        WHERE event_type IN ('membership.backfilled','membership.backfill.completed')`);
    },
  ];
  for(const arrange of scenarios){
    const {db}=fixture(t);
    await installCurrentSchemaWithoutLedger(db);
    await arrange(db);
    const beforeState=await inspectMigrationState(db);
    assert.equal(beforeState.classification,'unmanaged');
    assert.equal(beforeState.adoption.eligible,false);
    const before=await snapshot(db);
    await assert.rejects(
      adoptMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_ADOPTION_BLOCKED',
    );
    assert.deepEqual(await snapshot(db),before);
    assert.ok(!before.objects.some(item=>item.name==='schema_migrations'));
  }
});

test('public migration errors redact secrets, local paths, and raw SQL',()=>{
  const secret='/private/database.sqlite token=super-secret CREATE TABLE credentials(value TEXT)';
  const controlled=publicMigrationError(new MigrationError('MIGRATION_FAILED',secret,{
    cause:new Error(secret),details:{version:1},
  }));
  const unexpected=publicMigrationError(new Error(secret));
  for(const result of [controlled,unexpected]){
    const serialized=JSON.stringify(result);
    assert.equal(result.error,'MIGRATION_FAILED');
    assert.doesNotMatch(serialized,/private|super-secret|CREATE TABLE|credentials/i);
  }
});

test('migration CLI rejects dangling database symlinks',()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migration-target-'));
  try{
    const target=join(directory,'database.sqlite');
    symlinkSync(join(directory,'missing-victim.sqlite'),target);
    assert.equal(lstatSync(target).isSymbolicLink(),true);
    assert.throws(
      ()=>localDatabaseTarget(pathToFileURL(target).href),
      error=>error?.code==='DB_MIGRATE_TARGET',
    );
  }finally{
    rmSync(directory,{recursive:true,force:true});
  }
});

test('atomic missing-target reservation rejects a late symlink without touching its victim',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migration-reservation-'));
  const target=join(directory,'database.sqlite');
  const victim=join(directory,'victim.sqlite');
  writeFileSync(victim,'');
  try{
    const expectedStateFingerprint=await freshFingerprint();
    let injected=false;
    await assert.rejects(
      migrateCli({
        argv:[
          'apply','--database',pathToFileURL(target).href,
          '--expected-state',expectedStateFingerprint,
        ],
        stdout:{write(){}},
        createDatabaseClient:config=>{
          if(!injected&&config.url==='file::memory:'){
            injected=true;
            symlinkSync(victim,target);
          }
          return createClient(config);
        },
      }),
      error=>error?.code==='DB_MIGRATE_TARGET',
    );
    const victimDb=createClient({url:pathToFileURL(victim).href});
    try{ assert.deepEqual((await snapshot(victimDb)).objects,[]); }
    finally{ victimDb.close(); }
  }finally{
    rmSync(directory,{recursive:true,force:true});
  }
});

test('an opened target replacement is detected without redirecting migration writes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migration-replacement-'));
  const target=join(directory,'database.sqlite');
  const displaced=join(directory,'reserved.sqlite');
  const victim=join(directory,'victim.sqlite');
  writeFileSync(victim,'');
  try{
    const expectedStateFingerprint=await freshFingerprint();
    await assert.rejects(
      migrateCli({
        argv:[
          'apply','--database',pathToFileURL(target).href,
          '--expected-state',expectedStateFingerprint,
        ],
        stdout:{write(){}},
        apply:async(client,options)=>{
          renameSync(target,displaced);
          symlinkSync(victim,target);
          assert.equal(lstatSync(target).isSymbolicLink(),true);
          const result=await applyMigrations(client,{...options,retry:NO_RETRY});
          assert.equal(lstatSync(target).isSymbolicLink(),true);
          return result;
        },
      }),
      error=>error?.code==='DB_MIGRATE_TARGET',
    );
    const victimDb=createClient({url:pathToFileURL(victim).href});
    try{ assert.deepEqual((await snapshot(victimDb)).objects,[]); }
    finally{ victimDb.close(); }
  }finally{
    rmSync(directory,{recursive:true,force:true});
  }
});
