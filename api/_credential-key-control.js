import {
  credentialKeyControlPurpose,
  parseCredentialKeyControlRow,
} from '../db/credential-key-control.js';

const FINGERPRINT_PATTERN=/^[a-f0-9]{64}$/;
const CONTROL_COLUMNS=`purpose,control_version,state,highest_key_version,
  highest_key_fingerprint,generation,installed_by_migration,installed_at,updated_at`;

export class CredentialKeyControlError extends Error{
  constructor(code,{cause}={}){
    super('credential key control unavailable',cause?{cause}:undefined);
    this.name='CredentialKeyControlError';
    this.code=code;
  }
}

function fail(code,cause){ throw new CredentialKeyControlError(code,{cause}); }

function candidate(ring){
  const purpose=credentialKeyControlPurpose(ring?.purpose);
  const version=Number(ring?.active?.version);
  const fingerprint=String(ring?.active?.fingerprint||'');
  if(!purpose||!Number.isSafeInteger(version)||version<1||version>2147483647
    ||!FINGERPRINT_PATTERN.test(fingerprint)||!(ring?.byVersion instanceof Map)){
    throw new TypeError('valid credential key ring required');
  }
  const active=ring.byVersion.get(version);
  if(!active||active.version!==version||active.fingerprint!==fingerprint){
    throw new TypeError('valid credential key ring required');
  }
  return Object.freeze({purpose,version,fingerprint,ring});
}

async function record(db,purpose){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const result=await db.execute({
    sql:`SELECT ${CONTROL_COLUMNS} FROM credential_key_controls WHERE purpose=? LIMIT 2`,
    args:[purpose],
  });
  if(result.rows?.length!==1) fail('KEY_CONTROL_STATE_INVALID');
  const parsed=parseCredentialKeyControlRow(result.rows[0]);
  if(!parsed||parsed.purpose!==purpose) fail('KEY_CONTROL_STATE_INVALID');
  return parsed;
}

function evaluate(current,configured){
  if(current.state==='uninitialized'){
    return Object.freeze({ready:false,state:'uninitialized',reason:'KEY_CONTROL_UNINITIALIZED'});
  }
  if(configured.version<current.highestKeyVersion){
    return Object.freeze({ready:false,state:'downgrade',reason:'KEY_CONTROL_DOWNGRADE'});
  }
  if(configured.version>current.highestKeyVersion){
    return Object.freeze({ready:false,state:'advance_required',reason:'KEY_CONTROL_ADVANCE_REQUIRED'});
  }
  if(configured.fingerprint!==current.highestKeyFingerprint){
    return Object.freeze({ready:false,state:'substitution',reason:'KEY_CONTROL_SUBSTITUTION'});
  }
  return Object.freeze({ready:true,state:'accepted',reason:null});
}

function publicStatus(current,configured,evaluation){
  return Object.freeze({
    ready:evaluation.ready,
    state:evaluation.state,
    reason:evaluation.reason,
    configured_version:configured.version,
    accepted_version:current.highestKeyVersion,
    generation:current.generation,
  });
}

export async function credentialKeyControlStatus(db,ring){
  const configured=candidate(ring);
  const current=await record(db,configured.purpose);
  return publicStatus(current,configured,evaluate(current,configured));
}

export async function assertCredentialKeyControl(db,ring){
  const status=await credentialKeyControlStatus(db,ring);
  if(!status.ready) fail(status.reason||'KEY_CONTROL_STATE_INVALID');
  return status;
}

