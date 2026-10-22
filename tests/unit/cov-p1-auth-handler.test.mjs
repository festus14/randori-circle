// Branch-level behaviour tests for api/auth.js. Every collaborator module is
// replaced with a controllable stub so each handler's guard, fail-closed, and
// enumeration-safety decision can be exercised in isolation. Integration
// coverage against a real migrated database lives in the *-api tests.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import bcrypt from 'bcryptjs';

const SECRET='cov-p1-auth-handler-secret-at-least-32-bytes';
const HOST='randori.example.test';
const ORIGIN=`https://${HOST}`;
const BINDING='A'.repeat(43);
const BINDING_HASH='a'.repeat(64);
const SESSION_HASH='b'.repeat(64);
const PASSWORD='correct-horse-battery';
const PASSWORD_HASH=bcrypt.hashSync(PASSWORD,4);
const ENV_KEYS=['NODE_ENV','ALLOW_OPEN_SIGNUP','SIGNUP_ALLOWLIST','CIRCLE_MEMBERSHIP_ENABLED',
  'MULTI_CIRCLE_CONTROL_PLANE_ENABLED','IDENTITY_MANAGEMENT_ENABLED','RANDORI_LOCAL_RUNTIME',
  'RANDORI_LOCAL_FIRST_USER_ADMIN','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL','CIRCLE_HEALTH_ENABLED','ADMIN_DIAGNOSTICS_ENABLED'];

let S;
const ok=async()=>{};
function freshState(){
  return {
    sqlLog:[],
    sql:()=>({rows:[]}),
    attempts:()=>1,
    admins:new Set(),
    mutationOrigin:()=>true,
    signed:()=>({id:7}),
    verify:async()=>({id:7,email:'member@example.test',sessionHash:SESSION_HASH}),
    issueSession:async()=>'session-token',
    revokeRequestSession:ok,
    revokeAccountSessions:ok,
    authReady:ok,
    membership:{
      enabled:false,registrationState:async()=>'uninitialized',ready:ok,
      hasActive:async()=>true,hasPrimary:async()=>true,
      boundClaim:()=>({binding_hash:BINDING_HASH}),claimForHash:()=>({binding_hash:BINDING_HASH}),
      live:async()=>({ok:true}),validate:async()=>({ok:true,used_by:null}),
      createPassword:async()=>({ok:true,user_id:21}),createGoogle:async()=>({ok:true,user_id:22,is_admin:false}),
      accept:async()=>({ok:true}),
    },
    flags:{controlPlane:false,availability:false,coordination:false,scheduling:false},
    localIdentity:false,
    localRuntime:false,
    googleConfig:{appOrigin:ORIGIN,clientId:'client',clientSecret:'secret',redirectUri:`${ORIGIN}/api/auth/google/callback`},
    exchange:async()=>({email:'google@example.test',name:'Google Person',issuer:'https://accounts.google.com',subject:'sub-1'}),
    activation:{config:null,ready:ok,request:async()=>({outboxEvents:[]}),resend:async()=>({outboxEvents:[]}),verify:async()=>({status:'verified',sessionToken:'activated',user:{id:3}})},
    reset:{config:null,ready:ok,request:async()=>({outboxEvents:[]}),consume:async()=>({status:'reset'})},
    recent:{read:async()=>({ok:true,method:'password'}),record:async()=>({method:'password',at:'now'}),require:ok},
    delivered:[],
    identity:{hashConfigured:false,ready:ok,state:async()=>({methods:['password']}),
      addPassword:async()=>({status:'added'}),unlinkPassword:async()=>({status:'unlinked'}),
      unlinkGoogle:async()=>({status:'unlinked'}),link:async()=>({status:'linked'}),observe:async()=>({changed:false})},
  };
}
S=freshState();

const fakeDb={
  async execute(statement){
    const sql=typeof statement==='string'?statement:statement.sql;
    const args=typeof statement==='string'?[]:statement.args;
    S.sqlLog.push({sql,args});
    if(sql.includes('INSERT INTO auth_rate_limits')) return {rows:[{attempts:S.attempts(sql,args)}].filter(row=>row.attempts!==null)};
    if(sql.includes('DELETE FROM auth_rate_limits')) return {rows:[]};
    return S.sql(sql,args);
  },
};

mock.module('../../api/_db.js',{exports:{
  getClient:()=>{ if(S.clientThrows) throw new Error('no database'); return fakeDb; },
  getJwtSecret:()=>SECRET,
  deterministicColor:()=>'#123456',
  getAdminEmails:()=>S.admins,
  issueSession:(...args)=>S.issueSession(...args),
  issueSessionInTransaction:async()=>'tx-token',
  revokeAccountSessions:(...args)=>S.revokeAccountSessions(...args),
  revokeRequestSession:(...args)=>S.revokeRequestSession(...args),
  verifyMutationOrigin:req=>S.mutationOrigin(req),
  verifyRequestAuth:(...args)=>S.verify(...args),
  verifySignedRequestAuth:req=>S.signed(req),
}});
mock.module('../../api/_auth-readiness.js',{exports:{ensureAuthReadiness:db=>S.authReady(db)}});
mock.module('../../api/_circle-membership.js',{exports:{
  acceptPreparedInvitation:(...a)=>S.membership.accept(...a),
  circleMembershipRegistrationState:(...a)=>S.membership.registrationState(...a),
  circleMembershipEnabled:()=>S.membership.enabled,
  createGoogleAccountFromPreparedInvitation:(...a)=>S.membership.createGoogle(...a),
  createPasswordAccountFromPreparedInvitation:(...a)=>S.membership.createPassword(...a),
  ensureCircleMembershipReadiness:(...a)=>S.membership.ready(...a),
  hasActiveCircleMembership:(...a)=>S.membership.hasActive(...a),
  hasActivePrimaryCircleMembership:(...a)=>S.membership.hasPrimary(...a),
  readBoundInviteClaim:(...a)=>S.membership.boundClaim(...a),
  readInviteClaimForBindingHash:(...a)=>S.membership.claimForHash(...a),
  validateLivePreparedClaim:(...a)=>S.membership.live(...a),
  validatePreparedInvitation:(...a)=>S.membership.validate(...a),
}});
mock.module('../../api/_active-circle.js',{exports:{
  multiCircleAvailabilityEnabled:()=>S.flags.availability,
  multiCircleControlPlaneEnabled:()=>S.flags.controlPlane,
  secondaryCircleCoordinationEnabled:()=>S.flags.coordination,
  secondaryCircleSchedulingEnabled:()=>S.flags.scheduling,
}});
mock.module('../../api/_local-runtime.js',{exports:{
  localIdentityAdapterEnabled:()=>S.localIdentity,
  localRuntimeRequest:()=>S.localRuntime,
}});
mock.module('../../api/_auth-config.js',{exports:{
  googleOAuthRequestConfiguration:()=>S.googleConfig,
  setAuthResponseHeaders:res=>res.setHeader('Cache-Control','no-store'),
}});
mock.module('../../api/_google-oidc.js',{exports:{
  GOOGLE_AUTHORIZATION_ENDPOINT:'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_REAUTH_MAX_AGE_SECONDS:120,
  exchangeGoogleAuthorizationCode:(...a)=>S.exchange(...a),
  publicGoogleAuthorizationError:value=>value==='access_denied'?'access_denied':'authorization_failed',
  publicGoogleErrorCode:()=>'provider_error',
}});
mock.module('../../api/_email-activation.js',{exports:{
  emailActivationConfiguration:()=>S.activation.config,
  ensureEmailActivationReadiness:(...a)=>S.activation.ready(...a),
  requestEmailActivation:(...a)=>S.activation.request(...a),
  resendEmailActivation:(...a)=>S.activation.resend(...a),
  verifyEmailActivation:(...a)=>S.activation.verify(...a),
}});
mock.module('../../api/_password-reset.js',{exports:{
  consumePasswordReset:(...a)=>S.reset.consume(...a),
  ensurePasswordResetReadiness:(...a)=>S.reset.ready(...a),
  passwordResetConfiguration:()=>S.reset.config,
  requestPasswordReset:(...a)=>S.reset.request(...a),
}});
mock.module('../../api/_recent-auth.js',{exports:{
  readRecentAuth:(...a)=>S.recent.read(...a),
  recordRecentAuth:(...a)=>S.recent.record(...a),
  requireRecentAuth:(...a)=>S.recent.require(...a),
}});
mock.module('../../api/_outbox-immediate.js',{exports:{
  deliverCommittedOutboxEvents:(req,events)=>{ S.delivered.push(events); },
}});
mock.module('../../api/_identity-linking.js',{exports:{
  GOOGLE_ISSUER:'https://accounts.google.com',
  addPasswordCredential:(...a)=>S.identity.addPassword(...a),
  ensureIdentityLinkingReadiness:(...a)=>S.identity.ready(...a),
  identityEmailHashConfigured:()=>S.identity.hashConfigured,
  linkGoogleCredential:(...a)=>S.identity.link(...a),
  observeGoogleProviderEmail:(...a)=>S.identity.observe(...a),
  readIdentityState:(...a)=>S.identity.state(...a),
  unlinkGoogleCredential:(...a)=>S.identity.unlinkGoogle(...a),
  unlinkPasswordCredential:(...a)=>S.identity.unlinkPassword(...a),
}});

