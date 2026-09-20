import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V15=EXECUTABLE_MIGRATIONS.slice(0,15);
const THROUGH_V16=EXECUTABLE_MIGRATIONS.slice(0,16);
const V16=EXECUTABLE_MIGRATIONS[15];
const CYCLE_A='a'.repeat(64);
const CYCLE_B='b'.repeat(64);
const NOW='2026-09-19T12:00:00.000Z';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-secondary-schedule-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedPairing(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),
    (2,'two@example.test','hash','Two','#222222',0),
    (3,'three@example.test','hash','Three','#333333',0)`);
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
    (20,'circle-twenty','twenty','Twenty',0,1),(21,'circle-twenty-one','twenty-one','Twenty one',0,3)`);
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
    (20,1,'owner','active'),(20,2,'member','active'),(21,3,'owner','active')`);
  await db.execute({sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
    VALUES ('circle:20',20,?,'2026-W38','2026-09-13T07:00:00.000Z','2026-09-20T07:00:00.000Z',
      '2026-09-13T07:00:00.000Z','Europe/London','cycle_default'),
      ('circle:21',21,?,'2026-W38','2026-09-13T07:00:00.000Z','2026-09-20T07:00:00.000Z',
      '2026-09-13T07:00:00.000Z','Europe/London','cycle_default')`,args:[CYCLE_A,CYCLE_B]});
  const publications=[];
  for(const [circleId,cycleKey,token] of [[20,CYCLE_A,'11111111-1111-4111-8111-111111111111'],[21,CYCLE_B,'22222222-2222-4222-8222-222222222222']]){
    const publication=await db.execute({sql:`INSERT INTO circle_pairing_publications
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
       generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,args:[`circle:${circleId}`,circleId,cycleKey,'2026-W38',
      '2026-09-13T07:00:00.000Z','2026-09-20T07:00:00.000Z','2026-09-13T07:00:00.000Z',
      'Europe/London',token,'fair-seeded-v1',`circle:${circleId}:${cycleKey}:weekly`,circleId===20?2:1]});
    publications.push(Number(publication.rows[0].id));
  }
  await db.execute({sql:`INSERT INTO circle_pairing_eligibility
    (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
     availability_source,position,group_position,group_size,member_position)
    VALUES (?,?,?,?,1,1,0,'cycle_default',0,0,2,0),(?,?,?,?,2,1,0,'cycle_default',1,0,2,1),
      (?,?,?,?,3,1,0,'cycle_default',0,0,1,0)`,args:[
    publications[0],'circle:20',20,CYCLE_A,publications[0],'circle:20',20,CYCLE_A,
    publications[1],'circle:21',21,CYCLE_B,
  ]});
  const paired=await db.execute({sql:`INSERT INTO circle_pairing_groups
    (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,
     user_b_id,user_b_available,user_b_member_position,is_solo)
    VALUES (?,'circle:20',20,?,0,2,1,2,1,1,0) RETURNING id`,args:[publications[0],CYCLE_A]});
  const solo=await db.execute({sql:`INSERT INTO circle_pairing_groups
    (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,user_b_id,is_solo)
    VALUES (?,'circle:21',21,?,0,1,3,NULL,1) RETURNING id`,args:[publications[1],CYCLE_B]});
  return {publicationA:publications[0],publicationB:publications[1],groupA:Number(paired.rows[0].id),groupB:Number(solo.rows[0].id)};
}

function scheduleArgs(pairing,{scope='circle:20',circle=20,cycle=CYCLE_A,memberCount=2,userA=1,userB=2,solo=0}={}){
  return ['c'.repeat(64),pairing.publicationA,scope,circle,cycle,pairing.groupA,
    memberCount,userA,userB,solo,1,null,NOW,NOW];
}

test('v16 installs only the exact secondary scheduling ownership schema',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db,THROUGH_V16);
    assert.equal(result.toVersion,16);
    assert.deepEqual(V16.operations.map(operation=>operation.name),[
      'uq_circle_pairing_groups_schedule_owner','circle_pair_schedules',
      'circle_pair_schedule_proposals','idx_circle_pair_schedule_proposals_schedule',
    ]);
    const scheduleForeignKeys=await item.db.execute(`PRAGMA foreign_key_list('circle_pair_schedules')`);
    assert.deepEqual(new Set(scheduleForeignKeys.rows.map(row=>String(row.table))),
      new Set(['circle_pairing_publications','circle_pairing_groups']));
    const proposalForeignKeys=await item.db.execute(`PRAGMA foreign_key_list('circle_pair_schedule_proposals')`);
    assert.deepEqual(new Set(proposalForeignKeys.rows.map(row=>String(row.table))),
      new Set(['circle_pair_schedules','circle_pairing_publications','circle_pairing_groups','auth_accounts']));
  }finally{ item.close(); }
});

test('managed v15 upgrades exactly once to v16',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V15);
    const before=await inspectMigrationState(item.db,{migrations:THROUGH_V16});
    assert.equal(before.currentVersion,15);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,migrations:THROUGH_V16,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[16]);
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
  }finally{ item.close(); }
});

test('v16 accepts one normalized paired schedule and rejects forged ownership or proposers',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    const pairing=await seedPairing(item.db);
    const schedule=await item.db.execute({sql:`INSERT INTO circle_pair_schedules
      (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
       user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,args:scheduleArgs(pairing)});
    const scheduleId=Number(schedule.rows[0].id);
    await item.db.execute({sql:`INSERT INTO circle_pair_schedule_proposals
      (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
       member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[scheduleId,'c'.repeat(64),pairing.publicationA,
      'circle:20',20,CYCLE_A,pairing.groupA,2,1,2,0,'d'.repeat(64),'2026-09-20T08:00:00.000Z',1,NOW]});
    for(const operation of [
      ()=>item.db.execute({sql:`INSERT INTO circle_pair_schedules
        (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
         user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:scheduleArgs(pairing,{scope:'circle:21',circle:21,cycle:CYCLE_B})}),
      ()=>item.db.execute({sql:`INSERT INTO circle_pair_schedules
        (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
         user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:['e'.repeat(64),pairing.publicationB,'circle:21',21,CYCLE_B,
        pairing.groupB,1,3,3,1,1,null,NOW,NOW]}),
      ()=>item.db.execute({sql:`INSERT INTO circle_pair_schedule_proposals
        (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
         member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[scheduleId,'c'.repeat(64),pairing.publicationA,
        'circle:20',20,CYCLE_A,pairing.groupA,2,1,2,0,'e'.repeat(64),'2026-09-20T09:00:00.000Z',3,NOW]}),
      ()=>item.db.execute({sql:`UPDATE circle_pair_schedule_proposals SET circle_id=21 WHERE schedule_id=?`,args:[scheduleId]}),
      ()=>item.db.execute({sql:`DELETE FROM circle_pairing_groups WHERE id=?`,args:[pairing.groupA]}),
      ()=>item.db.execute({sql:`DELETE FROM circle_pair_schedules WHERE id=?`,args:[scheduleId]}),
    ]) await assert.rejects(operation,error=>String(error?.code||'').startsWith('SQLITE_CONSTRAINT'));
  }finally{ item.close(); }
});

test('v16 enforces one schedule per exact group and normalized unique proposal instants',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    const pairing=await seedPairing(item.db);
    const inserted=await item.db.execute({sql:`INSERT INTO circle_pair_schedules
      (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
       user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,args:scheduleArgs(pairing)});
    const scheduleId=Number(inserted.rows[0].id);
    await assert.rejects(()=>item.db.execute({sql:`INSERT INTO circle_pair_schedules
      (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
       user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:['e'.repeat(64),...scheduleArgs(pairing).slice(1)]}),/constraint/i);
    const proposalArgs=[scheduleId,'c'.repeat(64),pairing.publicationA,'circle:20',20,CYCLE_A,
      pairing.groupA,2,1,2,0,'d'.repeat(64),'2026-09-20T08:00:00.000Z',1,NOW];
    await item.db.execute({sql:`INSERT INTO circle_pair_schedule_proposals
      (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
       member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:proposalArgs});
    await assert.rejects(()=>item.db.execute({sql:`INSERT INTO circle_pair_schedule_proposals
      (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
       member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:[...proposalArgs.slice(0,11),'e'.repeat(64),
      '2026-09-20T08:00:00.000Z',2,NOW]}),/constraint/i);
  }finally{ item.close(); }
});
