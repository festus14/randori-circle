// ID-82 (issue #340): every app_logs writer reachable from a request stores
// a daily keyed address hash and a coarse user-agent family, never the raw
// values, and the admin logs API shows rows from before the change reduced
// too. Real handlers against a fully migrated SQLite database; only
// api/_db.js is replaced, to inject the client and a header-driven identity.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const SECRET='unit-test-secret-at-least-thirty-two-characters';
const directory=mkdtempSync(join(tmpdir(),'randori-log-privacy-'));
const realDb=createClient({url:`file:${join(directory,'logs.sqlite')}`});
let clientOverride=null;

const IDENTITIES={
  admin:{id:1,email:'admin@example.test'},
  member:{id:2,email:'member@example.test'},
};

function authFor(req){
  const identity=IDENTITIES[req?.headers?.['x-test-auth']];
  return identity?{...identity,sessionHash:'a'.repeat(64)}:null;
}

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>clientOverride||realDb,
    getJwtSecret:()=>SECRET,
    getCronSecret:()=>{ throw new Error('Missing CRON_SECRET'); },
    getAdminEmails:()=>new Set(),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W43',
    shuffleArray:values=>[...values],
    verifyRequestAuth:authFor,
    verifySignedRequestAuth:authFor,
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const [{default:dataHandler},{default:opsHandler},privacy]=await Promise.all([
  import('../../api/data.js'),
  import('../../api/ops.js'),
  import('../../api/_log-privacy.js'),
]);

