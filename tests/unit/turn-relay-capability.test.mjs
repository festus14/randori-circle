// Issue #305 (ID-107): the turnRelay capability is advertised only while the
// flag is literally true and a relay is fully configured. Without it the
// browser never loads the relay module and creates its peer as before.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import authHandler from '../../api/auth.js';

const KEYS=['TURN_RELAY_ENABLED','CLOUDFLARE_TURN_KEY_ID','CLOUDFLARE_TURN_API_TOKEN','CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ANALYTICS_API_TOKEN','RANDORI_LOCAL_RUNTIME','TURN_MONTHLY_GB_BUDGET'];
const previous=Object.fromEntries(KEYS.map(key=>[key,process.env[key]]));
afterEach(()=>{
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

async function capabilities(){
  const res={statusCode:200,headers:{},body:null,
    status(code){ this.statusCode=code; return this; },
    setHeader(name,value){ this.headers[String(name).toLowerCase()]=value; },
    json(value){ this.body=value; return this; },end(){ return this; }};
  await authHandler({method:'GET',url:'/api/auth/capabilities',query:{endpoint:'capabilities'},
    headers:{host:'randori.example.test'},socket:{remoteAddress:'203.0.113.4'}},res);
  assert.equal(res.statusCode,200);
  return res.body.capabilities;
}

test('turnRelay is advertised only for the literal flag with a fully configured relay',async()=>{
  for(const key of KEYS) delete process.env[key];
  assert.equal('turnRelay' in await capabilities(),false);
  Object.assign(process.env,{CLOUDFLARE_TURN_KEY_ID:'0123456789abcdef0123456789abcdef',
    CLOUDFLARE_TURN_API_TOKEN:'cf-turn-api-token-0123456789abcdef',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),
    CLOUDFLARE_ANALYTICS_API_TOKEN:'cf-analytics-token-0123456789abcdef'});
  assert.equal('turnRelay' in await capabilities(),false,'configured but flag off');
  process.env.TURN_RELAY_ENABLED='True';
  assert.equal('turnRelay' in await capabilities(),false);
  process.env.TURN_RELAY_ENABLED='true';
  assert.equal((await capabilities()).turnRelay,true);
  process.env.TURN_MONTHLY_GB_BUDGET='invalid';
  assert.equal('turnRelay' in await capabilities(),false,'an invalid budget hides the capability');
  delete process.env.TURN_MONTHLY_GB_BUDGET;
  process.env.RANDORI_LOCAL_RUNTIME='true';
  assert.equal('turnRelay' in await capabilities(),false,'never in the local runtime');
});
