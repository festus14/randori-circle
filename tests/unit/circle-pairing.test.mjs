import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import {
  CirclePairingError,
  ensureCirclePairingReadiness,
  listSecondaryPairingScopes,
  publishCirclePairing,
  readCirclePairing,
  SECONDARY_PAIRING_CRON_LIMIT,
} from '../../api/_circle-pairing.js';
import { availabilityCycleKey } from '../../api/_availability.js';
import { buildFairPairing, pairKey } from '../../api/_pairing.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NOW=new Date('2026-09-20T08:15:00.000Z');
const SESSION_HASH='a'.repeat(64);
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-pairing-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  let db=createClient({url});
  return {
    get db(){ return db; },
    reopen(){ db.close(); db=createClient({url}); return db; },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function prepare(db){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
}

async function seedAccount(db,id,{demo=0}={}){
  await db.execute({
    sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
      VALUES (?,?,?,?,?,?,0)`,
    args:[id,`member-${id}@example.test`,'hash',`Member ${id}`,id%2?'#123456':'#654321',demo],
  });
}

async function seedCircle(db,{circleId=20,userIds=[1,2,3],ownerId=1,contextVersion=7,sessionHash=SESSION_HASH}={}){
  for(const userId of userIds) await seedAccount(db,userId);
  await db.execute({
    sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (?,?,?,?,0,?)`,args:[circleId,`circle-${circleId}`,`circle-${circleId}`,`Circle ${circleId}`,ownerId],
  });
  for(const userId of userIds){
    await db.execute({
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
        VALUES (?,?,?,'active')`,args:[circleId,userId,userId===ownerId?'owner':'member'],
    });
  }
  await db.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,?,1,4000000000)`,args:[sessionHash,ownerId],
  });
  await db.execute({
    sql:`INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,?,?,1)`,
    args:[sessionHash,ownerId,circleId,contextVersion],
  });
  return {
    kind:'session',payload:{id:ownerId,sessionHash},userId:ownerId,circleId,
    contextVersion,implicit:false,requireOwner:true,
  };
}

async function seedCurrentDecision(db,{circleId,userId,isAvailable,version=1}){
  const scope={kind:'circle',scopeKey:`circle:${circleId}`,circleId};
  const cycle=resolvePairingCycle({now:NOW,state:'current'});
  const cycleKey=availabilityCycleKey(scope,cycle);
  await db.execute({
    sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,?,?,?,?,?, 'cycle_default') ON CONFLICT(scope_key,cycle_key) DO NOTHING`,
    args:[scope.scopeKey,circleId,cycleKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone],
  });
  await db.execute({
    sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES (?,?,?,?,?,'user')`,args:[scope.scopeKey,cycleKey,userId,isAvailable?1:0,version],
  });
  return cycleKey;
}

test('secondary publication snapshots all members, ignores the legacy flag, and is immutable',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db);
    await seedCurrentDecision(item.db,{circleId:20,userId:2,isAvailable:false,version:4});
    const first=await publishCirclePairing(item.db,{authority,now:NOW});
    const second=await publishCirclePairing(item.db,{authority,now:NOW});
    assert.equal(first.created,true);
    assert.equal(second.created,false);
    assert.equal(first.publication.id,second.publication.id);
    assert.equal(first.publication.participantCount,3);
    assert.deepEqual(first.publication.eligibility.map(item=>[
      item.userId,item.isAvailable,item.availabilityVersion,item.availabilitySource,
    ]),[
      [1,true,0,'cycle_default'],[2,false,4,'user'],[3,true,0,'cycle_default'],
    ]);
    assert.equal(first.publication.groups.length,1);
    assert.equal(first.publication.groups[0].isSolo,false);
    assert.deepEqual(new Set([
      first.publication.groups[0].userAId,first.publication.groups[0].userBId,
    ]),new Set([1,3]));
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM pairing_weeks`)).rows[0].count),0);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM outbox_events`)).rows[0].count),0);
    assert.match(first.publication.algorithm.seed,/^circle:20:[a-f0-9]{64}:weekly$/);
  }finally{ item.close(); }
});

