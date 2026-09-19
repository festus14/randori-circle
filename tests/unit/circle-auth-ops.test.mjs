import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import bcrypt from 'bcryptjs';
import {googleOAuthCookieHeader,googleProviderFetch} from '../support/google-oidc.mjs';

const JWT_SECRET='circle-auth-unit-test-secret-at-least-32-characters';
const PASSWORD='correct horse battery';
const PASSWORD_HASH=await bcrypt.hash(PASSWORD,4);
const executed=[];
let executeHandler=()=>({rows:[],rowsAffected:0});
let membershipResult=true;
let membershipError=null;
let validationResult={ok:false};
let acceptanceResult={ok:false};
let cutoverStarted=false;
let registrationState='open';
let accountAcceptanceResult={ok:false};
let passwordAccountResult={ok:false};
let readinessError=null;
const membershipCalls=[];
const validationCalls=[];
const acceptanceCalls=[];
const accountAcceptanceCalls=[];
const passwordAccountCalls=[];
const readinessCalls=[];
const availabilityApplications=[];
const availabilityReads=[];
const sessionRevocations=[];
const identityTransactionActions=[];
let sessionIssueError=null;
let sessionRevokeError=null;
let signedSessionPayload=null;

const db={
  async execute(statement){
    const sql=typeof statement==='string' ? statement : String(statement?.sql||'');
    const args=typeof statement==='string' ? [] : (statement?.args||[]);
    executed.push({sql,args});
    if(sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc")){
      return {rows:[{now_utc:new Date().toISOString()}],rowsAffected:0};
    }
    const result=await executeHandler(sql,args) || {rows:[],rowsAffected:0};
    if(!(result.rows?.length)&&sql.includes('INSERT INTO auth_provider_identities')&&sql.includes('RETURNING user_id')){
      return rows([{user_id:Number(args[2])}]);
    }
    return result;
  },
  async batch(statements,mode){
    const results=[];
    for(const statement of statements) results.push(await this.execute(statement));
    return results;
  },
  async transaction(){
    const transaction={
      execute:async statement=>{
        identityTransactionActions.push({type:'execute',transaction});
        return this.execute(statement);
      },
      batch:this.batch.bind(this),
      async commit(){ identityTransactionActions.push({type:'commit',transaction}); },
      async rollback(){ identityTransactionActions.push({type:'rollback',transaction}); },
    };
    identityTransactionActions.push({type:'begin',transaction});
    return transaction;
  },
};

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>db,
    getJwtSecret:()=>JWT_SECRET,
    getCronSecret:()=>process.env.CRON_SECRET||'',
    getAdminEmails:()=>new Set(['admin@example.test']),
    deterministicColor:()=>'#123456',
    issueSession:async(_db,user)=>{
      if(sessionIssueError) throw sessionIssueError;
      return `test-session-${user.id||user.uid}`;
    },
    issueSessionInTransaction:async(_db,user)=>{
      if(sessionIssueError) throw sessionIssueError;
      identityTransactionActions.push({type:'issue',transaction:_db});
      return `test-session-${user.id||user.uid}`;
    },
    revokeAccountSessions:async(_db,userId,reason)=>{
      if(sessionRevokeError) throw sessionRevokeError;
      if(reason==='identity_change') identityTransactionActions.push({type:'revoke',transaction:_db});
      sessionRevocations.push({userId,reason}); return 1;
    },
    revokeRequestSession:async()=>{
      if(sessionRevokeError) throw sessionRevokeError;
      return {authenticated:!!signedSessionPayload,revoked:!!signedSessionPayload,userId:signedSessionPayload?.id||null};
    },
    isoWeekLabel:()=>'2026-W38',
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:req=>req.headers?.['x-test-auth']==='user'
      ? {id:2,email:'user@example.test',name:'User'}
      : (req.headers?.['x-test-auth']==='admin'
        ? {id:1,email:'admin@example.test',name:'Admin',is_admin:true}
        : null),
    verifySignedRequestAuth:()=>signedSessionPayload,
  },
});

