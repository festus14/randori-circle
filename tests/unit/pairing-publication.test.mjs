import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import {
  getPairingPublication,
  PairingPublicationError,
  publishPairingCycle,
} from '../../api/_pairing-publication.js';

const NOW='2026-09-20T07:00:00.000Z';
const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){
    const item=cleanup.pop();
    try{ await item(); }catch{}
  }
});

function statement(sql,args=[]){ return {sql,args}; }

async function createDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-pair-publication-'));
  const url=pathToFileURL(join(directory,'pairing.sqlite')).href;
  const db=createClient({url});
  await db.batch([
    statement(`CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`),
    statement(`CREATE UNIQUE INDEX idx_pairing_weeks_week_label ON pairing_weeks(week_label)`),
    statement(`CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`),
    statement(`CREATE TABLE pairing_participants (week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auth', created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (week_id,user_id))`),
    statement(`CREATE TABLE pairing_week_runs (week_label TEXT PRIMARY KEY, week_id INTEGER, generation_token TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, algorithm_version TEXT NOT NULL, algorithm_seed TEXT NOT NULL, participant_count INTEGER NOT NULL, participants_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`),
    statement(`CREATE TABLE pairing_email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, recipient_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, provider_message_id TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE (week_id,user_id,kind))`),
  ],'write');
  let closed=false;
  cleanup.push(async()=>{
    if(!closed){ closed=true; await db.close(); }
    rmSync(directory,{recursive:true,force:true});
  });
  return {db,url,directory,close:async()=>{ if(!closed){ closed=true; await db.close(); } }};
}

function people(count,start=1){
  return Array.from({length:count},(_,index)=>({
    id:start+index,
    name:`Person ${start+index}`,
    email:`person-${start+index}@private.example`,
    color:'#123456',
    source:'auth',
  }));
}

async function count(db,table){
  const result=await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count||0);
}

function assertPairCoverage(publication,expectedIds){
  const ids=[];
  for(const pair of publication.pairs){
    ids.push(pair.aId);
    if(!pair.isAI) ids.push(pair.bId);
    else assert.equal(pair.aId,pair.bId);
  }
  assert.deepEqual(ids.sort((a,b)=>a-b),[...expectedIds].sort((a,b)=>a-b));
}

test('one, two, three, and odd participant snapshots publish complete non-duplicating pairs',async()=>{
  const {db}=await createDatabase();
  const sizes=[1,2,3,5];
  for(let index=0;index<sizes.length;index+=1){
    const participants=people(sizes[index],index*10+1);
    const now=new Date(Date.parse(NOW)+index*7*24*60*60*1000).toISOString();
    const result=await publishPairingCycle(db,{
      now,
      participants,
      notificationRecipients:participants.map(person=>({id:person.id,email:person.email,kind:'paired'})),
    });
    assert.equal(result.created,true);
    assert.equal(result.publication.participantCount,participants.length);
    assert.equal(result.publication.participants.length,participants.length);
    assert.equal(result.publication.pairs.length,Math.ceil(participants.length/2));
    assertPairCoverage(result.publication,participants.map(person=>person.id));
    assert.equal(result.publication.pairs.filter(pair=>pair.isAI).length,participants.length%2);
    assert.equal(Object.isFrozen(result.publication),true);
    assert.doesNotMatch(JSON.stringify(result),/@private\.example|recipient_email|generationToken/i);
  }
  assert.equal(await count(db,'pairing_week_runs'),sizes.length);
  assert.equal(await count(db,'pairing_weeks'),sizes.length);
  assert.equal(await count(db,'pairing_email_outbox'),sizes.reduce((sum,size)=>sum+size,0));
});

