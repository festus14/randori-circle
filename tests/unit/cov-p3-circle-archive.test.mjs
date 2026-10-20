import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  archiveSecondaryCircle,
  CircleArchiveError,
  parseCircleArchive,
} from '../../api/_circle-archive.js';

const HASH='a'.repeat(64);
const PAYLOAD=Object.freeze({id:1,sessionHash:HASH});
const INPUT=Object.freeze({circlePublicId:'circle-secondary',expectedContextVersion:4});
const NOW=1_795_000_000;
const CLOCK={rows:[{now_seconds:NOW,now_utc:'2026-11-18T10:13:20.000Z'}]};
const LIVE={rows:[{id:1}]};
const RECENT={rows:[{authenticated_at:NOW-5,method:'password'}]};

function target(overrides={}){
  return {rows:[{id:20,public_id:'circle-secondary',name:'Secondary',is_primary:0,archived_at:null,
    role:'owner',status:'active',archived_by:null,archive_event_type:null,archive_dedupe_key:null,...overrides}]};
}

// Transaction double that replays scripted execute() results in order.
function scriptedDb(script,{commitError=null}={}){
  const log=[];
  const statements=[];
  let transactions=0;
  const attempts=Array.isArray(script[0])?script.map(list=>[...list]):[[...script]];
  return {
    log,statements,
    get transactions(){ return transactions; },
    async transaction(mode){
      const queue=attempts[Math.min(transactions,attempts.length-1)];
      transactions+=1;
      log.push(`begin:${mode}`);
      return {
        async execute(statement){
          statements.push(statement);
          const next=queue.shift();
          if(next instanceof Error) throw next;
          return next||{rows:[]};
        },
        async commit(){ log.push('commit'); if(commitError) throw commitError; },
        async rollback(){ log.push('rollback'); throw new Error('rollback errors are ignored'); },
        async close(){ log.push('close'); },
      };
    },
  };
}

const archive=(db,options={})=>archiveSecondaryCircle(db,PAYLOAD,INPUT,{baseDelayMs:0,...options});

test('archive input parsing accepts only the exact canonical body',()=>{
  assert.deepEqual(parseCircleArchive({circle_public_id:'circle-x',expected_context_version:0}),
    {circlePublicId:'circle-x',expectedContextVersion:0});
  for(const body of [
    null,[],'x',{circle_public_id:'circle-x'},
    {circle_public_id:'circle-x',expected_context_version:1,extra:true},
    {circle_public_id:' circle-x ',expected_context_version:1},
    {circle_public_id:'!bad',expected_context_version:1},
    {circle_public_id:'circle-x',expected_context_version:-1},
    {circle_public_id:'circle-x',expected_context_version:'1'},
    {circle_public_id:'circle-x',expected_context_version:1.5},
  ]){
    assert.throws(()=>parseCircleArchive(body),error=>error instanceof CircleArchiveError
      &&error.code==='CIRCLE_ARCHIVE_INPUT_INVALID');
  }
});

test('archive request validation rejects unusable actors, inputs, and retry policies',async()=>{
  const db=scriptedDb([]);
  const cases=[
    [db,{id:1,sessionHash:'nope'},INPUT,{}],
    [db,{uid:'01',sessionHash:HASH},INPUT,{}],
    [db,{id:-1,sessionHash:HASH},INPUT,{}],
    [{},PAYLOAD,INPUT,{}],
    [db,PAYLOAD,null,{}],
    [db,PAYLOAD,{circlePublicId:' x',expectedContextVersion:0},{}],
    [db,PAYLOAD,{circlePublicId:'x',expectedContextVersion:-1},{}],
    [db,PAYLOAD,INPUT,{maxAttempts:0}],
    [db,PAYLOAD,INPUT,{maxAttempts:9}],
    [db,PAYLOAD,INPUT,{baseDelayMs:-1}],
    [db,PAYLOAD,INPUT,{baseDelayMs:1001}],
    [db,PAYLOAD,INPUT,{nowSeconds:0}],
    [db,PAYLOAD,INPUT,{nowSeconds:1.5}],
  ];
  for(const [client,payload,input,options] of cases){
    await assert.rejects(archiveSecondaryCircle(client,payload,input,options),TypeError);
  }
  assert.equal(db.transactions,0);
});