test('secondary readiness rechecks connection, ledger, and exact v13 structure without caching',async t=>{
  async function readyFixture(){
    const item=fixture();
    await prepare(item.db);
    assert.equal(await ensureCirclePairingReadiness(item.db),true);
    return item;
  }
  const unavailable=error=>error instanceof CirclePairingError
    &&error.code==='CIRCLE_PAIRING_SCHEMA_UNAVAILABLE';
  await t.test('foreign keys disabled',async()=>{
    const item=await readyFixture();
    try{
      await item.db.execute('PRAGMA foreign_keys=OFF');
      await assert.rejects(ensureCirclePairingReadiness(item.db),unavailable);
    }finally{ item.close(); }
  });
  await t.test('check constraints disabled',async()=>{
    const item=await readyFixture();
    try{
      await item.db.execute('PRAGMA ignore_check_constraints=ON');
      await assert.rejects(ensureCirclePairingReadiness(item.db),unavailable);
    }finally{ item.close(); }
  });
  await t.test('v13 ledger checksum changed',async()=>{
    const item=await readyFixture();
    try{
      await item.db.execute({
        sql:`UPDATE schema_migrations SET checksum=? WHERE version=13`,args:['f'.repeat(64)],
      });
      await assert.rejects(ensureCirclePairingReadiness(item.db),unavailable);
    }finally{ item.close(); }
  });
  await t.test('descriptor unique index removed',async()=>{
    const item=await readyFixture();
    try{
      await item.db.execute('DROP INDEX uq_pairing_cycles_descriptor');
      await assert.rejects(ensureCirclePairingReadiness(item.db),unavailable);
    }finally{ item.close(); }
  });
  await t.test('v13 check changed',async()=>{
    const item=await readyFixture();
    try{
      const result=await item.db.execute(`SELECT sql FROM sqlite_schema
        WHERE type='table' AND name='circle_pairing_eligibility'`);
      const sql=String(result.rows[0].sql);
      const weakened=sql.replace("CHECK(scope_key=('circle:'||circle_id))","CHECK(length(scope_key)>0)");
      assert.notEqual(weakened,sql);
      await item.db.execute('PRAGMA writable_schema=ON');
      await item.db.execute({sql:`UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='circle_pairing_eligibility'`,args:[weakened]});
      await item.db.execute('PRAGMA writable_schema=OFF');
      await assert.rejects(ensureCirclePairingReadiness(item.db),unavailable);
    }finally{ item.close(); }
  });
  await t.test('v13 descriptor foreign key changed',async()=>{
    const item=await readyFixture();
    try{
      const result=await item.db.execute(`SELECT sql FROM sqlite_schema
        WHERE type='table' AND name='circle_pairing_publications'`);
      const sql=String(result.rows[0].sql);
      const exact="FOREIGN KEY(scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone) REFERENCES pairing_cycles(scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone) ON DELETE RESTRICT";
      const weakened="FOREIGN KEY(scope_key,cycle_key) REFERENCES pairing_cycles(scope_key,cycle_key) ON DELETE RESTRICT";
      const changed=sql.replace(exact,weakened);
      assert.notEqual(changed,sql);
      await item.db.execute('PRAGMA writable_schema=ON');
      await item.db.execute({sql:`UPDATE sqlite_schema SET sql=? WHERE type='table' AND name='circle_pairing_publications'`,args:[changed]});
      await item.db.execute('PRAGMA writable_schema=OFF');
      const reopened=item.reopen();
      await prepareMigrationConnection(reopened);
      await assert.rejects(ensureCirclePairingReadiness(reopened),unavailable);
    }finally{ item.close(); }
  });
});

test('an all-unavailable circle publishes a complete zero-group snapshot',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2]});
    await seedCurrentDecision(item.db,{circleId:20,userId:1,isAvailable:false});
    await seedCurrentDecision(item.db,{circleId:20,userId:2,isAvailable:false});
    const result=await publishCirclePairing(item.db,{authority,now:NOW});
    assert.equal(result.created,true);
    assert.equal(result.publication.participantCount,2);
    assert.equal(result.publication.eligibility.every(item=>!item.isAvailable),true);
    assert.deepEqual(result.publication.groups,[]);
  }finally{ item.close(); }
});

