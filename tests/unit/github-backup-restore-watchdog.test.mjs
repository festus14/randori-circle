import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  assessMonitorArtifacts,
  assessScheduledRuns,
  BACKUP_WATCHDOG_FORMAT,
  discoverAuthoritativeEvidence,
  main,
  verifyDownloadedMonitor,
} from '../../scripts/github-backup-restore-watchdog.mjs';

const NOW=Date.parse('2026-09-22T06:00:00.000Z');
const ACTIVATION='2026-09-21T03:17:00.000Z';
const MAX_AGE=8*24*60*60*1000;
const STUCK_AFTER=90*60*1000;
const COMMIT='a'.repeat(40);
const DIGEST='b'.repeat(64);
const resources=[];

afterEach(()=>{
  while(resources.length) rmSync(resources.pop(),{recursive:true,force:true});
});

function run(overrides={}){
  return {
    id:123,run_attempt:2,event:'schedule',head_branch:'main',status:'completed',
    conclusion:'success',head_sha:COMMIT,
    created_at:'2026-09-21T03:17:00Z',updated_at:'2026-09-21T03:40:00Z',
    ...overrides,
  };
}

function runOptions(overrides={}){
  return {defaultBranch:'main',maxRunAgeMs:MAX_AGE,stuckAfterMs:STUCK_AFTER,
    slotGraceMs:2*60*60*1000,slotDeadlineMs:3.5*60*60*1000,
    activationAt:ACTIVATION,clock:()=>NOW,...overrides};
}

function discovery(){
  const selected=assessScheduledRuns([run()],runOptions());
  return assessMonitorArtifacts([{
    id:456,name:'turso-backup-monitor-123-2',expired:false,
    created_at:'2026-09-21T03:40:00Z',
  }],selected,{maxRunAgeMs:MAX_AGE,clock:()=>NOW});
}

function monitorSummary(overrides={}){
  return {
    ok:true,kind:'turso-backup-monitor',format:'randori.turso-backup-monitor.v1',
    status:'healthy',alert:false,category:null,checkedAt:'2026-09-21T03:39:00.000Z',
    owner:'repository-operations',cadence:'weekly',runId:123,runAttempt:2,repoCommit:COMMIT,
    objectives:{rpoTargetMs:1_800_000,rtoTargetMs:900_000,sourceSnapshotAgeMs:1_000,
      restoredSnapshotAgeMs:5_000,restoreDurationMs:4_000},
    counts:{tableCount:37,totalRows:84,sequenceRows:8,appliedMigrationCount:2},
    checksums:{schemaManifest:DIGEST,sourceMigrations:DIGEST,finalMigrations:DIGEST,
      restoreComparison:DIGEST},
    cleanup:{sourceWriteStateRestored:true,restoreDeleted:true},
    ...overrides,
  };
}

test('scheduled-run assessment alerts on absence, failure, staleness, and a stuck run',()=>{
  assert.equal(assessScheduledRuns([],runOptions()).category,'run_missing');
  assert.equal(assessScheduledRuns([run({head_sha:'main'})],runOptions()).category,'run_missing');
  assert.equal(assessScheduledRuns([run({conclusion:'failure'})],runOptions()).category,'run_failed');
  assert.equal(assessScheduledRuns([run()],runOptions({maxRunAgeMs:60*60*1000})).category,
    'run_stale');
  assert.equal(assessScheduledRuns([run({
    status:'waiting',conclusion:null,created_at:'2026-09-22T03:17:00Z',
    updated_at:'2026-09-22T03:17:00Z',
  })],runOptions()).category,'run_stuck');
});

test('bootstrap is explicit before activation and invents no expected rehearsal timestamp',()=>{
  const result=assessScheduledRuns([run({
    id:100,created_at:'2026-09-14T03:17:00Z',updated_at:'2026-09-14T03:40:00Z',
  })],runOptions({clock:()=>Date.parse('2026-09-21T03:16:59.999Z')}));
  assert.deepEqual(result,{
    ok:false,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,
    status:'setup_pending',alert:false,category:'setup_pending',
    checkedAt:'2026-09-21T03:16:59.999Z',owner:'@festus14',cadence:'hourly',
    activationAt:ACTIVATION,
    requiredAction:'configure_protected_rehearsal_and_wait_for_activation',
  });
  assert.equal('expectedAt' in result,false);
  assert.equal('runId' in result,false);
});

