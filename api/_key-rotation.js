import {createCipheriv,createDecipheriv,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';

export const MAX_PREVIOUS_KEYS=3;
export const CREDENTIAL_ENVELOPE_WRITE_VERSION=2;

const KEY_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const VERSION_PATTERN=/^[1-9]\d{0,8}$/;
const FINGERPRINT_PATTERN=/^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const PURPOSE_KEY_ENVIRONMENTS=Object.freeze([
  Object.freeze({purpose:'email-activation',keyEnv:'EMAIL_VERIFICATION_ENCRYPTION_KEY',
    versionEnv:'EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION',
    previousKeysEnv:'EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS',
    writeVersionEnv:'EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION'}),
  Object.freeze({purpose:'password-reset',keyEnv:'PASSWORD_RESET_ENCRYPTION_KEY',
    versionEnv:'PASSWORD_RESET_ENCRYPTION_KEY_VERSION',
    previousKeysEnv:'PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS',
    writeVersionEnv:'PASSWORD_RESET_ENVELOPE_WRITE_VERSION'}),
  Object.freeze({purpose:'invitation-email',keyEnv:'INVITATION_EMAIL_ENCRYPTION_KEY',
    versionEnv:'INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
    previousKeysEnv:'INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS',
    writeVersionEnv:'INVITATION_EMAIL_ENVELOPE_WRITE_VERSION'}),
  Object.freeze({purpose:'identity-email-observation',keyEnv:'IDENTITY_EMAIL_HASH_KEY',
    versionEnv:'IDENTITY_EMAIL_HASH_KEY_VERSION',
    previousKeysEnv:'IDENTITY_EMAIL_HASH_PREVIOUS_KEYS',requiresVersion:true}),
]);

function configurationError(code){
  const error=new Error('key rotation configuration invalid');
  error.code=code;
  return error;
}

function decodeKey(encoded){
  if(!KEY_PATTERN.test(encoded)) return null;
  const key=Buffer.from(encoded,'base64url');
  return key.length===32&&key.toString('base64url')===encoded?key:null;
}

function version(value){
  const text=String(value||'').trim();
  if(!VERSION_PATTERN.test(text)) return null;
  const parsed=Number(text);
  return Number.isSafeInteger(parsed)&&parsed<=2147483647?parsed:null;
}

export function rotationKeyFingerprint(key,purpose){
  return createHmac('sha256',key)
    .update(`randori-key-fingerprint-v1\0${purpose}`,'utf8').digest('hex');
}

function parsePreviousKeys(value,{purpose,fingerprint}){
  const source=String(value||'').trim();
  if(!source) return [];
  let parsed;
  try{ parsed=JSON.parse(source); }
  catch{ throw configurationError('KEY_RING_PREVIOUS_INVALID'); }
  if(!Array.isArray(parsed)||parsed.length>MAX_PREVIOUS_KEYS){
    throw configurationError('KEY_RING_PREVIOUS_INVALID');
  }
  return parsed.map((entry,index)=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)
      ||Object.keys(entry).sort().join(',')!=='key,version'){
      throw configurationError('KEY_RING_PREVIOUS_INVALID');
    }
    const key=decodeKey(String(entry.key||'').trim());
    const keyVersion=version(entry.version);
    if(!key||!keyVersion) throw configurationError('KEY_RING_PREVIOUS_INVALID');
    return Object.freeze({version:keyVersion,key,
      fingerprint:fingerprint(key,purpose),position:index});
  });
}

/** Validate that configured active and prior material belongs to one purpose only. */
export function assertPurposeKeyIsolation({env=process.env,rings=[]}={}){
  if(!env||typeof env!=='object'||!Array.isArray(rings)){
    throw new TypeError('valid purpose key isolation input required');
  }
  const entries=[];
  for(const definition of PURPOSE_KEY_ENVIRONMENTS){
    const encoded=String(env[definition.keyEnv]||'').trim();
    const previous=parsePreviousKeys(env[definition.previousKeysEnv],{
      purpose:definition.purpose,fingerprint:rotationKeyFingerprint,
    });
    if(!encoded){
      if(previous.length) throw configurationError('KEY_RING_ACTIVE_INVALID');
      continue;
    }
    if(definition.requiresVersion&&!String(env[definition.versionEnv]||'').trim()){
      throw configurationError('KEY_RING_VERSION_INVALID');
    }
    const configured=parseKeyRing({env,purpose:definition.purpose,keyEnv:definition.keyEnv,
      versionEnv:definition.versionEnv,previousKeysEnv:definition.previousKeysEnv,
      writeVersionEnv:definition.writeVersionEnv});
    for(const item of configured.ordered) entries.push({purpose:definition.purpose,key:item.key});
  }
  for(const ring of rings){
    if(!ring||typeof ring.purpose!=='string'||!Array.isArray(ring.ordered)){
      throw new TypeError('valid purpose key ring required');
    }
    for(const item of ring.ordered){
      if(!Buffer.isBuffer(item?.key)||item.key.length!==32){
        throw new TypeError('valid purpose key ring required');
      }
      entries.push({purpose:ring.purpose,key:item.key});
    }
  }
  const owners=new Map();
  for(const entry of entries){
    const material=entry.key.toString('base64url');
    const owner=owners.get(material);
    if(owner&&owner!==entry.purpose){
      throw configurationError('KEY_RING_CROSS_PURPOSE_REUSE');
    }
    owners.set(material,entry.purpose);
  }
  return true;
}

