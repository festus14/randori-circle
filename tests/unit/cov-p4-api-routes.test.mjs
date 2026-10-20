// Route-level tests for api/data.js and api/ops.js against a real, fully migrated
// SQLite database. Only api/_db.js is replaced, to inject the client and a
// header-driven identity; readiness probes, SQL and handlers run for real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const directory=mkdtempSync(join(tmpdir(),'randori-cov-routes-'));
const realDb=createClient({url:`file:${join(directory,'routes.sqlite')}`});
let clientOverride=null;
const sentryCalls=[];

const IDENTITIES={
  admin:{id:1,email:'admin@example.test'},
  member:{id:2,email:'member@example.test'},
  envadmin:{id:3,email:'env-admin@example.test'},
  ghost:{id:99,email:'ghost@example.test'},
  anonymous:null,
  malformed:{id:'not-a-number'},
};

function authFor(req){
  const identity=IDENTITIES[req?.headers?.['x-test-auth']];
  return identity?{...identity,sessionHash:'a'.repeat(64)}:null;
}

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>{
      if(clientOverride instanceof Error) throw clientOverride;
      return clientOverride||realDb;
    },
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret:()=>{
      if(!process.env.CRON_SECRET) throw new Error('Missing CRON_SECRET');
      return process.env.CRON_SECRET;
    },
    getAdminEmails:()=>new Set(String(process.env.ADMIN_EMAILS||'').split(',').map(value=>value.trim()).filter(Boolean)),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W38',
    shuffleArray:values=>[...values],
    verifyRequestAuth:authFor,
    verifySignedRequestAuth:authFor,
    verifyMutationOrigin:req=>req?.headers?.['x-test-origin']!=='rejected',
    initSentry:()=>{},
    isSentryConfigured:()=>Boolean(process.env.SENTRY_DSN),
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:(...args)=>{ sentryCalls.push(['message',...args]); return null; },
    captureSentryException:(...args)=>{ sentryCalls.push(['exception',...args]); return null; },
  },
});

const [{default:dataHandler},{default:opsHandler,createOpsHandler}]=await Promise.all([
  import('../../api/data.js'),
  import('../../api/ops.js'),
]);