const {default:handler,localPasswordSignupEnabled,validSignupPassword}=await import('../../api/auth.js');

beforeEach(()=>{ S=freshState(); for(const key of ENV_KEYS) delete process.env[key]; });
afterEach(()=>{ for(const key of ENV_KEYS) delete process.env[key]; mock.restoreAll(); });

function response({withGetHeader=true}={}){
  const res={
    statusCode:200,headers:{},body:undefined,ended:false,
    status(code){ this.statusCode=code; return this; },
    setHeader(name,value){ this.headers[String(name).toLowerCase()]=value; },
    json(value){ this.body=value; return this; },
    writeHead(code,headers={}){ this.statusCode=code; for(const [k,v] of Object.entries(headers)) this.setHeader(k,v); },
    end(){ this.ended=true; return this; },
  };
  if(withGetHeader) res.getHeader=function(name){ return this.headers[String(name).toLowerCase()]; };
  return res;
}

async function call({endpoint,method='POST',body,query={},url,headers={},cookie='',res=response()}={}){
  const req={
    method,url:url??`/api/auth?endpoint=${endpoint}`,
    query:endpoint===undefined?query:{endpoint,...query},
    body,
    headers:{host:HOST,origin:ORIGIN,'x-forwarded-proto':'https',cookie,...headers},
    socket:{remoteAddress:'198.51.100.7'},
  };
  await handler(req,res);
  return res;
}

function cookies(res){
  const raw=res.headers['set-cookie'];
  return (Array.isArray(raw)?raw:[raw]).filter(Boolean);
}
function location(res){ return new URL(res.headers.location); }

function sqlRoutes(routes){
  return (sql,args)=>{
    for(const [pattern,result] of routes){
      if(pattern.test(sql)) return typeof result==='function'?result(sql,args):{rows:result};
    }
    return {rows:[]};
  };
}

// --- request routing, origin and helper behaviour ---

test('mutations are rejected without a same-origin proof before any handler runs',async()=>{
  S.mutationOrigin=()=>false;
  const blocked=await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}});
  assert.equal(blocked.statusCode,403);
  assert.equal(blocked.body.error,'cross-origin mutation rejected');
  assert.equal(blocked.headers['cache-control'],'no-store');
  assert.equal(S.sqlLog.length,0);
  S.mutationOrigin=()=>true;
  for(const headers of [{origin:''},{origin:'https://evil.example'},{origin:'not a url'},{host:'',origin:ORIGIN}]){
    const res=await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD},headers});
    assert.equal(res.statusCode,403,JSON.stringify(headers));
    assert.equal(res.body.error,'same-origin request required');
  }
  // A proxy-forwarded host is honoured for the origin comparison.
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE email/,[]]]);
  const proxied=await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD},
    headers:{host:'internal:3000','x-forwarded-host':`${HOST}, other`}});
  assert.equal(proxied.statusCode,401);
});

test('endpoint resolution falls back through ep, path segments, and malformed URLs',async()=>{
  S.signed=()=>null;
  assert.equal((await call({endpoint:undefined,method:'GET',query:{ep:'ME'},url:'/api/auth'})).statusCode,401);
  assert.equal((await call({endpoint:undefined,method:'GET',url:'/api/auth/me'})).statusCode,401);
  const unknown=await call({endpoint:undefined,method:'GET',url:'//'});
  assert.equal(unknown.statusCode,404);
  assert.match(unknown.body.error,/unknown auth endpoint ''/);
  assert.ok(unknown.body.available.includes('google/callback'));
  // Unknown endpoint names still dispatch by path for legacy rewrites.
  const routed=[
    ['/api/auth/x/capabilities',null,'GET',200],
    ['/api/auth/activation/resend',null,'GET',405],
    ['/api/auth/activation/verify',null,'GET',405],
    ['/api/auth/password-reset/request',null,'GET',405],
    ['/api/auth/password-reset/consume',null,'GET',405],
    ['/api/auth/v/recent-auth',null,'PUT',405],
    ['/api/auth/v/identities',null,'POST',405],
    ['/api/auth/identities/password',null,'GET',405],
    ['/api/auth/identities/google',null,'GET',405],
    ['/api/auth/v/google-callback',null,'POST',405],
    ['/api/auth/xsignup',null,'GET',405],
    ['/api/auth/xlogin',null,'GET',405],
    ['/api/auth/xlogout-all',null,'GET',405],
    ['/api/auth/xlogout',null,'GET',405],
    ['/api/auth/me',null,'POST',405],
  ];
  for(const [url,,method,status] of routed){
    const res=await call({endpoint:'zz',url,method,headers:{origin:ORIGIN}});
    assert.equal(res.statusCode,status,url);
  }
  // Generic "start"/"callback" endpoints without "google" still route to Google.
  S.googleConfig=null;
  assert.equal((await call({endpoint:'start',method:'GET'})).statusCode,503);
  assert.equal((await call({endpoint:'callback',method:'GET'})).statusCode,503);
});

test('password policy is measured in UTF-8 bytes',()=>{
  assert.equal(validSignupPassword(123),false);
  assert.equal(validSignupPassword('a'.repeat(9)),false);
  assert.equal(validSignupPassword('a'.repeat(10)),true);
  assert.equal(validSignupPassword('a'.repeat(72)),true);
  assert.equal(validSignupPassword('é'.repeat(37)),false,'74 bytes exceeds bcrypt limit');
  S.localIdentity=true;
  assert.equal(localPasswordSignupEnabled({}),true);
  S.localIdentity=false; S.localRuntime=true; process.env.ALLOW_OPEN_SIGNUP='true';
  assert.equal(localPasswordSignupEnabled({}),true);
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal(localPasswordSignupEnabled({}),false);
});

// --- capabilities ---

