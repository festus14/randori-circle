// Fail-closed and conflict branches of api/_secondary-schedule.js on a real,
// fully migrated SQLite database: strict input/authority contracts, schema
// readiness caching, stored-row integrity, CAS write anomalies, retry policy,
// and HTTP failure mapping.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabaseSync, migratedTemplatePath } from '../support/migrated-db.mjs';
import {
  ensureSecondaryScheduleReadiness,
  mutateSecondarySchedule,
  parseSecondaryScheduleMutation,
  readSecondarySchedule,
  SecondaryScheduleError,
  secondaryScheduleFailure,
  secondaryScheduleIdentity,
} from '../../api/_secondary-schedule.js';
import { ScheduleInputError, ScheduleTemporalError } from '../../api/_schedule.js';

const SESSION_HASH='f'.repeat(64);
const PARTNER_SESSION_HASH='e'.repeat(64);
const CYCLE='a'.repeat(64);
const GENERATION='11111111-1111-4111-8111-111111111111';
const FLAGS=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_SCHEDULING_ENABLED','SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED'];
const cleanup=[];

beforeEach(()=>{ for(const key of [...FLAGS,'TURSO_DATABASE_URL']) delete process.env[key]; });
afterEach(()=>{
  for(const key of [...FLAGS,'TURSO_DATABASE_URL']) delete process.env[key];
  while(cleanup.length){ try{ cleanup.pop()(); }catch{} }
});

