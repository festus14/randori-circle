import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,beforeEach,mock,test} from 'node:test';
import {createClient} from '@libsql/client';

let currentDb=null;
const temporaryDirectories=[];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='owner') return {id:1,email:'owner@example.test',name:'Owner'};
  if(identity==='member') return {id:2,email:'member@example.test',name:'Member'};
  if(identity==='outsider') return {id:3,email:'outsider@example.test',name:'Outsider'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(['configured-owner@example.test']),
    getClient:()=>currentDb,
    getJwtSecret:()=>'circle-membership-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:req=>req?.headers?.['x-test-cross']!=='1',
    verifyRequestAuth:authPayload,
  },
});

const membership=await import('../../api/_circle-membership.js');
const [{default:invitationsHandler},{default:dataHandler}]=await Promise.all([
  import('../../api/invitations.js'),
  import('../../api/data.js'),
]);

function invoke(handler,{method='GET',url='/',query={},headers={},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const res={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      end(payload){ finish(payload); },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(handler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function createDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-membership-'));
  temporaryDirectories.push(directory);
  const db=createClient({url:pathToFileURL(join(directory,'membership.sqlite')).href});
  await db.batch([
    `CREATE TABLE auth_accounts (
      id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,color TEXT NOT NULL,created_at TEXT,last_login TEXT,
      is_available INTEGER,availability_updated_at TEXT,is_admin INTEGER,is_demo INTEGER,
      bio TEXT,tz TEXT,interview_focus TEXT,leetcode_handle TEXT,google_sub TEXT
    )`,
    `CREATE TABLE auth_provider_identities (
      issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id INTEGER NOT NULL,created_at TEXT NOT NULL,
      last_login TEXT NOT NULL,PRIMARY KEY(issuer,subject),UNIQUE(issuer,user_id),
      FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE
    )`,
    membership.CIRCLES_TABLE_SQL,
    membership.CIRCLE_MEMBERSHIPS_TABLE_SQL,
    membership.CIRCLE_INVITATIONS_TABLE_SQL,
    membership.CIRCLE_AUDIT_EVENTS_TABLE_SQL,
    membership.AUTH_RATE_LIMITS_TABLE_SQL,
    membership.CIRCLE_MEMBERSHIP_ROLLOUT_TABLE_SQL,
    `INSERT INTO circle_membership_rollout (id,registrations_closed,updated_at)
      VALUES (1,0,datetime('now'))`,
    `INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_available,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle)
      VALUES
      (1,'owner@example.test','x','Owner','#112233',1,1,0,'Owner bio','Europe/London','both','owner-handle'),
      (2,'member@example.test','x','Member <script>','#445566',0,0,0,NULL,'UTC','dsa',NULL),
      (3,'outsider@example.test','x','Outsider','#778899',1,0,0,NULL,'UTC','both',NULL),
      (4,'configured-owner@example.test','x','Configured owner','#aabbcc',1,0,0,NULL,'UTC','both',NULL),
      (5,'demo@example.test','x','Demo','#ddeeff',1,1,1,NULL,'UTC','both',NULL)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'3c20c4da-1906-4ca4-b4fd-5971f1dd066d','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now')),
             (10,2,'member','active',datetime('now'),datetime('now'))`,
  ],'write');
  return db;
}

beforeEach(()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  delete process.env.TURSO_DATABASE_URL;
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
  while(temporaryDirectories.length) rmSync(temporaryDirectories.pop(),{recursive:true,force:true});
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
});

test('claims are signed, short lived, email bound, and never store the raw invitation token',async()=>{
  currentDb=await createDatabase();
  const token=membership.createInvitationToken();
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  const tokenHash=membership.hashInvitationToken(token);
  const emailHash=membership.hashInvitationEmail(' MEMBER@Example.Test ');
  assert.match(tokenHash,/^[0-9a-f]{64}$/);
  assert.match(emailHash,/^[0-9a-f]{64}$/);
  assert.notEqual(tokenHash,token);
  const invitationId='23248c6c-23e0-4b0f-9dd2-45e9367fc456';
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[invitationId,10,tokenHash,emailHash,1],
  });

  const prepared=await membership.prepareInvitationClaim(currentDb,{token});
  assert.equal(prepared.ok,true);
  assert.equal(prepared.claim.includes(token),false);
  const cookie=membership.inviteClaimCookie(prepared.claim);
  assert.match(cookie,/Path=\/api\/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  assert.equal(cookie.includes(token),false);
  const parsed=membership.readInviteClaim({headers:{cookie}});
  assert.equal(parsed.invitation_id,invitationId);
  assert.deepEqual(await membership.validatePreparedInvitation(currentDb,{claim:parsed,email:'wrong@example.test'}),{ok:false});
  const validated=await membership.validatePreparedInvitation(currentDb,{claim:parsed,email:'member@example.test'});
  assert.equal(validated.ok,true);
  assert.equal(validated.used_by,null);

  const stored=await currentDb.execute(`SELECT token_hash,email_hash FROM circle_invitations WHERE id='${invitationId}'`);
  assert.equal(JSON.stringify(stored.rows).includes(token),false);
  assert.equal(JSON.stringify(stored.rows).includes('member@example.test'),false);
});

test('invitation acceptance is atomic, same-account idempotent, and rejects a different account',async()=>{
  currentDb=await createDatabase();
  const token=membership.createInvitationToken();
  const invitationId='e3ed1b91-210d-4518-a77f-c50c4f305be4';
  const tokenHash=membership.hashInvitationToken(token);
  const emailHash=membership.hashInvitationEmail('member@example.test');
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[invitationId,10,tokenHash,emailHash,1],
  });
  const prepared=await membership.prepareInvitationClaim(currentDb,{token});
  const claim=membership.readInviteClaim({headers:{cookie:`${membership.INVITE_CLAIM_COOKIE}=${prepared.claim}`}});

  const accepted=await membership.acceptPreparedInvitation(currentDb,{claim,email:'member@example.test',userId:2});
  assert.deepEqual(accepted,{ok:true,circle_id:10,idempotent:false});
  const retried=await membership.acceptPreparedInvitation(currentDb,{claim,email:'member@example.test',userId:2});
  assert.deepEqual(retried,{ok:true,circle_id:10,idempotent:true});
  assert.deepEqual(await membership.acceptPreparedInvitation(currentDb,{claim,email:'member@example.test',userId:3}),{ok:false});

  const validated=await membership.validatePreparedInvitation(currentDb,{claim,email:'member@example.test'});
  assert.equal(validated.used_by,2);
  const invitation=await currentDb.execute({sql:`SELECT used_by,used_at FROM circle_invitations WHERE id=?`,args:[invitationId]});
  assert.equal(Number(invitation.rows[0].used_by),2);
  assert.ok(invitation.rows[0].used_at);
  const audit=await currentDb.execute({sql:`SELECT COUNT(*) AS count FROM circle_audit_events WHERE invitation_id=?`,args:[invitationId]});
  assert.equal(Number(audit.rows[0].count),1);

  const competingId='c460fe10-15bf-461b-b536-a5aeb8110948';
  const competingToken=membership.createInvitationToken();
  const competingHash=membership.hashInvitationToken(competingToken);
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[competingId,10,competingHash,emailHash,1],
  });
  const competingPrepared=await membership.prepareInvitationClaim(currentDb,{token:competingToken});
  const competingClaim=membership.readInviteClaim({headers:{cookie:
    `${membership.INVITE_CLAIM_COOKIE}=${competingPrepared.claim}`}});
  const outcomes=await Promise.all([2,3].map(userId=>membership.acceptPreparedInvitation(currentDb,{
    claim:competingClaim,email:'member@example.test',userId,
  })));
  assert.equal(outcomes.filter(outcome=>outcome.ok).length,1);
  const winner=outcomes[0].ok?2:3;
  const competingRow=await currentDb.execute({sql:`SELECT used_by FROM circle_invitations WHERE id=?`,args:[competingId]});
  assert.equal(Number(competingRow.rows[0].used_by),winner);
  const competingAudit=await currentDb.execute({sql:`SELECT COUNT(*) AS count FROM circle_audit_events WHERE invitation_id=?`,args:[competingId]});
  assert.equal(Number(competingAudit.rows[0].count),1);

  await currentDb.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=10 AND user_id=2`);
  const disabledReplay=await membership.acceptPreparedInvitation(currentDb,{
    claim,email:'member@example.test',userId:2,
  });
  assert.deepEqual(disabledReplay,{ok:false});
  const disabledMembership=await currentDb.execute(`SELECT status FROM circle_memberships WHERE circle_id=10 AND user_id=2`);
  assert.equal(disabledMembership.rows[0].status,'inactive');
  const originalAuditAfterReplay=await currentDb.execute({sql:`SELECT COUNT(*) AS count FROM circle_audit_events WHERE invitation_id=?`,args:[invitationId]});
  assert.equal(Number(originalAuditAfterReplay.rows[0].count),1);
});

test('new Google account creation and invitation acceptance commit atomically',async()=>{
  currentDb=await createDatabase();
  const token=membership.createInvitationToken();
  const invitationId='94948c6c-23e0-4b0f-9dd2-45e9367fc456';
  const email='new.google@example.test';
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[invitationId,10,membership.hashInvitationToken(token),membership.hashInvitationEmail(email),1],
  });
  const prepared=await membership.prepareInvitationClaim(currentDb,{token});
  const claim=membership.readInviteClaim({headers:{cookie:`${membership.INVITE_CLAIM_COOKIE}=${prepared.claim}`}});
  const accepted=await membership.createGoogleAccountFromPreparedInvitation(currentDb,{
    claim,email,passwordHash:`!oauth:${'A'.repeat(32)}`,displayName:'New Google',color:'#123456',
    isAdmin:false,googleIssuer:'https://accounts.google.com',googleSub:'google-new-1',
  });
  assert.equal(accepted.ok,true);
  assert.equal(accepted.created,true);
  const state=await currentDb.execute({
    sql:`SELECT account.id,membership.status,invitation.used_by,audit.event_type
      FROM auth_accounts account
      JOIN circle_memberships membership ON membership.user_id=account.id AND membership.circle_id=10
      JOIN circle_invitations invitation ON invitation.id=? AND invitation.used_by=account.id
      JOIN circle_audit_events audit ON audit.invitation_id=invitation.id
      WHERE account.email=? AND account.google_sub=?`,
    args:[invitationId,email,'google-new-1'],
  });
  assert.equal(state.rows.length,1);
  assert.equal(state.rows[0].status,'active');
  assert.equal(state.rows[0].event_type,'invitation.accepted');
  const identity=await currentDb.execute({
    sql:`SELECT issuer,subject,user_id FROM auth_provider_identities WHERE user_id=?`,args:[accepted.user_id],
  });
  assert.deepEqual(identity.rows.map(row=>[String(row.issuer),String(row.subject),Number(row.user_id)]),[
    ['https://accounts.google.com','google-new-1',accepted.user_id],
  ]);

  const revokedToken=membership.createInvitationToken();
  const revokedId='a4948c6c-23e0-4b0f-9dd2-45e9367fc456';
  const rejectedEmail='revoked@example.test';
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[revokedId,10,membership.hashInvitationToken(revokedToken),membership.hashInvitationEmail(rejectedEmail),1],
  });
  const revokedPrepared=await membership.prepareInvitationClaim(currentDb,{token:revokedToken});
  const revokedClaim=membership.readInviteClaim({headers:{cookie:
    `${membership.INVITE_CLAIM_COOKIE}=${revokedPrepared.claim}`}});
  await currentDb.execute({sql:`UPDATE circle_invitations SET revoked_at=datetime('now') WHERE id=?`,args:[revokedId]});
  const rejected=await membership.createGoogleAccountFromPreparedInvitation(currentDb,{
    claim:revokedClaim,email:rejectedEmail,passwordHash:`!oauth:${'B'.repeat(32)}`,
    displayName:'Rejected Google',color:'#654321',isAdmin:false,
    googleIssuer:'https://accounts.google.com',googleSub:'google-rejected-1',
  });
  assert.deepEqual(rejected,{ok:false});
  const orphan=await currentDb.execute({sql:`SELECT id FROM auth_accounts WHERE email=?`,args:[rejectedEmail]});
  assert.equal(orphan.rows.length,0);

  await currentDb.execute({
    sql:`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_available,is_admin,is_demo,google_sub)
      VALUES (20,'old-address@example.test','!oauth:old','Existing Google','#abcdef',1,0,0,'stable-google-sub')`,
  });
  const changedEmailToken=membership.createInvitationToken();
  const changedEmailId='b4948c6c-23e0-4b0f-9dd2-45e9367fc456';
  const changedEmail='new-address@example.test';
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[changedEmailId,10,membership.hashInvitationToken(changedEmailToken),membership.hashInvitationEmail(changedEmail),1],
  });
  const changedEmailPrepared=await membership.prepareInvitationClaim(currentDb,{token:changedEmailToken});
  const changedEmailClaim=membership.readInviteClaim({headers:{cookie:
    `${membership.INVITE_CLAIM_COOKIE}=${changedEmailPrepared.claim}`}});
  const duplicateIdentity=await membership.createGoogleAccountFromPreparedInvitation(currentDb,{
    claim:changedEmailClaim,email:changedEmail,passwordHash:`!oauth:${'C'.repeat(32)}`,
    displayName:'Duplicate Google',color:'#abcdef',isAdmin:false,
    googleIssuer:'https://accounts.google.com',googleSub:'stable-google-sub',
  });
  assert.deepEqual(duplicateIdentity,{ok:false});
  const duplicateAccounts=await currentDb.execute({
    sql:`SELECT email FROM auth_accounts WHERE google_sub='stable-google-sub'`,
  });
  assert.deepEqual(duplicateAccounts.rows.map(row=>String(row.email)),['old-address@example.test']);
});

test('new local password account creation uses the same atomic invitation and membership contract',async()=>{
  currentDb=await createDatabase();
  const email='local.invitee@example.test';
  const token=membership.createInvitationToken();
  const invitationId='d4948c6c-23e0-4b0f-9dd2-45e9367fc456';
  await currentDb.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
    args:[invitationId,10,membership.hashInvitationToken(token),membership.hashInvitationEmail(email),1],
  });
  const prepared=await membership.prepareInvitationClaim(currentDb,{token});
  const claim=membership.readInviteClaim({headers:{cookie:
    `${membership.INVITE_CLAIM_COOKIE}=${prepared.claim}`}});
  const passwordHash=`$2b$10$${'A'.repeat(53)}`;
  const accepted=await membership.createPasswordAccountFromPreparedInvitation(currentDb,{
    claim,email,passwordHash,displayName:'Local Invitee',color:'#123456',isAdmin:false,
  });
  assert.equal(accepted.ok,true);
  assert.equal(accepted.created,true);
  const state=await currentDb.execute({
    sql:`SELECT account.password_hash,account.google_sub,membership.role,membership.status,
        invitation.used_by,audit.event_type
      FROM auth_accounts account
      JOIN circle_memberships membership ON membership.user_id=account.id AND membership.circle_id=10
      JOIN circle_invitations invitation ON invitation.id=? AND invitation.used_by=account.id
      JOIN circle_audit_events audit ON audit.invitation_id=invitation.id
      WHERE account.email=?`,
    args:[invitationId,email],
  });
  assert.equal(state.rows.length,1);
  assert.equal(state.rows[0].password_hash,passwordHash);
  assert.equal(state.rows[0].google_sub,null);
  assert.equal(state.rows[0].role,'member');
  assert.equal(state.rows[0].status,'active');
  assert.equal(state.rows[0].event_type,'invitation.accepted');

  const replay=await membership.createPasswordAccountFromPreparedInvitation(currentDb,{
    claim,email,passwordHash:`$2b$10$${'B'.repeat(53)}`,displayName:'Local Invitee',color:'#123456',
  });
  assert.deepEqual(replay,{ok:false});
  const accounts=await currentDb.execute({sql:`SELECT COUNT(*) AS count FROM auth_accounts WHERE email=?`,args:[email]});
  assert.equal(Number(accounts.rows[0].count),1);

  const wrongEmail=await membership.createPasswordAccountFromPreparedInvitation(currentDb,{
    claim,email:'other@example.test',passwordHash:`$2b$10$${'C'.repeat(53)}`,
    displayName:'Other User',color:'#654321',
  });
  assert.deepEqual(wrongEmail,{ok:false});
});

test('password invitation account creation rolls back on expiry and a later acceptance no-op',async()=>{
  currentDb=await createDatabase();
  const passwordHash=`$2b$10$${'D'.repeat(53)}`;
  const createPrepared=async({id,email})=>{
    const token=membership.createInvitationToken();
    await currentDb.execute({
      sql:`INSERT INTO circle_invitations
        (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
        VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
      args:[id,10,membership.hashInvitationToken(token),membership.hashInvitationEmail(email),1],
    });
    const prepared=await membership.prepareInvitationClaim(currentDb,{token});
    return membership.readInviteClaim({headers:{cookie:
      `${membership.INVITE_CLAIM_COOKIE}=${prepared.claim}`}});
  };

  const expiredId='e4948c6c-23e0-4b0f-9dd2-45e9367fc456';
  const expiredEmail='expired.local@example.test';
  const expiredClaim=await createPrepared({id:expiredId,email:expiredEmail});
  await currentDb.execute({
    sql:`UPDATE circle_invitations SET expires_at=datetime('now','-1 second') WHERE id=?`,args:[expiredId],
  });
  const expired=await membership.createPasswordAccountFromPreparedInvitation(currentDb,{
    claim:expiredClaim,email:expiredEmail,passwordHash,displayName:'Expired Local',color:'#123456',
  });
  assert.deepEqual(expired,{ok:false});

  const racedId='f4948c6c-23e0-4b0f-9dd2-45e9367fc456';
  const racedEmail='raced.local@example.test';
  const racedClaim=await createPrepared({id:racedId,email:racedEmail});
  const base=currentDb;
  let statementNumber=0;
  const failingDb={
    async transaction(mode){
      const transaction=await base.transaction(mode);
      return {
        async execute(statement){
          statementNumber+=1;
          if(statementNumber===2) return {rows:[],rowsAffected:0};
          return transaction.execute(statement);
        },
        commit:transaction.commit.bind(transaction),
        rollback:transaction.rollback.bind(transaction),
      };
    },
  };
  const raced=await membership.createPasswordAccountFromPreparedInvitation(failingDb,{
    claim:racedClaim,email:racedEmail,passwordHash,displayName:'Raced Local',color:'#654321',
  });
  assert.deepEqual(raced,{ok:false});

  for(const [invitationId,email] of [[expiredId,expiredEmail],[racedId,racedEmail]]){
    const account=await currentDb.execute({sql:`SELECT id FROM auth_accounts WHERE email=?`,args:[email]});
    assert.equal(account.rows.length,0);
    const invitation=await currentDb.execute({
      sql:`SELECT used_at,used_by FROM circle_invitations WHERE id=?`,args:[invitationId],
    });
    assert.equal(invitation.rows[0].used_at,null);
    assert.equal(invitation.rows[0].used_by,null);
    const audit=await currentDb.execute({
      sql:`SELECT id FROM circle_audit_events WHERE invitation_id=?`,args:[invitationId],
    });
    assert.equal(audit.rows.length,0);
  }
});

