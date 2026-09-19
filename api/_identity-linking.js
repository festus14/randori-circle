import {createHmac,randomBytes} from 'node:crypto';

import {normalizeInvitationEmail} from './_circle-membership.js';
import {recordRecentAuth,requireRecentAuth,readRecentAuth} from './_recent-auth.js';

export const GOOGLE_ISSUER='https://accounts.google.com';

const SESSION_HASH_PATTERN=/^[a-f0-9]{64}$/;
const SUBJECT_PATTERN=/^[A-Za-z0-9_-]{1,255}$/;
const EVENT_TYPES=new Set([
  'google_linked','google_unlinked','password_added','password_unlinked',
  'link_conflict','unlink_denied','provider_email_changed','provider_email_rekeyed','recovery_completed',
]);
const PROVIDERS=new Set(['google','password']);
const OUTCOMES=new Set(['succeeded','denied','conflict','observed']);
const REASON_PATTERN=/^[a-z][a-z0-9_]{0,63}$/;
const EMAIL_HASH_KEY_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const EMAIL_HASH_KEY_VERSION_PATTERN=/^[1-9]\d{0,8}$/;

function identityEmailHashConfiguration(env=process.env){
  const encoded=String(env.IDENTITY_EMAIL_HASH_KEY||'').trim();
  const versionText=String(env.IDENTITY_EMAIL_HASH_KEY_VERSION||'').trim();
  if(!EMAIL_HASH_KEY_PATTERN.test(encoded)||!EMAIL_HASH_KEY_VERSION_PATTERN.test(versionText)) return null;
  const key=Buffer.from(encoded,'base64url');
  const version=Number(versionText);
  if(key.length!==32||key.toString('base64url')!==encoded
    ||!Number.isSafeInteger(version)||version<1||version>2147483647) return null;
  const fingerprint=createHmac('sha256',key)
    .update('randori-provider-email-key-fingerprint-v1','utf8').digest('hex');
  return Object.freeze({key,version,fingerprint});
}

export function identityEmailHashConfigured(env=process.env){
  return Boolean(identityEmailHashConfiguration(env));
}

function providerEmailDigest(email,configuration=identityEmailHashConfiguration()){
  if(!configuration){
    const error=new Error('identity email hashing unavailable');
    error.code='IDENTITY_EMAIL_HASH_UNAVAILABLE';
    throw error;
  }
  const hash=createHmac('sha256',configuration.key)
    .update(`randori-provider-email-observation-v1\0${configuration.version}\0${email}`,'utf8')
    .digest('hex');
  return Object.freeze({hash,keyVersion:configuration.version});
}

function hashVersionError(){
  const error=new Error('identity email hash key version rollback');
  error.code='IDENTITY_EMAIL_HASH_VERSION_ROLLBACK';
  return error;
}

async function assertIdentityEmailHashVersion(db,configuration){
  const result=await db.execute({
    sql:`SELECT MAX(hash_key_version) AS max_key_version,
        MIN(CASE WHEN hash_key_version=? THEN hash_key_fingerprint END) AS min_fingerprint,
        MAX(CASE WHEN hash_key_version=? THEN hash_key_fingerprint END) AS max_fingerprint
      FROM auth_provider_email_state`,
    args:[configuration.version,configuration.version],
  });
  const row=result.rows?.[0]||{};
  const maximum=row.max_key_version===null||row.max_key_version===undefined
    ?null:Number(row.max_key_version);
  const minimumFingerprint=row.min_fingerprint===null||row.min_fingerprint===undefined
    ?null:String(row.min_fingerprint);
  const maximumFingerprint=row.max_fingerprint===null||row.max_fingerprint===undefined
    ?null:String(row.max_fingerprint);
  if((maximum!==null&&maximum>configuration.version)
    ||(minimumFingerprint!==null&&(minimumFingerprint!==configuration.fingerprint
      ||maximumFingerprint!==configuration.fingerprint))){
    throw hashVersionError();
  }
}