function fixture({migrated=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-secondary-schedule-'));
  if(migrated) copyMigratedDatabaseSync(join(directory,'test.sqlite'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  cleanup.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function migrated({seeded=true}={}){
  await migratedTemplatePath();
  const db=fixture({migrated:true});
  await prepareMigrationConnection(db);
  if(!seeded) return db;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0)`);
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (20,'circle-twenty','twenty','Twenty',0,1)`);
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (20,1,'owner','active'),(20,2,'member','active')`);
  await db.execute({sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,1,1,4102444800),(?,2,1,4102444800)`,
    args:[SESSION_HASH,PARTNER_SESSION_HASH]});
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,1,20,7,1),(?,2,20,7,1)`,args:[SESSION_HASH,PARTNER_SESSION_HASH]});
  await db.execute({sql:`INSERT INTO pairing_cycles
    (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
    VALUES ('circle:20',20,?,'2026-W38','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z','Europe/London','cycle_default')`,args:[CYCLE]});
  const publication=await db.execute({sql:`INSERT INTO circle_pairing_publications
    (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
     generation_token,algorithm_version,algorithm_seed,participant_count)
    VALUES ('circle:20',20,?,'2026-W38','2000-01-01T00:00:00.000Z','2999-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z','Europe/London',?,'fair-seeded-v1',?,2) RETURNING id`,
  args:[CYCLE,GENERATION,`circle:20:${CYCLE}:weekly`]});
  const publicationId=Number(publication.rows[0].id);
  await db.execute({sql:`INSERT INTO circle_pairing_eligibility
    (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
     availability_source,position,group_position,group_size,member_position)
    VALUES (?,'circle:20',20,?,1,1,0,'cycle_default',0,0,2,0),(?,'circle:20',20,?,2,1,0,'cycle_default',1,0,2,1)`,
  args:[publicationId,CYCLE,publicationId,CYCLE]});
  await db.execute({sql:`INSERT INTO circle_pairing_groups
    (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,user_b_id,user_b_available,user_b_member_position,is_solo)
    VALUES (?,'circle:20',20,?,0,2,1,2,1,1,0)`,args:[publicationId,CYCLE]});
  return db;
}

function authority(userId=1,{contextVersion=7,sessionHash=userId===1?SESSION_HASH:PARTNER_SESSION_HASH}={}){
  return {kind:'session',payload:{id:userId,sessionHash},userId,circleId:20,contextVersion,implicit:false};
}

const sqlOf=statement=>typeof statement==='string'?statement:String(statement?.sql||'');

// Lets a test intercept statements, batches, commits, and transaction creation.
function intercepting(db,{execute,batch,commit,transaction,close}={}){
  return {
    execute:statement=>db.execute(statement),
    batch:(statements,mode)=>db.batch(statements,mode),
    async transaction(mode){
      if(transaction){ const replaced=await transaction(mode); if(replaced!==undefined) return replaced; }
      const tx=await db.transaction(mode);
      return {
        async execute(statement){
          if(execute){ const replaced=await execute(sqlOf(statement),statement,tx); if(replaced!==undefined) return replaced; }
          return tx.execute(statement);
        },
        async batch(statements,batchMode){
          if(batch){ const replaced=await batch(statements,tx); if(replaced!==undefined) return replaced; }
          return tx.batch(statements,batchMode);
        },
        async commit(){ if(commit) await commit(tx); return tx.commit(); },
        rollback:()=>tx.rollback(),
        close(){ if(close) close(); return tx.close(); },
      };
    },
  };
}

function code(expected){
  return error=>error instanceof SecondaryScheduleError&&error.code===expected;
}

async function propose(db,instant,who=1){
  const current=await readSecondarySchedule(db,{authority:authority(who)});
  return mutateSecondarySchedule(db,{authority:authority(who),mutation:{action:'propose',baseVersion:current.schedule.version,instant}});
}

test('identity and mutation parsing reject malformed inputs',()=>{
  for(const input of [undefined,{generationToken:'not-a-uuid',groupId:1},{generationToken:GENERATION,groupId:0},
    {generationToken:GENERATION.replace('-4111','-1111'),groupId:1},{generationToken:42,groupId:1}]){
    assert.throws(()=>secondaryScheduleIdentity(input),TypeError);
  }
  const version='0'.repeat(64);
  for(const body of [null,[],'clear',{action:'rename',base_version:version},{action:'clear'},
    {action:'clear',base_version:'A'.repeat(64)},{action:'clear',base_version:7},
    {action:'propose',base_version:version,instant:'2098-09-20 09:00'},
    {action:'remove',base_version:version,proposal_id:42}]){
    assert.throws(()=>parseSecondaryScheduleMutation(body),ScheduleInputError);
  }
  assert.deepEqual(parseSecondaryScheduleMutation({action:'remove',base_version:version,proposal_id:'1'.repeat(64)}),
    {action:'remove',baseVersion:version,proposalId:'1'.repeat(64)});
});

test('failure mapping exposes only stable public codes',()=>{
  const ctx={contextVersion:7};
  assert.deepEqual(secondaryScheduleFailure(new ScheduleTemporalError('accept'),ctx),{status:400,body:{
    ok:false,error:'That proposal has elapsed. Remove it or choose a future time.',code:'schedule_instant_elapsed',circle_context_version:7}});
  assert.deepEqual(secondaryScheduleFailure(new ScheduleInputError('proposal not found')),{status:400,body:{ok:false,error:'proposal not found'}});
  assert.deepEqual(secondaryScheduleFailure(new SecondaryScheduleError('SECONDARY_SCHEDULE_CONTEXT_CHANGED','x'),ctx),
    {status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'}});
  assert.deepEqual(secondaryScheduleFailure(new SecondaryScheduleError('SECONDARY_SCHEDULE_PAIR_UNAVAILABLE','x'),ctx),
    {status:404,body:{ok:false,error:'current paired assignment unavailable',circle_context_version:7}});
  assert.deepEqual(secondaryScheduleFailure(new SecondaryScheduleError('SECONDARY_SCHEDULE_INTEGRITY','x')),
    {status:503,body:{ok:false,error:'schedule unavailable'}});
  assert.deepEqual(secondaryScheduleFailure(new Error('SQLITE internal /path'),ctx),
    {status:503,body:{ok:false,error:'schedule unavailable',circle_context_version:7}});
});

test('schema readiness fails closed, clears its cache on failure, and shares a URL-scoped cache',async()=>{
  await assert.rejects(ensureSecondaryScheduleReadiness(null),code('SECONDARY_SCHEDULE_INPUT_INVALID'));
  const empty=fixture();
  await assert.rejects(ensureSecondaryScheduleReadiness(empty),code('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'));
  await assert.rejects(ensureSecondaryScheduleReadiness({execute:async()=>{ throw new Error('network'); }}),error=>
    code('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE')(error)&&error.cause instanceof Error);

  const db=await migrated({seeded:false});
  // A ledger missing its latest two migrations is not ready even though
  // the schema matches. Missing only the latest (additive) row is the
  // ready pending-additive state (ID-87).
  const latest=await db.execute(`SELECT MAX(version) AS v FROM schema_migrations`);
  const lagging={execute:async statement=>{
    const sql=sqlOf(statement);
    if(/FROM schema_migrations/i.test(sql)&&!/sqlite_master|pragma/i.test(sql)){
      const result=await db.execute(statement);
      return {...result,rows:result.rows.filter(row=>Number(row.version)<=Number(latest.rows[0].v)-2)};
    }
    return db.execute(statement);
  }};
  await assert.rejects(ensureSecondaryScheduleReadiness(lagging),code('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'));

  let reads=0;
  const counted={execute:async statement=>{ reads+=1; return db.execute(statement); }};
  assert.equal(await ensureSecondaryScheduleReadiness(counted),true);
  assert.ok(reads>0);

  // With a configured database URL, readiness is cached per URL across client objects.
  process.env.TURSO_DATABASE_URL=`libsql://cov-p2-secondary-${process.pid}-${Date.now()}.example`;
  assert.equal(await ensureSecondaryScheduleReadiness(counted),true);
  let unexpected=0;
  const other={execute:async()=>{ unexpected+=1; throw new Error('should not be probed'); }};
  assert.equal(await ensureSecondaryScheduleReadiness(other),true);
  assert.equal(unexpected,0);
});

