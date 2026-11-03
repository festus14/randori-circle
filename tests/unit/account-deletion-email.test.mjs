import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {createClient} from '@libsql/client';
import {createMigratedDatabase} from '../support/migrated-db.mjs';
import {prepareMigrationConnection,applyMigrations,inspectMigrationState} from '../../db/migration-runner.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {initializeLocalPrimaryCircleData} from '../../api/_admin-init.js';
import {hashInvitationEmail} from '../../api/_circle-membership.js';
import {issueSession,verifyRequestAuth,verifySignedRequestAuth} from '../../api/_db.js';
import {inspectDatabaseReadiness} from '../../api/_health.js';
import {inspectMembershipRolloutReadiness} from '../../db/membership-readiness.js';
import {pairingSchemaV6Ready} from '../../api/_pairing-readiness.js';
import {
  createDeletionToken,hashDeletionToken,openDeletionToken,sealDeletionToken,
  requestAccountDeletionEmail,createAccountDeletionLinkEmailHandler,
  DELETION_LINK_EVENT_TYPE,DELETION_REQUEST_TOKEN_TTL_SECONDS,deletionTokenSchemaAvailable,
  cancelTokenForDeletionEmail,readDeletionToken,
} from '../../api/_account-deletion-tokens.js';
import {
  requestAccountDeletionViaEmailToken,cancelAccountDeletionViaEmailToken,
  requestAccountDeletion,createAccountDeletionEmailHandler,runAccountDeletionGraceJobs,
  readActiveDeletionPending,DELETION_GRACE_SECONDS,createAccountDeletionReminderEvent,
} from '../../api/_account-deletion-grace.js';
import handler from '../../api/auth.js';

