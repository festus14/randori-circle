// Secondary-circle pairing fail-closed paths: authority validation, injected
// database faults inside the write transaction, stored-row corruption, and the
// HTTP failure mapping. A real migrated database keeps readiness honest; a thin
// wrapper only intercepts the statements a test deliberately breaks.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import {
  CirclePairingError,
  circlePairingFailure,
  ensureCirclePairingReadiness,
  listSecondaryPairingScopes,
  publishCirclePairing,
  readCirclePairing,
} from '../../api/_circle-pairing.js';
import { PairingRecoveryError } from '../../api/_pairing-recovery.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

const NOW=new Date('2026-09-20T08:15:00.000Z');
const SESSION_HASH='b'.repeat(64);

async function withDatabase(run){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-circle-pairing-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  try{
    await prepareMigrationConnection(db);
    await run(db);
  }finally{
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }
}

async function seedCircle(db,{circleId=20,userIds=[1,2,3],ownerId=1,contextVersion=7,publicId=`circle-${circleId}`}={}){
  for(const id of userIds){
    await db.execute({sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
      VALUES (?,?,?,?,?,0,0)`,args:[id,`m${id}@example.test`,'hash',`Member ${id}`,'#123456']});
  }
  await db.execute({sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (?,?,?,?,0,?)`,
    args:[circleId,publicId,`slug-${circleId}`,`Circle ${circleId}`,ownerId]});
  for(const id of userIds){
    await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,?,?,'active')`,
      args:[circleId,id,id===ownerId?'owner':'member']});
  }
  await db.execute({sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,1,4000000000)`,
    args:[SESSION_HASH,ownerId]});
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,?,?,?,1)`,args:[SESSION_HASH,ownerId,circleId,contextVersion]});
  return {kind:'session',payload:{id:ownerId,sessionHash:SESSION_HASH},userId:ownerId,circleId,
    contextVersion,implicit:false,requireOwner:true};
}

function sqlOf(statement){ return typeof statement==='string'?statement:String(statement?.sql||''); }

// hooks.execute(sql, statement, real) / hooks.batch(statements, mode, real) may
// return undefined to fall through to the real database.
function wrap(db,hooks={}){
  const log={transactions:0,rollbacks:0,commits:0};
  const intercept=(real)=>({
    async execute(statement){
      const handled=await hooks.execute?.(sqlOf(statement),statement,()=>real.execute(statement));
      return handled===undefined?real.execute(statement):handled;
    },
    async batch(statements,mode){
      const handled=await hooks.batch?.(statements,mode,()=>real.batch(statements,mode));
      return handled===undefined?real.batch(statements,mode):handled;
    },
  });
  return {
    ...intercept(db),log,
    async transaction(mode){
      log.transactions+=1;
      if(hooks.transaction) await hooks.transaction(log.transactions);
      const tx=await db.transaction(mode);
      return {
        ...intercept(tx),
        commit:async()=>{ log.commits+=1; if(hooks.commit) await hooks.commit(); return tx.commit(); },
        rollback:async()=>{ log.rollbacks+=1; await tx.rollback(); if(hooks.rollbackError) throw hooks.rollbackError; },
        close:async()=>{ tx.close(); if(hooks.closeError) throw hooks.closeError; },
      };
    },
  };
}

async function rejectsCode(promise,code){
  await assert.rejects(promise,error=>{
    assert.ok(error instanceof CirclePairingError||error instanceof PairingRecoveryError,String(error));
    assert.equal(error.code,code);
    return true;
  });
}

async function publicationCount(db){
  return Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_pairing_publications`)).rows[0].count);
}

