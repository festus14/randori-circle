import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,beforeEach,mock,test} from 'node:test';
import {createClient} from '@libsql/client';

import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';
import {installWaitUntilCapture,stubResendFetch} from '../support/immediate-delivery.mjs';

let currentDb=null;
const temporaryDirectories=[];
const SECRET='invite-request-test-secret-at-least-thirty-two-characters';
const ORIGIN='https://randori.example.test';
const sentryEvents=[];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='owner') return {id:1,email:'owner@example.test',sessionHash:'a'.repeat(64)};
  if(identity==='member') return {id:2,email:'member@example.test',sessionHash:'b'.repeat(64)};
  if(identity==='outsider') return {id:3,email:'outsider@example.test',sessionHash:'c'.repeat(64)};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:(error,context)=>{ sentryEvents.push({error,context}); return null; },
    captureSentryMessage:()=>null,
    deterministicColor:()=>'#123456',
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getCronSecret:()=>'cron-secret',
    getJwtSecret:()=>SECRET,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    isoWeekLabel:()=>'2026-W42',
    issueSession:async()=>{ throw new Error('not used'); },
    issueSessionInTransaction:async()=>{ throw new Error('not used'); },
    revokeAccountSessions:async()=>{ throw new Error('not used'); },
    revokeRequestSession:async()=>{ throw new Error('not used'); },
    verifyMutationOrigin:req=>req?.headers?.['x-test-cross']!=='1',
    verifyRequestAuth:authPayload,
    verifySignedRequestAuth:authPayload,
  },
});

const [{default:invitationsHandler},{default:authHandler},requests,config,notification,
  membership,invitationEmail,delivery]=await Promise.all([
  import('../../api/invitations.js'),
  import('../../api/auth.js'),
  import('../../api/_invite-requests.js'),
  import('../../api/_invite-request-config.js'),
  import('../../api/_invite-request-notification.js'),
  import('../../api/_circle-membership.js'),
  import('../../api/_invitation-email.js'),
  import('../../api/_outbox-delivery.js'),
]);

function invoke(handler,{method='GET',url='/',query={},headers={},body}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const startedAt=Date.now();
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload,elapsedMs:Date.now()-startedAt});
    };
    const res={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      getHeader(name){ return responseHeaders[String(name).toLowerCase()]; },
      end(payload){ finish(payload); },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(handler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

function submit(body,{ip='198.51.100.1',origin=ORIGIN,query={endpoint:'invite-requests'},method='POST'}={}){
  const headers={host:'randori.example.test','x-forwarded-proto':'https','x-forwarded-for':ip};
  if(origin!==null) headers.origin=origin;
  return invoke(invitationsHandler,{method,url:'/api/invite-requests',query,headers,body});
}

function list(identity='owner',query={}){
  return invoke(invitationsHandler,{url:'/api/invite-requests',
    query:{endpoint:'invite-requests',...query},headers:identity?{'x-test-auth':identity}:{}});
}

function decide(body,{identity='owner',headers={},method='POST',query={endpoint:'invite-request-decision'}}={}){
  return invoke(invitationsHandler,{method,url:'/api/invite-requests/decision',query,
    headers:{'x-test-auth':identity,origin:ORIGIN,host:'randori.example.test',...headers},body});
}

async function migratedDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-invite-requests-'));
  temporaryDirectories.push(directory);
  const db=createClient({url:pathToFileURL(join(directory,'current.sqlite')).href});
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'owner@example.test','x','Owner','#112233',0),(2,'member@example.test','x','Member','#445566',0),
      (3,'outsider@example.test','x','Outsider','#778899',0),(5,'demo@example.test','x','Demo','#ddeeff',1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'3c20c4da-1906-4ca4-b4fd-5971f1dd066d','randori-circle','Randori <Circle>',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at) VALUES
      (10,1,'owner','active',datetime('now'),datetime('now')),
      (10,2,'member','active',datetime('now'),datetime('now')),
      (10,5,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  return db;
}

async function rows(sql,args=[]){
  return (await currentDb.execute({sql,args})).rows;
}

const ENV_KEYS=['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','INVITE_REQUESTS_ENABLED','INVITATION_EMAIL_DELIVERY_ENABLED',
  'INVITATION_EMAIL_ENCRYPTION_KEY','NODE_ENV','OUTBOX_IMMEDIATE_DELIVERY','RESEND_API_KEY','RESEND_FROM',
  'TURSO_DATABASE_URL','VERCEL'];

beforeEach(()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.INVITE_REQUESTS_ENABLED='true';
  sentryEvents.length=0;
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
  while(temporaryDirectories.length) rmSync(temporaryDirectories.pop(),{recursive:true,force:true});
  for(const key of ENV_KEYS) delete process.env[key];
});

function enableOwnerNotifications(){
  process.env.NODE_ENV='production';
  process.env.APP_URL=ORIGIN;
  process.env.RESEND_API_KEY='re_invite_request_test';
  process.env.RESEND_FROM='Randori <circle@randori.example.test>';
}

test('input validation is bounded, Unicode-aware, field-specific, and honeypot-first',()=>{
  const valid=requests.validateInviteRequestInput({name:'  Ada\n  Lovelace ',email:' Ada@Example.Test ',
    note:' Preparing for\r\nsystem design ',website:''});
  assert.deepEqual({...valid,value:{...valid.value}},{ok:true,honeypot:false,
    value:{name:'Ada Lovelace',email:'ada@example.test',note:'Preparing for\nsystem design'},fields:{}});
  assert.equal(requests.validateInviteRequestInput({name:'Al',email:'al@example.test'}).value.note,null);
  assert.equal(requests.validateInviteRequestInput({name:'Al',email:'al@example.test',note:'   '}).value.note,null);
  assert.equal(requests.validateInviteRequestInput({name:'Al',email:'al@example.test',note:null}).ok,true);
  assert.equal(requests.validateInviteRequestInput({name:'é'.repeat(60),email:'a@b.co'}).ok,true,
    'limits count code points, matching SQLite length()');
  assert.equal(requests.validateInviteRequestInput({name:'😀'.repeat(60),email:'a@b.co',note:'😀'.repeat(280)}).ok,true);
  const cases=[
    [null,{form:'Send the request as a JSON object.'}],
    [[],{form:'Send the request as a JSON object.'}],
    [{email:'a@b.co'},{name:'Enter your name.'}],
    [{name:'A',email:'a@b.co'},{name:'Use 2–60 characters.'}],
    [{name:'x'.repeat(61),email:'a@b.co'},{name:'Use 2–60 characters.'}],
    [{name:'Ada‮evil',email:'a@b.co'},{name:'Remove unsupported characters from your name.'}],
    [{name:'Ada',email:'not-an-email'},{email:'Enter a valid email address.'}],
    [{name:'Ada',email:'ädä@example.test'},{email:'Enter a valid email address.'}],
    [{name:'Ada',email:'ada‮@example.test'},{email:'Enter a valid email address.'}],
    [{name:'Ada',email:42},{email:'Enter a valid email address.'}],
    [{name:'Ada',email:'a@b.co',note:42},{note:'Enter text.'}],
    [{name:'Ada',email:'a@b.co',note:'x'.repeat(281)},{note:'Use at most 280 characters.'}],
    [{name:'Ada',email:'a@b.co',note:'bell\u0007'},{note:'Remove unsupported characters.'}],
    [{name:'Ada',email:'a@b.co',circle_id:99},{form:'Unexpected field.'}],
  ];
  for(const [body,fields] of cases){
    const result=requests.validateInviteRequestInput(body);
    assert.equal(result.ok,false,JSON.stringify(body));
    assert.equal(result.honeypot,false);
    assert.equal(result.value,null);
    assert.deepEqual(result.fields,fields,JSON.stringify(body));
  }
  for(const website of ['https://spam.example',' x ',1,true,{}]){
    const result=requests.validateInviteRequestInput({name:'',email:'bad',website});
    assert.deepEqual({honeypot:result.honeypot,ok:result.ok},{honeypot:true,ok:false});
  }
});

