import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { parse } from 'yaml';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { DELETION_LEDGER_DB_SCHEMA, main as cli } from '../../scripts/deletion-ledger.mjs';
import { main, rehearse } from '../../scripts/deletion-ledger-retention.mjs';
import { guardedRetentionPurge, verifyRetentionTarget } from '../../scripts/deletion-ledger-retention-policy.mjs';

const NOW=new Date('2026-11-03T04:23:00.000Z');
const CUTOFF='2026-11-02T04:23:00.000Z';
const OLD='2026-11-02T04:22:59.999Z';
const RECENT='2026-11-02T04:23:00.001Z';
const CREATED='2026-01-01T00:00:00.000Z';

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'randori-ledger-retention-test-'));
  const url=`file:${join(directory,'ledger.db')}`;
  const client=createClient({url});
  t.after(()=>{client.close();rmSync(directory,{recursive:true,force:true});});
  await client.execute(DELETION_LEDGER_DB_SCHEMA);
  const output=join(directory,'github-output');
  const summary=join(directory,'github-summary');
  const env={DELETION_LEDGER_DATABASE_URL:url,RUNNER_TEMP:directory,
    GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary};
  let log='';
  const run=options=>main({env,now:NOW,allowLocal:true,stdout:{write(s){log+=s;}},...options});
  return {client,url,directory,env,run,log:()=>log,output,summary};
}

async function seed(client){
  await client.execute({sql:'INSERT INTO deletion_ledger VALUES (1,?,?),(2,?,?),(3,?,?),(4,NULL,?)',
    args:[OLD,CREATED,CUTOFF,CREATED,RECENT,CREATED,CREATED]});
}
const count=async client=>Number((await client.execute('SELECT COUNT(*) AS n FROM deletion_ledger')).rows[0].n);

test('one-day retention uses the existing purge: >1d deleted, exactly 1d / <1d / null retained',async t=>{
  const f=await fixture(t);
  await seed(f.client);
  const {evidence,exitCode}=await f.run({dryRun:false});
  assert.equal(exitCode,0);
  assert.deepEqual([evidence.eligible,evidence.purged,evidence.retained],[1,1,3]);
  assert.equal(evidence.cutoff,CUTOFF);
  assert.equal(evidence.target_verified,true);
  assert.deepEqual((await f.client.execute('SELECT account_id FROM deletion_ledger ORDER BY account_id')).rows.map(r=>r.account_id),[2,3,4]);
  const again=await f.run({dryRun:false});
  assert.deepEqual([again.evidence.purged,again.evidence.retained],[0,3]);
});

test('dry-run is read-only: counts, unchanged database bytes, no DELETE or write transaction',async t=>{
  const f=await fixture(t);
  await seed(f.client);
  const before=readFileSync(join(f.directory,'ledger.db'));
  const statements=[];
  const createDatabaseClient=config=>{
    const client=createClient(config);
    return {close:()=>client.close(),transaction:async mode=>{
      assert.equal(mode,'read');
      const tx=await client.transaction(mode);
      return {execute:stmt=>{statements.push(stmt.sql);return tx.execute(stmt);},
        rollback:()=>tx.rollback(),get closed(){return tx.closed;},close:()=>tx.close(),
        commit:()=>assert.fail('dry-run must not commit')};
    }};
  };
  const result=await f.run({dryRun:true,createDatabaseClient});
  assert.equal(result.exitCode,0);
  assert.deepEqual([result.evidence.eligible,result.evidence.purged,result.evidence.retained],[1,0,4]);
  assert.ok(statements.every(sql=>/^SELECT/.test(sql)));
  assert.deepEqual(readFileSync(join(f.directory,'ledger.db')),before);
  assert.equal(await count(f.client),4);
});

test('refuses a real fully migrated app DB even if it contains a ledger-shaped table',async t=>{
  const f=await fixture(t);
  const app=await createMigratedDatabase({prefix:'randori-retention-app-refusal-'});
  const client=createClient({url:app.url});
  t.after(()=>{client.close();app.cleanup();});
  await client.execute(DELETION_LEDGER_DB_SCHEMA);
  await seed(client);
  const bytes=readFileSync(app.path);
  for(const dryRun of [true,false]){
    const result=await f.run({env:{...f.env,DELETION_LEDGER_DATABASE_URL:app.url},dryRun});
    assert.equal(result.exitCode,1);
    assert.equal(result.evidence.category,'RETENTION_TARGET_REFUSED');
    assert.equal(result.evidence.target_verified,false);
    assert.equal(await count(client),4);
  }
  assert.deepEqual(readFileSync(app.path),bytes);
});

