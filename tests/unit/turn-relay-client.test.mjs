// Issue #305 (ID-107): the direct call asks for TURN credentials just before
// it creates its RTCPeerConnection and falls back to STUN-only on 404, 503,
// a bad response or a three-second timeout. The route is never contacted for
// real: fetch is an in-memory fake.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  TURN_ENDPOINT,
  TURN_FAILURE_RETRY_MS,
  TURN_OFF_RETRY_MS,
  TURN_REFRESH_MARGIN_MS,
  TURN_TIMEOUT_MS,
  createIceServerSource,
  relayServersFrom,
} from '../../assets/turn-relay.js';

const ROOM='week_10_pair_20';
const STUN=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const RELAY={urls:['turn:turn.cloudflare.com:3478?transport=udp','turns:turn.cloudflare.com:443?transport=tcp'],
  username:'user-0123',credential:'cred-abcdef'};

function relayPayload(nowMs,{ttlMs=60*60*1000,servers=[{urls:['stun:stun.cloudflare.com:3478']},RELAY]}={}){
  return {iceServers:servers,expiresAt:new Date(nowMs+ttlMs).toISOString()};
}

function harness(respond){
  let nowMs=Date.parse('2026-11-19T12:00:00Z');
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,init,body:JSON.parse(init.body)});
    return respond({url,init,nowMs,calls});
  };
  return {
    calls,
    now:()=>nowMs,
    advance(ms){ nowMs+=ms; },
    fetchImpl,
  };
}

const json=(status,value)=>({ok:status>=200&&status<300,status,json:async()=>value});

test('a returned relay is used together with the existing STUN servers',async()=>{
  const h=harness(({nowMs})=>json(200,relayPayload(nowMs)));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  const servers=await source.servers(ROOM);
  assert.deepEqual(servers,[...STUN,{urls:['stun:stun.cloudflare.com:3478']},RELAY]);
  assert.equal(h.calls.length,1);
  const [call]=h.calls;
  assert.equal(call.url,TURN_ENDPOINT);
  assert.equal(TURN_ENDPOINT,'/api/video/turn','same-origin route');
  assert.equal(call.init.method,'POST');
  assert.equal(call.init.credentials,'same-origin');
  assert.equal(call.init.cache,'no-store');
  assert.deepEqual(call.body,{room_id:ROOM});
  assert.ok(call.init.signal instanceof AbortSignal);
  // The pass is reused while fresh, and every caller gets its own copy.
  servers[0].urls='mutated';
  assert.deepEqual(await source.servers(ROOM),[...STUN,{urls:['stun:stun.cloudflare.com:3478']},RELAY]);
  assert.equal(h.calls.length,1);
});

test('an expired or nearly expired pass is fetched again before a reconnect',async()=>{
  const h=harness(({nowMs})=>json(200,relayPayload(nowMs,{ttlMs:5*60*1000})));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  await source.servers(ROOM);
  h.advance(5*60*1000-TURN_REFRESH_MARGIN_MS-1);
  await source.servers(ROOM);
  assert.equal(h.calls.length,1,'still fresh');
  h.advance(2);
  assert.equal((await source.servers(ROOM)).length,STUN.length+2);
  assert.equal(h.calls.length,2,'re-fetched inside the refresh margin');
  // A different room is a different authorization.
  await source.servers('week_10_pair_21');
  assert.equal(h.calls.length,3);
  assert.deepEqual(h.calls[2].body,{room_id:'week_10_pair_21'});
});

test('404 means the relay is off: STUN-only, and not asked again for ten minutes',async()=>{
  const h=harness(()=>json(404,{error:'call relay unavailable',code:'turn_relay_disabled'}));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  assert.deepEqual(await source.servers(ROOM),STUN);
  h.advance(TURN_OFF_RETRY_MS-1);
  assert.deepEqual(await source.servers(ROOM),STUN);
  assert.equal(h.calls.length,1);
  h.advance(1);
  await source.servers(ROOM);
  assert.equal(h.calls.length,2);
});

