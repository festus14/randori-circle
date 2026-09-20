import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const publishedScopes=[];
const aggregateLogs=[];
let failingCircleId=10;

const cycle=Object.freeze({
  cycleId:'2026-W39',
  startsAt:'2026-09-20T07:00:00.000Z',
  endsAt:'2026-09-27T07:00:00.000Z',
  cutoffAt:'2026-09-19T17:00:00.000Z',
  timeZone:'Europe/London',
});

const db={
  async execute(statement){
    const sql=typeof statement==='string'?statement:String(statement?.sql||'');
    if(sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc")){
      return {rows:[{now_utc:'2026-09-20T08:15:00.000Z'}],rowsAffected:0};
    }
    if(sql.includes('INSERT INTO app_logs')){
      aggregateLogs.push({event:statement.args[2],message:statement.args[3],
        meta:JSON.parse(statement.args[4]),route:statement.args[5],ua:statement.args[6],ip:statement.args[7]});
    }
    return {rows:[],rowsAffected:0};
  },
};

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    deterministicColor:()=>'#123456',
    getAdminEmails:()=>new Set(),
    getClient:()=>db,
    getCronSecret:()=>process.env.CRON_SECRET,
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    issueSession:async()=>'',
    issueSessionInTransaction:async()=>'',
    isoWeekLabel:()=>cycle.cycleId,
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:async()=>null,
    verifySignedRequestAuth:()=>null,
  },
});

mock.module('../../api/_pairing-publication.js',{
  exports:{
    publishPairingCycle:async()=>({
      created:true,
      publication:{
        cycle,weekId:1,generation:1,participantCount:0,pairs:[],
        algorithm:{version:'fair-v2'},
      },
    }),
  },
});

mock.module('../../api/_circle-pairing.js',{
  exports:{
    SECONDARY_PAIRING_CACHE_CONTROL:'private, no-store',
    circlePairingFailure:()=>({status:503,body:{ok:false,error:'pairing unavailable'}}),
    listSecondaryPairingScopes:async()=>[10,20,30],
    publishCirclePairing:async(_db,{authority})=>{
      publishedScopes.push(authority.circleId);
      if(authority.circleId===failingCircleId) throw new Error('isolated circle failure');
      return {created:authority.circleId!==30};
    },
  },
});

mock.module('../../api/_pairing-email.js',{
  exports:{
    PAIRING_EMAIL_EVENT_TYPE:'pairing.email.requested',
    classifyPairingProviderError:error=>error,
    createPairingEmailHandler:()=>async()=>({}),
    createResendEmailSender:()=>async()=>({}),
    migrateLegacyPairingEmails:async()=>0,
    pairingEmailStatus:async()=>({
      pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0,
    }),
  },
});

process.env.NODE_ENV='production';
process.env.CRON_SECRET='cron-secret';
process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED='true';
process.env.SECONDARY_CIRCLE_COORDINATION_ENABLED='true';

const {default:opsHandler}=await import('../../api/ops.js');

function invoke(){
  return new Promise((resolve,reject)=>{
    let status=200;
    const response={
      status(value){ status=value; return this; },
      json(body){ resolve({status,body}); return this; },
      setHeader(){},
    };
    Promise.resolve(opsHandler({
      method:'GET',url:'/api/cron/weekly',query:{endpoint:'weekly'},
      headers:{'x-cron-secret':'cron-secret'},socket:{remoteAddress:'203.0.113.10'},
    },response)).catch(reject);
  });
}

test('secondary weekly cron continues after an isolated first or middle scope failure',async()=>{
  for(const failedId of [10,20]){
    failingCircleId=failedId;
    publishedScopes.length=0;
    const response=await invoke();
    assert.equal(response.status,503);
    assert.deepEqual(publishedScopes,[10,20,30],
      'one failed scope must not starve later deterministic scopes');
    assert.deepEqual(response.body,{
      ok:false,error:'pairing unavailable',retryable:true,
      secondary:{
        attempted:3,
        created:1,
        existing:1,
        failed:1,
      },
    });
    assert.deepEqual(aggregateLogs.at(-1),{
      event:'weekly_pairing_completed',message:'weekly pairing completed with failures',
      meta:{
        primary:{created:true,existing:false,participant_count:0,pair_count:0,solo_count:0},
        secondary:{attempted:3,created:1,existing:1,failed:1},
      },
      route:null,ua:null,ip:null,
    });
    assert.doesNotMatch(JSON.stringify(aggregateLogs.at(-1)),/circleId|scope|cycle|user|email/i);
  }
});

test('an empty primary publication continues through every secondary scope and logs only aggregates',async()=>{
  failingCircleId=null;
  publishedScopes.length=0;
  aggregateLogs.length=0;
  const response=await invoke();
  assert.equal(response.status,200);
  assert.equal(response.body.participant_count,0);
  assert.deepEqual(response.body.secondary,{attempted:3,created:2,existing:1,failed:0});
  assert.deepEqual(publishedScopes,[10,20,30]);
  assert.deepEqual(aggregateLogs, [{
    event:'weekly_pairing_completed',message:'weekly pairing completed',
    meta:{
      primary:{created:true,existing:false,participant_count:0,pair_count:0,solo_count:0},
      secondary:{attempted:3,created:2,existing:1,failed:0},
    },
    route:null,ua:null,ip:null,
  }]);
  assert.doesNotMatch(JSON.stringify(aggregateLogs),/circleId|scope|cycle|user|email/i);
});

after(()=>{
  for(const key of [
    'NODE_ENV','CRON_SECRET','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED',
  ]) delete process.env[key];
});
