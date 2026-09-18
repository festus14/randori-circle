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