test('failure mapping exposes stable statuses and only safe circle context',()=>{
  const error=(code,extra={})=>Object.assign(new CirclePairingError(code,'x'),extra);
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_CONTEXT_CHANGED')),
    {status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'}});
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_OWNER_REQUIRED'),{contextVersion:3,circlePublicId:'c1'}),
    {status:403,body:{ok:false,error:'circle owner required',circle_public_id:'c1',circle_context_version:3}});
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_FORBIDDEN'),{circlePublicId:'c1'}),
    {status:403,body:{ok:false,error:'active circle membership required'}});
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_NO_PARTICIPANTS'),{contextVersion:0}),
    {status:400,body:{ok:false,error:'at least one active member is required',circle_context_version:0}});
  const state={state:'pending'};
  const changed=new PairingRecoveryError('PAIRING_RECOVERY_CYCLE_CHANGED','x',{publicationState:state});
  assert.equal(circlePairingFailure(changed).body.code,'pairing_cycle_changed');
  assert.equal(circlePairingFailure(changed).body.publication_state,state);
  const notReady=new PairingRecoveryError('PAIRING_RECOVERY_NOT_READY','x',{publicationState:state});
  assert.equal(circlePairingFailure(notReady).status,409);
  assert.equal(circlePairingFailure(notReady).body.code,'pairing_recovery_not_ready');
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_BATCH_OVERFLOW')),{status:503,body:{
    ok:false,error:'secondary pairing batch limit exceeded',code:'pairing_batch_overflow',retryable:true}});
  // Untyped errors never leak their code or message.
  const raw=Object.assign(new Error('SQLITE secret'),{code:'CIRCLE_PAIRING_FORBIDDEN'});
  assert.deepEqual(circlePairingFailure(raw),{status:503,body:{ok:false,error:'pairing unavailable'}});
  assert.deepEqual(circlePairingFailure(error('CIRCLE_PAIRING_INTEGRITY')),{status:503,body:{ok:false,error:'pairing unavailable'}});
});

test('malformed clients and authorities are rejected before any database access',async()=>{
  const calls=[];
  const db={execute:async()=>{ calls.push('execute'); },batch:async()=>{},transaction:async()=>{ calls.push('tx'); }};
  const valid={kind:'session',payload:{id:1},userId:1,circleId:20,contextVersion:0,implicit:false};
  await rejectsCode(publishCirclePairing({execute(){},batch(){}},{authority:valid}),'CIRCLE_PAIRING_INPUT_INVALID');
  await rejectsCode(readCirclePairing(null,{authority:valid}),'CIRCLE_PAIRING_INPUT_INVALID');
  await rejectsCode(publishCirclePairing(db),'CIRCLE_PAIRING_INPUT_INVALID');
  for(const authority of [
    null,[],{...valid,kind:'cron'},{...valid,payload:null},{...valid,payload:[]},{...valid,implicit:'no'},
    {...valid,circleId:0},{...valid,userId:-1},{...valid,contextVersion:-1},{...valid,contextVersion:1.5},
    {...valid,payload:{id:2}},{...valid,payload:{uid:9}},
  ]){
    await rejectsCode(publishCirclePairing(db,{authority}),'CIRCLE_PAIRING_INPUT_INVALID');
  }
  await rejectsCode(publishCirclePairing(db,{authority:{kind:'system',circleId:'abc'}}),'CIRCLE_PAIRING_INPUT_INVALID');
  await rejectsCode(publishCirclePairing(db,{authority:{kind:'system',circleId:20},expectedCycleKey:'a'.repeat(64)}),
    'CIRCLE_PAIRING_OWNER_REQUIRED');
  await rejectsCode(publishCirclePairing(db,{authority:valid,expectedCycleKey:'a'.repeat(64)}),
    'CIRCLE_PAIRING_OWNER_REQUIRED');
  for(const limit of [0,101,1.5,'5']){
    await rejectsCode(listSecondaryPairingScopes(db,{limit}),'CIRCLE_PAIRING_INPUT_INVALID');
  }
  await rejectsCode(ensureCirclePairingReadiness({}),'CIRCLE_PAIRING_INPUT_INVALID');
  assert.deepEqual(calls,[]);
});

test('readiness converts unexpected inspection errors to a schema-unavailable failure',async()=>{
  const cause=new Error('disk I/O');
  await assert.rejects(ensureCirclePairingReadiness({execute:async()=>{ throw cause; }}),error=>{
    assert.equal(error.code,'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE');
    assert.equal(error.cause,cause);
    return true;
  });
});

test('a ledger missing its latest migration row is not ready',async()=>{
  await withDatabase(async db=>{
    const latest=await db.execute(`SELECT MAX(version) AS v FROM schema_migrations`);
    const wrapped=wrap(db,{execute:(sql,_statement,real)=>sql.includes('schema_migrations')&&!sql.includes('sqlite_')
      ?real().then(result=>({...result,rows:result.rows.filter(row=>Number(row.version)!==Number(latest.rows[0].v))}))
      :undefined});
    await rejectsCode(ensureCirclePairingReadiness(wrapped),'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE');
    assert.equal(await ensureCirclePairingReadiness(db),true);
  });
});

test('scope enumeration fails closed on read errors and tolerates an empty result shape',async()=>{
  await withDatabase(async db=>{
    const failing=wrap(db,{execute:sql=>{ if(sql.includes('ORDER BY circle.id LIMIT')) throw new Error('down'); }});
    await rejectsCode(listSecondaryPairingScopes(failing),'CIRCLE_PAIRING_UNAVAILABLE');
    const empty=wrap(db,{execute:sql=>sql.includes('ORDER BY circle.id LIMIT')?{}:undefined});
    assert.deepEqual(await listSecondaryPairingScopes(empty,{limit:1}),[]);
  });
});