test('capabilities fail closed when readiness probes reject or the client is unavailable',async()=>{
  S.activation.config={};
  S.reset.config={};
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  S.activation.ready=async()=>{ throw new Error('stale'); };
  S.reset.ready=async()=>{ throw new Error('stale'); };
  S.identity.ready=async()=>{ throw new Error('stale'); };
  const res=await call({endpoint:'capabilities',method:'GET'});
  assert.deepEqual([res.body.capabilities.verifiedEmailActivation,res.body.capabilities.passwordReset,
    res.body.capabilities.identityManagement,res.body.capabilities.googleOAuth],[false,false,false,false]);
  assert.equal(res.body.registrationMode,'private_beta');
  S.clientThrows=true;
  const noDb=await call({endpoint:'capabilities',method:'GET'});
  assert.equal(noDb.body.capabilities.passwordReset,false);
  assert.equal((await call({endpoint:'capabilities',method:'POST'})).statusCode,405);
});

test('capabilities advertise every ready feature and rollout flag',async()=>{
  S.activation.config={};
  S.reset.config={};
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  S.identity.hashConfigured=true;
  S.membership.enabled=true;
  S.flags={controlPlane:true,availability:true,coordination:true,scheduling:true};
  const res=await call({endpoint:'capabilities',method:'GET'});
  const c=res.body.capabilities;
  assert.equal(c.verifiedEmailActivation,true);
  assert.equal(c.passwordSignup,true);
  assert.equal(c.passwordReset,true);
  assert.equal(c.identityManagement,true);
  assert.equal(c.googleOAuth,true);
  assert.equal(c.multiCircleControlPlane,true);
  assert.equal(c.multiCircleAvailability,true);
  assert.equal(c.secondaryCircleCoordination,true);
  assert.equal(c.secondaryCircleScheduling,true);
  assert.equal(res.body.registrationMode,'verified_invite');
  S.localIdentity=true;
  assert.equal((await call({endpoint:'capabilities',method:'GET'})).body.registrationMode,'local_invite');
  S.localIdentity=false; S.activation.config=null; S.localRuntime=true; process.env.ALLOW_OPEN_SIGNUP='true';
  assert.equal((await call({endpoint:'capabilities',method:'GET'})).body.registrationMode,'local_open');
});

test('capabilities advertise circle health only while its flag and circle membership are on',async()=>{
  const capability=async()=>(await call({endpoint:'capabilities',method:'GET'})).body.capabilities.circleHealth;
  assert.equal(await capability(),undefined);
  process.env.CIRCLE_HEALTH_ENABLED='true';
  assert.equal(await capability(),undefined,'membership is required for owners to exist');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal(await capability(),true);
  process.env.CIRCLE_HEALTH_ENABLED='false';
  assert.equal(await capability(),undefined);
});

test('capabilities advertise admin diagnostics only while ADMIN_DIAGNOSTICS_ENABLED is exactly true (#310)',async()=>{
  assert.equal('adminDiagnostics' in (await call({endpoint:'capabilities',method:'GET'})).body.capabilities,false);
  process.env.ADMIN_DIAGNOSTICS_ENABLED='1';
  assert.equal('adminDiagnostics' in (await call({endpoint:'capabilities',method:'GET'})).body.capabilities,false);
  process.env.ADMIN_DIAGNOSTICS_ENABLED='true';
  assert.equal((await call({endpoint:'capabilities',method:'GET'})).body.capabilities.adminDiagnostics,true);
});

// --- signup ---

const signupBody=(extra={})=>({email:' New@Example.Test ',password:PASSWORD,name:'New Person',...extra});

test('signup is disabled unless local signup or verified activation is configured',async()=>{
  const res=await call({endpoint:'signup',body:signupBody()});
  assert.equal(res.statusCode,503);
  assert.match(res.body.error,/private beta/);
  assert.equal((await call({endpoint:'signup',method:'GET'})).statusCode,405);
  S.localIdentity=true;
  for(const [body,pattern] of [
    [{email:'a@b.co'},/required/],
    [signupBody({password:'short'}),/10-72/],
    [signupBody({email:'not-an-email'}),/invalid email/],
    [signupBody({email:`${'a'.repeat(250)}@b.co`}),/invalid email/],
    // New accounts use the shared strict rules (ID-68).
    [signupBody({email:'a..b@example.test'}),/invalid email/],
    [signupBody({email:'new@example.c'}),/invalid email/],
    [signupBody({name:' x '}),/display name/],
  ]){
    const rejected=await call({endpoint:'signup',body});
    assert.equal(rejected.statusCode,400);
    assert.match(rejected.body.error,pattern);
  }
});

test('verified-activation signup returns an identical pending response and maps readiness failures',async()=>{
  S.activation.config={};
  S.attempts=()=>6;
  const limited=await call({endpoint:'signup',body:signupBody()});
  assert.equal(limited.statusCode,429);
  S.attempts=()=>1;
  S.activation.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,503);
  S.activation.ready=ok;
  S.activation.request=async()=>{ throw new Error('outbox down'); };
  const failed=await call({endpoint:'signup',body:signupBody()});
  assert.equal(failed.statusCode,503);
  assert.deepEqual(S.delivered,[],'nothing is delivered when activation failed');
  S.activation.request=async(db,{email,claim})=>{ assert.equal(email,'new@example.test'); assert.equal(claim,null); return {outboxEvents:['evt']}; };
  const accepted=await call({endpoint:'signup',body:signupBody()});
  assert.equal(accepted.statusCode,202);
  assert.equal(accepted.body.pending,true);
  assert.deepEqual(S.delivered,[['evt']]);
});

test('local invitation signup requires a live matching invitation and maps every failure',async()=>{
  S.localIdentity=true;
  S.membership.enabled=true;
  const withInvite=signupBody({invite_binding:BINDING});
  S.membership.boundClaim=()=>null;
  assert.match((await call({endpoint:'signup',body:withInvite})).body.error,/valid local invitation/);
  assert.match((await call({endpoint:'signup',body:signupBody({invite_binding:'short'})})).body.error,/valid local invitation/);
  S.membership.boundClaim=()=>({binding_hash:BINDING_HASH});
  S.membership.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,503);
  S.membership.ready=ok;
  S.attempts=()=>99;
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,429);
  S.attempts=()=>{ throw new Error('db down'); };
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,503);
  S.attempts=()=>1;
  S.membership.validate=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,503);
  S.membership.validate=async()=>({ok:true,used_by:5});
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,403,'used invitation');
  S.membership.validate=async()=>({ok:true,used_by:null});
  S.membership.createPassword=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,503);
  S.membership.createPassword=async()=>({ok:false});
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,403);
  S.membership.createPassword=async()=>({ok:true,user_id:21});
  S.issueSession=async()=>{ throw new Error('session store'); };
  assert.equal((await call({endpoint:'signup',body:withInvite})).statusCode,503);
  S.issueSession=async(db,user,options)=>{ assert.equal(options.recentAuthMethod,'password'); return 'tok'; };
  const created=await call({endpoint:'signup',body:withInvite,res:response({withGetHeader:false})});
  assert.equal(created.statusCode,200);
  assert.equal(created.body.user.id,21);
  assert.equal(created.body.user.isAdmin,false);
  assert.match(cookies(created)[0],/^randori_session=tok; .*HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
});

test('hosted membership signup without the local adapter demands a Google invitation',async()=>{
  S.localRuntime=true; process.env.ALLOW_OPEN_SIGNUP='true';
  S.membership.enabled=true;
  const res=await call({endpoint:'signup',body:signupBody()});
  assert.equal(res.statusCode,403);
  assert.match(res.body.error,/Google invitation/);
});

