// Fail-closed branches of pairing publication that the SQLite integration tests
// cannot reach without corrupting a real database: stored-publication
// integrity, configuration and input validation, publisher authorization,
// retryable transaction conflicts, and fail-closed readiness.
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import { resolvePairingCycle } from '../../api/_pairing-cycle.js';

const realAvailability=await import('../../api/_availability.js?cov-p2-real=1');
const realActiveCircle=await import('../../api/_active-circle.js?cov-p2-real=1');

const control={
  ready:true,
  readyError:null,
  scope:Object.freeze({kind:'circle',scopeKey:'circle:1',circleId:1}),
  scopeError:null,
  contextValid:true,
  contextError:null,
  availability:null,
};

mock.module('../../api/_pairing-readiness.js',{exports:{
  pairingSchemaV6Ready:async()=>{
    if(control.readyError) throw control.readyError;
    return control.ready;
  },
}});
mock.module('../../api/_availability.js',{exports:{
  ...realAvailability,
  resolveAvailabilityPublicationScope:async()=>{
    if(control.scopeError) throw control.scopeError;
    return control.scope;
  },
  applyCycleAvailability:async(_db,{scope,cycle,accounts})=>{
    if(control.availability) return control.availability({scope,cycle,accounts});
    const cycleKey=realAvailability.availabilityCycleKey(scope,cycle);
    return accounts.map(account=>({
      ...account,isAvailable:true,cycleKey,availabilityVersion:1,availabilitySource:'user',
    }));
  },
}});
mock.module('../../api/_active-circle.js',{exports:{
  ...realActiveCircle,
  validateActiveCircleMutationContext:async()=>{
    if(control.contextError) throw control.contextError;
    return control.contextValid;
  },
}});

const {
  getPairingPublication,
  PairingPublicationError,
  publishPairingCycle,
}=await import('../../api/_pairing-publication.js');
const { PairingRecoveryError }=await import('../../api/_pairing-recovery.js');

const NOW='2026-09-20T07:00:00.000Z';
const CYCLE=resolvePairingCycle({now:NOW});
const APP_URL='https://randori.example.test';
const KEY='a'.repeat(64);

beforeEach(()=>{
  control.ready=true;
  control.readyError=null;
  control.scope=Object.freeze({kind:'circle',scopeKey:'circle:1',circleId:1});
  control.scopeError=null;
  control.contextValid=true;
  control.contextError=null;
  control.availability=null;
});

function storedPublication(overrides={}){
  const snapshot=[
    {user_id:1,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'user'},
    {user_id:2,source:'auth',availability_cycle_key:KEY,availability_version:0,availability_source:'cycle_default'},
  ];
  return {
    run:{
      week_label:CYCLE.cycleId,week_id:7,generation_token:'token-1',generation:1,
      algorithm_version:'fair-v1',algorithm_seed:'seed',participant_count:2,
      participants_json:JSON.stringify(snapshot),created_at:'2026-09-20 07:00:00',
      ...overrides.run,
    },
    weeks:overrides.weeks||[{id:7,week_label:CYCLE.cycleId,week_start:CYCLE.startsAt,is_demo:0}],
    participants:overrides.participants||[
      {user_id:1,position:0,source:'auth'},
      {user_id:2,position:1,source:'auth'},
    ],
    groups:overrides.groups||[{id:11,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:0}],
  };
}

function readDb(stored){
  return {
    batch:async()=>stored===null
      ?[{rows:[]},{rows:[]},{rows:[]},{rows:[]}]
      :[{rows:stored.runRows||[stored.run]},{rows:stored.weeks},{rows:stored.participants},{rows:stored.groups}],
  };
}

async function assertCode(promise,code){
  await assert.rejects(promise,error=>{
    assert.ok(error instanceof PairingPublicationError||error instanceof PairingRecoveryError,String(error));
    assert.equal(error.code,code);
    return true;
  });
}

test('a complete stored publication is returned frozen and without private fields',async()=>{
  const publication=await getPairingPublication(readDb(storedPublication()),{now:NOW});
  assert.equal(publication.weekId,7);
  assert.equal(publication.cycle.cycleId,CYCLE.cycleId);
  assert.deepEqual(publication.pairs,[{groupId:11,aId:1,bId:2,isAI:false}]);
  assert.deepEqual(publication.algorithm,{version:'fair-v1',seed:'seed'});
  assert.ok(Object.isFrozen(publication)&&Object.isFrozen(publication.pairs[0]));
  assert.equal('participants_json' in publication,false);
});

