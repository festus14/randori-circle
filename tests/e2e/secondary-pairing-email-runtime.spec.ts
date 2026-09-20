import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {expect,test} from '@playwright/test';

import {createOpsHandler} from '../../api/ops.js';
import {pairingSchemaV6Ready} from '../../api/_pairing-readiness.js';
import {prepareMigrationConnection} from '../../db/migration-runner.js';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';
import {expectInviteGateLoaded,stageRealRuntimeClient} from './real-runtime-fixture';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
const silentLogger=Object.freeze({log(){},error(){}});
const rolloutFlags=[
  'MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED',
] as const;
const environmentKeys=[...rolloutFlags,'CRON_SECRET'] as const;

async function json(page,path:string,method='GET',body?:object,headers:Record<string,string>={}){
  return page.evaluate(async input=>{
    const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',
      headers:{...input.headers,...(input.body===undefined?{}:{'content-type':'application/json'})},
      ...(input.body===undefined?{}:{body:JSON.stringify(input.body)})});
    return {status:response.status,body:await response.json()};
  },{path,method,body,headers});
}

test('local capture delivers manual and weekly-route secondary publications once without room links',async({page})=>{
  test.setTimeout(90_000);
  const original=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
  for(const key of rolloutFlags) process.env[key]='true';
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-secondary-email-browser-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  let runtime:Awaited<ReturnType<typeof startLocalDevelopmentServer>>|null=null;
  let db:ReturnType<typeof createClient>|null=null;
  try{
    runtime=await startLocalDevelopmentServer({
      config,
      logger:silentLogger,
      handlers:{ops:createOpsHandler({
        isWeeklyDue:()=>true,
      })},
    });
    process.env.CRON_SECRET='secondary-email-browser-secret';
    await page.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await expectInviteGateLoaded(page);
    const login=await json(page,'/api/auth/login','POST',{
      email:LOCAL_OWNER_EMAIL,password:LOCAL_OWNER_PASSWORD,
    });
    expect(login.status).toBe(200);
    const manualCircle=await json(page,'/api/circles','POST',{
      name:'Manual Practice',request_id:'secondary-email-manual-0001',
    });
    expect(manualCircle.status,JSON.stringify(manualCircle.body)).toBe(201);
    const manualContext=Number((manualCircle.body as {context_version:number}).context_version);
    const manualPublicId=String((manualCircle.body as {circle:{public_id:string}}).circle.public_id);
    db=createClient({url:databaseUrl});
    await prepareMigrationConnection(db);
    const ownerId=Number((login.body as {user:{id:number}}).user.id);
    const manualId=Number((await db.execute({
      sql:`SELECT id FROM circles WHERE public_id=?`,args:[manualPublicId],
    })).rows[0].id);
    const primaryId=Number((await db.execute(`SELECT id FROM circles
      WHERE is_primary=1 AND archived_at IS NULL`)).rows[0].id);
    await db.batch([
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
        VALUES (2,'manual-two@example.test','hash','Manual Two','#222222',0,0),
               (3,'manual-three@example.test','hash','Manual Three','#333333',0,0)`,
      {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
        VALUES (?,2,'member','active'),(?,3,'member','active')`,args:[manualId,manualId]},
      {sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
        VALUES (?,'membership.backfilled',?,2,?),
               (?,'membership.backfilled',?,3,?)`,
      args:[primaryId,ownerId,`membership-backfilled:${primaryId}:2`,
        primaryId,ownerId,`membership-backfilled:${primaryId}:3`]},
    ],'write');

    const manual=await json(page,'/api/pairing/run','POST',{},
      {'x-randori-circle-context-version':String(manualContext)});
    expect(manual.status,JSON.stringify(manual.body)).toBe(200);
    expect(manual.body).toMatchObject({created:true,coordination_only:true,workspace_available:false});
    const replay=await json(page,'/api/pairing/run','POST',{},
      {'x-randori-circle-context-version':String(manualContext)});
    expect(replay.body).toMatchObject({created:false,skipped:true});
    const compact=(await db.execute(`SELECT event_version,payload_json FROM outbox_events
      WHERE event_type='pairing.email.requested' ORDER BY id`)).rows;
    expect(compact).toHaveLength(3);
    for(const row of compact){
      expect(Number(row.event_version)).toBe(2);
      expect(Object.keys(JSON.parse(String(row.payload_json))).sort()).toEqual([
        'circle_id','kind','publication_id','user_id',
      ]);
      expect(String(row.payload_json)).not.toContain('@');
    }

    const cronCircle=await json(page,'/api/circles','POST',{
      name:'Cron Practice',request_id:'secondary-email-cron-000001',
    });
    expect(cronCircle.status,JSON.stringify(cronCircle.body)).toBe(201);
    const cronPublicId=String((cronCircle.body as {circle:{public_id:string}}).circle.public_id);
    const cronId=Number((await db.execute({
      sql:`SELECT id FROM circles WHERE public_id=?`,args:[cronPublicId],
    })).rows[0].id);
    await db.batch([
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
        VALUES (4,'cron-four@example.test','hash','Cron Four','#444444',0,0)`,
      {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
        VALUES (? ,4,'member','active')`,args:[cronId]},
      {sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
        VALUES (?,'membership.backfilled',?,4,?)`,
      args:[primaryId,ownerId,`membership-backfilled:${primaryId}:4`]},
      {sql:`INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (?,0)
        ON CONFLICT(user_id) DO UPDATE SET email_enabled=0`,args:[ownerId]},
    ],'write');
    expect(await pairingSchemaV6Ready(db,{requireClosedMembership:true})).toBe(true);
    const cron=await json(page,'/api/cron/weekly','GET',undefined,
      {'x-cron-secret':'secondary-email-browser-secret'});
    expect(cron.status,JSON.stringify(cron.body)).toBe(200);
    expect(cron.body).toMatchObject({secondary:{attempted:2,created:1,existing:1,failed:0}});
    const queuedAfterCron=(await db.execute(`SELECT payload_json FROM outbox_events
      WHERE event_type='pairing.email.requested' AND event_version=2 ORDER BY id`)).rows
      .map(row=>JSON.parse(String(row.payload_json)) as {circle_id:number});
    expect(queuedAfterCron).toHaveLength(5);
    expect(queuedAfterCron.filter(payload=>Number(payload.circle_id)===manualId)).toHaveLength(3);
    expect(queuedAfterCron.filter(payload=>Number(payload.circle_id)===cronId)).toHaveLength(2);

    const combinedDrain=await json(page,'/api/cron/outbox','POST',undefined,
      {'x-cron-secret':'secondary-email-browser-secret'});
    const combinedBody=combinedDrain.body as {
      email_delivery:{captured:Array<{recipient_email:string;subject:string;links:string[]}>};
      outbox:{types:Record<string,{claimed:number;delivered:number;suppressed:number}>};
    };
    const pairingMetrics=combinedBody.outbox.types['pairing.email.requested'];
    expect(pairingMetrics.claimed).toBeGreaterThanOrEqual(5);
    expect(pairingMetrics.delivered).toBe(3);
    expect(pairingMetrics.suppressed).toBe(pairingMetrics.claimed-3);
    expect(combinedBody.email_delivery.captured).toHaveLength(3);
    expect(combinedBody.email_delivery.captured).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recipient_email:'manual-two@example.test',subject:expect.stringContaining('Manual Practice'),
        links:[runtime.url],
      }),
      expect.objectContaining({
        recipient_email:'manual-three@example.test',subject:expect.stringContaining('Manual Practice'),
        links:[runtime.url],
      }),
      expect.objectContaining({
        recipient_email:'cron-four@example.test',subject:expect.stringContaining('Cron Practice'),
        links:[runtime.url],
      }),
    ]));
    for(const message of combinedBody.email_delivery.captured){
      if(message.recipient_email.startsWith('manual-')){
        expect(message.subject).not.toContain('Cron Practice');
      }else{
        expect(message.recipient_email).toBe('cron-four@example.test');
        expect(message.subject).not.toContain('Manual Practice');
      }
    }
    expect(JSON.stringify(combinedBody.email_delivery.captured)).not.toMatch(/\/join\/|room|workspace|week_[1-9]/i);
    const emptyDrain=await json(page,'/api/cron/outbox','POST',undefined,
      {'x-cron-secret':'secondary-email-browser-secret'});
    expect((emptyDrain.body as {outbox:{claimed:number}}).outbox.claimed).toBe(0);
  }finally{
    await db?.close();
    await runtime?.close();
    for(const [key,value] of Object.entries(original)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
    rmSync(rootDir,{recursive:true,force:true});
  }
});
