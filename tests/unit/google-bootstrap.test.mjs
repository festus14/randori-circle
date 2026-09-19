import assert from 'node:assert/strict';
import {after,test,mock} from 'node:test';
import {createClient} from '@libsql/client';
import {googleOAuthCookieHeader,googleProviderFetch} from '../support/google-oidc.mjs';

const db=createClient({url:'file::memory:'});
const JWT_SECRET='google-bootstrap-test-secret-at-least-thirty-two-bytes';

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>db,
    getJwtSecret:()=>JWT_SECRET,
    getAdminEmails:()=>new Set(['bootstrap@example.test']),
    deterministicColor:()=>'#123456',
    issueSession:async(_db,user)=>`test-session-${user.id||user.uid}`,
    issueSessionInTransaction:async(_db,user)=>`test-session-${user.id||user.uid}`,
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:()=>null,
    verifySignedRequestAuth:()=>null,
  },
});

const {default:authHandler}=await import('../../api/auth.js');
const originalFetch=globalThis.fetch;

function invoke(){
  return new Promise((resolve,reject)=>{
    let status=200;
    let settled=false;
    const headers={};
    const finish=body=>{
      if(settled) return;
      settled=true;
      resolve({status,headers,body});
    };
    const req={
      method:'GET',url:'/api/auth/google/callback',
      query:{endpoint:'callback',code:'code',state:'expected-state'},
      headers:{
        host:'randori.example.test','x-forwarded-proto':'https',
        cookie:googleOAuthCookieHeader(),
      },
      socket:{remoteAddress:'127.0.0.1'},
    };
    const res={
      status(code){ status=code; return this; },
      json(body){ finish(body); return this; },
      setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      getHeader(name){ return headers[String(name).toLowerCase()]; },
      writeHead(code,values={}){
        status=code;
        for(const [name,value] of Object.entries(values)) headers[name.toLowerCase()]=value;
        return this;
      },
      end(body){ finish(body); },
    };
    Promise.resolve(authHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

after(()=>{
  globalThis.fetch=originalFetch;
  for(const key of [
    'APP_URL','AUTH_SCHEMA_BOOTSTRAP_ENABLED','CIRCLE_MEMBERSHIP_ENABLED',
    'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST',
  ]) delete process.env[key];
  db.close();
});

test('legacy Google bootstrap cannot bypass the provider-identity migration gate',async()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  process.env.SIGNUP_ALLOWLIST='bootstrap@example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  let providerCalls=0;
  globalThis.fetch=googleProviderFetch({
    claims:{email:'bootstrap@example.test',name:'Bootstrap Owner',sub:'google-bootstrap-1'},
    onRequest:()=>{ providerCalls+=1; },
  });

  const disabled=await invoke();
  assert.equal(disabled.status,302);
  assert.match(disabled.headers.location,/google_error=db_error/);
  const before=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_accounts'`);
  assert.equal(before.rows.length,0);

  process.env.AUTH_SCHEMA_BOOTSTRAP_ENABLED='true';
  const enabled=await invoke();
  assert.equal(enabled.status,302);
  assert.equal(enabled.headers.location,'https://randori.example.test/?google_error=db_error');
  assert.doesNotMatch(String(enabled.headers['set-cookie']),/randori_session=[^;]/);

  const accounts=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_accounts'`);
  assert.equal(accounts.rows.length,0,'a missing provider-identity table must fail before legacy bootstrap writes');
  const identities=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_provider_identities'`);
  assert.equal(identities.rows.length,0,'request-time bootstrap must not create the versioned identity table');
  assert.equal(providerCalls,0,'an unmigrated database must fail before consuming the one-time provider code');
  const rollout=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='circle_membership_rollout'`);
  assert.equal(rollout.rows.length,0,'bootstrap must not create membership schema or close its registration latch');
});