test('activation is schedule-aligned and fails closed without post-activation evidence',()=>{
  const historical=run({
    id:100,created_at:'2026-09-14T03:17:00Z',updated_at:'2026-09-14T03:40:00Z',
  });
  const active=assessScheduledRuns([historical],runOptions({clock:()=>Date.parse(ACTIVATION)}));
  assert.equal(active.status,'alert');
  assert.equal(active.category,'run_missing');
  assert.equal(active.activationAt,ACTIVATION);
  assert.equal(active.expectedAt,ACTIVATION);

  for(const activationAt of [
    '2026-09-21T03:17:00Z','2026-09-21T03:17:00.0Z','2026-09-21T03:17:00.00Z',ACTIVATION,
  ]){
    const accepted=assessScheduledRuns([],runOptions({activationAt,
      clock:()=>Date.parse('2026-09-21T03:16:59.999Z')}));
    assert.equal(accepted.activationAt,ACTIVATION);
  }

  for(const activationAt of [
    'invalid','2026-09-21T03:18:00.000Z','2026-09-22T03:17:00.000Z',
    '2027-02-29T03:17:00.000Z',
  ]){
    assert.throws(()=>assessScheduledRuns([],runOptions({activationAt})),
      /control activation epoch/);
  }
});

test('the current Monday slot is required immediately after its bounded grace',()=>{
  const previous=run();
  const beforeGrace=assessScheduledRuns([previous],runOptions({
    clock:()=>Date.parse('2026-09-28T04:30:00.000Z'),
  }));
  assert.equal(beforeGrace.candidate,true);
  assert.equal(beforeGrace.expectedAt,'2026-09-21T03:17:00.000Z');

  const missed=assessScheduledRuns([previous],runOptions({
    clock:()=>Date.parse('2026-09-28T05:47:00.000Z'),
  }));
  assert.equal(missed.category,'run_missing');
  assert.equal(missed.expectedAt,'2026-09-28T03:17:00.000Z');
});

test('a prior post-activation success stays verifiable through a later slot grace',()=>{
  const graceNow=Date.parse('2026-09-28T04:30:00.000Z');
  const priorSuccess=run();
  const currentRun=run({
    id:124,run_attempt:1,status:'in_progress',conclusion:null,
    created_at:'2026-09-28T03:17:00Z',updated_at:'2026-09-28T03:17:00Z',
  });
  const selected=assessScheduledRuns([currentRun,priorSuccess],runOptions({clock:()=>graceNow}));
  assert.equal(selected.candidate,true);
  assert.equal(selected.runId,123);
  assert.equal(selected.activationAt,ACTIVATION);
  assert.equal(selected.expectedAt,'2026-09-21T03:17:00.000Z');

  const candidate=assessMonitorArtifacts([{
    id:456,name:'turso-backup-monitor-123-2',expired:false,
    created_at:'2026-09-21T03:40:00Z',
  }],selected,{maxRunAgeMs:MAX_AGE,clock:()=>graceNow});
  assert.equal(candidate.status,'candidate');
  assert.equal(candidate.activationAt,ACTIVATION);

  const verified=verifyDownloadedMonitor(monitorSummary(),candidate,{
    maxRunAgeMs:MAX_AGE,activationAt:ACTIVATION,clock:()=>graceNow,
  });
  assert.equal(verified.status,'healthy');
  assert.equal(verified.activationAt,ACTIVATION);
  assert.equal(verified.expectedAt,'2026-09-21T03:17:00.000Z');
});

test('a stale prior-success alert retains the reviewed activation epoch',()=>{
  const result=assessScheduledRuns([
    run({created_at:'2026-09-21T03:17:00Z',updated_at:'2026-09-21T03:40:00Z'}),
    run({id:124,run_attempt:1,status:'in_progress',conclusion:null,
      created_at:'2026-09-28T03:17:00Z',updated_at:'2026-09-28T03:17:00Z'}),
  ],runOptions({maxRunAgeMs:6*24*60*60*1000,
    clock:()=>Date.parse('2026-09-28T04:30:00.000Z')}));
  assert.equal(result.category,'run_stale');
  assert.equal(result.activationAt,ACTIVATION);
  assert.equal(result.expectedAt,'2026-09-21T03:17:00.000Z');
});

test('a grace-edge run cannot reset the absolute current-slot deadline',()=>{
  const graceEdge=run({id:124,run_attempt:1,status:'in_progress',conclusion:null,
    created_at:'2026-09-21T05:17:00Z',updated_at:'2026-09-21T05:17:00Z'});
  const observing=assessScheduledRuns([graceEdge],runOptions({
    clock:()=>Date.parse('2026-09-21T05:47:00.000Z'),
  }));
  assert.equal(observing.status,'observing');
  assert.equal(observing.alert,false);

  const stuck=assessScheduledRuns([graceEdge],runOptions({
    clock:()=>Date.parse('2026-09-21T06:47:00.000Z'),
  }));
  assert.equal(stuck.category,'run_stuck');
});

