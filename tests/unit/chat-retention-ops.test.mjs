import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

test('the protected retention workflow is manual, serialized, latest-main only, and count-only',()=>{
  const workflow=readFileSync('.github/workflows/chat-retention.yml','utf8');
  assert.match(workflow,/^name: Chat retention$/m);
  assert.match(workflow,/^\s{2}workflow_dispatch:$/m);
  assert.doesNotMatch(workflow,/^\s{2}(?:schedule|pull_request|pull_request_target):/m);
  assert.match(workflow,/^\s{2}contents: read$/m);
  assert.match(workflow,/group: turso-production-database-operations/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,
    /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow,/environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow,/test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse "origin\/\$\{DEFAULT_BRANCH\}"\)"/);
  assert.match(workflow,/PURGE_EXPIRED_CHAT/);
  assert.match(workflow,/CHAT_RETENTION_ENABLED: \$\{\{ vars\.CHAT_RETENTION_ENABLED \}\}/);
  assert.match(workflow,/CHAT_RETENTION_SCOPE_KEY: \$\{\{ secrets\.CHAT_RETENTION_SCOPE_KEY \}\}/);
  assert.match(workflow,/CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID: \$\{\{ secrets\./);
  assert.match(workflow,/CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID: \$\{\{ secrets\./);
  assert.match(workflow,/timeout --signal=TERM --kill-after=30s 10m/);
  assert.match(workflow,/retention-days: 30/);
  assert.doesNotMatch(workflow,/echo[^\n]*(?:TURSO_|CHAT_RETENTION_(?:SCOPE|CIRCLE|WEEK|PAIR|RUN|.*DIGEST))/);
});

test('the status command emits one sanitized document without scope, content, URL, or SQL',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-retention-cli-'));
  const path=join(directory,'retention.sqlite');
  const db=createClient({url:`file:${path}`});
  try{
    await prepareMigrationConnection(db);
    const before=await inspectMigrationState(db);
    await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    await db.execute(`INSERT INTO pair_messages
      (id,week_id,pair_group_id,sender_id,message,created_at)
      VALUES (73491,81234,92345,63412,'highly-private-content','not-a-time')`);
    const result=spawnSync(process.execPath,['scripts/chat-retention.mjs'],{
      cwd:process.cwd(),encoding:'utf8',
      env:{...process.env,CHAT_RETENTION_ACTION:'status',TURSO_DATABASE_URL:`file:${path}`},
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stderr,'');
    const payload=JSON.parse(result.stdout);
    assert.equal(payload.ok,true);
    assert.equal(payload.metrics.anomalies.unmappedCount,1);
    assert.equal(payload.metrics.anomalies.invalidTimestampCount,1);
    assert.doesNotMatch(result.stdout,/highly-private-content|81234|92345|63412|retention\.sqlite|SELECT|pair_messages/);
  }finally{
    db.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test('command failures expose only a fixed error code',()=>{
  const result=spawnSync(process.execPath,['scripts/chat-retention.mjs'],{
    cwd:process.cwd(),encoding:'utf8',
    env:{...process.env,CHAT_RETENTION_ACTION:'not-valid',TURSO_DATABASE_URL:'file:/private/secret.sqlite'},
  });
  assert.equal(result.status,2);
  assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{ok:false,error_code:'RETENTION_COMMAND_FAILED'});
  assert.doesNotMatch(result.stderr,/private|secret|sqlite/i);
});