test('the feature flag and routing gate every invite-request endpoint before database work',async()=>{
  currentDb={execute:async()=>{ throw new Error('database must not be touched'); },
    transaction:async()=>{ throw new Error('database must not be touched'); }};
  delete process.env.INVITE_REQUESTS_ENABLED;
  for(const response of [await submit({name:'Ada',email:'ada@example.test'}),await list(),
    await decide({id:'00000000-0000-4000-8000-000000000000',decision:'approve',expected_status:'pending'})]){
    assert.deepEqual([response.status,response.body],[404,{error:'not found'}]);
  }
  process.env.INVITE_REQUESTS_ENABLED='true';
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  assert.equal((await submit({name:'Ada',email:'ada@example.test'})).status,404);
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal((await submit({name:'Ada',email:'ada@example.test'},{origin:null})).status,403);
  assert.equal((await submit({name:'Ada',email:'ada@example.test'},{origin:'https://evil.example'})).status,403);
  assert.equal((await submit({name:'Ada',email:'ada@example.test'},{origin:'not a url'})).status,403);
  assert.equal((await submit({name:'Ada',email:'ada@example.test'},
    {query:{endpoint:'invite-requests',circle:'10'}})).status,400);
  const put=await submit({},{method:'PUT'});
  assert.deepEqual([put.status,put.headers.allow],[405,'GET, POST']);
  const invalid=await submit({name:'A',email:'nope'});
  assert.equal(invalid.status,400);
  assert.deepEqual(invalid.body,{error:'invalid invite request',
    fields:{name:'Use 2–60 characters.',email:'Enter a valid email address.'}});
  const getDecision=await decide({},{method:'GET'});
  assert.deepEqual([getDecision.status,getDecision.headers.allow],[405,'POST']);
  assert.equal((await decide({},{query:{endpoint:'invite-request-decision',x:'1'}})).status,400);
  assert.equal((await decide({id:'00000000-0000-4000-8000-000000000000',decision:'approve',
    expected_status:'pending'},{headers:{'x-test-cross':'1'}})).status,403);
  assert.equal((await list('owner',{status:'approved'})).status,400);
  assert.equal((await list('owner',{limit:'0'})).status,400);
  assert.equal((await list('owner',{limit:'101'})).status,400);
  assert.equal((await list('owner',{limit:'ten'})).status,400);
  assert.equal((await list('owner',{cursor:'%%%'})).status,400);
  assert.equal((await list('owner',{unknown:'1'})).status,400);
  assert.equal((await invoke(invitationsHandler,{url:'/api/invite-requests?status=a&status=b',
    query:{endpoint:'invite-requests'},headers:{'x-test-auth':'owner'}})).status,400);
  assert.equal((await list(null)).status,401);
  for(const [origin,proto] of [['http://randori.example.test','https'],['https://randori.example.test/path','https'],
    ['https://user:pw@randori.example.test','https'],['https://randori.example.test:8443','https'],
    ['https://randori.example.test?x=1','https'],['https://randori.example.test','ftp']]){
    const response=await invoke(invitationsHandler,{method:'POST',url:'/api/invite-requests',
      query:{endpoint:'invite-requests'},headers:{origin,host:'randori.example.test','x-forwarded-proto':proto},
      body:{name:'Ada',email:'ada@example.test'}});
    assert.equal(response.status,403,`${origin} via ${proto}`);
  }
  const plainHttp=await invoke(invitationsHandler,{method:'POST',url:'/api/invite-requests',
    query:{endpoint:'invite-requests'},headers:{origin:'https://randori.example.test',host:'randori.example.test'},
    body:{name:'Ada',email:'ada@example.test'}});
  assert.equal(plainHttp.status,403,'an https Origin on a plain-http socket is rejected');
});

test('a filled honeypot gets the generic accepted response without storing or rate limiting',async()=>{
  currentDb=await migratedDatabase();
  const response=await submit({name:'Bot',email:'bot@example.test',website:'https://spam.example'});
  assert.equal(response.status,202);
  assert.deepEqual(response.body,{ok:true,message:requests.INVITE_REQUEST_ACCEPTED_MESSAGE});
  assert.ok(response.elapsedMs>=requests.INVITE_REQUEST_RESPONSE_FLOOR_MS-5,'honeypot honours the floor');
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests`))[0].count,0);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM auth_rate_limits`))[0].count,0);
});

test('responses are identical for new, duplicate, member, invited, and declined emails',async()=>{
  currentDb=await migratedDatabase();
  await currentDb.execute({sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES ('11111111-1111-4111-8111-111111111111',10,?,?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))`,
  args:['e'.repeat(64),membership.hashInvitationEmail('invited@example.test')]});
  const responses=[];
  responses.push(await submit({name:'New Person',email:'New.Person@Example.Test',note:'Interview prep'},{ip:'198.51.100.10'}));
  responses.push(await submit({name:'New Person again',email:'new.person@example.test'},{ip:'198.51.100.11'}));
  responses.push(await submit({name:'Member',email:'member@example.test'},{ip:'198.51.100.12'}));
  responses.push(await submit({name:'Invited',email:'invited@example.test'},{ip:'198.51.100.13'}));
  for(const response of responses){
    assert.equal(response.status,202);
    assert.deepEqual(response.body,{ok:true,message:requests.INVITE_REQUEST_ACCEPTED_MESSAGE});
    assert.deepEqual(Object.keys(response.headers).sort(),['cache-control','pragma']);
    assert.ok(response.elapsedMs>=requests.INVITE_REQUEST_RESPONSE_FLOOR_MS-5,`${response.elapsedMs}ms`);
  }
  const stored=await rows(`SELECT id,circle_id,email,name,note,status,expires_at-created_at AS ttl FROM invite_requests`);
  assert.equal(stored.length,1,'only the new email is stored, and only once');
  assert.deepEqual({...stored[0],id:undefined},{id:undefined,circle_id:10,email:'new.person@example.test',
    name:'New Person',note:'Interview prep',status:'pending',ttl:config.INVITE_REQUEST_TTL_SECONDS});

  const declined=await requests.decideInviteRequest(currentDb,{requestId:stored[0].id,decision:'decline',ownerUserId:1});
  assert.equal(declined.status,'declined');
  const again=await submit({name:'New Person',email:'new.person@example.test'},{ip:'198.51.100.14'});
  assert.deepEqual([again.status,again.body],[202,{ok:true,message:requests.INVITE_REQUEST_ACCEPTED_MESSAGE}]);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests WHERE status='pending'`))[0].count,0,
    'a recently declined email is silently not re-queued');
  assert.equal(sentryEvents.length,0);
});