test('an arbitrarily late run still alerts on the last watchdog tick before four hours',()=>{
  const late=run({id:125,run_attempt:1,status:'in_progress',conclusion:null,
    created_at:'2026-09-21T06:46:00Z',updated_at:'2026-09-21T06:46:00Z'});
  const result=assessScheduledRuns([late],runOptions({
    clock:()=>Date.parse('2026-09-21T06:47:00.000Z'),
  }));
  assert.equal(result.category,'run_stuck');
  assert.equal(result.expectedAt,'2026-09-21T03:17:00.000Z');
});

test('artifact assessment requires one exact, fresh, unexpired monitor artifact',()=>{
  const candidate=assessScheduledRuns([run()],runOptions());
  assert.equal(assessMonitorArtifacts([],candidate,{maxRunAgeMs:MAX_AGE,clock:()=>NOW}).category,
    'artifact_missing');
  assert.equal(assessMonitorArtifacts([{
    id:456,name:'turso-backup-monitor-123-2',expired:true,created_at:'2026-09-21T03:40:00Z',
  }],candidate,{maxRunAgeMs:MAX_AGE,clock:()=>NOW}).category,'artifact_expired');
  assert.equal(assessMonitorArtifacts([{
    id:456,name:'turso-backup-monitor-123-2',expired:false,created_at:'2026-09-01T03:40:00Z',
  }],candidate,{maxRunAgeMs:MAX_AGE,clock:()=>NOW}).category,'artifact_stale');
  assert.deepEqual(discovery(),{
    ok:true,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,status:'candidate',
    alert:false,category:null,checkedAt:'2026-09-22T06:00:00.000Z',owner:'@festus14',
    cadence:'hourly',activationAt:ACTIVATION,
    expectedAt:'2026-09-21T03:17:00.000Z',runId:123,runAttempt:2,
    repoCommit:COMMIT,
    runCreatedAt:'2026-09-21T03:17:00.000Z',
    artifactId:456,artifactName:'turso-backup-monitor-123-2',
    artifactCreatedAt:'2026-09-21T03:40:00.000Z',
  });
});

test('download verification accepts only an exact healthy PII-free monitor projection',()=>{
  const healthy=verifyDownloadedMonitor(monitorSummary(),discovery(),{
    maxRunAgeMs:MAX_AGE,activationAt:ACTIVATION,clock:()=>NOW,
  });
  assert.equal(healthy.status,'healthy');
  assert.equal(healthy.activationAt,ACTIVATION);
  assert.equal(healthy.cleanup.restoreDeleted,true);

  for(const altered of [
    monitorSummary({runId:999}),
    monitorSummary({repoCommit:'c'.repeat(40)}),
    monitorSummary({objectives:{...monitorSummary().objectives,rpoTargetMs:3_600_000}}),
    monitorSummary({privateRecipient:'person@example.test'}),
    monitorSummary({cleanup:{sourceWriteStateRestored:true,restoreDeleted:false}}),
    monitorSummary({checkedAt:'2026-09-01T03:39:00.000Z'}),
  ]){
    const result=verifyDownloadedMonitor(altered,discovery(),{
      maxRunAgeMs:MAX_AGE,activationAt:ACTIVATION,clock:()=>NOW,
    });
    assert.equal(result.category,'artifact_corrupt');
    assert.doesNotMatch(JSON.stringify(result),/person@example\.test/);
  }

  for(const alteredDiscovery of [
    {...discovery(),activationAt:'2026-09-28T03:17:00.000Z'},
    {...discovery(),activationAt:'2026-09-14T03:17:00.000Z'},
    {...discovery(),activationAt:'2026-09-21T03:18:00.000Z'},
    {...discovery(),expectedAt:'2026-09-21T03:17:00.001Z'},
    Object.fromEntries(Object.entries(discovery()).filter(([key])=>key!=='activationAt')),
  ]){
    const result=verifyDownloadedMonitor(monitorSummary(),alteredDiscovery,{
      maxRunAgeMs:MAX_AGE,activationAt:ACTIVATION,clock:()=>NOW,
    });
    assert.equal(result.category,'artifact_corrupt');
    assert.equal(result.activationAt,ACTIVATION);
    assert.equal(!result.expectedAt||Date.parse(result.expectedAt)>=Date.parse(ACTIVATION),true);
  }
});