test('publication time and timezone are validated inside the transaction',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    await rejectsCode(publishCirclePairing(db,{authority,now:'not-a-time'}),'CIRCLE_PAIRING_INPUT_INVALID');
    await rejectsCode(publishCirclePairing(db,{authority,now:async()=>NaN}),'CIRCLE_PAIRING_INPUT_INVALID');
    await rejectsCode(publishCirclePairing(db,{authority,now:NOW,timeZone:'Mars/Olympus'}),'CIRCLE_PAIRING_INPUT_INVALID');
    const clockDown=wrap(db,{execute:sql=>{ if(sql.includes('now_utc')) throw new Error('clock'); }});
    await rejectsCode(publishCirclePairing(clockDown,{authority}),'CIRCLE_PAIRING_UNAVAILABLE');
    const clockJunk=wrap(db,{execute:sql=>sql.includes('now_utc')?{rows:[{now_utc:'garbage'}]}:undefined});
    await rejectsCode(publishCirclePairing(clockJunk,{authority}),'CIRCLE_PAIRING_UNAVAILABLE');
    const clockEmpty=wrap(db,{execute:sql=>sql.includes('now_utc')?{}:undefined});
    await rejectsCode(readCirclePairing(clockEmpty,{authority}),'CIRCLE_PAIRING_UNAVAILABLE');
    assert.equal(await publicationCount(db),0);
    // The database clock is used when no explicit instant is supplied.
    const result=await publishCirclePairing(db,{authority});
    assert.equal(result.created,true);
  });
});