test('domain outcomes are reported only to the caller and a stale pending row is replaced',async()=>{
  currentDb=await migratedDatabase();
  const now=2_000_000_000;
  const first=await requests.submitInviteRequest(currentDb,{name:'Grace',email:'grace@example.test'},{nowSeconds:now});
  assert.deepEqual({stored:first.stored,outcome:first.outcome,events:first.outboxEvents.length},
    {stored:true,outcome:'stored',events:0});
  const duplicate=await requests.submitInviteRequest(currentDb,{name:'Grace',email:'grace@example.test'},{nowSeconds:now+1});
  assert.equal(duplicate.outcome,'duplicate');
  assert.equal((await requests.submitInviteRequest(currentDb,{name:'M',email:'member@example.test'},
    {nowSeconds:now})).outcome,'member');
  const later=now+config.INVITE_REQUEST_TTL_SECONDS;
  const replaced=await requests.submitInviteRequest(currentDb,{name:'Grace',email:'grace@example.test'},{nowSeconds:later});
  assert.equal(replaced.outcome,'stored');
  assert.deepEqual((await rows(`SELECT status,email,name FROM invite_requests ORDER BY created_at`)).map(row=>({...row})),[
    {status:'expired',email:null,name:null},{status:'pending',email:'grace@example.test',name:'Grace'},
  ]);
  await assert.rejects(requests.submitInviteRequest(currentDb,{name:'X',email:'bad'}),TypeError);
  await assert.rejects(requests.submitInviteRequest(null,{name:'X',email:'x@example.test'}),TypeError);
  await currentDb.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=10`);
  await assert.rejects(requests.submitInviteRequest(currentDb,{name:'Y',email:'y@example.test'}),
    error=>error instanceof requests.InviteRequestUnavailableError&&error.code==='PRIMARY_CIRCLE_UNAVAILABLE');
  await assert.rejects(requests.submitInviteRequest(currentDb,{name:'Y',email:'y@example.test'},{nowSeconds:0}),TypeError);
});

test('per-IP, per-email, and global limits use auth_rate_limits and stop at the first exhausted dimension',async()=>{
  currentDb=await migratedDatabase();
  const now=2_000_000_000;
  const hash=email=>membership.hashInvitationEmail(email);
  for(let attempt=1;attempt<=5;attempt+=1){
    assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:'203.0.113.1',
      emailHash:hash(`ip${attempt}@example.test`),nowSeconds:now})).allowed,true);
  }
  const ipLimited=await requests.consumeInviteRequestRateLimits(currentDb,{ip:'203.0.113.1',
    emailHash:hash('ip6@example.test'),nowSeconds:now});
  assert.equal(ipLimited.allowed,false);
  assert.equal(ipLimited.dimension,'ip');
  assert.equal(ipLimited.retryAfter,3600-(now%3600));
  for(let attempt=1;attempt<=3;attempt+=1){
    assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:`203.0.113.${10+attempt}`,
      emailHash:hash('same@example.test'),nowSeconds:now})).allowed,true);
  }
  assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:'203.0.113.20',
    emailHash:hash('same@example.test'),nowSeconds:now})).dimension,'email');
  assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:'203.0.113.1',
    emailHash:hash('fresh@example.test'),nowSeconds:now+3600})).allowed,true,'the hourly window resets');
  const keys=await rows(`SELECT key FROM auth_rate_limits`);
  assert.ok(keys.every(row=>/^[0-9a-f]{64}$/.test(String(row.key))),'keys are HMACs, never raw IPs or emails');
  for(let host=1;host<=5;host+=1){
    assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:`2001:db8:aa:bb::${host}`,
      emailHash:hash(`v6-${host}@example.test`),nowSeconds:now})).allowed,true);
  }
  assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:'2001:db8:aa:bb:ffff:1:2:3',
    emailHash:hash('v6-6@example.test'),nowSeconds:now})).dimension,'ip','one IPv6 /64 shares a single budget');
  assert.equal((await requests.consumeInviteRequestRateLimits(currentDb,{ip:'2001:db8:aa:cc::1',
    emailHash:hash('v6-7@example.test'),nowSeconds:now})).allowed,true,'a different /64 has its own budget');
  await assert.rejects(requests.consumeInviteRequestRateLimits(currentDb,{ip:'x',emailHash:'nope'}),TypeError);
  await assert.rejects(requests.consumeInviteRequestRateLimits(null,{}),TypeError);
  await assert.rejects(requests.consumeInviteRequestRateLimits(currentDb,{emailHash:hash('a@b.co'),nowSeconds:0}),TypeError);
  await assert.rejects(requests.consumeInviteRequestRateLimits({execute:async()=>({rows:[{attempts:'x'}]})},
    {ip:'1',emailHash:hash('a@b.co'),nowSeconds:now}),/invalid rate limit state/);
});

test('the public endpoint returns 429 with Retry-After once the client address is exhausted',async()=>{
  currentDb=await migratedDatabase();
  for(let attempt=1;attempt<=5;attempt+=1){
    assert.equal((await submit({name:'Spammer',email:`s${attempt}@example.test`},{ip:'203.0.113.99, 10.0.0.1'})).status,202);
  }
  const limited=await submit({name:'Spammer',email:'s6@example.test'},{ip:'203.0.113.99'});
  assert.equal(limited.status,429);
  assert.match(String(limited.headers['retry-after']),/^\d+$/);
  assert.equal(limited.body.error,'too many requests; try again later');
  assert.ok(limited.elapsedMs>=requests.INVITE_REQUEST_RESPONSE_FLOOR_MS-5);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests`))[0].count,5);
});

