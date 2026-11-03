import { inspectSchema } from '../db/schema-inspector.js';
import { inspectLedgerReadiness } from '../db/migration-compatibility.js';
import { READINESS_SCHEMA_MANIFEST } from '../db/schema-readiness-manifest.js';
import { MAX_READINESS_SCHEMA_OBJECTS } from './_health.js';

const TABLES=new Set(['circle_pair_messages','circle_session_runs','circle_pair_room_snapshots','circle_pair_code_documents',
  'circle_session_completion_receipts','circle_pair_session_controls','circle_pair_meeting_links','circle_video_signals',
  'circle_chat_retention_control','circle_chat_retention_scopes','circle_chat_retention_runs','circle_chat_retention_legal_holds','circle_chat_retention_audit_events','circle_pairing_groups','circle_pairing_eligibility','circle_pair_schedules']);
const MANIFEST=Object.freeze({...READINESS_SCHEMA_MANIFEST,artifactScope:'owned',toleratedLegacyTables:[],
  tables:READINESS_SCHEMA_MANIFEST.tables.filter(item=>TABLES.has(item.name)),
  indexes:READINESS_SCHEMA_MANIFEST.indexes.filter(item=>TABLES.has(item.table)),
  triggers:READINESS_SCHEMA_MANIFEST.triggers.filter(item=>TABLES.has(item.table)),
});
export async function ensureSecondaryWorkspaceReadiness(db){
  const ledger=await inspectLedgerReadiness(db);if(!ledger.ready||ledger.currentVersion<24)throw new Error('workspace schema unavailable');
  const schema=await inspectSchema(db,{manifest:MANIFEST,maxSchemaObjects:MAX_READINESS_SCHEMA_OBJECTS});
  if(!schema.ok||schema.warnings.length)throw new Error('workspace schema unavailable');
  return true;
}