const NOW=Math.floor(Date.now()/1000),EMAIL='removed@example.test';
const INVALID={ok:false,status:'invalid'};
const keys=['JWT_SECRET','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','CIRCLE_MEMBERSHIP_ENABLED',
  'ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED','NODE_ENV','APP_URL'];
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const resources=[];
afterEach(async()=>{
  for(const cleanup of resources.splice(0).reverse())await cleanup();
  for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
});
async function fixture({active=false,google=false,admin=false}={}){
  const data=await createMigratedDatabase({prefix:'randori-email-deletion-'});
  const db=createClient({url:data.url});resources.push(()=>data.cleanup(),()=>db.close());
  await prepareMigrationConnection(db);
  Object.assign(process.env,{JWT_SECRET:'email-deletion-test-secret-with-at-least-32-bytes',NODE_ENV:'development',
    TURSO_DATABASE_URL:data.url,CIRCLE_MEMBERSHIP_ENABLED:'true',ACCOUNT_DELETION_ENABLED:'true',ACCOUNT_DELETION_GRACE_ENABLED:'true',APP_URL:'http://127.0.0.1:9999'});
  delete process.env.TURSO_AUTH_TOKEN;
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin) VALUES
    (1,'owner@example.test','!oauth:owner','Owner','#111111',1),
    (2,'removed@example.test','$2a$10$member','Removed','#222222',0)`);
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test']});
  await db.execute({sql:`UPDATE circle_memberships SET status=? WHERE user_id=2`,args:[active?'active':'inactive']});
  if(google)await db.execute("UPDATE auth_accounts SET password_hash='!oauth:google-only',google_sub='google-removed' WHERE id=2");
  if(admin){await db.execute('UPDATE auth_accounts SET is_admin=1 WHERE id=2');await db.execute('UPDATE auth_accounts SET is_admin=0 WHERE id=1');}
  return db;
}
async function events(db,type){return (await db.execute({sql:'SELECT * FROM outbox_events WHERE event_type=? ORDER BY id',args:[type]})).rows;}
function event(row){return {id:Number(row.id),eventType:row.event_type,eventVersion:Number(row.event_version),idempotencyKey:row.idempotency_key,payload:JSON.parse(row.payload_json)};}
async function requestToken(db,at=NOW){
  const requested=await requestAccountDeletionEmail(db,{email:EMAIL},{nowSeconds:at});assert.equal(requested.accepted,true);
  const rows=await events(db,DELETION_LINK_EVENT_TYPE);const queued=event(rows.at(-1));
  return openDeletionToken(queued.payload.token_envelope,'request',queued.idempotencyKey);
}
async function confirm(db,token,at=NOW){return requestAccountDeletionViaEmailToken(db,{token,confirm:'DELETE',nowSeconds:at});}
async function cancelMail(db,{reminder=false,at=NOW}={}){
  const pending=await readActiveDeletionPending(db,2);
  if(reminder)await db.execute(createAccountDeletionReminderEvent({userId:2,scheduledFor:pending.scheduled_for}));
  const row=(await events(db,reminder?'account.deletion.reminder':'account.deletion.confirmation')).at(-1);
  const token=await cancelTokenForDeletionEmail(db,event(row),pending,{nowSeconds:at});
  return {token,event:event(row)};
}
function response(){return {statusCode:200,headers:{},body:null,status(code){this.statusCode=code;return this;},
  setHeader(k,v){this.headers[k.toLowerCase()]=v;},getHeader(k){return this.headers[k.toLowerCase()];},json(body){this.body=body;return this;}};}
async function call(ep,body,{ip='198.51.100.9',origin='http://127.0.0.1:9999',method='POST'}={}){
  const res=response(),started=Date.now();
  await handler({method,url:`/api/auth?endpoint=${ep}`,query:{endpoint:ep},body,
    headers:{host:'127.0.0.1:9999',origin,'x-forwarded-for':ip,'content-type':'application/json'},socket:{remoteAddress:ip}},res);
  return {status:res.statusCode,body:res.body,elapsed:Date.now()-started,headers:res.headers};
}
async function ready(db){
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true);
  assert.equal((await inspectMembershipRolloutReadiness(db)).ok,true);
}

for(const google of [false,true])test(`removed ${google?'Google-only':'password'} account requests, locks, cancels and executes through existing cron`,async()=>{
  const db=await fixture({google,admin:true}); // Resolution 2: sole admin flag without any active membership.
  await ready(db);
  const session=await issueSession(db,{id:2,email:EMAIL,name:'Removed'},{recentAuthMethod:'password',nowSeconds:NOW});
  const token=await requestToken(db);
  const proofs=(await db.execute('SELECT * FROM account_deletion_tokens')).rows;
  assert.equal(Number(proofs[0].expires_at)-NOW,DELETION_REQUEST_TOKEN_TTL_SECONDS);
  assert.equal(JSON.stringify(proofs).includes(token),false,'only token hashes at rest');
  const result=await confirm(db,token);assert.equal(result.status,'pending_deletion');
  assert.equal(Date.parse(result.scheduled_for)/1000,NOW+DELETION_GRACE_SECONDS);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM auth_sessions WHERE revoked_at IS NULL')).rows[0].n,0);
  assert.equal(await verifyRequestAuth({headers:{cookie:`randori_session=${session}`}},db,{nowSeconds:NOW}),null);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM circle_audit_events WHERE event_type='account.deletion_requested' AND subject_user_id=2")).rows[0].n,1);
  await ready(db);
  assert.deepEqual(await confirm(db,token),INVALID);
  const {token:cancel}=await cancelMail(db);
  assert.ok(cancel);
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:cancel,nowSeconds:NOW+1}),{ok:true,status:'cancelled'});
  assert.equal((await db.execute('SELECT status FROM circle_memberships WHERE user_id=2')).rows[0].status,'inactive');
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM circle_audit_events WHERE event_type='account.deletion_cancelled' AND subject_user_id=2")).rows[0].n,1);
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:cancel,nowSeconds:NOW+2}),INVALID);
  await ready(db);
  const second=await requestToken(db,NOW+61);assert.equal((await confirm(db,second,NOW+61)).ok,true);
  const latest=await cancelMail(db,{at:NOW+61});
  const executed=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+61+DELETION_GRACE_SECONDS,adminEmails:[],hashInvitationEmail});
  assert.equal(executed.executed,1);assert.deepEqual(executed.errors,[]);
  assert.equal((await db.execute('SELECT email FROM auth_accounts WHERE id=2')).rows[0].email,'deleted-2@account-deleted.invalid');
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM account_deletion_tokens WHERE user_id=2')).rows[0].n,0);
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:latest.token,nowSeconds:NOW+62+DELETION_GRACE_SECONDS}),INVALID);
  assert.equal(JSON.stringify((await db.execute('SELECT payload_json FROM outbox_events')).rows).includes('token_envelope'),false);
  await ready(db);
});

test('non-enumeration: unknown, active, removed, pending, tombstone and normalisable-invalid email share 202 and the 350ms floor',async()=>{
  const db=await fixture();
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (3,'pending@example.test','!oauth:pending','Pending','#333333'),
    (4,'tombstone@example.test','!account-deleted','Deleted member','#444444')`);
  await db.execute(`INSERT INTO account_deletion_requests (user_id,requested_at,scheduled_for) VALUES (3,${NOW},${NOW+DELETION_GRACE_SECONDS})`);
  const bodies=[],times=[];
  for(const [i,email] of ['unknown@example.test','owner@example.test',EMAIL,'pending@example.test','tombstone@example.test','odd..email@example.test'].entries()){
    const res=await call('account-delete-link-request',{email},{ip:`198.51.100.${i+1}`});
    assert.equal(res.status,202);assert.ok(res.elapsed>=340,`${email}: ${res.elapsed}`);bodies.push(res.body);times.push(res.elapsed);
  }
  for(const body of bodies)assert.deepEqual(body,bodies[0]);
  assert.ok(Math.max(...times)-Math.min(...times)<300,JSON.stringify(times));
  assert.equal((await events(db,DELETION_LINK_EVENT_TYPE)).length,1);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM account_deletion_tokens WHERE purpose='request'")).rows[0].n,1);
});