mock.module('../../api/_circle-membership.js',{
  exports:{
    INVITE_CLAIM_COOKIE:'randori_invite_claim',
    normalizeInvitationEmail:value=>typeof value==='string'?value.trim().toLowerCase():null,
    hashInvitationEmail:value=>typeof value==='string'?'a'.repeat(64):null,
    circleMembershipEnabled:()=>process.env.CIRCLE_MEMBERSHIP_ENABLED==='true',
    circleMembershipCutoverStarted:async()=>cutoverStarted,
    circleMembershipRegistrationState:async()=>cutoverStarted?'closed':registrationState,
    clearInviteClaimCookie:()=> 'randori_invite_claim=; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    readInviteClaim:req=>String(req.headers?.cookie||'').includes('randori_invite_claim=valid-claim')
      ? {invitation_id:'invite-1',circle_id:1,token_hash:'token-hash',email_hash:'email-hash',exp:9999999999}
      : null,
    hasActivePrimaryCircleMembership:async(_db,userId)=>{
      membershipCalls.push(userId);
      if(membershipError) throw membershipError;
      return membershipResult;
    },
    validatePreparedInvitation:async(_db,input)=>{
      validationCalls.push(input);
      return validationResult;
    },
    acceptPreparedInvitation:async(_db,input)=>{
      acceptanceCalls.push(input);
      return acceptanceResult;
    },
    createGoogleAccountFromPreparedInvitation:async(_db,input)=>{
      accountAcceptanceCalls.push(input);
      return accountAcceptanceResult;
    },
    createPasswordAccountFromPreparedInvitation:async(_db,input)=>{
      passwordAccountCalls.push(input);
      return passwordAccountResult;
    },
    ensureCircleMembershipReadiness:async dbValue=>{
      readinessCalls.push(dbValue);
      if(readinessError) throw readinessError;
    },
  },
});

mock.module('../../api/_invitation-email.js',{
  exports:{
    INVITATION_EMAIL_DRAIN_BATCH_SIZE:3,
    INVITATION_EMAIL_EVENT_TYPE:'invitation.email.requested',
    createInvitationEmailHandler:()=>async()=>({}),
    invitationEmailConfiguration:()=>null,
    invitationEmailStatus:async()=>({
      pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0,
    }),
    deliverInvitationEmails:async()=>{ throw new Error('invitation email delivery must remain disabled'); },
  },
});

mock.module('../../api/_pairing-readiness.js',{
  exports:{
    pairingSchemaV6Ready:async()=>true,
  },
});