test('an AI solo pair and a legacy snapshot without availability fields are accepted',async()=>{
  const stored=storedPublication({
    run:{participant_count:1,participants_json:JSON.stringify([{user_id:1,source:'users'}]),created_at:null},
    participants:[{user_id:1,position:0,source:'users'}],
    groups:[{id:3,user_a_id:1,user_b_id:1,is_ai_pair:1}],
  });
  // created_at is required for an intact run, so a missing value fails closed.
  await assertCode(getPairingPublication(readDb(stored),{now:NOW}),'PAIRING_PUBLICATION_INTEGRITY');
  stored.run.created_at='2026-09-20 07:00:00';
  const publication=await getPairingPublication(readDb(stored),{now:NOW});
  assert.deepEqual(publication.pairs,[{groupId:3,aId:1,bId:1,isAI:true}]);
  assert.equal(publication.participants[0].source,'users');
});

test('getPairingPublication rejects missing clients, bad options, and non-current cycles',async()=>{
  await assertCode(getPairingPublication(null,{now:NOW}),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(getPairingPublication({batch:1},{now:NOW}),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(getPairingPublication(readDb(null),null),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(getPairingPublication(readDb(null),[]),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(getPairingPublication(readDb(null),{now:NOW,timeZone:'Not/AZone'}),
    'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(getPairingPublication(readDb(null),{now:NOW,state:'upcoming'}),
    'PAIRING_PUBLICATION_STATE_INVALID');
  assert.equal(await getPairingPublication(readDb(null),{now:NOW}),null);
});

test('a read failure, a legacy unmanaged week, and duplicate runs fail closed',async()=>{
  const cause=new Error('network down');
  await assert.rejects(getPairingPublication({batch:async()=>{ throw cause; }},{now:NOW}),error=>{
    assert.equal(error.code,'PAIRING_PUBLICATION_FAILED');
    assert.equal(error.cause,cause);
    return true;
  });
  await assertCode(getPairingPublication({batch:async()=>[
    {rows:[]},{rows:[{id:1,week_label:CYCLE.cycleId}]},{},undefined,
  ]},{now:NOW}),'PAIRING_PUBLICATION_LEGACY_CONFLICT');
  assert.equal(await getPairingPublication({batch:async()=>[]},{now:NOW}),null);
  const stored=storedPublication();
  stored.runRows=[stored.run,stored.run];
  await assertCode(getPairingPublication(readDb(stored),{now:NOW}),'PAIRING_PUBLICATION_INTEGRITY');
});

const corruptions={
  'run week id':{run:{week_id:0}},
  'run generation':{run:{generation:0}},
  'run participant count':{run:{participant_count:-1}},
  'run generation token':{run:{generation_token:''}},
  'run algorithm version':{run:{algorithm_version:null}},
  'run algorithm seed':{run:{algorithm_seed:''}},
  'week count':{weeks:[]},
  'week id':{weeks:[{id:8,week_label:CYCLE.cycleId,week_start:CYCLE.startsAt,is_demo:0}]},
  'week label':{weeks:[{id:7,week_label:'2020-W01',week_start:CYCLE.startsAt,is_demo:0}]},
  'week start':{weeks:[{id:7,week_label:CYCLE.cycleId,week_start:CYCLE.endsAt,is_demo:0}]},
  'demo week':{weeks:[{id:7,week_label:CYCLE.cycleId,week_start:CYCLE.startsAt,is_demo:1}]},
  'participant rows':{participants:[{user_id:1,position:0,source:'auth'}]},
  'group rows':{groups:[]},
  'snapshot json':{run:{participants_json:'{not json'}},
  'snapshot shape':{run:{participants_json:JSON.stringify({user_id:1})}},
  'snapshot length':{run:{participants_json:JSON.stringify([{user_id:1,source:'auth'}])}},
  'snapshot user id':{run:{participants_json:JSON.stringify([null,{user_id:2,source:'auth'}])}},
  'snapshot duplicate':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth'},{user_id:1,source:'auth'}])}},
  'snapshot source':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'admin'},{user_id:2,source:'auth'}])}},
  'snapshot partial availability':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:KEY},{user_id:2,source:'auth'}])}},
  'snapshot mixed availability modes':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'user'},
    {user_id:2,source:'auth'}])}},
  'snapshot cycle key':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:'xyz',availability_version:1,availability_source:'user'},
    {user_id:2,source:'auth',availability_cycle_key:'xyz',availability_version:1,availability_source:'user'}])}},
  'snapshot version':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:KEY,availability_version:-1,availability_source:'user'},
    {user_id:2,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'user'}])}},
  'snapshot decision source':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'admin'},
    {user_id:2,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'user'}])}},
  'snapshot cycle keys disagree':{run:{participants_json:JSON.stringify([
    {user_id:1,source:'auth',availability_cycle_key:KEY,availability_version:1,availability_source:'user'},
    {user_id:2,source:'auth',availability_cycle_key:'b'.repeat(64),availability_version:1,availability_source:'user'}])}},
  'participant duplicate':{participants:[{user_id:1,position:0,source:'auth'},{user_id:1,position:1,source:'auth'}]},
  'participant position range':{participants:[{user_id:1,position:0,source:'auth'},{user_id:2,position:2,source:'auth'}]},
  'participant position duplicate':{participants:[{user_id:1,position:0,source:'auth'},{user_id:2,position:0,source:'auth'}]},
  'participant position integer':{participants:[{user_id:1,position:0.5,source:'auth'},{user_id:2,position:1,source:'auth'}]},
  'participant source mismatch':{participants:[{user_id:1,position:0,source:'users'},{user_id:2,position:1,source:'auth'}]},
  'participant order mismatch':{participants:[{user_id:2,position:0,source:'auth'},{user_id:1,position:1,source:'auth'}]},
  'participant missing source':{participants:[{user_id:1,position:0},{user_id:2,position:1,source:'auth'}]},
  'group ai flag':{groups:[{id:11,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:2}]},
  'group third member':{groups:[{id:11,user_a_id:1,user_b_id:2,user_c_id:3,is_ai_pair:0}]},
  'group unknown member a':{groups:[{id:11,user_a_id:9,user_b_id:2,is_ai_pair:0}]},
  'group unknown member b':{groups:[{id:11,user_a_id:1,user_b_id:9,is_ai_pair:0}]},
  'group self pair':{groups:[{id:11,user_a_id:1,user_b_id:1,is_ai_pair:0}]},
  'group ai with partner':{groups:[{id:11,user_a_id:1,user_b_id:2,is_ai_pair:1}]},
  'group invalid partner id':{groups:[{id:11,user_a_id:1,user_b_id:'x',is_ai_pair:0}]},
};