test('repeated publication is immutable and returns the stored result without touching rows',async()=>{
  const {db}=await createDatabase();
  const original=people(3);
  const first=await publishPairingCycle(db,{
    now:NOW,
    participants:original,
    notificationRecipients:original.map(person=>({id:person.id,email:person.email,kind:'paired'})),
  });
  const before=(await db.execute(`SELECT generation_token,updated_at FROM pairing_week_runs`)).rows[0];

  const second=await publishPairingCycle(db,{
    now:'2026-09-25T12:00:00.000Z',
    participants:people(1,90),
    notificationRecipients:[{id:90,email:'replacement@private.example',kind:'paired'}],
  });
  const after=(await db.execute(`SELECT generation_token,updated_at FROM pairing_week_runs`)).rows[0];

  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.deepEqual(second.publication,first.publication);
  assert.deepEqual(after,before);
  assert.equal(await count(db,'pairing_weeks'),1);
  assert.equal(await count(db,'pairing_groups'),2);
  assert.equal(await count(db,'pairing_participants'),3);
  assert.equal(await count(db,'pairing_email_outbox'),3);
});

test('concurrent clients converge on one complete immutable publication',async()=>{
  const fixture=await createDatabase();
  await fixture.close();
  const firstDb=createClient({url:fixture.url});
  const secondDb=createClient({url:fixture.url});
  cleanup.push(()=>firstDb.close(),()=>secondDb.close());
  const firstPeople=people(4,1);
  const secondPeople=people(3,20);

  const [first,second]=await Promise.all([
    publishPairingCycle(firstDb,{now:NOW,participants:firstPeople}),
    publishPairingCycle(secondDb,{now:NOW,participants:secondPeople}),
  ]);

  assert.equal(Number(first.created)+Number(second.created),1);
  assert.deepEqual(first.publication,second.publication);
  assert.ok([3,4].includes(first.publication.participantCount));
  assertPairCoverage(first.publication,first.publication.participants.map(item=>item.userId));
  assert.equal(await count(firstDb,'pairing_week_runs'),1);
  assert.equal(await count(firstDb,'pairing_weeks'),1);
  assert.equal(await count(firstDb,'pairing_participants'),first.publication.participantCount);
  assert.equal(await count(firstDb,'pairing_groups'),Math.ceil(first.publication.participantCount/2));
});

test('a transaction failure rolls back the claim, week, participants, groups, and outbox',async()=>{
  const {db}=await createDatabase();
  // Fail on the second outbox row so every earlier publication write,
  // including the first outbox row, must be rolled back together.
  await db.execute(`CREATE TRIGGER reject_second_outbox BEFORE INSERT ON pairing_email_outbox WHEN NEW.user_id=2 BEGIN SELECT RAISE(ABORT,'forced pairing failure'); END`);
  const participants=people(2);

  await assert.rejects(
    publishPairingCycle(db,{
      now:NOW,
      participants,
      notificationRecipients:participants.map(person=>({id:person.id,email:person.email,kind:'paired'})),
    }),
    error=>error instanceof PairingPublicationError
      &&error.code==='PAIRING_PUBLICATION_FAILED'
      &&error.message==='Pairing publication could not be committed.'
      &&!JSON.stringify(error).includes('@private.example'),
  );
  for(const table of ['pairing_week_runs','pairing_weeks','pairing_participants','pairing_groups','pairing_email_outbox']){
    assert.equal(await count(db,table),0,table);
  }
});