/**
 * Parse one purpose-specific key ring. Existing single-key deployments remain
 * version 1 and write v1 until the explicit v2 write switch is enabled.
 */
export function parseKeyRing({
  env=process.env,purpose,keyEnv,versionEnv,previousKeysEnv,writeVersionEnv=null,
  fallbackKey=null,fingerprint=rotationKeyFingerprint,
}={}){
  if(typeof purpose!=='string'||!purpose||typeof keyEnv!=='string'
    ||typeof versionEnv!=='string'||typeof previousKeysEnv!=='string'){
    throw new TypeError('valid key ring definition required');
  }
  const encoded=String(env[keyEnv]||'').trim();
  const activeKey=encoded?decodeKey(encoded)
    :(typeof fallbackKey==='function'?fallbackKey():null);
  if(!Buffer.isBuffer(activeKey)||activeKey.length!==32){
    throw configurationError('KEY_RING_ACTIVE_INVALID');
  }
  const configuredVersion=String(env[versionEnv]||'').trim();
  const activeVersion=configuredVersion?version(configuredVersion):1;
  if(!activeVersion) throw configurationError('KEY_RING_VERSION_INVALID');
  const previous=parsePreviousKeys(env[previousKeysEnv],{purpose,fingerprint});
  const active=Object.freeze({version:activeVersion,key:activeKey,
    fingerprint:fingerprint(activeKey,purpose),position:-1});
  let priorVersion=activeVersion;
  const versions=new Set([activeVersion]);
  const fingerprints=new Set([active.fingerprint]);
  for(const entry of previous){
    if(entry.version>=priorVersion) throw configurationError('KEY_RING_PREVIOUS_UNORDERED');
    if(versions.has(entry.version)) throw configurationError('KEY_RING_VERSION_DUPLICATE');
    if(fingerprints.has(entry.fingerprint)) throw configurationError('KEY_RING_MATERIAL_DUPLICATE');
    versions.add(entry.version);
    fingerprints.add(entry.fingerprint);
    priorVersion=entry.version;
  }
  const writeVersionText=writeVersionEnv?String(env[writeVersionEnv]||'1').trim():'1';
  if(!['1',String(CREDENTIAL_ENVELOPE_WRITE_VERSION)].includes(writeVersionText)){
    throw configurationError('KEY_RING_WRITE_VERSION_INVALID');
  }
  const writeEnvelopeVersion=Number(writeVersionText);
  const ordered=Object.freeze([active,...previous]);
  return Object.freeze({purpose,active,previous:Object.freeze(previous),ordered,
    byVersion:new Map(ordered.map(item=>[item.version,item])),writeEnvelopeVersion});
}

export class CredentialEnvelopeError extends Error{
  constructor(code,{retryable=false}={}){
    super('credential envelope unavailable');
    this.name='CredentialEnvelopeError';
    this.code=code;
    this.retryable=Boolean(retryable);
  }
}

function strictBase64url(value,{length=null,min=0,max=Number.MAX_SAFE_INTEGER}={}){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try{
    const decoded=Buffer.from(value,'base64url');
    if(decoded.toString('base64url')!==value||(length!==null&&decoded.length!==length)
      ||decoded.length<min||decoded.length>max) return null;
    return decoded;
  }catch{ return null; }
}

function v2Aad({purpose,keyVersion,idempotencyKey}){
  if(!IDEMPOTENCY_KEY_PATTERN.test(String(idempotencyKey||''))){
    throw new CredentialEnvelopeError('ENVELOPE_CONTEXT_INVALID');
  }
  return Buffer.from(`randori-credential-envelope\0${purpose}\0v2\0${keyVersion}\0${idempotencyKey}`,'utf8');
}