for(const [name,overrides] of Object.entries(corruptions)){
  test(`stored publication integrity fails closed on ${name}`,async()=>{
    await assertCode(getPairingPublication(readDb(storedPublication(overrides)),{now:NOW}),
      'PAIRING_PUBLICATION_INTEGRITY');
  });
}

test('grouped coverage must include every participant exactly once',async()=>{
  const snapshot=[1,2,3,4].map(id=>({user_id:id,source:'auth'}));
  const base={
    run:{participant_count:4,participants_json:JSON.stringify(snapshot)},
    participants:[1,2,3,4].map((id,position)=>({user_id:id,position,source:'auth'})),
  };
  await assertCode(getPairingPublication(readDb(storedPublication({...base,groups:[
    {id:1,user_a_id:1,user_b_id:2,is_ai_pair:0},{id:2,user_a_id:2,user_b_id:3,is_ai_pair:0},
  ]})),{now:NOW}),'PAIRING_PUBLICATION_INTEGRITY');
  await assertCode(getPairingPublication(readDb(storedPublication({...base,groups:[
    {id:1,user_a_id:1,user_b_id:2,is_ai_pair:0},{id:2,user_a_id:3,user_b_id:1,is_ai_pair:0},
  ]})),{now:NOW}),'PAIRING_PUBLICATION_INTEGRITY');
  await assertCode(getPairingPublication(readDb(storedPublication({...base,groups:[
    {id:1,user_a_id:1,user_b_id:2,is_ai_pair:0},{id:2,user_a_id:3,user_b_id:3,is_ai_pair:1},
  ]})),{now:NOW}),'PAIRING_PUBLICATION_INTEGRITY');
  const publication=await getPairingPublication(readDb(storedPublication({...base,groups:[
    {id:1,user_a_id:1,user_b_id:2,is_ai_pair:0},{id:2,user_a_id:3,user_b_id:4,is_ai_pair:0},
  ]})),{now:NOW});
  assert.equal(publication.pairs.length,2);
});

