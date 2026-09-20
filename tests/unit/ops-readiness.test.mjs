import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureNotificationPreferencesReadiness } from '../../api/_ops-readiness.js';

const EXPECTED_PROBE='SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0';

function deferred(){
  let resolve,reject;
  const promise=new Promise((onResolve,onReject)=>{
    resolve=onResolve;
    reject=onReject;
  });
  return {promise,resolve,reject};
}

test('notification-preference readiness executes one exact read-only six-column projection',async()=>{
  const statements=[];
  const db={execute:async statement=>{
    statements.push(statement);
    return {rows:[]};
  }};

  assert.equal(await ensureNotificationPreferencesReadiness(db),true);
  assert.deepEqual(statements,[EXPECTED_PROBE]);
  assert.doesNotMatch(statements[0],/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu);
});

test('notification-preference readiness coalesces concurrent probes and caches only success per client',async()=>{
  const gate=deferred();
  let firstCalls=0;
  const first={execute:async statement=>{
    firstCalls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    await gate.promise;
    return {rows:[]};
  }};
  let secondCalls=0;
  const second={execute:async statement=>{
    secondCalls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    return {rows:[]};
  }};

  const one=ensureNotificationPreferencesReadiness(first);
  const two=ensureNotificationPreferencesReadiness(first);
  await Promise.resolve();
  assert.equal(firstCalls,1);
  gate.resolve();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);
  assert.equal(await ensureNotificationPreferencesReadiness(first),true);
  assert.equal(firstCalls,1,'a successful probe is cached for the concrete client');

  assert.equal(await ensureNotificationPreferencesReadiness(second),true);
  assert.equal(secondCalls,1,'another client has an independent readiness cache');
});

test('notification-preference readiness evicts a rejected probe so a transient failure can retry',async()=>{
  let calls=0;
  const transient=new Error('temporary database failure');
  const db={execute:async statement=>{
    calls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    if(calls===1) throw transient;
    return {rows:[]};
  }};

  await assert.rejects(ensureNotificationPreferencesReadiness(db),error=>error===transient);
  assert.equal(await ensureNotificationPreferencesReadiness(db),true);
  assert.equal(calls,2);
});

test('notification-preference readiness rejects invalid clients before probing',async()=>{
  await assert.rejects(ensureNotificationPreferencesReadiness(null),/database client is required/);
  await assert.rejects(ensureNotificationPreferencesReadiness({}),/database client is required/);
});