mock.module('../../api/_availability.js',{
  exports:{
    AVAILABILITY_CACHE_CONTROL:'private, no-store',
    availabilityFailure:()=>({status:503,body:{ok:false,error:'availability unavailable'}}),
    availabilityResponse:availability=>({ok:true,availability}),
    getAvailabilityState:async(_db,options)=>{
      availabilityReads.push(options);
      return {
        cycle:{cycleId:'2026-W39',startsAt:'2026-09-20T07:00:00.000Z',endsAt:'2026-09-27T07:00:00.000Z',cutoffAt:'2026-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'upcoming'},
        cycleKey:'a'.repeat(64),isAvailable:true,version:0,source:'legacy_bridge',editable:true,updatedAt:null,
      };
    },
    updateAvailability:async()=>{ throw new Error('unexpected availability write'); },
    resolveAvailabilityPublicationScope:async(_db,{localRuntime})=>localRuntime
      ?{kind:'local',scopeKey:'local',circleId:null}
      :{kind:'circle',scopeKey:'circle:1',circleId:1},
    applyCycleAvailability:async(_db,{scope,cycle,accounts})=>{
      availabilityApplications.push({scope,cycle,accounts});
      return accounts.map(account=>({
        ...account,
        isAvailable:account.is_available===null||account.is_available===undefined||Number(account.is_available)===1,
      }));
    },
  },
});

const [{default:authHandler,validSignupPassword},{default:opsHandler}]=await Promise.all([
  import('../../api/auth.js'),
  import('../../api/ops.js'),
]);

const originalFetch=globalThis.fetch;
const sameOriginHeaders={origin:'https://randori.example.test',host:'randori.example.test','x-forwarded-proto':'https'};
const localOriginHeaders={origin:'http://127.0.0.1:3000',host:'127.0.0.1:3000'};

function rows(values=[],extra={}){ return {rows:values,rowsAffected:0,...extra}; }

async function withFixedNow(iso,callback){
  const NativeDate=globalThis.Date;
  const instant=new NativeDate(iso).getTime();
  globalThis.Date=class FixedDate extends NativeDate{
    constructor(...args){ super(...(args.length?args:[instant])); }
    static now(){ return instant; }
  };
  try{ return await callback(); }
  finally{ globalThis.Date=NativeDate; }
}

function invoke(handler,{method='GET',url='/',query={},headers={},body={},remoteAddress='127.0.0.1'}={}){
  return new Promise((resolve,reject)=>{
    let status=200;
    let settled=false;
    const responseHeaders={};
    const finish=value=>{
      if(settled) return;
      settled=true;
      resolve({status,headers:responseHeaders,body:value});
    };
    const response={
      status(value){ status=value; return this; },
      json(value){ finish(value); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      getHeader(name){ return responseHeaders[String(name).toLowerCase()]; },
      writeHead(value,headersValue={}){
        status=value;
        for(const [name,headerValue] of Object.entries(headersValue)) responseHeaders[name.toLowerCase()]=headerValue;
        return this;
      },
      end(value){ finish(value); return this; },
    };
    const request={method,url,query,headers,body,socket:{remoteAddress}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

function accountSql(sql){
  return sql.includes('SELECT id,email,password_hash,display_name,color,is_admin FROM auth_accounts WHERE email=');
}

function oauthCookies({claim=true}={}){
  return googleOAuthCookieHeader({invitationClaim:claim?'valid-claim':undefined});
}

function oauthRequestHeaders(options){
  return {...sameOriginHeaders,cookie:oauthCookies(options)};
}

beforeEach(()=>{
  executed.length=0;
  membershipCalls.length=0;
  validationCalls.length=0;
  acceptanceCalls.length=0;
  accountAcceptanceCalls.length=0;
  passwordAccountCalls.length=0;
  readinessCalls.length=0;
  availabilityApplications.length=0;
  availabilityReads.length=0;
  sessionRevocations.length=0;
  identityTransactionActions.length=0;
  sessionIssueError=null;
  sessionRevokeError=null;
  signedSessionPayload=null;
  membershipResult=true;
  membershipError=null;
  validationResult={ok:false};
  acceptanceResult={ok:false};
  cutoverStarted=false;
  registrationState='open';
  accountAcceptanceResult={ok:false};
  passwordAccountResult={ok:false};
  readinessError=null;
  executeHandler=()=>rows();
  globalThis.fetch=originalFetch;
  for(const key of [
    'ALLOW_OPEN_SIGNUP','APP_URL','CIRCLE_MEMBERSHIP_ENABLED','CRON_SECRET',
    'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST',
    'EMAIL_PASSWORD_ACTIVATION_ENABLED','EMAIL_VERIFICATION_ENCRYPTION_KEY',
    'RANDORI_LOCAL_RUNTIME','RANDORI_LOCAL_IDENTITY','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL','VERCEL','VERCEL_ENV','VERCEL_URL',
  ]) delete process.env[key];
});

after(()=>{ globalThis.fetch=originalFetch; });

test('local password signup remains closed when membership rollout is enabled',async()=>{
  process.env.NODE_ENV='development';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  process.env.ALLOW_OPEN_SIGNUP='true';
  process.env.TURSO_DATABASE_URL='file:///tmp/randori-circle-auth.sqlite';
  process.env.APP_URL='http://127.0.0.1:3000';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const denied=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:localOriginHeaders,
    body:{email:'new@example.test',password:PASSWORD,name:'New Member'},
  });
  assert.equal(denied.status,503);
  assert.deepEqual(denied.body,{error:'password signup is disabled during the private beta; use Google sign-in'});
  assert.equal(executed.length,0);

  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:9}]);
    return rows();
  };
  const allowed=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:localOriginHeaders,
    body:{email:'new@example.test',password:PASSWORD,name:'New Member'},
  });
  assert.equal(allowed.status,200);
  assert.match(String(allowed.headers['set-cookie']),/randori_session=/);

  executed.length=0;
  registrationState='uninitialized';
  const bootstrap=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:localOriginHeaders,
    body:{email:'bootstrap@example.test',password:PASSWORD,name:'Bootstrap Admin'},
  });
  assert.equal(bootstrap.status,200);
  const bootstrapInsert=executed.find(call=>call.sql.includes('INSERT INTO auth_accounts')&&call.sql.includes('RETURNING id'));
  assert.match(bootstrapInsert.sql,/NOT EXISTS \(SELECT 1 FROM sqlite_schema/);
  assert.equal(executed.some(call=>/CREATE TABLE.*circle_membership_rollout/i.test(call.sql)),false);

  cutoverStarted=true;
  const frozen=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:localOriginHeaders,
    body:{email:'late@example.test',password:PASSWORD,name:'Late Member'},
  });
  assert.equal(frozen.status,403);
  assert.deepEqual(frozen.body,{error:'private beta signup requires a Google invitation'});

  cutoverStarted=false;
  registrationState='open';
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('circle_membership_rollout')) return rows([]);
    return rows();
  };
  const raced=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:localOriginHeaders,
    body:{email:'race@example.test',password:PASSWORD,name:'Race Member'},
  });
  assert.equal(raced.status,403);
  assert.equal(executed.some(call=>call.sql.includes('circle_membership_rollout WHERE id=1')),true);
});