test('authority and context are validated before any schedule data is read',async()=>{
  const db=await migrated();
  await assert.rejects(readSecondarySchedule({execute(){}},{authority:authority()}),code('SECONDARY_SCHEDULE_INPUT_INVALID'));
  await assert.rejects(mutateSecondarySchedule({},{authority:authority(),mutation:{}}),code('SECONDARY_SCHEDULE_INPUT_INVALID'));
  for(const bad of [undefined,{...authority(),kind:'service'},{...authority(),payload:null},{...authority(),userId:0},
    {...authority(),circleId:'x'},{...authority(),contextVersion:-1},{...authority(),contextVersion:1.5},
    {...authority(),implicit:'false'}]){
    await assert.rejects(readSecondarySchedule(db,{authority:bad}),code('SECONDARY_SCHEDULE_INPUT_INVALID'));
  }
  await assert.rejects(readSecondarySchedule(db,{authority:authority(1,{contextVersion:8})}),code('SECONDARY_SCHEDULE_CONTEXT_CHANGED'));
  const contextFails=intercepting(db,{execute:async sql=>{
    if(sql.includes('FROM auth_sessions session')) throw new Error('context lookup failed');
  }});
  await assert.rejects(readSecondarySchedule(contextFails,{authority:authority()}),code('SECONDARY_SCHEDULE_UNAVAILABLE'));
  const assignmentFails=intercepting(db,{execute:async sql=>{
    if(sql.includes('FROM circle_pairing_publications publication')) throw new Error('assignment failed');
  }});
  await assert.rejects(readSecondarySchedule(assignmentFails,{authority:authority()}),code('SECONDARY_SCHEDULE_UNAVAILABLE'));
  const noAssignment=intercepting(db,{execute:async sql=>sql.includes('FROM circle_pairing_publications publication')?{}:undefined});
  await assert.rejects(readSecondarySchedule(noAssignment,{authority:authority()}),code('SECONDARY_SCHEDULE_PAIR_UNAVAILABLE'));
});

test('a tampered paired assignment row is an integrity failure',async()=>{
  const db=await migrated();
  const real=(await db.execute(`SELECT id FROM circle_pairing_publications`)).rows[0].id;
  const base={publication_id:real,scope_key:'circle:20',circle_id:20,cycle_key:CYCLE,generation_token:GENERATION,
    circle_public_id:'circle-twenty',group_id:1,member_count:2,user_a_id:1,user_b_id:2,is_solo:0};
  const ok=intercepting(db,{execute:async sql=>sql.includes('FROM circle_pairing_publications publication')?{rows:[base]}:undefined});
  assert.equal((await readSecondarySchedule(ok,{authority:authority()})).circle_public_id,'circle-twenty');
  for(const drift of [{publication_id:null},{scope_key:'circle:21'},{scope_key:null},{circle_id:21},{cycle_key:'xyz'},{cycle_key:null},
    {group_id:0},{member_count:3},{user_a_id:null},{user_b_id:1},{is_solo:1},{user_a_id:3,user_b_id:4},
    {circle_public_id:''},{circle_public_id:null}]){
    const client=intercepting(db,{execute:async sql=>sql.includes('FROM circle_pairing_publications publication')?{rows:[{...base,...drift}]}:undefined});
    await assert.rejects(readSecondarySchedule(client,{authority:authority()}),code('SECONDARY_SCHEDULE_INTEGRITY'),JSON.stringify(drift));
  }
  // An invalid generation token cannot derive a schedule identity.
  const badToken=intercepting(db,{execute:async sql=>sql.includes('FROM circle_pairing_publications publication')
    ?{rows:[{...base,generation_token:null}]}:undefined});
  await assert.rejects(readSecondarySchedule(badToken,{authority:authority()}),code('SECONDARY_SCHEDULE_UNAVAILABLE'));
});