export function withCredentialKeyControlStatus(metrics,status){
  if(!metrics||typeof metrics!=='object'||!status||typeof status!=='object'){
    throw new TypeError('valid credential rotation status required');
  }
  return Object.freeze({...metrics,ready:metrics.ready===true&&status.ready===true,
    control_state:status.state,control_reason:status.reason,
    accepted_version:status.accepted_version,control_generation:status.generation});
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const code=String(current.code||current.rawCode||'').toUpperCase();
    if(['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code)) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i
      .test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function readBack(db,configured){
  try{
    const current=await record(db,configured.purpose);
    if(current.state==='accepted'&&current.highestKeyVersion===configured.version
      &&current.highestKeyFingerprint===configured.fingerprint){
      return Object.freeze({ok:true,purpose:configured.purpose,version:configured.version,
        generation:current.generation,changed:false,reconciled:true});
    }
  }catch{}
  fail('KEY_CONTROL_COMMIT_UNKNOWN');
}

async function transitionAttempt(db,{operation,configured,expectedVersion,expectedGeneration,
  validateCandidate}){
  let transaction;
  let finished=false;
  let commitStarted=false;
  let reconcile=false;
  let result;
  try{
    transaction=await db.transaction('write');
    const current=await record(transaction,configured.purpose);
    if(current.state==='accepted'&&current.highestKeyVersion===configured.version
      &&current.highestKeyFingerprint===configured.fingerprint){
      await transaction.rollback();
      finished=true;
      return Object.freeze({ok:true,purpose:configured.purpose,version:configured.version,
        generation:current.generation,changed:false,reconciled:false});
    }
    if(operation==='adopt'){
      if(current.state!=='uninitialized'||current.generation!==0){
        const assessment=evaluate(current,configured);
        fail(assessment.reason||'KEY_CONTROL_ALREADY_ADOPTED');
      }
    }else{
      if(current.state!=='accepted') fail('KEY_CONTROL_UNINITIALIZED');
      if(current.highestKeyVersion!==expectedVersion||current.generation!==expectedGeneration){
        fail('KEY_CONTROL_STATE_CHANGED');
      }
      if(configured.version<=current.highestKeyVersion){
        fail(configured.version===current.highestKeyVersion
          ?'KEY_CONTROL_SUBSTITUTION':'KEY_CONTROL_DOWNGRADE');
      }
      const prior=configured.ring.byVersion.get(current.highestKeyVersion);
      if(!prior||prior.fingerprint!==current.highestKeyFingerprint){
        fail('KEY_CONTROL_CONTINUITY_MISSING');
      }
    }
    if(typeof validateCandidate==='function') await validateCandidate(transaction,configured.ring,{operation});
    const nextGeneration=current.generation+1;
    const changed=await transaction.execute({
      sql:`UPDATE credential_key_controls SET state='accepted',highest_key_version=?,
          highest_key_fingerprint=?,generation=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE purpose=? AND state=? AND generation=?
          AND highest_key_version IS ? AND highest_key_fingerprint IS ? RETURNING generation`,
      args:[configured.version,configured.fingerprint,nextGeneration,configured.purpose,
        current.state,current.generation,current.highestKeyVersion,current.highestKeyFingerprint],
    });
    if(changed.rows?.length!==1||Number(changed.rows[0].generation)!==nextGeneration){
      fail('KEY_CONTROL_STATE_CHANGED');
    }
    result=Object.freeze({ok:true,purpose:configured.purpose,version:configured.version,
      generation:nextGeneration,changed:true,reconciled:false});
    commitStarted=true;
    await transaction.commit();
    finished=true;
    return result;
  }catch(error){
    if(!commitStarted) throw error;
    reconcile=true;
  }finally{
    if(transaction&&!finished){ try{ await transaction.rollback(); }catch{} }
    try{ await transaction?.close?.(); }catch{}
  }
  if(reconcile) return readBack(db,configured);
  fail('KEY_CONTROL_TRANSITION_FAILED');
}

export async function transitionCredentialKeyControl(db,{operation,ring,expectedVersion=null,
  expectedGeneration=null,validateCandidate}={}){
  if(!db||typeof db.transaction!=='function'||!['adopt','advance'].includes(operation)){
    throw new TypeError('valid credential key control transition required');
  }
  const configured=candidate(ring);
  if(operation==='advance'&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<1
    ||expectedVersion>2147483647||!Number.isSafeInteger(expectedGeneration)
    ||expectedGeneration<1||expectedGeneration>2147483647)){
    throw new TypeError('valid expected credential key control state required');
  }
  for(let attempt=1;attempt<=5;attempt+=1){
    try{
      return await transitionAttempt(db,{operation,configured,expectedVersion,expectedGeneration,
        validateCandidate});
    }catch(error){
      if(error instanceof CredentialKeyControlError||!retryableConflict(error)||attempt===5) throw error;
      await wait(Math.min(200,10*(2**(attempt-1))));
    }
  }
  fail('KEY_CONTROL_TRANSITION_FAILED');
}