test('prepared invitation OAuth forces explicit Google account selection',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  const prepared=await invoke(authHandler,{
    url:'/api/auth/google/start',query:{endpoint:'google-start'},headers:oauthRequestHeaders(),
  });
  assert.equal(prepared.status,302);
  assert.equal(new URL(prepared.headers.location).searchParams.get('prompt'),'select_account');

  const regular=await invoke(authHandler,{
    url:'/api/auth/google/start',query:{endpoint:'google-start'},headers:oauthRequestHeaders({claim:false}),
  });
  assert.equal(regular.status,302);
  assert.equal(new URL(regular.headers.location).searchParams.get('prompt'),null);
});

test('local invite signup normalizes rejection cost without looking up the submitted email',async()=>{
  Object.assign(process.env,{
    NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',RANDORI_LOCAL_IDENTITY:'true',
    ALLOW_OPEN_SIGNUP:'false',CIRCLE_MEMBERSHIP_ENABLED:'true',
    TURSO_DATABASE_URL:'file:///tmp/randori-circle-auth.sqlite',APP_URL:'http://127.0.0.1:3000',
  });
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(accountSql(sql)||sql.includes('SELECT id FROM auth_accounts WHERE email=')){
      return rows([{id:1,email:'owner@example.test'}]);
    }
    return rows();
  };
  const request=body=>invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},
    headers:{...localOriginHeaders,cookie:'randori_invite_claim=valid-claim'},body,
  });
  const originalHash=bcrypt.hash;
  const hashes=[];
  bcrypt.hash=async(password,cost)=>{ hashes.push({password,cost}); return PASSWORD_HASH; };
  try{
    const wrong=await request({email:'owner@example.test',password:PASSWORD,name:'Wrong Identity'});
    assert.equal(wrong.status,403);
    assert.deepEqual(wrong.body,{error:'invitation unavailable or does not match this email'});
    assert.equal(hashes.length,1,'a wrong invited email must perform one password hash');
    assert.equal(executed.some(call=>accountSql(call.sql)||call.sql.includes('SELECT id FROM auth_accounts WHERE email=')),false);
    assert.equal(passwordAccountCalls.length,0);

    validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
    const conflict=await request({email:'owner@example.test',password:PASSWORD,name:'Existing Identity'});
    assert.equal(conflict.status,403);
    assert.deepEqual(conflict.body,wrong.body);
    assert.equal(hashes.length,2,'a valid invitation conflict must perform exactly one password hash');
    assert.deepEqual(hashes,[{password:PASSWORD,cost:10},{password:PASSWORD,cost:10}]);
    assert.equal(executed.some(call=>accountSql(call.sql)||call.sql.includes('SELECT id FROM auth_accounts WHERE email=')),false);
    assert.equal(passwordAccountCalls.length,1);
    assert.match(passwordAccountCalls[0].passwordHash,/^\$2/);
    assert.equal(readinessCalls.length,2);
  }finally{
    bcrypt.hash=originalHash;
  }
});

