import assert from 'node:assert/strict';
import {afterEach,beforeEach,mock,test} from 'node:test';
import {resolvePairingCycle} from '../../api/_pairing-cycle.js';

const SECRET_DATABASE_ERROR='private database diagnostic with sensitive details';
const realFetch=globalThis.fetch;
let currentDb=null;
let providerCalls=0;

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test',name:'Member'};
  if(identity==='member-string') return {id:'2',email:'member@example.test',name:'Member'};
  if(identity==='malformed') return {id:'2x',email:'member@example.test',name:'Member'};
  if(identity==='unsafe') return {id:'9007199254740992',email:'member@example.test',name:'Member'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getJwtSecret:()=>'pair-access-failure-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,
    verifySignedRequestAuth:authPayload,
  },
});

const [{default:dataHandler},{listPublicExercises}]=await Promise.all([
  import('../../api/data.js'),
  import('../../api/_catalog.js'),
]);

function rows(values=[],extra={}){
  return {rows:values,rowsAffected:0,...extra};
}

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function currentPairingFixture(sql){
  const cycle=resolvePairingCycle();
  const cycleId=cycle.cycleId;
  const startsAt=cycle.startsAt;
  if(sql.includes('SELECT aa.id,c.id AS circle_id')&&sql.includes('LIMIT 2')) return rows([{id:2,circle_id:1}]);
  if(sql.includes('FROM pairing_week_runs WHERE week_label=?')) return rows([{
    week_label:cycleId,week_id:10,generation_token:'published-token',generation:1,
    algorithm_version:'fair-v2',algorithm_seed:`${cycleId}:weekly`,participant_count:2,
    participants_json:'[{"user_id":2,"source":"auth"},{"user_id":4,"source":"auth"}]',created_at:startsAt,
  }]);
  if(sql.includes('FROM pairing_weeks WHERE week_label=?')) return rows([{id:10,week_label:cycleId,week_start:startsAt,is_demo:0}]);
  if(sql.includes('FROM pairing_participants pp')) return rows([
    {user_id:2,position:0,source:'auth'},{user_id:4,position:1,source:'auth'},
  ]);
  if(sql.includes('FROM pairing_groups pg')&&sql.includes('JOIN pairing_week_runs pwr')) return rows([{
    id:20,user_a_id:2,user_b_id:4,user_c_id:null,is_ai_pair:0,
  }]);
  if(sql.includes('SELECT aa.id,aa.display_name AS name,aa.color')) return rows([
    {id:2,name:'Member',color:'#654321'},{id:4,name:'Partner',color:'#123456'},
  ]);
  return null;
}

function mockDb(executeHandler){
  const db={
    async execute(statement){
      const sql=sqlText(statement);
      const result=await executeHandler(sql,statement?.args||[]);
      if((result?.rows?.length||0)>0||(result?.rowsAffected||0)>0) return result;
      return currentPairingFixture(sql)||result;
    },
    async batch(statements,mode){
      if(mode==='write'&&statements.length===2&&sqlText(statements[1]).includes(`event='execute_attempt'`)){
        return [rows(),rows([{c:1}])];
      }
      const results=[];
      for(const statement of statements) results.push(await db.execute(statement));
      return results;
    },
  };
  return db;
}