test('discovery queries only scheduled default-branch runs and binds the exact artifact',async()=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url,authorization:options.headers.authorization});
    const value=url.includes('/artifacts?')?{artifacts:[{
      id:456,name:'turso-backup-monitor-123-2',expired:false,
      created_at:'2026-09-21T03:40:00Z',
    }]}:{workflow_runs:[run()]};
    return {ok:true,async json(){ return value; }};
  };
  const result=await discoverAuthoritativeEvidence({
    GITHUB_REPOSITORY:'festus14/randori-circle',WATCHDOG_DEFAULT_BRANCH:'main',
    GITHUB_API_URL:'https://api.github.com',GITHUB_TOKEN:'private-watchdog-token',
    WATCHDOG_CONTROL_ACTIVATION_AT:ACTIVATION,
    WATCHDOG_MAX_RUN_AGE_MS:String(MAX_AGE),WATCHDOG_STUCK_AFTER_MS:String(STUCK_AFTER),
    WATCHDOG_SLOT_GRACE_MS:String(2*60*60*1000),
    WATCHDOG_SLOT_DEADLINE_MS:String(3.5*60*60*1000),
  },{fetchImpl,clock:()=>NOW});
  assert.equal(result.status,'candidate');
  assert.equal(result.repoCommit,COMMIT);
  assert.match(requests[0].url,
    /actions\/workflows\/turso-backup-restore-rehearsal\.yml\/runs\?branch=main&event=schedule&per_page=10$/);
  assert.match(requests[1].url,/actions\/runs\/123\/artifacts\?per_page=100$/);
  assert.deepEqual(requests.map(item=>item.authorization),[
    'Bearer private-watchdog-token','Bearer private-watchdog-token',
  ]);
  assert.doesNotMatch(JSON.stringify(result),/private-watchdog-token/);
});

test('pre-activation discovery reports setup without querying GitHub',async()=>{
  let requests=0;
  const result=await discoverAuthoritativeEvidence({
    GITHUB_REPOSITORY:'festus14/randori-circle',WATCHDOG_DEFAULT_BRANCH:'main',
    GITHUB_API_URL:'https://api.github.com',GITHUB_TOKEN:'private-watchdog-token',
    WATCHDOG_CONTROL_ACTIVATION_AT:ACTIVATION,
    WATCHDOG_MAX_RUN_AGE_MS:String(MAX_AGE),WATCHDOG_STUCK_AFTER_MS:String(STUCK_AFTER),
    WATCHDOG_SLOT_GRACE_MS:String(2*60*60*1000),
    WATCHDOG_SLOT_DEADLINE_MS:String(3.5*60*60*1000),
  },{fetchImpl:async()=>{ requests+=1; throw new Error('must not fetch'); },
    clock:()=>Date.parse('2026-09-20T17:00:00.000Z')});
  assert.equal(result.status,'setup_pending');
  assert.equal(result.ok,false);
  assert.equal(result.alert,false);
  assert.equal(requests,0);
});

test('pre-activation CLI persists a non-ready setup artifact without alerting',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-backup-watchdog-setup-'));
  resources.push(directory);
  const output=join(directory,'backup-watchdog-summary.json');
  const githubOutput=join(directory,'github-output');
  writeFileSync(githubOutput,'',{mode:0o600});
  const execution=await main({
    argv:['--mode','discover','--output',output],
    environment:{
      RUNNER_TEMP:directory,GITHUB_OUTPUT:githubOutput,
      GITHUB_REPOSITORY:'festus14/randori-circle',WATCHDOG_DEFAULT_BRANCH:'main',
      GITHUB_API_URL:'https://api.github.com',GITHUB_TOKEN:'private-watchdog-token',
      WATCHDOG_CONTROL_ACTIVATION_AT:ACTIVATION,
      WATCHDOG_MAX_RUN_AGE_MS:String(MAX_AGE),WATCHDOG_STUCK_AFTER_MS:String(STUCK_AFTER),
      WATCHDOG_SLOT_GRACE_MS:String(2*60*60*1000),
      WATCHDOG_SLOT_DEADLINE_MS:String(3.5*60*60*1000),
    },
    fetchImpl:async()=>{ throw new Error('must not fetch'); },stdout:{write(){}},
    clock:()=>Date.parse('2026-09-20T17:00:00.000Z'),
  });
  assert.equal(execution.exitCode,0);
  assert.equal(execution.result.status,'setup_pending');
  assert.equal(execution.result.ok,false);
  assert.equal(execution.result.alert,false);
  assert.equal('expectedAt' in execution.result,false);
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),execution.result);
  assert.equal(readFileSync(githubOutput,'utf8'),
    'alert=false\ncategory=setup_pending\ncandidate=false\n');
});