test('fails closed on empty DB, wrong columns, extra schema objects and destructive triggers',async t=>{
  const f=await fixture(t);
  await f.client.execute('DROP TABLE deletion_ledger');
  const schemas=[[],['CREATE TABLE deletion_ledger(account_id INTEGER,deleted_at TEXT,created_at TEXT)'],
    [DELETION_LEDGER_DB_SCHEMA,'CREATE TABLE extra(value TEXT)'],
    [DELETION_LEDGER_DB_SCHEMA,'CREATE TRIGGER bad AFTER DELETE ON deletion_ledger BEGIN DELETE FROM deletion_ledger; END']];
  for(const statements of schemas){
    for(const stmt of statements) await f.client.execute(stmt);
    await assert.rejects(verifyRetentionTarget(f.client,DELETION_LEDGER_DB_SCHEMA),{code:'RETENTION_TARGET_REFUSED'});
    await f.client.execute('DROP TABLE IF EXISTS deletion_ledger');
    await f.client.execute('DROP TABLE IF EXISTS extra');
  }
});

for(const [label,extraTable,trigger] of [
  ['table',true,false],['trigger',false,true],['table and destructive trigger',true,true],
]){
  test(`sqliteX application ${label} refuses retention before any deletion in both modes`,async t=>{
    const f=await fixture(t);
    await seed(f.client);
    if(extraTable){
      await f.client.execute('CREATE TABLE sqliteX_app(value TEXT)');
      await f.client.execute("INSERT INTO sqliteX_app VALUES ('protected')");
    }
    if(trigger){
      await f.client.execute(`CREATE TRIGGER sqliteX_cleanup AFTER DELETE ON deletion_ledger
        BEGIN DELETE FROM deletion_ledger; ${extraTable?'DELETE FROM sqliteX_app;':''} END;`);
    }
    const ledgerBefore=(await f.client.execute('SELECT * FROM deletion_ledger ORDER BY account_id')).rows;
    for(const dryRun of [true,false]){
      const statements=[];
      let commits=0;
      const createDatabaseClient=config=>{
        const client=createClient(config);
        return {close:()=>client.close(),transaction:async mode=>{
          const tx=await client.transaction(mode);
          return {execute:stmt=>{statements.push(stmt.sql);return tx.execute(stmt);},
            commit:()=>{commits++;return tx.commit();},rollback:()=>tx.rollback(),
            get closed(){return tx.closed;},close:()=>tx.close()};
        }};
      };
      const result=await f.run({dryRun,createDatabaseClient});
      assert.equal(result.exitCode,1);
      assert.equal(result.evidence.category,'RETENTION_TARGET_REFUSED');
      assert.equal(result.evidence.target_verified,false);
      assert.ok(statements.length>0);
      assert.ok(statements.every(sql=>/^SELECT\b/.test(sql)),'refusal must occur before any DELETE');
      assert.equal(commits,0);
      assert.deepEqual((await f.client.execute('SELECT * FROM deletion_ledger ORDER BY account_id')).rows,ledgerBefore);
      if(extraTable){
        assert.deepEqual((await f.client.execute('SELECT value FROM sqliteX_app')).rows.map(r=>r.value),['protected']);
      }
    }
  });
}

test('cap refuses 10,001 eligible entries without writes in both modes; exactly 10,000 can purge',async t=>{
  const f=await fixture(t);
  await f.client.execute({sql:`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
    INSERT INTO deletion_ledger SELECT x,?,? FROM n`,args:[OLD,CREATED]});
  for(const dryRun of [true,false]){
    const result=await f.run({dryRun});
    assert.equal(result.exitCode,1);
    assert.equal(result.evidence.category,'RETENTION_CAP_EXCEEDED');
    assert.deepEqual([result.evidence.eligible,result.evidence.purged,result.evidence.retained],[10001,0,10001]);
    assert.equal(await count(f.client),10001);
  }
  await f.client.execute('UPDATE deletion_ledger SET deleted_at=NULL WHERE account_id=10001');
  const result=await f.run({dryRun:false});
  assert.equal(result.exitCode,0);
  assert.deepEqual([result.evidence.purged,result.evidence.retained],[10000,1]);
});

