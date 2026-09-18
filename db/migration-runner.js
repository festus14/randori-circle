import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION, validateExecutableMigrations } from './executable-migrations.js';
import {
  MIGRATION_LEDGER_TABLE,
  MigrationError,
  assertMigrationLedgerContract,
  createMigrationLedger,
  insertMigrationLedgerRow,
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from './migration-ledger.js';
import { MIGRATION_PLANS } from './migration-plan.js';
import { inspectSchema } from './schema-inspector.js';
import { SCHEMA_MANIFEST, checksum } from './schema-manifest.js';

const RETRY_DEFAULTS=Object.freeze({maxAttempts:4,baseDelayMs:40,maxDelayMs:400});
const PUBLIC_MESSAGES=Object.freeze({
  MIGRATION_STATE_CHANGED:'Database state changed after planning; inspect it again before retrying.',
  MIGRATION_UNMANAGED:'Existing unledgered schema requires explicit verified adoption.',
  MIGRATION_ADOPTION_BLOCKED:'Existing schema does not satisfy adoption invariants.',
  MIGRATION_LEDGER_INVALID:'Migration ledger is invalid.',
  MIGRATION_SCHEMA_INVALID:'Database schema does not match its recorded migration version.',
  MIGRATION_FAILED:'Database migration failed.',
});

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }

function retryConfiguration(options={}){
  const maxAttempts=Number(options.maxAttempts??RETRY_DEFAULTS.maxAttempts);
  const baseDelayMs=Number(options.baseDelayMs??RETRY_DEFAULTS.baseDelayMs);
  const maxDelayMs=Number(options.maxDelayMs??RETRY_DEFAULTS.maxDelayMs);
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10) throw new TypeError('maxAttempts must be an integer from 1 to 10');
  if(!Number.isFinite(baseDelayMs)||baseDelayMs<0||baseDelayMs>5000) throw new TypeError('baseDelayMs must be between 0 and 5000');
  if(!Number.isFinite(maxDelayMs)||maxDelayMs<baseDelayMs||maxDelayMs>10000) throw new TypeError('maxDelayMs must be between baseDelayMs and 10000');
  return {maxAttempts,baseDelayMs,maxDelayMs,wait:options.sleep||sleep};
}

export function isRetryableMigrationConflict(error){
  if(error instanceof MigrationError) return false;
  let current=error;
  for(let depth=0;current&&depth<5;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>[
      'SQLITE_BUSY',
      'SQLITE_BUSY_SNAPSHOT',
      'SQLITE_LOCKED',
      'SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT',
      'LIBSQL_TRANSACTION_BUSY',
    ].includes(code))) return true;
    const message=String(current.message||'').trim();
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(message)
      ||/^database is busy$/i.test(message)) return true;
    current=current.cause;
  }
  return false;
}

export async function withMigrationRetry(operation,options={}){
  const {maxAttempts,baseDelayMs,maxDelayMs,wait}=retryConfiguration(options);
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{ return await operation(attempt); }
    catch(error){
      lastError=error;
      if(attempt===maxAttempts||!isRetryableMigrationConflict(error)) throw error;
      await wait(Math.min(maxDelayMs,baseDelayMs*(2**(attempt-1))));
    }
  }
  throw lastError;
}

function manifestAtVersion(version){
  const tables=new Map();
  const indexes=new Map();
  MIGRATION_PLANS.filter(plan=>plan.version<=version).forEach(plan=>plan.operations.forEach(operation=>{
    if(operation.operation==='ensure-table'){
      const {operation:_operation,...definition}=operation;
      tables.set(operation.name,Object.freeze(definition));
    }
    if(operation.operation==='ensure-index'){
      const {operation:_operation,...definition}=operation;
      indexes.set(operation.name,Object.freeze(definition));
    }
  }));
  const value={
    version,
    tables:Object.freeze([...tables.values()]),
    indexes:Object.freeze([...indexes.values()]),
    toleratedLegacyTables:Object.freeze([...new Set([
      ...SCHEMA_MANIFEST.toleratedLegacyTables,MIGRATION_LEDGER_TABLE,
    ])]),
  };
  return Object.freeze({...value,checksum:checksum(value)});
}

function exactSchema(status){
  return status.ok&&status.warnings.length===0;
}

function structuralBlockers(status){
  return status.blockers.filter(blocker=>blocker.artifact?.type!=='connection');
}

