// Runtime-safe immutable ledger metadata. Executable SQL remains in the
// migration-only module; request paths need only these names and checksums.
//
// `compatibility` says how a migration may be released (ID-87, #371):
// - 'breaking': code that knows this version is ready only once the database
//   is at it. Merging it takes readiness down until the protected cutover runs.
// - 'additive': only new tables, new indexes, and triggers or seed rows on
//   those new tables. Code that knows this version is also ready one version
//   behind, so it can merge first and the cutover can run afterwards.
//   `introduces` lists exactly the artifacts it adds; readiness does not
//   require them yet, and code reaches them only behind
//   api/_schema-capability.js.
// db/migration-compatibility-check.js (migration-only) proves an additive
// migration really is additive. Migrations 1-21 shipped under the strict
// release order and stay 'breaking': the code that shipped with them assumes
// their schema is present, so relabelling them would make readiness lie.
export const MIGRATION_COMPATIBILITY=Object.freeze({
  ADDITIVE:'additive',
  BREAKING:'breaking',
});

export const MIGRATION_CONTRACTS=Object.freeze([
  Object.freeze({
    version:1,
    name:'current-application-schema-baseline',
    checksum:'27944847696265114fbbb0e70ffa961a7f766a8f85cc4fe251ef00a779aac0df',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:2,
    name:'primary-circle-membership-schema',
    checksum:'ceca22b30cc4f546359dc8d5731e1ab157e82b748b468e6eed510a8a4379444d',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:3,
    name:'cycle-scoped-availability',
    checksum:'dd467c77944b1da0b722ddd91ebef1071811fb24c65fdff7d2121b67fb204270',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:4,
    name:'provider-scoped-identities',
    checksum:'99e63a04a8617d4dcc12d5ff71ac8590e21ba5a44bdcaba90ead405f42f5625e',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:5,
    name:'durable-revocable-sessions',
    checksum:'cad0dcadb3b75ae267dd6d7ff9393507e122f0d104e648357631a1c4af0b98ad',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:6,
    name:'durable-provider-neutral-outbox',
    checksum:'e62bdb26e9055eeae387e80bbd3dba08130228bf9a42673b2fceecddd9fc2f6b',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:7,
    name:'verified-email-activation',
    checksum:'2f904882cdc996c63492794b7e321560cbe3574871984e51e2d3075b897e95e1',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:8,
    name:'password-reset-and-recent-auth',
    checksum:'60059dfffd4d333e5b90a8eea32f23bc2165a8019911e4b006deeb0f2b68929c',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:9,
    name:'explicit-provider-linking',
    checksum:'226c58e70d0f7dfeae89449dcc567f52afeed46c19c2f9987c510f78029ec560',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:10,
    name:'chat-cursor-and-rate-indexes',
    checksum:'df6508898b4b697ca8d21646c9460aefcc7f85d7fc8f2f027ed10342fe98e014',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:11,
    name:'bounded-chat-retention',
    checksum:'e1e41483cbdff5a10a58ccc144bfadbb818cecb900768495ad8ab64dd393332b',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:12,
    name:'session-bound-active-circle-context',
    checksum:'9443e548fb6edac275eb8af08e7bc007cbfa32e5450efaf444375b976eddf43c',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:13,
    name:'circle-owned-pairing-coordination',
    checksum:'54b73ffd4cbc009af58c40110b6387d15c2ec52f7f9c082ef69b1258c691d122',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:14,
    name:'transactional-circle-creation',
    checksum:'cb99ca24aa032f941f582cdccbc942fd3f00c3d1fe495c1cd3330a37f3ee8ea8',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:15,
    name:'durable-credential-key-control',
    checksum:'3b715ac6c5f4d4efa6d628bcc01fad8dccc189b855c5dd0ecf7625e1dc3b1a34',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:16,
    name:'circle-owned-pair-scheduling',
    checksum:'916a3c1b5f8108d92fe9cc3a71d17441781c378b2be9662c351a85e78a13a418',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:17,
    name:'participant-session-completion-receipts',
    checksum:'b75ffcc2762110d36d9b7011b6591c99076e559de9c4df76107218ed3be67ed5',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:18,
    name:'private-schedule-bound-meeting-links',
    checksum:'2e4006db5baa026eafd538dda4c8694654dea6343453b222208ae53f6b962135',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:19,
    name:'durable-pair-session-controls',
    checksum:'b61e5a5e55a0bc5012815ba7aa07c645776b269faf2ef796faf359a1385dd483',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:20,
    name:'bounded-source-bound-code-documents',
    checksum:'e9ddba8da87a5e6a5ccbb29fb9c4956de6b66ee1430c5e58c49cbd3688c9e3c6',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:21,
    name:'public-invite-requests',
    checksum:'b68bd2fbb88e0cae3ce125a16b2f20dac48ea3f2600e179ad9dcc5a33f3f42e8',
    compatibility:'breaking',
  }),
  Object.freeze({
    version:22,
    name:'feedback-platform',
    checksum:'a4aba4b1ee643086c231a2dfa9d4733930251efc580cf7ac24fbdb3396fb47ca',
    compatibility:'additive',
    introduces:Object.freeze({
      tables:Object.freeze(['feedback_items','feedback_votes','feedback_events']),
      indexes:Object.freeze(['idx_feedback_items_author','idx_feedback_items_circle_status',
        'idx_feedback_items_closed_retention','uq_feedback_items_author_idempotency',
        'idx_feedback_votes_feedback','idx_feedback_votes_user','idx_feedback_events_feedback']),
      triggers:Object.freeze([]),
    }),
  }),
]);

export const LATEST_MIGRATION_VERSION=MIGRATION_CONTRACTS.at(-1)?.version||0;

const SQLITE_IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]*$/;
export const INTRODUCED_ARTIFACT_KINDS=Object.freeze(['tables','indexes','triggers']);

// Tables, indexes and triggers share SQLite's one schema namespace, so names
// must be unique across all three lists.
function validIntroducedArtifacts(introduces){
  if(!introduces||typeof introduces!=='object'||Array.isArray(introduces)) return false;
  if(Object.keys(introduces).sort().join(',')!=='indexes,tables,triggers') return false;
  if(!INTRODUCED_ARTIFACT_KINDS.every(kind=>Array.isArray(introduces[kind]))) return false;
  const names=INTRODUCED_ARTIFACT_KINDS.flatMap(kind=>introduces[kind]);
  return names.length>0&&names.every(name=>typeof name==='string'&&SQLITE_IDENTIFIER.test(name))
    &&new Set(names).size===names.length;
}

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
  contracts.forEach(contract=>{
    const {version}=contract;
    if(contract.compatibility===MIGRATION_COMPATIBILITY.BREAKING){
      if(contract.introduces!==undefined){
        throw new Error(`breaking migration contract ${version} must not list introduced artifacts`);
      }
      return;
    }
    if(contract.compatibility!==MIGRATION_COMPATIBILITY.ADDITIVE){
      throw new Error(`migration contract ${version} must declare compatibility 'additive' or 'breaking'`);
    }
    // The baseline has no earlier version for code to be ready on.
    if(version===1) throw new Error('migration contract 1 cannot be additive');
    if(!validIntroducedArtifacts(contract.introduces)){
      throw new Error(`additive migration contract ${version} must list the tables, indexes and triggers it introduces`);
    }
  });
  return true;
}

validateMigrationContracts();
