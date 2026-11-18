import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { executeProgram } from '../../api/_execution.js';
import { prepareExecutionSnapshot, executionWarmSnapshot, executionWarmStatus, WARM_SNAPSHOT_EXPIRATION_MS } from '../../api/_execution-warm.js';
import { main as prepareCli } from '../../scripts/execution-prewarm.mjs';
import { readExecutionQueueHealth } from '../../api/_execution-queue.js';
import { warmMeasurementCohort, summarizeStartupPairs, sanitizeStartupMeasurement, readStartupMeasurement } from '../../api/_execution-measurement.js';
import { runExecutionSmoke, EXECUTION_SMOKE_EXPECTED_OUTPUT, recordExecutionSmoke } from '../../api/_execution-smoke.js';
import { assessExecutionSmoke } from '../../scripts/github-execution-smoke.mjs';

const env={EXECUTION_QUEUE_ENABLED:'true',EXECUTION_PROVIDER:'vercel-sandbox',JWT_SECRET:'test-secret-for-execution-warm'.repeat(2),
  EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID:'snap_pristine_js',EXECUTION_WARM_PYTHON_SNAPSHOT_ID:'snap_pristine_py'};
const measured={...env,EXECUTION_WARM_MEASURE_ENABLED:'true'};
async function fixture(t){const file=await createMigratedDatabase({prefix:'randori-warm-test-'}),db=createClient({url:file.url});t.after(()=>{db.close();file.cleanup();});return db;}
function sdk({createFails=false,cleanupFails=false,snapshot=true}={}){
  const calls={create:[],commands:[],files:[],snapshots:[],deleted:0,stopped:0};
  return{calls,Sandbox:{async create(params){calls.create.push(params);if(createFails)throw new Error('provider private error');return{
    async writeFiles(files){calls.files.push(files);},
    async runCommand(params){calls.commands.push(params);params.stdout?.write('ok');return{exitCode:0};},
    snapshot:snapshot?async opts=>{calls.snapshots.push(opts);return{snapshotId:'snap_generated'};}:undefined,
    async delete(){calls.deleted++;if(cleanupFails)throw new Error('down');},async stop(){calls.stopped++;if(cleanupFails)throw new Error('down');},
  };}}};
}

test('pinned SDK 3.8.0 supports the exact snapshot creation/restoration API, no made-up image+snapshot option',()=>{
  const pkg=JSON.parse(readFileSync(new URL('../../node_modules/@vercel/sandbox/package.json',import.meta.url),'utf8'));
  assert.equal(pkg.version,'3.8.0');
  const declarations=readFileSync(new URL('../../node_modules/@vercel/sandbox/dist/sandbox.d.ts',import.meta.url),'utf8');
  assert.match(declarations,/type: "snapshot";\s+snapshotId: string;/);
  assert.match(declarations,/snapshot\(opts\?: \{[\s\S]*?expiration\?: number;[\s\S]*?\}\): Promise<Snapshot>/);
  assert.match(declarations,/image\?: never;/);
});

test('pristine snapshots are opt-in, strictly validated and never disclosed in warm health',()=>{
  assert.equal(executionWarmSnapshot('javascript',{...env,EXECUTION_QUEUE_ENABLED:'false'}),null);
  assert.equal(executionWarmSnapshot('python',{...env,EXECUTION_WARM_PYTHON_SNAPSHOT_ID:''}),null);
  for(const id of [' https://provider/secret','snap bad',123,'snap_','secret'])assert.throws(()=>executionWarmSnapshot('python',{...env,EXECUTION_WARM_PYTHON_SNAPSHOT_ID:id}));
  assert.deepEqual(executionWarmStatus(env),{javascript:{supported:true,configured:true},python:{supported:true,configured:true}});
});