async function schemaObjects(db){
  const result=await db.execute(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE type IN ('table','index','view','trigger') ORDER BY type,name`);
  return (result.rows||[]).map(row=>({
    type:String(row.type),
    name:String(row.name),
    table:String(row.tbl_name||''),
    sql:row.sql===null||row.sql===undefined?null:String(row.sql),
  }));
}

function applicationObjects(objects){
  return objects.filter(item=>item.name!==MIGRATION_LEDGER_TABLE&&!item.name.startsWith('sqlite_'));
}

function numericValue(row,name){
  const value=Number(row?.[name]);
  return Number.isSafeInteger(value)&&value>=0?value:0;
}

export async function inspectMembershipAdoption(db){
  const rolloutResult=await db.execute(`SELECT id,registrations_closed FROM circle_membership_rollout ORDER BY id LIMIT 2`);
  const rolloutRows=rolloutResult.rows||[];
  const blockers=[];
  if(rolloutRows.length!==1||Number(rolloutRows[0]?.id)!==1){
    blockers.push('rollout_singleton_invalid');
    return {ok:false,registrationState:'invalid',blockers,counts:{rolloutRows:rolloutRows.length}};
  }
  const closed=Number(rolloutRows[0].registrations_closed);
  if(![0,1].includes(closed)) blockers.push('rollout_value_invalid');
  const primaryResult=await db.execute(`SELECT id FROM circles
    WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  const primaryRows=primaryResult.rows||[];
  const primaryId=Number(primaryRows[0]?.id);
  const validPrimaryId=Number.isSafeInteger(primaryId)&&primaryId>0;
  const counts={rolloutRows:rolloutRows.length,activePrimaryCircles:primaryRows.length};
  const aggregateResult=await db.execute(`SELECT
    (SELECT COUNT(*) FROM circles) AS circles,
    (SELECT COUNT(*) FROM circle_memberships) AS memberships,
    (SELECT COUNT(*) FROM circle_invitations) AS invitations,
    (SELECT COUNT(*) FROM circle_audit_events) AS auditEvents,
    (SELECT COUNT(*) FROM circle_audit_events WHERE event_type='membership.backfill.completed') AS completedBackfills`);
  counts.circles=numericValue(aggregateResult.rows?.[0],'circles');
  counts.memberships=numericValue(aggregateResult.rows?.[0],'memberships');
  counts.invitations=numericValue(aggregateResult.rows?.[0],'invitations');
  counts.auditEvents=numericValue(aggregateResult.rows?.[0],'auditEvents');
  counts.completedBackfills=numericValue(aggregateResult.rows?.[0],'completedBackfills');

  if(closed===0){
    if(counts.circles||counts.memberships||counts.invitations||counts.auditEvents){
      blockers.push('open_rollout_has_membership_state');
    }
  }else if(closed===1){
    if(primaryRows.length!==1||!validPrimaryId) blockers.push('closed_rollout_primary_circle_invalid');
    if(primaryRows.length===1&&validPrimaryId){
      const stateResult=await db.execute({
        sql:`SELECT
          (SELECT COUNT(*) FROM circle_memberships owner_membership
            JOIN auth_accounts owner_account ON owner_account.id=owner_membership.user_id
              AND COALESCE(owner_account.is_demo,0)=0
            WHERE owner_membership.circle_id=?
              AND owner_membership.role='owner' AND owner_membership.status='active') AS activeOwners,
          (SELECT COUNT(*) FROM circle_audit_events event
            JOIN circle_memberships actor_membership
              ON actor_membership.circle_id=event.circle_id
              AND actor_membership.user_id=event.actor_user_id
              AND actor_membership.role='owner' AND actor_membership.status='active'
            JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
              AND COALESCE(actor_account.is_demo,0)=0
            WHERE event.circle_id=? AND event.event_type='membership.backfill.completed'
              AND event.subject_user_id IS NULL AND event.invitation_id IS NULL
              AND event.dedupe_key=?) AS matchingBackfills,
          (SELECT COUNT(*) FROM auth_accounts account
            WHERE COALESCE(account.is_demo,0)=0
              AND NOT EXISTS (
                SELECT 1 FROM circle_audit_events event
                JOIN circle_memberships actor_membership
                  ON actor_membership.circle_id=event.circle_id
                  AND actor_membership.user_id=event.actor_user_id
                  AND actor_membership.role='owner' AND actor_membership.status='active'
                JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
                  AND COALESCE(actor_account.is_demo,0)=0
                WHERE event.circle_id=? AND event.event_type='membership.backfilled'
                  AND event.subject_user_id=account.id
                  AND event.invitation_id IS NULL
                  AND event.dedupe_key=printf('membership-backfilled:%d:%d',?,account.id)
              )
              AND NOT EXISTS (
                SELECT 1 FROM circle_invitations invitation
                JOIN circle_audit_events event ON event.invitation_id=invitation.id
                WHERE invitation.circle_id=? AND invitation.used_by=account.id
                  AND invitation.used_at IS NOT NULL AND invitation.revoked_at IS NULL
                  AND event.circle_id=invitation.circle_id
                  AND event.event_type='invitation.accepted'
                  AND event.actor_user_id=account.id
                  AND event.subject_user_id=account.id
                  AND event.dedupe_key=('invite-accepted:'||invitation.id)
              )) AS invalidAccountProvenance,
          (SELECT COUNT(*) FROM circle_audit_events event
            LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
            LEFT JOIN circle_memberships actor_membership
              ON actor_membership.circle_id=event.circle_id
              AND actor_membership.user_id=event.actor_user_id
              AND actor_membership.role='owner' AND actor_membership.status='active'
            LEFT JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
              AND COALESCE(actor_account.is_demo,0)=0
            WHERE event.event_type='membership.backfilled' AND (
              event.circle_id<>? OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
              OR event.invitation_id IS NOT NULL OR actor_membership.user_id IS NULL
              OR actor_account.id IS NULL
              OR event.dedupe_key IS NOT printf('membership-backfilled:%d:%d',?,account.id)
            )) AS malformedBackfillAudits,
          (SELECT COUNT(*) FROM circle_audit_events event
            LEFT JOIN circle_invitations invitation ON invitation.id=event.invitation_id
            LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
            WHERE event.event_type='invitation.accepted' AND (
              event.circle_id<>? OR invitation.id IS NULL OR invitation.circle_id<>?
              OR invitation.used_at IS NULL OR invitation.revoked_at IS NOT NULL
              OR invitation.used_by IS NOT account.id
              OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
              OR event.actor_user_id IS NOT account.id
              OR event.dedupe_key IS NOT ('invite-accepted:'||invitation.id)
            )) AS malformedInvitationAudits,
          (SELECT COUNT(*) FROM auth_accounts account
            WHERE COALESCE(account.is_demo,0)=0 AND NOT EXISTS (
              SELECT 1 FROM circle_memberships membership
              WHERE membership.circle_id=? AND membership.user_id=account.id
                AND membership.status='active'
            )) AS uncoveredAccounts,
          (SELECT COUNT(*) FROM circle_memberships membership
            LEFT JOIN auth_accounts account ON account.id=membership.user_id
            WHERE membership.status='active' AND account.id IS NULL) AS orphanMemberships`,
        args:[
          primaryId,
          primaryId,`primary-membership-backfill:${primaryId}:v1`,
          primaryId,primaryId,
          primaryId,
          primaryId,primaryId,
          primaryId,primaryId,
          primaryId,
        ],
      });
      const row=stateResult.rows?.[0];
      counts.activeOwners=numericValue(row,'activeOwners');
      counts.matchingBackfills=numericValue(row,'matchingBackfills');
      counts.invalidAccountProvenance=numericValue(row,'invalidAccountProvenance');
      counts.malformedBackfillAudits=numericValue(row,'malformedBackfillAudits');
      counts.malformedInvitationAudits=numericValue(row,'malformedInvitationAudits');
      counts.uncoveredAccounts=numericValue(row,'uncoveredAccounts');
      counts.orphanMemberships=numericValue(row,'orphanMemberships');
      if(counts.activeOwners<1) blockers.push('closed_rollout_has_no_owner');
      if(counts.completedBackfills!==1||counts.matchingBackfills!==1){
        blockers.push('closed_rollout_backfill_audit_invalid');
      }
      if(counts.invalidAccountProvenance||counts.malformedBackfillAudits
        ||counts.malformedInvitationAudits){
        blockers.push('closed_rollout_account_audit_invalid');
      }
      if(counts.uncoveredAccounts) blockers.push('closed_rollout_has_uncovered_accounts');
      if(counts.orphanMemberships) blockers.push('closed_rollout_has_orphan_memberships');
    }
  }
  const evidenceResults=await Promise.all([
    db.execute(`SELECT id,is_demo FROM auth_accounts ORDER BY id`),
    db.execute(`SELECT id,is_primary,archived_at FROM circles ORDER BY id`),
    db.execute(`SELECT circle_id,user_id,role,status FROM circle_memberships ORDER BY circle_id,user_id`),
    db.execute(`SELECT circle_id,event_type,subject_user_id,dedupe_key FROM circle_audit_events
      WHERE event_type IN ('membership.backfilled','membership.backfill.completed','invitation.accepted')
      ORDER BY circle_id,event_type,subject_user_id,dedupe_key`),
    db.execute(`SELECT id,circle_id,used_at,used_by,revoked_at FROM circle_invitations
      WHERE used_at IS NOT NULL OR used_by IS NOT NULL ORDER BY id`),
  ]);
  const evidenceFingerprint=checksum(evidenceResults.map(result=>(result.rows||[]).map(row=>
    Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value===null?null:String(value)])),
  )));
  return {
    ok:blockers.length===0,
    registrationState:closed===1?'closed':closed===0?'open':'invalid',
    blockers,
    counts,
    evidenceFingerprint,
  };
}