function invoke(handler,{method='GET',url='/',query={},headers={},body,auth,remoteAddress='203.0.113.9'}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      getHeader(name){ return responseHeaders[String(name).toLowerCase()]; },
      end(payload){ finish(payload); },
    };
    const request={method,url,query,headers:{...headers,...(auth?{'x-test-auth':auth}:{})},body,socket:{remoteAddress}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

// A client whose execute() fails for statements matching `pattern`.
// `hits` proves the intended failure path was actually exercised.
function failingClient(pattern,error=new Error('simulated database failure')){
  const client={
    hits:0,
    execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      if(pattern.test(sql)){ client.hits+=1; return Promise.reject(error); }
      return realDb.execute(statement);
    },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  return client;
}

async function scalar(sql,args=[]){
  const result=await realDb.execute({sql,args});
  return Object.values(result.rows[0]||{})[0];
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const state=await inspectMigrationState(realDb);
  await applyMigrations(realDb,{expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  for(const [id,email,isAdmin] of [[1,'admin@example.test',1],[2,'member@example.test',0],[3,'env-admin@example.test',0]]){
    await realDb.execute({
      sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
        VALUES (?,?,?,?,?,1,?,0)`,
      args:[id,email,'hash',`User ${id}`,'#abcdef',isAdmin],
    });
  }
});

after(()=>{
  try{ realDb.close(); }catch{}
  rmSync(directory,{recursive:true,force:true});
});

const ENV_KEYS=['ADMIN_EMAILS','APP_URL','CRON_SECRET','NODE_ENV','RANDORI_LOCAL_RUNTIME','SENTRY_DSN','TURSO_DATABASE_URL',
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED'];
beforeEach(()=>{
  clientOverride=null;
  sentryCalls.length=0;
  for(const key of ENV_KEYS) delete process.env[key];
});

test('ops notification preferences: method, auth, readiness, defaults and persistence', async ()=>{
  const prefs={url:'/api/ops?endpoint=notifications-prefs'};
  assert.equal((await invoke(opsHandler,{...prefs,method:'DELETE',auth:'member'})).status,405);
  assert.equal((await invoke(opsHandler,{...prefs})).status,401);

  clientOverride=new Error('no database');
  assert.deepEqual((await invoke(opsHandler,{...prefs,auth:'member'})).body,{error:'notification preferences unavailable'});
  clientOverride=null;

  const defaults=await invoke(opsHandler,{...prefs,auth:'member'});
  assert.deepEqual(defaults.body,{ok:true,prefs:{user_id:2,email_enabled:1,sms_enabled:0,phone:null}});

  const saved=await invoke(opsHandler,{...prefs,method:'POST',auth:'member',body:{email_enabled:false,sms_enabled:'yes',phone:'+1555000111122223333444',email:'alerts@example.test'}});
  assert.deepEqual(saved.body.prefs,{user_id:2,email_enabled:false,sms_enabled:true,phone:'+1555000111122223333',email:'alerts@example.test'});
  const stored=await invoke(opsHandler,{...prefs,auth:'member'});
  assert.equal(Number(stored.body.prefs.email_enabled),0);
  assert.equal(Number(stored.body.prefs.sms_enabled),1);
  assert.equal(stored.body.prefs.phone,'+1555000111122223333');

  // An empty PUT restores channel defaults but keeps the stored contact details.
  const reset=await invoke(opsHandler,{url:'/api/ops/notifications',method:'PUT',auth:'member'});
  assert.deepEqual(reset.body.prefs,{user_id:2,email_enabled:true,sms_enabled:false,phone:null,email:null});
  const kept=await invoke(opsHandler,{...prefs,auth:'member'});
  assert.equal(kept.body.prefs.email,'alerts@example.test');
  assert.ok(await scalar(`SELECT COUNT(*) FROM app_logs WHERE event='notif_prefs_updated'`)>=2);

  // The upsert falls back to INSERT OR IGNORE + UPDATE when the conflict clause fails.
  const upsertFailure=failingClient(/ON CONFLICT\(user_id\) DO UPDATE/);
  clientOverride=upsertFailure;
  const fallback=await invoke(opsHandler,{...prefs,method:'POST',auth:'admin',body:{sms_enabled:1,email_enabled:0}});
  assert.equal(fallback.body.ok,true);
  assert.equal(upsertFailure.hits,1);
  assert.equal(Number(await scalar('SELECT sms_enabled FROM user_notification_prefs WHERE user_id=1')),1);
  assert.equal(Number(await scalar('SELECT email_enabled FROM user_notification_prefs WHERE user_id=1')),0);
  await invoke(opsHandler,{...prefs,method:'POST',auth:'admin',body:{sms_enabled:0}});
  assert.equal(Number(await scalar('SELECT email_enabled FROM user_notification_prefs WHERE user_id=1')),1);

  const readFailure=failingClient(/FROM user_notification_prefs WHERE user_id=\?/);
  clientOverride=readFailure;
  assert.deepEqual((await invoke(opsHandler,{...prefs,auth:'member'})).body,{error:'fetch failed'});
  assert.equal(readFailure.hits,1);
});

test('ops routing resolves endpoints from query, search and path, and rejects unknown or cross-origin calls', async ()=>{
  const unknown=await invoke(opsHandler,{url:'/api/ops/nonsense'});
  assert.equal(unknown.status,404);
  assert.match(unknown.body.error,/unknown ops endpoint 'nonsense'/);
  assert.ok(unknown.body.available.includes('weekly'));

  assert.equal((await invoke(opsHandler,{url:'/api/ops',query:{endpoint:'NOTIFICATIONS'}})).status,401);
  assert.equal((await invoke(opsHandler,{url:'/api/ops?endpoint=Prefs'})).status,401);

  const crossOrigin=await invoke(opsHandler,{url:'/api/ops/notifications',method:'POST',headers:{'x-test-origin':'rejected'}});
  assert.deepEqual(crossOrigin.body,{error:'cross-origin mutation rejected'});
  const availability=await invoke(opsHandler,{url:'/api/settings/availability',method:'POST',headers:{'x-test-origin':'rejected'}});
  assert.deepEqual(availability.body,{ok:false,error:'cross-origin mutation rejected'});
  assert.ok(availability.headers['cache-control']);
});

test('the retired legacy promote action never changes roles for any caller', async ()=>{
  const promote={url:'/api/ops/reshuffle',method:'POST'};
  assert.equal((await invoke(opsHandler,{...promote,method:'GET'})).status,405);
  const before=Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_admin=1'));
  process.env.ADMIN_EMAILS='env-admin@example.test';
  for(const auth of [undefined,'member','ghost','admin','envadmin']){
    for(const request of [
      {body:{action:'promote',email:'member@example.test'}},
      {body:{action:'PROMOTE',email:' Member@Example.test '}},
      {query:{action:'promote',email:'member@example.test'}},
    ]){
      const response=await invoke(opsHandler,{...promote,auth,...request});
      assert.equal(response.status,410,`${auth}:${JSON.stringify(request)}`);
      assert.equal(response.body.code,'legacy_promote_retired');
      assert.equal(response.body.replacement.path,'/api/members');
    }
  }
  assert.equal(Number(await scalar('SELECT is_admin FROM auth_accounts WHERE id=2')),0);
  assert.equal(Number(await scalar('SELECT is_admin FROM auth_accounts WHERE id=3')),0);
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_admin=1')),before);
});

test('demo seed, shuffle and reset operate only on demo data and require an admin', async ()=>{
  for(const endpoint of ['demo-seed','demo-shuffle','demo-reset']){
    assert.equal((await invoke(opsHandler,{url:`/api/ops/${endpoint}`})).status,405,endpoint);
    assert.equal((await invoke(opsHandler,{url:`/api/ops/${endpoint}`,method:'POST',auth:'member'})).status,403,endpoint);
  }

  // Shuffle with fewer than two demo users seeds them inline first.
  const shuffled=await invoke(opsHandler,{url:'/api/ops/demo-shuffle',method:'POST',auth:'admin'});
  assert.equal(shuffled.status,200,JSON.stringify(shuffled.body));
  assert.equal(shuffled.body.demo,true);
  assert.equal(shuffled.body.count,9);
  assert.ok(shuffled.body.pairs.length>=4);
  assert.ok(shuffled.body.pairs.some(pair=>pair.is_demo_a||pair.is_demo_b));
  assert.equal(Number(await scalar('SELECT is_demo FROM pairing_weeks WHERE id=?',[shuffled.body.week_id])),1);

  const seeded=await invoke(opsHandler,{url:'/api/ops/demo_seed',method:'POST',auth:'admin'});
  assert.equal(seeded.body.seeded_count,6);
  assert.ok(seeded.body.seeded.every(user=>user.email.endsWith('@randori.demo')));

  const reset=await invoke(opsHandler,{url:'/api/ops/demo-reset',method:'POST',auth:'admin'});
  assert.equal(reset.status,200);
  assert.equal(reset.body.deleted.demo_users,12);
  assert.equal(reset.body.deleted.weeks,1);
  assert.ok(reset.body.deleted.groups>=4);
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_demo=1')),0);
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_demo=0')),3);
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM pairing_weeks WHERE is_demo=1')),0);

  // Count probes are best-effort; the reset still deletes demo rows if they fail.
  await invoke(opsHandler,{url:'/api/ops/demo-seed',method:'POST',auth:'admin'});
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_demo=1')),6);
  const probeFailure=failingClient(/SELECT COUNT\(\*\) AS c FROM (pairing_|auth_accounts WHERE is_demo=1)/);
  clientOverride=probeFailure;
  const blind=await invoke(opsHandler,{url:'/api/ops/demo-reset',method:'POST',auth:'admin'});
  assert.equal(blind.status,200);
  assert.equal(probeFailure.hits,3);
  assert.deepEqual(blind.body.deleted,{groups:0,weeks:0,demo_users:0});
  assert.equal(Number(await scalar('SELECT COUNT(*) FROM auth_accounts WHERE is_demo=1')),0);
});

test('outbox replay validates the operator and the request shape before touching the outbox', async ()=>{
  const replay={url:'/api/ops/outbox-replay',method:'POST'};
  assert.equal((await invoke(opsHandler,{...replay,method:'GET'})).status,405);
  assert.equal((await invoke(opsHandler,{...replay})).status,401);
  assert.equal((await invoke(opsHandler,{...replay,auth:'malformed'})).status,401);
  assert.equal((await invoke(opsHandler,{...replay,auth:'member',body:{}})).status,403);
  assert.equal((await invoke(opsHandler,{...replay,auth:'ghost',body:{}})).status,403);
  clientOverride=new Error('no database');
  assert.equal((await invoke(opsHandler,{...replay,auth:'admin',body:{}})).status,503);
  const operatorFailure=failingClient(/SELECT id,is_admin,is_demo FROM auth_accounts/);
  clientOverride=operatorFailure;
  assert.equal((await invoke(opsHandler,{...replay,auth:'admin',body:{}})).status,503);
  assert.equal(operatorFailure.hits,1);
  clientOverride=null;

  for(const body of [null,[],{event_id:1,extra:true}]){
    assert.equal((await invoke(opsHandler,{...replay,auth:'admin',body})).status,400,JSON.stringify(body));
  }
  assert.equal((await invoke(opsHandler,{...replay,auth:'admin',body:{event_id:'x',reason_code:'nope'}})).status,400);
  const missing=await invoke(opsHandler,{...replay,auth:'admin',body:{event_id:424242,reason_code:'OPERATOR_RETRY'}});
  assert.equal(missing.status,409,JSON.stringify(missing.body));
  const clockFailure=failingClient(/strftime/);
  clientOverride=clockFailure;
  assert.equal((await invoke(opsHandler,{...replay,auth:'admin',body:{event_id:1,reason_code:'OPERATOR_RETRY'}})).status,503);
  assert.ok(clockFailure.hits>=1);
});

test('cron routes require the shared secret and fail closed on configuration or clock problems', async ()=>{
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox',method:'PUT'})).status,405);
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox'})).status,401);
  process.env.CRON_SECRET='cron-secret-value';
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox',headers:{authorization:'Bearer wrong-secret-value'}})).status,401);
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox',headers:{'x-cron-secret':'cron-secret-valu'}})).status,401);
  const noBase=await invoke(opsHandler,{url:'/api/cron/outbox',headers:{authorization:'Bearer cron-secret-value'}});
  assert.deepEqual(noBase.body,{error:'outbox unavailable'});
  process.env.APP_URL='https://randori.example.test';
  clientOverride=new Error('no database');
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox',headers:{'x-cron-secret':'cron-secret-value'}})).status,503);
  clientOverride=null;

  assert.equal((await invoke(opsHandler,{url:'/api/cron/weekly',method:'DELETE'})).status,405);
  process.env.TURSO_DATABASE_URL='file:unused-by-mocked-client';
  const before=Number(await scalar(`SELECT COUNT(*) FROM app_logs WHERE event='cron_auth_fail'`));
  const denied=await invoke(opsHandler,{url:'/api/cron/weekly',headers:{authorization:'Bearer nope'}});
  assert.equal(denied.status,401);
  assert.match(denied.body.hint,/x-cron-secret/);
  assert.equal(Number(await scalar(`SELECT COUNT(*) FROM app_logs WHERE event='cron_auth_fail'`)),before+1);

  const cron={url:'/api/cron/weekly',headers:{'x-cron-secret':'cron-secret-value'}};
  const notDue=await invoke(createOpsHandler({isWeeklyDue:()=>false}),cron);
  assert.equal(notDue.body.skipped,true);
  assert.equal(notDue.body.reason,'outside_due_window');

  clientOverride={execute:async()=>({rows:[{now_utc:'not a time'}]})};
  assert.equal((await invoke(createOpsHandler({isWeeklyDue:()=>true}),cron)).status,503);
  clientOverride=new Error('no database');
  assert.equal((await invoke(createOpsHandler({isWeeklyDue:()=>true}),cron)).status,503);

  assert.throws(()=>createOpsHandler({isWeeklyDue:'sunday'}),TypeError);
});

test('client log ingestion normalises entries, protects reserved namespaces and rate limits by IP', async ()=>{
  const logs={url:'/api/data/logs',method:'POST'};
  assert.equal((await invoke(dataHandler,{...logs})).status,401);
  clientOverride=new Error('no database');
  assert.equal((await invoke(dataHandler,{...logs,auth:'member',body:{message:'x'}})).status,503);
  clientOverride=null;

  const batch=await invoke(dataHandler,{...logs,auth:'member',headers:{'user-agent':'unit-agent'},body:[
    {level:'ERROR',message:'boom',event:'execute_attempt',source:'runner',meta:{a:1}},
    {level:'shout',message:'loud',event:'execute_lease_acquired',meta:'raw-meta',route:'/custom'},
    {level:'warn',message:'careful',meta_json:'{"b":2}',ua:'custom-agent'},
    {message:''},
  ]});
  assert.deepEqual(batch.body,{ok:true,inserted:3});
  const rows=(await realDb.execute(`SELECT level,source,event,meta_json,route,ua FROM app_logs WHERE user_id=2 AND message IN ('boom','loud','careful') ORDER BY id`)).rows;
  assert.deepEqual(rows.map(row=>[row.level,row.source,row.event,row.meta_json,row.route,row.ua]),[
    ['error','client','client_execute_attempt','{"a":1}','/api/data/logs','unit-agent'],
    ['info','client','client_execute_lease_acquired','raw-meta','/custom','unit-agent'],
    ['warn','client',null,'{"b":2}','/api/data/logs','custom-agent'],
  ]);

  const wrapped=await invoke(dataHandler,{...logs,auth:'member',body:{logs:[{message:'one'},{message:'two'}]}});
  assert.equal(wrapped.body.inserted,2);
  const single=await invoke(dataHandler,{...logs,auth:'member',body:{message:'single',level:'success'}});
  assert.equal(single.body.inserted,1);
  const cyclic={}; cyclic.self=cyclic;
  const unserializable=await invoke(dataHandler,{...logs,auth:'member',body:{message:'cyclic meta',meta:cyclic}});
  assert.equal(unserializable.body.inserted,1);

  // Sixty requests per minute per forwarded IP are accepted; the sixty-first is refused.
  const headers={'x-forwarded-for':'198.51.100.77, 10.0.0.1'};
  for(let index=0;index<60;index+=1){
    assert.equal((await invoke(dataHandler,{...logs,auth:'member',headers,body:{message:''}})).status,200);
  }
  const limited=await invoke(dataHandler,{...logs,auth:'member',headers,body:{message:'too many'}});
  assert.equal(limited.status,429);
  assert.equal((await invoke(dataHandler,{...logs,auth:'member',headers:{'x-real-ip':'198.51.100.78'},body:{message:'other ip'}})).status,200);
});

test('admin log reads are filtered, bounded and tolerate non-JSON metadata', async ()=>{
  const read={url:'/api/data/logs'};
  assert.equal((await invoke(dataHandler,{...read})).status,401);
  const forbidden=await invoke(dataHandler,{...read,auth:'member'});
  assert.equal(forbidden.status,403);
  assert.equal(forbidden.body.you_are,'member@example.test');
  assert.equal((await invoke(dataHandler,{...read,auth:'ghost'})).status,403);
  clientOverride=new Error('no database');
  assert.equal((await invoke(dataHandler,{...read,auth:'admin'})).status,503);
  clientOverride=null;

  await invoke(dataHandler,{url:'/api/data/logs',method:'POST',auth:'member',body:[
    {level:'debug',message:'filter target',event:'filter_event',source:'probe',meta:'not json'},
  ]});
  const filtered=await invoke(dataHandler,{url:'/api/data/logs?level=debug&event=filter_event&source=probe&limit=5',auth:'admin'});
  assert.equal(filtered.status,200);
  assert.equal(filtered.body.count,1);
  assert.equal(filtered.body.logs[0].meta,'not json');

  const parsed=await invoke(dataHandler,{...read,auth:'admin',query:{event:'client_execute_attempt',limit:'nope'}});
  assert.deepEqual(parsed.body.logs[0].meta,{a:1});

  const newest=Number(await scalar('SELECT MAX(id) FROM app_logs'));
  const sinceId=await invoke(dataHandler,{url:`/api/data/logs?since=${newest}`,auth:'admin'});
  assert.equal(sinceId.body.count,0);
  // Unknown levels are ignored and the limit is clamped to 200.
  const sinceTime=await invoke(dataHandler,{url:'/api/data/logs?since=2000-01-01&limit=999&level=bogus',auth:'admin'});
  assert.equal(sinceTime.body.count,Math.min(200,Number(await scalar('SELECT COUNT(*) FROM app_logs'))));
  assert.ok(sinceTime.body.count>1);

  // Configured admins are recognised by email even without the database flag.
  process.env.ADMIN_EMAILS='env-admin@example.test';
  assert.equal((await invoke(dataHandler,{url:'/api/data/logs?limit=1',auth:'envadmin'})).status,200);

  const logsFailure=failingClient(/FROM app_logs ORDER BY id DESC|FROM app_logs WHERE/);
  clientOverride=logsFailure;
  const failed=await invoke(dataHandler,{url:'/api/data/logs?limit=1',auth:'admin'});
  assert.equal(failed.status,500);
  assert.equal(failed.body.error,'logs fetch failed');
  assert.equal(logsFailure.hits,1);
  clientOverride=null;
  assert.equal((await invoke(dataHandler,{url:'/api/data/logs',method:'PATCH',auth:'admin'})).status,405);
});

test('profile reads and updates normalise fields and refuse availability writes', async ()=>{
  const profile={url:'/api/data/profile'};
  assert.equal((await invoke(dataHandler,{...profile})).status,401);
  assert.equal((await invoke(dataHandler,{...profile,auth:'ghost'})).status,404);
  clientOverride=new Error('no database');
  assert.equal((await invoke(dataHandler,{...profile,auth:'member'})).status,503);
  clientOverride=null;

  assert.match((await invoke(dataHandler,{...profile,method:'POST',auth:'member',body:{isAvailable:false}})).body.error,/availability/);
  assert.match((await invoke(dataHandler,{...profile,method:'POST',auth:'member',body:{}})).body.error,/no fields/);
  assert.match((await invoke(dataHandler,{...profile,method:'POST',auth:'member'})).body.error,/no fields/);

  const updated=await invoke(dataHandler,{...profile,method:'POST',auth:'member',body:{
    name:'  Renamed Member With An Exceedingly Long Name  ',color:'#00ff00',bio:' hello ',tz:'Europe/London',
    interview_focus:'System_Design',leetcode_handle:' coder ',
  }});
  assert.equal(updated.status,200);
  assert.equal(updated.body.user.display_name,'Renamed Member With An Exceeding');
  assert.equal(updated.body.user.interview_focus,'system');
  assert.equal(updated.body.user.bio,'hello');
  assert.equal(updated.body.user.leetcode_handle,'coder');

  for(const [focus,expected] of [['dsa','dsa'],['BOTH','both'],['frontend','both']]){
    const result=await invoke(dataHandler,{...profile,method:'POST',auth:'member',body:{display_name:'Member',interview_focus:focus}});
    assert.equal(result.body.user.interview_focus,expected,focus);
  }
  await realDb.execute(`UPDATE auth_accounts SET bio=NULL,tz=NULL,interview_focus=NULL,leetcode_handle=NULL,is_available=NULL WHERE id=2`);
  const read=await invoke(dataHandler,{...profile,auth:'member'});
  assert.equal(read.body.user.is_available,true);
  assert.equal(read.body.user.interview_focus,'both');
  assert.equal(read.body.user.bio,'');

  const updateFailure=failingClient(/^UPDATE auth_accounts SET/);
  clientOverride=updateFailure;
  const failed=await invoke(dataHandler,{...profile,method:'POST',auth:'member',body:{tz:'UTC'}});
  assert.equal(failed.status,500);
  assert.equal(failed.body.error,'update failed');
  assert.equal(updateFailure.hits,1);
  clientOverride=null;
  assert.equal((await invoke(dataHandler,{...profile,method:'DELETE',auth:'member'})).status,405);
});

test('data routing reports unknown endpoints and sanitises unhandled failures', async ()=>{
  const unknown=await invoke(dataHandler,{url:'/api/data?endpoint=Nope'});
  assert.equal(unknown.status,404);
  assert.match(unknown.body.error,/unknown data endpoint 'nope'/);
  assert.equal((await invoke(dataHandler,{url:'/api/data/logs',method:'POST',headers:{'x-test-origin':'rejected'}})).status,403);

  // A failure after readiness reaches the top-level handler, which logs and reports it once.
  process.env.SENTRY_DSN='https://public@example.invalid/1';
  const profileFailure=failingClient(/SELECT id,email,display_name,color,created_at,last_login/,new Error('disk I/O error'));
  clientOverride=profileFailure;
  const failed=await invoke(dataHandler,{url:'/api/data/profile',auth:'member',headers:{'user-agent':'ua','x-forwarded-for':'192.0.2.1'}});
  assert.equal(failed.status,500);
  // Raw database errors are logged and reported, never returned to the client.
  assert.deepEqual(failed.body,{error:'internal'});
  assert.equal(profileFailure.hits,1);
  assert.equal(sentryCalls.filter(([kind])=>kind==='exception').length,1);
  const logged=(await realDb.execute(`SELECT level,source,event,route FROM app_logs WHERE event='api_unhandled' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual({...logged},{level:'error',source:'server',event:'api_unhandled',route:'/api/data/profile'});
});
