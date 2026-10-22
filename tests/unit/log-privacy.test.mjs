// ID-82 (issue #340): what an app_logs row may say about the client. The
// helpers never return a raw address or user agent: an address becomes a
// daily keyed hash of its network, a user agent a coarse family from a fixed
// vocabulary.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';

import { clientNetwork, rateLimitAddress } from '../../api/_client-address.js';
import {
  LOG_ADDRESS_HASH_PATTERN,
  appLogClientFields,
  logAddressHash,
  presentAppLogClient,
  userAgentFamily,
} from '../../api/_log-privacy.js';

const SECRET='unit-test-secret-at-least-thirty-two-characters';
const DAY='2026-10-21';
const SAVED=Object.freeze({JWT_SECRET:process.env.JWT_SECRET,LOG_ADDRESS_SECRET:process.env.LOG_ADDRESS_SECRET});

afterEach(()=>{
  for(const [key,value] of Object.entries(SAVED)){
    if(value===undefined) delete process.env[key];
    else process.env[key]=value;
  }
});

// Any IPv4 dotted quad, and any IPv6-looking run (two or more hex groups
// joined by colons, or a '::').
const RAW_IPV4=/\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const RAW_IPV6=/[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f:]*|::/i;
// The whole vocabulary a stored family can use, written out independently.
const FAMILY=/^(?:bot|other|(?:Edge|Opera|Samsung Internet|Firefox|Headless Chrome|Chrome|Safari|other)(?: \d{1,4})? on (?:iOS \d{1,2}|Android \d{1,2}|Windows(?: 10\/11| 8\.1| 8| 7)?|ChromeOS|macOS|Linux|other))$/;

function expectedHash(network,day=DAY,secret=SECRET){
  return `h1:${createHmac('sha256',secret).update(`randori-log-address-v1\0${day}\0${network}`,'utf8').digest('hex').slice(0,16)}`;
}

test('clientNetwork keeps an IPv4 address, collapses IPv4-mapped IPv6 and keys IPv6 by its /64',()=>{
  assert.equal(clientNetwork('203.0.113.9'),'203.0.113.9');
  assert.equal(clientNetwork(' 203.0.113.9 '),'203.0.113.9');
  assert.equal(clientNetwork('010.001.002.003'),'10.1.2.3');
  assert.equal(clientNetwork('::ffff:192.0.2.1'),'192.0.2.1');
  assert.equal(clientNetwork('::FFFF:c000:0201'),'192.0.2.1');
  assert.equal(clientNetwork('2001:db8:1:2:3:4:5:6'),'2001:0db8:0001:0002::/64');
  assert.equal(clientNetwork('[2001:DB8:1:2::9]'),'2001:0db8:0001:0002::/64');
  assert.equal(clientNetwork('fe80::1%en0'),'fe80:0000:0000:0000::/64');
  for(const value of [undefined,null,'','unknown','not-an-ip','256.1.1.1','1.2.3','1.2.3.4.5','203.0.113.9:443',
    '1::2::3','1:2:3:4:5:6:7','::ffff:999.0.0.1','12345::1','jane@example.test',42]){
    assert.equal(clientNetwork(value),null,String(value));
  }
  // Rate limits keep their identity: the network, or the bounded raw value
  // (which they only ever store as a keyed hash).
  assert.equal(rateLimitAddress('010.001.002.003'),'10.1.2.3');
  assert.equal(rateLimitAddress('garbage'),'garbage');
  assert.equal(rateLimitAddress(null),'unknown');
  assert.equal(rateLimitAddress('   '),'unknown');
});