test('an odd available roster stores solo practice without a fabricated partner',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1]});
    const result=await publishCirclePairing(item.db,{authority,now:NOW});
    assert.equal(result.publication.groups.length,1);
    assert.deepEqual(result.publication.groups.map(group=>({
      userAId:group.userAId,userBId:group.userBId,isSolo:group.isSolo,
    })),[{userAId:1,userBId:null,isSolo:true}]);
    const stored=await item.db.execute(`SELECT user_a_id,user_b_id,is_solo FROM circle_pairing_groups`);
    assert.deepEqual(stored.rows.map(row=>[Number(row.user_a_id),row.user_b_id,Number(row.is_solo)]),[[1,null,1]]);
  }finally{ item.close(); }
});

test('stale context and demotion produce no publication writes',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db);
    await assert.rejects(
      publishCirclePairing(item.db,{authority:{...authority,contextVersion:6},now:NOW}),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_CONTEXT_CHANGED',
    );
    await item.db.execute(`UPDATE circle_memberships SET role='member' WHERE circle_id=20 AND user_id=1`);
    await assert.rejects(
      publishCirclePairing(item.db,{authority,now:NOW}),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_OWNER_REQUIRED',
    );
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('different circles publish the same ISO cycle independently and history remains scoped',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    await seedCircle(item.db,{circleId:20,userIds:[1,2],ownerId:1,contextVersion:7,sessionHash:'a'.repeat(64)});
    await seedAccount(item.db,3);
    await seedAccount(item.db,4);
    await item.db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (30,'circle-30','circle-30','Circle 30',0,3)`);
    await item.db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (30,3,'owner','active'),(30,4,'member','active')`);
    const first=await publishCirclePairing(item.db,{authority:{kind:'system',circleId:20},now:NOW});
    const second=await publishCirclePairing(item.db,{authority:{kind:'system',circleId:30},now:NOW});
    assert.equal(first.publication.cycle.cycleId,second.publication.cycle.cycleId);
    assert.notEqual(first.publication.id,second.publication.id);
    assert.notEqual(first.publication.algorithm.seed,second.publication.algorithm.seed);
    const rows=await item.db.execute(`SELECT scope_key,COUNT(*) AS count
      FROM circle_pairing_publications GROUP BY scope_key ORDER BY scope_key`);
    assert.deepEqual(rows.rows.map(row=>[String(row.scope_key),Number(row.count)]),[
      ['circle:20',1],['circle:30',1],
    ]);
  }finally{ item.close(); }
});

test('future canonical publications cannot influence an earlier cycle fairness history',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2,3,4,5,6]});
    const futureNow=new Date('2026-10-18T08:15:00.000Z');
    const future=await publishCirclePairing(item.db,{authority,now:futureNow});
    assert.equal(future.publication.cycle.cycleId,'2026-W43');
    const earlier=await publishCirclePairing(item.db,{authority,now:NOW});
    const scope={kind:'circle',scopeKey:'circle:20',circleId:20};
    const cycle=resolvePairingCycle({now:NOW,state:'current'});
    const cycleKey=availabilityCycleKey(scope,cycle);
    const expected=buildFairPairing([1,2,3,4,5,6].map(id=>({id,source:'auth'})),[],{
      seed:`circle:20:${cycleKey}:weekly`,
    }).pairs.map(pair=>pairKey(pair.a.id,pair.b.id)).sort();
    assert.deepEqual(earlier.publication.groups
      .map(group=>pairKey(group.userAId,group.userBId)).sort(),expected);
  }finally{ item.close(); }
});

test('read authorization redacts a departed partner and never yields a workspace capability',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2]});
    await publishCirclePairing(item.db,{authority,now:NOW});
    let read=await readCirclePairing(item.db,{authority,now:NOW});
    assert.equal(read.accounts.size,2);
    await item.db.execute(`UPDATE circle_memberships SET status='inactive'
      WHERE circle_id=20 AND user_id=2`);
    read=await readCirclePairing(item.db,{authority,now:NOW});
    assert.equal(read.accounts.has(2),false);
    assert.equal(read.publication.groups.length,1);
  }finally{ item.close(); }
});

