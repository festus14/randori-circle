// Preserve #451's additive v24 release evidence under the v25 workspace release.
import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
await import('../support/historical-v24.mjs');
const {EXECUTABLE_MIGRATIONS}=await import('../../db/executable-migrations.js');
const {prepareMigrationConnection,applyMigrations,inspectMigrationState}=await import('../../db/migration-runner.js');
const {initializeLocalPrimaryCircleData}=await import('../../api/_admin-init.js');
const {inspectDatabaseReadiness}=await import('../../api/_health.js');
const {deletionTokenSchemaAvailable,requestAccountDeletionEmail}=await import('../../api/_account-deletion-tokens.js');
const {default:handler}=await import('../../api/auth.js');
const keys=['JWT_SECRET','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','CIRCLE_MEMBERSHIP_ENABLED','ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED','NODE_ENV','APP_URL'];
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const resources=[],NOW=Math.floor(Date.now()/1000),EMAIL='removed@example.test';
afterEach(async()=>{
  for(const cleanup of resources.splice(0).reverse())await cleanup();
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
});
async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-v24-deletion-release-'));
  const url=`file:${join(directory,'local.sqlite')}`,db=createClient({url});
  resources.push(()=>rmSync(directory,{recursive:true,force:true}),()=>db.close());
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,24),state=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  Object.assign(process.env,{JWT_SECRET:'email-deletion-test-secret-with-at-least-32-bytes',NODE_ENV:'development',TURSO_DATABASE_URL:url,CIRCLE_MEMBERSHIP_ENABLED:'true',ACCOUNT_DELETION_ENABLED:'true',ACCOUNT_DELETION_GRACE_ENABLED:'true',APP_URL:'http://127.0.0.1:9999'});
  delete process.env.TURSO_AUTH_TOKEN;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin) VALUES
    (1,'owner@example.test','!oauth:owner','Owner','#111111',1),
    (2,'removed@example.test','$2a$10$member','Removed','#222222',0)`);
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test']});
  await db.execute("UPDATE circle_memberships SET status='inactive' WHERE user_id=2");
  return db;
}
async function call(endpoint,body){
  const res={statusCode:200,headers:{},body:null,status(code){this.statusCode=code;return this;},setHeader(k,v){this.headers[k.toLowerCase()]=v;},getHeader(k){return this.headers[k.toLowerCase()];},json(body){this.body=body;return this;}};
  await handler({method:'POST',url:`/api/auth?endpoint=${endpoint}`,query:{endpoint},body,headers:{host:'127.0.0.1:9999',origin:'http://127.0.0.1:9999','x-forwarded-for':'198.51.100.9','content-type':'application/json'},socket:{remoteAddress:'198.51.100.9'}},res);
  return {status:res.statusCode,body:res.body};
}
test('v24 is additive: v23 stays ready, new endpoints stay hidden, then cutover unlocks the flow',async()=>{
  const db=await fixture();
  await db.execute('DROP TABLE account_deletion_tokens');
  await db.execute('DELETE FROM schema_migrations WHERE version=24');
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  assert.equal(await deletionTokenSchemaAvailable(db),false);
  assert.equal((await call('account-delete-link-request',{email:EMAIL})).status,404);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,24);
  const state=await inspectMigrationState(db,{migrations});
  assert.equal(state.currentVersion,23);assert.equal(state.ready,true);
  const result=await applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  assert.deepEqual(result.applied.map(item=>item.version),[24]);
  // A new client sees the installed migration immediately; the request cache
  // on the old client deliberately has a 30-second pending TTL.
  const fresh=createClient({url:process.env.TURSO_DATABASE_URL});resources.push(()=>fresh.close());
  const prior=process.env.TURSO_DATABASE_URL;delete process.env.TURSO_DATABASE_URL;
  assert.equal(await deletionTokenSchemaAvailable(fresh),true);process.env.TURSO_DATABASE_URL=prior;
  assert.equal((await requestAccountDeletionEmail(fresh,{email:EMAIL},{nowSeconds:NOW})).accepted,true);
});