// ---- publishPairingCycle with a scripted transactional client ----

function scriptedDb(script={}){
  const log={transactions:0,commits:0,rollbacks:0,closes:0,writes:[],executes:[]};
  let reads=0;
  const execute=async(statement)=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    log.executes.push(sql);
    if(sql.includes('now_utc')) return script.now?script.now():{rows:[{now_utc:NOW}]};
    if(sql.includes('is_admin FROM auth_accounts')) return script.localPublisher?.(statement)||{rows:[]};
    if(sql.includes('membership.role')) return script.publisher?.(statement)||{rows:[{id:1,role:'owner',circle_id:1}]};
    if(sql.includes('is_available')) return script.accounts?script.accounts(statement):{rows:[
      {id:1,email:'one@example.test',is_available:1},{id:2,email:' two@example.test ',is_available:1},
    ]};
    if(sql.includes('group_row.user_a_id')) return script.history?script.history():{rows:[]};
    if(sql.includes('sqlite_schema')) return {rows:[{count:0}]};
    throw new Error(`unexpected SQL ${sql.slice(0,60)}`);
  };
  const batch=async(statements,mode)=>{
    if(mode==='write'){
      log.writes.push(statements);
      if(script.write) return script.write(statements);
      return [];
    }
    reads+=1;
    if(script.read) return script.read(reads);
    return [{rows:[]},{rows:[]},{rows:[]},{rows:[]}];
  };
  const db={
    execute,batch,log,
    transaction:async()=>{
      log.transactions+=1;
      if(script.transaction) await script.transaction(log.transactions);
      return {
        execute,batch,
        commit:async()=>{ log.commits+=1; if(script.commit) await script.commit(); },
        rollback:async()=>{ log.rollbacks+=1; if(script.rollbackError) throw script.rollbackError; },
        close:script.noClose?undefined:async()=>{ log.closes+=1; if(script.closeError) throw script.closeError; },
      };
    },
  };
  return db;
}

function options(overrides={}){
  return {now:NOW,appUrl:APP_URL,localRuntime:false,callerId:null,...overrides};
}

test('publication rejects non-transactional clients and malformed options before any I/O',async()=>{
  await assertCode(publishPairingCycle(null,options()),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle({execute(){},batch(){}},options()),'PAIRING_PUBLICATION_INPUT_INVALID');
  const db=scriptedDb();
  await assertCode(publishPairingCycle(db,null),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle(db,[]),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle(db,{appUrl:APP_URL}),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle(db,options({allowLocalAppUrl:'yes'})),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle(db,options({expectedCycleKey:KEY})),'PAIRING_PUBLISHER_REVOKED');
  assert.equal(db.log.transactions,0);
});

test('the app URL must be one canonical https origin, or loopback http only when local is allowed',async()=>{
  const db=scriptedDb();
  for(const appUrl of [undefined,'',' https://x.test','https://x.test/'.padEnd(2100,'a'),'not a url',
    'https://user:pw@x.test','https://x.test/?q=1','https://x.test/#h','https://x.test/app',
    'http://x.test','https://localhost','http://localhost:3000/path']){
    await assertCode(publishPairingCycle(db,options({appUrl})),'PAIRING_PUBLICATION_CONFIG_INVALID');
  }
  await assertCode(publishPairingCycle(db,options({appUrl:'https://x.test',localRuntime:true})),
    'PAIRING_PUBLICATION_CONFIG_INVALID');
  await assertCode(publishPairingCycle(db,options({appUrl:'http://example.test',allowLocalAppUrl:true})),
    'PAIRING_PUBLICATION_CONFIG_INVALID');
  assert.equal(db.log.transactions,0);
  const local=await publishPairingCycle(publishingDb(),options({
    appUrl:'http://127.0.0.1:3000',allowLocalAppUrl:true,
  }));
  assert.equal(local.appUrl,'http://127.0.0.1:3000');
});

