import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  CircleCreationError,
  createCircleAndSelect,
  ensureCircleCreationReadiness,
  parseCircleCreation,
} from '../../api/_circle-creation.js';

const HASH='a'.repeat(64);
const PAYLOAD=Object.freeze({id:5,sessionHash:HASH});
const INPUT=Object.freeze({name:'Weekend Kata',requestId:'request-0123456789abcdef'});
const UUID='12345678-1234-4123-8123-123456789abc';
const PUBLIC_ID='circle_12345678123441238123123456789abc';
const NOW={rows:[{now_seconds:1_795_000_000}]};
const LIVE={rows:[{id:5}]};
const NO_RECEIPT={rows:[]};
const LIMITS={rows:[{active_memberships:1,owned_circles:1}]};

const digest=(domain,value)=>createHash('sha256').update(`${domain}\0${value}`,'utf8').digest('hex');
const REQUEST_HASH=digest('randori-circle-create-request-v1',INPUT.requestId);
const FINGERPRINT=digest('randori-circle-create-name-v1',INPUT.name);

function receipt(overrides={}){
  return {rows:[{circle_id:30,request_fingerprint:FINGERPRINT,initiating_session_hash:HASH,context_version:3,
    audit_event_id:9,public_id:'circle_existing',name:INPUT.name,is_primary:0,archived_at:null,role:'owner',
    status:'active',audit_circle_id:30,event_type:'circle.created',actor_user_id:5,subject_user_id:5,
    invitation_id:null,dedupe_key:`circle-created:5:${REQUEST_HASH}`,selected_circle_id:30,
    selected_context_version:3,...overrides}]};
}

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
        async rollback(){ log.push('rollback'); },
        async close(){ log.push('close'); throw new Error('close errors are ignored'); },
      };
    },
  };
}

const create=(db,options={})=>createCircleAndSelect(db,PAYLOAD,INPUT,{randomUuid:()=>UUID,maxAttempts:1,...options});
const writes=(circleId=31)=>[
  {rows:[{id:circleId,public_id:PUBLIC_ID,name:INPUT.name}]},{rows:[{circle_id:circleId}]},
  {rows:[{id:77}]},{rows:[{circle_id:circleId}]},
];

test('creation body parsing rejects non-canonical names and request ids',()=>{
  assert.deepEqual(parseCircleCreation({name:'Kata',request_id:'a'.repeat(16)}),{name:'Kata',requestId:'a'.repeat(16)});
  for(const body of [
    null,{name:'Kata'},{name:'Kata',request_id:'a'.repeat(16),x:1},
    {name:' Kata',request_id:'a'.repeat(16)},{name:'',request_id:'a'.repeat(16)},
    {name:'é',request_id:'a'.repeat(16)},{name:'a\u0007b',request_id:'a'.repeat(16)},
    {name:'x'.repeat(81),request_id:'a'.repeat(16)},{name:'\u{1F600}'.repeat(61),request_id:'a'.repeat(16)},
    {name:'Kata',request_id:'short'},{name:'Kata',request_id:16},{name:'Kata',request_id:'a'.repeat(15)+'!'},
  ]){
    assert.throws(()=>parseCircleCreation(body),error=>error instanceof CircleCreationError
      &&error.code==='CIRCLE_CREATE_INPUT_INVALID');
  }
});

test('readiness is cached per client after success and evicted after failure',async()=>{
  await assert.rejects(ensureCircleCreationReadiness(null),TypeError);
  let calls=0;
  const ok={async execute(sql){ calls+=1; assert.match(sql,/FROM circle_creation_requests LIMIT 0/); return {rows:[]}; }};
  assert.equal(await ensureCircleCreationReadiness(ok),true);
  await ensureCircleCreationReadiness(ok);
  assert.equal(calls,1);

  let attempts=0;
  const flaky={async execute(){ attempts+=1; if(attempts===1) throw new Error('no such table'); return {rows:[]}; }};
  await assert.rejects(ensureCircleCreationReadiness(flaky),/no such table/);
  assert.equal(await ensureCircleCreationReadiness(flaky),true);
  assert.equal(attempts,2);
});

test('creation request validation fails before opening a transaction',async()=>{
  const db=scriptedDb([]);
  for(const [payload,input,options] of [
    [{id:5,sessionHash:'x'},INPUT,{}],[{uid:'05',sessionHash:HASH},INPUT,{}],[{id:0,sessionHash:HASH},INPUT,{}],
    [PAYLOAD,null,{}],[PAYLOAD,[],{}],[PAYLOAD,{name:1,requestId:'x'},{}],[PAYLOAD,{name:'x',requestId:1},{}],
    [PAYLOAD,INPUT,{maxAttempts:0}],[PAYLOAD,INPUT,{maxAttempts:6}],
  ]){
    await assert.rejects(createCircleAndSelect(db,payload,input,options),TypeError);
  }
  await assert.rejects(createCircleAndSelect({},PAYLOAD,INPUT),TypeError);
  assert.equal(db.transactions,0);
});