function decrypt({key,iv,ciphertext,tag,aad}){
  const decipher=createDecipheriv('aes-256-gcm',key,iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]);
}

function sealWithKey(plaintext,{key,aad}){
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(aad);
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return {iv,ciphertext,tag:cipher.getAuthTag()};
}

export function sealCredentialEnvelope({plaintext,idempotencyKey,ring,legacyAad}={}){
  const value=Buffer.isBuffer(plaintext)?plaintext:Buffer.from(String(plaintext??''),'utf8');
  if(!ring?.active||!value.length||value.length>4096||typeof legacyAad!=='function'){
    throw new TypeError('valid credential envelope input required');
  }
  if(ring.writeEnvelopeVersion===1){
    const sealed=sealWithKey(value,{key:ring.active.key,aad:legacyAad()});
    return [sealed.iv,sealed.ciphertext,sealed.tag].map(part=>part.toString('base64url')).join('.');
  }
  const aad=v2Aad({purpose:ring.purpose,keyVersion:ring.active.version,idempotencyKey});
  const sealed=sealWithKey(value,{key:ring.active.key,aad});
  return ['v2',String(ring.active.version),ring.active.fingerprint,
    sealed.iv.toString('base64url'),sealed.ciphertext.toString('base64url'),
    sealed.tag.toString('base64url')].join('.');
}

export function credentialEnvelopeHeader(envelope){
  if(typeof envelope!=='string') return Object.freeze({kind:'malformed'});
  const parts=envelope.split('.');
  const match=/^v([1-9]\d{0,8})$/.exec(parts[0]||'');
  if(match){
    const envelopeVersion=Number(match[1]);
    if(envelopeVersion!==2) return Object.freeze({kind:'future',envelopeVersion,keyVersion:null,fingerprint:null});
    const keyVersion=version(parts[1]);
    const fingerprint=String(parts[2]||'');
    if(parts.length!==6||!keyVersion||!FINGERPRINT_PATTERN.test(fingerprint)){
      return Object.freeze({kind:'malformed'});
    }
    return Object.freeze({kind:'versioned',envelopeVersion,keyVersion,fingerprint});
  }
  if(parts.length===3) return Object.freeze({kind:'legacy',envelopeVersion:1,keyVersion:null,fingerprint:null});
  return Object.freeze({kind:'malformed'});
}

export function openCredentialEnvelope({
  envelope,idempotencyKey,ring,legacyAad,minPlaintextBytes=1,maxPlaintextBytes=4096,
}={}){
  if(!ring?.active||typeof legacyAad!=='function') throw new TypeError('valid credential key ring required');
  const parts=typeof envelope==='string'?envelope.split('.'):[];
  const header=credentialEnvelopeHeader(envelope);
  if(header.kind==='future'){
    throw new CredentialEnvelopeError('ENVELOPE_VERSION_UNAVAILABLE',{retryable:true});
  }
  if(header.kind==='malformed') throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  if(header.kind==='legacy'){
    const iv=strictBase64url(parts[0],{length:12});
    const ciphertext=strictBase64url(parts[1],{min:minPlaintextBytes,max:maxPlaintextBytes});
    const tag=strictBase64url(parts[2],{length:16});
    if(!iv||!ciphertext||!tag) throw new CredentialEnvelopeError('ENVELOPE_INVALID');
    for(const candidate of ring.ordered){
      try{
        const plaintext=decrypt({key:candidate.key,iv,ciphertext,tag,aad:legacyAad()});
        // AES-GCM preserves plaintext length, so the ciphertext check above
        // already proved this authenticated value is within the exact bounds.
        return Object.freeze({plaintext,keyVersion:candidate.version,envelopeVersion:1,
          fingerprint:candidate.fingerprint});
      }catch{}
    }
    // V1 carries no key identifier, so a structurally valid authentication
    // failure may be a retired key. Retrying is safer than destroying a link.
    throw new CredentialEnvelopeError('KEY_VERSION_UNAVAILABLE',{retryable:true});
  }
  const candidate=ring.byVersion.get(header.keyVersion);
  if(!candidate) throw new CredentialEnvelopeError('KEY_VERSION_UNAVAILABLE',{retryable:true});
  const expected=Buffer.from(candidate.fingerprint);
  const actual=Buffer.from(header.fingerprint);
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual)){
    throw new CredentialEnvelopeError('KEY_FINGERPRINT_MISMATCH',{retryable:true});
  }
  const iv=strictBase64url(parts[3],{length:12});
  const ciphertext=strictBase64url(parts[4],{min:minPlaintextBytes,max:maxPlaintextBytes});
  const tag=strictBase64url(parts[5],{length:16});
  if(!iv||!ciphertext||!tag) throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  try{
    const plaintext=decrypt({key:candidate.key,iv,ciphertext,tag,
      aad:v2Aad({purpose:ring.purpose,keyVersion:header.keyVersion,idempotencyKey})});
    if(plaintext.length<minPlaintextBytes||plaintext.length>maxPlaintextBytes){
      throw new Error('plaintext size');
    }
    return Object.freeze({plaintext,keyVersion:header.keyVersion,envelopeVersion:2,
      fingerprint:header.fingerprint});
  }catch(error){
    if(error instanceof CredentialEnvelopeError) throw error;
    throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  }
}

