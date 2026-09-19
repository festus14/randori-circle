import {checksum} from './stable-checksum.js';

export const CREDENTIAL_KEY_CONTROL_MIGRATION_VERSION=15;
export const CREDENTIAL_KEY_CONTROL_VERSION=1;
export const CREDENTIAL_KEY_PURPOSES=Object.freeze([
  'email-activation',
  'identity-email-observation',
  'invitation-email',
  'password-reset',
]);

const FINGERPRINT_PATTERN=/^[a-f0-9]{64}$/;

export const CREDENTIAL_KEY_CONTROL_SEED_OPERATIONS=Object.freeze(
  CREDENTIAL_KEY_PURPOSES.map(purpose=>Object.freeze({
    operation:'ensure-row',
    name:`credential_key_controls:${purpose}`,
    table:'credential_key_controls',
    sql:`INSERT INTO credential_key_controls
      (purpose,control_version,state,highest_key_version,highest_key_fingerprint,
       generation,installed_by_migration,installed_at,updated_at)
      VALUES ('${purpose}',1,'uninitialized',NULL,NULL,0,15,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(purpose) DO NOTHING`,
  })),
);

function integer(value,{minimum=0,maximum=Number.MAX_SAFE_INTEGER}={}){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>=minimum&&number<=maximum?number:null;
}

export function credentialKeyControlPurpose(value){
  const purpose=String(value||'');
  return CREDENTIAL_KEY_PURPOSES.includes(purpose)?purpose:null;
}

export function parseCredentialKeyControlRow(row){
  if(!row||typeof row!=='object'||Array.isArray(row)) return null;
  const purpose=credentialKeyControlPurpose(row.purpose);
  const controlVersion=integer(row.control_version,{minimum:1,maximum:1});
  const generation=integer(row.generation,{maximum:2147483647});
  const installedByMigration=integer(row.installed_by_migration,{
    minimum:CREDENTIAL_KEY_CONTROL_MIGRATION_VERSION,
    maximum:CREDENTIAL_KEY_CONTROL_MIGRATION_VERSION,
  });
  const installedAt=String(row.installed_at||'');
  const updatedAt=String(row.updated_at||'');
  const timestampsValid=installedAt.length===24&&updatedAt.length===24
    &&Number.isFinite(Date.parse(installedAt))&&Number.isFinite(Date.parse(updatedAt))
    &&Date.parse(updatedAt)>=Date.parse(installedAt);
  if(!purpose||controlVersion!==CREDENTIAL_KEY_CONTROL_VERSION||generation===null
    ||installedByMigration!==CREDENTIAL_KEY_CONTROL_MIGRATION_VERSION||!timestampsValid){
    return null;
  }
  const state=String(row.state||'');
  if(state==='uninitialized'&&generation===0&&row.highest_key_version===null
    &&row.highest_key_fingerprint===null){
    return Object.freeze({purpose,state,controlVersion,generation,installedByMigration,
      installedAt,updatedAt,highestKeyVersion:null,highestKeyFingerprint:null});
  }
  const highestKeyVersion=integer(row.highest_key_version,{minimum:1,maximum:2147483647});
  const highestKeyFingerprint=String(row.highest_key_fingerprint||'');
  if(state!=='accepted'||generation<1||highestKeyVersion===null
    ||!FINGERPRINT_PATTERN.test(highestKeyFingerprint)) return null;
  return Object.freeze({purpose,state,controlVersion,generation,installedByMigration,
    installedAt,updatedAt,highestKeyVersion,highestKeyFingerprint});
}

export async function readCredentialKeyControlRows(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const result=await db.execute(`SELECT purpose,control_version,state,highest_key_version,
    highest_key_fingerprint,generation,installed_by_migration,installed_at,updated_at
    FROM credential_key_controls ORDER BY purpose LIMIT 5`);
  const rows=result.rows||[];
  const parsed=rows.map(parseCredentialKeyControlRow);
  const purposes=parsed.filter(Boolean).map(row=>row.purpose);
  const exact=rows.length===CREDENTIAL_KEY_PURPOSES.length&&parsed.every(Boolean)
    &&JSON.stringify(purposes)===JSON.stringify(CREDENTIAL_KEY_PURPOSES);
  return Object.freeze({ok:exact,rows:Object.freeze(exact?parsed:[]),
    blockers:Object.freeze(exact?[]:['credential_key_controls_invalid'])});
}

export async function inspectCredentialKeyControlReadiness(db){
  const state=await readCredentialKeyControlRows(db);
  return Object.freeze({ok:state.ok,
    initialized:state.ok?state.rows.filter(row=>row.state==='accepted').length:0,
    total:state.ok?state.rows.length:0,
    stateDigest:state.ok?checksum(state.rows.map(row=>({
      purpose:row.purpose,state:row.state,highestKeyVersion:row.highestKeyVersion,
      highestKeyFingerprint:row.highestKeyFingerprint,generation:row.generation,
      controlVersion:row.controlVersion,installedByMigration:row.installedByMigration,
      installedAt:row.installedAt,updatedAt:row.updatedAt,
    }))):null,
    blockers:state.blockers});
}