function userId(value){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

function sessionHash(value){
  const normalized=String(value||'');
  return SESSION_HASH_PATTERN.test(normalized)?normalized:null;
}

function googleSubject(value){
  const normalized=String(value||'');
  return SUBJECT_PATTERN.test(normalized)?normalized:null;
}

function nowValue(value){
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function hasPassword(row){
  return String(row?.password_hash||'').startsWith('$2');
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const code=String(current.code||current.rawCode||'').toUpperCase();
    if(['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code)) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

async function databaseNow(db,override){
  if(override!==undefined&&override!==null){
    const normalized=nowValue(override);
    if(!normalized) throw new TypeError('valid identity time is required');
    return normalized;
  }
  const result=await db.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
  const current=Number(result.rows?.[0]?.now_seconds);
  if(!nowValue(current)) throw new Error('database identity time unavailable');
  return current;
}

async function accountState(db,id){
  const result=await db.execute({
    sql:`SELECT account.id,account.email,account.password_hash,account.google_sub,
        identity.subject AS google_subject
      FROM auth_accounts account
      LEFT JOIN auth_provider_identities identity
        ON identity.user_id=account.id AND identity.issuer=?
      WHERE account.id=? LIMIT 2`,
    args:[GOOGLE_ISSUER,id],
  });
  return result.rows?.length===1?result.rows[0]:null;
}

async function audit(db,{userId:subjectUserId,actorUserId=subjectUserId,eventType,provider,outcome,reasonCode,nowSeconds}){
  const subject=userId(subjectUserId);
  const actor=userId(actorUserId);
  if(!subject||!actor||!EVENT_TYPES.has(eventType)||!PROVIDERS.has(provider)
    ||!OUTCOMES.has(outcome)||!REASON_PATTERN.test(String(reasonCode||''))||!nowValue(nowSeconds)){
    throw new TypeError('valid identity audit event is required');
  }
  const result=await db.execute({
    sql:`INSERT INTO auth_identity_audit_events
        (user_id,actor_user_id,event_type,provider,outcome,reason_code,created_at)
      SELECT account.id,actor.id,?,?,?,?,? FROM auth_accounts account,auth_accounts actor
      WHERE account.id=? AND actor.id=? RETURNING id`,
    args:[eventType,provider,outcome,reasonCode,nowSeconds,subject,actor],
  });
  if(result.rows?.length!==1) throw new Error('identity audit persistence failed');
}

async function closeTransaction(transaction,committed){
  if(!committed){ try{ await transaction.rollback(); }catch{} }
  try{ await transaction.close?.(); }catch{}
}

async function persistAudit(db,event,{nowSeconds}={}){
  for(let attempt=1;attempt<=8;attempt+=1){
    let transaction;
    let committed=false;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const now=await databaseNow(transaction,nowSeconds);
      await audit(transaction,{...event,nowSeconds:now});
      commitStarted=true;
      await transaction.commit(); committed=true;
      return;
    }catch(error){
      if(commitStarted||!retryableConflict(error)||attempt===8) throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,10*(2**(attempt-1)))));
    }finally{
      if(transaction) await closeTransaction(transaction,committed);
    }
  }
}

async function revokeOtherSessions(transaction,{userId:targetUserId,sessionHash:currentSessionHash,nowSeconds}){
  await transaction.execute({
    sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason='identity_change'
      WHERE user_id=? AND session_hash<>? AND revoked_at IS NULL AND expires_at>?`,
    args:[nowSeconds,targetUserId,currentSessionHash,nowSeconds],
  });
}

export async function ensureIdentityLinkingReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const configuration=identityEmailHashConfiguration();
  if(!configuration) throw new Error('identity email hashing unavailable');
  await db.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities LIMIT 0`);
  await db.execute(`SELECT issuer,subject,email_hash,hash_key_version,hash_key_fingerprint,observed_at,changed_at FROM auth_provider_email_state LIMIT 0`);
  await db.execute(`SELECT id,user_id,actor_user_id,event_type,provider,outcome,reason_code,created_at
    FROM auth_identity_audit_events LIMIT 0`);
  await db.execute(`SELECT session_hash,user_id,authenticated_at,method FROM auth_recent_proofs LIMIT 0`);
  await assertIdentityEmailHashVersion(db,configuration);
}

export async function readIdentityState(db,payload,{nowSeconds}={}){
  const id=userId(payload?.id??payload?.uid);
  if(!id||!sessionHash(payload?.sessionHash)) throw new TypeError('valid identity session is required');
  const state=await accountState(db,id);
  if(!state) throw new Error('identity account unavailable');
  const recentAuth=await readRecentAuth(db,payload,{...(nowSeconds?{nowSeconds}:{})});
  const password=hasPassword(state);
  const google=Boolean(state.google_subject);
  return Object.freeze({
    accountEmail:String(state.email),
    password:Object.freeze({linked:password,canAdd:!password&&google,canUnlink:password&&google}),
    google:Object.freeze({linked:google,canLink:!google,canUnlink:google&&password}),
    recentAuth,
  });
}

async function linkGoogleCredentialAttempt(db,payload,{
  issuer,subject,providerEmail,providerAuthenticatedAt,nowSeconds,
}={}){
  const id=userId(payload?.id??payload?.uid);
  const currentSessionHash=sessionHash(payload?.sessionHash);
  const normalizedSubject=googleSubject(subject);
  const normalizedEmail=normalizeInvitationEmail(providerEmail);
  if(!db||typeof db.transaction!=='function'||!id||!currentSessionHash
    ||issuer!==GOOGLE_ISSUER||!normalizedSubject||!normalizedEmail
    ||!Number.isSafeInteger(providerAuthenticatedAt)){
    throw new TypeError('valid explicit Google link proof is required');
  }
  const emailHashConfiguration=identityEmailHashConfiguration();
  const emailObservation=providerEmailDigest(normalizedEmail,emailHashConfiguration);
  let transaction;
  let committed=false;
  let closed=false;
  let commitStarted=false;
  try{
    transaction=await db.transaction('write');
    // Acquire the SQLite writer before reading ownership so two callbacks
    // cannot both make a decision from the same stale identity snapshot.
    await transaction.execute({
      sql:`UPDATE auth_sessions SET expires_at=expires_at
        WHERE session_hash=? AND user_id=? RETURNING session_hash`,
      args:[currentSessionHash,id],
    });
    await assertIdentityEmailHashVersion(transaction,emailHashConfiguration);
    const now=await databaseNow(transaction,nowSeconds);
    if(providerAuthenticatedAt>now+60||providerAuthenticatedAt<now-180){
      throw new TypeError('fresh Google authentication is required');
    }
    await requireRecentAuth(transaction,{id,sessionHash:currentSessionHash},{nowSeconds:now});
    const state=await accountState(transaction,id);
    if(!state) throw new Error('identity account unavailable');
    const owner=await transaction.execute({
      sql:`SELECT user_id FROM auth_provider_identities WHERE issuer=? AND subject=? LIMIT 2`,
      args:[issuer,normalizedSubject],
    });
    if(owner.rows?.length===1&&Number(owner.rows[0].user_id)!==id){
      await closeTransaction(transaction,false); closed=true;
      await persistAudit(db,{userId:id,eventType:'link_conflict',provider:'google',outcome:'conflict',
        reasonCode:'provider_in_use'},{nowSeconds:now});
      return Object.freeze({status:'provider_in_use'});
    }
    if(state.google_subject&&String(state.google_subject)!==normalizedSubject){
      await closeTransaction(transaction,false); closed=true;
      await persistAudit(db,{userId:id,eventType:'link_conflict',provider:'google',outcome:'conflict',
        reasonCode:'provider_already_linked'},{nowSeconds:now});
      return Object.freeze({status:'provider_already_linked'});
    }
    const account=await transaction.execute({
      sql:`UPDATE auth_accounts SET google_sub=?
        WHERE id=? AND (google_sub IS NULL OR google_sub=?)
          AND NOT EXISTS (SELECT 1 FROM auth_accounts other WHERE other.id<>? AND other.google_sub=?)
        RETURNING id,email`,
      args:[normalizedSubject,id,normalizedSubject,id,normalizedSubject],
    });
    if(account.rows?.length!==1) throw Object.assign(new Error('provider identity conflict'),{code:'IDENTITY_CONFLICT'});
    const linked=await transaction.execute({
      sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id,created_at,last_login)
        VALUES (?,?,?,datetime('now'),datetime('now'))
        ON CONFLICT(issuer,subject) DO UPDATE SET last_login=excluded.last_login
          WHERE auth_provider_identities.user_id=excluded.user_id
        RETURNING user_id`,
      args:[issuer,normalizedSubject,id],
    });
    if(linked.rows?.length!==1||Number(linked.rows[0].user_id)!==id){
      throw Object.assign(new Error('provider identity conflict'),{code:'IDENTITY_CONFLICT'});
    }
    const previousEmail=await transaction.execute({
      sql:`SELECT email_hash,hash_key_version,hash_key_fingerprint
        FROM auth_provider_email_state WHERE issuer=? AND subject=? LIMIT 2`,
      args:[issuer,normalizedSubject],
    });
    const priorEmail=previousEmail.rows?.length===1?previousEmail.rows[0]:null;
    if(priorEmail&&Number(priorEmail.hash_key_version)>emailObservation.keyVersion){
      throw hashVersionError();
    }
    if(priorEmail&&Number(priorEmail.hash_key_version)===emailObservation.keyVersion
      &&String(priorEmail.hash_key_fingerprint)!==emailHashConfiguration.fingerprint){
      throw hashVersionError();
    }
    const providerEmailRekeyed=Boolean(priorEmail)
      &&Number(priorEmail.hash_key_version)<emailObservation.keyVersion;
    const providerEmailChanged=Boolean(priorEmail)&&!providerEmailRekeyed
      &&String(priorEmail.email_hash)!==emailObservation.hash;
    await transaction.execute({
      sql:`INSERT INTO auth_provider_email_state
          (issuer,subject,email_hash,hash_key_version,hash_key_fingerprint,observed_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET
          changed_at=CASE WHEN auth_provider_email_state.hash_key_version=excluded.hash_key_version
              AND auth_provider_email_state.email_hash<>excluded.email_hash
            THEN excluded.observed_at ELSE auth_provider_email_state.changed_at END,
          email_hash=excluded.email_hash,hash_key_version=excluded.hash_key_version,
          hash_key_fingerprint=excluded.hash_key_fingerprint,
          observed_at=excluded.observed_at`,
      args:[issuer,normalizedSubject,emailObservation.hash,emailObservation.keyVersion,
        emailHashConfiguration.fingerprint,now],
    });
    if(providerEmailRekeyed){
      await audit(transaction,{userId:id,eventType:'provider_email_rekeyed',provider:'google',outcome:'observed',
        reasonCode:'hash_key_rotated',nowSeconds:now});
    }else if(providerEmailChanged){
      await audit(transaction,{userId:id,eventType:'provider_email_changed',provider:'google',outcome:'observed',
        reasonCode:'provider_email_rotated',nowSeconds:now});
    }
    const sameEmail=normalizeInvitationEmail(state.email)===normalizedEmail;
    await audit(transaction,{userId:id,eventType:sameEmail&&!state.google_subject?'recovery_completed':'google_linked',
      provider:'google',outcome:'succeeded',reasonCode:sameEmail?'same_email_explicit_link':'explicit_link',nowSeconds:now});
    await recordRecentAuth(transaction,{sessionHash:currentSessionHash,userId:id,method:'google',nowSeconds:now});
    commitStarted=true;
    await transaction.commit(); committed=true;
    return Object.freeze({status:state.google_subject?'already_linked':'linked'});
  }catch(error){
    if(error?.code==='IDENTITY_CONFLICT'){
      await closeTransaction(transaction,false);
      closed=true;
      await persistAudit(db,{userId:id,eventType:'link_conflict',provider:'google',outcome:'conflict',
        reasonCode:'provider_in_use'},{nowSeconds});
      return Object.freeze({status:'provider_in_use'});
    }
    if(!commitStarted&&retryableConflict(error)) error.identityLinkRetryable=true;
    throw error;
  }finally{
    if(transaction&&!closed){
      if(!committed) await closeTransaction(transaction,false);
      else{ try{ await transaction.close?.(); }catch{} }
    }
  }
}

export async function linkGoogleCredential(db,payload,input={}){
  for(let attempt=1;attempt<=8;attempt+=1){
    try{ return await linkGoogleCredentialAttempt(db,payload,input); }
    catch(error){
      if(error?.identityLinkRetryable!==true||attempt===8) throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(250,10*(2**(attempt-1)))));
    }
  }
  throw new Error('identity link unavailable');
}

export async function unlinkGoogleCredential(db,payload,{nowSeconds}={}){
  const id=userId(payload?.id??payload?.uid);
  const currentSessionHash=sessionHash(payload?.sessionHash);
  if(!db||typeof db.transaction!=='function'||!id||!currentSessionHash){
    throw new TypeError('valid identity session is required');
  }
  const transaction=await db.transaction('write');
  let committed=false;
  try{
    const now=await databaseNow(transaction,nowSeconds);
    await requireRecentAuth(transaction,{id,sessionHash:currentSessionHash},{nowSeconds:now});
    const state=await accountState(transaction,id);
    if(!state) throw new Error('identity account unavailable');
    if(!state.google_subject){
      await transaction.rollback(); committed=true;
      return Object.freeze({status:'not_linked'});
    }
    if(!hasPassword(state)){
      await audit(transaction,{userId:id,eventType:'unlink_denied',provider:'google',outcome:'denied',
        reasonCode:'final_credential',nowSeconds:now});
      await transaction.commit(); committed=true;
      return Object.freeze({status:'final_credential'});
    }
    const removed=await transaction.execute({
      sql:`DELETE FROM auth_provider_identities WHERE issuer=? AND subject=? AND user_id=? RETURNING subject`,
      args:[GOOGLE_ISSUER,String(state.google_subject),id],
    });
    if(removed.rows?.length!==1) throw new Error('provider unlink changed concurrently');
    const account=await transaction.execute({
      sql:`UPDATE auth_accounts SET google_sub=NULL WHERE id=? AND google_sub=? RETURNING id`,
      args:[id,String(state.google_subject)],
    });
    if(account.rows?.length!==1) throw new Error('provider unlink changed concurrently');
    await revokeOtherSessions(transaction,{userId:id,sessionHash:currentSessionHash,nowSeconds:now});
    await audit(transaction,{userId:id,eventType:'google_unlinked',provider:'google',outcome:'succeeded',
      reasonCode:'explicit_unlink',nowSeconds:now});
    await transaction.commit(); committed=true;
    return Object.freeze({status:'unlinked'});
  }finally{ await closeTransaction(transaction,committed); }
}

export async function addPasswordCredential(db,payload,{passwordHash,nowSeconds}={}){
  const id=userId(payload?.id??payload?.uid);
  const currentSessionHash=sessionHash(payload?.sessionHash);
  if(!db||typeof db.transaction!=='function'||!id||!currentSessionHash
    ||typeof passwordHash!=='string'||!passwordHash.startsWith('$2')||passwordHash.length>128){
    throw new TypeError('valid password credential is required');
  }
  const transaction=await db.transaction('write');
  let committed=false;
  try{
    const now=await databaseNow(transaction,nowSeconds);
    const recent=await requireRecentAuth(transaction,{id,sessionHash:currentSessionHash},{nowSeconds:now});
    const state=await accountState(transaction,id);
    if(!state) throw new Error('identity account unavailable');
    if(hasPassword(state)){
      await transaction.rollback(); committed=true;
      return Object.freeze({status:'already_linked'});
    }
    if(!state.google_subject||recent.method!=='google'){
      await audit(transaction,{userId:id,eventType:'link_conflict',provider:'password',outcome:'denied',
        reasonCode:'verified_control_required',nowSeconds:now});
      await transaction.commit(); committed=true;
      return Object.freeze({status:'verified_control_required'});
    }
    const updated=await transaction.execute({
      sql:`UPDATE auth_accounts SET password_hash=? WHERE id=? AND password_hash NOT LIKE '$2%'
        AND EXISTS (SELECT 1 FROM auth_provider_identities identity
          WHERE identity.user_id=auth_accounts.id AND identity.issuer=?) RETURNING id`,
      args:[passwordHash,id,GOOGLE_ISSUER],
    });
    if(updated.rows?.length!==1) throw new Error('password link changed concurrently');
    await audit(transaction,{userId:id,eventType:'password_added',provider:'password',outcome:'succeeded',
      reasonCode:'verified_google_control',nowSeconds:now});
    await transaction.commit(); committed=true;
    return Object.freeze({status:'linked'});
  }finally{ await closeTransaction(transaction,committed); }
}

export async function unlinkPasswordCredential(db,payload,{nowSeconds}={}){
  const id=userId(payload?.id??payload?.uid);
  const currentSessionHash=sessionHash(payload?.sessionHash);
  if(!db||typeof db.transaction!=='function'||!id||!currentSessionHash){
    throw new TypeError('valid identity session is required');
  }
  const replacement=`!oauth:${randomBytes(24).toString('base64url')}`;
  const transaction=await db.transaction('write');
  let committed=false;
  try{
    const now=await databaseNow(transaction,nowSeconds);
    await requireRecentAuth(transaction,{id,sessionHash:currentSessionHash},{nowSeconds:now});
    const state=await accountState(transaction,id);
    if(!state) throw new Error('identity account unavailable');
    if(!hasPassword(state)){
      await transaction.rollback(); committed=true;
      return Object.freeze({status:'not_linked'});
    }
    if(!state.google_subject){
      await audit(transaction,{userId:id,eventType:'unlink_denied',provider:'password',outcome:'denied',
        reasonCode:'final_credential',nowSeconds:now});
      await transaction.commit(); committed=true;
      return Object.freeze({status:'final_credential'});
    }
    const updated=await transaction.execute({
      sql:`UPDATE auth_accounts SET password_hash=? WHERE id=? AND password_hash LIKE '$2%'
        AND EXISTS (SELECT 1 FROM auth_provider_identities identity
          WHERE identity.user_id=auth_accounts.id AND identity.issuer=?) RETURNING id`,
      args:[replacement,id,GOOGLE_ISSUER],
    });
    if(updated.rows?.length!==1) throw new Error('password unlink changed concurrently');
    await revokeOtherSessions(transaction,{userId:id,sessionHash:currentSessionHash,nowSeconds:now});
    await audit(transaction,{userId:id,eventType:'password_unlinked',provider:'password',outcome:'succeeded',
      reasonCode:'explicit_unlink',nowSeconds:now});
    await transaction.commit(); committed=true;
    return Object.freeze({status:'unlinked'});
  }finally{ await closeTransaction(transaction,committed); }
}

export async function observeGoogleProviderEmail(db,{
  issuer,subject,userId:targetUserId,providerEmail,nowSeconds,
}={}){
  const id=userId(targetUserId);
  const normalizedSubject=googleSubject(subject);
  const normalizedEmail=normalizeInvitationEmail(providerEmail);
  if(!db||typeof db.transaction!=='function'||issuer!==GOOGLE_ISSUER||!id||!normalizedSubject||!normalizedEmail){
    throw new TypeError('valid Google email observation is required');
  }
  const emailHashConfiguration=identityEmailHashConfiguration();
  const emailObservation=providerEmailDigest(normalizedEmail,emailHashConfiguration);
  const transaction=await db.transaction('write');
  let committed=false;
  try{
    await transaction.execute(`UPDATE auth_provider_email_state SET observed_at=observed_at WHERE 0=1`);
    await assertIdentityEmailHashVersion(transaction,emailHashConfiguration);
    const now=await databaseNow(transaction,nowSeconds);
    const previous=await transaction.execute({
      sql:`SELECT state.email_hash,state.hash_key_version,state.hash_key_fingerprint
        FROM auth_provider_identities identity
        LEFT JOIN auth_provider_email_state state
          ON state.issuer=identity.issuer AND state.subject=identity.subject
        WHERE identity.issuer=? AND identity.subject=? AND identity.user_id=? LIMIT 2`,
      args:[issuer,normalizedSubject,id],
    });
    if(previous.rows?.length!==1) throw new Error('provider identity unavailable');
    const previousHash=previous.rows[0].email_hash===null?null:String(previous.rows[0].email_hash);
    const previousVersion=previous.rows[0].hash_key_version===null
      ?null:Number(previous.rows[0].hash_key_version);
    if(previousHash!==null&&previousVersion>emailObservation.keyVersion){
      throw hashVersionError();
    }
    if(previousHash!==null&&previousVersion===emailObservation.keyVersion
      &&String(previous.rows[0].hash_key_fingerprint)!==emailHashConfiguration.fingerprint){
      throw hashVersionError();
    }
    const rekeyed=previousHash!==null&&previousVersion<emailObservation.keyVersion;
    const changed=previousHash!==null&&!rekeyed&&previousHash!==emailObservation.hash;
    await transaction.execute({
      sql:`INSERT INTO auth_provider_email_state
          (issuer,subject,email_hash,hash_key_version,hash_key_fingerprint,observed_at,changed_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(issuer,subject) DO UPDATE SET
          changed_at=CASE WHEN auth_provider_email_state.hash_key_version=excluded.hash_key_version
              AND auth_provider_email_state.email_hash<>excluded.email_hash
            THEN excluded.observed_at ELSE auth_provider_email_state.changed_at END,
          email_hash=excluded.email_hash,hash_key_version=excluded.hash_key_version,
          hash_key_fingerprint=excluded.hash_key_fingerprint,
          observed_at=excluded.observed_at`,
      args:[issuer,normalizedSubject,emailObservation.hash,emailObservation.keyVersion,
        emailHashConfiguration.fingerprint,now,changed?now:null],
    });
    if(rekeyed){
      await audit(transaction,{userId:id,eventType:'provider_email_rekeyed',provider:'google',outcome:'observed',
        reasonCode:'hash_key_rotated',nowSeconds:now});
    }else if(changed){
      await audit(transaction,{userId:id,eventType:'provider_email_changed',provider:'google',outcome:'observed',
        reasonCode:'provider_email_rotated',nowSeconds:now});
    }
    await transaction.commit(); committed=true;
    return Object.freeze({changed,rekeyed});
  }finally{ await closeTransaction(transaction,committed); }
}
