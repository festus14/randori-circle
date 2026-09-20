import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {expect,test} from '@playwright/test';

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
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED',
  'SECONDARY_CIRCLE_SCHEDULING_ENABLED','SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED',
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

function fixServerTime(iso:string){
  const NativeDate=globalThis.Date;
  const instant=new NativeDate(iso).getTime();
  (globalThis as typeof globalThis&{Date:DateConstructor}).Date=class FixedDate extends NativeDate{
    constructor(...args:ConstructorParameters<DateConstructor>){
      super(...(args.length?args:[instant]));
    }
    static now(){ return instant; }
  } as DateConstructor;
  return ()=>{ globalThis.Date=NativeDate; };
}

test('a browser schedule proposal queues and captures one dashboard-only secondary email',async({page})=>{
  test.setTimeout(90_000);
  const original=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
  for(const key of rolloutFlags) process.env[key]='true';
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-secondary-schedule-email-browser-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  let runtime:Awaited<ReturnType<typeof startLocalDevelopmentServer>>|null=null;
  let db:ReturnType<typeof createClient>|null=null;
  let restoreServerTime=()=>{};
  try{
    runtime=await startLocalDevelopmentServer({config,logger:silentLogger});
    process.env.CRON_SECRET='secondary-schedule-email-browser-secret';
    await page.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await expectInviteGateLoaded(page);
    const login=await json(page,'/api/auth/login','POST',{
      email:LOCAL_OWNER_EMAIL,password:LOCAL_OWNER_PASSWORD,
    });
    expect(login.status).toBe(200);
    const created=await json(page,'/api/circles','POST',{
      name:'Schedule Circle',request_id:'secondary-schedule-email-0001',
    });
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const contextVersion=Number((created.body as {context_version:number}).context_version);
    const publicId=String((created.body as {circle:{public_id:string}}).circle.public_id);
    const ownerId=Number((login.body as {user:{id:number}}).user.id);
    db=createClient({url:databaseUrl});
    await prepareMigrationConnection(db);
    const circleId=Number((await db.execute({sql:`SELECT id FROM circles WHERE public_id=?`,args:[publicId]})).rows[0].id);
    const primaryId=Number((await db.execute(`SELECT id FROM circles
      WHERE is_primary=1 AND archived_at IS NULL`)).rows[0].id);
    await db.batch([
      `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
        VALUES (2,'schedule-partner@example.test','hash','Schedule Partner','#222222',0,1)`,
      {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
        VALUES (?,2,'member','active')`,args:[circleId]},
      {sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
        VALUES (?,'membership.backfilled',?,2,?)`,
      args:[primaryId,ownerId,`membership-backfilled:${primaryId}:2`]},
    ],'write');

    const context={'x-randori-circle-context-version':String(contextVersion)};
    const pairingState=await json(page,'/api/my-pair','GET',undefined,context);
    expect(pairingState.status,JSON.stringify(pairingState.body)).toBe(200);
    restoreServerTime=fixServerTime(String(
      (pairingState.body as {publication_state:{recovery_at:string}}).publication_state.recovery_at,
    ));
    const publication=await json(page,'/api/pairing/run','POST',{
      expected_cycle_key:String((pairingState.body as {publication_state:{cycle_key:string}})
        .publication_state.cycle_key),
    },context);
    expect(publication.status,JSON.stringify(publication.body)).toBe(200);
    expect(publication.body).toMatchObject({created:true,coordination_only:true,workspace_available:false});
    const initial=await json(page,'/api/schedule','GET',undefined,context);
    expect(initial.status,JSON.stringify(initial.body)).toBe(200);
    const proposed=await json(page,'/api/schedule','POST',{
      action:'propose',base_version:String((initial.body as {schedule:{version:string}}).schedule.version),
      instant:'2098-09-20T09:00:00.000Z',
    },context);
    expect(proposed.status,JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body).toMatchObject({coordination_only:true,workspace_available:false,
      dashboard_path:'/?view=dashboard'});

    const stored=(await db.execute(`SELECT event_version,idempotency_key,payload_json
      FROM outbox_events WHERE event_type='schedule.email.requested' ORDER BY id`)).rows;
    expect(stored).toHaveLength(1);
    expect(Number(stored[0].event_version)).toBe(2);
    const payload=JSON.parse(String(stored[0].payload_json));
    expect(Object.keys(payload).sort()).toEqual([
      'actor_user_id','instant_fingerprint','kind','proposal_id','recipient_user_id',
      'schedule_id','schedule_revision','template_version',
    ]);
    expect(payload).toMatchObject({kind:'proposal',actor_user_id:ownerId,recipient_user_id:2,
      schedule_revision:1,template_version:1});
    expect(String(stored[0].payload_json)).not.toMatch(/@|Schedule Circle|2098-09-20|circle_id|group_id|room/i);

    const drained=await json(page,'/api/cron/outbox','POST',undefined,{
      'x-cron-secret':'secondary-schedule-email-browser-secret',
    });
    expect(drained.status,JSON.stringify(drained.body)).toBe(200);
    const body=drained.body as {
      schedule_delivery:{captured:Array<{recipient_email:string;subject:string;links:string[]}>};
      outbox:{types:Record<string,{claimed:number;delivered:number;backlog:number}>};
    };
    expect(body.outbox.types['schedule.email.requested']).toMatchObject({claimed:1,delivered:1,backlog:0});
    expect(body.schedule_delivery.captured).toEqual([expect.objectContaining({
      recipient_email:'schedule-partner@example.test',subject:expect.stringContaining('Schedule Circle'),
      links:[`${runtime.url}/?view=dashboard`],
    })]);
    expect(JSON.stringify(body.schedule_delivery.captured)).not.toMatch(/\/join\/|room|workspace|video|chat/i);
  }finally{
    restoreServerTime();
    await db?.close();
    await runtime?.close();
    for(const [key,value] of Object.entries(original)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
    rmSync(rootDir,{recursive:true,force:true});
  }
});