export async function prepareMigrationConnection(db){
  await db.execute('PRAGMA foreign_keys=ON');
  await db.execute('PRAGMA ignore_check_constraints=OFF');
}

export async function inspectMigrationState(db,{migrations=EXECUTABLE_MIGRATIONS}={}){
  validateExecutableMigrations(migrations);
  const latestVersion=migrations.at(-1)?.version||0;
  const objects=await schemaObjects(db);
  const ledgerPresent=await migrationLedgerExists(db);
  let ledger={currentVersion:0,rows:[]};
  if(ledgerPresent){
    await assertMigrationLedgerContract(db);
    ledger=validateMigrationLedger(await readMigrationLedger(db),migrations);
  }
  const appObjects=applicationObjects(objects);
  const classification=ledgerPresent
    ? ledger.currentVersion===0&&appObjects.length?'unmanaged':'managed'
    : appObjects.length?'unmanaged':'fresh';
  const expectedVersion=classification==='managed'
    ? ledger.currentVersion
    : classification==='fresh'?0:latestVersion;
  const schemaStatus=await inspectSchema(db,{manifest:manifestAtVersion(expectedVersion)});
  let membership=null;
  if(exactSchema(schemaStatus)&&(classification==='unmanaged'&&latestVersion>=2
    ||(classification==='managed'&&ledger.currentVersion>=2))){
    membership=await inspectMembershipAdoption(db);
  }
  const adoptionEligible=classification==='unmanaged'&&!ledgerPresent
    &&exactSchema(schemaStatus)&&(latestVersion<2||membership?.ok===true);
  const stateFingerprint=checksum({
    classification,
    latestVersion,
    migrationSet:migrations.map(({version,checksum:migrationChecksum})=>({
      version,checksum:migrationChecksum,
    })),
    objects,
    ledger:ledger.rows.map(({
      version,name,checksum:rowChecksum,appliedAt,executionMs,disposition,
    })=>({version,name,checksum:rowChecksum,appliedAt,executionMs,disposition})),
    schema:{blockers:structuralBlockers(schemaStatus),warnings:schemaStatus.warnings},
    membership,
  });
  return {
    classification,
    stateFingerprint,
    latestVersion,
    currentVersion:ledger.currentVersion,
    ledgerPresent,
    schemaExact:exactSchema(schemaStatus),
    ready:exactSchema(schemaStatus)
      &&(classification!=='managed'||ledger.currentVersion<2||membership?.ok===true),
    schemaStatus,
    adoption:{
      eligible:adoptionEligible,
      blockers:adoptionEligible?[]:[
        ...(ledgerPresent?['ledger_already_present']:[]),
        ...(!exactSchema(schemaStatus)?['schema_not_exact']:[]),
        ...(membership?.blockers||[]),
      ],
      membership,
    },
  };
}

