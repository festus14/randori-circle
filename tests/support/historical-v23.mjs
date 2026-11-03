// Model the historical additive v23 release without relaxing the current v25 contract.
import { mock } from 'node:test';
import * as contracts from '../../db/migration-contract.js';
import { SCHEMA_OPERATION_SETS, TOLERATED_LEGACY_TABLES, resolveCurrentArtifacts } from '../../db/schema-manifest.js';
import { compileSchemaReadinessManifest } from '../../db/schema-inspector.js';
// Compile/cache the real executable plans before installing request-time historical contracts.
export const { EXECUTABLE_MIGRATIONS }=await import('../../db/executable-migrations.js');
export const V23_CONTRACTS=Object.freeze(contracts.MIGRATION_CONTRACTS.slice(0,23));
const sets=SCHEMA_OPERATION_SETS.slice(0,23);
const manifest=compileSchemaReadinessManifest({version:1,checksum:'a'.repeat(64),
  tables:resolveCurrentArtifacts(sets,'ensure-table'),indexes:resolveCurrentArtifacts(sets,'ensure-index'),
  triggers:resolveCurrentArtifacts(sets,'ensure-trigger'),toleratedLegacyTables:[...TOLERATED_LEGACY_TABLES]});
mock.module('../../db/migration-contract.js',{exports:{...contracts,MIGRATION_CONTRACTS:V23_CONTRACTS,LATEST_MIGRATION_VERSION:23}});
mock.module('../../db/schema-readiness-manifest.js',{exports:{READINESS_SCHEMA_MANIFEST:manifest}});
