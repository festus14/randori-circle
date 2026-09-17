import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

import { MigrationError } from '../../db/migrate.js';
import { main } from '../../scripts/migrate.mjs';

test('migration CLI validates configuration and moves a file database to ready', async () => {
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-cli-'));
  const env={TURSO_DATABASE_URL:`file:${join(directory,'test.sqlite')}`};
  const output=[];
  mock.method(process.stdout,'write',chunk=>{
    output.push(String(chunk));
    return true;
  });
  try{
    await assert.rejects(
      main({},[]),
      error=>error instanceof MigrationError && error.code==='MIGRATION_CONFIG_INVALID',
    );
    await assert.rejects(
      main(env,['--unknown']),
      error=>error instanceof MigrationError && error.code==='MIGRATION_CONFIG_INVALID',
    );
    await assert.rejects(
      main(env,['--status']),
      error=>error instanceof MigrationError &&
        error.code==='schema_uninitialized' &&
        error.details?.currentVersion===0,
    );

    const migrated=await main(env,[]);
    assert.equal(migrated.migration.fromVersion,0);
    assert.equal(migrated.migration.toVersion,4);
    assert.equal(migrated.readiness.ready,true);

    const status=await main(env,['--status']);
    assert.equal(status.readiness.ready,true);
    assert.equal(status.readiness.currentVersion,4);
    assert.equal(output.length,2);
    assert.equal(JSON.parse(output[0]).migration.ok,true);
    assert.equal(JSON.parse(output[1]).ready,true);
  }finally{
    mock.restoreAll();
    rmSync(directory,{recursive:true,force:true});
  }
});
