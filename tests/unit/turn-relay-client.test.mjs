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
  TURN_PAUSED_RETRY_MS,
  TURN_REFRESH_MARGIN_MS,
  TURN_TIMEOUT_MS,
  createIceServerSource,
  relayServersFrom,
} from '../../assets/turn-relay.js';

const ROOM='week_10_pair_20';
const STUN=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
const RELAY={urls:['turn:turn.cloudflare.com:3478?transport=udp','turns:turn.cloudflare.com:443?transport=tcp'],
  username:'user-0123',credential:'cred-abcdef'};

function relayPayload(nowMs,{ttlMs=60*60*1000,servers=[{urls:['stun:stun.cloudflare.com:3478']},RELAY],relay='cloudflare'}={}){
  return {iceServers:servers,expiresAt:new Date(nowMs+ttlMs).toISOString(),relay};
}
const METERED=[{urls:'stun:stun.relay.metered.ca:80'},
  {urls:'turn:global.relay.metered.ca:80',username:'m-user',credential:'m-cred'},
  {urls:'turns:global.relay.metered.ca:443?transport=tcp',username:'m-user',credential:'m-cred'}];

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

test('the Metered backup is used on its own hosts only',async()=>{
  const h=harness(({nowMs})=>json(200,relayPayload(nowMs,{servers:METERED,relay:'metered'})));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  assert.deepEqual(await source.servers(ROOM),[...STUN,{urls:['stun:stun.relay.metered.ca:80']},
    {urls:['turn:global.relay.metered.ca:80'],username:'m-user',credential:'m-cred'},
    {urls:['turns:global.relay.metered.ca:443?transport=tcp'],username:'m-user',credential:'m-cred'}]);
  const nowMs=Date.now();
  assert.equal(relayServersFrom(relayPayload(nowMs,{servers:METERED,relay:'cloudflare'}),nowMs),null,'a relay label must match its hosts');
  assert.equal(relayServersFrom(relayPayload(nowMs,{relay:'metered'}),nowMs),null);
  const {relay:_omitted,...unlabelled}=relayPayload(nowMs);
  assert.equal(relayServersFrom(unlabelled,nowMs),null,'an unlabelled relay is ignored');
  for(const relay of [null,'none','other','__proto__','constructor']){
    assert.equal(relayServersFrom(relayPayload(nowMs,{relay}),nowMs),null,String(relay));
  }
});

