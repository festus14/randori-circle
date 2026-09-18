import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import bcrypt from 'bcryptjs';

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
const membershipCalls=[];
const validationCalls=[];
const acceptanceCalls=[];
const accountAcceptanceCalls=[];

const db={
  async execute(statement){
    const sql=typeof statement==='string' ? statement : String(statement?.sql||'');
    const args=typeof statement==='string' ? [] : (statement?.args||[]);
    executed.push({sql,args});
    return await executeHandler(sql,args) || {rows:[],rowsAffected:0};
  },
  async batch(statements,mode){
    const results=[];
    for(const statement of statements) results.push(await this.execute(statement));
    return results;
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
    isoWeekLabel:()=>'2026-W38',
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:req=>req.headers?.['x-test-auth']==='user'
      ? {id:2,email:'user@example.test',name:'User'}
      : (req.headers?.['x-test-auth']==='admin'
        ? {id:1,email:'admin@example.test',name:'Admin',is_admin:true}
        : null),
  },
});

mock.module('../../api/_circle-membership.js',{
  exports:{
    INVITE_CLAIM_COOKIE:'randori_invite_claim',
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
  },
});

const [{default:authHandler},{default:opsHandler}]=await Promise.all([
  import('../../api/auth.js'),
  import('../../api/ops.js'),
]);

const originalFetch=globalThis.fetch;
const sameOriginHeaders={origin:'https://randori.example.test',host:'randori.example.test'};

function rows(values=[],extra={}){ return {rows:values,rowsAffected:0,...extra}; }

function invoke(handler,{method='GET',url='/',query={},headers={},body={}}={}){
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
    const request={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

function accountSql(sql){
  return sql.includes('SELECT id,email,password_hash,display_name,color,is_admin FROM auth_accounts WHERE email=');
}

function oauthCookies({claim=true}={}){
  const values=[
    'randori_oauth_state=expected-state',
    'randori_oauth_verifier=verifier',
  ];
  if(claim) values.push('randori_invite_claim=valid-claim');
  return values.join('; ');
}

beforeEach(()=>{
  executed.length=0;
  membershipCalls.length=0;
  validationCalls.length=0;
  acceptanceCalls.length=0;
  accountAcceptanceCalls.length=0;
  membershipResult=true;
  membershipError=null;
  validationResult={ok:false};
  acceptanceResult={ok:false};
  cutoverStarted=false;
  registrationState='open';
  accountAcceptanceResult={ok:false};
  executeHandler=()=>rows();
  globalThis.fetch=originalFetch;
  for(const key of [
    'ALLOW_OPEN_SIGNUP','APP_URL','CIRCLE_MEMBERSHIP_ENABLED','CRON_SECRET',
    'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST',
  ]) delete process.env[key];
});

after(()=>{ globalThis.fetch=originalFetch; });

test('membership flag keeps password signup closed and preserves disabled behavior',async()=>{
  process.env.ALLOW_OPEN_SIGNUP='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const denied=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:sameOriginHeaders,
    body:{email:'new@example.test',password:PASSWORD,name:'New Member'},
  });
  assert.equal(denied.status,403);
  assert.deepEqual(denied.body,{error:'private beta signup requires a Google invitation'});
  assert.equal(executed.length,0);

  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  executeHandler=sql=>{
    if(sql.includes('RETURNING attempts')) return rows([{attempts:1}]);
    if(sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:9}]);
    return rows();
  };
  const allowed=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:sameOriginHeaders,
    body:{email:'new@example.test',password:PASSWORD,name:'New Member'},
  });
  assert.equal(allowed.status,200);
  assert.match(String(allowed.headers['set-cookie']),/randori_session=/);

  executed.length=0;
  registrationState='uninitialized';
  const bootstrap=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:sameOriginHeaders,
    body:{email:'bootstrap@example.test',password:PASSWORD,name:'Bootstrap Admin'},
  });
  assert.equal(bootstrap.status,200);
  const bootstrapInsert=executed.find(call=>call.sql.includes('INSERT INTO auth_accounts')&&call.sql.includes('RETURNING id'));
  assert.match(bootstrapInsert.sql,/NOT EXISTS \(SELECT 1 FROM sqlite_schema/);
  assert.equal(executed.some(call=>/CREATE TABLE.*circle_membership_rollout/i.test(call.sql)),false);

  cutoverStarted=true;
  const frozen=await invoke(authHandler,{
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:sameOriginHeaders,
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
    method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers:sameOriginHeaders,
    body:{email:'race@example.test',password:PASSWORD,name:'Race Member'},
  });
  assert.equal(raced.status,403);
  assert.equal(executed.some(call=>call.sql.includes('circle_membership_rollout WHERE id=1')),true);
});

test('prepared invitation OAuth forces explicit Google account selection',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  const prepared=await invoke(authHandler,{
    url:'/api/auth/google/start',query:{endpoint:'google-start'},headers:{cookie:oauthCookies()},
  });
  assert.equal(prepared.status,302);
  assert.equal(new URL(prepared.headers.location).searchParams.get('prompt'),'select_account');

  const regular=await invoke(authHandler,{
    url:'/api/auth/google/start',query:{endpoint:'google-start'},headers:{cookie:oauthCookies({claim:false})},
  });
  assert.equal(regular.status,302);
  assert.equal(new URL(regular.headers.location).searchParams.get('prompt'),null);
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
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'invited@example.test',name:'Invited User',sub:'google-invited-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'valid-code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
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
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'invited@example.test',name:'Invited User',sub:'google-invited-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([{
      id:8,is_admin:0,password_hash:'!oauth:existing',google_sub:'google-invited-1',
    }]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
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
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'invited@example.test',name:'Invited User',sub:'google-invited-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([{
      id:8,is_admin:0,password_hash:'!oauth:existing',google_sub:'google-invited-1',
    }]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
  });
  assert.equal(result.status,302);
  assert.equal(result.headers.location,'https://randori.example.test/?google=success');
  assert.equal(acceptanceCalls.length,1);
  assert.equal(acceptanceCalls[0].userId,8);
  assert.match(String(result.headers['set-cookie']),/randori_session=/);
});

