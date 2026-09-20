import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import {
  assertPairingRecoveryAllowed,
  pairingPublicationState,
  PairingRecoveryError,
  parsePairingRecoveryRequest,
} from '../../api/_pairing-recovery.js';

const scope={kind:'circle',circleId:42};

function stateAt(now,{isOwner=false,publishedAt=null}={}){
  const cycle=resolvePairingCycle({now,timeZone:'Europe/London'});
  return pairingPublicationState({scope,cycle,observedAt:now,publishedAt,isOwner});
}

test('publication recovery uses a half-open 30-minute grace in GMT and BST',()=>{
  const gmtPending=stateAt('2026-01-11T08:29:59.999Z',{isOwner:true});
  assert.equal(gmtPending.state,'pending');
  assert.equal(gmtPending.scheduled_at,'2026-01-11T08:00:00.000Z');
  assert.equal(gmtPending.recovery_at,'2026-01-11T08:30:00.000Z');
  assert.equal(gmtPending.can_publish_now,false);

  const gmtOverdue=stateAt('2026-01-11T08:30:00.000Z',{isOwner:true});
  assert.equal(gmtOverdue.state,'overdue');
  assert.equal(gmtOverdue.can_publish_now,true);

  const bstPending=stateAt('2026-06-14T07:29:59.999Z',{isOwner:true});
  assert.equal(bstPending.state,'pending');
  assert.equal(bstPending.scheduled_at,'2026-06-14T07:00:00.000Z');
  assert.equal(bstPending.recovery_at,'2026-06-14T07:30:00.000Z');
  assert.equal(bstPending.can_publish_now,false);

  const bstOverdue=stateAt('2026-06-14T07:30:00.000Z',{isOwner:true});
  assert.equal(bstOverdue.state,'overdue');
  assert.equal(bstOverdue.can_publish_now,true);
});

test('DST transition Sundays derive recovery from the resolved local boundary',()=>{
  const spring=stateAt('2026-03-29T07:30:00.000Z',{isOwner:true});
  assert.equal(spring.scheduled_at,'2026-03-29T07:00:00.000Z');
  assert.equal(spring.recovery_at,'2026-03-29T07:30:00.000Z');
  assert.equal(spring.state,'overdue');

  const autumn=stateAt('2026-10-25T08:30:00.000Z',{isOwner:true});
  assert.equal(autumn.scheduled_at,'2026-10-25T08:00:00.000Z');
  assert.equal(autumn.recovery_at,'2026-10-25T08:30:00.000Z');
  assert.equal(autumn.state,'overdue');
});

test('members get truthful state without an owner capability',()=>{
  const member=stateAt('2026-06-14T07:31:00.000Z');
  assert.equal(member.state,'overdue');
  assert.equal(Object.hasOwn(member,'can_publish_now'),false);
  assert.match(member.cycle_key,/^[0-9a-f]{64}$/);
  assert.equal(member.published_at,null);
});

test('a durable publication wins over overdue time and normalizes SQLite timestamps',()=>{
  const published=stateAt('2026-06-14T09:00:00.000Z',{
    isOwner:true,publishedAt:'2026-06-14 07:12:34',
  });
  assert.equal(published.state,'published');
  assert.equal(published.can_publish_now,false);
  assert.equal(published.published_at,'2026-06-14T07:12:34.000Z');
});

test('recovery request accepts only the exact cycle key and fences time and cycle',()=>{
  const pending=stateAt('2026-06-14T07:29:59.999Z',{isOwner:true});
  const overdue=stateAt('2026-06-14T07:30:00.000Z',{isOwner:true});
  const request=parsePairingRecoveryRequest({expected_cycle_key:overdue.cycle_key});
  assert.equal(request.expectedCycleKey,overdue.cycle_key);
  assert.equal(assertPairingRecoveryAllowed(overdue,request.expectedCycleKey),overdue);

  assert.throws(
    ()=>assertPairingRecoveryAllowed(pending,pending.cycle_key),
    error=>error instanceof PairingRecoveryError&&error.code==='PAIRING_RECOVERY_NOT_READY'
      &&error.publicationState===pending,
  );
  assert.throws(
    ()=>assertPairingRecoveryAllowed(overdue,'0'.repeat(64)),
    error=>error instanceof PairingRecoveryError&&error.code==='PAIRING_RECOVERY_CYCLE_CHANGED'
      &&error.publicationState===overdue,
  );
  for(const body of [{},null,[],{expected_cycle_key:'bad'},{expected_cycle_key:overdue.cycle_key,force:true}]){
    assert.throws(()=>parsePairingRecoveryRequest(body),PairingRecoveryError);
  }
});
