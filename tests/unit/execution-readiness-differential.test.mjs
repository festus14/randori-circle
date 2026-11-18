import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {test,mock,after} from 'node:test';
import {createClient} from '@libsql/client';
import {createMigratedDatabase} from '../support/migrated-db.mjs';
import {inspectDatabaseReadiness,databaseReadinessConfiguration} from '../../api/_health.js';
import {prepareMigrationConnection} from '../../db/migration-runner.js';
import {initializePrimaryCircleData} from '../../api/_admin-init.js';
import {readAdminDiagnostics} from '../../api/_admin-diagnostics.js';

// Frozen, independently hashed main source. CI needs no GitHub access or Git
// history to compare the three public readiness paths and admin initialization.
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const baseline=JSON.parse(readFileSync(new URL('../support/execution-readiness-main-1eb.json',import.meta.url),'utf8'));
const HASHES={health:'b1503eee9c2b0a381ab5af976bd4df9ae8deee31ea091c05cd976cc9a5ddebba',
  adminInit:'4d6093cae89ba50ea16bb7744f652390c48c5616934d48f247c6648c060512a2',handler:'69897b8550414b0732004fb332267d147f7df05d276bfa9d69da0e184c3bc7e3'};
for(const [key,hash]of Object.entries(HASHES))assert.equal(createHash('sha256').update(baseline[key]).digest('hex'),hash);
assert.equal(baseline.revision,'1eb7078');
const directory=mkdtempSync(join(tmpdir(),'randori-468-main-reference-'));mkdirSync(join(directory,'api'));
writeFileSync(join(directory,'package.json'),JSON.stringify({type:'module'}));
symlinkSync(join(ROOT,'db'),join(directory,'db'),'dir');
writeFileSync(join(directory,'api','_health.js'),baseline.health);
writeFileSync(join(directory,'api','_admin-init.js'),baseline.adminInit);
const header="import {HEALTH_RESPONSE,READY_RESPONSE,UNAVAILABLE_RESPONSE,coalescedDatabaseReadiness,databaseReadinessConfiguration,readinessTargetExists,resolveHealthProbe,setHealthHeaders} from './_health.js';\n";
writeFileSync(join(directory,'api','handler.js'),header+'export function handler(getClient){return '+baseline.handler.trim()+';}\n');
after(()=>rmSync(directory,{recursive:true,force:true}));
const mainHealth=await import(pathToFileURL(join(directory,'api','_health.js')).href);
const mainAdmin=await import(pathToFileURL(join(directory,'api','_admin-init.js')).href);
const {handler:mainHandlerFactory}=await import(pathToFileURL(join(directory,'api','handler.js')).href);
let currentDb;
const SECRET='execution-readiness-r3-fixture-secret'.repeat(2),SID='c'.repeat(64),NOW=1800000000,UUID='22222222-2222-4222-8222-222222222222';
const auth=()=>({id:1,email:'admin@example.test',authTransport:'bearer'});
mock.module('../../api/_db.js',{exports:{getClient:()=>currentDb,getJwtSecret:()=>SECRET,getAdminEmails:()=>new Set(),
  captureSentryException:()=>{},captureSentryMessage:()=>{},initSentry:()=>{},isSentryConfigured:()=>false,verifyMutationOrigin:()=>true,
  verifyRequestAuth:auth,verifySignedRequestAuth:auth}});
const {default:dataHandler}=await import('../../api/data.js');
const mainHandler=mainHandlerFactory(()=>currentDb);
const PATHS=['/api/health','/api/health/ready','/api/readyz'];
const BAD={EXECUTION_GLOBAL_CONCURRENCY:'bad',EXECUTION_CIRCLE_CONCURRENCY:'-1',EXECUTION_INTERVIEW_SHARE:'999',
  EXECUTION_GLOBAL_PER_DAY:'0',EXECUTION_MAX_WAIT_SECONDS:'NaN',EXECUTION_QUEUE_LIMIT:'bad',EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID:'invalid',
  EXECUTION_WARM_PYTHON_SNAPSHOT_ID:'PRIVATE_BAD_SETTING',EXECUTION_WARM_MEASURE_ENABLED:'true'};