function assertExpectedFingerprint(actual,expected){
  if(!/^[a-f0-9]{64}$/.test(String(expected||''))||actual!==expected){
    throw new MigrationError('MIGRATION_STATE_CHANGED','Migration state fingerprint mismatch');
  }
}

function assertManagedSchema(state){
  if(!state.ready){
    throw new MigrationError('MIGRATION_SCHEMA_INVALID','Managed schema does not match its ledger',{
      details:{
        currentVersion:state.currentVersion,
        blockers:[
          ...state.schemaStatus.blockers.map(blocker=>blocker.code),
          ...state.schemaStatus.warnings.map(warning=>warning.code),
          ...(state.adoption.membership?.blockers||[]),
        ],
      },
    });
  }
}

async function executeOperations(db,operations){
  for(const operation of operations) await db.execute(operation.sql);
}

async function rollbackQuietly(transaction){
  try{ await transaction.rollback(); }catch{}
}

async function closeQuietly(transaction){
  try{ transaction.close?.(); }catch{}
}

async function commitTransaction(transaction,version){
  try{ await transaction.commit(); }
  catch(error){
    throw new MigrationError('MIGRATION_FAILED','Migration commit outcome is unknown',{
      cause:error,
      details:Number.isSafeInteger(version)?{version}:undefined,
    });
  }
}