test('the stored-only global cap returns the same 429 for every email and ignores non-stored outcomes',async()=>{
  currentDb=await migratedDatabase();
  const now=Math.floor(Date.now()/1000);
  for(let attempt=0;attempt<3;attempt+=1){
    assert.equal((await submit({name:'Member',email:'member@example.test'},{ip:`198.51.100.${30+attempt}`})).status,202);
    assert.equal((await submit({name:'Bot',email:`bot${attempt}@example.test`,website:'x'},{ip:'198.51.100.40'})).status,202);
  }
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests`))[0].count,0);
  await currentDb.execute({sql:`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<50)
    INSERT INTO invite_requests (id,circle_id,email_hash,email,name,status,created_at,expires_at)
    SELECT printf('00000000-0000-4000-8000-%012d',n),10,printf('%064x',n),printf('cap%d@example.test',n),
      'Cap','pending',?-n,?+86400 FROM seq`,args:[now,now]});
  const fresh=await submit({name:'Fresh',email:'fresh@example.test'},{ip:'198.51.100.50'});
  const member=await submit({name:'Owner',email:'owner@example.test'},{ip:'198.51.100.51'});
  for(const response of [fresh,member]){
    assert.equal(response.status,429);
    assert.equal(response.headers['retry-after'],'3600');
    assert.deepEqual(response.body,{error:'too many requests; try again later',retry_after_seconds:3600});
  }
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests WHERE email='fresh@example.test'`))[0].count,0);
  await currentDb.execute({sql:`UPDATE invite_requests SET created_at=created_at-86400 WHERE email LIKE 'cap%'`});
  assert.equal((await submit({name:'Fresh',email:'fresh@example.test'},{ip:'198.51.100.52'})).status,202,
    'the window rolls');
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests WHERE email='fresh@example.test'`))[0].count,1);
});

test('a slow request is logged without request data when it outlasts the floor',async t=>{
  const warnings=[];
  t.mock.method(console,'warn',(...args)=>warnings.push(args.join(' ')));
  currentDb={execute:async()=>{
    await new Promise(resolve=>setTimeout(resolve,requests.INVITE_REQUEST_RESPONSE_FLOOR_MS+50));
    throw new Error('no such table: invite_requests');
  }};
  const response=await submit({name:'Slow Person',email:'slow@example.test'});
  assert.equal(response.status,503);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/^\[invite_request_floor_exceeded\] \{"elapsed_ms":\d+,"floor_ms":750\}$/);
  assert.equal(warnings[0].includes('slow'),false);
});

test('an unready pre-v21 schema fails closed with a generic 503 and is recognised as not installed',async()=>{
  currentDb=createClient({url:'file::memory:'});
  const unready=await submit({name:'Ada',email:'ada@example.test'});
  assert.deepEqual([unready.status,unready.body],[503,{error:'invite requests unavailable'}]);
  assert.equal(sentryEvents[0].context.tags.event,'invite_request_submit_fail');
  assert.equal(JSON.stringify(sentryEvents[0].context).includes('ada@example.test'),false);
  assert.equal((await list()).status,503);
  assert.equal(config.inviteRequestSchemaNotInstalled(sentryEvents[0].error),true);
  assert.equal(config.inviteRequestSchemaNotInstalled(new Error('outer',{cause:new Error('no such table: main.invite_requests')})),true);
  assert.equal(config.inviteRequestSchemaNotInstalled(new Error('disk I/O error')),false);
  assert.equal(config.inviteRequestSchemaNotInstalled(null),false);
  await assert.rejects(config.ensureInviteRequestReadiness(null),TypeError);
});

test('owner notification digests are queued once per hour and carry no requester data',async()=>{
  currentDb=await migratedDatabase();
  enableOwnerNotifications();
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  const capture=installWaitUntilCapture();
  const resend=stubResendFetch();
  try{
    const response=await submit({name:'Mallory <script>',email:'mallory@example.test',note:'Buy pills at spam.example'});
    assert.equal(response.status,202);
    await capture.settle();
    const events=await rows(`SELECT event_type,event_version,idempotency_key,payload_json,status FROM outbox_events
      WHERE event_type=?`,[notification.INVITE_REQUEST_EVENT_TYPE]);
    assert.equal(events.length,1,'the demo co-owner is never notified');
    assert.match(String(events[0].idempotency_key),/^invite-request-digest\/v1\/10\/1\/\d+$/);
    assert.equal(Number(events[0].event_version),1);
    assert.deepEqual(Object.keys(JSON.parse(events[0].payload_json)).sort(),
      ['circle_id','digest_hour','owner_user_id','template_version']);
    for(const forbidden of ['mallory','Mallory','spam.example']){
      assert.equal(String(events[0].payload_json).includes(forbidden),false);
    }
    assert.equal(events[0].status,'delivered','delivered immediately after the response via waitUntil');
    assert.equal(resend.calls.length,1);
    assert.equal(resend.calls[0].to,'owner@example.test');
    assert.equal(resend.calls[0].idempotencyKey,events[0].idempotency_key);
    assert.equal(resend.calls[0].subject,'New invite request for Randori <Circle>');
    assert.match(resend.calls[0].html,/href="https:\/\/randori\.example\.test\/\?view=circle"/);
    assert.match(resend.calls[0].html,/Randori &lt;Circle&gt;/);
    for(const forbidden of ['mallory','Mallory','spam.example','pills']){
      assert.equal(resend.calls[0].html.includes(forbidden),false,forbidden);
    }
    assert.equal((await submit({name:'Second',email:'second@example.test'},{ip:'198.51.100.2'})).status,202);
    await capture.settle();
    assert.equal((await rows(`SELECT COUNT(*) AS count FROM outbox_events WHERE event_type=?`,
      [notification.INVITE_REQUEST_EVENT_TYPE]))[0].count,1,'a second request in the same hour is absorbed');
    assert.equal(resend.calls.length,1);
  }finally{ capture.restore(); resend.restore(); }
});

test('notification configuration, payload parsing, rendering, and suppression fail closed',async()=>{
  currentDb=await migratedDatabase();
  assert.equal(notification.inviteRequestNotificationConfiguration(),null,'no provider configured');
  enableOwnerNotifications();
  assert.deepEqual({...notification.inviteRequestNotificationConfiguration()},{origin:ORIGIN,localRuntime:false});
  for(const env of [
    {INVITE_REQUESTS_ENABLED:'false',CIRCLE_MEMBERSHIP_ENABLED:'true'},
    {INVITE_REQUESTS_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',RESEND_API_KEY:'k',RESEND_FROM:'f',
      NODE_ENV:'production',APP_URL:'http://randori.example.test'},
    {INVITE_REQUESTS_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',RESEND_API_KEY:'k',RESEND_FROM:'f',
      NODE_ENV:'production',APP_URL:'https://randori.example.test/path'},
    {INVITE_REQUESTS_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',RESEND_API_KEY:'k',RESEND_FROM:'f',
      NODE_ENV:'production',APP_URL:'not a url'},
    {INVITE_REQUESTS_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',RESEND_API_KEY:'k',RESEND_FROM:'f',
      NODE_ENV:'development',APP_URL:'https://randori.example.test'},
  ]) assert.equal(notification.inviteRequestNotificationConfiguration({env}),null,JSON.stringify(env));
  const localEnv={INVITE_REQUESTS_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',NODE_ENV:'development',
    APP_URL:'http://127.0.0.1:4173'};
  assert.equal(notification.inviteRequestNotificationConfiguration({localRuntime:true,env:localEnv}).origin,
    'http://127.0.0.1:4173');
  assert.equal(notification.inviteRequestNotificationConfiguration({localRuntime:true,
    env:{...localEnv,APP_URL:'https://randori.example.test'}}),null);
  assert.throws(()=>notification.createInviteRequestNotificationEvent({circleId:0,ownerUserId:1,digestHour:1}),TypeError);
  assert.throws(()=>notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl:ORIGIN}),TypeError);
  for(const baseUrl of ['http://randori.example.test','https://localhost','https://x.test/path','nope']){
    assert.throws(()=>notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl,send:async()=>({})}),
      TypeError,baseUrl);
  }
  assert.throws(()=>notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl:'https://x.test',
    send:async()=>({}),localRuntime:true}),TypeError);
  const sent=[];
  const handler=notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl:`${ORIGIN}/`,
    send:async message=>{ sent.push(message); return {data:{id:'msg_1'}}; }});
  const event=(payload,version=1)=>({eventVersion:version,idempotencyKey:'invite-request-digest/v1/10/1/1',payload});
  const payload={circle_id:10,owner_user_id:1,digest_hour:1,template_version:1};
  assert.deepEqual(await handler(event(payload)),{status:'suppressed',reasonCode:'NO_PENDING_INVITE_REQUESTS'});
  await requests.submitInviteRequest(currentDb,{name:'One',email:'one@example.test'});
  await requests.submitInviteRequest(currentDb,{name:'Two',email:'two@example.test'});
  assert.deepEqual(await handler(event(payload)),{status:'delivered',providerName:'email',providerMessageId:'msg_1'});
  assert.equal(sent[0].subject,'2 invite requests for Randori <Circle>');
  assert.match(sent[0].html,/2 people have asked to join/);
  assert.deepEqual(await handler(event({...payload,owner_user_id:2})),
    {status:'suppressed',reasonCode:'INVITE_REQUEST_OWNER_INACTIVE'});
  assert.deepEqual(await handler(event({...payload,owner_user_id:5})),
    {status:'suppressed',reasonCode:'INVITE_REQUEST_OWNER_INACTIVE'},'demo owners are never emailed');
  await currentDb.execute(`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (1,0)`);
  assert.deepEqual(await handler(event(payload)),{status:'suppressed',reasonCode:'NOTIFICATIONS_DISABLED'});
  await currentDb.execute(`UPDATE user_notification_prefs SET email_enabled=1 WHERE user_id=1`);
  await currentDb.execute(`UPDATE auth_accounts SET email='not-an-email' WHERE id=1`);
  assert.deepEqual(await handler(event(payload)),{status:'suppressed',reasonCode:'OWNER_EMAIL_INVALID'});
  await currentDb.execute(`UPDATE auth_accounts SET email='owner@example.test' WHERE id=1`);
  const reject=async(input,code,retryable)=>{
    await assert.rejects(handler(input),error=>error.code===code&&error.retryable===retryable);
  };
  await reject(event(payload,2),'EVENT_VERSION_UNSUPPORTED',true);
  await reject(event(payload,0),'EVENT_VERSION_UNSUPPORTED',false);
  await reject(event({...payload,extra:1}),'PAYLOAD_INVALID',false);
  await reject(event([]),'PAYLOAD_INVALID',false);
  await reject(event({...payload,template_version:2}),'PAYLOAD_INVALID',false);
  await reject(event({...payload,circle_id:'x'}),'PAYLOAD_INVALID',false);
  for(const [status,code,retryable] of [[429,'PROVIDER_RATE_LIMITED',true],[422,'PROVIDER_REJECTED',false],
    [500,'PROVIDER_FAILED',true]]){
    const failing=notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl:ORIGIN,
      send:async()=>({error:Object.assign(new Error('provider'),{statusCode:status})})});
    await assert.rejects(failing(event(payload)),error=>error.code===code&&error.retryable===retryable);
  }
  const passthrough=notification.createInviteRequestNotificationHandler({db:currentDb,baseUrl:ORIGIN,
    send:async()=>{ throw new (await import('../../api/_outbox.js')).OutboxDeliveryError('DELIVERY_TIMEOUT'); }});
  await assert.rejects(passthrough(event(payload)),error=>error.code==='DELIVERY_TIMEOUT');
});

test('the outbox registry builds the notification handler only when delivery is configured',async()=>{
  currentDb=await migratedDatabase();
  const req={headers:{host:'randori.example.test'},socket:{remoteAddress:'198.51.100.1'}};
  assert.equal((await delivery.outboxDeliveryPlan(currentDb,ORIGIN,req,
    {types:[notification.INVITE_REQUEST_EVENT_TYPE]})).handlers.size,0);
  enableOwnerNotifications();
  const plan=await delivery.outboxDeliveryPlan(currentDb,ORIGIN,req,{types:[notification.INVITE_REQUEST_EVENT_TYPE]});
  assert.deepEqual([...plan.handlers.keys()],[notification.INVITE_REQUEST_EVENT_TYPE]);
  assert.ok(delivery.OUTBOX_DELIVERY_TYPES.some(item=>item.type===notification.INVITE_REQUEST_EVENT_TYPE
    &&item.key==='invite_request_delivery'));
});

test('the owner review list is primary-owner only, newest first, paginated, and hides expired rows',async()=>{
  currentDb=await migratedDatabase();
  const base=Math.floor(Date.now()/1000);
  for(let index=0;index<5;index+=1){
    await requests.submitInviteRequest(currentDb,{name:`Person ${index}`,email:`p${index}@example.test`,
      note:index===0?'First':null},{nowSeconds:base-100+index});
  }
  await requests.submitInviteRequest(currentDb,{name:'Old',email:'old@example.test'},
    {nowSeconds:base-config.INVITE_REQUEST_TTL_SECONDS-1});
  assert.equal((await list('member')).status,403);
  assert.equal((await list('outsider')).status,403);
  const first=await list('owner',{status:'pending',limit:'2'});
  assert.equal(first.status,200);
  assert.equal(first.body.pending_count,5,'an overdue pending request is never shown or counted');
  assert.deepEqual(first.body.requests.map(item=>item.name),['Person 4','Person 3']);
  assert.deepEqual(Object.keys(first.body.requests[0]).sort(),['created_at','email','expires_at','id','name','note']);
  assert.equal(first.body.requests[0].email,'p4@example.test');
  assert.equal(first.body.requests[0].created_at,new Date((base-96)*1000).toISOString());
  const second=await list('owner',{limit:'2',cursor:first.body.next_cursor});
  assert.deepEqual(second.body.requests.map(item=>item.name),['Person 2','Person 1']);
  const third=await list('owner',{limit:'2',cursor:second.body.next_cursor});
  assert.deepEqual(third.body.requests.map(item=>({name:item.name,note:item.note})),[{name:'Person 0',note:'First'}]);
  assert.equal(third.body.next_cursor,null);
  const all=await list('owner');
  assert.equal(all.body.requests.length,5);
  assert.equal(all.body.next_cursor,null);
  assert.equal(requests.decodeInviteRequestCursor(''),null);
  assert.equal(requests.decodeInviteRequestCursor(Buffer.from('12.not-a-uuid').toString('base64url')),false);
  assert.equal(requests.decodeInviteRequestCursor(Buffer.from('0.00000000-0000-4000-8000-000000000000').toString('base64url')),false);
  assert.equal(requests.decodeInviteRequestCursor(42),false);
  await assert.rejects(requests.listPendingInviteRequests(currentDb,{circleId:10,limit:0}),TypeError);
  await assert.rejects(requests.listPendingInviteRequests(null,{circleId:10}),TypeError);
});

test('approval creates exactly one normal email-bound invitation, audits, scrubs, and replays idempotently',async()=>{
  currentDb=await migratedDatabase();
  await requests.submitInviteRequest(currentDb,{name:'Ada',email:'ada@example.test',note:'Hi'});
  const [{id}]=await rows(`SELECT id FROM invite_requests`);
  assert.deepEqual((await decide({id,decision:'approve'})).status,400);
  assert.deepEqual((await decide({id,decision:'approve',expected_status:'approved'})).status,400);
  assert.deepEqual((await decide({id:'nope',decision:'approve',expected_status:'pending'})).status,400);
  assert.deepEqual((await decide({id,decision:'maybe',expected_status:'pending'})).status,400);
  assert.equal((await decide({id,decision:'approve',expected_status:'pending'},{identity:'member'})).status,403);
  assert.equal((await decide({id:'00000000-0000-4000-8000-000000000000',decision:'approve',
    expected_status:'pending'})).status,404);
  const approved=await decide({id,decision:'approve',expected_status:'pending'});
  assert.equal(approved.status,200);
  assert.equal(approved.body.request.status,'approved');
  assert.equal(approved.body.invitation.email,'ada@example.test');
  assert.equal(approved.body.invitation.status,'pending');
  assert.match(approved.body.invitation.invite_url,/^\/invite#invite=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(approved.body.email_delivery,{queued:false},'unadopted key control keeps copy-link approval');
  const invitations=await rows(`SELECT id,circle_id,email_hash,created_by FROM circle_invitations`);
  assert.equal(invitations.length,1);
  assert.deepEqual({...invitations[0]},{id:approved.body.invitation.id,circle_id:10,
    email_hash:membership.hashInvitationEmail('ada@example.test'),created_by:1});
  const token=approved.body.invitation.invite_url.split('=')[1];
  assert.equal((await membership.prepareInvitationClaim(currentDb,{token})).ok,true,'the invitation is usable');
  const request=(await rows(`SELECT status,email,name,note,decided_by,invitation_id FROM invite_requests`))[0];
  assert.deepEqual({...request},{status:'approved',email:null,name:null,note:null,decided_by:1,
    invitation_id:approved.body.invitation.id});
  assert.deepEqual((await rows(`SELECT event_type,actor_user_id,invitation_id,dedupe_key FROM circle_audit_events
    ORDER BY id`)).map(row=>row.event_type),['invitation.created','invite_request.approved']);
  const replay=await decide({id,decision:'approve',expected_status:'pending'});
  assert.equal(replay.status,200);
  assert.equal(replay.body.replayed,true);
  assert.deepEqual(replay.body.invitation,{id:approved.body.invitation.id});
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,1);
  const conflict=await decide({id,decision:'decline',expected_status:'pending'});
  assert.deepEqual([conflict.status,conflict.body],[409,{error:'invite request is no longer pending',
    code:'invite_request_not_pending',status:'approved'}]);
  const listed=await invoke(invitationsHandler,{url:'/api/invitations',query:{endpoint:'invitations'},
    headers:{'x-test-auth':'owner'}});
  assert.deepEqual(listed.body.invitations.map(item=>[item.id,item.status]),[[approved.body.invitation.id,'pending']]);
});

test('approval queues the existing invitation email and delivers it right after the response',async()=>{
  currentDb=await migratedDatabase();
  enableOwnerNotifications();
  process.env.INVITATION_EMAIL_DELIVERY_ENABLED='true';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,21).toString('base64url');
  process.env.OUTBOX_IMMEDIATE_DELIVERY='true';
  await adoptCredentialKeyControl(currentDb,invitationEmail.invitationKeyRing());
  await requests.submitInviteRequest(currentDb,{name:'Lin',email:'lin@example.test'});
  const [{id}]=await rows(`SELECT id FROM invite_requests`);
  const capture=installWaitUntilCapture();
  const resend=stubResendFetch();
  try{
    const approved=await decide({id,decision:'approve',expected_status:'pending'});
    assert.equal(approved.status,200);
    assert.deepEqual(approved.body.email_delivery,{queued:true});
    await capture.settle();
    const events=await rows(`SELECT idempotency_key,status FROM outbox_events WHERE event_type=?`,
      [invitationEmail.INVITATION_EMAIL_EVENT_TYPE]);
    assert.deepEqual(events.map(row=>({...row})),[{idempotency_key:`invitation-email/v1/${approved.body.invitation.id}/1`,
      status:'delivered'}]);
    assert.equal(resend.calls.length,1);
    assert.equal(resend.calls[0].to,'lin@example.test');
  }finally{ capture.restore(); resend.restore(); }
});

test('decline scrubs and audits; expired requests conflict; domain guards reject invalid input',async()=>{
  currentDb=await migratedDatabase();
  const now=Math.floor(Date.now()/1000);
  await requests.submitInviteRequest(currentDb,{name:'Dee',email:'dee@example.test',note:'Note'});
  await requests.submitInviteRequest(currentDb,{name:'Old',email:'old@example.test'},
    {nowSeconds:now-config.INVITE_REQUEST_TTL_SECONDS-5});
  const byEmail=async email=>(await rows(`SELECT id FROM invite_requests WHERE email=?`,[email]))[0].id;
  const deeId=await byEmail('dee@example.test');
  const oldId=await byEmail('old@example.test');
  const declined=await decide({id:deeId,decision:'decline',expected_status:'pending'});
  assert.equal(declined.status,200);
  assert.deepEqual(Object.keys(declined.body).sort(),['ok','request']);
  assert.equal(declined.body.request.status,'declined');
  const row=(await rows(`SELECT status,email,name,note,decided_by,invitation_id FROM invite_requests WHERE id=?`,[deeId]))[0];
  assert.deepEqual({...row},{status:'declined',email:null,name:null,note:null,decided_by:1,invitation_id:null});
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,0,'decline sends nothing');
  assert.deepEqual((await rows(`SELECT event_type,invitation_id FROM circle_audit_events`)).map(item=>({...item})),
    [{event_type:'invite_request.declined',invitation_id:null}]);
  const replay=await decide({id:deeId,decision:'decline',expected_status:'pending'});
  assert.deepEqual([replay.status,replay.body.replayed,replay.body.invitation],[200,true,undefined]);
  const expired=await decide({id:oldId,decision:'approve',expected_status:'pending'});
  assert.deepEqual([expired.status,expired.body.status],[409,'expired']);
  assert.equal((await rows(`SELECT status FROM invite_requests WHERE id=?`,[oldId]))[0].status,'expired');
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,0);
  await assert.rejects(requests.decideInviteRequest(currentDb,{requestId:'x',decision:'approve',ownerUserId:1}),TypeError);
  await assert.rejects(requests.decideInviteRequest(null,{}),TypeError);
  await requests.submitInviteRequest(currentDb,{name:'Racer',email:'racer@example.test'});
  const racer=await byEmail('racer@example.test');
  await currentDb.execute(`UPDATE circle_memberships SET role='member' WHERE user_id=1`);
  await currentDb.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
    VALUES (10,3,'owner','active',datetime('now'),datetime('now'))`);
  assert.equal((await requests.decideInviteRequest(currentDb,{requestId:racer,decision:'approve',ownerUserId:1})).status,
    'not_found','a demoted owner cannot decide');
  const transferred=await requests.decideInviteRequest(currentDb,{requestId:racer,decision:'approve',ownerUserId:3});
  assert.equal(transferred.status,'approved','the current owner can decide');
});

