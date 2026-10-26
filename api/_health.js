import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inspectCompletedMembershipRollout,
  inspectMembershipRolloutReadiness,
} from '../db/membership-readiness.js';
import { MIGRATION_CONTRACTS } from '../db/migration-contract.js';
import { inspectLedgerReadiness, readinessManifestForLedger } from '../db/migration-compatibility.js';
import { inspectSchema, readOnlyDatabase } from '../db/schema-inspector.js';
import { READINESS_SCHEMA_MANIFEST } from '../db/schema-readiness-manifest.js';
import { inspectCredentialKeyControlReadiness } from '../db/credential-key-control.js';

export const HEALTH_RESPONSE=Object.freeze({ok:true,status:'live'});
export const READY_RESPONSE=Object.freeze({ok:true,status:'ready'});
export const UNAVAILABLE_RESPONSE=Object.freeze({ok:false,status:'unavailable'});
export const READINESS_TIMEOUT_MS=8_000;
// v16's normalized schedule ownership adds two tables and their automatic
// constraint indexes; keep a bounded margin for the full managed schema.
export const MAX_READINESS_SCHEMA_OBJECTS=256;

const inFlightReadiness=new Map();

function configured(value){
  return typeof value==='string'&&value.trim()!=='';
}

export function databaseReadinessConfiguration(env=process.env){
  const rawUrl=String(env.TURSO_DATABASE_URL||'').trim();
  if(!rawUrl||rawUrl.length>2048) return null;
  let url;
  try{ url=new URL(rawUrl); }catch{ return null; }
  if(url.username||url.password||url.search||url.hash) return null;
  const local=env.RANDORI_LOCAL_RUNTIME==='true';
  const membershipRequired=env.CIRCLE_MEMBERSHIP_ENABLED==='true';
  const authToken=String(env.TURSO_AUTH_TOKEN||'').trim();
  let localDatabasePath=null;
  if(local){
    if(env.NODE_ENV==='production'||url.protocol!=='file:'||url.host||!url.pathname.startsWith('/')||authToken) return null;
    const expectedPath=String(env.RANDORI_LOCAL_DATABASE_PATH||'').trim();
    try{ localDatabasePath=fileURLToPath(url); }catch{ return null; }
    if(!expectedPath||!isAbsolute(expectedPath)||resolve(expectedPath)!==expectedPath
      ||localDatabasePath!==expectedPath) return null;
  }else if(!url.host||!configured(authToken)||authToken.length>32_768
    ||!(env.NODE_ENV==='production'
      ?['libsql:','https:'].includes(url.protocol)
      :['libsql:','https:','http:'].includes(url.protocol))){
    return null;
  }
  return Object.freeze({
    cacheKey:createHash('sha256')
      .update(`${local?'local':'remote'}\0${membershipRequired?'membership':'legacy'}\0${rawUrl}\0${authToken}`,'utf8')
      .digest('hex'),
    local,
    localDatabasePath,
    membershipRequired,
  });
}

export function readinessTargetExists(configuration){
  if(!configuration?.local) return true;
  try{
    const metadata=lstatSync(configuration.localDatabasePath);
    return metadata.isFile()&&!metadata.isSymbolicLink()&&metadata.nlink===1
      &&realpathSync(configuration.localDatabasePath)===configuration.localDatabasePath;
  }catch{
    return false;
  }
}

export function resolveHealthProbe(req){
  const queryProbe=String(req?.query?.probe||req?.query?.check||'').trim().toLowerCase();
  if(queryProbe) return queryProbe==='live'||queryProbe==='liveness'?'live'
    :queryProbe==='ready'||queryProbe==='readiness'?'ready':'invalid';
  const path=String(req?.url||'').split('?',1)[0].replace(/\/+$/,'').toLowerCase();
  if(path.endsWith('/live')||path.endsWith('/healthz')) return 'live';
  if(path.endsWith('/ready')||path.endsWith('/readyz')) return 'ready';
  return 'ready';
}

// Ready means the ledger is at the code's latest version, or one version
// behind when that latest migration is additive (ID-87), and the schema
// matches the version actually applied exactly. `contracts` and `manifest`
// exist so tests can model code one migration ahead; production callers use
// the checked-in defaults.
export async function inspectDatabaseReadiness(database,{
  membershipRequired=false,
  contracts=MIGRATION_CONTRACTS,
  manifest=READINESS_SCHEMA_MANIFEST,
}={}){
  const db=readOnlyDatabase(database);
  const ledger=await inspectLedgerReadiness(db,{contracts});
  if(!ledger.ready) return false;
  const schema=await inspectSchema(db,{
    manifest:readinessManifestForLedger(manifest,ledger,{contracts}),
    maxSchemaObjects:MAX_READINESS_SCHEMA_OBJECTS,
  });
  if(!schema.ok||schema.warnings.length!==0) return false;
  const keyControl=await inspectCredentialKeyControlReadiness(db);
  if(!keyControl.ok) return false;
  const membership=membershipRequired
    ?await inspectCompletedMembershipRollout(db)
    :await inspectMembershipRolloutReadiness(db);
  return membership.ok===true;
}

function timeout(promise,timeoutMs){
  let timer;
  const expired=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('readiness deadline exceeded')),timeoutMs);
  });
  return Promise.race([promise,expired]).finally(()=>clearTimeout(timer));
}

// Share only an in-flight probe. Results are never retained, so a schema or
// rollout change cannot be hidden behind a stale success cache.
export function coalescedDatabaseReadiness(cacheKey,database,{
  membershipRequired=false,
  timeoutMs=READINESS_TIMEOUT_MS,
}={}){
  if(!/^[a-f0-9]{64}$/.test(String(cacheKey||''))) throw new TypeError('invalid readiness cache key');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30_000){
    throw new TypeError('readiness timeout must be an integer from 1 to 30000 milliseconds');
  }
  const existing=inFlightReadiness.get(cacheKey);
  if(existing) return timeout(existing,timeoutMs);
  const pending=Promise.resolve().then(()=>inspectDatabaseReadiness(database,{membershipRequired}));
  inFlightReadiness.set(cacheKey,pending);
  pending.finally(()=>{
    if(inFlightReadiness.get(cacheKey)===pending) inFlightReadiness.delete(cacheKey);
  }).catch(()=>{});
  return timeout(pending,timeoutMs);
}

export function setHealthHeaders(res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Content-Type-Options','nosniff');
}