test('cron scope enumeration is deterministic and rejects overflow before publication',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    for(let circleId=1;circleId<=SECONDARY_PAIRING_CRON_LIMIT+1;circleId+=1){
      await seedAccount(item.db,circleId);
      await item.db.execute({
        sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (?,?,?,?,0,?)`,
        args:[circleId,`public-${circleId}`,`slug-${circleId}`,`Circle ${circleId}`,circleId],
      });
      await item.db.execute({
        sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,?,'owner','active')`,
        args:[circleId,circleId],
      });
    }
    await assert.rejects(
      listSecondaryPairingScopes(item.db),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_BATCH_OVERFLOW',
    );
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),0);
    await item.db.execute({sql:`UPDATE circles SET archived_at=datetime('now') WHERE id=?`,args:[SECONDARY_PAIRING_CRON_LIMIT+1]});
    assert.deepEqual(await listSecondaryPairingScopes(item.db),Array.from({length:SECONDARY_PAIRING_CRON_LIMIT},(_,index)=>index+1));
  }finally{ item.close(); }
});

test('concurrent owner and cron publication converge on one immutable claim',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-pairing-race-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const setup=createClient({url});
  const ownerClient=createClient({url});
  const cronClient=createClient({url});
  try{
    await prepare(setup);
    const authority=await seedCircle(setup,{userIds:[1,2,3,4]});
    await Promise.all([prepareMigrationConnection(ownerClient),prepareMigrationConnection(cronClient)]);
    const results=await Promise.all([
      publishCirclePairing(ownerClient,{authority,now:NOW}),
      publishCirclePairing(cronClient,{authority:{kind:'system',circleId:20},now:NOW}),
    ]);
    assert.equal(results.filter(result=>result.created).length,1);
    assert.equal(results[0].publication.id,results[1].publication.id);
    assert.deepEqual(results[0].publication.groups,results[1].publication.groups);
    assert.equal(Number((await setup.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),1);
  }finally{
    setup.close(); ownerClient.close(); cronClient.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('concurrent owners converge on the same immutable publication',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-pairing-owner-race-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const setup=createClient({url});
  const firstClient=createClient({url});
  const secondClient=createClient({url});
  try{
    await prepare(setup);
    const firstAuthority=await seedCircle(setup,{userIds:[1,2,3,4]});
    await setup.execute(`UPDATE circle_memberships SET role='owner' WHERE circle_id=20 AND user_id=2`);
    const secondHash='b'.repeat(64);
    await setup.execute({
      sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,2,1,4000000000)`,
      args:[secondHash],
    });
    await setup.execute({
      sql:`INSERT INTO auth_session_circle_contexts
        (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,2,20,4,1)`,
      args:[secondHash],
    });
    const secondAuthority={kind:'session',payload:{id:2,sessionHash:secondHash},userId:2,
      circleId:20,contextVersion:4,implicit:false,requireOwner:true};
    await Promise.all([prepareMigrationConnection(firstClient),prepareMigrationConnection(secondClient)]);
    const results=await Promise.all([
      publishCirclePairing(firstClient,{authority:firstAuthority,now:NOW}),
      publishCirclePairing(secondClient,{authority:secondAuthority,now:NOW}),
    ]);
    assert.equal(results.filter(result=>result.created).length,1);
    assert.equal(results[0].publication.id,results[1].publication.id);
    assert.deepEqual(results[0].publication.groups,results[1].publication.groups);
  }finally{
    setup.close(); firstClient.close(); secondClient.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('a pre-commit busy retry re-resolves database time and the current cycle',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2]});
    let transactions=0;
    let clockReads=0;
    let injected=false;
    const instants=[new Date('2026-09-20T06:59:59.000Z'),new Date('2026-09-20T07:00:01.000Z')];
    const wrapper={
      execute:statement=>item.db.execute(statement),
      batch:(statements,mode)=>item.db.batch(statements,mode),
      async transaction(mode){
        transactions+=1;
        const tx=await item.db.transaction(mode);
        return {
          async execute(statement){
            const sql=typeof statement==='string'?statement:String(statement?.sql||'');
            if(!injected&&sql.includes('INSERT INTO circle_pairing_publications')){
              injected=true;
              throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
            }
            return tx.execute(statement);
          },
          batch:(statements,batchMode)=>tx.batch(statements,batchMode),
          commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close?.(),
        };
      },
    };
    const result=await publishCirclePairing(wrapper,{
      authority,now:()=>instants[Math.min(clockReads++,instants.length-1)],
    });
    assert.equal(transactions,2);
    assert.equal(clockReads,2);
    assert.equal(result.publication.cycle.cycleId,'2026-W39');
    const cycles=await item.db.execute(`SELECT cycle_id FROM pairing_cycles ORDER BY cycle_id`);
    assert.deepEqual(cycles.rows.map(row=>String(row.cycle_id)),['2026-W39']);
  }finally{ item.close(); }
});

test('a pre-commit retry revalidates a revoked selected session before any publication write',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2]});
    let transactions=0;
    let injected=false;
    const wrapper={
      execute:statement=>item.db.execute(statement),
      batch:(statements,mode)=>item.db.batch(statements,mode),
      async transaction(mode){
        transactions+=1;
        const tx=await item.db.transaction(mode);
        return {
          async execute(statement){
            const sql=typeof statement==='string'?statement:String(statement?.sql||'');
            if(!injected&&sql.includes('INSERT INTO circle_pairing_publications')){
              injected=true;
              throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
            }
            return tx.execute(statement);
          },
          batch:(statements,batchMode)=>tx.batch(statements,batchMode),
          commit:()=>tx.commit(),
          async rollback(){
            await tx.rollback();
            if(transactions===1){
              await item.db.execute({
                sql:`UPDATE auth_sessions SET revoked_at=1,revocation_reason='current_logout' WHERE session_hash=?`,
                args:[SESSION_HASH],
              });
            }
          },
          close:()=>tx.close?.(),
        };
      },
    };
    await assert.rejects(
      publishCirclePairing(wrapper,{authority,now:NOW}),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_CONTEXT_CHANGED',
    );
    assert.equal(transactions,2);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('cron revalidates an owner removed after deterministic enumeration',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    await seedCircle(item.db,{userIds:[1,2]});
    assert.deepEqual(await listSecondaryPairingScopes(item.db),[20]);
    await item.db.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND role='owner'`);
    await assert.rejects(
      publishCirclePairing(item.db,{authority:{kind:'system',circleId:20},now:NOW}),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_FORBIDDEN',
    );
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),0);
  }finally{ item.close(); }
});

test('an ambiguous commit is never retried and a later call reads the committed publication',async()=>{
  const item=fixture();
  try{
    await prepare(item.db);
    const authority=await seedCircle(item.db,{userIds:[1,2]});
    let transactionCount=0;
    const ambiguous={
      execute:statement=>item.db.execute(statement),
      batch:(statements,mode)=>item.db.batch(statements,mode),
      async transaction(mode){
        transactionCount+=1;
        const tx=await item.db.transaction(mode);
        return {
          execute:statement=>tx.execute(statement),batch:(statements,batchMode)=>tx.batch(statements,batchMode),
          async commit(){ await tx.commit(); throw new Error('ambiguous transport after commit'); },
          rollback:()=>tx.rollback(),close:()=>tx.close(),
        };
      },
    };
    await assert.rejects(
      publishCirclePairing(ambiguous,{authority,now:NOW}),
      error=>error instanceof CirclePairingError&&error.code==='CIRCLE_PAIRING_UNAVAILABLE',
    );
    assert.equal(transactionCount,1);
    const retried=await publishCirclePairing(item.db,{authority,now:NOW});
    assert.equal(retried.created,false);
    assert.equal(Number((await item.db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count),1);
  }finally{ item.close(); }
});
