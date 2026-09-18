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

export function validateMigrationPlans(plans=MIGRATION_PLANS){
  if(!Array.isArray(plans)||plans.length===0) throw new TypeError('migration plans must not be empty');
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