test('invalid timestamps abort instead of deleting ambiguous records',async t=>{
  const f=await fixture(t);
  for(const time of ['0000-00-00T00:00:00.000Z','2026-02-30T00:00:00.000Z']){
    await f.client.execute({sql:'INSERT OR REPLACE INTO deletion_ledger VALUES (1,?,?)',args:[time,CREATED]});
    const result=await f.run({dryRun:false});
    assert.equal(result.evidence.category,'RETENTION_DATA_REFUSED');
    assert.equal(await count(f.client),1);
  }
});

test('count and existing purge share a write transaction; unexpected delete count rolls back',async t=>{
  const f=await fixture(t);
  await seed(f.client);
  const client={transaction:mode=>{assert.equal(mode,'write');return f.client.transaction(mode);}};
  await assert.rejects(guardedRetentionPurge(client,{before:CUTOFF,expectedSchema:DELETION_LEDGER_DB_SCHEMA,
    purge:async tx=>{
      await tx.execute({sql:'DELETE FROM deletion_ledger WHERE deleted_at < ?',args:[CUTOFF]});
      return {purged:2};
    }}),{code:'RETENTION_COUNT_MISMATCH'});
  assert.equal(await count(f.client),4);
});

const context={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'festus14/randori-circle',GITHUB_REF:'refs/heads/main',
  GITHUB_EVENT_NAME:'schedule',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_WORKFLOW_REF:'festus14/randori-circle/.github/workflows/deletion-ledger-retention.yml@refs/heads/main'};

test('missing credentials, local URLs and wrong workflow context fail before opening a client',async t=>{
  const f=await fixture(t);
  const configured={...context,DELETION_LEDGER_DATABASE_URL:'libsql://synthetic.invalid',DELETION_LEDGER_AUTH_TOKEN:'synthetic-token'};
  const cases=[{...context},{...configured,DELETION_LEDGER_AUTH_TOKEN:''},
    {...configured,DELETION_LEDGER_DATABASE_URL:f.url},{...configured,GITHUB_REF:'refs/heads/topic'},
    {...configured,GITHUB_EVENT_NAME:'pull_request'},{...configured,GITHUB_WORKFLOW_REF:'wrong'},
    {...configured,GITHUB_RUN_ID:'unsafe\nmetadata'}, {...context,TURSO_DATABASE_URL:f.url,TURSO_AUTH_TOKEN:'unused'}];
  for(const env of cases){
    const result=await f.run({env,allowLocal:false,createDatabaseClient:()=>assert.fail('must not connect')});
    assert.equal(result.exitCode,1);
    assert.ok(['RETENTION_CONFIG_REFUSED','RETENTION_CONTEXT_REFUSED'].includes(result.evidence.category));
  }
  assert.equal((await f.run({dryRun:'false'})).exitCode,1);
});

test('provider failures are attempted once and every evidence channel is sanitized',async t=>{
  const f=await fixture(t);
  let attempts=0;
  const secret='token-private host-private url-private db-private SELECT * row-private';
  const result=await f.run({dryRun:false,createDatabaseClient:()=>{
    attempts++;throw Object.assign(new Error(secret),{code:secret});
  }});
  assert.equal(attempts,1);
  assert.equal(result.exitCode,1);
  assert.equal(result.evidence.category,'RETENTION_FAILED');
  for(const text of [f.log(),readFileSync(f.output,'utf8'),readFileSync(f.summary,'utf8'),
    readFileSync(join(f.directory,'deletion-ledger-retention-summary.json'),'utf8')]){
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(f.url));
    assert.ok(!text.includes(CREATED));
  }
  const stored=JSON.parse(readFileSync(join(f.directory,'deletion-ledger-retention-summary.json'),'utf8'));
  assert.deepEqual(stored,result.evidence);
  assert.equal(stored.run_id,'123');
  assert.equal(stored.timestamp,NOW.toISOString());
  const spoofed=await f.run({createDatabaseClient:()=>{
    throw Object.assign(new Error(secret),{code:'RETENTION_CAP_EXCEEDED',counts:{secret}});
  }});
  assert.equal(spoofed.evidence.category,'RETENTION_FAILED');
  assert.ok(!f.log().includes(secret));
});