test('controlled initialization backfills only non-demo auth accounts and audits once',async()=>{
  currentDb=await createDatabase();
  assert.equal(await membership.circleMembershipCutoverStarted(currentDb),false);
  await currentDb.execute(`DELETE FROM circle_audit_events`);
  await currentDb.execute(`DELETE FROM circle_memberships`);
  const result=await membership.initializePrimaryCircle(currentDb,{ownerUserId:1,ownerEmails:['configured-owner@example.test']});
  assert.equal(result.circleId,10);
  await currentDb.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
    VALUES (6,'late@example.test','x','Late account','#abcdef',1,0,0)`);
  await currentDb.execute(`UPDATE circle_memberships SET status='inactive' WHERE circle_id=10 AND user_id=3`);
  await membership.initializePrimaryCircle(currentDb,{ownerUserId:1,ownerEmails:['configured-owner@example.test']});

  const rows=await currentDb.execute(`SELECT user_id,role,status FROM circle_memberships ORDER BY user_id`);
  assert.deepEqual(rows.rows.map(row=>[Number(row.user_id),String(row.role),String(row.status)]),[
    [1,'owner','active'],[2,'member','active'],[3,'member','inactive'],[4,'owner','active'],
  ]);
  const audit=await currentDb.execute(`SELECT subject_user_id FROM circle_audit_events
    WHERE event_type='membership.backfilled' ORDER BY subject_user_id`);
  assert.deepEqual(audit.rows.map(row=>Number(row.subject_user_id)),[1,2,3,4]);
  const completed=await currentDb.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
    WHERE event_type='membership.backfill.completed'`);
  assert.equal(Number(completed.rows[0].count),1);
  assert.equal(await membership.circleMembershipCutoverStarted(currentDb),true);
});

