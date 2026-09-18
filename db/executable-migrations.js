import { MIGRATION_PLANS, validateMigrationPlans } from './migration-plan.js';
import { LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS } from './migration-contract.js';
import { checksum } from './schema-manifest.js';

export const ROLLOUT_SINGLETON_OPERATION=Object.freeze({
  operation:'ensure-row',
  name:'circle_membership_rollout:1',
  table:'circle_membership_rollout',
  sql:`INSERT INTO circle_membership_rollout (id,registrations_closed,updated_at)
    VALUES (1,0,datetime('now')) ON CONFLICT(id) DO NOTHING`,
});

function executableOperations(plan){
  return Object.freeze([
    ...plan.operations,
    ...(plan.version===2?[ROLLOUT_SINGLETON_OPERATION]:[]),
  ]);
}

export function checksumExecutableMigration({version,name,planChecksum,operations}){
  return checksum({version,name,planChecksum,operations});
}

function defineExecutableMigration(plan,metadata){
  if(!metadata||metadata.version!==plan.version||metadata.name!==plan.name){
    throw new Error(`migration plan ${plan.version} has no execution metadata`);
  }
  const operations=executableOperations(plan);
  const payload={version:plan.version,name:plan.name,planChecksum:plan.checksum,operations};
  const calculatedChecksum=checksumExecutableMigration(payload);
  if(calculatedChecksum!==metadata.checksum){
    throw new Error(`Immutable executable migration ${plan.version} changed: ${calculatedChecksum}`);
  }
  return Object.freeze({...payload,checksum:calculatedChecksum});
}

export const EXECUTABLE_MIGRATIONS=Object.freeze(
  MIGRATION_PLANS.map((plan,index)=>defineExecutableMigration(plan,MIGRATION_CONTRACTS[index])),
);

export { LATEST_MIGRATION_VERSION };

export function validateExecutableMigrations(migrations=EXECUTABLE_MIGRATIONS,plans=MIGRATION_PLANS){
  validateMigrationPlans(plans);
  if(!Array.isArray(migrations)||migrations.length===0||migrations.length>plans.length){
    throw new TypeError('executable migrations must be a non-empty migration-plan prefix');
  }
  migrations.forEach((migration,index)=>{
    const plan=plans[index];
    const expectedVersion=index+1;
    if(!migration||migration.version!==expectedVersion||plan.version!==expectedVersion){
      throw new Error(`executable migration gap at version ${expectedVersion}`);
    }
    if(migration.name!==plan.name||migration.planChecksum!==plan.checksum){
      throw new Error(`executable migration ${expectedVersion} does not match its immutable plan`);
    }
    const canonical=EXECUTABLE_MIGRATIONS[index];
    if(canonical&&migration.checksum!==canonical.checksum){
      throw new Error(`executable migration ${expectedVersion} checksum is not the pinned execution checksum`);
    }
    if(!Array.isArray(migration.operations)||migration.operations.length<plan.operations.length){
      throw new Error(`executable migration ${expectedVersion} has no operations`);
    }
    migration.operations.forEach(operation=>{
      if(!['ensure-table','ensure-index','ensure-row'].includes(operation?.operation)){
        throw new Error(`executable migration ${expectedVersion} contains an unsupported operation`);
      }
      if(typeof operation.sql!=='string'||!operation.sql.trim()||operation.sql.includes(';')){
        throw new Error(`executable migration ${expectedVersion} contains invalid SQL`);
      }
      if(operation.operation==='ensure-row'
        &&(operation.name!==ROLLOUT_SINGLETON_OPERATION.name
          ||operation.table!==ROLLOUT_SINGLETON_OPERATION.table
          ||operation.sql!==ROLLOUT_SINGLETON_OPERATION.sql)){
        throw new Error(`executable migration ${expectedVersion} contains an unsupported state operation`);
      }
    });
    const planOperations=migration.operations.slice(0,plan.operations.length);
    if(checksum(planOperations)!==plan.operationsChecksum){
      throw new Error(`executable migration ${expectedVersion} changed its canonical plan operations`);
    }
    if(checksumExecutableMigration(migration)!==migration.checksum){
      throw new Error(`executable migration ${expectedVersion} checksum does not match`);
    }
  });
  return true;
}

validateExecutableMigrations();