test('open signup enforces the allowlist and registration state',async()=>{
  S.localIdentity=true;
  process.env.NODE_ENV='production';
  const blocked=await call({endpoint:'signup',body:signupBody()});
  assert.equal(blocked.statusCode,403);
  assert.match(blocked.body.error,/invite-only/);
  process.env.NODE_ENV='test';
  process.env.SIGNUP_ALLOWLIST='someone@else.test';
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,403,'non-empty allowlist excludes others');
  process.env.SIGNUP_ALLOWLIST=' NEW@example.test , other@x.test';
  S.membership.registrationState=async()=>'closed';
  assert.match((await call({endpoint:'signup',body:signupBody()})).body.error,/Google invitation/);
  S.membership.registrationState=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,503);
  S.membership.registrationState=async()=>'open';
  S.attempts=()=>6;
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,429);
  S.attempts=()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,503);
  S.attempts=()=>1;
  S.sql=sqlRoutes([[/SELECT id FROM auth_accounts WHERE email/,[{id:1}]]]);
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,409);
  // Guard rejected the insert (registrations closed concurrently).
  S.sql=sqlRoutes([[/INSERT INTO auth_accounts/,[]]]);
  const raced=await call({endpoint:'signup',body:signupBody()});
  assert.equal(raced.statusCode,403);
  assert.match(S.sqlLog.find(e=>e.sql.includes('INSERT INTO auth_accounts')).sql,/registrations_closed=0/);
});

test('open signup derives admin from configuration and local first-user bootstrap only on a local file DB',async()=>{
  S.localRuntime=true; process.env.ALLOW_OPEN_SIGNUP='true';
  const insertArgs=()=>S.sqlLog.filter(e=>e.sql.includes('INSERT INTO auth_accounts')).at(-1).args;
  S.sql=sqlRoutes([[/INSERT INTO auth_accounts/,[{id:31}]],[/INSERT INTO users/,()=>{ throw new Error('legacy table missing'); }]]);
  S.admins=new Set(['new@example.test']);
  const admin=await call({endpoint:'signup',body:signupBody()});
  assert.equal(admin.statusCode,200);
  assert.equal(admin.body.user.is_admin,true,'missing is_admin column falls back to configured admin');
  assert.match(S.sqlLog.find(e=>e.sql.includes('INSERT INTO auth_accounts')).sql,/NOT EXISTS \(SELECT 1 FROM sqlite_schema/);
  S.admins=new Set();
  Object.assign(process.env,{NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',RANDORI_LOCAL_FIRST_USER_ADMIN:'true'});
  for(const [url,expected] of [['file:/tmp/randori.db',1],['libsql://db.turso.io',0],['::not a url::',0],['file://remote-host/db',0]]){
    process.env.TURSO_DATABASE_URL=url;
    await call({endpoint:'signup',body:signupBody()});
    assert.equal(insertArgs()[5],expected,url);
  }
  process.env.TURSO_DATABASE_URL='file:/tmp/randori.db';
  process.env.TURSO_AUTH_TOKEN='token';
  await call({endpoint:'signup',body:signupBody()});
  assert.equal(insertArgs()[5],0,'remote credentials disable first-user admin');
  delete process.env.TURSO_AUTH_TOKEN;
  S.sql=sqlRoutes([[/INSERT INTO auth_accounts/,[{id:32,is_admin:1}]]]);
  assert.equal((await call({endpoint:'signup',body:signupBody()})).body.user.isAdmin,true);
  S.issueSession=async()=>{ throw new Error('session store'); };
  assert.equal((await call({endpoint:'signup',body:signupBody()})).statusCode,503);
});

test('rate-limit buckets tolerate a missing counter row and occasionally prune expired rows',async()=>{
  S.localRuntime=true; process.env.ALLOW_OPEN_SIGNUP='true';
  S.attempts=()=>null;
  mock.method(Math,'random',()=>0);
  S.sql=sqlRoutes([[/INSERT INTO auth_accounts/,[{id:40,is_admin:0}]]]);
  const res=await call({endpoint:'signup',body:signupBody()});
  assert.equal(res.statusCode,200);
  assert.ok(S.sqlLog.some(e=>e.sql.includes('DELETE FROM auth_rate_limits')));
});

// --- activation and password reset ---

test('activation resend is enumeration-safe and maps limiter and readiness failures',async()=>{
  assert.equal((await call({endpoint:'activation-resend',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'activation-resend',body:{email:'a@b.co'}})).statusCode,503);
  S.activation.config={};
  for(const email of [undefined,'bad',`${'a'.repeat(250)}@b.co`]){
    assert.equal((await call({endpoint:'activation-resend',body:{email}})).statusCode,400);
  }
  S.attempts=()=>6;
  assert.equal((await call({endpoint:'activation-resend',body:{email:'a@b.co'}})).statusCode,429);
  S.attempts=()=>1;
  S.activation.resend=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'activation-resend',body:{email:'a@b.co'}})).statusCode,503);
  S.activation.resend=async()=>null;
  const res=await call({endpoint:'activation-resend',body:{email:'a@b.co'}});
  assert.equal(res.statusCode,202);
  assert.deepEqual(S.delivered,[undefined]);
});

test('activation verify issues a session only for a verified token',async()=>{
  assert.equal((await call({endpoint:'activation-verify',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'activation-verify',body:{token:'t'}})).statusCode,503);
  S.activation.config={};
  S.attempts=()=>21;
  assert.equal((await call({endpoint:'activation-verify',body:{token:'t'}})).statusCode,429);
  S.attempts=()=>1;
  S.activation.verify=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'activation-verify',body:{token:'t'}})).statusCode,503);
  S.activation.verify=async()=>({status:'expired'});
  const expired=await call({endpoint:'activation-verify',body:{}});
  assert.equal(expired.statusCode,409);
  assert.deepEqual(expired.body,{ok:false,status:'expired'});
  assert.equal(cookies(expired).length,0);
  S.activation.verify=async()=>({status:'verified',sessionToken:'fresh',user:{id:3}});
  const verified=await call({endpoint:'activation-verify',body:{token:'t'}});
  assert.equal(verified.statusCode,200);
  assert.match(cookies(verified)[0],/^randori_session=fresh;/);
});

test('password reset request and consume guard configuration, input, limits, and token state',async()=>{
  assert.equal((await call({endpoint:'password-reset-request',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'password-reset-request',body:{email:'a@b.co'}})).statusCode,503);
  assert.equal((await call({endpoint:'password-reset-consume',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'password-reset-consume',body:{token:'t',password:PASSWORD}})).statusCode,503);
  S.reset.config={};
  assert.equal((await call({endpoint:'password-reset-request',body:{email:'nope'}})).statusCode,400);
  S.attempts=()=>11;
  assert.equal((await call({endpoint:'password-reset-request',body:{email:'a@b.co'}})).statusCode,429);
  S.attempts=()=>1;
  S.reset.request=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'password-reset-request',body:{email:'a@b.co'}})).statusCode,503);

  assert.equal((await call({endpoint:'password-reset-consume',body:{token:'t',password:'short'}})).statusCode,400);
  S.attempts=()=>21;
  assert.equal((await call({endpoint:'password-reset-consume',body:{token:'t',password:PASSWORD}})).statusCode,429);
  S.attempts=()=>1;
  S.reset.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'password-reset-consume',body:{token:'t',password:PASSWORD}})).statusCode,503);
  S.reset.ready=ok;
  S.reset.consume=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'password-reset-consume',body:{token:'t',password:PASSWORD}})).statusCode,503);
  S.reset.consume=async()=>({status:'used'});
  const reused=await call({endpoint:'password-reset-consume',body:{password:PASSWORD}});
  assert.equal(reused.statusCode,409);
  assert.equal(reused.body.status,'used');
  S.reset.consume=async(db,{passwordHash})=>{ assert.ok(await bcrypt.compare(PASSWORD,passwordHash)); return {status:'reset'}; };
  const done=await call({endpoint:'password-reset-consume',body:{token:'t',password:PASSWORD}});
  assert.equal(done.statusCode,200);
  assert.match(cookies(done)[0],/^randori_session=; .*Max-Age=0/,'the current session cookie is cleared');
});