test('a stable Google subject cannot create a second account after its email changes',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:null};
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'new-address@example.test',name:'Existing User',sub:'stable-google-sub',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('SELECT id,email FROM auth_accounts WHERE google_sub=')){
      return rows([{id:8,email:'old-address@example.test'}]);
    }
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
  });
  assert.equal(result.status,302);
  assert.match(result.headers.location,/google_error=identity_mismatch/);
  assert.equal(accountAcceptanceCalls.length,0);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
  assert.match(String(result.headers['set-cookie']),/randori_invite_claim=;/);
});

test('disabled membership flag preserves the legacy Google shadow-user write',async()=>{
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'legacy@example.test',name:'Legacy User',sub:'google-legacy-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:18}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies({claim:false})},
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
    headers:{cookie:oauthCookies({claim:false})},
  });
  assert.equal(frozen.status,302);
  assert.match(frozen.headers.location,/google_error=private_beta/);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO auth_accounts')),false);

  executed.length=0;
  cutoverStarted=false;
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('circle_membership_rollout')) return rows([]);
    return rows();
  };
  const raced=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies({claim:false})},
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
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'invited@example.test',name:'Invited User',sub:'google-invited-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if(sql.includes('INSERT INTO auth_accounts')&&sql.includes('RETURNING id')) return rows([{id:8}]);
    if(sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };

  validationResult={ok:true,circle_id:1,invitation_id:'invite-1',email_hash:'email-hash',used_by:99};
  let result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
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
    headers:{cookie:oauthCookies()},
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
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'invited@example.test',name:'Invited User',sub:'google-invited-1',email_verified:true,
      }),{status:200});
  executeHandler=sql=>{
    if(sql.includes('SELECT id, is_admin, password_hash, google_sub')) throw new Error('database unavailable');
    return rows();
  };

  const result=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'expected-state'},
    headers:{cookie:oauthCookies()},
  });
  assert.equal(result.status,302);
  assert.match(result.headers.location,/google_error=db_error/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_invite_claim=;/);
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('manual and weekly production pairing queries are primary-circle scoped when enabled',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{
      id:1,email:'admin@example.test',is_admin:1,
    }]);
    if(sql.includes('SELECT id FROM pairing_weeks WHERE week_label=')) return rows([]);
    if(sql.includes('FROM auth_accounts')&&sql.includes("cm.status='active'")) return rows([]);
    return rows();
  };

  const manual=await invoke(opsHandler,{
    method:'POST',url:'/api/admin/reshuffle',query:{endpoint:'reshuffle'},headers:{'x-test-auth':'admin'},
  });
  assert.equal(manual.status,400);
  let candidateQueries=executed.filter(call=>call.sql.includes('FROM auth_accounts')&&call.sql.includes('circle_memberships'));
  assert.ok(candidateQueries.length>=2);
  for(const call of candidateQueries){
    assert.match(call.sql,/cm\.status='active'/);
    assert.match(call.sql,/c\.is_primary=1/);
    assert.match(call.sql,/c\.archived_at IS NULL/);
    assert.match(call.sql,/COALESCE\(is_demo,0\)=0/);
  }

  executed.length=0;
  const weekly=await invoke(opsHandler,{
    method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'},
  });
  assert.equal(weekly.status,400);
  candidateQueries=executed.filter(call=>call.sql.includes('FROM auth_accounts')&&call.sql.includes('circle_memberships'));
  assert.equal(candidateQueries.length,1);
  assert.equal(executed.some(call=>call.sql.includes('FROM users ORDER BY id')),false);
});

test('disabled membership flag preserves legacy weekly fallback and unscoped manual query',async()=>{
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{
      id:1,email:'admin@example.test',is_admin:1,
    }]);
    if(sql.includes('SELECT id FROM pairing_weeks WHERE week_label=')) return rows([]);
    return rows();
  };

  const manual=await invoke(opsHandler,{
    method:'POST',url:'/api/admin/reshuffle',query:{endpoint:'reshuffle'},headers:{'x-test-auth':'admin'},
  });
  assert.equal(manual.status,400);
  assert.equal(executed.some(call=>call.sql.includes('circle_memberships')),false);

  executed.length=0;
  const weekly=await invoke(opsHandler,{
    method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'},
  });
  assert.equal(weekly.status,400);
  assert.equal(executed.some(call=>call.sql.includes('FROM users ORDER BY id')),true);
  assert.equal(executed.some(call=>call.sql.includes('circle_memberships')),false);
});

test('membership-scoped pairing database failures fail closed with a generic response',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.CRON_SECRET='cron-secret';
  executeHandler=sql=>{
    if(sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{
      id:1,email:'admin@example.test',is_admin:1,
    }]);
    if(sql.includes('SELECT id FROM pairing_weeks WHERE week_label=')) return rows([]);
    if(sql.includes('circle_memberships')) throw new Error('sensitive database failure');
    return rows();
  };

  for(const request of [
    {method:'POST',url:'/api/admin/reshuffle',query:{endpoint:'reshuffle'},headers:{'x-test-auth':'admin'}},
    {method:'POST',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'}},
  ]){
    const result=await invoke(opsHandler,request);
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{error:'pairing unavailable'});
    assert.doesNotMatch(JSON.stringify(result.body),/sensitive database failure/);
  }
});