function response(){return{statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
async function call(handler,path,method='GET'){const res=response();await handler({method,url:path,query:{endpoint:'health'},headers:{}},res);return{status:res.statusCode,headers:res.headers,body:res.body};}
async function fixture(t){const file=await createMigratedDatabase({prefix:'randori-468-readiness-'}),db=createClient({url:file.url});
  t.after(()=>{currentDb=null;db.close();file.cleanup();});await prepareMigrationConnection(db);return{db,file};}
function environment(t,file,extra={}){
  const values={NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',TURSO_DATABASE_URL:file.url,RANDORI_LOCAL_DATABASE_PATH:file.path,TURSO_AUTH_TOKEN:undefined,
    JWT_SECRET:SECRET,CIRCLE_MEMBERSHIP_ENABLED:'false',MULTI_CIRCLE_CONTROL_PLANE_ENABLED:'false',SECONDARY_CIRCLE_WORKSPACE_ENABLED:'false',
    EXECUTION_PROVIDER:'vercel-sandbox',EXECUTION_QUEUE_ENABLED:undefined,...BAD,...extra};
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  for(const[key,value]of Object.entries(values))if(value===undefined)delete process.env[key];else process.env[key]=value;
  t.after(()=>{for(const[key,value]of Object.entries(old))if(value===undefined)delete process.env[key];else process.env[key]=value;});
}
async function seed(db){await db.execute("INSERT INTO auth_accounts(id,email,password_hash,display_name,color,is_admin,is_demo) VALUES(1,'admin@example.test','x','Admin','#111111',1,0),(2,'member@example.test','x','Member','#222222',0,0)");
  await db.execute({sql:'INSERT INTO auth_sessions(session_hash,user_id,created_at,expires_at) VALUES(?,1,?,?)',args:[SID,NOW-60,NOW+3600]});}
const options={actor:{userId:1,sessionHash:SID},nowSeconds:NOW,randomUuid:()=>UUID};
async function outcome(operation){try{return{result:await operation()};}catch(error){return{error:{name:error.name,message:error.message,code:error.code}};}}

for(const flag of [undefined,'false'])for(const primaries of [0,2])test(`flag ${String(flag)}, ${primaries} primary circles: all readiness routes/HEAD equal main despite bad execution settings`,async t=>{
  const{db,file}=await fixture(t);environment(t,file,{EXECUTION_QUEUE_ENABLED:flag});currentDb=db;
  if(primaries===2){
    // Two active primaries cannot exist in a valid schema (unique index).
    // Model that corrupt state explicitly; BOTH main and branch must reject
    // schema drift, rather than adding a flag-dependent deployment condition.
    await db.execute('DROP INDEX uq_circles_active_primary');
    await db.execute("INSERT INTO circles(public_id,slug,name,is_primary) VALUES('one','one','One',1),('two','two','Two',1)");
  }
  assert.equal(await inspectDatabaseReadiness(db),await mainHealth.inspectDatabaseReadiness(db));
  assert.deepEqual(databaseReadinessConfiguration(),mainHealth.databaseReadinessConfiguration());
  for(const path of PATHS)for(const method of ['GET','HEAD']){
    const before=await call(mainHandler,path,method),actual=await call(dataHandler,path,method);
    assert.deepEqual(actual,before);assert.equal(JSON.stringify(actual),JSON.stringify(before));assert.equal(actual.status,primaries?503:200);
  }
  t.diagnostic(JSON.stringify({flag:flag??'unset',primaries,differentialPairs:6}));
});

test('flag ON execution-only misconfiguration leaves schema readiness and admin initialization equal main',async t=>{
  const candidate=await fixture(t),reference=await fixture(t);environment(t,candidate.file,{EXECUTION_QUEUE_ENABLED:'true'});
  await seed(candidate.db);await seed(reference.db);currentDb=candidate.db;
  assert.equal(await inspectDatabaseReadiness(candidate.db),true);
  assert.equal(await mainHealth.inspectDatabaseReadiness(reference.db),true);
  assert.deepEqual(await initializePrimaryCircleData(candidate.db,options),await mainAdmin.initializePrimaryCircleData(reference.db,options));
  for(const path of PATHS){assert.deepEqual(await call(dataHandler,path),await call(mainHandler,path));assert.equal((await call(dataHandler,path)).status,200);}
  const execution=response();await dataHandler({method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{},
    body:{question_slug:'focus-block-rollup',question_version:1,language:'javascript',code:'function rollUpFocusBlocks(){return [];}' }},execution);
  assert.equal(execution.statusCode,503);assert.equal(execution.body.code,'execution_busy');assert.equal(execution.body.reason,'configuration');
  const diagnostic=await readAdminDiagnostics(candidate.db,{env:process.env});
  assert.equal(diagnostic.cards.execution.status,'degraded');assert.equal(diagnostic.cards.execution.queue.ready,false);assert.equal(diagnostic.cards.execution.queue.reason,'configuration');
  assert.equal(await inspectDatabaseReadiness(candidate.db),true,'refusal telemetry does not poison whole-app readiness');
});

for(const flag of [undefined,'false'])for(const primaries of [0,2])test(`admin init flag ${String(flag)}, ${primaries} primaries equals main with bad execution knobs`,async t=>{
  const candidate=await fixture(t),reference=await fixture(t);environment(t,candidate.file,{EXECUTION_QUEUE_ENABLED:flag});
  for(const {db}of[candidate,reference]){await seed(db);if(primaries){await db.execute('DROP INDEX uq_circles_active_primary');await db.execute("INSERT INTO circles(public_id,slug,name,is_primary) VALUES('a','a','A',1),('b','b','B',1)");}}
  assert.deepEqual(await outcome(()=>initializePrimaryCircleData(candidate.db,options)),await outcome(()=>mainAdmin.initializePrimaryCircleData(reference.db,options)));
});

test('shared readiness helper is byte-for-byte restored to the pinned main implementation',()=>{
  assert.equal(readFileSync(new URL('../../api/_health.js',import.meta.url),'utf8'),baseline.health);
});
