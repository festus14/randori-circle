#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { MigrationError, runMigrations } from '../db/migrate.js';
import { checkDatabaseReadiness } from '../db/readiness.js';

function statusDetails(readiness) {
  return {
    currentVersion:readiness.currentVersion,
    latestVersion:readiness.latestVersion,
    pendingVersions:readiness.pendingVersions,
    missingTables:readiness.missingTables,
    missingIndexes:readiness.missingIndexes,
    missingColumns:readiness.missingColumns,
    columnDrift:readiness.columnDrift,
    indexDrift:readiness.indexDrift,
    missingUniqueConstraints:readiness.missingUniqueConstraints,
    foreignKeyDrift:readiness.foreignKeyDrift,
    foreignKeysEnabled:readiness.foreignKeysEnabled,
    missingMigrationArtifacts:readiness.missingMigrationArtifacts,
  };
}

export async function main(env=process.env, argv=process.argv.slice(2)) {
  const unexpected=argv.filter(argument=>argument!=='--status');
  if(unexpected.length||argv.filter(argument=>argument==='--status').length>1){
    throw new MigrationError('Usage: node scripts/migrate.mjs [--status]',{code:'MIGRATION_CONFIG_INVALID'});
  }
  const url=env.TURSO_DATABASE_URL;
  if(!url) throw new MigrationError('TURSO_DATABASE_URL is required',{code:'MIGRATION_CONFIG_INVALID'});
  const client=createClient({url,authToken:env.TURSO_AUTH_TOKEN||undefined});
  try{
    if(argv.includes('--status')){
      const readiness=await checkDatabaseReadiness(client);
      if(!readiness.ready){
        throw new MigrationError('Database is not ready',{
          code:readiness.reason||'schema_mismatch',
          details:statusDetails(readiness),
        });
      }
      process.stdout.write(`${JSON.stringify({ok:true,ready:true,...statusDetails(readiness)})}\n`);
      return {readiness};
    }
    const migration=await runMigrations(client);
    const readiness=await checkDatabaseReadiness(client);
    if(!readiness.ready){
      throw new MigrationError('Database failed post-migration readiness checks',{
        code:'MIGRATION_VERIFICATION_FAILED',
        details:{reason:readiness.reason},
      });
    }
    process.stdout.write(`${JSON.stringify({migration,readiness:{ready:true,currentVersion:readiness.currentVersion,latestVersion:readiness.latestVersion}})}\n`);
    return {migration,readiness};
  }finally{
    client.close();
  }
}

const isMain=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  main().catch(error=>{
    const code=error instanceof MigrationError?error.code:'MIGRATION_FAILED';
    const details=error instanceof MigrationError?error.details:undefined;
    process.stderr.write(`${JSON.stringify({ok:false,error:code,message:error.message,...(details||{})})}\n`);
    process.exitCode=1;
  });
}