async function applyOneVersion(db,migration,{expectedStateFingerprint,migrations,retry}){
  return withMigrationRetry(async()=>{
    let transaction;
    let committed=false;
    try{
      transaction=await db.transaction('write');
      const state=await inspectMigrationState(transaction,{migrations});
      assertExpectedFingerprint(state.stateFingerprint,expectedStateFingerprint);
      if(state.classification==='unmanaged'){
        throw new MigrationError('MIGRATION_UNMANAGED','Cannot apply migrations to unmanaged schema');
      }
      assertManagedSchema(state);
      if(state.currentVersion>=migration.version){
        await rollbackQuietly(transaction);
        return {applied:false};
      }
      if(state.currentVersion!==migration.version-1){
        throw new MigrationError('MIGRATION_LEDGER_INVALID','Migration ledger changed unexpectedly',{
          details:{currentVersion:state.currentVersion,version:migration.version},
        });
      }
      if(!state.ledgerPresent) await createMigrationLedger(transaction);
      const startedAt=Date.now();
      await executeOperations(transaction,migration.operations);
      const postStatus=await inspectSchema(transaction,{manifest:manifestAtVersion(migration.version)});
      if(!exactSchema(postStatus)){
        throw new MigrationError('MIGRATION_SCHEMA_INVALID','Migration postcondition failed',{
          details:{version:migration.version},
        });
      }
      if(migration.version>=2){
        const membership=await inspectMembershipAdoption(transaction);
        if(!membership.ok){
          throw new MigrationError('MIGRATION_SCHEMA_INVALID','Membership migration postcondition failed',{
            details:{version:migration.version},
          });
        }
      }
      const executionMs=Math.max(0,Date.now()-startedAt);
      await insertMigrationLedgerRow(transaction,migration,{executionMs,disposition:'applied'});
      validateMigrationLedger(await readMigrationLedger(transaction),migrations);
      const committedState=await inspectMigrationState(transaction,{migrations});
      if(committedState.currentVersion!==migration.version||!committedState.ready){
        throw new MigrationError('MIGRATION_SCHEMA_INVALID','Migration ledger postcondition failed',{
          details:{version:migration.version},
        });
      }
      await commitTransaction(transaction,migration.version);
      committed=true;
      return {
        applied:true,
        version:migration.version,
        name:migration.name,
        checksum:migration.checksum,
        executionMs,
        stateFingerprint:committedState.stateFingerprint,
      };
    }catch(error){
      if(transaction&&!committed) await rollbackQuietly(transaction);
      throw error;
    }finally{
      if(transaction) await closeQuietly(transaction);
    }
  },retry);
}