test('logAddressHash is an HMAC of the network salted with the UTC day',()=>{
  const ipv4=logAddressHash('203.0.113.9',{day:DAY,secret:SECRET});
  assert.match(ipv4,LOG_ADDRESS_HASH_PATTERN);
  assert.equal(ipv4,expectedHash('203.0.113.9'));
  assert.equal(logAddressHash(' 203.0.113.9 ',{day:DAY,secret:SECRET}),ipv4);
  // IPv4-mapped IPv6 is the same client as its IPv4 address.
  assert.equal(logAddressHash('::ffff:203.0.113.9',{day:DAY,secret:SECRET}),ipv4);
  // IPv6 privacy addresses inside one /64 share a value; another /64 does not.
  const ipv6=logAddressHash('2001:db8:1:2::9',{day:DAY,secret:SECRET});
  assert.equal(ipv6,expectedHash('2001:0db8:0001:0002::/64'));
  assert.equal(logAddressHash('2001:db8:1:2:aaaa:bbbb:cccc:dddd',{day:DAY,secret:SECRET}),ipv6);
  assert.notEqual(logAddressHash('2001:db8:1:3::9',{day:DAY,secret:SECRET}),ipv6);
  // Without the secret, values differ from day to day (pseudonymous: whoever
  // holds the secret can recompute them for every address).
  assert.notEqual(logAddressHash('203.0.113.9',{day:'2026-10-22',secret:SECRET}),ipv4);
  assert.notEqual(logAddressHash('203.0.113.9',{day:DAY,secret:`${SECRET}-other`}),ipv4);
  assert.notEqual(logAddressHash('203.0.113.10',{day:DAY,secret:SECRET}),ipv4);
  // The day comes from a Date, a SQLite datetime or an ISO instant, in UTC.
  assert.equal(logAddressHash('203.0.113.9',{day:new Date(`${DAY}T23:59:59Z`),secret:SECRET}),ipv4);
  assert.equal(logAddressHash('203.0.113.9',{day:`${DAY} 08:00:00`,secret:SECRET}),ipv4);
  assert.equal(logAddressHash('203.0.113.9',{day:`${DAY}T08:00:00.000Z`,secret:SECRET}),ipv4);
  for(const value of [ipv4,ipv6]){
    assert.doesNotMatch(value,RAW_IPV4);
    assert.doesNotMatch(value.slice(3),RAW_IPV6);
  }
});

test('logAddressHash defaults to today and LOG_ADDRESS_SECRET or JWT_SECRET, and stores nothing it cannot hash',()=>{
  delete process.env.LOG_ADDRESS_SECRET;
  process.env.JWT_SECRET=SECRET;
  const today=new Date().toISOString().slice(0,10);
  assert.equal(logAddressHash('198.51.100.7'),expectedHash('198.51.100.7',today));
  // A dedicated key wins over JWT_SECRET, so either can rotate on its own.
  process.env.LOG_ADDRESS_SECRET='log-address-secret-of-its-own';
  assert.equal(logAddressHash('198.51.100.7'),expectedHash('198.51.100.7',today,'log-address-secret-of-its-own'));
  process.env.LOG_ADDRESS_SECRET='';
  assert.equal(logAddressHash('198.51.100.7'),expectedHash('198.51.100.7',today));
  // Writers only ever hash a real address: an existing hash is not passed through.
  const hashed=logAddressHash('198.51.100.7');
  assert.equal(logAddressHash(hashed),null);
  for(const value of [undefined,null,'','unknown','garbage','999.0.0.1','1::2::3','203.0.113.9:443',{},42]){
    assert.equal(logAddressHash(value),null,String(value));
  }
  assert.equal(logAddressHash('198.51.100.7',{day:'yesterday'}),null);
  assert.equal(logAddressHash('198.51.100.7',{day:new Date('nope')}),null);
  assert.equal(logAddressHash('198.51.100.7',{day:null}),null);
  assert.equal(logAddressHash('198.51.100.7',{secret:''}),null);
  assert.equal(logAddressHash('198.51.100.7',{secret:42}),null);
  delete process.env.JWT_SECRET;
  assert.equal(logAddressHash('198.51.100.7'),null);
  delete process.env.LOG_ADDRESS_SECRET;
  assert.equal(logAddressHash('198.51.100.7'),null);
});