test('authority checks fail closed when lookups error or the circle is not eligible',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const sessionLookupDown=wrap(db,{execute:sql=>{ if(sql.includes('auth_session_circle_contexts')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(sessionLookupDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    const membershipDown=wrap(db,{execute:sql=>{ if(sql.includes('SELECT membership.role,circle.public_id')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(membershipDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    const membershipGone=wrap(db,{execute:sql=>sql.includes('SELECT membership.role,circle.public_id')?{}:undefined});
    await rejectsCode(readCirclePairing(membershipGone,{authority,now:NOW}),'CIRCLE_PAIRING_FORBIDDEN');

    const system={kind:'system',circleId:20};
    const systemDown=wrap(db,{execute:sql=>{ if(sql.includes('SELECT circle.public_id')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(systemDown,{authority:system,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    await rejectsCode(publishCirclePairing(db,{authority:{kind:'system',circleId:99},now:NOW}),'CIRCLE_PAIRING_FORBIDDEN');
    assert.equal(await publicationCount(db),0);
  });
});

test('a member without owner rights may read but a null public id is reported as empty',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const blankId=wrap(db,{execute:(sql,_s,real)=>sql.includes('SELECT membership.role,circle.public_id')
      ?real().then(result=>({rows:[{role:result.rows[0].role,public_id:null}]})):undefined});
    const read=await readCirclePairing(blankId,{authority,now:NOW});
    assert.equal(read.circlePublicId,'');
    assert.equal(read.role,'owner');
    assert.equal(read.publication,null);
    assert.equal(read.accounts.size,0);
    const systemBlank=wrap(db,{execute:sql=>sql.includes('SELECT circle.public_id')?{rows:[{public_id:null}]}:undefined});
    const published=await publishCirclePairing(systemBlank,{authority:{kind:'system',circleId:20},now:NOW});
    assert.equal(published.created,true);
  });
});

test('eligibility and history read failures abort before a claim is written',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const accountsDown=wrap(db,{execute:sql=>{ if(sql.includes('SELECT account.id\n')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(accountsDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    const duplicates=wrap(db,{execute:sql=>sql.includes('SELECT account.id\n')?{rows:[{id:1},{id:1}]}:undefined});
    await rejectsCode(publishCirclePairing(duplicates,{authority,now:NOW}),'CIRCLE_PAIRING_INTEGRITY');
    const none=wrap(db,{execute:sql=>sql.includes('SELECT account.id\n')?{}:undefined});
    await rejectsCode(publishCirclePairing(none,{authority,now:NOW}),'CIRCLE_PAIRING_NO_PARTICIPANTS');
    const historyDown=wrap(db,{execute:sql=>{ if(sql.includes('ORDER BY publication.starts_at DESC')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(historyDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    const historyEmpty=wrap(db,{execute:sql=>sql.includes('ORDER BY publication.starts_at DESC')?{}:undefined});
    assert.equal((await publishCirclePairing(historyEmpty,{authority,now:NOW})).created,true);
  });
});

test('claim and child-row write failures roll back the whole publication',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const claimDown=wrap(db,{execute:sql=>{ if(sql.includes('INSERT INTO circle_pairing_publications')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(claimDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    const childDown=wrap(db,{execute:sql=>{ if(sql.includes('INSERT INTO circle_pairing_groups')) throw new Error('down'); }});
    await rejectsCode(publishCirclePairing(childDown,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    assert.equal(await publicationCount(db),0);
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS c FROM circle_pairing_eligibility`)).rows[0].c),0);
  });
});

test('a lost claim with no visible winner is an integrity failure, not success',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const lost=wrap(db,{execute:sql=>sql.includes('INSERT INTO circle_pairing_publications')?{rows:[]}:undefined});
    await rejectsCode(publishCirclePairing(lost,{authority,now:NOW}),'CIRCLE_PAIRING_INTEGRITY');
    assert.equal(await publicationCount(db),0);
  });
});

test('a lost claim whose winner commits concurrently returns that publication without committing',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const winner=await publishCirclePairing(db,{authority:{kind:'system',circleId:20},now:NOW});
    let reads=0;
    // The first snapshot predates the concurrent winner; the claim then loses
    // ON CONFLICT and the post-claim read observes the winner's rows.
    const raced=wrap(db,{
      batch:async(_s,mode,real)=>{
        if(mode!=='read') return undefined;
        reads+=1;
        return reads===1?[{rows:[]},{rows:[]},{rows:[]}]:real();
      },
      execute:sql=>sql.includes('INSERT INTO circle_pairing_publications')?{rows:[]}:undefined,
    });
    const result=await publishCirclePairing(raced,{authority,now:NOW});
    assert.equal(result.created,false);
    assert.equal(result.publication.id,winner.publication.id);
    assert.equal(result.publicationState.state,'published');
    assert.equal(raced.log.commits,0);
    assert.equal(raced.log.rollbacks,1);
  });
});

test('a changed generation token after the claim is treated as an ownership change',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    let reads=0;
    const swapped=wrap(db,{batch:async(_statements,mode,real)=>{
      if(mode!=='read') return undefined;
      reads+=1;
      const result=await real();
      if(reads===2&&result[0].rows[0]){
        return [{rows:[{...result[0].rows[0],generation_token:'11111111-1111-4111-8111-111111111111'}]},result[1],result[2]];
      }
      return result;
    }});
    await rejectsCode(publishCirclePairing(swapped,{authority,now:NOW}),'CIRCLE_PAIRING_INTEGRITY');
    assert.equal(swapped.log.commits,0);
    assert.equal(await publicationCount(db),0);
  });
});

test('stored publication corruption is detected on read',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db,{userIds:[1,2,3,4]});
    await publishCirclePairing(db,{authority,now:NOW});
    const corrupt=(mutate)=>wrap(db,{batch:async(_s,mode,real)=>mode==='read'?mutate(await real()):undefined});
    const cases=[
      result=>{ throw new Error('read failed'); },
      result=>[{rows:[]},result[1],result[2]],
      result=>[{rows:[]},{rows:[]},result[2]],
      result=>[{rows:[result[0].rows[0],result[0].rows[0]]},result[1],result[2]],
      result=>[result[0],{rows:result[1].rows.slice(1)},result[2]],
      result=>[result[0],{rows:result[1].rows.map((row,index)=>index===0?{...row,group_size:3}:row)},result[2]],
      result=>[result[0],{rows:result[1].rows.map((row,index)=>index===0?{...row,member_position:2}:row)},result[2]],
      result=>[result[0],{rows:result[1].rows.map((row,index)=>index===0?{...row,is_available:0}:row)},result[2]],
      result=>[result[0],result[1],{rows:result[2].rows.map((row,index)=>index===0?{...row,user_b_id:row.user_a_id}:row)}],
      result=>[result[0],result[1],{rows:result[2].rows.map((row,index)=>index===0?{...row,user_b_id:999}:row)}],
      result=>[result[0],result[1],{rows:result[2].rows.map((row,index)=>index===0?{...row,position:5}:row)}],
      result=>[result[0],result[1],{rows:result[2].rows.map(row=>({...row,user_a_id:result[2].rows[0].user_a_id,user_b_id:result[2].rows[0].user_b_id}))}],
      result=>[result[0],result[1],undefined],
    ];
    for(const [index,mutate] of cases.entries()){
      await assert.rejects(readCirclePairing(corrupt(mutate),{authority,now:NOW}),error=>{
        assert.ok(error instanceof CirclePairingError,`case ${index}`);
        assert.ok(['CIRCLE_PAIRING_INTEGRITY','CIRCLE_PAIRING_UNAVAILABLE'].includes(error.code),`case ${index}: ${error.code}`);
        return true;
      });
    }
    const blankNames=wrap(db,{execute:(sql,_s,real)=>sql.includes('account.display_name')
      ?real().then(result=>({rows:result.rows.map(row=>Number(row.id)===2?{id:2,display_name:'',color:null}:row)}))
      :undefined});
    const intact=await readCirclePairing(blankNames,{authority,now:NOW});
    assert.equal(intact.publication.groups.length,2);
    assert.equal(intact.accounts.get(1).name,'Member 1');
    // A blank display name or colour falls back to safe defaults.
    assert.deepEqual(intact.accounts.get(2),{name:'Member',color:'#999'});
  });
});

test('an all-unavailable publication reads without a name lookup',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db,{userIds:[1]});
    const { availabilityCycleKey }=await import('../../api/_availability.js');
    const { resolvePairingCycle }=await import('../../api/_pairing-cycle.js');
    const cycle=resolvePairingCycle({now:NOW});
    const scope={kind:'circle',scopeKey:'circle:20',circleId:20};
    const cycleKey=availabilityCycleKey(scope,cycle);
    await db.execute({sql:`INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,?,?,?,?,?,'cycle_default')`,args:[scope.scopeKey,20,cycleKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone]});
    await db.execute({sql:`INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES (?,?,1,0,1,'user')`,args:[scope.scopeKey,cycleKey]});
    await publishCirclePairing(db,{authority,now:NOW});
    let nameLookups=0;
    const counting=wrap(db,{execute:sql=>{ if(sql.includes('account.display_name')) nameLookups+=1; }});
    const read=await readCirclePairing(counting,{authority,now:NOW});
    assert.equal(read.publication.groups.length,0);
    assert.equal(nameLookups,0);
  });
});

test('read failures roll back and swallow rollback and close errors',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    await publishCirclePairing(db,{authority,now:NOW});
    const broken=wrap(db,{
      execute:sql=>{ if(sql.includes('account.display_name')) throw new Error('names down'); },
      rollbackError:new Error('rollback failed'),closeError:new Error('close failed'),
    });
    await rejectsCode(readCirclePairing(broken,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    assert.equal(broken.log.rollbacks,1);
  });
});

test('lock conflicts are retried with backoff and persistent conflicts surface as unavailable',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const conflicts=[
      Object.assign(new Error('x'),{rawCode:'transaction_conflict'}),
      new Error('outer',{cause:new Error('SQLITE_BUSY - database is locked')}),
    ];
    const flaky=wrap(db,{transaction:attempt=>{ if(attempt<=conflicts.length) throw conflicts[attempt-1]; }});
    const result=await publishCirclePairing(flaky,{authority,now:NOW});
    assert.equal(result.created,true);
    assert.equal(flaky.log.transactions,3);

    const busy=wrap(db,{transaction:()=>{ throw new Error('database is busy'); }});
    await assert.rejects(publishCirclePairing(busy,{authority,now:NOW}),error=>{
      assert.equal(error.code,'CIRCLE_PAIRING_UNAVAILABLE');
      assert.equal(error.cause.message,'database is busy');
      return true;
    });
    assert.equal(busy.log.transactions,4);
    const typed=wrap(db,{transaction:attempt=>{
      throw attempt<4?Object.assign(new Error('x'),{code:'SQLITE_BUSY_SNAPSHOT'})
        :new CirclePairingError('CIRCLE_PAIRING_TEST','typed');
    }});
    await rejectsCode(publishCirclePairing(typed,{authority,now:NOW}),'CIRCLE_PAIRING_TEST');
  });
});

test('a commit failure is never retried and close errors are swallowed',async()=>{
  await withDatabase(async db=>{
    const authority=await seedCircle(db);
    const ambiguous=wrap(db,{
      commit:()=>{ throw Object.assign(new Error('x'),{code:'SQLITE_BUSY'}); },
      closeError:new Error('close failed'),
    });
    await rejectsCode(publishCirclePairing(ambiguous,{authority,now:NOW}),'CIRCLE_PAIRING_UNAVAILABLE');
    assert.equal(ambiguous.log.transactions,1);
  });
});