test('scheduled and manual workflow contexts execute the driver using a redirected disposable DB only',async t=>{
  const f=await fixture(t);
  await seed(f.client);
  const remoteEnv={...f.env,...context,DELETION_LEDGER_DATABASE_URL:'libsql://synthetic.invalid',
    DELETION_LEDGER_AUTH_TOKEN:'synthetic-token',TURSO_DATABASE_URL:'must-not-use',TURSO_AUTH_TOKEN:'must-not-use'};
  const factory=config=>{
    assert.deepEqual(config,{url:'libsql://synthetic.invalid',authToken:'synthetic-token'});
    return createClient({url:f.url});
  };
  for(const [event,dryRun] of [['workflow_dispatch',true],['schedule',false]]){
    const result=await f.run({env:{...remoteEnv,GITHUB_EVENT_NAME:event},allowLocal:false,dryRun,
      createDatabaseClient:factory});
    assert.equal(result.exitCode,0);
    assert.equal(result.evidence.purged,dryRun?0:1);
  }
  assert.equal(await count(f.client),3);
});

test('CLI rejects ambiguous flags; retention dry-run requires a valid cutoff',async t=>{
  const f=await fixture(t);
  for(const argv of [['purge','--before',CUTOFF,'--dry-run'],['init','--retention'],
    ['purge','--before',CUTOFF,'--before',OLD],['purge','--before',CUTOFF,'--retention','--retention']]){
    await assert.rejects(cli({argv,env:f.env}),{code:'DELETION_LEDGER_USAGE'});
  }
  await assert.rejects(cli({argv:['purge','--before','not-a-date','--retention','--dry-run'],env:f.env}),/valid purge cutoff/);
});

test('standalone disposable rehearsal exercises the same driver without ambient credentials',async t=>{
  const f=await fixture(t);
  const result=await rehearse({env:{...f.env,DELETION_LEDGER_DATABASE_URL:'libsql://must-not-connect.invalid',
    DELETION_LEDGER_AUTH_TOKEN:'must-not-use'},stdout:{write(){}}});
  assert.equal(result.exitCode,0);
  assert.deepEqual([result.evidence.eligible,result.evidence.purged,result.evidence.retained],[1,0,4]);
  const child=spawnSync(process.execPath,['scripts/deletion-ledger-retention.mjs','--rehearse'],{
    cwd:process.cwd(),env:{PATH:process.env.PATH,RUNNER_TEMP:f.directory},encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  assert.equal(JSON.parse(child.stdout).dry_run,true);
  const invalid=spawnSync(process.execPath,['scripts/deletion-ledger-retention.mjs','--dry-run','bad'],{encoding:'utf8'});
  assert.equal(invalid.status,1);
  assert.equal(JSON.parse(invalid.stderr).category,'RETENTION_CONFIG_REFUSED');
});

test('workflow separates secret-free PR rehearsal from default-branch production runs',()=>{
  const workflow=parse(readFileSync('.github/workflows/deletion-ledger-retention.yml','utf8'));
  assert.equal(workflow.on.schedule[0].cron,'23 4 * * *');
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default,true);
  assert.deepEqual(workflow.permissions,{contents:'read'});
  const rehearsal=JSON.stringify(workflow.jobs.rehearsal);
  assert.ok(!rehearsal.includes('secrets.'));
  assert.ok(rehearsal.includes('--rehearse'));
  const job=workflow.jobs.retention;
  assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));
  assert.ok(job.if.includes("github.event_name == 'schedule'"));
  assert.equal(job.concurrency['cancel-in-progress'],false);
  const purge=job.steps.find(s=>s.id==='purge');
  assert.deepEqual(Object.keys(purge.env).sort(),['DELETION_LEDGER_AUTH_TOKEN','DELETION_LEDGER_DATABASE_URL','DELETION_LEDGER_RETENTION_DRY_RUN']);
  assert.equal(purge.run,'node scripts/deletion-ledger-retention.mjs --dry-run "$DELETION_LEDGER_RETENTION_DRY_RUN"');
  const artifact=job.steps.find(s=>s.id==='upload');
  assert.equal(artifact.if,'always()');
  assert.equal(artifact.with.path,'${{ runner.temp }}/deletion-ledger-retention-summary.json');
  assert.equal(artifact.with['retention-days'],30);
});