test('password byte limits reject bcrypt-truncated inputs and accept exact UTF-8 boundaries',()=>{
  assert.equal(validSignupPassword('a'.repeat(9)),false);
  assert.equal(validSignupPassword('a'.repeat(10)),true);
  assert.equal(validSignupPassword('a'.repeat(72)),true);
  assert.equal(validSignupPassword('a'.repeat(73)),false);
  assert.equal(validSignupPassword('é'.repeat(36)),true);
  assert.equal(validSignupPassword('é'.repeat(37)),false);
  assert.equal(validSignupPassword('🙂'.repeat(18)),true);
  assert.equal(validSignupPassword('🙂'.repeat(19)),false);
});

test('migrated local login probes readiness, avoids DDL, and bcrypt-compares absent accounts',async()=>{
  Object.assign(process.env,{
    NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',RANDORI_LOCAL_IDENTITY:'true',
    ALLOW_OPEN_SIGNUP:'false',CIRCLE_MEMBERSHIP_ENABLED:'true',
    TURSO_DATABASE_URL:'file:///tmp/randori-circle-auth.sqlite',APP_URL:'http://127.0.0.1:3000',
  });
  executeHandler=sql=>sql.includes('RETURNING attempts')?rows([{attempts:1}]):rows();
  const originalCompare=bcrypt.compare;
  const compared=[];
  bcrypt.compare=async(password,hash)=>{ compared.push({password,hash}); return false; };
  let response;
  try{
    response=await invoke(authHandler,{
      method:'POST',url:'/api/auth/login',query:{endpoint:'login'},headers:localOriginHeaders,
      body:{email:'absent@example.test',password:PASSWORD},
    });
  }finally{
    bcrypt.compare=originalCompare;
  }
  assert.equal(response.status,401);
  assert.deepEqual(response.body,{error:'invalid credentials'});
  assert.equal(compared.length,1);
  assert.equal(compared[0].password,PASSWORD);
  assert.match(compared[0].hash,/^\$2/);
  assert.equal(readinessCalls.length,1);
  assert.equal(executed.some(call=>/\b(?:CREATE|ALTER|DROP)\b/i.test(call.sql)),false);
});

test('password login and profile require active primary-circle membership when enabled',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(accountSql(sql)) return rows([{
      id:2,email:'user@example.test',password_hash:PASSWORD_HASH,display_name:'User',color:'#123456',is_admin:0,
    }]);
    if(sql.includes('SELECT id,email,display_name,color,created_at')) return rows([{
      id:2,email:'user@example.test',display_name:'User',color:'#123456',is_available:1,is_admin:0,
    }]);
    return rows();
  };

  membershipResult=false;
  const deniedLogin=await invoke(authHandler,{
    method:'POST',url:'/api/auth/login',query:{endpoint:'login'},headers:sameOriginHeaders,
    body:{email:'user@example.test',password:PASSWORD},
  });
  assert.equal(deniedLogin.status,403);
  assert.equal(deniedLogin.headers['set-cookie'],undefined);
  assert.equal(executed.some(call=>call.sql.includes('SET last_login=')),false);

  const deniedProfile=await invoke(authHandler,{
    url:'/api/auth/me',query:{endpoint:'me'},headers:{'x-test-auth':'user'},
  });
  assert.equal(deniedProfile.status,403);
  assert.match(String(deniedProfile.headers['set-cookie']),/randori_session=;.*Max-Age=0/);

  membershipResult=true;
  const allowedLogin=await invoke(authHandler,{
    method:'POST',url:'/api/auth/login',query:{endpoint:'login'},headers:sameOriginHeaders,
    body:{email:'user@example.test',password:PASSWORD},
  });
  assert.equal(allowedLogin.status,200);
  assert.match(String(allowedLogin.headers['set-cookie']),/randori_session=/);
});

test('membership lookup failures never establish or invalidate a session as a false nonmember',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(accountSql(sql)) return rows([{
      id:2,email:'user@example.test',password_hash:PASSWORD_HASH,display_name:'User',color:'#123456',is_admin:0,
    }]);
    if(sql.includes('SELECT id,email,display_name,color,created_at')) return rows([{
      id:2,email:'user@example.test',display_name:'User',color:'#123456',is_available:1,is_admin:0,
    }]);
    return rows();
  };
  membershipError=new Error('database unavailable');

  const login=await invoke(authHandler,{
    method:'POST',url:'/api/auth/login',query:{endpoint:'login'},headers:sameOriginHeaders,
    body:{email:'user@example.test',password:PASSWORD},
  });
  assert.equal(login.status,503);
  assert.equal(login.headers['set-cookie'],undefined);

  const profile=await invoke(authHandler,{
    url:'/api/auth/me',query:{endpoint:'me'},headers:{'x-test-auth':'user'},
  });
  assert.equal(profile.status,503);
  assert.equal(profile.headers['set-cookie'],undefined,'transient readiness failures must not clear a valid session');
});