test('request and confirm recheck all memberships; delivery suppresses pending or reactivated accounts',async()=>{
  const db=await fixture();const token=await requestToken(db);
  const link=event((await events(db,DELETION_LINK_EVENT_TYPE))[0]);const sent=[];
  const deliver=createAccountDeletionLinkEmailHandler({db,baseUrl:'https://randori.example.test',send:async m=>{sent.push(m);return {providerName:'test'};}});
  assert.equal((await deliver(link)).status,'delivered');assert.match(sent[0].html,/expires in 24 hours/);
  await db.execute("UPDATE circle_memberships SET status='active' WHERE user_id=2");
  assert.deepEqual(await confirm(db,token),INVALID);assert.equal((await deliver(link)).status,'suppressed');
  assert.deepEqual(await requestAccountDeletionEmail(db,{email:EMAIL},{nowSeconds:NOW+60}),{accepted:false});
  await db.execute("UPDATE circle_memberships SET status='inactive' WHERE user_id=2");
  await db.execute("INSERT INTO circles (public_id,slug,name,is_primary,created_by) VALUES ('other','other','Other',0,1)");
  const circle=Number((await db.execute("SELECT id FROM circles WHERE public_id='other'")).rows[0].id);
  await db.execute({sql:"INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,2,'member','active')",args:[circle]});
  assert.deepEqual(await confirm(db,token),INVALID,'secondary active membership also blocks');
  await db.execute("UPDATE circle_memberships SET status='inactive' WHERE user_id=2");
  assert.equal((await confirm(db,token)).ok,true);assert.equal((await deliver(link)).status,'suppressed');
});

test('all unusable request/cancel proofs fail identically; request TTL is exactly 24h and cancellation ends at scheduled_for',async()=>{
  const db=await fixture();const token=await requestToken(db);
  for(const input of ['',createDeletionToken(),token]){
    const expired=input===token?NOW+DELETION_REQUEST_TOKEN_TTL_SECONDS:NOW;
    assert.deepEqual(await confirm(db,input,expired),INVALID);
    assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:input,nowSeconds:NOW}),INVALID);
  }
  assert.deepEqual(await requestAccountDeletionViaEmailToken(db,{token,confirm:'delete',nowSeconds:NOW}),INVALID);
  assert.equal((await confirm(db,token)).ok,true);const {token:cancel}=await cancelMail(db);
  assert.deepEqual(await confirm(db,cancel),INVALID,'cancel proof never requests deletion');
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:cancel,nowSeconds:NOW+DELETION_GRACE_SECONDS}),INVALID);
  assert.equal((await cancelAccountDeletionViaEmailToken(db,{token:cancel,nowSeconds:NOW+DELETION_GRACE_SECONDS-1})).ok,true);
});

