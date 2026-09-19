import { INDEXES, SCHEMA_OPERATION_SETS, TABLES, checksum } from './schema-manifest.js';

const PLAN_METADATA=Object.freeze([
  Object.freeze({
    version:1,
    name:'current-application-schema-baseline',
    description:'Declarative baseline for the pre-membership Randori schema; inspection only.',
    operationsChecksum:'2291bdea8c396ce13b3760c15e81b42f027e40cf3d4748400b208f3b06834cdf',
    checksum:'f5d7b032abc2848fe63fbcc14264f210e488c7b9b9fd33b073affb191dca085a',
  }),
  Object.freeze({
    version:2,
    name:'primary-circle-membership-schema',
    description:'Declarative identity and invitation schema introduced with primary-circle membership; inspection only.',
    operationsChecksum:'896b4f35344c19a0c70ef091d95a0b50af36d66259893ef6a0b0782c8b8d574a',
    checksum:'ceb0f119d72971762c5c1d9c93e6000386fc90fe43bbf0a9713f326932059d28',
  }),
  Object.freeze({
    version:3,
    name:'cycle-scoped-availability',
    description:'Per-scope weekly availability with immutable cycle contracts and optimistic versions.',
    operationsChecksum:'73abd55d97917fc5fede6aff7a5bc8394a6408319e87a6bd295eaca3d7a0e7b5',
    checksum:'0f88f5d6c9b305cb2bef7601aeaf3259615c8d7e59443ea66060bdafe1a6e948',
  }),
  Object.freeze({
    version:4,
    name:'provider-scoped-identities',
    description:'Stable OpenID Connect issuer and subject mappings for authenticated accounts.',
    operationsChecksum:'18831c331d9bd1fdf835eae05dc1457ecc761bfabb673601f0920329f9811121',
    checksum:'9c234c1b040b0470db8a4e6edcce957adcdbc9efa5a02275a468cc6854df6bb0',
  }),
  Object.freeze({
    version:5,
    name:'durable-revocable-sessions',
    description:'Hashed, bounded browser and Bearer sessions with durable revocation state.',
    operationsChecksum:'d5a2f7fc1beded3486c29cd419ac4941ad5d8b43ae5485764606575c7e64a918',
    checksum:'f6dcccada588712be68f1e02ea48c688b6cc3d48d3f4ff36764d6e1259ca5e34',
  }),
  Object.freeze({
    version:6,
    name:'durable-provider-neutral-outbox',
    description:'Versioned transactional events with bounded leases, retries, dead letters, and replay audit.',
    operationsChecksum:'8cb0d17a3c0fb53519d3b02843e534b90447b48b00c3fb0f1da0af75b38ee17b',
    checksum:'f64e694d6f493128347f3544a6a03af62b77d4e4a8f00592ed85055ae2a5d68b',
  }),
  Object.freeze({
    version:7,
    name:'verified-email-activation',
    description:'Invitation-bound password activation with hashed single-use verification credentials.',
    operationsChecksum:'a2be692ef8f352abc3038ad315117fd00c6a235d07a678f9742ba156e51e8bc7',
    checksum:'5379a4f70f7da440b6669bb4880320da240710fb7b56f61f28ad44e7817e5f48',
  }),
  Object.freeze({
    version:8,
    name:'password-reset-and-recent-auth',
    description:'Hashed one-time password recovery credentials and session-scoped recent-authentication evidence.',
    operationsChecksum:'55e683b76ac5cf24c93d3aa6cb60fab738b4957a6d6f12cdaffa5728c5ea68e2',
    checksum:'38226e8955ff195c11c5d8a7282d4adb70d7189395615f3ae1e718e9cacaebb6',
  }),
]);

function definePlan(operationSet,metadata){
  if(operationSet.version!==metadata.version) throw new Error(`migration operation set ${operationSet.version} has no matching metadata`);
  const operationsChecksum=checksum(operationSet.operations);
  if(operationsChecksum!==metadata.operationsChecksum){
    throw new Error(`Immutable migration plan ${metadata.version} operations changed: ${operationsChecksum}`);
  }
  const operations=operationSet.operations;
  const tables=Object.freeze(operations.filter(item=>item.operation==='ensure-table').map(item=>item.name));
  const indexes=Object.freeze(operations.filter(item=>item.operation==='ensure-index').map(item=>item.name));
  const checksummed={
    version:metadata.version,
    name:metadata.name,
    description:metadata.description,
    operationsChecksum,
    operations,
    tables,
    indexes,
  };
  const calculatedChecksum=checksum(checksummed);
  if(calculatedChecksum!==metadata.checksum){
    throw new Error(`Immutable migration plan ${metadata.version} checksum changed: ${calculatedChecksum}`);
  }
  return Object.freeze({...checksummed,checksum:calculatedChecksum});
}

export const MIGRATION_PLANS=Object.freeze(SCHEMA_OPERATION_SETS.map((operationSet,index)=>definePlan(operationSet,PLAN_METADATA[index])));
export const LATEST_PLAN_VERSION=MIGRATION_PLANS.at(-1)?.version||0;

const SQLITE_IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]*$/;

