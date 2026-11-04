import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { parse } from 'yaml';

import { chatRetentionEvidenceBindingDigest } from '../../api/_chat-retention.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { runChatRetentionCli } from '../../scripts/chat-retention.mjs';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

// Replay the actual workflow shell against a disposable remote and database.
// Advancing main models the time spent waiting for environment approval.
async function replayRetentionWorkflow({advance=false,checkoutLatest=false,staleAcceptance=false}={}){
  const workflow=parse(readFileSync('.github/workflows/chat-retention.yml','utf8'));
  const steps=workflow.jobs.retention.steps;
  const checkout=steps.find(step=>step.uses?.startsWith('actions/checkout@'));
  const guard=steps.find(step=>step.name==='Refuse stale workflow code');
  const operation=steps.find(step=>step.id==='retention');
  const directory=mkdtempSync(join(tmpdir(),'randori-retention-workflow-'));
  const repository=join(directory,'checkout');
  const remote=join(directory,'remote.git');
  const output=join(directory,'github-output');
  let db;
  try{
    mkdirSync(repository);
    for(const path of ['api','db','scripts','package.json']){
      cpSync(path,join(repository,path),{recursive:true});
    }
    symlinkSync(join(process.cwd(),'node_modules'),join(repository,'node_modules'),'dir');
    const git=(...args)=>{
      const result=spawnSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],{
        cwd:repository,encoding:'utf8',timeout:30_000,
      });
      assert.equal(result.status,0,result.stderr);
      return result.stdout.trim();
    };
    git('init','--bare',remote);
    git('init','--initial-branch=main');
    git('config','user.name','Retention workflow test');
    git('config','user.email','retention@example.test');
    git('add','api','db','scripts','package.json');
    git('commit','-m','Accepted dispatch');
    const acceptedSha=git('rev-parse','HEAD');
    const dispatchSha=acceptedSha;
    git('remote','add','origin',remote);
    git('push','origin','main');
    if(advance){
      appendFileSync(join(repository,'scripts/chat-retention.mjs'),'\n// Main advanced during approval.\n');
      git('commit','-am','Advance main during approval');
      git('push','origin','main');
    }
    const latestSha=git('rev-parse','main');
    const resolveExpression=expression=>{
      if(expression==='github.sha') return dispatchSha;
      if(expression==='github.event.repository.default_branch') return 'main';
      if(expression.startsWith('steps.')&&expression.endsWith('.outputs.release_sha')){
        assert.equal(expression,`steps.${guard.id}.outputs.release_sha`);
        return readFileSync(output,'utf8').match(/^release_sha=(.+)$/m)?.[1]||'';
      }
      if(expression.startsWith('secrets.')||expression.startsWith('vars.')){
        return fixtureEnv[expression.split('.')[1]]||'';
      }
      const inputs={
        'inputs.operation':'purge','inputs.confirmation':'PURGE_EXPIRED_CHAT',
        'inputs.environment':'production',
        'inputs.staging_rehearsal_sha':staleAcceptance?'0'.repeat(40):acceptedSha,
        'inputs.production_dry_run_sha':acceptedSha,
        "inputs.operation == 'dry-run' && 'dry_run' || inputs.operation == 'purge' && 'run' || inputs.operation":'run',
        "inputs.operation == 'purge' && 'purge' || 'dry_run'":'purge',
        "inputs.storage == 'secondary' && '--secondary-workspace' || ''":'',
      };
      assert.ok(Object.hasOwn(inputs,expression),`unknown workflow expression: ${expression}`);
      return inputs[expression];
    };
    const render=value=>value.replace(/\$\{\{\s*(.*?)\s*\}\}/g,(_,expression)=>resolveExpression(expression));
    const ref=checkoutLatest?'main':render(checkout.with.ref);
    git('checkout','--detach',ref);
    const checkoutSha=git('rev-parse','HEAD');

    const path=join(directory,'retention.sqlite');
    await copyMigratedDatabase(path);
    db=createClient({url:`file:${path}`});
    await prepareMigrationConnection(db);
    await db.batch([
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
        (2,'a@example.test','hash','A','#111111'),(3,'b@example.test','hash','B','#222222')`,
      `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W01','2026-01-01')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id) VALUES (20,10,2,3)`,
    ],'write');
    const scope={scopeKey:'local',circleId:null,weekId:10,pairGroupId:20};
    const fixtureEnv={TURSO_DATABASE_URL:`file:${path}`,TURSO_AUTH_TOKEN:'',
      CHAT_RETENTION_ENABLED:'true',CHAT_RETENTION_SCOPE_KEY:'local',
      CHAT_RETENTION_WEEK_ID:'10',CHAT_RETENTION_PAIR_GROUP_ID:'20'};
    await runChatRetentionCli({env:{...fixtureEnv,CHAT_RETENTION_ACTION:'adopt_scope',
      CHAT_RETENTION_LOCAL_ADOPTION:'true'}});
    await runChatRetentionCli({env:{...fixtureEnv,CHAT_RETENTION_ACTION:'enable',
      CHAT_RETENTION_EXPECTED_GENERATION:'0'}});
    const times=(await db.execute(`SELECT
      strftime('%Y-%m-%dT00:00:00.000Z','now','-90 days') AS cutoff,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes') AS exported,
      strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute') AS backup`)).rows[0];
    for(const kind of ['backup','export']){
      const evidence={digest:(kind==='backup'?'a':'b').repeat(64),sourceMaxMessageId:1,
        throughAt:String(times.cutoff),completedAt:String(times[kind==='backup'?'backup':'exported'])};
      const prefix=`CHAT_RETENTION_${kind.toUpperCase()}`;
      Object.assign(fixtureEnv,{
        [`${prefix}_EVIDENCE_DIGEST`]:evidence.digest,
        [`${prefix}_SCOPE_BINDING_DIGEST`]:chatRetentionEvidenceBindingDigest({kind,scope,...evidence}),
        [`${prefix}_SOURCE_MAX_MESSAGE_ID`]:'1',
        [`${prefix}_THROUGH_AT`]:evidence.throughAt,
        [`${prefix}_COMPLETED_AT`]:evidence.completedAt,
      });
    }
    await db.execute({sql:`INSERT INTO pair_messages
      (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (1,10,20,2,'synthetic',?)`,
    args:[new Date(Date.parse(times.cutoff)-1000).toISOString()]});
    const shell=step=>spawnSync('bash',['-c',render(step.run)],{
      cwd:repository,encoding:'utf8',timeout:30_000,
      env:{PATH:process.env.PATH,RUNNER_TEMP:directory,GITHUB_OUTPUT:output,
        ...Object.fromEntries(Object.entries(step.env||{}).map(([key,value])=>[key,render(value)]))},
    });
    const validation=shell(steps.find(step=>step.name==='Validate protected operation'));
    assert.equal(validation.status,0,validation.stderr);
    const verification=shell(guard);
    const purge=verification.status===0?shell(operation):null;
    const count=async table=>(await db.execute(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count;
    return {
      dispatchSha,checkoutSha,latestSha,verificationStatus:verification.status,
      purgeStatus:purge?.status??null,purgeError:purge?.stderr.trim()||'',
      deleted:purge?.status===0?JSON.parse(purge.stdout).worker.deleted:0,
      remaining:await count('pair_messages'),runs:await count('chat_retention_runs'),
      auditEvents:await count('chat_retention_audit_events'),
    };
  }finally{
    db?.close();
    rmSync(directory,{recursive:true,force:true});
  }
}