test('503, 429 and other failures are STUN-only with a short back-off',async()=>{
  for(const status of [503,429,500,401,409]){
    const h=harness(()=>json(status,{error:'call relay unavailable',code:'turn_relay_unavailable'}));
    const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
    assert.deepEqual(await source.servers(ROOM),STUN,String(status));
    h.advance(TURN_FAILURE_RETRY_MS-1);
    await source.servers(ROOM);
    assert.equal(h.calls.length,1);
    h.advance(1);
    await source.servers(ROOM);
    assert.equal(h.calls.length,2);
  }
  const thrown=harness(()=>{ throw new TypeError('network'); });
  assert.deepEqual(await createIceServerSource(STUN,{fetchImpl:thrown.fetchImpl,now:thrown.now}).servers(ROOM),STUN);
  const badJson=harness(()=>({ok:true,status:200,json:async()=>{ throw new SyntaxError('bad'); }}));
  assert.deepEqual(await createIceServerSource(STUN,{fetchImpl:badJson.fetchImpl,now:badJson.now}).servers(ROOM),STUN);
  const invalid=harness(({nowMs})=>json(200,relayPayload(nowMs,{servers:[{urls:'turn:relay.example.com',username:'u',credential:'c'}]})));
  const invalidSource=createIceServerSource(STUN,{fetchImpl:invalid.fetchImpl,now:invalid.now});
  assert.deepEqual(await invalidSource.servers(ROOM),STUN,'a non-Cloudflare relay is never used');
  await invalidSource.servers(ROOM);
  assert.equal(invalid.calls.length,1,'an invalid response backs off too');
});

test('a slow route times out within the deadline and the call proceeds STUN-only',async()=>{
  assert.equal(TURN_TIMEOUT_MS,3000);
  let aborted=false;
  const hung=(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>{ aborted=true; reject(new DOMException('aborted','AbortError')); });
  });
  const source=createIceServerSource(STUN,{fetchImpl:hung,timeoutMs:20});
  const started=Date.now();
  assert.deepEqual(await source.servers(ROOM),STUN);
  assert.ok(Date.now()-started<1000);
  assert.equal(aborted,true,'the request is aborted, not left running');
});

test('concurrent peers share one request, and clear() forgets everything',async()=>{
  let release,hold=true;
  const h=harness(({nowMs})=>hold
    ?new Promise(resolve=>{ release=()=>resolve(json(200,relayPayload(nowMs))); })
    :json(200,relayPayload(nowMs)));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  const first=source.servers(ROOM), second=source.servers(ROOM);
  await new Promise(resolve=>setImmediate(resolve));
  release();
  assert.deepEqual(await first,await second);
  assert.equal(h.calls.length,1);
  source.clear();
  hold=false;
  await source.servers(ROOM);
  assert.equal(h.calls.length,2,'sign-out forgets the pass');
  hold=true;
  // A clear() while a request is in flight keeps nothing from it.
  source.clear();
  const pending=source.servers('week_10_pair_21');
  await new Promise(resolve=>setImmediate(resolve));
  source.clear();
  release();
  assert.deepEqual(await pending,STUN);
  hold=false;
  await source.servers('week_10_pair_21');
  assert.equal(h.calls.length,4,'nothing was cached from the cleared request');
});

test('no room means no request',async()=>{
  const h=harness(()=>json(200,{}));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  for(const room of ['',null,undefined,42]) assert.deepEqual(await source.servers(room),STUN);
  assert.equal(h.calls.length,0);
});

test('the default fetch and clock are the browser globals',async()=>{
  const original=globalThis.fetch;
  const seen=[];
  globalThis.fetch=async(url,init)=>{ seen.push(url); return json(200,relayPayload(Date.now())); };
  try{
    const servers=await createIceServerSource(STUN).servers(ROOM);
    assert.equal(servers.length,STUN.length+2);
  }finally{ globalThis.fetch=original; }
  assert.deepEqual(seen,[TURN_ENDPOINT]);
});

