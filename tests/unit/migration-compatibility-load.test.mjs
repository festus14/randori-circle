// A migration that is declared additive but is not (ID-87, #371) stops the
// migration tooling from loading at all, so db:migrate, the protected
// production workflow and the restore rehearsal can never apply it, and the
// deployability gate reports it. Migration 20 adds triggers to existing
// pairing tables, so declaring it additive must be refused.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { MIGRATION_PLANS } from '../../db/migration-plan.js';

const realContract=await import('../../db/migration-contract.js?compatibility-load=real');
const V20=MIGRATION_PLANS[19];
const MISLABELLED=Object.freeze(realContract.MIGRATION_CONTRACTS.map(contract=>contract.version===20
  ?Object.freeze({
    ...contract,
    compatibility:'additive',
    introduces:Object.freeze({tables:[...V20.tables],indexes:[...V20.indexes],triggers:[...V20.triggers]}),
  })
  :contract));
mock.module('../../db/migration-contract.js',{exports:{...realContract,MIGRATION_CONTRACTS:MISLABELLED}});

test('migration tooling refuses to load a mislabelled additive migration',async()=>{
  // The declaration itself is well formed; only the migration check sees through it.
  assert.equal(realContract.validateMigrationContracts(MISLABELLED),true);
  await assert.rejects(import('../../db/executable-migrations.js'),error=>{
    assert.equal(error.code,'MIGRATION_COMPATIBILITY_INVALID');
    assert.match(error.message,/^migration 20 is marked additive but trigger_on_existing_table \(ensure-trigger trg_pairing_groups_code_documents_invalidate: PAIRING_GROUPS\)/);
    return true;
  });
  await assert.rejects(import('../../db/migration-runner.js'),{code:'MIGRATION_COMPATIBILITY_INVALID'});
  const { inspectMigrationReleaseContract }=await import('../../scripts/check-deployability.mjs');
  const errors=await inspectMigrationReleaseContract();
  assert.equal(errors.length,1);
  assert.match(errors[0],/^migration release contract: migration 20 is marked additive but trigger_on_existing_table/);
});
