import assert from 'node:assert/strict';
import {after,test,mock} from 'node:test';
import {createClient} from '@libsql/client';

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
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:()=>null,
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
      headers:{cookie:'randori_oauth_state=expected-state; randori_oauth_verifier=verifier'},
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

test('fresh production Google bootstrap is explicit, allowlisted, and disabled by default',async()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  process.env.SIGNUP_ALLOWLIST='bootstrap@example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  globalThis.fetch=async url=>String(url).includes('/token')
    ? new Response(JSON.stringify({access_token:'google-access'}),{status:200})
    : new Response(JSON.stringify({
        email:'bootstrap@example.test',name:'Bootstrap Owner',sub:'google-bootstrap-1',email_verified:true,
      }),{status:200});

  const disabled=await invoke();
  assert.equal(disabled.status,302);
  assert.match(disabled.headers.location,/google_error=db_error/);
  const before=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='auth_accounts'`);
  assert.equal(before.rows.length,0);

  process.env.AUTH_SCHEMA_BOOTSTRAP_ENABLED='true';
  const enabled=await invoke();
  assert.equal(enabled.status,302);
  assert.equal(enabled.headers.location,'https://randori.example.test/?google=success');
  assert.match(String(enabled.headers['set-cookie']),/randori_session=/);

  const columns=await db.execute(`PRAGMA table_info('auth_accounts')`);
  assert.equal(columns.rows.some(row=>row.name==='google_sub'),true);
  const account=await db.execute(`SELECT email,display_name,is_admin,google_sub FROM auth_accounts`);
  assert.deepEqual(account.rows.map(row=>({
    email:String(row.email),display_name:String(row.display_name),is_admin:Number(row.is_admin),google_sub:String(row.google_sub),
  })),[{
    email:'bootstrap@example.test',display_name:'Bootstrap Owner',is_admin:1,google_sub:'google-bootstrap-1',
  }]);
  const rollout=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name='circle_membership_rollout'`);
  assert.equal(rollout.rows.length,0,'bootstrap must not create membership schema or close its registration latch');
});