test('confirmation and reminder deliver without membership; newer cancel supersedes old and delivery retries keep the proof',async()=>{
  const db=await fixture();const token=await requestToken(db);await confirm(db,token);
  const sent=[],send=async m=>{sent.push(m);return {providerName:'test'};};
  const deliver=createAccountDeletionEmailHandler({db,baseUrl:'https://randori.example.test',send});
  const confirmation=event((await events(db,'account.deletion.confirmation'))[0]);
  assert.equal((await deliver(confirmation)).status,'delivered');assert.equal((await deliver(confirmation)).status,'delivered');
  const cancel=new URL(sent[0].html.match(/href="([^"]+#cancel=[^"]+)"/)[1]).hash.slice('#cancel='.length);
  assert.ok(sent[1].html.includes(cancel),'retry carries the same token');
  assert.match(sent[0].html,/does not restore circle membership/);
  assert.equal(sent[0].to,EMAIL);assert.doesNotMatch(sent[0].html,/unsubscribe/);
  const reminder=await cancelMail(db,{reminder:true,at:NOW+1});assert.ok(reminder.token);
  assert.equal((await deliver(reminder.event)).status,'delivered');
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token:cancel,nowSeconds:NOW+2}),INVALID);
  await deliver(confirmation);assert.doesNotMatch(sent.at(-1).html,/#cancel=/,'old queued email suppresses obsolete link');
  assert.equal((await cancelAccountDeletionViaEmailToken(db,{token:reminder.token,nowSeconds:NOW+2})).ok,true);
  assert.equal((await deliver(reminder.event)).status,'suppressed');
});

test('signed-in request removed during grace still cancels via original email without restoring membership',async()=>{
  const db=await fixture({active:true});
  const session=await issueSession(db,{id:2,email:EMAIL,name:'Member'},{recentAuthMethod:'password',nowSeconds:NOW});
  const signed=verifySignedRequestAuth({headers:{cookie:`randori_session=${session}`}},{nowSeconds:NOW});
  assert.equal((await requestAccountDeletion(db,{userId:2,sessionHash:signed.sessionHash,nowSeconds:NOW})).ok,true);
  const {token}=await cancelMail(db);await db.execute("UPDATE circle_memberships SET status='inactive' WHERE user_id=2");
  assert.equal((await cancelAccountDeletionViaEmailToken(db,{token,nowSeconds:NOW+1})).ok,true);
  assert.equal((await db.execute('SELECT status FROM circle_memberships WHERE user_id=2')).rows[0].status,'inactive');
});

for(const reason of ['last_owner','last_admin'])test(`reactivated during grace rechecks ${reason}, stays locked and notifies once`,async()=>{
  const db=await fixture();await confirm(db,await requestToken(db));
  await db.execute("UPDATE circle_memberships SET status='active' WHERE user_id=2");
  if(reason==='last_owner'){
    await db.execute("INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (20,'owned','owned','Owned',0,2)");
    await db.execute("INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (20,2,'owner','active')");
  }else{await db.execute('UPDATE auth_accounts SET is_admin=CASE WHEN id=2 THEN 1 ELSE 0 END');}
  const options={nowSeconds:NOW+DELETION_GRACE_SECONDS,adminEmails:reason==='last_admin'?['owner@example.test']:[],hashInvitationEmail};
  // For last_admin notify another configured operator but do not make that
  // operator active: it must not satisfy the remaining active-admin predicate.
  if(reason==='last_admin')await db.execute("UPDATE circle_memberships SET status='inactive' WHERE user_id=1");
  const first=await runAccountDeletionGraceJobs(db,options);assert.equal(first.blocked,1);assert.equal(first.executed,0);
  assert.equal(first.blocked_notifications,1);
  assert.equal((await runAccountDeletionGraceJobs(db,{...options,nowSeconds:options.nowSeconds+1})).blocked_notifications,0);
  assert.ok(await readActiveDeletionPending(db,2));
});