test('unusable clocks and changed sessions stop before reading receipts',async()=>{
  await assert.rejects(create(scriptedDb([{rows:[{now_seconds:0}]}])),
    error=>error.code==='CIRCLE_CREATE_UNAVAILABLE'&&error instanceof CircleCreationError);
  // The uid alias is honoured as the actor identity.
  const db=scriptedDb([NOW,{rows:[]}]);
  assert.deepEqual(await createCircleAndSelect(db,{uid:'5',sessionHash:HASH},INPUT,{maxAttempts:1}),
    {ok:false,reason:'session_changed'});
  assert.deepEqual(db.statements[1].args,[HASH,5,1_795_000_000]);
});

test('an existing receipt replays only for the same name, session, and unchanged context',async()=>{
  const replay=await create(scriptedDb([NOW,LIVE,receipt()]));
  assert.deepEqual(replay,{ok:true,circle:{public_id:'circle_existing',name:INPUT.name,role:'owner',is_primary:false},
    context_version:3,created:false});

  for(const conflict of [{request_fingerprint:'0'.repeat(64)},{initiating_session_hash:'b'.repeat(64)}]){
    assert.deepEqual(await create(scriptedDb([NOW,LIVE,receipt(conflict)])),{ok:false,reason:'request_conflict'});
  }
  for(const corrupt of [{name:'Other'},{is_primary:1},{audit_circle_id:31},{event_type:'circle.archived'},
    {actor_user_id:6},{subject_user_id:6},{invitation_id:'x'},{dedupe_key:'circle-created:5:other'}]){
    await assert.rejects(create(scriptedDb([NOW,LIVE,receipt(corrupt)])),error=>error.code==='CIRCLE_CREATE_INTEGRITY');
  }
  for(const changed of [{archived_at:'2026-01-01'},{role:'member'},{status:'removed'},{selected_circle_id:10},
    {selected_context_version:4}]){
    assert.deepEqual(await create(scriptedDb([NOW,LIVE,receipt(changed)])),{ok:false,reason:'context_changed'});
  }
  await assert.rejects(create(scriptedDb([NOW,LIVE,receipt({context_version:0,selected_context_version:0})])),
    error=>error.code==='CIRCLE_CREATE_INTEGRITY');
  await assert.rejects(create(scriptedDb([NOW,LIVE,{rows:[{},{}]}])),error=>error.code==='CIRCLE_CREATE_INTEGRITY');
});

test('ownership and membership ceilings and corrupt counts block creation',async()=>{
  assert.deepEqual(await create(scriptedDb([NOW,LIVE,NO_RECEIPT,{rows:[{active_memberships:100,owned_circles:0}]}])),
    {ok:false,reason:'membership_limit'});
  assert.deepEqual(await create(scriptedDb([NOW,LIVE,NO_RECEIPT,{rows:[{active_memberships:10,owned_circles:10}]}])),
    {ok:false,reason:'ownership_limit'});
  for(const limits of [{rows:[]},{rows:[{active_memberships:-1,owned_circles:0}]},
    {rows:[{active_memberships:1,owned_circles:'x'}]}]){
    await assert.rejects(create(scriptedDb([NOW,LIVE,NO_RECEIPT,limits])),error=>error.code==='CIRCLE_CREATE_INTEGRITY');
  }
});

test('corrupt contexts, bad generated identities, and missing writes roll back as integrity failures',async()=>{
  const base=[NOW,LIVE,NO_RECEIPT,LIMITS];
  const cases=[
    [[{rows:[{},{}]}]],
    [[{rows:[{circle_id:1,context_version:-1}]}]],
    [[{rows:[{circle_id:1,context_version:Number.MAX_SAFE_INTEGER}]}]],
    [[NO_RECEIPT],{randomUuid:()=>'not-a-uuid'}],
    [[NO_RECEIPT,{rows:[]}]],
    [[NO_RECEIPT,{rows:[{id:0}]}]],
    [[NO_RECEIPT,writes()[0],{rows:[]}]],
    [[NO_RECEIPT,...writes().slice(0,2),{rows:[]}]],
    [[NO_RECEIPT,...writes().slice(0,3),{rows:[]}]],
  ];
  for(const [tail,options] of cases){
    const db=scriptedDb([...base,...tail]);
    await assert.rejects(create(db,options),error=>error instanceof CircleCreationError
      &&error.code==='CIRCLE_CREATE_INTEGRITY');
    assert.ok(db.log.includes('rollback'));
    assert.ok(!db.log.includes('commit'));
  }
});