test('registration-state probes do not create rollout schema before explicit initialization',async()=>{
  currentDb=createClient({url:'file::memory:'});
  assert.equal(await membership.circleMembershipRegistrationState(currentDb),'uninitialized');
  assert.equal(await membership.circleMembershipCutoverStarted(currentDb),false);
  const schema=await currentDb.execute({
    sql:`SELECT name FROM sqlite_schema WHERE type='table' AND name='circle_membership_rollout'`,
    args:[],
  });
  assert.equal(schema.rows.length,0);
});

test('owner invitation APIs create, safely list, prepare, clear stale claims, and revoke',async()=>{
  currentDb=await createDatabase();
  const ownerHeaders={'x-test-auth':'owner',origin:'https://randori.example.test',host:'randori.example.test'};
  const created=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations',query:{endpoint:'invitations'},headers:ownerHeaders,
    body:{email:' New.Member@Example.Test '},
  });
  assert.equal(created.status,201);
  assert.equal(created.headers['cache-control'],'private, no-store');
  assert.equal(created.headers.pragma,'no-cache');
  assert.equal(created.body.invitation.email,'new.member@example.test');
  assert.match(created.body.invitation.invite_url,/^\/invite#invite=[A-Za-z0-9_-]{43}$/);
  const rawToken=created.body.invitation.invite_url.split('=')[1];

  const listed=await invoke(invitationsHandler,{
    url:'/api/invitations',query:{endpoint:'invitations'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(listed.status,200);
  assert.equal(listed.body.count,1);
  assert.equal(listed.body.invitations[0].status,'pending');
  const serializedList=JSON.stringify(listed.body);
  for(const forbidden of ['new.member@example.test',rawToken,'token_hash','email_hash']){
    assert.equal(serializedList.includes(forbidden),false,forbidden);
  }

  const staleCookie=`${membership.INVITE_CLAIM_COOKIE}=stale.claim`;
  const invalid=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
    headers:{origin:'https://randori.example.test',host:'randori.example.test',cookie:staleCookie},
    body:{token:'x'.repeat(43)},
  });
  assert.equal(invalid.status,400);
  assert.match(String(invalid.headers['set-cookie']),/Max-Age=0/);

  const prepared=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
    headers:{origin:'https://randori.example.test',host:'randori.example.test'},body:{token:rawToken},
  });
  assert.equal(prepared.status,200);
  assert.equal(prepared.headers['cache-control'],'private, no-store');
  assert.equal(prepared.body.expires_in_seconds,600);
  assert.equal(Array.isArray(prepared.headers['set-cookie']),true);
  assert.match(prepared.headers['set-cookie'][0],/Max-Age=0/);
  assert.match(prepared.headers['set-cookie'][1],/HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
  assert.equal(prepared.headers['set-cookie'].join(';').includes(rawToken),false);

  const revoked=await invoke(invitationsHandler,{
    method:'DELETE',url:`/api/invitations/${created.body.invitation.id}`,
    query:{endpoint:'invitations',id:created.body.invitation.id},headers:ownerHeaders,
  });
  assert.deepEqual(revoked.body,{ok:true,id:created.body.invitation.id,status:'revoked'});
  const afterRevoke=await membership.prepareInvitationClaim(currentDb,{token:rawToken});
  assert.deepEqual(afterRevoke,{ok:false});

  const denied=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations',query:{endpoint:'invitations'},
    headers:{...ownerHeaders,'x-test-auth':'member'},body:{email:'someone@example.test'},
  });
  assert.equal(denied.status,403);
});