// --- recent authentication ---

test('recent-auth GET reports methods and fails closed on unavailable state',async()=>{
  assert.equal((await call({endpoint:'recent-auth',method:'PUT'})).statusCode,405);
  S.verify=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'recent-auth',method:'GET'})).statusCode,503);
  S.verify=async()=>null;
  assert.equal((await call({endpoint:'recent-auth',method:'GET'})).statusCode,401);
  S.verify=async()=>({id:7,sessionHash:SESSION_HASH});
  S.sql=sqlRoutes([[/google_linked/,[]]]);
  assert.equal((await call({endpoint:'recent-auth',method:'GET'})).statusCode,401,'deleted account');
  S.sql=sqlRoutes([[/google_linked/,()=>{ throw new Error('db'); }]]);
  assert.equal((await call({endpoint:'recent-auth',method:'GET'})).statusCode,503);
  S.sql=sqlRoutes([[/google_linked/,[{password_hash:'!oauth:x',google_linked:1}]]]);
  const google=await call({endpoint:'recent-auth',method:'GET'});
  assert.deepEqual(google.body.methods,{password:false,google:true});
  S.googleConfig=null;
  S.sql=sqlRoutes([[/google_linked/,[{password_hash:PASSWORD_HASH,google_linked:1}]]]);
  assert.deepEqual((await call({endpoint:'recent-auth',method:'GET'})).body.methods,{password:true,google:false});
});

test('recent-auth POST verifies the password with a constant-cost compare and records proof',async()=>{
  for(const password of [undefined,'','x'.repeat(73)]){
    assert.equal((await call({endpoint:'recent-auth',body:{password}})).statusCode,400);
  }
  S.attempts=()=>11;
  assert.equal((await call({endpoint:'recent-auth',body:{password:PASSWORD}})).statusCode,429);
  S.attempts=()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'recent-auth',body:{password:PASSWORD}})).statusCode,503);
  S.attempts=()=>1;
  S.sql=sqlRoutes([[/SELECT password_hash FROM auth_accounts/,()=>{ throw new Error('db'); }]]);
  assert.equal((await call({endpoint:'recent-auth',body:{password:PASSWORD}})).statusCode,503);
  for(const rows of [[],[{password_hash:'!oauth:x'}],[{password_hash:PASSWORD_HASH},{password_hash:PASSWORD_HASH}]]){
    S.sql=sqlRoutes([[/SELECT password_hash FROM auth_accounts/,rows]]);
    assert.equal((await call({endpoint:'recent-auth',body:{password:PASSWORD}})).statusCode,401);
  }
  S.sql=sqlRoutes([[/SELECT password_hash FROM auth_accounts/,[{password_hash:PASSWORD_HASH}]]]);
  assert.equal((await call({endpoint:'recent-auth',body:{password:'wrong-password!'}})).statusCode,401);
  S.recent.record=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'recent-auth',body:{password:PASSWORD}})).statusCode,503);
  S.recent.record=async(db,{sessionHash,method})=>({method,sessionHash});
  const res=await call({endpoint:'recent-auth',body:{password:PASSWORD}});
  assert.deepEqual(res.body,{ok:true,recentAuth:{ok:true,method:'password',sessionHash:SESSION_HASH}});
});

// --- identity management ---

test('identity endpoints are unavailable unless requested and the email hash key is configured',async()=>{
  assert.equal((await call({endpoint:'identities',method:'GET'})).statusCode,503);
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  assert.equal((await call({endpoint:'identities',method:'GET'})).statusCode,503,'hash key missing');
  S.identity.hashConfigured=true;
  assert.equal((await call({endpoint:'identities',method:'POST'})).statusCode,405);
  S.verify=async()=>null;
  assert.equal((await call({endpoint:'identities',method:'GET'})).statusCode,401);
  S.verify=async()=>({id:7,sessionHash:SESSION_HASH});
  const state=await call({endpoint:'identities',method:'GET'});
  assert.deepEqual(state.body,{ok:true,identity:{methods:['password']}});
});

test('password identity changes require recent auth, rate limits, and safe final-credential handling',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  assert.equal((await call({endpoint:'identity-password',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'identity-password',body:{action:'replace'}})).statusCode,400);
  S.recent.require=async()=>{ throw Object.assign(new Error('stale'),{code:'RECENT_AUTH_REQUIRED'}); };
  const stale=await call({endpoint:'identity-password',body:{action:'add',password:PASSWORD}});
  assert.equal(stale.statusCode,403);
  assert.equal(stale.body.code,'recent_auth_required');
  S.recent.require=async()=>{ throw Object.assign(new Error('forbidden'),{statusCode:403}); };
  assert.equal((await call({endpoint:'identity-password',body:{action:'add',password:PASSWORD}})).statusCode,403);
  S.recent.require=ok;
  S.attempts=()=>11;
  assert.equal((await call({endpoint:'identity-password',body:{action:'add',password:PASSWORD}})).statusCode,429);
  S.attempts=()=>1;
  assert.equal((await call({endpoint:'identity-password',body:{action:'add',password:'short'}})).statusCode,400);
  S.identity.addPassword=async()=>({status:'verified_control_required'});
  assert.equal((await call({endpoint:'identity-password',body:{action:'add',password:PASSWORD}})).statusCode,403);
  S.identity.addPassword=async()=>({status:'added'});
  const added=await call({endpoint:'identity-password',body:{action:'add',password:PASSWORD}});
  assert.deepEqual(added.body,{ok:true,status:'added',identity:{methods:['password']}});
  S.identity.unlinkPassword=async()=>({status:'final_credential'});
  assert.equal((await call({endpoint:'identity-password',body:{action:'unlink'}})).statusCode,409);
  S.identity.unlinkPassword=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'identity-password',body:{action:'unlink'}})).statusCode,503);
  S.identity.unlinkPassword=async()=>({status:'unlinked'});
  assert.equal((await call({endpoint:'identity-password',body:{action:'unlink'}})).body.status,'unlinked');
});

test('Google unlink validates the action and refuses to remove the final credential',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  assert.equal((await call({endpoint:'identity-google-unlink',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'identity-google-unlink',body:{action:'link'}})).statusCode,400);
  S.identity.unlinkGoogle=async()=>({status:'final_credential'});
  assert.equal((await call({endpoint:'identity-google-unlink',body:{action:'unlink'}})).statusCode,409);
  S.identity.unlinkGoogle=async()=>({status:'unlinked'});
  assert.equal((await call({endpoint:'identity-google-unlink',body:{action:'unlink'}})).body.status,'unlinked');
  S.verify=async()=>null;
  assert.equal((await call({endpoint:'identity-google-unlink',body:{action:'unlink'}})).statusCode,401);
});

// --- login / me / logout ---