test('stored schedule and proposal rows are validated on read',async()=>{
  const db=await migrated();
  await propose(db,'2098-09-20T09:00:00.000Z');
  const [scheduleResult,proposalResult]=await db.batch([
    `SELECT id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at FROM circle_pair_schedules`,
    `SELECT id,schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at FROM circle_pair_schedule_proposals`,
  ],'read');
  const schedule={...scheduleResult.rows[0]};
  const proposalRow={...proposalResult.rows[0]};
  const withRows=(schedules,proposals)=>intercepting(db,{batch:async statements=>
    sqlOf(statements[0]).includes('FROM circle_pair_schedules')?[{rows:schedules},{rows:proposals}]:undefined});
  const read=client=>readSecondarySchedule(client,{authority:authority()});
  assert.equal((await read(withRows([schedule],[proposalRow]))).schedule.proposals.length,1);

  await assert.rejects(read(withRows([],[proposalRow])),code('SECONDARY_SCHEDULE_INTEGRITY'));
  await assert.rejects(read(withRows([schedule,schedule],[])),code('SECONDARY_SCHEDULE_INTEGRITY'));
  const many=Array.from({length:13},(_,index)=>({...proposalRow,proposal_key:index.toString(16).padStart(64,'0')}));
  await assert.rejects(read(withRows([schedule],many)),code('SECONDARY_SCHEDULE_INTEGRITY'));
  for(const drift of [{id:0},{schedule_key:'0'.repeat(64)},{publication_id:999},{scope_key:'circle:21'},{circle_id:21},
    {cycle_key:'b'.repeat(64)},{group_id:99},{member_count:3},{user_a_id:9},{user_b_id:9},{is_solo:1},{revision:0},
    {revision:'x'},{agreed_time:'2098-09-20T10:00:00+01:00'},{agreed_time:'garbage'}]){
    await assert.rejects(read(withRows([{...schedule,...drift}],[])),code('SECONDARY_SCHEDULE_INTEGRITY'),JSON.stringify(drift));
  }
  for(const drift of [{schedule_id:999},{schedule_key:'0'.repeat(64)},{publication_id:999},{scope_key:'x'},{circle_id:1},
    {cycle_key:'x'},{group_id:5},{member_count:1},{user_a_id:5},{user_b_id:5},{is_solo:1},{proposal_key:'bad'},
    {proposal_key:null},{instant:null},{instant:'2098-09-20T10:00:00+01:00'},{proposed_by:3},{proposed_by:null}]){
    await assert.rejects(read(withRows([schedule],[{...proposalRow,...drift}])),code('SECONDARY_SCHEDULE_INTEGRITY'),JSON.stringify(drift));
  }
  // Duplicate ids or instants are corruption.
  await assert.rejects(read(withRows([schedule],[proposalRow,proposalRow])),code('SECONDARY_SCHEDULE_INTEGRITY'));
  await assert.rejects(read(withRows([schedule],[proposalRow,{...proposalRow,proposal_key:'9'.repeat(64)}])),
    code('SECONDARY_SCHEDULE_INTEGRITY'));
  // A partner-authored proposal is projected as such; a missing updated_at projects as empty.
  const partner=await read(withRows([{...schedule,updated_at:null}],[{...proposalRow,proposed_by:2}]));
  assert.equal(partner.schedule.proposals[0].proposed_by,'partner');
  assert.equal(partner.schedule.updated_at,'');
  // Missing result sets are treated as empty, and batch failures are unavailable.
  const missing=intercepting(db,{batch:async()=>[]});
  assert.deepEqual((await read(missing)).schedule.proposals,[]);
  const failing=intercepting(db,{batch:async()=>{ throw new Error('batch failed'); }});
  await assert.rejects(read(failing),code('SECONDARY_SCHEDULE_UNAVAILABLE'));
});

test('read transactions roll back on unexpected errors and ignore close failures',async()=>{
  const db=await migrated();
  const commitFails=intercepting(db,{commit:async()=>{ throw new TypeError('commit transport'); },close:()=>{ throw new Error('close'); }});
  await assert.rejects(readSecondarySchedule(commitFails,{authority:authority()}),error=>
    code('SECONDARY_SCHEDULE_UNAVAILABLE')(error)&&error.cause instanceof TypeError);
  const closeFails=intercepting(db,{close:()=>{ throw new Error('close'); }});
  assert.equal((await readSecondarySchedule(closeFails,{authority:authority()})).ok,true);
});