test('verified Google invitation bypasses allowlist only after validation and atomic acceptance',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.SIGNUP_ALLOWLIST='someone-else@example.test';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  accountAcceptanceResult={ok:true,user_id:8,is_admin:false,circle_id:1,created:true,idempotent:false};
  membershipResult=false;
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'google-invited-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'valid-code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.match(String(result.headers['set-cookie']),/randori_invite_claim=; Path=\/api\/auth;.*Max-Age=0/);
  assert.match(String(result.headers['set-cookie']),/randori_session=/);
  assert.deepEqual(validationCalls,[{
    claim:{invitation_id:'invite-1',circle_id:1,token_hash:'token-hash',email_hash:'email-hash',exp:9999999999},
    email:'invited@example.test',
  }]);
  assert.deepEqual(accountAcceptanceCalls,[{
    claim:{invitation_id:'invite-1',circle_id:1,token_hash:'token-hash',email_hash:'email-hash',exp:9999999999},
    email:'invited@example.test',
    passwordHash:accountAcceptanceCalls[0].passwordHash,
    displayName:'Invited User',color:'#123456',isAdmin:false,googleSub:'google-invited-1',
    googleIssuer:'https://accounts.google.com',
  }]);
  assert.match(accountAcceptanceCalls[0].passwordHash,/^!oauth:[A-Za-z0-9_-]{32}$/);
  assert.equal(acceptanceCalls.length,0);
  assert.equal(executed.some(call=>/\b(?:FROM|INTO) users\b/.test(call.sql)),false);
});

test('same-account invitation replay completes sign-in only while membership remains active',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  membershipResult=true;
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:8};
  acceptanceResult={ok:true,circle_id:1,idempotent:true};
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'google-invited-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([{
      id:8,is_admin:0,password_hash:'!oauth:existing',google_sub:'google-invited-1',
    }]);
    if(sql.includes('UPDATE auth_accounts SET last_login')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.match(String(result.headers['set-cookie']),/randori_session=/);
  assert.equal(acceptanceCalls.length,1);
  assert.equal(acceptanceCalls[0].userId,8);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO auth_accounts')),false);
});

test('an active member consumes a fresh prepared invitation before receiving a session',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  membershipResult=true;
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  acceptanceResult={ok:true,circle_id:1,idempotent:false};
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'google-invited-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([{
      id:8,is_admin:0,password_hash:'!oauth:existing',google_sub:'google-invited-1',
    }]);
    if(sql.includes('UPDATE auth_accounts SET last_login')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.equal(acceptanceCalls.length,1);
  assert.equal(acceptanceCalls[0].userId,8);
  assert.match(String(result.headers['set-cookie']),/randori_session=/);
});