export async function applyMigrations(db,{expectedStateFingerprint,migrations=EXECUTABLE_MIGRATIONS,retry}={}){
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function') throw new TypeError('a transactional database client is required');
  validateExecutableMigrations(migrations);
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations});
  assertExpectedFingerprint(initial.stateFingerprint,expectedStateFingerprint);
  if(initial.classification==='unmanaged'){
    throw new MigrationError('MIGRATION_UNMANAGED','Cannot apply migrations to unmanaged schema');
  }
  assertManagedSchema(initial);
  const applied=[];
  let expectedFingerprint=initial.stateFingerprint;
  for(const migration of migrations){
    if(migration.version<=initial.currentVersion) continue;
    try{
      const result=await applyOneVersion(db,migration,{
        expectedStateFingerprint:expectedFingerprint,
        migrations,
        retry,
      });
      if(result.applied){
        expectedFingerprint=result.stateFingerprint;
        const {stateFingerprint:_stateFingerprint,...record}=result;
        applied.push(record);
      }
    }catch(error){
      if(error instanceof MigrationError) throw error;
      throw new MigrationError('MIGRATION_FAILED',`Migration ${migration.version} failed`,{
        cause:error,
        details:{version:migration.version},
      });
    }
  }
  const finalState=await inspectMigrationState(db,{migrations});
  if(finalState.classification!=='managed'||finalState.currentVersion!==(migrations.at(-1)?.version||0)
    ||!finalState.ready){
    throw new MigrationError('MIGRATION_SCHEMA_INVALID','Migration verification failed');
  }
  assertExpectedFingerprint(finalState.stateFingerprint,expectedFingerprint);
  return {
    ok:true,
    mode:'apply',
    fromVersion:initial.currentVersion,
    toVersion:finalState.currentVersion,
    latestVersion:migrations.at(-1)?.version||LATEST_MIGRATION_VERSION,
    applied,
    stateFingerprint:finalState.stateFingerprint,
  };
}

export async function adoptMigrations(db,{expectedStateFingerprint,migrations=EXECUTABLE_MIGRATIONS,retry}={}){
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function') throw new TypeError('a transactional database client is required');
  validateExecutableMigrations(migrations);
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations});
  assertExpectedFingerprint(initial.stateFingerprint,expectedStateFingerprint);
  if(!initial.adoption.eligible){
    throw new MigrationError('MIGRATION_ADOPTION_BLOCKED','Database is not eligible for migration adoption',{
      details:{blockers:initial.adoption.blockers},
    });
  }
  const committedState=await withMigrationRetry(async()=>{
    let transaction;
    let committed=false;
    try{
      transaction=await db.transaction('write');
      const locked=await inspectMigrationState(transaction,{migrations});
      assertExpectedFingerprint(locked.stateFingerprint,expectedStateFingerprint);
      if(!locked.adoption.eligible){
        throw new MigrationError('MIGRATION_ADOPTION_BLOCKED','Database is not eligible for migration adoption');
      }
      await createMigrationLedger(transaction);
      for(const migration of migrations){
        await insertMigrationLedgerRow(transaction,migration,{executionMs:0,disposition:'adopted'});
      }
      validateMigrationLedger(await readMigrationLedger(transaction),migrations);
      const adoptedState=await inspectMigrationState(transaction,{migrations});
      if(adoptedState.classification!=='managed'
        ||adoptedState.currentVersion!==(migrations.at(-1)?.version||0)
        ||!adoptedState.ready){
        throw new MigrationError('MIGRATION_SCHEMA_INVALID','Migration adoption postcondition failed');
      }
      await commitTransaction(transaction,migrations.at(-1)?.version);
      committed=true;
      return adoptedState;
    }catch(error){
      if(transaction&&!committed) await rollbackQuietly(transaction);
      throw error;
    }finally{
      if(transaction) await closeQuietly(transaction);
    }
  },retry);
  return {
    ok:true,
    mode:'adopt',
    fromVersion:0,
    toVersion:committedState.currentVersion,
    latestVersion:migrations.at(-1)?.version||LATEST_MIGRATION_VERSION,
    adopted:migrations.map(({version,name,checksum:migrationChecksum})=>({version,name,checksum:migrationChecksum})),
    stateFingerprint:committedState.stateFingerprint,
  };
}

export function publicMigrationError(error){
  const code=error instanceof MigrationError&&PUBLIC_MESSAGES[error.code]?error.code:'MIGRATION_FAILED';
  const result={ok:false,error:code,message:PUBLIC_MESSAGES[code]};
  if(error instanceof MigrationError&&error.details){
    const details={};
    if(Number.isSafeInteger(error.details.version)) details.version=error.details.version;
    if(Number.isSafeInteger(error.details.currentVersion)) details.currentVersion=error.details.currentVersion;
    if(Array.isArray(error.details.blockers)){
      const blockers=error.details.blockers.map(String)
        .filter(value=>/^[a-z][a-z0-9_]{0,63}$/.test(value)).slice(0,50);
      if(blockers.length) details.blockers=blockers;
    }
    if(Object.keys(details).length) result.details=details;
  }
  return result;
}

export { MigrationError } from './migration-ledger.js';