const USER_AGENTS=Object.freeze([
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','Chrome 131 on Windows 10/11'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70','Edge 131 on Windows 10/11'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0','Opera 115 on Windows 10/11'],
  ['Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0','Firefox 115 on Windows 7'],
  ['Mozilla/5.0 (Windows NT 6.3; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0','Firefox 115 on Windows 8.1'],
  ['Mozilla/5.0 (Windows NT 6.2; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0','Firefox 115 on Windows 8'],
  ['Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.2623.112 Safari/537.36','Chrome 49 on Windows'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0','Firefox 132 on macOS'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15','Safari 17 on macOS'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1','Safari 17 on iOS 17'],
  ['Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1','Safari 16 on iOS 16'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1','Chrome 130 on iOS 18'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15','Firefox 131 on iOS 17'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/131.0.2903.68 Mobile/15E148 Safari/605.1.15','Edge 131 on iOS 17'],
  ['Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36','Chrome 131 on Android 14'],
  ['Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36','Samsung Internet 26 on Android 13'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','Chrome 131 on ChromeOS'],
  ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0','Firefox 132 on Linux'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.33 Safari/537.36','Headless Chrome 131 on Linux'],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)','bot'],
  ['Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)','bot'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)','bot'],
  ['Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36','Chrome 120 on Android 10'],
  ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com) AppleWebKit/537.36','bot'],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)','bot'],
  // Only an exact family passes through; anything appended is reduced.
  ['Chrome 131 on Windows 10/11; jane@example.test','other'],
  ['Chrome 131 on Linux\u0000x','other on Linux'],
  ['SomeApp/1.0 (Linux)','other on Linux'],
  ['SomeApp/1.0 Chrome/77','Chrome 77 on other'],
  ['curl/8.4.0','other'],
  ['randori-production-smoke/1','other'],
  ['jane@example.test <script>alert(1)</script> 203.0.113.9','other'],
  ['Chrome/1234567 (Windows NT 10.0)','other on Windows 10/11'],
]);

test('userAgentFamily reduces real user agents to browser and OS majors from a fixed vocabulary',()=>{
  for(const [agent,family] of USER_AGENTS){
    const reduced=userAgentFamily(agent);
    assert.equal(reduced,family,agent);
    assert.match(reduced,FAMILY,agent);
    assert.notEqual(reduced,agent);
    assert.doesNotMatch(reduced,RAW_IPV4);
    assert.doesNotMatch(reduced,/Mozilla|AppleWebKit|KHTML|Gecko|Build|Pixel|SM-|@|<|\d+\.\d+\.\d+/,agent);
    // A family passes through unchanged, so reducing twice is harmless.
    assert.equal(userAgentFamily(reduced),reduced);
  }
  for(const value of [undefined,null,'','   ',42,{},['Chrome/131']]){
    assert.equal(userAgentFamily(value),null,String(value));
  }
});

test('userAgentFamily stays cheap on adversarial input',()=>{
  const inputs=[
    `iPhone ${' '.repeat(100_000)}OS 17_`,
    `${'Chrome/'.repeat(20_000)}131`,
    `${'Version/1.'.repeat(20_000)} Safari/`,
    `${'bot'.repeat(50_000)}x`,
  ];
  const started=performance.now();
  for(const input of inputs) assert.match(userAgentFamily(input),FAMILY);
  assert.ok(performance.now()-started<250,'user-agent reduction must be bounded');
});

