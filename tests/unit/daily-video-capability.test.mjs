// Issue #463 (ID-98): the embedded-video capability is advertised only when
// the flag and provider configuration are valid, and the page security
// headers delegate camera/microphone to exactly the Daily frame origin.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import authHandler from '../../api/auth.js';
import { DAILY_FRAME_ORIGIN } from '../../api/_daily-video.js';
import { securityHeaderIsSafe } from '../../scripts/check-deployability.mjs';

const KEYS=['DAILY_MONTHLY_MINUTE_BUDGET','DAILY_VIDEO_ENABLED','DAILY_API_KEY','DAILY_DOMAIN','RANDORI_LOCAL_RUNTIME'];
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

test('embeddedVideo is advertised only for the literal flag with a valid key and domain',async()=>{
  for(const key of KEYS) delete process.env[key];
  assert.equal('embeddedVideo' in await capabilities(),false);
  Object.assign(process.env,{DAILY_API_KEY:'daily-test-api-key-0123456789abcdef',DAILY_DOMAIN:'randori-circle.daily.co'});
  assert.equal('embeddedVideo' in await capabilities(),false,'configured but flag off');
  process.env.DAILY_VIDEO_ENABLED='True';
  assert.equal('embeddedVideo' in await capabilities(),false);
  process.env.DAILY_VIDEO_ENABLED='true';
  assert.equal((await capabilities()).embeddedVideo,true);
  for(const invalid of ['','0','-1','invalid']){
    process.env.DAILY_MONTHLY_MINUTE_BUDGET=invalid;
    assert.equal('embeddedVideo' in await capabilities(),false,'invalid budget hides capability');
  }
  process.env.DAILY_MONTHLY_MINUTE_BUDGET='60';
  assert.equal((await capabilities()).embeddedVideo,true);
  delete process.env.DAILY_MONTHLY_MINUTE_BUDGET;
  process.env.DAILY_API_KEY='';
  assert.equal('embeddedVideo' in await capabilities(),false,'missing key');
  process.env.DAILY_API_KEY='daily-test-api-key-0123456789abcdef';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  assert.equal('embeddedVideo' in await capabilities(),false,'never in the local runtime');
  delete process.env.RANDORI_LOCAL_RUNTIME;
  const serialized=JSON.stringify(await capabilities());
  assert.equal(serialized.includes('daily-test-api-key'),false,'the key never reaches the browser');
});

test('page headers allow framing and media delegation for exactly the Daily origin',()=>{
  const vercel=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
  const page=vercel.headers.find(route=>route.source==='/(.*)').headers;
  const header=name=>page.find(item=>item.key===name).value;
  const csp=header('Content-Security-Policy');
  const frameSrc=csp.split(';').map(part=>part.trim()).filter(part=>part.startsWith('frame-src '));
  assert.deepEqual(frameSrc,[`frame-src 'self' ${DAILY_FRAME_ORIGIN}`]);
  assert.match(csp,/frame-ancestors 'none'/);
  assert.doesNotMatch(csp.match(/script-src[^;]*/)[0],/daily/,'no Daily script is loaded into the app origin');
  assert.doesNotMatch(csp.match(/connect-src[^;]*/)[0],/daily/,'the browser never calls the Daily API');
  const permissions=header('Permissions-Policy');
  assert.equal(permissions,`camera=(self "${DAILY_FRAME_ORIGIN}"), microphone=(self "${DAILY_FRAME_ORIGIN}"), geolocation=()`);
  assert.equal(securityHeaderIsSafe('content-security-policy',csp),true);
  assert.equal(securityHeaderIsSafe('permissions-policy',permissions),true);
  assert.ok(vercel.rewrites.some(rewrite=>rewrite.source==='/api/video/room'&&rewrite.destination==='/api/video?endpoint=room'));
});