test('a stable Google subject signs into the same account after its verified email changes',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  globalThis.fetch=googleProviderFetch({claims:{
    email:'new-address@example.test',name:'Existing User',sub:'stable-google-sub',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE google_sub=')){
      return rows([{id:8,email:'old-address@example.test',is_admin:0}]);
    }
    if(sql.includes('UPDATE auth_accounts SET email=')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.equal(accountAcceptanceCalls.length,0);
  assert.match(String(result.headers['set-cookie']),/randori_session=/);
  assert.equal(executed.filter(call=>call.sql.includes('UPDATE auth_accounts SET email=')).length,1);
  assert.deepEqual(sessionRevocations,[{userId:8,reason:'identity_change'}]);
  assert.deepEqual(identityTransactionActions.map(action=>action.type),['begin','execute','revoke','issue','commit']);
  assert.ok(identityTransactionActions.every(action=>action.transaction===identityTransactionActions[0].transaction));
});

test('a verified Google email never auto-links an existing password account',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'new-google-subject',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([{
      id:8,email:'invited@example.test',is_admin:0,password_hash:PASSWORD_HASH,google_sub:null,
    }]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.match(result.headers.location,/google_error=account_exists_use_password/);
  assert.equal(accountAcceptanceCalls.length,0);
  assert.equal(executed.some(call=>call.sql.includes('UPDATE auth_accounts SET')),false);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('a stable Google subject cannot take an email already bound to another Google identity',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  globalThis.fetch=googleProviderFetch({claims:{
    email:'occupied@example.test',name:'Conflicting User',sub:'stable-google-sub',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([{
      id:9,email:'occupied@example.test',is_admin:0,password_hash:'!oauth:other',google_sub:'other-google-sub',
    }]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders({claim:false}),
  });
  assert.match(result.headers.location,/google_error=identity_mismatch/);
  assert.equal(executed.some(call=>call.sql.includes('UPDATE auth_accounts SET')),false);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('disabled membership flag preserves the legacy Google shadow-user write',async()=>{
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  globalThis.fetch=googleProviderFetch({claims:{
    email:'legacy@example.test',name:'Legacy User',sub:'google-legacy-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:18}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders({claim:false}),
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.equal(executed.some(call=>call.sql.includes('SELECT id FROM users')),true);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO users')),true);
  assert.equal(membershipCalls.length,0);

  executed.length=0;
  cutoverStarted=true;
  const frozen=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders({claim:false}),
  });
  assert.equal(frozen.status,302);
  assert.match(frozen.headers.location,/google_error=private_beta/);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO auth_accounts')),false);

  executed.length=0;
  cutoverStarted=false;
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('circle_membership_rollout')) return rows([]);
    return rows();
  };
  const raced=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders({claim:false}),
  });
  assert.equal(raced.status,302);
  assert.match(raced.headers.location,/google_error=private_beta/);
  assert.equal(executed.some(call=>call.sql.includes('circle_membership_rollout WHERE id=1')),true);
});

test('invalid, already-used-by-other, or lost-race invite claims never issue a session',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  membershipResult=false;
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'google-invited-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:99};
  let result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.match(result.headers.location,/google_error=private_beta/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO auth_accounts')),false);

  executed.length=0;
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  accountAcceptanceResult={ok:false};
  result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.match(result.headers.location,/google_error=private_beta/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('transient OAuth database failure retains the prepared invite claim for a safe retry',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  globalThis.fetch=googleProviderFetch({claims:{
    email:'invited@example.test',name:'Invited User',sub:'google-invited-1',
  }});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) throw new Error('database unavailable');
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(result.status,302);
  assert.match(result.headers.location,/google_error=db_error/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_invite_claim=;/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('manual and weekly production pairing queries are primary-circle scoped when enabled',async()=>{
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")||sql.includes("membership.role='owner'")) return rows([{id:1,role:'owner',circle_id:1}]);
    if(sql.includes('FROM auth_accounts')&&sql.includes("cm.status='active'")) return rows([]);
    if(sql.includes('FROM auth_accounts account')&&sql.includes("membership.status='active'")) return rows([]);
    return rows();
  };

  const manual=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'},
  });
  assert.equal(manual.status,400);
  let candidateQueries=executed.filter(call=>call.sql.includes('account.email')&&call.sql.includes('circle_memberships'));
  assert.equal(candidateQueries.length,1);
  for(const call of candidateQueries){
    assert.match(call.sql,/membership\.status='active'/);
    assert.match(call.sql,/circle\.is_primary=1/);
    assert.match(call.sql,/circle\.archived_at IS NULL/);
    assert.match(call.sql,/COALESCE\(account\.is_demo,0\)=0/);
    assert.deepEqual(call.args,[1]);
  }
  assert.equal(availabilityApplications.length,1);
  assert.equal(availabilityApplications[0].scope.scopeKey,'circle:1');
  assert.equal(availabilityApplications[0].cycle.state,'current');

  executed.length=0;
  const weekly=await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler,{
    method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'},
  }));
  assert.equal(weekly.status,400);
  candidateQueries=executed.filter(call=>call.sql.includes('account.email')&&call.sql.includes('circle_memberships'));
  assert.equal(candidateQueries.length,1);
  assert.equal(executed.some(call=>call.sql.includes('FROM users ORDER BY id')),false);
});

test('pairing publication requires a primary-circle owner in production and only a database admin in the isolated local runtime',async()=>{
  process.env.APP_URL='https://randori.example.test';
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")||sql.includes("membership.role='owner'")) return rows([]);
    return rows();
  };
  const production=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'},
  });
  assert.equal(production.status,403,'a production is_admin claim is not circle-owner authority');

  process.env.NODE_ENV='development';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.TURSO_DATABASE_URL='file:///tmp/randori-pairing-local.sqlite';
  process.env.APP_URL='http://127.0.0.1:3000';
  executed.length=0;
  executeHandler=sql=>{
    if(sql.includes('SELECT id,is_admin FROM auth_accounts')) return rows([{id:1,is_admin:1}]);
    return rows();
  };
  const local=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},
    headers:{'x-test-auth':'admin',host:'127.0.0.1:3000'},
  });
  assert.equal(local.status,400,'an authorized local admin reaches participant validation');
  assert.equal(executed.some(call=>call.sql.includes('circle_memberships')),false);

  executeHandler=sql=>{
    if(sql.includes('SELECT id,is_admin FROM auth_accounts')) return rows([{id:1,is_admin:0}]);
    return rows();
  };
  const localMember=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},
    headers:{'x-test-auth':'admin',host:'127.0.0.1:3000'},
  });
  assert.equal(localMember.status,403);
});