test('approval-time main advances refuse the pinned dispatch and a substituted latest checkout',async t=>{
  for(const checkoutLatest of [false,true]){
    const result=await replayRetentionWorkflow({advance:true,checkoutLatest});
    t.diagnostic(JSON.stringify({checkoutLatest,...result}));
    assert.notEqual(result.dispatchSha,result.latestSha);
    assert.equal(result.checkoutSha,checkoutLatest?result.latestSha:result.dispatchSha);
    assert.equal(result.verificationStatus,1,'stale dispatch or substituted checkout must be refused');
    assert.equal(result.purgeStatus,null,'purge must not execute after failed verification');
    assert.deepEqual([result.deleted,result.remaining,result.runs,result.auditEvents],[0,1,0,0]);
  }
});

test('matching checkout, dispatch, latest main and accepted SHAs allow the workflow purge',async t=>{
  const result=await replayRetentionWorkflow();
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.checkoutSha,result.dispatchSha);
  assert.equal(result.checkoutSha,result.latestSha);
  assert.equal(result.verificationStatus,0);
  assert.equal(result.purgeStatus,0,result.purgeError);
  assert.deepEqual([result.deleted,result.remaining,result.runs],[1,0,1]);
  assert.ok(result.auditEvents>0);
});

test('the verified workflow release refuses stale acceptance before enqueue or deletion',async t=>{
  const result=await replayRetentionWorkflow({staleAcceptance:true});
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.verificationStatus,0);
  assert.equal(result.purgeStatus,2);
  assert.deepEqual(JSON.parse(result.purgeError),{ok:false,error_code:'RETENTION_REHEARSAL_GATE_REQUIRED'});
  assert.deepEqual([result.deleted,result.remaining,result.runs,result.auditEvents],[0,1,0,0]);
});

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
  assert.match(workflow,/ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow,/retention_dispatch_sha: \$\{\{ github\.sha \}\}/);
  assert.match(workflow,/test "\$\{checkout_sha\}" = "\$\{retention_dispatch_sha\}"/);
  assert.match(workflow,/test "\$\{checkout_sha\}" = "\$\(git rev-parse "origin\/\$\{DEFAULT_BRANCH\}"\)"/);
  assert.match(workflow,/PURGE_EXPIRED_CHAT/);
  assert.match(workflow,/CHAT_RETENTION_ENABLED: \$\{\{ vars\.CHAT_RETENTION_ENABLED \}\}/);
  assert.match(workflow,/inputs\.operation == 'dry-run' && 'dry_run'/);
  assert.match(workflow,/retention_release_sha: \$\{\{ steps\.release\.outputs\.release_sha \}\}/);
  assert.match(workflow,/retention_target_stage: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow,/retention_staging_rehearsal_sha: \$\{\{ inputs\.staging_rehearsal_sha \}\}/);
  assert.match(workflow,/retention_production_dry_run_sha: \$\{\{ inputs\.production_dry_run_sha \}\}/);
  assert.match(workflow,/--staging-rehearsal-sha "\$\{retention_staging_rehearsal_sha\}"/);
  assert.match(workflow,/--production-dry-run-sha "\$\{retention_production_dry_run_sha\}"/);
  assert.match(workflow,/CHAT_RETENTION_SCOPE_KEY: \$\{\{ secrets\.CHAT_RETENTION_SCOPE_KEY \}\}/);
  assert.match(workflow,/CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID: \$\{\{ secrets\./);
  assert.match(workflow,/CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID: \$\{\{ secrets\./);
  assert.match(workflow,/timeout --signal=TERM --kill-after=30s 10m/);
  assert.match(workflow,/retention-days: 30/);
  assert.doesNotMatch(workflow,/echo[^\n]*(?:TURSO_|CHAT_RETENTION_(?:SCOPE|CIRCLE|WEEK|PAIR|RUN|.*DIGEST))/);
});

test('pair chat renders the visible private-beta retention policy',()=>{
  const app=readFileSync('index.html','utf8');
  assert.match(app,/testId:'pair-chat-retention-policy'/);
  assert.match(app,/Private-beta chat retention is 90 days/);
  assert.match(app,/Legal or export holds and safety pauses may retain messages longer/);
});

test('the status command emits one sanitized document without scope, content, URL, or SQL',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-retention-cli-'));
  const path=join(directory,'retention.sqlite');
  await copyMigratedDatabase(path);
  const db=createClient({url:`file:${path}`});
  try{
    await prepareMigrationConnection(db);
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
    // Left as-is (#418): cannot trip — the status payload is aggregate counts
    // only (one fixture message; anomaly counts capped at 1001), never the row
    // ids/content, so the 5-digit sentinels cannot appear in stdout.
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