test('the browser re-checks the route response',()=>{
  const nowMs=Date.parse('2026-11-19T12:00:00Z');
  assert.deepEqual(relayServersFrom(relayPayload(nowMs),nowMs),{
    servers:[{urls:['stun:stun.cloudflare.com:3478']},RELAY],expiresAtMs:nowMs+60*60*1000,
  });
  assert.deepEqual(relayServersFrom({iceServers:[{urls:'turn:cloudflare.com',username:'u',credential:'c'}],
    expiresAt:new Date(nowMs+1000).toISOString()},nowMs)?.servers,[{urls:['turn:cloudflare.com'],username:'u',credential:'c'}]);
  const future=new Date(nowMs+1000).toISOString();
  const turn=(urls,extra={})=>({iceServers:[{urls,username:'u',credential:'c',...extra}],expiresAt:future});
  for(const payload of [
    null,'x',{},{iceServers:{}},{iceServers:[],expiresAt:future},
    {iceServers:[RELAY]},{iceServers:[RELAY],expiresAt:'soon'},{iceServers:[RELAY],expiresAt:new Date(nowMs).toISOString()},
    {iceServers:Array.from({length:5},()=>RELAY),expiresAt:future},
    {iceServers:[{urls:'stun:stun.cloudflare.com'}],expiresAt:future},
    {iceServers:[{urls:'turn:turn.cloudflare.com'}],expiresAt:future},
    {iceServers:[null],expiresAt:future},{iceServers:[{urls:[]}],expiresAt:future},
    turn('turn:turn.example.com'),turn('turn:cloudflare.com.evil.test'),turn('http://turn.cloudflare.com'),
    turn('turn:turn.cloudflare.com?transport=sctp'),turn([`turn:${'a'.repeat(260)}.cloudflare.com`]),
    turn(Array.from({length:17},()=>'turn:turn.cloudflare.com')),turn([42]),
    turn('turn:turn.cloudflare.com',{credential:'x'.repeat(513)}),turn('turn:turn.cloudflare.com',{username:'has space'}),
    turn('turn:turn.cloudflare.com',{username:undefined}),
  ]) assert.equal(relayServersFrom(payload,nowMs),null,JSON.stringify(payload)?.slice(0,120));
  assert.ok(relayServersFrom(relayPayload(Date.now())),'default clock');
});

test('credentials stay in memory: the module never touches web storage or cookies',()=>{
  const source=readFileSync(new URL('../../assets/turn-relay.js',import.meta.url),'utf8')
    .split('\n').filter(line=>!/^\s*(?:\/\/|\*|\/\*\*)/.test(line)).join('\n');
  assert.doesNotMatch(source,/localStorage|sessionStorage|indexedDB|document\.cookie|caches\./);
});

test('index.html lazily asks for the relay just before each peer and keeps Google STUN as the base',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const start=html.indexOf('// ---------- live video (WebRTC + Turso signaling) ----------');
  const end=html.indexOf('// ---------- tabs ----------',start);
  const video=html.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.doesNotMatch(video,/turn:|metered|credential\s*:/,'no hard-coded relay or credential');
  assert.match(video,/const iceServers = \[\n(?:\s+\{ urls: 'stun:stun\d?\.l\.google\.com:19302' \},?\n){4}\s+\];/);
  assert.match(video,/import\('\/assets\/turn-relay\.js'\)\.then\(m=>m\.createIceServerSource\(iceServers\)\)/);
  assert.match(video,/setTimeout\(r,3e3,iceServers\)/,'the whole lookup, import included, is capped at three seconds');
  const createPeer=video.slice(video.indexOf('async function createPeer('),video.indexOf('async function joinVideo('));
  assert.match(createPeer,/const servers=await videoIceServers\(getVideoRoomId\(\)\);\n\s+if\(!videoSessionMatches\(expectedEpoch\)\) return null;\n\s+if\(pc\) closeVideoPeer\(pc\);\n\s+const peer = new RTCPeerConnection\(\{ iceServers:servers \}\);/);
  assert.equal((video.match(/new RTCPeerConnection/g)||[]).length,1);
  assert.match(video,/videoUpdateStatus\('joining '\+room\.slice\(0,6\)\);\n\s+videoIceServers\(room\);/,'prefetched on join');
  assert.match(video,/videoIce\?\.then\(s=>s\?\.clear\(\)\);\n\s+clearVideoSession\(\{releaseMedia:true\}\);/,'forgotten on sign-out');
});