test('creation selects the new circle by inserting or advancing the session context',async()=>{
  const inserted=scriptedDb([NOW,LIVE,NO_RECEIPT,LIMITS,NO_RECEIPT,...writes(),{rows:[{circle_id:31,context_version:1}]}]);
  assert.deepEqual(await create(inserted),{ok:true,circle:{public_id:PUBLIC_ID,name:INPUT.name,role:'owner',
    is_primary:false},context_version:1,created:true});
  assert.match(inserted.statements.at(-1).sql,/INSERT INTO auth_session_circle_contexts/);
  assert.equal(inserted.statements[5].args[0],PUBLIC_ID);
  assert.equal(inserted.statements[5].args[1],'circle-12345678123441238123123456789abc');

  const advanced=scriptedDb([NOW,LIVE,NO_RECEIPT,LIMITS,{rows:[{circle_id:10,context_version:6}]},...writes(),
    {rows:[{circle_id:31,context_version:7}]}]);
  assert.equal((await create(advanced)).context_version,7);
  assert.match(advanced.statements.at(-1).sql,/UPDATE auth_session_circle_contexts/);

  for(const context of [{rows:[]},{rows:[{circle_id:32,context_version:1}]},{rows:[{circle_id:31,context_version:2}]}]){
    const db=scriptedDb([NOW,LIVE,NO_RECEIPT,LIMITS,NO_RECEIPT,...writes(),context]);
    await assert.rejects(create(db),error=>error.code==='CIRCLE_CREATE_CONTEXT_CHANGED');
    assert.ok(!db.log.includes('commit'));
  }
});

test('commit ambiguity is never retried while conflicts and unique races are',async()=>{
  const success=[NOW,LIVE,NO_RECEIPT,LIMITS,NO_RECEIPT,...writes(),{rows:[{circle_id:31,context_version:1}]}];
  const busy=Object.assign(new Error('busy'),{code:'SQLITE_BUSY'});
  const ambiguous=scriptedDb(success,{commitError:busy});
  await assert.rejects(create(ambiguous,{maxAttempts:3}),error=>error.code==='CIRCLE_CREATE_COMMIT_UNKNOWN'
    &&error.cause===busy);
  assert.equal(ambiguous.transactions,1);

  const unique=Object.assign(new Error('SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: circles.public_id'),
    {code:'SQLITE_CONSTRAINT_UNIQUE'});
  const raced=scriptedDb([[NOW,LIVE,NO_RECEIPT,LIMITS,NO_RECEIPT,unique],success]);
  assert.equal((await create(raced,{maxAttempts:2})).created,true);
  assert.equal(raced.transactions,2);

  const receiptRace=new Error('SQLITE_CONSTRAINT_UNIQUE: circle_creation_requests.actor_user_id, circle_creation_requests.request_hash');
  const replayed=scriptedDb([[NOW,LIVE,NO_RECEIPT,LIMITS,NO_RECEIPT,...writes().slice(0,3),receiptRace],
    [NOW,LIVE,receipt()]]);
  assert.equal((await create(replayed,{maxAttempts:2})).created,false);

  // Unrelated unique failures and generic errors are not retried and stay opaque.
  const unrelated=Object.assign(new Error('UNIQUE constraint failed: other.column'),{code:'SQLITE_CONSTRAINT_UNIQUE'});
  for(const failure of [unrelated,new Error('disk I/O error')]){
    const db=scriptedDb([[NOW,failure],success]);
    await assert.rejects(create(db,{maxAttempts:3}),error=>error.code==='CIRCLE_CREATE_UNAVAILABLE'&&error.cause===failure);
    assert.equal(db.transactions,1);
  }
  // Exhausted lock conflicts surface as unavailable, not as the raw driver error.
  const locked=scriptedDb([[new Error('database is locked')],[new Error('SQLITE_BUSY - database is locked')]]);
  await assert.rejects(create(locked,{maxAttempts:2}),error=>error.code==='CIRCLE_CREATE_UNAVAILABLE');
  assert.equal(locked.transactions,2);
  let opens=0;
  const nested={async transaction(){ opens+=1;
    throw new Error('outer',{cause:Object.assign(new Error('inner'),{rawCode:'sqlite_locked_sharedcache'})}); }};
  await assert.rejects(createCircleAndSelect(nested,PAYLOAD,INPUT,{maxAttempts:2}),
    error=>error.code==='CIRCLE_CREATE_UNAVAILABLE');
  assert.equal(opens,2);
});