test('proposal limits, duplicate instants, unknown proposals and no-op writes are handled without side effects',async()=>{
  const db=await migrated();
  await propose(db,'2098-09-20T00:00:00.000Z');
  await assert.rejects(propose(db,'2098-09-20T00:00:00.000Z'),error=>
    error instanceof ScheduleInputError&&/already proposed/.test(error.message));
  for(let hour=1;hour<12;hour+=1){
    const result=await propose(db,`2098-09-20T${String(hour).padStart(2,'0')}:00:00.000Z`);
    assert.equal(result.conflict,false);
  }
  await assert.rejects(propose(db,'2098-09-21T00:00:00.000Z'),error=>
    error instanceof ScheduleInputError&&/maximum 12/.test(error.message));
  const current=await readSecondarySchedule(db,{authority:authority()});
  await assert.rejects(mutateSecondarySchedule(db,{authority:authority(),mutation:{
    action:'remove',baseVersion:current.schedule.version,proposalId:'9'.repeat(64)}}),/proposal not found/);
  await assert.rejects(mutateSecondarySchedule(db,{authority:authority(),mutation:{
    action:'archive',baseVersion:current.schedule.version}}),/unsupported schedule action/);
  // Clearing an unset time and re-accepting the agreed time are committed no-ops.
  const revision=async()=>Number((await db.execute(`SELECT revision FROM circle_pair_schedules`)).rows[0].revision);
  const before=await revision();
  const cleared=await mutateSecondarySchedule(db,{authority:authority(),mutation:{action:'clear',baseVersion:current.schedule.version}});
  assert.equal(cleared.conflict,false);
  assert.equal(cleared.response.schedule.version,current.schedule.version);
  assert.equal(await revision(),before);
  const proposalId=current.schedule.proposals[0].proposal_id;
  const accepted=await mutateSecondarySchedule(db,{authority:authority(2),mutation:{action:'accept',baseVersion:current.schedule.version,proposalId}});
  const again=await mutateSecondarySchedule(db,{authority:authority(2),mutation:{action:'accept',baseVersion:accepted.response.schedule.version,proposalId}});
  assert.equal(again.conflict,false);
  assert.equal(again.response.schedule.version,accepted.response.schedule.version);
  assert.equal(again.outboxStatements,undefined);
});