test('discovery API failures become fixed alerts without leaking credentials or provider text',async()=>{
  const privateError='private-watchdog-token person@example.test';
  const directory=mkdtempSync(join(tmpdir(),'randori-backup-watchdog-api-'));
  resources.push(directory);
  const execution=await main({
    argv:['--mode','discover','--output',join(directory,'backup-watchdog-summary.json')],
    environment:{
      RUNNER_TEMP:directory,GITHUB_REPOSITORY:'festus14/randori-circle',
      WATCHDOG_DEFAULT_BRANCH:'main',GITHUB_API_URL:'https://api.github.com',
      GITHUB_TOKEN:'private-watchdog-token',WATCHDOG_CONTROL_ACTIVATION_AT:ACTIVATION,
      WATCHDOG_MAX_RUN_AGE_MS:String(MAX_AGE),
      WATCHDOG_STUCK_AFTER_MS:String(STUCK_AFTER),WATCHDOG_SLOT_GRACE_MS:String(2*60*60*1000),
      WATCHDOG_SLOT_DEADLINE_MS:String(3.5*60*60*1000),
    },
    fetchImpl:async()=>{ throw new Error(privateError); },stdout:{write(){}},clock:()=>NOW,
  });
  assert.equal(execution.exitCode,0);
  assert.equal(execution.result.category,'api_failure');
  assert.doesNotMatch(JSON.stringify(execution.result),/private-watchdog-token|person@example\.test/);
});

test('CLI converts a missing downloaded artifact into sanitized evidence and outputs',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-backup-watchdog-'));
  resources.push(directory);
  const output=join(directory,'backup-watchdog-summary.json');
  const githubOutput=join(directory,'github-output');
  writeFileSync(output,`${JSON.stringify(discovery())}\n`,{mode:0o600});
  writeFileSync(githubOutput,'',{mode:0o600});
  let stdout='';
  const execution=await main({
    argv:['--mode','verify','--discovery',output,'--monitor-summary',
      join(directory,'backup-monitor-summary.json'),'--output',output],
    environment:{RUNNER_TEMP:directory,GITHUB_OUTPUT:githubOutput,
      WATCHDOG_CONTROL_ACTIVATION_AT:ACTIVATION,WATCHDOG_MAX_RUN_AGE_MS:String(MAX_AGE)},
    stdout:{write(value){ stdout+=value; }},clock:()=>NOW,
  });
  assert.equal(execution.exitCode,0);
  assert.equal(execution.result.category,'artifact_corrupt');
  assert.deepEqual(JSON.parse(readFileSync(output,'utf8')),execution.result);
  assert.deepEqual(JSON.parse(stdout),execution.result);
  assert.equal(readFileSync(githubOutput,'utf8'),
    'alert=true\ncategory=artifact_corrupt\ncandidate=false\n');
});

test('watchdog workflow is independent, read-only, hourly, and production-secret-free',()=>{
  const workflow=readFileSync('.github/workflows/turso-backup-restore-watchdog.yml','utf8');
  const rehearsal=readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8');
  assert.match(workflow,/cron: '47 \* \* \* \*'/);
  assert.match(rehearsal,/cron: '17 3 \* \* 1'/);
  assert.equal((rehearsal.match(/REHEARSAL_RPO_TARGET_MS: '1800000'/g)||[]).length,2);
  assert.equal((rehearsal.match(/REHEARSAL_RTO_TARGET_MS: '900000'/g)||[]).length,2);
  assert.match(workflow,/WATCHDOG_SLOT_GRACE_MS: '7200000'/);
  assert.match(workflow,/WATCHDOG_SLOT_DEADLINE_MS: '12600000'/);
  assert.equal((workflow.match(
    /WATCHDOG_CONTROL_ACTIVATION_AT: '2026-09-21T03:17:00\.000Z'/g)||[]).length,2);
  assert.match(workflow,/group: turso-backup-restore-watchdog/);
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/scripts\/github-backup-restore-watchdog\.mjs/);
  assert.match(workflow,/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow,/actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(workflow,/id: upload[\s\S]+steps\.upload\.outcome != 'success'/);
  assert.match(workflow,/Backup restore watchdog alert for @festus14/);
  assert.doesNotMatch(workflow,/environment:\s*turso|secrets\.|TURSO_PRODUCTION_PLATFORM_TOKEN/);
  assert.doesNotMatch(workflow,
    /turso-backup-restore-rehearsal\.mjs|gh\s+workflow\s+run|actions\/workflows\/[^\s]+\/dispatches/);
});