test('schema readiness fails closed when it throws or is anything but true',async()=>{
  control.readyError=new Error('sqlite_schema unreadable');
  const db=scriptedDb();
  await assertCode(publishPairingCycle(db,options()),'PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE');
  control.readyError=null;
  control.ready='true';
  await assertCode(publishPairingCycle(db,options()),'PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE');
  assert.equal(db.log.writes.length,0);
  assert.equal(db.log.rollbacks,2);
  assert.equal(db.log.closes,2);
});

test('publication time comes from the database unless an explicit valid instant is given',async()=>{
  await assertCode(publishPairingCycle(scriptedDb(),options({now:'not a time'})),'PAIRING_PUBLICATION_INPUT_INVALID');
  await assertCode(publishPairingCycle(scriptedDb({now:()=>{ throw new Error('down'); }}),options({now:undefined})),
    'PAIRING_PUBLICATION_FAILED');
  await assertCode(publishPairingCycle(scriptedDb({now:()=>({rows:[]})}),options({now:undefined})),
    'PAIRING_PUBLICATION_FAILED');
  await assertCode(publishPairingCycle(scriptedDb({now:()=>({rows:[{now_utc:'garbage'}]})}),options({now:undefined})),
    'PAIRING_PUBLICATION_FAILED');
  const db=publishingDb();
  const result=await publishPairingCycle(db,options({now:undefined}));
  assert.equal(result.publication.cycle.cycleId,CYCLE.cycleId);
  const fromDate=await publishPairingCycle(publishingDb(),options({now:new Date(NOW)}));
  assert.equal(fromDate.publication.cycle.cycleId,CYCLE.cycleId);
});

test('a changed authorized scope revokes the publisher before any read of publications',async()=>{
  const db=scriptedDb();
  for(const authorizedScope of [
    {kind:'local',scopeKey:'circle:1',circleId:1},
    {kind:'circle',scopeKey:'circle:2',circleId:1},
    {kind:'circle',scopeKey:'circle:1',circleId:2},
  ]){
    await assertCode(publishPairingCycle(db,options({authorizedScope})),'PAIRING_PUBLISHER_REVOKED');
  }
  control.scope=null;
  await assertCode(publishPairingCycle(db,options({authorizedScope:{kind:'circle',scopeKey:'circle:1',circleId:1}})),
    'PAIRING_PUBLISHER_REVOKED');
  assert.equal(db.log.writes.length,0);
});

test('publisher authorization is rechecked inside the transaction for owners and local admins',async()=>{
  await assertCode(publishPairingCycle(scriptedDb(),options({callerId:0})),'PAIRING_PUBLICATION_INPUT_INVALID');
  control.contextError=new Error('context lookup failed');
  await assertCode(publishPairingCycle(scriptedDb(),options({callerId:1,circleContext:{payload:{}}})),
    'PAIRING_PUBLICATION_FAILED');
  control.contextError=null;
  control.contextValid=false;
  await assertCode(publishPairingCycle(scriptedDb(),options({callerId:1,circleContext:{payload:{}}})),
    'PAIRING_CONTEXT_CHANGED');
  control.contextValid=true;
  await assertCode(publishPairingCycle(scriptedDb({publisher:()=>{ throw new Error('down'); }}),options({callerId:1})),
    'PAIRING_PUBLICATION_FAILED');
  for(const rows of [[],[{id:1,role:'member',circle_id:1}],[{id:1,role:'owner',circle_id:2}],
    [{id:2,role:'owner',circle_id:1}],[{id:1,role:'owner',circle_id:1},{id:1,role:'owner',circle_id:1}]]){
    await assertCode(publishPairingCycle(scriptedDb({publisher:()=>({rows})}),options({callerId:1})),
      'PAIRING_PUBLISHER_REVOKED');
  }
  await assertCode(publishPairingCycle(scriptedDb({publisher:()=>({})}),options({callerId:1})),
    'PAIRING_PUBLISHER_REVOKED');

  control.scope=Object.freeze({kind:'local',scopeKey:'local',circleId:null});
  const local={appUrl:'http://localhost:3000',localRuntime:true,callerId:1};
  await assertCode(publishPairingCycle(scriptedDb({localPublisher:()=>({rows:[{id:1,is_admin:0}]})}),options(local)),
    'PAIRING_PUBLISHER_REVOKED');
  let args;
  const ok=await publishPairingCycle(publishingDb({
    localPublisher:statement=>{ args=statement.args; return {rows:[{id:1,is_admin:1}]}; },
  }),options(local));
  assert.deepEqual(args,[1]);
  assert.equal(ok.created,true);
});