test('legacy weeks and incomplete run claims fail closed without appending or replacing rows',async()=>{
  const {db}=await createDatabase();
  const cycle=resolvePairingCycle({now:NOW});
  await db.execute({
    sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo) VALUES (?,?,'both',0)`,
    args:[cycle.cycleId,cycle.startsAt],
  });
  const weekId=Number((await db.execute(`SELECT id FROM pairing_weeks`)).rows[0].id);
  await db.execute({
    sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair) VALUES (?,?,?,0)`,
    args:[weekId,70,71],
  });

  await assert.rejects(
    publishPairingCycle(db,{now:NOW,participants:people(2)}),
    error=>error?.code==='PAIRING_PUBLICATION_LEGACY_CONFLICT',
  );
  assert.equal(await count(db,'pairing_week_runs'),0);
  assert.equal(await count(db,'pairing_weeks'),1);
  assert.equal(await count(db,'pairing_groups'),1);

  await db.execute({sql:`DELETE FROM pairing_groups WHERE week_id=?`,args:[weekId]});
  await db.execute({sql:`DELETE FROM pairing_weeks WHERE id=?`,args:[weekId]});
  await db.execute({
    sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo) VALUES (?,?,'both',0)`,
    args:[cycle.cycleId,cycle.startsAt],
  });
  const incompleteWeekId=Number((await db.execute(`SELECT id FROM pairing_weeks`)).rows[0].id);
  await db.execute({
    sql:`INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json) VALUES (?,?,'orphan-token',1,'fair-seeded-v1','seed',2,'[{"user_id":1,"source":"auth"},{"user_id":2,"source":"auth"}]')`,
    args:[cycle.cycleId,incompleteWeekId],
  });
  await assert.rejects(
    publishPairingCycle(db,{now:NOW,participants:people(2)}),
    error=>error?.code==='PAIRING_PUBLICATION_INTEGRITY',
  );
  assert.equal(await count(db,'pairing_weeks'),1);
  assert.equal(await count(db,'pairing_groups'),0);
});

test('a stored week must match the exact London cycle boundary',async()=>{
  const {db}=await createDatabase();
  await publishPairingCycle(db,{now:NOW,participants:people(2)});
  await db.execute(`UPDATE pairing_weeks SET week_start='2026-09-20T08:00:00.000Z'`);

  for(const operation of [
    ()=>getPairingPublication(db,{now:NOW}),
    ()=>publishPairingCycle(db,{now:NOW,participants:people(2)}),
  ]){
    await assert.rejects(operation,error=>error?.code==='PAIRING_PUBLICATION_INTEGRITY');
  }
  assert.equal(await count(db,'pairing_week_runs'),1);
  assert.equal(await count(db,'pairing_weeks'),1);
});

test('reads are current-cycle scoped and malformed inputs fail before publication',async()=>{
  const {db}=await createDatabase();
  assert.equal(await getPairingPublication(db,{now:NOW}),null);
  const input=people(2);
  const inputBefore=structuredClone(input);
  await publishPairingCycle(db,{now:NOW,participants:input});
  assert.deepEqual(input,inputBefore,'the supplied eligibility snapshot must not be mutated');
  assert.equal((await getPairingPublication(db,{now:'2026-09-27T07:00:00.000Z'})),null);

  for(const options of [
    {now:'2026-09-27T07:00:00.000Z',participants:[]},
    {now:'2026-09-27T07:00:00.000Z',participants:[...people(1),...people(1)]},
    {now:'2026-09-27T07:00:00.000Z',participants:[{id:1,source:'untrusted'}]},
    {now:'2026-09-27T07:00:00.000Z',participants:people(1),notificationRecipients:[{id:99,email:'wrong@example.test',kind:'paired'}]},
    {now:'2026-09-27T07:00:00.000Z',participants:people(1),notificationRecipients:[{id:1,email:'wrong@example.test',kind:'unavailable'}]},
    {now:'2026-09-27T07:00:00.000Z',state:'upcoming',participants:people(1)},
    {now:'not-an-instant',participants:people(1)},
  ]){
    await assert.rejects(
      publishPairingCycle(db,options),
      error=>error instanceof PairingPublicationError,
    );
  }
  assert.equal(await count(db,'pairing_week_runs'),1);
});

test('write batches contain only a token-guarded immutable create path',async()=>{
  const fixture=await createDatabase();
  const writeBatches=[];
  const db={
    batch(statements,mode){
      if(mode==='write') writeBatches.push(statements);
      return fixture.db.batch(statements,mode);
    },
  };
  await publishPairingCycle(db,{now:NOW,participants:people(2)});
  assert.equal(writeBatches.length,1);
  const sql=writeBatches[0].map(item=>item.sql).join('\n');
  assert.doesNotMatch(sql,/\bDELETE\b|ON\s+CONFLICT[^\n]*DO\s+UPDATE/i);
  assert.match(sql,/generation_token=\?/);
  assert.match(sql,/WHERE NOT EXISTS \(SELECT 1 FROM pairing_weeks/);
});
