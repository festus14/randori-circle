import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { expect, test } from '@playwright/test';

import { createOutboxEventStatement } from '../../api/_outbox.js';
import {
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';
import {expectInviteGateLoaded,stageRealRuntimeClient} from './real-runtime-fixture';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
const silentLogger=Object.freeze({log(){},error(){}});

test('real cron drains saturated mixed types fairly and then reports an empty queue',async({page})=>{
  test.setTimeout(45_000);
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-outbox-budget-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  let runtime=null;
  const cronSecret='outbox-budget-browser-secret';
  try{
    runtime=await startLocalDevelopmentServer({config,logger:silentLogger});
    process.env.CRON_SECRET=cronSecret;
    const db=createClient({url:databaseUrl});
    try{
      const events=[];
      for(let sequence=1;sequence<=5;sequence+=1){
        events.push(createOutboxEventStatement({eventType:'pairing.email.requested',eventVersion:1,
          idempotencyKey:`runtime-budget/pairing/${sequence}`,payload:{private_marker:'never-return-this'},
          maxAttempts:1,deliveryTimeoutMs:1000}));
      }
      events.push(createOutboxEventStatement({eventType:'schedule.email.requested',eventVersion:1,
        idempotencyKey:'runtime-budget/schedule/1',payload:{private_marker:'never-return-this'},
        maxAttempts:1,deliveryTimeoutMs:1000}));
      events.push(createOutboxEventStatement({eventType:'invitation.email.requested',eventVersion:1,
        idempotencyKey:'runtime-budget/invitation/1',payload:{private_marker:'never-return-this'},
        maxAttempts:1,deliveryTimeoutMs:1000}));
      await db.batch(events,'write');
      await page.goto(runtime.url,{waitUntil:'domcontentloaded'});
      await expectInviteGateLoaded(page);
      const first=await page.evaluate(async secret=>{
        const response=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret}});
        return {status:response.status,body:await response.json()};
      },cronSecret);
      expect(first.status).toBe(200);
      expect(first.body.outbox).toMatchObject({
        budget_ms:45_000,max_claims:8,deadline_reached:false,claimed:7,
      });
      expect(first.body.outbox.types['pairing.email.requested']).toMatchObject({
        claimed:5,dead_lettered:5,backlog:0,dead_letter:5,
      });
      expect(first.body.outbox.types['schedule.email.requested']).toMatchObject({
        claimed:1,dead_lettered:1,backlog:0,dead_letter:1,
      });
      expect(first.body.outbox.types['invitation.email.requested']).toMatchObject({
        claimed:1,dead_lettered:1,backlog:0,dead_letter:1,
      });
      expect(JSON.stringify(first.body)).not.toContain('never-return-this');
      const stored=await db.execute(`SELECT event_type,status,lease_owner,lease_token
        FROM outbox_events ORDER BY id`);
      expect(stored.rows).toHaveLength(7);
      expect(stored.rows.every(row=>row.status==='dead_letter'
        &&row.lease_owner===null&&row.lease_token===null)).toBe(true);

      const empty=await page.evaluate(async secret=>{
        const response=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret}});
        return {status:response.status,body:await response.json()};
      },cronSecret);
      expect(empty).toMatchObject({status:200,body:{outbox:{claimed:0,deadline_reached:false}}});
    }finally{
      await db.close();
    }
  }finally{
    await runtime?.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});