// Return an empty state for the pre-write reads, then a coherent stored
// publication mirroring whatever the write batch inserted.
function readAfterWrite({tokenOverride}={}){
  const reader=()=>reader.written?reader.stored:[{rows:[]},{rows:[]},{rows:[]},{rows:[]}];
  reader.written=false;
  reader.capture=(statements)=>{
    const run=statements[0].args;
    const snapshot=JSON.parse(run[5]);
    const participants=snapshot.map((item,position)=>({user_id:item.user_id,position,source:item.source}));
    const groups=statements.filter(item=>item.sql.includes('INSERT INTO pairing_groups'))
      .map((item,index)=>({id:index+1,user_a_id:item.args[0],user_b_id:item.args[1],user_c_id:null,is_ai_pair:item.args[2]}));
    reader.stored=[
      {rows:[{week_label:run[0],week_id:5,generation_token:tokenOverride||run[1],generation:1,
        algorithm_version:run[2],algorithm_seed:run[3],participant_count:run[4],participants_json:run[5],
        created_at:'2026-09-20 07:00:00'}]},
      {rows:[{id:5,week_label:run[0],week_start:CYCLE.startsAt,is_demo:0}]},
      {rows:participants},
      {rows:groups},
    ];
    reader.written=true;
    return statements;
  };
  return reader;
}

function publishingDb(script={},readerOptions){
  const reader=readAfterWrite(readerOptions);
  const db=scriptedDb({
    ...script,
    read:reader,
    write:(statements)=>{ reader.capture(statements); return script.write?.(statements)||[]; },
  });
  db.reader=reader;
  return db;
}

test('a fresh publication writes token-guarded rows and one outbox event per recipient',async()=>{
  const db=publishingDb({accounts:()=>({rows:[
    {id:1,email:'one@example.test',is_available:1},
    {id:2,email:'',is_available:1},
    {id:3,email:'three@example.test',is_available:0},
  ]})});
  control.availability=({scope,cycle,accounts})=>{
    const cycleKey=realAvailability.availabilityCycleKey(scope,cycle);
    return accounts.map(account=>({...account,isAvailable:account.id!==3,cycleKey,
      availabilityVersion:1,availabilitySource:'user'}));
  };
  const result=await publishPairingCycle(db,options());
  assert.equal(result.created,true);
  assert.equal(result.publicationState.state,'published');
  assert.equal(result.appUrl,APP_URL);
  const outbox=db.log.writes[0].filter(item=>item.sql.includes('outbox_events'));
  assert.deepEqual(outbox.map(item=>[item.args[0],item.args[1]]),[['paired',1],['unavailable',3]]);
  assert.equal(db.log.commits,1);
  assert.equal(db.log.writes[0].some(item=>item.sql.includes('chat_retention')),false);
});

test('a concurrent claim with a different generation token reports created=false',async()=>{
  const db=publishingDb({},{tokenOverride:'someone-else'});
  const result=await publishPairingCycle(db,options());
  assert.equal(result.created,false);
  assert.equal(result.publication.weekId,5);
});

test('an existing publication is replayed idempotently with a rollback and no writes',async()=>{
  const stored=storedPublication();
  const db=scriptedDb({read:()=>[{rows:[stored.run]},{rows:stored.weeks},{rows:stored.participants},{rows:stored.groups}]});
  const result=await publishPairingCycle(db,options());
  assert.equal(result.created,false);
  assert.equal(result.publicationState.state,'published');
  assert.equal('can_publish_now' in result.publicationState,false);
  assert.equal(db.log.writes.length,0);
  assert.equal(db.log.commits,0);
  assert.ok(db.log.rollbacks>=1);
});