test('relay none (every free allowance used up) is STUN-only, checked again in five minutes',async()=>{
  const h=harness(()=>json(200,{iceServers:[],expiresAt:null,relay:'none',reason:'budget_reached'}));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  assert.deepEqual(await source.servers(ROOM),STUN);
  h.advance(TURN_PAUSED_RETRY_MS-1);
  await source.servers(ROOM);
  assert.equal(h.calls.length,1);
  h.advance(1);
  await source.servers(ROOM);
  assert.equal(h.calls.length,2);
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
    servers:[{urls:['stun:stun.cloudflare.com:3478']},RELAY],expiresAtMs:nowMs+60*60*1000,relay:'cloudflare',
  });
  assert.deepEqual(relayServersFrom({iceServers:[{urls:'turn:cloudflare.com',username:'u',credential:'c'}],
    expiresAt:new Date(nowMs+1000).toISOString(),relay:'cloudflare'},nowMs)?.servers,[{urls:['turn:cloudflare.com'],username:'u',credential:'c'}]);
  const future=new Date(nowMs+1000).toISOString();
  const relay='cloudflare';
  const turn=(urls,extra={})=>({iceServers:[{urls,username:'u',credential:'c',...extra}],expiresAt:future,relay});
  for(const payload of [
    null,'x',{},{iceServers:{}},{iceServers:[],expiresAt:future,relay},
    {iceServers:[RELAY],relay},{iceServers:[RELAY],expiresAt:'soon',relay},{iceServers:[RELAY],expiresAt:new Date(nowMs).toISOString(),relay},
    {iceServers:Array.from({length:9},()=>RELAY),expiresAt:future,relay},
    {iceServers:[{urls:'stun:stun.cloudflare.com'}],expiresAt:future,relay},
    {iceServers:[{urls:'turn:turn.cloudflare.com'}],expiresAt:future,relay},
    {iceServers:[null],expiresAt:future,relay},{iceServers:[{urls:[]}],expiresAt:future,relay},
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

test('peek answers synchronously whenever it can, and create claims the peer slot at once then',async()=>{
  let release;
  const h=harness(({nowMs})=>new Promise(resolve=>{ release=()=>resolve(json(200,relayPayload(nowMs))); }));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  for(const room of ['',null]) assert.deepEqual(source.peek(room),STUN,'no room is an immediate STUN answer');
  const made=[];
  const make=servers=>{ made.push(servers); return Promise.resolve(`peer-${made.length}`); };
  // While the relay answer is pending, every caller of the same epoch shares one creation.
  const first=source.create(ROOM,1,make), second=source.create(ROOM,1,make), third=source.create(ROOM,1,make);
  assert.ok(first instanceof Promise);
  assert.equal(made.length,0,'nothing is created before the relay answers');
  assert.equal(second,first); assert.equal(third,first);
  assert.equal(h.calls.length,1,'one request');
  await new Promise(resolve=>setImmediate(resolve));
  release();
  assert.equal(await first,'peer-1');
  assert.equal(made.length,1,'exactly one peer');
  assert.deepEqual(made[0],[...STUN,{urls:['stun:stun.cloudflare.com:3478']},RELAY]);
  // With a fresh answer, create is synchronous: make runs before create returns.
  const sync=source.create(ROOM,2,make);
  assert.equal(made.length,2,'synchronous, exactly like the old path');
  assert.equal(await sync,'peer-2');
  assert.ok(Array.isArray(source.peek(ROOM)));
  // A new epoch never reuses an older pending creation.
  h.advance(2*60*60*1000);
  const stale=source.create(ROOM,3,make);
  const fresh=source.create(ROOM,4,make);
  assert.notEqual(stale,fresh);
  await new Promise(resolve=>setImmediate(resolve));
  release();
  await Promise.all([stale,fresh]);
  assert.equal(made.length,4);
  // clear() drops a pending creation's slot.
  source.clear();
  h.advance(2*60*60*1000);
  const pendingBeforeClear=source.create(ROOM,5,make);
  source.clear();
  assert.notEqual(source.create(ROOM,5,make),pendingBeforeClear,'a cleared slot is not shared');
});

test('flag off or a 404 keeps create synchronous with STUN only',async()=>{
  const h=harness(()=>json(404,{code:'turn_relay_disabled'}));
  const source=createIceServerSource(STUN,{fetchImpl:h.fetchImpl,now:h.now});
  assert.deepEqual(await source.peek(ROOM),STUN);
  const made=[];
  source.create(ROOM,1,servers=>made.push(servers));
  assert.deepEqual(made,[STUN],'synchronous after the 404 is known');
  assert.equal(h.calls.length,1);
});

test('a fetch that ignores its abort signal still cannot hold the call past the deadline',async()=>{
  const source=createIceServerSource(STUN,{fetchImpl:()=>new Promise(()=>{}),timeoutMs:20});
  const made=[];
  const started=Date.now();
  await source.create(ROOM,1,servers=>made.push(servers));
  assert.ok(Date.now()-started<1000);
  assert.deepEqual(made,[STUN]);
  assert.deepEqual(source.peek(ROOM),STUN,'and backs off afterwards');
});

test('index.html asks for the relay only when advertised and keeps peer creation synchronous otherwise',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const start=html.indexOf('// ---------- live video (WebRTC + Turso signaling) ----------');
  const end=html.indexOf('// ---------- tabs ----------',start);
  const video=html.slice(start,end);
  assert.ok(start>0&&end>start);
  assert.doesNotMatch(video,/turn:|metered|credential\s*:/,'no hard-coded relay or credential');
  assert.match(video,/const iceServers = \[\n(?:\s+\{ urls: 'stun:stun\d?\.l\.google\.com:19302' \},?\n){4}\s+\];/);
  assert.match(video,/if\(window\._randori_auth\?\.capabilities\?\.turnRelay===true\) \(iceLoad\?\?=import\('\/assets\/turn-relay\.js'\)\.then\(m=>iceSrc=m\.createIceServerSource\(iceServers\)\)/,
    'the module loads only when the server advertises the relay');
  assert.doesNotMatch(video,/3e3|setTimeout\(r,/,'the deadline lives in the module (TURN_TIMEOUT_MS)');
  assert.match(video,/function createPeer\(i,e=videoSessionEpoch\)\{\n\s+return iceSrc\?iceSrc\.create\(getVideoRoomId\(\),e,v=>makePeer\(i,e,v\)\):makePeer\(i,e,iceServers\);\n\s+\}/,
    'without the relay module, creation is the old synchronous path');
  const makePeer=video.slice(video.indexOf('async function makePeer('),video.indexOf('async function joinVideo('));
  assert.match(makePeer,/^async function makePeer\(isInitiator,expectedEpoch,servers\)\{\n\s+if\(!videoSessionMatches\(expectedEpoch\)\) return null;\n\s+if\(pc\) closeVideoPeer\(pc\);\n\s+const peer = new RTCPeerConnection\(\{ iceServers:servers \}\);\n\s+pc=peer;/,
    'no await between the slot check and pc=peer');
  assert.equal((video.match(/new RTCPeerConnection/g)||[]).length,1);
  assert.match(video,/const joinEpoch=\+\+videoSessionEpoch;\n\s+videoIceWarm\(room\);/,'warmed as soon as the member joins');
  assert.match(video,/videoIceWarm\(getVideoRoomId\(\)\);\n\s+sendSignal\('join',\{peer:webrtcPeerId\},''\);/,'and on a room switch');
  assert.match(video,/iceSrc\?\.clear\(\);\n\s+clearVideoSession\(\{releaseMedia:true\}\);/,'forgotten on sign-out');
  assert.match(html,/turnRelay:capabilities\.turnRelay===true,/,'the capability is parsed');
});