test('appLogClientFields reduces whatever the request or logger context carries',()=>{
  process.env.JWT_SECRET=SECRET;
  const chrome=USER_AGENTS[0][0];
  const firefox=USER_AGENTS[7][0];
  const hash=address=>logAddressHash(address);
  const forwarded={headers:{'x-forwarded-for':' 203.0.113.9 , 10.0.0.1','user-agent':chrome},socket:{remoteAddress:'127.0.0.1'}};
  const fields=appLogClientFields(forwarded);
  assert.deepEqual({...fields},{ua:'Chrome 131 on Windows 10/11',ip:hash('203.0.113.9')});
  assert.ok(Object.isFrozen(fields));
  // Logger contexts wrap the request, or carry headers, or name the values.
  assert.deepEqual({...appLogClientFields({req:forwarded,source:'server'})},{...fields});
  assert.deepEqual({...appLogClientFields({headers:forwarded.headers,req:{headers:{'user-agent':firefox}}})},{...fields});
  assert.deepEqual({...appLogClientFields({ip:'198.51.100.4',ua:firefox,req:forwarded})},
    {ua:'Firefox 132 on macOS',ip:hash('198.51.100.4')});
  // x-real-ip, then the socket, when there is no forwarded address.
  assert.equal(appLogClientFields({headers:{'x-real-ip':'2001:db8:9:9::1'}}).ip,hash('2001:db8:9:9::1'));
  assert.equal(appLogClientFields({headers:{'x-forwarded-for':''},socket:{remoteAddress:'::ffff:198.51.100.5'}}).ip,
    hash('198.51.100.5'));
  assert.deepEqual({...appLogClientFields({headers:{'x-forwarded-for':['203.0.113.9'],'user-agent':[chrome]}})},{...fields});
  // Nothing usable means nothing stored.
  for(const context of [undefined,null,{},{headers:{}},{headers:{'x-forwarded-for':'unknown','user-agent':''}}]){
    assert.deepEqual({...appLogClientFields(context)},{ua:null,ip:null});
  }
  const hostile={get req(){ throw new Error('broken request'); }};
  assert.deepEqual({...appLogClientFields(hostile)},{ua:null,ip:null});
  // A row that carries a user keeps no address: the account already says who it was.
  for(const userId of [7,'7',0]){
    assert.deepEqual({...appLogClientFields(forwarded,{userId})},{ua:'Chrome 131 on Windows 10/11',ip:null},String(userId));
  }
  for(const userId of [undefined,null,'']){
    assert.equal(appLogClientFields(forwarded,{userId}).ip,hash('203.0.113.9'),String(userId));
  }
  // A stored hash offered as an address is not an IP literal, so nothing is stored.
  assert.equal(appLogClientFields({ip:hash('203.0.113.9')}).ip,null);
});

test('presentAppLogClient shows rows from before ID-82 reduced, hashed with their own day',()=>{
  delete process.env.LOG_ADDRESS_SECRET;
  process.env.JWT_SECRET=SECRET;
  const legacy={ua:USER_AGENTS[14][0],ip:'203.0.113.9',created_at:'2026-10-01 10:00:00'};
  const shown=presentAppLogClient(legacy);
  assert.deepEqual({...shown},{ua:'Chrome 131 on Android 14',ip:expectedHash('203.0.113.9','2026-10-01')});
  assert.equal(shown.ip,logAddressHash('203.0.113.9',{day:'2026-10-01'}));
  // Rows written after ID-82 are already reduced and pass through unchanged.
  assert.deepEqual({...presentAppLogClient({...shown,created_at:'2026-10-21 10:00:00'})},{...shown});
  assert.deepEqual({...presentAppLogClient({ua:'',ip:'',created_at:'2026-10-01 10:00:00'})},{ua:null,ip:null});
  assert.deepEqual({...presentAppLogClient({ua:'agent',ip:'203.0.113.9',created_at:null})},
    {ua:'other',ip:logAddressHash('203.0.113.9')});
  assert.deepEqual({...presentAppLogClient(null)},{ua:null,ip:null});
  // Rows with a user show no address, old or new.
  assert.deepEqual({...presentAppLogClient({...legacy,user_id:2})},{ua:'Chrome 131 on Android 14',ip:null});
  assert.deepEqual({...presentAppLogClient({...shown,user_id:2})},{ua:'Chrome 131 on Android 14',ip:null});
  // Anything else in the column that is neither a hash nor an address shows nothing.
  assert.equal(presentAppLogClient({ip:'h1:not-a-hash',created_at:'2026-10-01 10:00:00'}).ip,null);
});