test('owner recovery is fenced by the exact cycle key and the grace period',async()=>{
  const scope=control.scope;
  const cycleKey=realAvailability.availabilityCycleKey(scope,CYCLE);
  await assertCode(publishPairingCycle(scriptedDb(),options({callerId:1,expectedCycleKey:'b'.repeat(64)})),
    'PAIRING_RECOVERY_CYCLE_CHANGED');
  // NOW is exactly the BST cutoff (08:00 Europe/London), so recovery is still
  // inside its 30 minute grace period.
  await assertCode(publishPairingCycle(scriptedDb(),options({callerId:1,expectedCycleKey:cycleKey})),
    'PAIRING_RECOVERY_NOT_READY');
  const graceEnd=new Date(Date.parse(CYCLE.cutoffAt)+30*60_000);
  await assertCode(publishPairingCycle(scriptedDb(),options({
    now:new Date(graceEnd.getTime()-1),callerId:1,expectedCycleKey:cycleKey,
  })),'PAIRING_RECOVERY_NOT_READY');
  const overdue=publishingDb();
  const result=await publishPairingCycle(overdue,options({now:graceEnd,callerId:1,expectedCycleKey:cycleKey}));
  assert.equal(result.created,true);
  assert.equal(result.publicationState.state,'published');
  assert.equal(result.publicationState.can_publish_now,false);
  await assertCode(publishPairingCycle(scriptedDb(),options({
    now:graceEnd,callerId:1,expectedCycleKey:'not-a-key',
  })),'PAIRING_RECOVERY_INPUT_INVALID');
});

test('eligibility reads fail closed on errors and duplicate or invalid account rows',async()=>{
  await assertCode(publishPairingCycle(scriptedDb({accounts:()=>{ throw new Error('down'); }}),options()),
    'PAIRING_PUBLICATION_FAILED');
  await assertCode(publishPairingCycle(scriptedDb({accounts:()=>({rows:[{id:1},{id:1}]})}),options()),
    'PAIRING_PUBLICATION_INTEGRITY');
  await assertCode(publishPairingCycle(scriptedDb({accounts:()=>({rows:[{id:'nope'}]})}),options()),
    'PAIRING_PUBLICATION_INTEGRITY');
  await assertCode(publishPairingCycle(scriptedDb({history:()=>{ throw new Error('down'); }}),options()),
    'PAIRING_PUBLICATION_FAILED');
  const empty=publishingDb({accounts:()=>({}),history:()=>({})});
  const result=await publishPairingCycle(empty,options());
  assert.equal(result.publication.participantCount,0);
  assert.deepEqual(result.publication.pairs,[]);
});

test('local publication reads every non-demo account without a circle argument',async()=>{
  control.scope=Object.freeze({kind:'local',scopeKey:'local',circleId:null});
  let accountStatement;
  const db=publishingDb({accounts:statement=>{ accountStatement=statement; return {rows:[{id:4,email:'x@y.test',is_available:1}]}; }});
  await publishPairingCycle(db,options({appUrl:'http://localhost',localRuntime:true}));
  assert.equal(typeof accountStatement,'string');
  assert.match(accountStatement,/COALESCE\(is_demo,0\)=0/);
});

test('availability snapshots and notification recipients are validated before the write',async()=>{
  const bad=(mutate)=>({scope,cycle,accounts})=>{
    const cycleKey=realAvailability.availabilityCycleKey(scope,cycle);
    return mutate(accounts.map(account=>({...account,isAvailable:true,cycleKey,availabilityVersion:1,availabilitySource:'user'})));
  };
  for(const mutate of [
    rows=>rows.map(row=>({...row,cycleKey:'nope'})),
    rows=>rows.map(row=>({...row,availabilityVersion:-1})),
    rows=>rows.map(row=>({...row,availabilitySource:'admin'})),
    rows=>[...rows,rows[0]],
    rows=>[...rows,{...rows[0],id:9,isAvailable:false},{...rows[0],id:9,isAvailable:false}],
  ]){
    control.availability=bad(mutate);
    const db=scriptedDb();
    await assertCode(publishPairingCycle(db,options()),'PAIRING_PUBLICATION_INPUT_INVALID');
    assert.equal(db.log.writes.length,0);
  }
  control.availability=({accounts})=>accounts.map(account=>({...account,isAvailable:true}));
  const legacy=publishingDb();
  const result=await publishPairingCycle(legacy,options());
  const snapshot=JSON.parse(legacy.log.writes[0][0].args[5]);
  assert.deepEqual(snapshot,[{user_id:1,source:'auth'},{user_id:2,source:'auth'}]);
  assert.equal(result.created,true);
});

