import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
export async function database(through=27){
  const dir=mkdtempSync(join(tmpdir(),'randori-toolkit-465-'));
  const url=`file:${join(dir,'test.db')}`;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,through);
  const before=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:before.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  return {db,url,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
export async function seedPair(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111'),(2,'two@example.test','hash','Two','#222'),(9,'outside@example.test','hash','Outside','#999')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES(10,'2026-W47','2026-11-15T08:00:00.000Z')`);
  await db.execute(`INSERT INTO pairing_groups(id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES(20,10,1,2,0)`);
  await db.execute(`INSERT INTO pairing_participants(week_id,user_id,position,source) VALUES(10,1,0,'auth'),(10,2,1,'auth')`);
}