test('CAS write anomalies return the latest state as a conflict or fail with integrity errors',async()=>{
  const db=await migrated();
  // First write: the insert loses a race and reports a conflict carrying the latest state.
  const initial=await readSecondarySchedule(db,{authority:authority()});
  const mutation={action:'propose',baseVersion:initial.schedule.version,instant:'2098-09-20T09:00:00.000Z'};
  const lostInsert=intercepting(db,{execute:async sql=>sql.startsWith('INSERT INTO circle_pair_schedules')?{rows:[]}:undefined});
  const conflict=await mutateSecondarySchedule(lostInsert,{authority:authority(),mutation});
  assert.equal(conflict.conflict,true);
  assert.deepEqual(conflict.response.schedule.proposals,[]);
  const badId=intercepting(db,{execute:async sql=>sql.startsWith('INSERT INTO circle_pair_schedules')?{rows:[{id:0,revision:1}]}:undefined});
  await assert.rejects(mutateSecondarySchedule(badId,{authority:authority(),mutation}),code('SECONDARY_SCHEDULE_INTEGRITY'));
  const lostProposal=intercepting(db,{execute:async sql=>sql.startsWith('INSERT INTO circle_pair_schedule_proposals')?{}:undefined});
  await assert.rejects(mutateSecondarySchedule(lostProposal,{authority:authority(),mutation}),code('SECONDARY_SCHEDULE_INTEGRITY'));
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM circle_pair_schedules`)).rows[0].n),0,'all rolled back');

  const created=await mutateSecondarySchedule(db,{authority:authority(),mutation});
  const version=created.response.schedule.version;
  const proposalId=created.response.schedule.proposals[0].proposal_id;
  // An UPDATE that matches no revision is a concurrent winner: report the latest state.
  const lostUpdate=intercepting(db,{execute:async sql=>sql.startsWith('UPDATE circle_pair_schedules')?{rows:[]}:undefined});
  const updateConflict=await mutateSecondarySchedule(lostUpdate,{authority:authority(),mutation:{action:'remove',baseVersion:version,proposalId}});
  assert.equal(updateConflict.conflict,true);
  assert.equal(updateConflict.response.schedule.version,version);
  const lostDelete=intercepting(db,{execute:async sql=>sql.startsWith('DELETE FROM circle_pair_schedule_proposals')?{rows:[]}:undefined});
  await assert.rejects(mutateSecondarySchedule(lostDelete,{authority:authority(),mutation:{action:'remove',baseVersion:version,proposalId}}),
    code('SECONDARY_SCHEDULE_INTEGRITY'));
  // An UPDATE claiming success without bumping the stored revision is detected.
  const phantom=intercepting(db,{execute:async sql=>sql.startsWith('UPDATE circle_pair_schedules')?{rows:[{id:1,revision:2}]}:undefined});
  await assert.rejects(mutateSecondarySchedule(phantom,{authority:authority(),mutation:{action:'accept',baseVersion:version,proposalId}}),
    code('SECONDARY_SCHEDULE_INTEGRITY'));
  // Proposal state was not touched by any failed attempt.
  const after=await readSecondarySchedule(db,{authority:authority()});
  assert.equal(after.schedule.version,version);
});

test('notification intents are written atomically and an unqueued intent aborts the write',async()=>{
  const db=await migrated();
  for(const key of FLAGS) process.env[key]='true';
  const initial=await readSecondarySchedule(db,{authority:authority()});
  const mutation={action:'propose',baseVersion:initial.schedule.version,instant:'2098-09-20T09:00:00.000Z'};
  const dropped=intercepting(db,{execute:async sql=>sql.startsWith('INSERT INTO outbox_events')?{rowsAffected:0}:undefined});
  await assert.rejects(mutateSecondarySchedule(dropped,{authority:authority(),mutation}),code('SECONDARY_SCHEDULE_INTEGRITY'));
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS n FROM circle_pair_schedules`)).rows[0].n),0);
  const result=await mutateSecondarySchedule(db,{authority:authority(),mutation});
  assert.equal(result.outboxStatements.length,1);
  const events=await db.execute(`SELECT payload_json FROM outbox_events`);
  assert.equal(JSON.parse(String(events.rows[0].payload_json)).recipient_user_id,2);
});

test('lock conflicts before commit are retried a bounded number of times',async()=>{
  const db=await migrated();
  const initial=await readSecondarySchedule(db,{authority:authority()});
  const mutation={action:'propose',baseVersion:initial.schedule.version,instant:'2098-09-20T09:00:00.000Z'};
  const conflicts=[Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}),Object.assign(new Error('x'),{rawCode:5}),
    new Error('outer',{cause:Object.assign(new Error('inner'),{code:'sqlite_locked'})})];
  for(const [index,error] of conflicts.entries()){
    let attempts=0;
    const flaky=intercepting(db,{transaction:async mode=>{
      if(mode==='write'){ attempts+=1; if(attempts===1) throw error; }
      return undefined;
    }});
    const latest=await readSecondarySchedule(db,{authority:authority()});
    const result=await mutateSecondarySchedule(flaky,{authority:authority(),mutation:{action:'propose',
      baseVersion:latest.schedule.version,instant:`2098-10-0${index+1}T00:00:00.000Z`}});
    assert.equal(result.conflict,false);
    assert.equal(result.response.schedule.proposals.length,index+1);
    assert.equal(attempts,2,`retried ${error.message}`);
  }
  let attempts=0;
  const busy=intercepting(db,{execute:async sql=>{
    if(sql.startsWith('INSERT INTO circle_pair_schedule_proposals')){ attempts+=1; throw Object.assign(new Error('locked'),{code:'SQLITE_LOCKED'}); }
  }});
  const latest=await readSecondarySchedule(db,{authority:authority()});
  await assert.rejects(mutateSecondarySchedule(busy,{authority:authority(),mutation:{...mutation,baseVersion:latest.schedule.version,
    instant:'2098-11-01T00:00:00.000Z'}}),error=>code('SECONDARY_SCHEDULE_UNAVAILABLE')(error)&&error.cause.code==='SQLITE_LOCKED');
  assert.equal(attempts,3);
  // Non-lock failures are not retried.
  attempts=0;
  const broken=intercepting(db,{transaction:async()=>{ attempts+=1; throw new Error('auth token expired'); }});
  await assert.rejects(mutateSecondarySchedule(broken,{authority:authority(),mutation}),code('SECONDARY_SCHEDULE_UNAVAILABLE'));
  assert.equal(attempts,1);
});