test('warm runs restore fresh, isolated snapshots; no submission can contaminate a later run',async t=>{
  const db=await fixture(t),fake=sdk();
  const options={env,db,executionContext:{userId:1,circleId:1,operation:'test'},loadSandboxSdk:async()=>fake};
  const warm=await executeProgram({language:'javascript',source:'PRIVATE_SOURCE'},options);
  const cold=await executeProgram({language:'javascript',source:'OTHER_SOURCE'},{...options,cold:true});
  assert.equal(warm.startup.mode,'snapshot');assert.equal(cold.startup.mode,'cold');
  assert.deepEqual(fake.calls.create[0].source,{type:'snapshot',snapshotId:'snap_pristine_js'});
  assert.equal(Object.hasOwn(fake.calls.create[0],'image'),false);
  assert.equal(fake.calls.create[1].image,'vercel/sandbox/node:24');
  for(const params of fake.calls.create){assert.equal(params.networkPolicy,'deny-all');assert.equal(params.persistent,false);assert.equal(Object.hasOwn(params,'env'),false);}
  assert.equal(fake.calls.snapshots.length,0,'submitted work never becomes a snapshot');
  assert.equal(fake.calls.deleted,2);assert.equal(fake.calls.commands[0].timeoutMs,10000);
});

test('stale snapshot/create/cleanup failures never trigger a second cold VM, and retain spend leases when uncertain',async t=>{
  const db=await fixture(t),fake=sdk({createFails:true});
  await assert.rejects(executeProgram({language:'javascript',source:'PRIVATE'}, {env,db,executionContext:{userId:1,circleId:1,operation:'test'},loadSandboxSdk:async()=>fake}));
  assert.equal(fake.calls.create.length,1);assert.equal((await readExecutionQueueHealth(db,{env})).activeUnits,1);
  const badCleanup=sdk({cleanupFails:true});
  await executeProgram({language:'javascript',source:'PRIVATE'}, {env,db,executionContext:{userId:2,circleId:2,operation:'test'},loadSandboxSdk:async()=>badCleanup});
  assert.equal(badCleanup.calls.deleted,1);assert.equal(badCleanup.calls.stopped,1);
  assert.equal((await readExecutionQueueHealth(db,{env})).activeUnits,2);
});

test('operator builder snapshots only an empty egress-denied interpreter with finite expiry, cleans VM',async()=>{
  const fake=sdk();const lifecycle=[];
  const result=await prepareExecutionSnapshot('python',{Sandbox:fake.Sandbox,lifecycle:event=>lifecycle.push(event)});
  assert.equal(result.snapshotId,'snap_generated');assert.equal(result.expirationMs,WARM_SNAPSHOT_EXPIRATION_MS);
  assert.deepEqual(fake.calls.commands[0].args,['--version']);assert.equal(fake.calls.commands[0].cmd,'python3');
  assert.equal(fake.calls.files.length,0);assert.equal(fake.calls.create[0].persistent,false);assert.equal(fake.calls.create[0].networkPolicy,'deny-all');
  assert.equal(fake.calls.snapshots[0].expiration,30*86400000);assert.deepEqual(lifecycle,['start','stopped']);
  const old=sdk({snapshot:false});await assert.rejects(prepareExecutionSnapshot('python',{Sandbox:old.Sandbox}),/snapshot support/);assert.equal(old.calls.deleted,1);
});

test('operator CLI refuses absent confirmation/flags before even reading credentials, and counts authorized fake preparation',async t=>{
  let touched=false;
  for(const [argv,flags] of [[[],env],[['python'],env],[['python','--confirm-spend'],{}],[['ruby','--confirm-spend'],env]])
    await assert.rejects(prepareCli({argv,env:flags,dbFactory:()=>{touched=true;throw new Error('forbidden');}}));
  assert.equal(touched,false);
  const db=await fixture(t),fake=sdk(),lines=[];
  await prepareCli({argv:['javascript','--confirm-spend'],env,dbFactory:()=>db,loadSdk:async()=>fake,output:s=>lines.push(s)});
  assert.match(lines[0],/^EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID=snap_generated$/);
  const health=await readExecutionQueueHealth(db,{env});assert.equal(health.recent.admitted,1);assert.equal(health.activeUnits,0);
});