test('login fails closed, is uniform for unknown accounts, and enforces membership',async()=>{
  assert.equal((await call({endpoint:'login',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co'}})).statusCode,400);
  S.localIdentity=true;
  S.membership.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,503);
  S.localIdentity=false;
  S.attempts=()=>11;
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,429);
  S.attempts=()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,503);
  S.attempts=()=>1;
  const account={id:5,email:'a@b.co',password_hash:PASSWORD_HASH,display_name:'A',color:'#fff',is_admin:0};
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE email/,[account]]]);
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:'x'.repeat(73)}})).statusCode,401,'over-length password');
  S.membership.enabled=true;
  S.membership.hasPrimary=async()=>false;
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,403);
  S.flags.controlPlane=true;
  S.membership.hasActive=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,503);
  S.membership.hasActive=async()=>true;
  S.admins=new Set(['a@b.co']);
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE email/,[{...account}]],[/SET is_admin=1/,()=>{ throw new Error('readonly'); }]]);
  const promoted=await call({endpoint:'login',body:{email:'A@B.CO',password:PASSWORD}});
  assert.equal(promoted.statusCode,200);
  assert.equal(promoted.body.user.isAdmin,true,'configured admin even if promotion write fails');
  S.issueSession=async()=>{ throw new Error('store'); };
  assert.equal((await call({endpoint:'login',body:{email:'a@b.co',password:PASSWORD}})).statusCode,503);
});

test('me validates signed and stored sessions and clears cookies for lapsed membership',async()=>{
  assert.equal((await call({endpoint:'me',method:'POST'})).statusCode,405);
  S.signed=()=>{ throw new Error('no secret'); };
  assert.equal((await call({endpoint:'me',method:'GET'})).statusCode,503);
  S.signed=()=>({id:7});
  S.verify=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'me',method:'GET'})).statusCode,503);
  S.verify=async()=>null;
  assert.equal((await call({endpoint:'me',method:'GET'})).statusCode,401);
  S.verify=async()=>({sessionHash:SESSION_HASH});
  assert.equal((await call({endpoint:'me',method:'GET'})).body.error,'invalid token payload');
  S.verify=async()=>({uid:7});
  S.localIdentity=true;
  S.membership.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'me',method:'GET'})).statusCode,503);
  S.membership.ready=ok;
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE id/,[]]]);
  assert.equal((await call({endpoint:'me',method:'GET'})).body.error,'user not found');
  const user={id:7,email:'Admin@Example.Test',display_name:'Ad',color:'#000',is_available:null,is_admin:0};
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE id/,[user]]]);
  S.membership.enabled=true;
  S.membership.hasPrimary=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'me',method:'GET'})).statusCode,503);
  S.membership.hasPrimary=async()=>false;
  const lapsed=await call({endpoint:'me',method:'GET'});
  assert.equal(lapsed.statusCode,403);
  assert.match(cookies(lapsed)[0],/^randori_session=; .*Max-Age=0/);
  S.membership.hasPrimary=async()=>true;
  S.admins=new Set(['admin@example.test']);
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE id/,[user]],[/SET is_admin=1/,()=>{ throw new Error('readonly'); }]]);
  const me=await call({endpoint:'me',method:'GET'});
  assert.equal(me.body.user.isAvailable,true,'null availability defaults to available');
  assert.equal(me.body.user.is_admin_env,true);
  assert.equal(me.body.user.is_admin_db,false);
  assert.equal(me.body.user.is_demo,false,'a missing is_demo value is not a demo account');
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE id/,[{...user,is_available:0,is_admin:1}]]]);
  assert.equal((await call({endpoint:'me',method:'GET'})).body.user.isAvailable,false);
  // #310: the browser hides admin diagnostics from demo admins, as the API does.
  S.sql=sqlRoutes([[/FROM auth_accounts WHERE id/,[{...user,is_admin:1,is_demo:1}]]]);
  assert.equal((await call({endpoint:'me',method:'GET'})).body.user.is_demo,true);
  S.sql=()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'me',method:'GET'})).body.error,'invalid session');
});

test('logout revokes only signed sessions, and logout-all requires a live session',async()=>{
  assert.equal((await call({endpoint:'logout',method:'GET'})).statusCode,405);
  S.signed=()=>null;
  let revoked=0;
  S.revokeRequestSession=async()=>{ revoked+=1; };
  assert.equal((await call({endpoint:'logout'})).body.ok,true);
  assert.equal(revoked,0,'unsigned cookies are cleared without a DB call');
  S.signed=()=>({id:7});
  S.revokeRequestSession=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'logout'})).statusCode,503);
  assert.equal((await call({endpoint:'logout-all',method:'GET'})).statusCode,405);
  S.verify=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'logout-all'})).statusCode,503);
  S.verify=async()=>null;
  const anonymous=await call({endpoint:'logout-all'});
  assert.equal(anonymous.statusCode,401);
  assert.match(cookies(anonymous)[0],/Max-Age=0/);
  S.verify=async()=>({id:7});
  S.revokeAccountSessions=async(db,id,reason)=>{ assert.deepEqual([id,reason],[7,'logout_all']); throw new Error('db'); };
  assert.equal((await call({endpoint:'logout-all'})).statusCode,503);
  S.revokeAccountSessions=ok;
  assert.equal((await call({endpoint:'logout-all'})).body.ok,true);
});

// --- Google start ---

test('Google start guards methods, purpose, invitation, configuration, and readiness',async()=>{
  assert.equal((await call({endpoint:'google-link-start',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'google-reauth-start',method:'GET'})).statusCode,405);
  assert.equal((await call({endpoint:'google-start',method:'PUT'})).statusCode,405);
  for(const body of [[],{x:1}]){
    assert.equal((await call({endpoint:'google-reauth-start',body})).statusCode,400);
  }
  assert.equal((await call({endpoint:'google-start',method:'GET',query:{purpose:'link'}})).statusCode,400);
  // Invitation start.
  const inviteBody={purpose:'invite',invite_binding:BINDING};
  assert.equal((await call({endpoint:'google-start',body:inviteBody})).statusCode,403,'membership disabled');
  S.membership.enabled=true;
  assert.equal((await call({endpoint:'google-start',body:{purpose:'invite',invite_binding:'bad'}})).statusCode,403);
  assert.equal((await call({endpoint:'google-start',body:{...inviteBody,extra:1}})).statusCode,403);
  S.membership.boundClaim=()=>null;
  assert.equal((await call({endpoint:'google-start',body:inviteBody})).statusCode,403);
  S.membership.boundClaim=()=>({binding_hash:BINDING_HASH});
  S.membership.live=async()=>({ok:false});
  assert.equal((await call({endpoint:'google-start',body:inviteBody})).statusCode,403);
  S.membership.live=async()=>{ throw new Error('db'); };
  assert.equal((await call({endpoint:'google-start',body:inviteBody})).statusCode,503);
  S.membership.live=async()=>({ok:true});
  const invite=await call({endpoint:'google-start',body:inviteBody});
  const inviteUrl=new URL(invite.body.authorizationUrl);
  assert.equal(inviteUrl.searchParams.get('prompt'),'select_account');
  assert.equal(inviteUrl.searchParams.get('code_challenge_method'),'S256');
  // Identity management requested but not configured, or not ready.
  S.membership.enabled=false;
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  assert.equal((await call({endpoint:'google-start',method:'GET'})).statusCode,503);
  assert.equal((await call({endpoint:'google-link-start',body:{}})).statusCode,503);
  S.identity.hashConfigured=true;
  S.identity.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'google-start',method:'GET'})).statusCode,503);
  S.identity.ready=ok;
  S.googleConfig=null;
  assert.equal((await call({endpoint:'google-start',method:'GET'})).statusCode,503);
});

