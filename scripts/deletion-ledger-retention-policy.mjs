// Guard the existing CLI purge. No DDL, provider API or second purge implementation.
import { ledgerDbTimestamp } from '../api/_deletion-ledger-db.js';
export const RETENTION_WINDOW_MS=24*60*60*1000;
export const RETENTION_MAX_ENTRIES=10_000;

export class RetentionError extends Error {
  constructor(code,counts){
    super('deletion ledger retention refused');
    this.code=code;
    this.counts=counts;
  }
}

function fail(code,counts){
  throw new RetentionError(code,counts);
}

const normalizedSchema=sql=>String(sql).replace(/\bIF\s+NOT\s+EXISTS\b/gi,'').replace(/\s+/g,'').toLowerCase();

export async function verifyRetentionTarget(client,expectedSchema){
  // A ledger-shaped table inside an app DB is insufficient. Require the sole
  // application schema object to be the exact operator-initialized v1 table.
  // This also excludes views, extra columns, indexes and DELETE triggers.
  const {rows}=await client.execute({
    sql:"SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
    args:[],
  });
  if(rows.length!==1||rows[0].type!=='table'||rows[0].name!=='deletion_ledger'
    ||normalizedSchema(rows[0].sql)!==normalizedSchema(expectedSchema)){
    fail('RETENTION_TARGET_REFUSED');
  }
}

export async function guardedRetentionPurge(client,{before,dryRun=false,expectedSchema,purge}){
  ledgerDbTimestamp(before,'purge cutoff');
  // BEGIN IMMEDIATE for purge: verification, count, DELETE and commit share one
  // write lock. A concurrent writer cannot push this run above the cap.
  // Dry-run uses a read transaction and rolls back; it never executes DELETE.
  const tx=await client.transaction(dryRun?'read':'write');
  try{
    await verifyRetentionTarget(tx,expectedSchema);
    const {rows}=await tx.execute({
      sql:`SELECT COUNT(*) AS total,
        COALESCE(SUM(deleted_at IS NOT NULL AND deleted_at < ?),0) AS eligible,
        COALESCE(SUM(
          strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+0 seconds') IS NOT created_at
          OR (deleted_at IS NOT NULL AND
            strftime('%Y-%m-%dT%H:%M:%fZ',deleted_at,'+0 seconds') IS NOT deleted_at)
        ),0) AS invalid FROM deletion_ledger`,
      args:[before],
    });
    const total=Number(rows[0]?.total);
    const eligible=Number(rows[0]?.eligible);
    const invalid=Number(rows[0]?.invalid);
    if(![total,eligible,invalid].every(n=>Number.isSafeInteger(n)&&n>=0)
      ||eligible>total||invalid!==0) fail('RETENTION_DATA_REFUSED');
    const counts={eligible,purged:0,retained:total};
    if(eligible>RETENTION_MAX_ENTRIES) fail('RETENTION_CAP_EXCEEDED',counts);
    if(dryRun){
      await tx.rollback();
      return {...counts,dry_run:true,target_verified:true};
    }
    const result=await purge(tx,{before});
    if(result.purged!==eligible) fail('RETENTION_COUNT_MISMATCH');
    await tx.commit();
    return {eligible,purged:result.purged,retained:total-result.purged,dry_run:false,target_verified:true};
  }finally{
    if(!tx.closed){ try{ await tx.rollback(); }catch{} }
    tx.close();
  }
}