test('paired p95 does not claim a benefit from one sample, rejects malformed fields, and measures both directions',()=>{
  const sample=summarizeStartupPairs([{coldMs:1000,snapshotMs:400}]);assert.equal(sample.improved,null);assert.equal(sample.sufficient,false);
  const better=summarizeStartupPairs(Array.from({length:20},(_,i)=>({coldMs:1000+i,snapshotMs:400+i})));
  assert.equal(better.improved,true);assert.equal(better.improvementMs,600);assert.equal(better.cold.p95,1018);
  const body={windowDays:30,samplesTruncated:false,languages:{javascript:better,python:better}};
  assert.deepEqual(sanitizeStartupMeasurement({...body,code:'PRIVATE'}),body);
  assert.equal(sanitizeStartupMeasurement({...body,languages:{javascript:{...better,improvementMs:9999},python:better}}),null);
  assert.equal(summarizeStartupPairs([{coldMs:'1000',snapshotMs:400},{coldMs:-1,snapshotMs:3}]).cold.samples,0);
});

test('execution-smoke workflow collects four bounded calls, caches paired samples by cohort, excludes stale cohorts',async t=>{
  const db=await fixture(t),calls=[];
  const execute=async(request,options)=>{calls.push({request,options});return{code:0,stdout:EXECUTION_SMOKE_EXPECTED_OUTPUT,
    startup:{mode:options.cold?'cold':'snapshot',createMs:options.cold?1200:300}};};
  const first=await runExecutionSmoke({trigger:'schedule',getDb:()=>db,env:measured,execute});
  assert.equal(first.body.ok,true);assert.equal(calls.length,4);assert.equal(first.body.coldStart.languages.javascript.cold.samples,1);
  assert.equal(first.body.coldStart.languages.javascript.improved,null);
  assert.equal(calls.filter(call=>call.options.cold).length,2);
  const second=await runExecutionSmoke({trigger:'schedule',getDb:()=>db,env:measured,execute});
  assert.equal(calls.length,4);assert.equal(second.body.languages.javascript.status,'throttled');assert.equal(second.body.coldStart.languages.python.cold.samples,1);
  const changed={...measured,EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID:'snap_new'};
  assert.equal((await readStartupMeasurement(db,changed)).languages.javascript.cold.samples,0);
  assert.doesNotMatch(JSON.stringify(first.body),/snap_|test-secret|source|stdout|code/);
  const incomplete=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:{...measured,EXECUTION_WARM_PYTHON_SNAPSHOT_ID:''},execute});
  assert.equal(incomplete.body.ok,false);assert.equal(incomplete.body.languages.python.status,'misconfigured');assert.equal(calls.length,4);
});

test('assessor returns only allowlisted aggregate percentiles and fails sufficient warm latency regressions',async t=>{
  const db=await fixture(t),cohort=warmMeasurementCohort(measured);
  for(let i=0;i<20;i++)await recordExecutionSmoke(db,1,{javascript:{status:'ok',durationMs:10,startup:{coldMs:1000,snapshotMs:1400}},python:{status:'ok',durationMs:10,startup:{coldMs:1000,snapshotMs:400}}},{cohort});
  const coldStart=await readStartupMeasurement(db,measured);
  const body={ok:true,checkedAt:new Date().toISOString(),languages:{javascript:{status:'ok',durationMs:10},python:{status:'ok',durationMs:10}},coldStart};
  const assessment=assessExecutionSmoke({...body,secret:'PRIVATE_SECRET'});
  assert.equal(assessment.ok,false);assert.equal(assessment.category,'warm_latency_regression');
  assert.doesNotMatch(JSON.stringify(assessment),/PRIVATE|secret|snap_/);
  assert.equal(assessExecutionSmoke({...body,coldStart:{...coldStart,windowDays:1}}).category,'malformed_response');
});