test('decision failures roll back the invitation and the request together',async()=>{
  currentDb=await migratedDatabase();
  await requests.submitInviteRequest(currentDb,{name:'Rollback',email:'rollback@example.test'});
  const [{id}]=await rows(`SELECT id FROM invite_requests`);
  await currentDb.execute(`CREATE TRIGGER test_fail_audit BEFORE INSERT ON circle_audit_events
    WHEN NEW.event_type='invite_request.approved' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  const failed=await decide({id,decision:'approve',expected_status:'pending'});
  assert.deepEqual([failed.status,failed.body],[503,{error:'invite requests unavailable'}]);
  assert.equal(sentryEvents.at(-1).context.tags.event,'invite_request_decision_fail');
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,0);
  assert.equal((await rows(`SELECT status FROM invite_requests`))[0].status,'pending');
});

test('bounded retention expires overdue pending rows and purges decided rows after 30 days',async()=>{
  currentDb=await migratedDatabase();
  const now=2_000_000_000;
  const day=24*60*60;
  for(let index=0;index<3;index+=1){
    await requests.submitInviteRequest(currentDb,{name:`Old ${index}`,email:`old${index}@example.test`},
      {nowSeconds:now-31*day+index});
  }
  await requests.submitInviteRequest(currentDb,{name:'Fresh',email:'fresh@example.test'},{nowSeconds:now-day});
  await requests.submitInviteRequest(currentDb,{name:'Decided',email:'decided@example.test'},{nowSeconds:now-40*day});
  const decidedId=(await rows(`SELECT id FROM invite_requests WHERE email='decided@example.test'`))[0].id;
  assert.equal((await requests.decideInviteRequest(currentDb,{requestId:decidedId,decision:'decline',ownerUserId:1,
    nowSeconds:now-35*day})).status,'declined');
  const firstPass=await config.purgeInviteRequests(currentDb,{limit:2,nowSeconds:now});
  assert.deepEqual({...firstPass},{expired:2,purged:1,more:true});
  const secondPass=await config.purgeInviteRequests(currentDb,{limit:2,nowSeconds:now});
  assert.deepEqual({...secondPass},{expired:1,purged:0,more:false});
  assert.deepEqual((await rows(`SELECT status,COUNT(*) AS count,MAX(email) AS email FROM invite_requests
    GROUP BY status ORDER BY status`)).map(row=>({...row})),[
    {status:'expired',count:3,email:null},{status:'pending',count:1,email:'fresh@example.test'},
  ]);
  const later=await config.purgeInviteRequests(currentDb,{nowSeconds:now+31*day});
  assert.deepEqual({...later},{expired:1,purged:3,more:false});
  assert.deepEqual((await rows(`SELECT status FROM invite_requests`)).map(row=>row.status),['expired']);
  await assert.rejects(config.purgeInviteRequests(currentDb,{limit:0}),TypeError);
  await assert.rejects(config.purgeInviteRequests(null),TypeError);
  await assert.rejects(config.purgeInviteRequests({execute:async()=>({rows:[]})}),/database time unavailable/);
});

test('capabilities advertise invite requests only when enabled and the v21 schema is ready',async()=>{
  const capabilities=async()=>(await invoke(authHandler,{url:'/api/auth/capabilities',
    query:{endpoint:'capabilities'},headers:{host:'randori.example.test'}})).body.capabilities;
  currentDb=await migratedDatabase();
  assert.equal((await capabilities()).inviteRequests,true);
  delete process.env.INVITE_REQUESTS_ENABLED;
  assert.equal('inviteRequests' in await capabilities(),false);
  process.env.INVITE_REQUESTS_ENABLED='true';
  currentDb.close();
  currentDb=createClient({url:'file::memory:'});
  assert.equal('inviteRequests' in await capabilities(),false,'pre-v21 schema is not advertised');
  currentDb.close();
  currentDb=await migratedDatabase();
  await currentDb.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=10`);
  assert.equal('inviteRequests' in await capabilities(),false,'no active primary circle is not advertised');
  assert.equal((await submit({name:'Ada',email:'ada@example.test'})).status,503);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM auth_rate_limits`))[0].count,0,
    'no rate-limit budget is spent when intake is unavailable');
});

test('the shared invitation writer rejects invalid input, non-owners, and missing audit or email intent',async()=>{
  const {insertOwnerInvitation}=await import('../../api/_invitation-create.js');
  currentDb=await migratedDatabase();
  await assert.rejects(insertOwnerInvitation(null,{}),TypeError);
  for(const input of [{ownerUserId:1,circleId:10,email:'bad'},{ownerUserId:0,circleId:10,email:'a@b.co'},
    {ownerUserId:1,circleId:'x',email:'a@b.co'}]){
    await assert.rejects(insertOwnerInvitation(currentDb,input),TypeError,JSON.stringify(input));
  }
  assert.deepEqual({...await insertOwnerInvitation(currentDb,{ownerUserId:2,circleId:10,email:'x@example.test'})},
    {ok:false},'a member cannot create an invitation');
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,0);
  const scripted=results=>({execute:async()=>results.shift()});
  await assert.rejects(insertOwnerInvitation(scripted([{rows:[{id:'i',circle_id:10}]},{rows:[]}]),
    {ownerUserId:1,circleId:10,email:'x@example.test'}),/audit missing/);
  process.env.NODE_ENV='development';
  await assert.rejects(insertOwnerInvitation(scripted([{rows:[{id:'i',circle_id:10}]},{rows:[{id:1}]},{rowsAffected:0}]),
    {ownerUserId:1,circleId:10,email:'x@example.test',emailConfiguration:{origin:'http://127.0.0.1:4173'},localRuntime:true}),
  /email intent missing/);
});

test('approval re-checks membership and live invitations inside the transaction',async()=>{
  currentDb=await migratedDatabase();
  await requests.submitInviteRequest(currentDb,{name:'Joiner',email:'joiner@example.test'});
  await requests.submitInviteRequest(currentDb,{name:'Invitee',email:'invitee@example.test'});
  const idOf=async email=>(await rows(`SELECT id FROM invite_requests WHERE email=?`,[email]))[0].id;
  const joinerId=await idOf('joiner@example.test');
  const inviteeId=await idOf('invitee@example.test');
  await currentDb.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (7,'Joiner@Example.test','x','Joiner','#010101')`);
  await currentDb.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
    VALUES (10,7,'member','active',datetime('now'),datetime('now'))`);
  const member=await decide({id:joinerId,decision:'approve',expected_status:'pending'});
  assert.deepEqual([member.status,member.body.code,member.body.status],[409,'invite_request_already_member','pending']);
  const owned=await invoke(invitationsHandler,{method:'POST',url:'/api/invitations',query:{endpoint:'invitations'},
    headers:{'x-test-auth':'owner',origin:ORIGIN,host:'randori.example.test'},body:{email:'invitee@example.test'}});
  assert.equal(owned.status,201);
  const invited=await decide({id:inviteeId,decision:'approve',expected_status:'pending'});
  assert.deepEqual([invited.status,invited.body.code],[409,'invite_request_already_invited']);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,1);
  assert.deepEqual((await rows(`SELECT status FROM invite_requests ORDER BY email`)).map(row=>row.status),
    ['pending','pending'],'the owner can still decline either request');
  assert.equal((await decide({id:joinerId,decision:'decline',expected_status:'pending'})).status,200);
});

test('concurrent approvals from two connections create exactly one invitation',async()=>{
  currentDb=await migratedDatabase();
  await requests.submitInviteRequest(currentDb,{name:'Race',email:'race@example.test'});
  const [{id}]=await rows(`SELECT id FROM invite_requests`);
  const url=pathToFileURL(join(temporaryDirectories.at(-1),'current.sqlite')).href;
  const clients=[createClient({url}),createClient({url})];
  try{
    const outcomes=await Promise.allSettled(clients.map(client=>
      requests.decideInviteRequest(client,{requestId:id,decision:'approve',ownerUserId:1})));
    const fulfilled=outcomes.filter(outcome=>outcome.status==='fulfilled').map(outcome=>outcome.value);
    assert.ok(fulfilled.length>=1);
    assert.equal(fulfilled.filter(result=>result.status==='approved'&&!result.replayed).length,1,
      'exactly one approval writes');
    for(const result of fulfilled) assert.equal(result.status,'approved');
    for(const outcome of outcomes.filter(item=>item.status==='rejected')){
      assert.match(String(outcome.reason?.code||outcome.reason?.message),/BUSY|locked/i,'only a lock conflict may fail');
    }
  }finally{ for(const client of clients) client.close(); }
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,1);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='invite_request.approved'`))[0].count,1);
});

