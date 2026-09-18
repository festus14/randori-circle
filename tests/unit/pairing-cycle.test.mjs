import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  DEFAULT_PAIRING_TIME_ZONE,
  pairingCronIsDue,
  resolvePairingCycle,
} from '../../api/_pairing-cycle.js';

const originalPairingTimeZone=process.env.PAIRING_TIME_ZONE;
const originalProcessTimeZone=process.env.TZ;

afterEach(()=>{
  if(originalPairingTimeZone===undefined) delete process.env.PAIRING_TIME_ZONE;
  else process.env.PAIRING_TIME_ZONE=originalPairingTimeZone;
  if(originalProcessTimeZone===undefined) delete process.env.TZ;
  else process.env.TZ=originalProcessTimeZone;
});

test('the current London cycle changes exactly at Sunday 08:00 during BST',()=>{
  const before=resolvePairingCycle({now:'2026-09-20T06:59:59.999Z'});
  assert.deepEqual(before,{
    cycleId:'2026-W38',
    startsAt:'2026-09-13T07:00:00.000Z',
    endsAt:'2026-09-20T07:00:00.000Z',
    cutoffAt:'2026-09-13T07:00:00.000Z',
    timeZone:'Europe/London',
    state:'current',
  });

  for(const now of ['2026-09-20T07:00:00.000Z','2026-09-20T07:00:00.001Z']){
    assert.deepEqual(resolvePairingCycle({now}),{
      cycleId:'2026-W39',
      startsAt:'2026-09-20T07:00:00.000Z',
      endsAt:'2026-09-27T07:00:00.000Z',
      cutoffAt:'2026-09-20T07:00:00.000Z',
      timeZone:'Europe/London',
      state:'current',
    });
  }
});

test('spring DST changes the UTC boundary while preserving Sunday 08:00 London',()=>{
  const before=resolvePairingCycle({now:'2026-03-29T06:59:59.999Z'});
  assert.equal(before.cycleId,'2026-W13');
  assert.equal(before.startsAt,'2026-03-22T08:00:00.000Z');
  assert.equal(before.endsAt,'2026-03-29T07:00:00.000Z');

  const at=resolvePairingCycle({now:'2026-03-29T07:00:00.000Z'});
  assert.equal(at.cycleId,'2026-W14');
  assert.equal(at.startsAt,'2026-03-29T07:00:00.000Z');
  assert.equal(at.endsAt,'2026-04-05T07:00:00.000Z');
});

test('autumn DST changes the UTC boundary while preserving Sunday 08:00 London',()=>{
  const before=resolvePairingCycle({now:'2026-10-25T07:59:59.999Z'});
  assert.equal(before.cycleId,'2026-W43');
  assert.equal(before.startsAt,'2026-10-18T07:00:00.000Z');
  assert.equal(before.endsAt,'2026-10-25T08:00:00.000Z');

  const at=resolvePairingCycle({now:'2026-10-25T08:00:00.000Z'});
  assert.equal(at.cycleId,'2026-W44');
  assert.equal(at.startsAt,'2026-10-25T08:00:00.000Z');
  assert.equal(at.endsAt,'2026-11-01T08:00:00.000Z');
});

test('cycle identifiers follow the next Monday across the ISO year boundary',()=>{
  const lastCycle=resolvePairingCycle({now:'2027-01-03T07:59:59.999Z'});
  assert.equal(lastCycle.cycleId,'2026-W53');
  assert.equal(lastCycle.startsAt,'2026-12-27T08:00:00.000Z');
  assert.equal(lastCycle.endsAt,'2027-01-03T08:00:00.000Z');

  const firstCycle=resolvePairingCycle({now:'2027-01-03T08:00:00.000Z'});
  assert.equal(firstCycle.cycleId,'2027-W01');
  assert.equal(firstCycle.startsAt,'2027-01-03T08:00:00.000Z');
  assert.equal(firstCycle.endsAt,'2027-01-10T08:00:00.000Z');
});

test('upcoming cycles advance by a local calendar week rather than 168 fixed hours',()=>{
  const current=resolvePairingCycle({now:'2026-03-28T12:00:00.000Z'});
  const upcoming=resolvePairingCycle({now:'2026-03-28T12:00:00.000Z',state:'upcoming'});
  assert.equal(current.startsAt,'2026-03-22T08:00:00.000Z');
  assert.equal(upcoming.startsAt,'2026-03-29T07:00:00.000Z');
  assert.equal(upcoming.endsAt,'2026-04-05T07:00:00.000Z');
  assert.equal(upcoming.cycleId,'2026-W14');
  assert.equal(upcoming.cutoffAt,upcoming.startsAt);
  assert.equal(upcoming.state,'upcoming');
});

test('the Hobby-safe 08:00 UTC cron runs at or after the London boundary across DST',()=>{
  assert.equal(pairingCronIsDue({now:'2026-07-05T07:00:00.000Z'}),false,'the single configured cron does not run at 07:00Z');
  assert.equal(pairingCronIsDue({now:'2026-07-05T07:59:59.999Z'}),false);
  assert.equal(pairingCronIsDue({now:'2026-07-05T08:00:00.000Z'}),true,'08:00Z is 09:00 BST and still after the cutoff');
  assert.equal(pairingCronIsDue({now:'2026-07-05T08:59:59.999Z'}),true);

  assert.equal(pairingCronIsDue({now:'2026-12-06T07:00:00.000Z'}),false,'07:00Z is 07:00 GMT');
  assert.equal(pairingCronIsDue({now:'2026-12-06T08:00:00.000Z'}),true,'08:00Z is 08:00 GMT');
  assert.equal(pairingCronIsDue({now:'2026-12-06T08:59:59.999Z'}),true);
  assert.equal(pairingCronIsDue({now:'2026-12-06T09:00:00.000Z'}),false);
});

test('resolution is independent of the host timezone and honors a configured IANA zone',()=>{
  process.env.TZ='Pacific/Honolulu';
  const london=resolvePairingCycle({now:'2026-09-20T07:00:00.000Z'});
  process.env.TZ='Asia/Tokyo';
  assert.deepEqual(resolvePairingCycle({now:'2026-09-20T07:00:00.000Z'}),london);

  process.env.PAIRING_TIME_ZONE='America/New_York';
  const configured=resolvePairingCycle({now:'2026-09-20T12:00:00.000Z'});
  assert.equal(configured.timeZone,'America/New_York');
  assert.equal(configured.startsAt,'2026-09-20T12:00:00.000Z');
  assert.equal(DEFAULT_PAIRING_TIME_ZONE,'Europe/London');
});

test('invalid time, timezone, state, and option values fail closed',()=>{
  for(const options of [
    null,
    [],
    {now:'not-an-instant'},
    {timeZone:''},
    {timeZone:'Mars/Olympus'},
    {state:'previous'},
  ]){
    assert.throws(()=>resolvePairingCycle(options),TypeError);
  }
});
