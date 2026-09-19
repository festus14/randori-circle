import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after,mock,test} from 'node:test';
import {createClient} from '@libsql/client';

import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {googleOAuthCookieHeader,googleProviderFetch} from '../support/google-oidc.mjs';

const directory=mkdtempSync(join(tmpdir(),'randori-google-oidc-'));
const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
const JWT_SECRET='google-oidc-integration-secret-at-least-32-bytes';

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',JWT_ISSUER:'randori-circle',getClient:()=>db,
    getJwtSecret:()=>JWT_SECRET,getAdminEmails:()=>new Set(),deterministicColor:()=>'#123456',
    issueSession:async(_db,user)=>`test-session-${user.id||user.uid}`,
    issueSessionInTransaction:async(_db,user)=>`test-session-${user.id||user.uid}`,
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    verifyMutationOrigin:()=>true,verifyRequestAuth:()=>null,verifySignedRequestAuth:()=>null,
  },
});

const {default:authHandler}=await import('../../api/auth.js');
const originalFetch=globalThis.fetch;

function invoke({code='one-time-code',cookie=googleOAuthCookieHeader()}={}){
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
      query:{endpoint:'callback',code,state:'expected-state'},
      headers:{host:'randori.example.test','x-forwarded-proto':'https',cookie},
    };
    const res={
      status(value){ status=value; return this; },
      json(body){ finish(body); return this; },
      setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      getHeader(name){ return headers[String(name).toLowerCase()]; },
      writeHead(value,values={}){
        status=value;
        for(const [name,headerValue] of Object.entries(values)) headers[name.toLowerCase()]=headerValue;
        return this;
      },
      end(body){ finish(body); },
    };
    Promise.resolve(authHandler(req,res)).then(()=>finish()).catch(reject);
  });
}

after(()=>{
  globalThis.fetch=originalFetch;
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST']){
    delete process.env[key];
  }
  db.close();
  rmSync(directory,{recursive:true,force:true});
});

test('migrated OAuth persists issuer plus subject, follows stable identity, and refuses email auto-linking',async()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  process.env.SIGNUP_ALLOWLIST='first@example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  await prepareMigrationConnection(db);
  const fresh=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:fresh.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});

  globalThis.fetch=googleProviderFetch({claims:{
    email:'first@example.test',name:'First Identity',sub:'stable-google-subject',
  }});
  const created=await invoke();
  assert.equal(created.headers.location,'https://randori.example.test/?google=success');
  assert.match(String(created.headers['set-cookie']),/randori_session=/);
  let accounts=await db.execute(`SELECT id,email,google_sub FROM auth_accounts ORDER BY id`);
  assert.deepEqual(accounts.rows.map(row=>[Number(row.id),String(row.email),String(row.google_sub)]),[
    [1,'first@example.test','stable-google-subject'],
  ]);
  let identities=await db.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities`);
  assert.deepEqual(identities.rows.map(row=>[String(row.issuer),String(row.subject),Number(row.user_id)]),[
    ['https://accounts.google.com','stable-google-subject',1],
  ]);

  await db.execute(`INSERT INTO auth_accounts
    (email,password_hash,display_name,color) VALUES
    ('renamed@example.test','$2a$10$PBpMY4NLVseWPP6G9VtPveLltge4ovpON5/cJwqL8JU.khDEvJ9De','Email Collision','#654321')`);
  globalThis.fetch=googleProviderFetch({claims:{
    email:'renamed@example.test',name:'Renamed Identity',sub:'stable-google-subject',
  }});
  const renamed=await invoke({code:'second-one-time-code'});
  assert.equal(renamed.headers.location,'https://randori.example.test/?google=success');
  accounts=await db.execute(`SELECT id,email,google_sub FROM auth_accounts ORDER BY id`);
  assert.deepEqual(accounts.rows.map(row=>[Number(row.id),String(row.email),String(row.google_sub)]),[
    [1,'first@example.test','stable-google-subject'],
    [2,'renamed@example.test','null'],
  ]);

  await db.execute(`INSERT INTO auth_accounts
    (email,password_hash,display_name,color) VALUES
    ('password@example.test','$2a$10$PBpMY4NLVseWPP6G9VtPveLltge4ovpON5/cJwqL8JU.khDEvJ9De','Password User','#654321')`);
  globalThis.fetch=googleProviderFetch({claims:{
    email:'password@example.test',name:'Password User',sub:'different-google-subject',
  }});
  const refused=await invoke({code:'third-one-time-code'});
  assert.match(refused.headers.location,/google_error=account_exists_use_password/);
  assert.doesNotMatch(String(refused.headers['set-cookie']),/randori_session=[^;]/);
  identities=await db.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities`);
  assert.equal(identities.rows.length,1);
});