test('a failed write batch or a missing post-write publication is not reported as success',async()=>{
  const cause=new Error('constraint failed');
  await assert.rejects(publishPairingCycle(scriptedDb({write:()=>{ throw cause; }}),options()),error=>{
    assert.equal(error.code,'PAIRING_PUBLICATION_FAILED');
    assert.equal(error.cause,cause);
    return true;
  });
  const db=scriptedDb();
  await assertCode(publishPairingCycle(db,options()),'PAIRING_PUBLICATION_INTEGRITY');
  assert.equal(db.log.commits,0);
});

test('a chat retention table registers the publication scope in the same write batch',async()=>{
  const db=publishingDb();
  const original=db.transaction;
  db.transaction=async()=>{
    const tx=await original();
    const txExecute=tx.execute;
    tx.execute=async(statement)=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('sqlite_schema')) return {rows:[{count:1}]};
      return txExecute(statement);
    };
    return tx;
  };
  await publishPairingCycle(db,options());
  assert.ok(db.log.writes[0].some(item=>/chat_retention_scopes/.test(item.sql)));
});

test('retryable lock conflicts are retried and a persistent conflict is surfaced',async()=>{
  let attempts=0;
  const db=publishingDb({transaction:()=>{
    attempts+=1;
    if(attempts===1) throw Object.assign(new Error('x'),{code:'SQLITE_BUSY'});
    if(attempts===2) throw new Error('wrapped',{cause:new Error('SQLITE_LOCKED: database table is locked')});
  }});
  const result=await publishPairingCycle(db,options());
  assert.equal(result.created,true);
  assert.equal(attempts,3);

  const busy=scriptedDb({transaction:()=>{ throw new Error('database is busy'); }});
  await assert.rejects(publishPairingCycle(busy,options()),error=>{
    assert.equal(error.code,'PAIRING_PUBLICATION_FAILED');
    assert.equal(error.cause.message,'database is busy');
    return true;
  });
  assert.equal(busy.log.transactions,4);

  const raw=scriptedDb({transaction:()=>{ throw Object.assign(new Error('x'),{rawCode:'libsql_transaction_busy'}); }});
  await assertCode(publishPairingCycle(raw,options()),'PAIRING_PUBLICATION_FAILED');
  assert.equal(raw.log.transactions,4);

  const fatal=scriptedDb({transaction:()=>{ throw new Error('disk I/O error'); }});
  await assertCode(publishPairingCycle(fatal,options()),'PAIRING_PUBLICATION_FAILED');
  assert.equal(fatal.log.transactions,1);
});

test('a conflict during commit is never retried because the outcome is ambiguous',async()=>{
  const db=publishingDb({
    commit:()=>{ throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}); },
    rollbackError:new Error('rollback failed'),
    closeError:new Error('close failed'),
  });
  await assertCode(publishPairingCycle(db,options()),'PAIRING_PUBLICATION_FAILED');
  assert.equal(db.log.transactions,1);
  assert.equal(db.log.closes,1);
});

test('a retry that ends in a typed publication error rethrows that error unchanged',async()=>{
  let attempts=0;
  const db=scriptedDb({noClose:true,transaction:()=>{
    attempts+=1;
    if(attempts===1) throw Object.assign(new Error('x'),{code:'SQLITE_LOCKED_SHAREDCACHE'});
  }});
  control.scopeError=new PairingPublicationError('PAIRING_SCOPE_TEST','scope unavailable');
  await assertCode(publishPairingCycle(db,options()),'PAIRING_SCOPE_TEST');
  assert.equal(attempts,2);
});