function invoke({method='GET',url='/',query={},body={},headers={'x-test-auth':'member'}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      setHeader(){},
      json(payload){ finish(payload); return this; },
      end(payload){ finish(payload); },
    };
    const request={method,url,query,body,headers,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

function assertGenericUnavailable(response,error){
  assert.equal(response.status,503);
  assert.deepEqual(response.body,error);
  assert.equal(JSON.stringify(response.body).includes(SECRET_DATABASE_ERROR),false);
  assert.equal('detail' in response.body,false);
}

function latestWeek(){
  return {id:10,week_label:'2026-W38',week_start:'2026-09-14',focus:'both'};
}

function isCurrentPublicationQuery(sql){
  return sql.includes('FROM pairing_week_runs WHERE week_label=?');
}

function pairAccess(){
  return {
    pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:null,
    is_ai_pair:0,topic:'Arrays',topic_kind:'dsa',
  };
}

beforeEach(()=>{
  currentDb=null;
  providerCalls=0;
  globalThis.fetch=realFetch;
  delete process.env.TURSO_DATABASE_URL;
});

afterEach(()=>{
  globalThis.fetch=realFetch;
});

test('my-pair reports source-aware membership query failures as generic unavailable',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.includes('FROM pairing_participants pp')) throw new Error(SECRET_DATABASE_ERROR);
    return rows();
  });
  const response=await invoke({url:'/api/my-pair',query:{endpoint:'my-pair'}});
  assertGenericUnavailable(response,{error:'pairing unavailable'});
});

test('my-pair normalizes numeric-string IDs and rejects malformed authenticated claims before storage',async()=>{
  const calls=[];
  currentDb=mockDb((sql,args)=>{
    calls.push({sql,args});
    if(sql.includes('SELECT aa.id,aa.display_name,aa.color,aa.bio')&&sql.includes('WITH pair_access AS')) return rows([{
      id:4,display_name:'Partner',color:'#123456',bio:'',tz:'UTC',interview_focus:'both',leetcode_handle:'',
    }]);
    if(sql.includes('FROM pair_schedules')&&sql.includes('WITH pair_access AS')){
      return rows([{
        id:null,week_id:null,pair_group_id:null,proposed_times:null,
        agreed_time:null,updated_at:null,access_present:1,
      }]);
    }
    if(sql.includes('SELECT id, display_name, color, tz')){
      return rows([{id:2,display_name:'Member',color:'#654321',tz:'UTC',interview_focus:'both'}]);
    }
    return rows();
  });
  const accepted=await invoke({
    url:'/api/my-pair',query:{endpoint:'my-pair'},headers:{'x-test-auth':'member-string'},
  });
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.paired,true);
  const membershipCall=calls.find(call=>call.sql.includes('SELECT aa.id,c.id AS circle_id'));
  assert.deepEqual(membershipCall.args,[2]);

  let storageCalls=0;
  currentDb=mockDb(()=>{ storageCalls+=1; throw new Error('must not reach storage'); });
  for(const identity of ['malformed','unsafe']){
    const rejected=await invoke({
      url:'/api/my-pair',query:{endpoint:'my-pair'},headers:{'x-test-auth':identity},
    });
    assert.equal(rejected.status,401);
    assert.deepEqual(rejected.body,{error:'authentication required'});
  }
  assert.equal(storageCalls,0);
});

test('my-pair reports database setup and latest-week failures as generic unavailable',async()=>{
  currentDb=null;
  const setupFailure=await invoke({url:'/api/my-pair',query:{endpoint:'my-pair'}});
  assertGenericUnavailable(setupFailure,{error:'pairing unavailable'});

  currentDb=mockDb(sql=>{
    if(isCurrentPublicationQuery(sql)){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    return rows();
  });
  const weekFailure=await invoke({url:'/api/my-pair',query:{endpoint:'my-pair'}});
  assertGenericUnavailable(weekFailure,{error:'pairing unavailable'});
});

test('my-pair does not continue when its final source-aware schedule check fails',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.includes('FROM pair_schedules')&&sql.includes('WITH pair_access AS')){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    if(sql.includes('SELECT aa.id,aa.display_name,aa.color,aa.bio')&&sql.includes('WITH pair_access AS')) return rows([{
      id:4,display_name:'Partner',color:'#123456',bio:'',tz:'UTC',interview_focus:'both',leetcode_handle:'',
    }]);
    return rows();
  });
  const response=await invoke({url:'/api/my-pair',query:{endpoint:'my-pair'}});
  assertGenericUnavailable(response,{error:'pairing unavailable'});
});