test('an unusable database clock fails closed as unavailable',async()=>{
  for(const clock of [{rows:[]},{rows:[{now_seconds:0,now_utc:'2026-11-18T10:13:20.000Z'}]},
    {rows:[{now_seconds:NOW,now_utc:'yesterday'}]}]){
    const db=scriptedDb([clock]);
    await assert.rejects(archive(db),error=>error.code==='CIRCLE_ARCHIVE_UNAVAILABLE');
    assert.deepEqual(db.log,['begin:write','rollback','close']);
  }
  // An injected application clock drives recent-auth freshness, not session liveness.
  const injected=NOW+3600;
  const db=scriptedDb([CLOCK,LIVE,target({is_primary:1}),{rows:[{authenticated_at:injected-1,method:'google'}]}]);
  assert.deepEqual(await archive(db,{nowSeconds:injected}),{ok:false,reason:'primary_circle'});
  assert.equal(db.statements[1].args[2],NOW);
  assert.equal(db.statements[3].args.at(-1),injected);
});

test('changed sessions, missing ownership, and target identity drift never archive',async()=>{
  assert.deepEqual(await archive(scriptedDb([CLOCK,{rows:[]}])),{ok:false,reason:'session_changed'});
  assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,{rows:[]}])),{ok:false,reason:'circle_unavailable'});
  assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,{rows:[{},{}]}])),{ok:false,reason:'circle_unavailable'});
  for(const drift of [{id:0},{public_id:'circle-other'}]){
    await assert.rejects(archive(scriptedDb([CLOCK,LIVE,target(drift)])),
      error=>error.code==='CIRCLE_ARCHIVE_INTEGRITY');
  }
  // Stale recent authentication blocks archive before any write.
  const stale=scriptedDb([CLOCK,LIVE,target(),{rows:[]}]);
  await assert.rejects(archive(stale),error=>error.code==='RECENT_AUTH_REQUIRED');
  assert.ok(!stale.log.includes('commit'));
  assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,target({is_primary:1}),RECENT])),
    {ok:false,reason:'primary_circle'});
});

test('an already archived circle replays idempotently only with matching archive evidence',async()=>{
  const archived={archived_at:'2026-01-01T00:00:00.000Z',archived_by:1,archive_event_type:'circle.archived',
    archive_dedupe_key:'circle-archived:20'};
  for(const bad of [{archived_by:null},{archive_event_type:'circle.renamed'},{archive_dedupe_key:'circle-archived:21'}]){
    assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,target({...archived,...bad}),RECENT])),
      {ok:false,reason:'circle_unavailable'});
  }
  const withContext=await archive(scriptedDb([CLOCK,LIVE,target(archived),RECENT,{rows:[{context_version:5}]}]));
  assert.deepEqual(withContext,{ok:true,changed:false,circle:{public_id:'circle-secondary',name:'Secondary'},
    context_version:5});
  const withoutContext=await archive(scriptedDb([CLOCK,LIVE,target({...archived,name:null}),RECENT,{}]));
  assert.deepEqual(withoutContext,{ok:true,changed:false,circle:{public_id:'circle-secondary',name:''}});
  for(const contexts of [{rows:[{context_version:1},{context_version:2}]},{rows:[{context_version:0}]},
    {rows:[{context_version:'x'}]}]){
    await assert.rejects(archive(scriptedDb([CLOCK,LIVE,target(archived),RECENT,contexts])),
      error=>error.code==='CIRCLE_ARCHIVE_INTEGRITY');
  }
});

test('archive requires the initiating session to hold the expected context on this circle',async()=>{
  for(const selected of [{rows:[]},{rows:[{circle_id:20,context_version:4},{circle_id:20,context_version:4}]},
    {rows:[{circle_id:10,context_version:4}]},{rows:[{circle_id:20,context_version:3}]},
    {rows:[{circle_id:20,context_version:'x'}]}]){
    assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,target(),RECENT,selected])),
      {ok:false,reason:'context_changed'});
  }
  const selected={rows:[{circle_id:20,context_version:4}]};
  assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,target(),RECENT,selected,{rows:[{user_id:2}]}])),
    {ok:false,reason:'last_circle'});
  // The guarded UPDATE losing a race is reported as a changed context.
  assert.deepEqual(await archive(scriptedDb([CLOCK,LIVE,target(),RECENT,selected,{rows:[]},{rows:[]}])),
    {ok:false,reason:'context_changed'});
});