test('rate limits mirror reset: email five, IP ten, consumption ten per 15 minutes',async()=>{
  await fixture();
  for(let i=0;i<5;i++)assert.equal((await call('account-delete-link-request',{email:EMAIL},{ip:`198.51.100.${i}`})).status,202);
  assert.equal((await call('account-delete-link-request',{email:EMAIL},{ip:'198.51.100.88'})).status,429);
  for(let i=0;i<10;i++)assert.equal((await call('account-delete-link-request',{email:`unknown-${i}@example.test`},{ip:'198.51.100.99'})).status,202);
  assert.equal((await call('account-delete-link-request',{email:'unknown-last@example.test'},{ip:'198.51.100.99'})).status,429);
  for(const ep of ['account-delete-confirm-token','account-delete-cancel-token']){
    for(let i=0;i<10;i++)assert.equal((await call(ep,{token:createDeletionToken(),confirm:'DELETE'})).status,409);
    assert.equal((await call(ep,{token:createDeletionToken(),confirm:'DELETE'})).status,429);
  }
});

test('resend cooldown, five-send cap, superseded request token, envelope purpose and event binding',async()=>{
  const db=await fixture();let token=await requestToken(db);
  assert.deepEqual(await requestAccountDeletionEmail(db,{email:EMAIL},{nowSeconds:NOW+59}),{accepted:false});
  for(let i=1;i<5;i++){
    const old=token;token=await requestToken(db,NOW+i*60);assert.deepEqual(await confirm(db,old,NOW+i*60),INVALID);
  }
  assert.deepEqual(await requestAccountDeletionEmail(db,{email:EMAIL},{nowSeconds:NOW+300}),{accepted:false});
  assert.notEqual(hashDeletionToken(token,'request'),hashDeletionToken(token,'cancel'));
  const envelope=sealDeletionToken(token,'request','test-key');assert.equal(openDeletionToken(envelope,'request','test-key'),token);
  assert.equal(openDeletionToken(envelope,'cancel','test-key'),null);assert.equal(openDeletionToken(envelope,'request','wrong-key'),null);
});

test('flags hide new requests and confirms while pending cancellation and execution keep their promise',async()=>{
  const db=await fixture();await confirm(db,await requestToken(db));const {token}=await cancelMail(db);
  for(const flag of ['ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED']){
    process.env[flag]='false';
    for(const ep of ['account-delete-link-request','account-delete-confirm-token'])assert.equal((await call(ep,{email:EMAIL,token,confirm:'DELETE'})).status,404);
    process.env[flag]='true';
  }
  process.env.ACCOUNT_DELETION_ENABLED='false';process.env.ACCOUNT_DELETION_GRACE_ENABLED='false';
  assert.equal((await call('account-delete-cancel-token',{token})).status,200);
  await requestAccountDeletionEmail(db,{email:EMAIL},{nowSeconds:NOW+60});
  const next=event((await events(db,DELETION_LINK_EVENT_TYPE)).at(-1));
  const nextToken=openDeletionToken(next.payload.token_envelope,'request',next.idempotencyKey);
  await confirm(db,nextToken,NOW+60);
  assert.equal((await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+60+DELETION_GRACE_SECONDS,adminEmails:[],hashInvitationEmail})).executed,1);
});

test('public routes reject cross-origin mutations and return generic invalid tokens without account facts',async()=>{
  await fixture();
  assert.equal((await call('account-delete-link-request',{email:EMAIL},{origin:'https://evil.example'})).status,403);
  assert.equal((await call('account-delete-link-request',{email:'bad'})).status,400);
  assert.equal((await call('account-delete-link-request',null,{method:'GET'})).status,405);
  const responses=[];
  for(const token of ['',createDeletionToken()])responses.push(await call('account-delete-confirm-token',{token,confirm:'DELETE'}));
  for(const res of responses){assert.equal(res.status,409);assert.deepEqual(res.body,INVALID);assert.ok(res.elapsed>=340);}
});