export function assertCredentialEnvelopeKey({envelope,ring}){
  const header=credentialEnvelopeHeader(envelope);
  if(header.kind==='legacy') return header;
  if(header.kind==='future'){
    throw new CredentialEnvelopeError('ENVELOPE_VERSION_UNAVAILABLE',{retryable:true});
  }
  if(header.kind!=='versioned') throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  const candidate=ring.byVersion.get(header.keyVersion);
  if(!candidate) throw new CredentialEnvelopeError('KEY_VERSION_UNAVAILABLE',{retryable:true});
  if(candidate.fingerprint!==header.fingerprint){
    throw new CredentialEnvelopeError('KEY_FINGERPRINT_MISMATCH',{retryable:true});
  }
  return header;
}

export async function readCredentialRotationMetrics(db,{
  eventType,envelopeField,ring,retainedEnvelopes=[],
}={}){
  if(!db||typeof db.execute!=='function'||typeof eventType!=='string'
    ||!/^[_a-z][_a-z0-9]*$/.test(String(envelopeField||''))||!ring?.active
    ||!Array.isArray(retainedEnvelopes)){
    throw new TypeError('valid credential rotation metric query required');
  }
  const result=await db.execute({
    sql:`SELECT status,event_version,json_extract(payload_json,?) AS envelope
      FROM outbox_events WHERE event_type=?
        AND status IN ('pending','processing','retry','dead_letter') ORDER BY id LIMIT 10001`,
    args:[`$.${envelopeField}`,eventType],
  });
  const rows=result.rows||[];
  if(rows.length>10000||retainedEnvelopes.length>10000
    ||rows.length+retainedEnvelopes.length>10000){
    throw new Error('credential rotation metric limit exceeded');
  }
  const counts={legacy_v1:0,malformed:0,future:0,missing_key:0,
    fingerprint_mismatch:0,key_version_ahead:0};
  const versions=new Map();
  for(const envelope of [...rows.map(row=>row.envelope),...retainedEnvelopes]){
    const header=credentialEnvelopeHeader(envelope);
    if(header.kind==='legacy'){ counts.legacy_v1+=1; continue; }
    if(header.kind==='malformed'){ counts.malformed+=1; continue; }
    if(header.kind==='future'){ counts.future+=1; continue; }
    versions.set(header.keyVersion,(versions.get(header.keyVersion)||0)+1);
    if(header.keyVersion>ring.active.version) counts.key_version_ahead+=1;
    const candidate=ring.byVersion.get(header.keyVersion);
    if(!candidate) counts.missing_key+=1;
    else if(candidate.fingerprint!==header.fingerprint) counts.fingerprint_mismatch+=1;
  }
  const actionable=rows.length;
  // Legacy envelopes do not identify the key that sealed them. Even when one
  // configured key can currently open a v1 envelope, the aggregate cannot
  // prove that any other key in the ring is safe to retire. Keep delivery
  // compatible, but make the retirement signal conservative until every
  // actionable or explicitly retained legacy envelope is gone.
  return Object.freeze({purpose:ring.purpose,ready:counts.legacy_v1===0
    &&counts.malformed===0&&counts.future===0
    &&counts.missing_key===0&&counts.fingerprint_mismatch===0&&counts.key_version_ahead===0,
  active_version:ring.active.version,write_envelope_version:ring.writeEnvelopeVersion,
  previous_versions:Object.freeze(ring.previous.map(item=>item.version)),actionable,
  retained:retainedEnvelopes.length,
  legacy_v1:counts.legacy_v1,versions:Object.freeze(Object.fromEntries([...versions].sort((a,b)=>a[0]-b[0]))),
  malformed:counts.malformed,future:counts.future,missing_key:counts.missing_key,
  fingerprint_mismatch:counts.fingerprint_mismatch,key_version_ahead:counts.key_version_ahead});
}