test('a secondary-circle owner who is not the primary owner cannot list or decide',async()=>{
  currentDb=await migratedDatabase();
  await currentDb.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (20,'4d31d5eb-2a17-4b5b-a5fe-6a82e2ee177e','side-circle','Side Circle',0,3,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (20,3,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  await requests.submitInviteRequest(currentDb,{name:'Target',email:'target@example.test'});
  const [{id}]=await rows(`SELECT id FROM invite_requests`);
  assert.equal((await list('outsider')).status,403);
  assert.equal((await decide({id,decision:'approve',expected_status:'pending'},{identity:'outsider'})).status,403);
  assert.equal((await requests.decideInviteRequest(currentDb,{requestId:id,decision:'approve',ownerUserId:3})).status,
    'not_found','the domain layer also scopes decisions to the request circle owner');
  assert.equal((await rows(`SELECT status FROM invite_requests`))[0].status,'pending');
});

test('retention keeps up with more than one batch and the owner list scrubs overdue rows on read',async()=>{
  currentDb=await migratedDatabase();
  const now=2_000_000_000;
  await currentDb.execute({sql:`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1200)
    INSERT INTO invite_requests (id,circle_id,email_hash,email,name,status,created_at,expires_at)
    SELECT printf('00000000-0000-4000-8000-%012d',n),10,printf('%064x',n),printf('old%d@example.test',n),
      'Old','pending',?-n,?-n FROM seq`,args:[now-config.INVITE_REQUEST_TTL_SECONDS,now]});
  const swept=await config.runInviteRequestRetention(currentDb,{nowSeconds:now});
  assert.deepEqual({...swept},{expired:1200,purged:0,batches:3,more:false});
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM invite_requests WHERE email IS NOT NULL`))[0].count,0);
  const capped=await config.runInviteRequestRetention(currentDb,{nowSeconds:now+31*86400,limit:100,maxBatches:2});
  assert.deepEqual({...capped},{expired:0,purged:200,batches:2,more:true},'a run is capped and reports remaining work');
  await assert.rejects(config.runInviteRequestRetention(currentDb,{maxBatches:0}),TypeError);

  await currentDb.execute(`DELETE FROM invite_requests`);
  const real=Math.floor(Date.now()/1000);
  await requests.submitInviteRequest(currentDb,{name:'Lapsed',email:'lapsed@example.test'},
    {nowSeconds:real-config.INVITE_REQUEST_TTL_SECONDS-10});
  assert.equal((await list()).status,200);
  assert.deepEqual({...(await rows(`SELECT status,email,name FROM invite_requests WHERE email_hash=?`,
    [membership.hashInvitationEmail('lapsed@example.test')]))[0]},{status:'expired',email:null,name:null});
  await assert.rejects(config.expireOverdueInviteRequests(currentDb,{circleId:0}),TypeError);
  await assert.rejects(config.expireOverdueInviteRequests(null,{circleId:10}),TypeError);
});

test('client addresses are keyed by IPv6 /64 and IPv4-mapped addresses collapse to IPv4',async()=>{
  const {clientAddress,rateLimitAddress}=await import('../../api/_client-address.js');
  assert.equal(clientAddress({headers:{'x-forwarded-for':' 203.0.113.9 , 10.0.0.1'}}),'203.0.113.9');
  assert.equal(clientAddress({socket:{remoteAddress:'198.51.100.3'}}),'198.51.100.3');
  assert.equal(clientAddress({}),'unknown');
  assert.equal(rateLimitAddress('2001:db8:1:2:3:4:5:6'),'2001:0db8:0001:0002::/64');
  assert.equal(rateLimitAddress('[2001:DB8:1:2::9]'),'2001:0db8:0001:0002::/64');
  assert.equal(rateLimitAddress('fe80::1%en0'),'fe80:0000:0000:0000::/64');
  assert.equal(rateLimitAddress('::ffff:192.0.2.1'),'192.0.2.1');
  assert.equal(rateLimitAddress('64:ff9b::192.0.2.1'),'0064:ff9b:0000:0000::/64');
  assert.equal(rateLimitAddress('203.0.113.5'),'203.0.113.5');
  for(const value of ['1::2::3','1:2:3:4:5:6:7','1:2:3:4:5:6:7:8:9','::ffff:999.0.0.1','12345::1']){
    assert.equal(rateLimitAddress(value),value,value);
  }
  assert.equal(rateLimitAddress(''),'unknown');
});

test('intake uses the shared strict rules and a legacy row the rules now reject cannot be approved (ID-68)',async()=>{
  for(const email of ['a..b@example.test','a@b.c','jürgen@example.test','a@localhost']){
    assert.equal(requests.validateInviteRequestInput({name:'Al',email}).fields.email,'Enter a valid email address.',email);
  }
  assert.equal(requests.validateInviteRequestInput({name:'Al',email:' Al+Prep@Example.Test '}).value.email,
    'al+prep@example.test');

  currentDb=await migratedDatabase();
  // Stored before ID-68, when only the loose shape was required.
  await requests.submitInviteRequest(currentDb,{name:'Legacy',email:'legacy@example.c'});
  const [{id}]=await rows(`SELECT id FROM invite_requests WHERE email='legacy@example.c'`);
  const refused=await decide({id,decision:'approve',expected_status:'pending'});
  assert.deepEqual([refused.status,refused.body.code,refused.body.status],[409,'invite_request_email_invalid','pending']);
  assert.equal((await rows(`SELECT COUNT(*) AS count FROM circle_invitations`))[0].count,0);
  assert.equal((await decide({id,decision:'decline',expected_status:'pending'})).status,200,'the owner can still decline it');
});