test('queued cancellation mail cannot act or deliver after execution',async()=>{
  const db=await fixture();await confirm(db,await requestToken(db));
  const {token,event:confirmation}=await cancelMail(db);
  const execute=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS,adminEmails:[],hashInvitationEmail});
  assert.equal(execute.executed,1);
  const sent=[];const deliver=createAccountDeletionEmailHandler({db,baseUrl:'https://randori.example.test',send:async m=>{sent.push(m);return {};}});
  assert.deepEqual(await deliver(confirmation),{status:'suppressed',reasonCode:'ACCOUNT_DELETION_NOT_PENDING'});
  assert.deepEqual(await cancelAccountDeletionViaEmailToken(db,{token,nowSeconds:NOW+DELETION_GRACE_SECONDS}),INVALID);
  assert.equal(sent.length,0);
});

test('a failed pending mutation rolls back token consumption and every side effect',async()=>{
  const db=await fixture(),token=await requestToken(db);
  const failing={transaction:async mode=>{
    const tx=await db.transaction(mode);return {
      execute:s=>tx.execute(s),commit:()=>tx.commit(),rollback:()=>tx.rollback(),
      batch:async statements=>{await tx.batch(statements);throw new Error('forced failure');},
    };
  }};
  await assert.rejects(()=>confirm(failing,token),/forced failure/);
  assert.equal(await readActiveDeletionPending(db,2),null);
  assert.equal((await db.execute('SELECT used_at FROM account_deletion_tokens')).rows[0].used_at,null);
  assert.equal((await confirm(db,token)).ok,true);
});

test('request-link provider keeps abort signals and reports only bounded delivery codes',async()=>{
  const db=await fixture(),token=await requestToken(db);
  const queued=event((await events(db,DELETION_LINK_EVENT_TYPE))[0]);
  const controller=new AbortController();
  const deliver=createAccountDeletionLinkEmailHandler({db,baseUrl:'https://randori.example.test',send:async message=>{
    assert.equal(message.signal,controller.signal);throw {statusCode:429,message:'private provider detail'};
  }});
  await assert.rejects(()=>deliver(queued,{signal:controller.signal}),error=>error.code==='PROVIDER_RATE_LIMITED'&&error.retryable);
  const wrong={...queued,payload:{...queued.payload,token_envelope:sealDeletionToken(token,'cancel',queued.idempotencyKey)}};
  await assert.rejects(()=>deliver(wrong),error=>error.code==='PAYLOAD_INVALID');
  process.env.ACCOUNT_DELETION_ENABLED='false';
  assert.deepEqual(await deliver(queued),{status:'suppressed',reasonCode:'ACCOUNT_DELETION_DISABLED'});
});


test('public email proof endpoints create no session and redact account and credential facts',async()=>{
  const db=await fixture({google:true,admin:true});
  const token=await requestToken(db);
  const started=await call('account-delete-confirm-token',{token,confirm:'DELETE'});
  assert.equal(started.status,200);assert.ok(started.elapsed>=340);
  assert.deepEqual(Object.keys(started.body).sort(),['ok','scheduled_for','status']);
  assert.equal(started.body.status,'pending_deletion');assert.equal(started.headers['set-cookie'],undefined);
  const {token:cancel}=await cancelMail(db);
  const stopped=await call('account-delete-cancel-token',{token:cancel});
  assert.equal(stopped.status,200);assert.deepEqual(stopped.body,{ok:true,status:'cancelled'});
  assert.equal(stopped.headers['set-cookie'],undefined);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM auth_sessions')).rows[0].n,0);
  assert.doesNotMatch(JSON.stringify([started.body,stopped.body]),/removed@example|token|hash|user_id/);
});