test('Google link and reauth starts bind the transaction to the current session',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  S.verify=async()=>null;
  assert.equal((await call({endpoint:'google-link-start',body:{}})).statusCode,401);
  assert.equal((await call({endpoint:'google-reauth-start',body:{}})).statusCode,401);
  S.verify=async()=>({id:7,sessionHash:SESSION_HASH});
  S.recent.require=async()=>{ throw Object.assign(new Error('stale'),{code:'RECENT_AUTH_REQUIRED'}); };
  assert.equal((await call({endpoint:'google-link-start',body:{}})).body.code,'recent_auth_required');
  S.recent.require=ok;
  const link=await call({endpoint:'google-link-start',body:{}});
  const linkUrl=new URL(link.body.authorizationUrl);
  assert.equal(linkUrl.searchParams.get('max_age'),'0');
  assert.match(cookies(link)[0],/Path=\/api\/auth\/google\/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  S.attempts=()=>11;
  assert.equal((await call({endpoint:'google-reauth-start',body:{}})).statusCode,429);
  S.attempts=()=>1;
  S.reset.ready=async()=>{ throw new Error('stale'); };
  assert.equal((await call({endpoint:'google-reauth-start',body:{}})).statusCode,503);
  S.reset.ready=ok;
  // `reauth=1` on the ordinary endpoint also selects reauthentication.
  const reauth=await call({endpoint:'google-start',query:{reauth:'1'}});
  assert.equal(new URL(reauth.body.authorizationUrl).searchParams.get('prompt'),'select_account');
});

// --- Google callback ---

async function startLogin({query={}}={}){
  const res=await call({endpoint:'google-start',method:'GET',query});
  assert.equal(res.statusCode,302);
  const state=location(res).searchParams.get('state');
  return {state,cookie:cookies(res)[0].split(';')[0]};
}
async function startJson(endpoint,body={}){
  const res=await call({endpoint,body});
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  return {state:new URL(res.body.authorizationUrl).searchParams.get('state'),cookie:cookies(res)[0].split(';')[0]};
}
async function callback(flow,query={code:'code-1'}){
  return call({endpoint:'google-callback',method:'GET',query:{state:flow.state,...query},cookie:flow.cookie});
}
function signedTransactionCookie(flow,payloadText){
  const payload=Buffer.from(payloadText,'utf8').toString('base64url');
  const sig=createHmac('sha256',SECRET).update(`randori-google-oauth-transaction-v1\0${payload}`,'utf8').digest('base64url');
  return {state:flow.state,cookie:`${flow.cookie.split('=')[0]}=${payload}.${sig}`};
}

test('callback rejects missing, tampered, or malformed transactions as invalid_state',async()=>{
  assert.equal((await call({endpoint:'google-callback',method:'POST'})).statusCode,405);
  const flow=await startLogin({query:{return_to:'/join/week_2_pair_3'}});
  const tampered=[
    {...flow,cookie:`${flow.cookie.split('=')[0]}=%E0%A4%A`},
    {...flow,cookie:''},
    {...flow,state:'x'},
    signedTransactionCookie(flow,'{not json'),
    signedTransactionCookie(flow,'[1,2]'),
    signedTransactionCookie(flow,JSON.stringify({v:1})),
  ];
  for(const candidate of tampered){
    const res=await callback(candidate);
    assert.equal(location(res).searchParams.get('google_error'),'invalid_state');
  }
  // Provider error and missing code still clear the one-time transaction cookie.
  const denied=await callback(flow,{error:'access_denied'});
  assert.equal(location(denied).searchParams.get('google_error'),'access_denied');
  assert.equal(location(denied).pathname,'/join/week_2_pair_3');
  assert.match(cookies(denied)[0],/Max-Age=0/);
  assert.equal(location(await callback(flow,{})).searchParams.get('google_error'),'missing_code');
});

test('callback fails closed when identity management or readiness is unavailable',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  const login=await startLogin();
  const link=await startJson('google-link-start');
  S.identity.hashConfigured=false;
  assert.equal(location(await callback(login)).searchParams.get('google_error'),'provider_unavailable');
  assert.equal(location(await callback(link)).searchParams.get('identity_link_error'),'unavailable');
  S.identity.hashConfigured=true;
  S.identity.ready=async()=>{ throw new Error('stale'); };
  assert.equal(location(await callback(login)).searchParams.get('google_error'),'db_error');
  S.identity.ready=ok;
  S.googleConfig=null;
  assert.equal((await callback(login)).statusCode,503);
});

test('callback reports provider exchange failures with a public code',async()=>{
  const flow=await startLogin();
  S.exchange=async()=>{ throw new Error('jwks fetch failed'); };
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'provider_error');
  S.membership.enabled=true;
  S.membership.ready=async()=>{ throw new Error('stale'); };
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'db_error');
});

test('link callback verifies the initiating session, recent auth, and link outcome',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  const flow=await startJson('google-link-start');
  const param=res=>[...location(res).searchParams.entries()][0];
  S.verify=async()=>({id:8,sessionHash:SESSION_HASH});
  assert.deepEqual(param(await callback(flow)),['identity_link_error','session_changed']);
  S.verify=async()=>({id:7,sessionHash:SESSION_HASH});
  S.recent.require=async()=>{ throw Object.assign(new Error('stale'),{code:'RECENT_AUTH_REQUIRED'}); };
  assert.deepEqual(param(await callback(flow)),['identity_link_error','recent_auth_required']);
  S.recent.require=ok;
  S.identity.link=async()=>{ throw new Error('db'); };
  assert.deepEqual(param(await callback(flow)),['identity_link_error','unavailable']);
  S.identity.link=async()=>({status:'subject_conflict'});
  assert.deepEqual(param(await callback(flow)),['identity_link_error','subject_conflict']);
  S.identity.link=async(db,current,{subject,providerEmail})=>{
    assert.equal(subject,'sub-1'); assert.equal(providerEmail,'google@example.test'); return {status:'already_linked'};
  };
  assert.deepEqual(param(await callback(flow)),['identity_link','already_linked']);
});

test('reauth callback requires the same session before and after the exchange and a bound identity',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  const flow=await startJson('google-reauth-start');
  const err=res=>location(res).searchParams.get('google_error');
  S.verify=async()=>{ throw new Error('db'); };
  assert.equal(err(await callback(flow)),'db_error');
  S.verify=async()=>({id:9,sessionHash:SESSION_HASH});
  assert.equal(err(await callback(flow)),'reauth_required');
  // Session swapped during the provider round trip.
  let reads=0;
  S.verify=async()=>(++reads===1?{id:7,sessionHash:SESSION_HASH}:{id:7,sessionHash:'c'.repeat(64)});
  assert.equal(err(await callback(flow)),'reauth_required');
  reads=0;
  S.verify=async()=>{ if(++reads===1) return {id:7,sessionHash:SESSION_HASH}; throw new Error('db'); };
  assert.equal(err(await callback(flow)),'db_error');
  S.verify=async()=>({id:7,sessionHash:SESSION_HASH});
  let exchangeOptions;
  S.exchange=async options=>{ exchangeOptions=options; return {email:'g@x.test',name:'',issuer:'https://accounts.google.com',subject:'sub-1'}; };
  S.sql=sqlRoutes([[/identity.issuer=\? AND identity.subject=\? AND account.id=\?/,()=>{ throw new Error('db'); }]]);
  assert.equal(err(await callback(flow)),'db_error');
  assert.equal(exchangeOptions.maxAuthAgeSeconds,120,'reauth demands a fresh auth_time');
  S.sql=sqlRoutes([[/AND account.id=\?/,[]]]);
  assert.equal(err(await callback(flow)),'identity_mismatch');
  const account={id:7,email:'g@x.test',display_name:'G',color:'#111',is_admin:0};
  S.sql=sqlRoutes([[/AND account.id=\?/,[account]]]);
  S.issueSession=async()=>{ throw new Error('store'); };
  assert.equal(err(await callback(flow)),'session_error');
  let observed=0;
  S.identity.observe=async()=>{ observed+=1; return {changed:false}; };
  S.issueSession=async(db,user,{recentAuthMethod})=>{ assert.equal(recentAuthMethod,'google'); return 'reauth-token'; };
  const success=await callback(flow);
  assert.equal(location(success).searchParams.get('google_reauth'),'success');
  assert.equal(observed,1);
  assert.ok(cookies(success).some(c=>c.startsWith('randori_session=reauth-token;')));
});

