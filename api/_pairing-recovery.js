import { availabilityCycleKey } from './_availability.js';

export const PAIRING_RECOVERY_GRACE_MS=30*60*1000;
export const PAIRING_CYCLE_KEY_PATTERN=/^[0-9a-f]{64}$/;

export class PairingRecoveryError extends Error{
  constructor(code,message,{publicationState}={}){
    super(message);
    this.name='PairingRecoveryError';
    this.code=code;
    if(publicationState) this.publicationState=publicationState;
  }
}

function instant(value,name,{nullable=false}={}){
  if(nullable&&(value===null||value===undefined||value==='')) return null;
  let normalized=value;
  if(typeof normalized==='string'){
    const sqlite=normalized.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/);
    if(sqlite) normalized=`${sqlite[1]}T${sqlite[2]}.${String(sqlite[3]||'0').padEnd(3,'0')}Z`;
  }
  const parsed=normalized instanceof Date?new Date(normalized.getTime()):new Date(normalized);
  if(!Number.isFinite(parsed.getTime())){
    throw new PairingRecoveryError('PAIRING_RECOVERY_INPUT_INVALID',`${name} must be a valid instant.`);
  }
  return parsed;
}

function recoveryInstant(cycle){
  const scheduled=instant(cycle?.cutoffAt,'cycle.cutoffAt');
  return new Date(scheduled.getTime()+PAIRING_RECOVERY_GRACE_MS);
}

/**
 * Project the only client-visible publication states from one observed instant.
 * The cycle key includes tenant scope and all configured boundary fields.
 */
export function pairingPublicationState({scope,cycle,observedAt,publishedAt=null,isOwner=false}={}){
  if(typeof isOwner!=='boolean'){
    throw new PairingRecoveryError('PAIRING_RECOVERY_INPUT_INVALID','isOwner must be a boolean.');
  }
  let cycleKey;
  try{ cycleKey=availabilityCycleKey(scope,cycle); }
  catch{
    throw new PairingRecoveryError('PAIRING_RECOVERY_INPUT_INVALID','Pairing recovery scope or cycle is invalid.');
  }
  const observed=instant(observedAt,'observedAt');
  const scheduled=instant(cycle.cutoffAt,'cycle.cutoffAt');
  const recovery=recoveryInstant(cycle);
  const published=instant(publishedAt,'publishedAt',{nullable:true});
  const state=published?'published':observed.getTime()>=recovery.getTime()?'overdue':'pending';
  return Object.freeze({
    state,
    cycle_key:cycleKey,
    observed_at:observed.toISOString(),
    scheduled_at:scheduled.toISOString(),
    recovery_at:recovery.toISOString(),
    published_at:published?.toISOString()||null,
    ...(isOwner?{can_publish_now:state==='overdue'}:{}),
  });
}

export function parsePairingRecoveryRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body)
    ||Object.keys(body).length!==1
    ||typeof body.expected_cycle_key!=='string'
    ||!PAIRING_CYCLE_KEY_PATTERN.test(body.expected_cycle_key)){
    throw new PairingRecoveryError(
      'PAIRING_RECOVERY_INPUT_INVALID',
      'request body must contain only a valid expected_cycle_key',
    );
  }
  return Object.freeze({expectedCycleKey:body.expected_cycle_key});
}

/** Fence an owner recovery mutation against the transaction-time cycle. */
export function assertPairingRecoveryAllowed(publicationState,expectedCycleKey){
  if(!PAIRING_CYCLE_KEY_PATTERN.test(String(expectedCycleKey||''))){
    throw new PairingRecoveryError('PAIRING_RECOVERY_INPUT_INVALID','expected_cycle_key is invalid.');
  }
  if(publicationState?.cycle_key!==expectedCycleKey){
    throw new PairingRecoveryError(
      'PAIRING_RECOVERY_CYCLE_CHANGED',
      'The pairing cycle changed. Refresh before publishing.',
      {publicationState},
    );
  }
  // Replaying the exact already-published cycle is safe and preserves the
  // endpoint's existing idempotent response contract.
  if(publicationState.state==='published') return publicationState;
  if(publicationState.state!=='overdue'){
    throw new PairingRecoveryError(
      'PAIRING_RECOVERY_NOT_READY',
      'Owner recovery is not available until the publication grace period ends.',
      {publicationState},
    );
  }
  return publicationState;
}