function invoke(handler,{method='GET',url='/',headers={},body,auth,remoteAddress='127.0.0.1'}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(){},
      getHeader(){},
      end(payload){ finish(payload); },
    };
    const request={method,url,query:{},headers:{...headers,...(auth?{'x-test-auth':auth}:{})},body,socket:{remoteAddress}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

const CHROME='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI_IOS='Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1';
const ANDROID='Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.39 Mobile Safari/537.36';
const FIREFOX='Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const RAW_ADDRESSES=['203.0.113.77','2001:db8:77:1::9','2001:0db8:0077:0001','::ffff:198.51.100.23','198.51.100.23','192.0.2.44'];
const RAW_AGENTS=[CHROME,SAFARI_IOS,ANDROID,FIREFOX];
// Any dotted quad, or a run of colon-joined hex groups as an IPv6 address has.
const RAW_IPV4=/\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const RAW_IPV6=/\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i;
const FAMILY=/^(?:bot|other|(?:Edge|Opera|Samsung Internet|Firefox|Headless Chrome|Chrome|Safari|other)(?: \d{1,4})? on (?:iOS \d{1,2}|Android \d{1,2}|Windows(?: 10\/11| 8\.1| 8| 7)?|ChromeOS|macOS|Linux|other))$/;

/** Asserts that no stored or returned value holds a raw address or user agent. */
function assertNoRawClient(rows,label){
  for(const row of rows){
    const text=JSON.stringify(row);
    for(const raw of [...RAW_ADDRESSES,...RAW_AGENTS]) assert.ok(!text.includes(raw),`${label}: ${raw} in ${text}`);
    assert.ok(!/Mozilla\/5\.0|AppleWebKit|Gecko\//.test(text),`${label}: full user agent in ${text}`);
    if(row.ip!==null) assert.match(String(row.ip),privacy.LOG_ADDRESS_HASH_PATTERN,label);
    if(row.ua!==null) assert.match(String(row.ua),FAMILY,label);
    assert.doesNotMatch(String(row.ip??''),RAW_IPV4,label);
    assert.doesNotMatch(String(row.ip??''),RAW_IPV6,label);
    assert.doesNotMatch(String(row.ua??''),RAW_IPV4,label);
  }
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const state=await inspectMigrationState(realDb);
  await applyMigrations(realDb,{expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  for(const [id,email,isAdmin] of [[1,'admin@example.test',1],[2,'member@example.test',0]]){
    await realDb.execute({
      sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
        VALUES (?,?,?,?,?,1,?,0)`,
      args:[id,email,'hash',`User ${id}`,'#abcdef',isAdmin],
    });
  }
});

after(()=>{
  try{ realDb.close(); }catch{}
  rmSync(directory,{recursive:true,force:true});
});

const savedSecret=process.env.JWT_SECRET;
beforeEach(()=>{
  clientOverride=null;
  process.env.JWT_SECRET=SECRET;
});
after(()=>{
  if(savedSecret===undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET=savedSecret;
});

test('client, server and ops log rows store a daily address hash and a coarse user-agent family only', async ()=>{
  await realDb.execute('DELETE FROM app_logs');
  const logs={url:'/api/data/logs',method:'POST',auth:'member'};
  // Client rows: forwarded IPv4, IPv6 through x-real-ip, IPv4-mapped IPv6,
  // and an entry that names its own (full) user agent.
  assert.equal((await invoke(dataHandler,{...logs,headers:{'x-forwarded-for':'203.0.113.77, 10.0.0.1','user-agent':CHROME},
    body:{level:'error',event:'js_exception',message:'client v4'}})).body.inserted,1);
  assert.equal((await invoke(dataHandler,{...logs,headers:{'x-real-ip':'2001:db8:77:1::9','user-agent':SAFARI_IOS},
    body:{level:'warn',event:'js_exception',message:'client v6'}})).body.inserted,1);
  assert.equal((await invoke(dataHandler,{...logs,headers:{'x-forwarded-for':'::ffff:198.51.100.23'},
    body:{logs:[{level:'error',message:'client mapped',ua:ANDROID}]}})).body.inserted,1);
  // A server row from data.js (the top-level failure log).
  clientOverride={
    execute(statement){
      const sql=typeof statement==='string'?statement:statement.sql;
      return /SELECT id,email,display_name,color,created_at,last_login/.test(sql)
        ?Promise.reject(new Error('disk I/O error'))
        :realDb.execute(statement);
    },
    batch:(...args)=>realDb.batch(...args),
    transaction:(...args)=>realDb.transaction(...args),
  };
  const failed=await invoke(dataHandler,{url:'/api/data/profile',auth:'member',headers:{'x-forwarded-for':'192.0.2.44','user-agent':FIREFOX}});
  assert.equal(failed.status,500);
  clientOverride=null;
  // A server row from api/ops.js.
  const prefs=await invoke(opsHandler,{url:'/api/ops?endpoint=notifications-prefs',method:'POST',auth:'member',
    headers:{'x-forwarded-for':'2001:db8:77:1:aaaa::1','user-agent':ANDROID},body:{email_enabled:true}});
  assert.equal(prefs.status,200);

  const rows=(await realDb.execute(`SELECT * FROM app_logs ORDER BY id`)).rows.map(row=>({...row}));
  const byMessage=Object.fromEntries(rows.map(row=>[row.event==='notif_prefs_updated'?'ops':row.event==='api_unhandled'?'server':row.message,row]));
  const hash=address=>privacy.logAddressHash(address);
  assert.deepEqual([byMessage['client v4'].ua,byMessage['client v4'].ip],['Chrome 131 on Windows 10/11',hash('203.0.113.77')]);
  assert.deepEqual([byMessage['client v6'].ua,byMessage['client v6'].ip],['Safari 17 on iOS 17',hash('2001:db8:77:1::9')]);
  assert.deepEqual([byMessage['client mapped'].ua,byMessage['client mapped'].ip],['Chrome 131 on Android 14',hash('198.51.100.23')]);
  assert.deepEqual([byMessage.server.ua,byMessage.server.ip],['Firefox 132 on Linux',hash('192.0.2.44')]);
  // Same /64 as the IPv6 client row on the same day: the same source.
  assert.deepEqual([byMessage.ops.ua,byMessage.ops.ip],['Chrome 131 on Android 14',byMessage['client v6'].ip]);
  assert.equal(rows.length,5);
  assertNoRawClient(rows,'stored');

  // Without a secret nothing about the address is stored at all.
  delete process.env.JWT_SECRET;
  assert.equal((await invoke(dataHandler,{...logs,headers:{'x-forwarded-for':'203.0.113.77','user-agent':CHROME},
    body:{level:'error',message:'no secret'}})).body.inserted,1);
  const unkeyed=(await realDb.execute(`SELECT ua,ip FROM app_logs WHERE message='no secret'`)).rows[0];
  assert.deepEqual({...unkeyed},{ua:'Chrome 131 on Windows 10/11',ip:null});
});

test('the admin logs API returns reduced values, including for rows written before ID-82', async ()=>{
  await realDb.execute('DELETE FROM app_logs');
  // Rows as the old code wrote them, still inside the 30-day retention.
  for(const [message,ua,ip,day] of [
    ['legacy v4',CHROME,'203.0.113.77','2026-10-01 09:00:00'],
    ['legacy v6',SAFARI_IOS,'2001:db8:77:1::9','2026-10-02 09:00:00'],
    ['legacy empty','','','2026-10-03 09:00:00'],
  ]){
    await realDb.execute({
      sql:`INSERT INTO app_logs (level,source,event,message,meta_json,user_id,route,ua,ip,created_at) VALUES ('error','client','js_exception',?,NULL,2,'/',?,?,?)`,
      args:[message,ua,ip,day],
    });
  }
  assert.equal((await invoke(dataHandler,{url:'/api/data/logs',method:'POST',auth:'member',
    headers:{'x-forwarded-for':'203.0.113.77','user-agent':CHROME},body:{level:'error',message:'current'}})).body.inserted,1);

  assert.equal((await invoke(dataHandler,{url:'/api/data/logs'})).status,401);
  assert.equal((await invoke(dataHandler,{url:'/api/data/logs',auth:'member'})).status,403);
  const read=await invoke(dataHandler,{url:'/api/data/logs?limit=10',auth:'admin'});
  assert.equal(read.status,200);
  assert.equal(read.body.count,4);
  const byMessage=Object.fromEntries(read.body.logs.map(log=>[log.message,log]));
  assert.deepEqual(Object.keys(read.body.logs[0]).sort(),
    ['created_at','event','id','ip','level','message','meta','meta_json','route','source','ua','user_id']);
  assert.deepEqual([byMessage['legacy v4'].ua,byMessage['legacy v4'].ip],
    ['Chrome 131 on Windows 10/11',privacy.logAddressHash('203.0.113.77',{day:'2026-10-01'})]);
  assert.deepEqual([byMessage['legacy v6'].ua,byMessage['legacy v6'].ip],
    ['Safari 17 on iOS 17',privacy.logAddressHash('2001:db8:77:1::9',{day:'2026-10-02'})]);
  assert.deepEqual([byMessage['legacy empty'].ua,byMessage['legacy empty'].ip],[null,null]);
  // A current row is returned exactly as stored.
  const stored=(await realDb.execute(`SELECT ua,ip FROM app_logs WHERE message='current'`)).rows[0];
  assert.deepEqual([byMessage.current.ua,byMessage.current.ip],[stored.ua,stored.ip]);
  assert.deepEqual([stored.ua,stored.ip],['Chrome 131 on Windows 10/11',privacy.logAddressHash('203.0.113.77')]);
  assertNoRawClient(read.body.logs,'returned');
});