test('availability local scope requires every loopback and provider-isolation guard',async()=>{
  const configureLocal=()=>{
    process.env.NODE_ENV='development';
    process.env.RANDORI_LOCAL_RUNTIME='true';
    process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
    process.env.TURSO_DATABASE_URL='file:///tmp/randori-availability-local.sqlite';
    process.env.APP_URL='http://127.0.0.1:3000';
    delete process.env.TURSO_AUTH_TOKEN;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_URL;
  };
  const request=overrides=>invoke(opsHandler,{
    method:'GET',url:'/api/settings/availability',query:{endpoint:'availability'},
    headers:{'x-test-auth':'user',host:'127.0.0.1:3000'},...overrides,
  });

  configureLocal();
  assert.equal((await request({})).status,200);
  assert.equal(availabilityReads.at(-1).localRuntime,true);

  for(const scenario of [
    {request:{remoteAddress:'203.0.113.4'}},
    {request:{headers:{'x-test-auth':'user',host:'localhost:3000'}}},
    {env:{VERCEL:'1'}},
    {env:{TURSO_AUTH_TOKEN:'secret'}},
    {env:{TURSO_DATABASE_URL:'libsql://remote.example.test'}},
    {env:{CIRCLE_MEMBERSHIP_ENABLED:'true'}},
  ]){
    configureLocal();
    Object.assign(process.env,scenario.env||{});
    availabilityReads.length=0;
    assert.equal((await request(scenario.request||{})).status,200);
    assert.equal(availabilityReads.length,1);
    assert.equal(availabilityReads[0].localRuntime,false);
  }
});

test('production pairing stays primary-circle scoped when the rollout flag is disabled',async()=>{
  process.env.APP_URL='https://randori.example.test';
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")||sql.includes("membership.role='owner'")) return rows([{id:1,role:'owner',circle_id:1}]);
    return rows();
  };

  const manual=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'},
  });
  assert.equal(manual.status,400);
  assert.equal(executed.some(call=>call.sql.includes('circle_memberships')),true);

  executed.length=0;
  const weekly=await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler,{
    method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'},
  }));
  assert.equal(weekly.status,400);
  assert.equal(executed.some(call=>call.sql.includes('FROM users ORDER BY id')),false);
  assert.equal(executed.some(call=>call.sql.includes('circle_memberships')),true);
});

test('membership-scoped pairing database failures fail closed with a generic response',async()=>{
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes('circle_memberships')) throw new Error('sensitive database failure');
    return rows();
  };

  for(const request of [
    {method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'}},
    {method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'}},
  ]){
    const result=request.query.endpoint==='weekly'
      ?await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler,request))
      :await invoke(opsHandler,request);
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{error:'pairing unavailable'});
    assert.doesNotMatch(JSON.stringify(result.body),/sensitive database failure/);
  }
});