test('owner invitation history is bounded to the newest 200 rows',async()=>{
  currentDb=await createDatabase();
  await currentDb.execute(`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<205
    )
    INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    SELECT printf('invite-%03d',value),10,printf('%064d',value),printf('%064x',value),1,
      printf('2026-09-18T12:%02d:%02d.000Z',(value/60)%60,value%60),
      '2026-09-25T12:00:00.000Z'
    FROM sequence`);
  const result=await invoke(invitationsHandler,{
    url:'/api/invitations',query:{endpoint:'invitations'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(result.status,200);
  assert.equal(result.body.count,200);
  assert.equal(result.body.invitations.length,200);
  assert.equal(result.body.invitations[0].id,'invite-205');
  assert.equal(result.body.invitations.at(-1).id,'invite-006');
});

test('primary-circle owner cannot list or revoke a secondary-circle invitation',async()=>{
  currentDb=await createDatabase();
  const invitationId='65b269ea-4f19-4ee3-8735-e35d9ecfae1a';
  await currentDb.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (20,'59b57183-0378-4fe2-9d89-9659111bc3c4','secondary-circle','Secondary Circle',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (20,1,'owner','active',datetime('now'),datetime('now'))`,
    {
      sql:`INSERT INTO circle_invitations
        (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
        VALUES (?,?,?,?,?,datetime('now'),datetime('now','+7 days'))`,
      args:[invitationId,20,'a'.repeat(64),'b'.repeat(64),1],
    },
  ],'write');

  const listed=await invoke(invitationsHandler,{
    url:'/api/invitations',query:{endpoint:'invitations'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(listed.status,200);
  assert.equal(listed.body.count,0);
  assert.deepEqual(listed.body.invitations,[]);

  const revoked=await invoke(invitationsHandler,{
    method:'DELETE',url:`/api/invitations/${invitationId}`,
    query:{endpoint:'invitations',id:invitationId},
    headers:{'x-test-auth':'owner',origin:'https://randori.example.test',host:'randori.example.test'},
  });
  assert.equal(revoked.status,404);
  assert.deepEqual(revoked.body,{error:'invitation not found'});
  const stored=await currentDb.execute({
    sql:`SELECT revoked_at FROM circle_invitations WHERE id=?`,args:[invitationId],
  });
  assert.equal(stored.rows[0].revoked_at,null);
});

test('public prepare is same-origin and atomically rate limited without revealing token validity',async()=>{
  currentDb=await createDatabase();
  const crossOrigin=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
    headers:{origin:'https://evil.example.test',host:'randori.example.test'},body:{token:'x'.repeat(43)},
  });
  assert.equal(crossOrigin.status,403);
  assert.equal(crossOrigin.headers['set-cookie'],undefined);

  let last;
  for(let attempt=0;attempt<13;attempt++){
    last=await invoke(invitationsHandler,{
      method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
      headers:{origin:'https://randori.example.test',host:'randori.example.test','x-forwarded-for':'203.0.113.8'},
      body:{token:'x'.repeat(43)},
    });
  }
  assert.equal(last.status,429);
  assert.equal(Number(last.headers['retry-after'])>0,true);
  assert.equal(last.body.error,'too many attempts');
});

test('public prepare prunes expired rate-limit rows before enforcing the current request',async()=>{
  currentDb=await createDatabase();
  await currentDb.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)`,
    args:['expired-client',99,Math.floor(Date.now()/1000)-1],
  });

  const result=await invoke(invitationsHandler,{
    method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
    headers:{origin:'https://randori.example.test',host:'randori.example.test','x-forwarded-for':'203.0.113.41'},
    body:{token:'x'.repeat(43)},
  });
  assert.equal(result.status,400);
  const rows=await currentDb.execute(`SELECT key,attempts FROM auth_rate_limits ORDER BY key`);
  assert.equal(rows.rows.some(row=>row.key==='expired-client'),false);
  assert.equal(rows.rows.length,1);
  assert.equal(Number(rows.rows[0].attempts),1);
});

test('public prepare still enforces rate limits when expired-row cleanup fails',async()=>{
  const database=await createDatabase();
  let cleanupAttempts=0;
  currentDb={
    execute(statement){
      const sql=typeof statement==='string'?statement:statement?.sql;
      if(/^DELETE FROM auth_rate_limits WHERE expires_at<=\?/u.test(String(sql).trim())){
        cleanupAttempts+=1;
        return Promise.reject(new Error('cleanup unavailable'));
      }
      return database.execute(statement);
    },
    batch(statements,mode){ return database.batch(statements,mode); },
    close(){ database.close(); },
  };

  let result;
  for(let attempt=0;attempt<13;attempt++){
    result=await invoke(invitationsHandler,{
      method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
      headers:{origin:'https://randori.example.test',host:'randori.example.test','x-forwarded-for':'203.0.113.42'},
      body:{token:'x'.repeat(43)},
    });
    assert.equal(result.status,attempt===12?429:400);
  }
  assert.equal(cleanupAttempts,13);
  assert.equal(result.status,429);
  const rows=await database.execute(`SELECT attempts FROM auth_rate_limits`);
  assert.equal(Number(rows.rows[0].attempts),13);
});

test('membership-scoped circle exposes only active primary-circle auth members',async()=>{
  currentDb=await createDatabase();
  const result=await invoke(dataHandler,{
    url:'/api/circle',query:{endpoint:'circle'},headers:{'x-test-auth':'member'},
  });
  assert.equal(result.status,200);
  assert.equal(result.headers['cache-control'],'private, no-store');
  assert.deepEqual(result.body.circle_meta,{
    id:10,public_id:'3c20c4da-1906-4ca4-b4fd-5971f1dd066d',name:'Randori Circle',
  });
  assert.deepEqual(result.body.membership,{role:'member'});
  assert.deepEqual(result.body.circle.map(person=>person.id),[1,2]);
  assert.equal(result.body.circle[1].display_name,'Member <script>');
  const serialized=JSON.stringify(result.body);
  for(const forbidden of ['owner@example.test','password_hash','is_admin','is_demo','outsider@example.test']){
    assert.equal(serialized.includes(forbidden),false,forbidden);
  }

  const outsider=await invoke(dataHandler,{
    url:'/api/circle',query:{endpoint:'circle'},headers:{'x-test-auth':'outsider'},
  });
  assert.equal(outsider.status,403);
  assert.deepEqual(outsider.body,{error:'circle membership required'});
});

test('a stale owner session cannot manage invitations after its account is deleted',async()=>{
  currentDb=await createDatabase();
  await currentDb.execute(`DELETE FROM auth_accounts WHERE id=1`);
  const invitations=await invoke(invitationsHandler,{
    url:'/api/invitations',query:{endpoint:'invitations'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(invitations.status,403);
  assert.deepEqual(invitations.body,{error:'circle owner required'});
  const circle=await invoke(dataHandler,{
    url:'/api/circle',query:{endpoint:'circle'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(circle.status,403);
  assert.deepEqual(circle.body,{error:'circle membership required'});
});

test('admin init upgrades a legacy auth schema before enforcing Google subject uniqueness',async()=>{
  currentDb=createClient({url:'file::memory:'});
  await currentDb.execute(`CREATE TABLE auth_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,color TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT,is_available INTEGER DEFAULT 1,availability_updated_at TEXT,
    is_admin INTEGER DEFAULT 0,is_demo INTEGER DEFAULT 0
  )`);
  await currentDb.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
    VALUES (1,'owner@example.test','x','Owner','#112233',1,1,0)`);

  const result=await invoke(dataHandler,{
    method:'POST',url:'/api/init',query:{endpoint:'init'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(result.status,200);
  const columns=await currentDb.execute(`PRAGMA table_info('auth_accounts')`);
  assert.equal(columns.rows.some(row=>row.name==='google_sub'),true);
  const indexes=await currentDb.execute(`PRAGMA index_list('auth_accounts')`);
  assert.equal(indexes.rows.some(row=>row.name==='uq_auth_accounts_google_sub'&&Number(row.unique)===1),true);
});

test('admin init installs membership indexes and runs the audited backfill',async()=>{
  currentDb=await createDatabase();
  await currentDb.execute(`DELETE FROM circle_audit_events`);
  await currentDb.execute(`DELETE FROM circle_memberships`);
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  const result=await invoke(dataHandler,{
    method:'POST',url:'/api/init',query:{endpoint:'init'},headers:{'x-test-auth':'owner'},
  });
  assert.equal(result.status,200);

  const indexes=await currentDb.execute(`SELECT name FROM sqlite_master
    WHERE type='index' AND name IN (
      'uq_circles_active_primary','idx_circle_memberships_user_active',
      'idx_circle_invitations_circle_created','idx_circle_audit_circle_created',
      'uq_auth_accounts_google_sub'
    ) ORDER BY name`);
  assert.deepEqual(indexes.rows.map(row=>String(row.name)),[
    'idx_circle_audit_circle_created','idx_circle_invitations_circle_created',
    'idx_circle_memberships_user_active','uq_auth_accounts_google_sub','uq_circles_active_primary',
  ]);
  const members=await currentDb.execute(`SELECT user_id,role FROM circle_memberships ORDER BY user_id`);
  assert.deepEqual(members.rows.map(row=>[Number(row.user_id),String(row.role)]),[
    [1,'owner'],[2,'member'],[3,'member'],[4,'owner'],
  ]);
  const completed=await currentDb.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
    WHERE event_type='membership.backfill.completed'`);
  assert.equal(Number(completed.rows[0].count),1);
});