test('request delivery fails closed for malformed, obsolete, demo, tombstone and changed-email proofs',async()=>{
  const db=await fixture(),token=await requestToken(db);
  const queued=event((await events(db,DELETION_LINK_EVENT_TYPE))[0]);let sends=0;
  const deliver=createAccountDeletionLinkEmailHandler({db,baseUrl:'https://randori.example.test',send:async()=>{sends++;return {};}});
  for(const bad of [{...queued,eventVersion:2},{...queued,payload:null},{...queued,payload:{...queued.payload,extra:true}}]){
    await assert.rejects(()=>deliver(bad),error=>error.code==='PAYLOAD_INVALID');
  }
  assert.equal((await deliver({...queued,payload:{...queued.payload,token_id:createDeletionToken()}})).reasonCode,'ACCOUNT_DELETION_LINK_INACTIVE');
  for(const update of ["is_demo=1","password_hash='!account-deleted'","email='changed@example.test'"]){
    await db.execute(`UPDATE auth_accounts SET ${update} WHERE id=2`);
    assert.equal(await readDeletionToken(db,{token,purpose:'request',nowSeconds:NOW}),null);
    assert.equal((await deliver(queued)).reasonCode,'ACCOUNT_DELETION_LINK_INACTIVE');
    await db.execute("UPDATE auth_accounts SET is_demo=0,password_hash='$2a$10$member',email='removed@example.test' WHERE id=2");
  }
  await requestToken(db,NOW+60);
  assert.equal((await deliver(queued)).reasonCode,'ACCOUNT_DELETION_LINK_INACTIVE');assert.equal(sends,0);
  assert.equal(hashDeletionToken(token,'password-reset'),null);
  assert.throws(()=>sealDeletionToken('invalid','request','key'),/valid deletion token/);
});

test('mail failures never expose provider messages and stored cancel envelopes cannot be rebound',async()=>{
  const db=await fixture(),token=await requestToken(db),queued=event((await events(db,DELETION_LINK_EVENT_TYPE))[0]);
  for(const [failure,code,retryable] of [[{status:400},'PROVIDER_REJECTED',false],[new Error('private details'),'PROVIDER_FAILED',true]]){
    const deliver=createAccountDeletionLinkEmailHandler({db,baseUrl:'https://randori.example.test',send:async()=>({error:failure})});
    await assert.rejects(()=>deliver(queued),error=>error.code===code&&error.retryable===retryable);
  }
  await confirm(db,token);const {token:cancel,event:mail}=await cancelMail(db);const pending=await readActiveDeletionPending(db,2);
  await db.execute({sql:"UPDATE outbox_events SET payload_json=json_set(payload_json,'$.token_envelope',?) WHERE id=?",
    args:[sealDeletionToken(cancel,'cancel','other-key'),mail.id]});
  assert.equal(await cancelTokenForDeletionEmail(db,mail,pending,{nowSeconds:NOW}),null);
  assert.equal(await cancelTokenForDeletionEmail(db,{...mail,idempotencyKey:'missing'},pending,{nowSeconds:NOW}),null);
  assert.equal(await cancelTokenForDeletionEmail(db,mail,{...pending,id:999},{nowSeconds:NOW}),null);
});

test('request and cancellation rollback leaves proof reusable when storage fails',async()=>{
  const db=await fixture();
  const failExecute=(sqlPart)=>({execute:statement=>db.execute(statement),transaction:async mode=>{
    const tx=await db.transaction(mode);return {execute:async statement=>{
      if(String(statement.sql||statement).includes(sqlPart))throw new Error('storage failure');return tx.execute(statement);
    },batch:statements=>tx.batch(statements),commit:()=>tx.commit(),rollback:()=>tx.rollback()};
  }});
  await assert.rejects(()=>requestAccountDeletionEmail(failExecute('INSERT INTO outbox_events'),{email:EMAIL}),/storage failure/);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM account_deletion_tokens')).rows[0].n,0);
  await confirm(db,await requestToken(db));const pending=await readActiveDeletionPending(db,2);
  const mail=event((await events(db,'account.deletion.confirmation'))[0]);
  await assert.rejects(()=>cancelTokenForDeletionEmail(failExecute('INSERT INTO account_deletion_tokens'),mail,pending,{nowSeconds:NOW}),/storage failure/);
  const {token}=await cancelMail(db);
  await assert.rejects(()=>cancelAccountDeletionViaEmailToken(failExecute('SET cancelled_at'),{token,nowSeconds:NOW}),/storage failure/);
  assert.ok(await readActiveDeletionPending(db,2));
  assert.equal((await cancelAccountDeletionViaEmailToken(db,{token,nowSeconds:NOW})).ok,true);
});
