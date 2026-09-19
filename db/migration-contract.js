// Runtime-safe immutable ledger metadata. Executable SQL remains in the
// migration-only module; request paths need only these names and checksums.
export const MIGRATION_CONTRACTS=Object.freeze([
  Object.freeze({
    version:1,
    name:'current-application-schema-baseline',
    checksum:'27944847696265114fbbb0e70ffa961a7f766a8f85cc4fe251ef00a779aac0df',
  }),
  Object.freeze({
    version:2,
    name:'primary-circle-membership-schema',
    checksum:'ceca22b30cc4f546359dc8d5731e1ab157e82b748b468e6eed510a8a4379444d',
  }),
  Object.freeze({
    version:3,
    name:'cycle-scoped-availability',
    checksum:'dd467c77944b1da0b722ddd91ebef1071811fb24c65fdff7d2121b67fb204270',
  }),
  Object.freeze({
    version:4,
    name:'provider-scoped-identities',
    checksum:'99e63a04a8617d4dcc12d5ff71ac8590e21ba5a44bdcaba90ead405f42f5625e',
  }),
  Object.freeze({
    version:5,
    name:'durable-revocable-sessions',
    checksum:'cad0dcadb3b75ae267dd6d7ff9393507e122f0d104e648357631a1c4af0b98ad',
  }),
  Object.freeze({
    version:6,
    name:'durable-provider-neutral-outbox',
    checksum:'e62bdb26e9055eeae387e80bbd3dba08130228bf9a42673b2fceecddd9fc2f6b',
  }),
  Object.freeze({
    version:7,
    name:'verified-email-activation',
    checksum:'2f904882cdc996c63492794b7e321560cbe3574871984e51e2d3075b897e95e1',
  }),
  Object.freeze({
    version:8,
    name:'password-reset-and-recent-auth',
    checksum:'60059dfffd4d333e5b90a8eea32f23bc2165a8019911e4b006deeb0f2b68929c',
  }),
  Object.freeze({
    version:9,
    name:'explicit-provider-linking',
    checksum:'226c58e70d0f7dfeae89449dcc567f52afeed46c19c2f9987c510f78029ec560',
  }),
  Object.freeze({
    version:10,
    name:'chat-cursor-and-rate-indexes',
    checksum:'df6508898b4b697ca8d21646c9460aefcc7f85d7fc8f2f027ed10342fe98e014',
  }),
  Object.freeze({
    version:11,
    name:'bounded-chat-retention',
    checksum:'e1e41483cbdff5a10a58ccc144bfadbb818cecb900768495ad8ab64dd393332b',
  }),
  Object.freeze({
    version:12,
    name:'session-bound-active-circle-context',
    checksum:'9443e548fb6edac275eb8af08e7bc007cbfa32e5450efaf444375b976eddf43c',
  }),
  Object.freeze({
    version:13,
    name:'circle-owned-pairing-coordination',
    checksum:'a25458811dba79d04f263b4d4d62a0cbb4e21ce774fd5be3bed87f90266deecf',
  }),
]);

export const LATEST_MIGRATION_VERSION=MIGRATION_CONTRACTS.at(-1)?.version||0;

export function validateMigrationContracts(contracts=MIGRATION_CONTRACTS){
  if(!Array.isArray(contracts)||contracts.length===0) throw new TypeError('migration contracts must not be empty');
  contracts.forEach((contract,index)=>{
    const version=index+1;
    if(contract?.version!==version) throw new Error(`migration contract gap at version ${version}`);
    if(typeof contract.name!=='string'||!contract.name) throw new Error(`migration contract ${version} has no name`);
    if(!/^[a-f0-9]{64}$/.test(String(contract.checksum||''))){
      throw new Error(`migration contract ${version} has an invalid checksum`);
    }
  });
  return true;
}

validateMigrationContracts();