function validateCanonicalOperation(operation,planVersion,availableTables){
  if(!operation||typeof operation!=='object'||Array.isArray(operation)){
    throw new Error(`migration plan ${planVersion} contains an invalid canonical operation`);
  }
  if(!['ensure-table','ensure-index'].includes(operation.operation)){
    throw new Error(`migration plan ${planVersion} contains unsupported operation ${JSON.stringify(operation.operation)}`);
  }
  if(typeof operation.name!=='string'||!SQLITE_IDENTIFIER.test(operation.name)
    ||typeof operation.sql!=='string'||operation.sql.includes(';')){
    throw new Error(`migration plan ${planVersion} contains an invalid ${operation.operation} definition`);
  }
  if(operation.operation==='ensure-table'){
    const match=/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\([\s\S]*\)\s*$/i.exec(operation.sql);
    if(!match||match[1]!==operation.name){
      throw new Error(`migration plan ${planVersion} table ${operation.name} has a non-canonical CREATE TABLE definition`);
    }
    availableTables.add(operation.name);
    return;
  }
  if(typeof operation.table!=='string'||!SQLITE_IDENTIFIER.test(operation.table)
    ||!Array.isArray(operation.keyParts)||operation.keyParts.length===0
    ||operation.keyParts.some(part=>typeof part!=='string'||!part.trim())
    ||typeof operation.unique!=='boolean'
    ||!(operation.where===null||(typeof operation.where==='string'&&operation.where.trim()))){
    throw new Error(`migration plan ${planVersion} index ${operation.name} has an invalid canonical definition`);
  }
  if(!availableTables.has(operation.table)){
    throw new Error(`migration plan ${planVersion} index ${operation.name} references unknown table ${operation.table}`);
  }
  const expectedSql=`CREATE ${operation.unique?'UNIQUE ':''}INDEX IF NOT EXISTS ${operation.name} ON ${operation.table}(${operation.keyParts.join(',')})${operation.where?` WHERE ${operation.where}`:''}`;
  if(operation.sql!==expectedSql){
    throw new Error(`migration plan ${planVersion} index ${operation.name} has a non-canonical CREATE INDEX definition`);
  }
}

export function validateMigrationPlans(plans=MIGRATION_PLANS){
  if(!Array.isArray(plans)||plans.length===0) throw new TypeError('migration plans must not be empty');
  const availableTables=new Set();
  plans.forEach((plan,index)=>{
    const expectedVersion=index+1;
    if(plan.version!==expectedVersion) throw new Error(`migration plan gap at version ${expectedVersion}`);
    if(typeof plan.name!=='string'||!plan.name) throw new Error(`migration plan ${expectedVersion} has no name`);
    if(!Array.isArray(plan.operations)||plan.operations.length===0) throw new Error(`migration plan ${expectedVersion} has no operations`);
    const operationKeys=plan.operations.map(item=>`${item.operation}:${item.name}`);
    const duplicateOperations=[...new Set(operationKeys.filter((key,position)=>operationKeys.indexOf(key)!==position))].sort();
    if(duplicateOperations.length){
      throw new Error(`migration plan ${plan.version} repeats canonical operations: ${JSON.stringify(duplicateOperations)}`);
    }
    if(checksum(plan.operations)!==plan.operationsChecksum){
      throw new Error(`migration plan ${plan.version} operations checksum does not match its canonical operations`);
    }
    plan.operations.forEach(operation=>validateCanonicalOperation(operation,plan.version,availableTables));
    const tables=plan.operations.filter(item=>item.operation==='ensure-table').map(item=>item.name);
    const indexes=plan.operations.filter(item=>item.operation==='ensure-index').map(item=>item.name);
    if(JSON.stringify(tables)!==JSON.stringify(plan.tables)||JSON.stringify(indexes)!==JSON.stringify(plan.indexes)){
      throw new Error(`migration plan ${plan.version} artifact lists do not match its canonical operations`);
    }
    const checksummed={
      version:plan.version,
      name:plan.name,
      description:plan.description,
      operationsChecksum:plan.operationsChecksum,
      operations:plan.operations,
      tables:plan.tables,
      indexes:plan.indexes,
    };
    if(checksum(checksummed)!==plan.checksum) throw new Error(`migration plan ${plan.version} checksum does not match its metadata`);
  });
  for(const [kind,expected] of [['table',TABLES.map(item=>item.name)],['index',INDEXES.map(item=>item.name)]]){
    const operation=kind==='table'?'ensure-table':'ensure-index';
    const declared=plans.flatMap(plan=>plan.operations.filter(item=>item.operation===operation).map(item=>item.name));
    const actual=[...new Set(declared)];
    const missing=expected.filter(name=>!actual.includes(name)).sort();
    const unknown=actual.filter(name=>!expected.includes(name)).sort();
    if(missing.length||unknown.length){
      throw new Error(`migration plans do not cover current manifest ${kind}s: ${JSON.stringify({missing,unknown})}`);
    }
  }
  return true;
}

// Validate at import time so a changed historical operation cannot silently
// reach either inspection command.
validateMigrationPlans();