test('post-update integrity checks roll back instead of committing a partial archive',async()=>{
  const prefix=[CLOCK,LIVE,target(),RECENT,{rows:[{circle_id:20,context_version:4}]},{rows:[]},
    {rows:[{id:20,public_id:'circle-secondary',name:'Secondary',archived_at:'x'}]}];
  const moved={rows:[{session_hash:HASH,user_id:1,circle_id:10,context_version:5}]};
  const cases=[
    [{rows:[]}],
    [{rows:[{id:1}]},{rows:[]}],
    [{rows:[{id:1}]},{rows:[{session_hash:HASH,user_id:1,circle_id:10,context_version:6}]}],
    [{rows:[{id:1}]},{rows:[{session_hash:'b'.repeat(64),user_id:1,circle_id:10,context_version:5}]}],
    [{rows:[{id:1}]},moved,{rows:[]},{rows:[{count:1}]}],
  ];
  for(const tail of cases){
    const db=scriptedDb([...prefix,...tail]);
    await assert.rejects(archive(db),error=>error.code==='CIRCLE_ARCHIVE_INTEGRITY');
    assert.ok(db.log.includes('rollback'));
    assert.ok(!db.log.includes('commit'));
  }
  const success=scriptedDb([...prefix,{rows:[{id:1}]},moved,{rows:[]},{rows:[{count:0}]}]);
  assert.deepEqual(await archive(success),{ok:true,changed:true,
    circle:{public_id:'circle-secondary',name:'Secondary'},context_version:5});
  assert.deepEqual(success.log,['begin:write','commit','close']);
});

test('an ambiguous commit is reported as unknown and never retried',async()=>{
  const script=[CLOCK,LIVE,target(),RECENT,{rows:[{circle_id:20,context_version:4}]},{rows:[]},
    {rows:[{id:20,name:'Secondary'}]},{rows:[{id:1}]},
    {rows:[{session_hash:HASH,user_id:1,circle_id:10,context_version:5}]},{rows:[]},{rows:[{count:0}]}];
  const busy=Object.assign(new Error('commit lost'),{code:'SQLITE_BUSY'});
  const db=scriptedDb(script,{commitError:busy});
  await assert.rejects(archive(db,{maxAttempts:3}),error=>error instanceof CircleArchiveError
    &&error.code==='CIRCLE_ARCHIVE_COMMIT_UNKNOWN'&&error.cause===busy);
  assert.equal(db.transactions,1);
});

test('retryable lock conflicts retry with backoff while other failures surface immediately',async()=>{
  const conflicts=[
    Object.assign(new Error('x'),{code:'SQLITE_BUSY'}),
    Object.assign(new Error('x'),{rawCode:'libsql_transaction_busy'}),
    new Error('database is locked'),
    new Error('SQLITE_LOCKED: database table is locked'),
    new Error('database is busy'),
    new Error('wrapped',{cause:Object.assign(new Error('inner'),{code:'TRANSACTION_CONFLICT'})}),
  ];
  for(const conflict of conflicts){
    const db=scriptedDb([[conflict],[CLOCK,{rows:[]}]]);
    assert.deepEqual(await archive(db,{maxAttempts:2,baseDelayMs:1}),{ok:false,reason:'session_changed'});
    assert.equal(db.transactions,2);
  }
  const exhausted=scriptedDb([[conflicts[0]],[conflicts[0]]]);
  await assert.rejects(archive(exhausted,{maxAttempts:2}),/x/);
  assert.equal(exhausted.transactions,2);

  const fatal=scriptedDb([[new Error('disk I/O error')],[CLOCK,{rows:[]}]]);
  await assert.rejects(archive(fatal,{maxAttempts:3}),/disk I\/O error/);
  assert.equal(fatal.transactions,1);

  // A failure to even open the transaction is retried the same way.
  let opens=0;
  const flaky={async transaction(){ opens+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); }};
  await assert.rejects(archiveSecondaryCircle(flaky,PAYLOAD,INPUT,{maxAttempts:3,baseDelayMs:0}),/busy/);
  assert.equal(opens,3);
});