test('pair run readiness and access failures return generic 503 responses',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.includes('SELECT week_id,user_id,source FROM pairing_participants LIMIT 0')){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    return rows();
  });
  const readinessFailure=await invoke({
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
  });
  assertGenericUnavailable(readinessFailure,{error:'runs unavailable'});

  currentDb=mockDb(sql=>{
    if(sql.includes('FROM pairing_groups AS pg')&&sql.includes("viewer.source='auth'")){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    return rows();
  });
  const accessFailure=await invoke({
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
  });
  assertGenericUnavailable(accessFailure,{error:'runs unavailable'});
});

test('pair runs normalize numeric-string IDs and reject malformed authenticated claims before storage',async()=>{
  const calls=[];
  currentDb=mockDb((sql,args)=>{
    calls.push({sql,args});
    if(sql.startsWith('SELECT pg.id AS pair_group_id')) return rows([pairAccess()]);
    if(sql.includes('WITH pair_access AS')&&sql.includes('FROM session_runs sr')) return rows([{id:null}]);
    return rows();
  });
  const accepted=await invoke({
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
    headers:{'x-test-auth':'member-string'},
  });
  assert.equal(accepted.status,200);
  assert.deepEqual(accepted.body.runs,[]);
  const accessCall=calls.find(call=>call.sql.startsWith('SELECT pg.id AS pair_group_id'));
  assert.deepEqual(accessCall.args,[2,20,10,2,2,2]);

  let storageCalls=0;
  currentDb=mockDb(()=>{ storageCalls+=1; throw new Error('must not reach storage'); });
  for(const identity of ['malformed','unsafe']){
    const rejected=await invoke({
      url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
      query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
      headers:{'x-test-auth':identity},
    });
    assert.equal(rejected.status,401);
    assert.deepEqual(rejected.body,{error:'authentication required'});
  }
  assert.equal(storageCalls,0);
});

test('pair run storage failures return generic 503 responses without database detail',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.startsWith('SELECT pg.id AS pair_group_id')) return rows([pairAccess()]);
    if(sql.includes('WITH pair_access AS')&&sql.includes('FROM session_runs sr')){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    return rows();
  });
  const response=await invoke({
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
  });
  assertGenericUnavailable(response,{error:'runs unavailable'});
});

test('canonical execution stops before the provider when room access storage fails',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.startsWith('SELECT pg.id AS pair_group_id')) throw new Error(SECRET_DATABASE_ERROR);
    return rows();
  });
  globalThis.fetch=async()=>{
    providerCalls+=1;
    throw new Error('provider must not be called');
  };
  const question=listPublicExercises()[0];
  const response=await invoke({
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},body:{
      room_id:'week_10_pair_20',language:'javascript',question_slug:question.slug,
      question_version:question.version,
      code:`function ${question.languages.javascript.entrypoint}(){ return null; }`,
    },
  });
  assertGenericUnavailable(response,{error:'execution service unavailable'});
  assert.equal(providerCalls,0);
});

test('canonical execution redacts guarded persistence failures after provider work',async()=>{
  currentDb=mockDb(sql=>{
    if(sql.startsWith('SELECT pg.id AS pair_group_id')) return rows([pairAccess()]);
    if(sql.includes("'execute_lease_start'")) return rows([{id:91}]);
    if(sql.includes('WITH pair_access AS')&&sql.includes('INSERT INTO session_runs')){
      throw new Error(SECRET_DATABASE_ERROR);
    }
    return rows();
  });
  globalThis.fetch=async()=>{
    providerCalls+=1;
    return new Response(JSON.stringify({run:{code:0,stdout:'',stderr:''}}),{status:200});
  };
  const question=listPublicExercises()[0];
  const response=await invoke({
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},body:{
      room_id:'week_10_pair_20',language:'javascript',question_slug:question.slug,
      question_version:question.version,
      code:`function ${question.languages.javascript.entrypoint}(){ return null; }`,
    },
  });
  assertGenericUnavailable(response,{ok:false,error:'execution service unavailable'});
  assert.equal(providerCalls,1);
});