test('login callback refuses ambiguous or conflicting provider identities',async()=>{
  const flow=await startLogin();
  const err=res=>location(res).searchParams.get('google_error');
  const acct={id:5,email:'Member@Example.Test',is_admin:0,password_hash:'x',google_sub:'sub-1'};
  const cases=[
    [[[/identity.subject=\? LIMIT 2/,[acct,acct]]],'identity_mismatch'],
    [[[/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[]]],'identity_mismatch'],
    [[[/WHERE google_sub=\? LIMIT 2/,[acct,acct]]],'identity_mismatch'],
    [[[/WHERE google_sub=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[]]],'identity_mismatch'],
    [[[/WHERE email = \?/,[{...acct,google_sub:'other'}]]],'identity_mismatch'],
    [[[/WHERE email = \?/,[{...acct,google_sub:null}]]],'account_exists_use_password'],
    [[],'private_beta'],
    [[[/WHERE google_sub=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]]],'identity_mismatch'],
    [[[/identity.subject=\? LIMIT 2/,()=>{ throw new Error('db'); }]],'db_error'],
  ];
  for(const [routes,expected] of cases){
    S.sql=sqlRoutes(routes);
    assert.equal(err(await callback(flow)),expected,JSON.stringify(routes.map(([p])=>String(p))));
  }
});

test('login callback binds the subject, notices provider email changes, and issues a session',async()=>{
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  S.identity.hashConfigured=true;
  const flow=await startLogin();
  const acct={id:5,email:'Member@Example.Test',is_admin:0,password_hash:'x',google_sub:'sub-1'};
  // Legacy google_sub match: bind and observe after the fact.
  S.sql=sqlRoutes([
    [/WHERE google_sub=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[]],[/UPDATE auth_provider_identities/,[{user_id:5}]],
    [/SELECT id FROM users/,[]],
  ]);
  S.identity.observe=async()=>({changed:true});
  S.admins=new Set(['member@example.test']);
  let issued;
  S.issueSession=async(db,user)=>{ issued=user; return 'login-token'; };
  const res=await callback(flow);
  const dest=location(res);
  assert.equal(dest.searchParams.get('google'),'success');
  assert.equal(dest.searchParams.get('identity_notice'),'provider_email_changed');
  assert.equal(issued.email,'member@example.test');
  assert.equal(issued.is_admin,true);
  assert.ok(S.sqlLog.some(e=>e.sql.includes('INSERT INTO users')),'legacy user row created');
  // Existing provider-identity row: observation happens once, before refresh.
  let observations=0;
  S.identity.observe=async()=>{ observations+=1; return {changed:false}; };
  S.sql=sqlRoutes([
    [/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[{user_id:5}]],[/SELECT id FROM users/,[{id:1}]],
  ]);
  const second=await callback(flow);
  assert.equal(location(second).searchParams.get('identity_notice'),null);
  assert.equal(observations,1);
  // Binding conflict.
  S.sql=sqlRoutes([[/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[{user_id:6}]]]);
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'identity_mismatch');
  S.sql=sqlRoutes([[/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[{user_id:5}]]]);
  S.issueSession=async()=>{ throw new Error('store'); };
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'session_error');
});

test('login callback with membership enabled requires an eligible membership',async()=>{
  S.membership.enabled=true;
  const flow=await startLogin();
  const acct={id:5,email:'m@x.test',is_admin:0,google_sub:'sub-1'};
  S.sql=sqlRoutes([[/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[{user_id:5}]]]);
  S.membership.hasPrimary=async()=>false;
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'private_beta');
  S.membership.hasPrimary=async()=>{ throw new Error('db'); };
  assert.equal(location(await callback(flow)).searchParams.get('google_error'),'db_error');
  S.membership.hasPrimary=async()=>true;
  assert.equal(location(await callback(flow)).searchParams.get('google'),'success');
  assert.equal(S.sqlLog.some(e=>e.sql.includes('FROM users WHERE lower(name)')),false,'no legacy users row under membership');
});

test('invitation callback validates, registers or accepts, errors return to /invite',async()=>{
  S.membership.enabled=true;
  const flow=await startJson('google-start',{purpose:'invite',invite_binding:BINDING});
  const err=res=>location(res).searchParams.get('google_error');
  S.membership.claimForHash=()=>null;
  const missing=await callback(flow);
  assert.equal(err(missing),'private_beta');
  assert.equal(location(missing).pathname,'/invite');
  S.membership.claimForHash=()=>({binding_hash:BINDING_HASH});
  S.membership.validate=async()=>{ throw new Error('db'); };
  assert.equal(err(await callback(flow)),'db_error');
  S.membership.validate=async()=>({ok:false});
  assert.equal(err(await callback(flow)),'private_beta');
  // New account created from the invitation.
  S.membership.validate=async()=>({ok:true,used_by:null});
  S.sql=sqlRoutes([[/INSERT INTO auth_provider_identities/,[{user_id:22}]]]);
  S.membership.createGoogle=async()=>({ok:false});
  assert.equal(err(await callback(flow)),'private_beta');
  S.membership.createGoogle=async(db,{googleSub,email})=>{ assert.equal(googleSub,'sub-1'); assert.equal(email,'google@example.test'); return {ok:true,user_id:22,is_admin:false}; };
  const created=await callback(flow);
  assert.equal(location(created).searchParams.get('google'),'success');
  assert.equal(location(created).pathname,'/','success leaves the invite page; only errors return to /invite');
  // Existing account accepting an invitation already claimed by someone else.
  const acct={id:5,email:'google@example.test',is_admin:0,google_sub:'sub-1'};
  S.sql=sqlRoutes([[/identity.subject=\? LIMIT 2/,[acct]],[/UPDATE auth_accounts SET last_login/,[{id:5}]],
    [/INSERT INTO auth_provider_identities/,[{user_id:5}]]]);
  S.membership.validate=async()=>({ok:true,used_by:6});
  assert.equal(err(await callback(flow)),'private_beta');
  S.membership.validate=async()=>({ok:true,used_by:5});
  S.membership.accept=async()=>{ throw new Error('db'); };
  assert.equal(err(await callback(flow)),'db_error');
  S.membership.accept=async()=>({ok:false});
  assert.equal(err(await callback(flow)),'private_beta');
  S.membership.accept=async()=>({ok:true});
  assert.equal(location(await callback(flow)).searchParams.get('google'),'success');
  // An invite transaction is unusable once membership is switched off.
  S.membership.enabled=false;
  assert.equal(err(await callback(flow)),'private_beta');
});
