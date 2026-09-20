import { mkdirSync, mkdtempSync, realpathSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { expect, test } from '@playwright/test';

import { deliverInvitationEmails } from '../../api/_invitation-email.js';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
const silentLogger=Object.freeze({log(){},error(){}});

async function json(page,path,method='GET',body){
  return page.evaluate(async input=>{
    const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',
      ...(input.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input.body)})});
    return {status:response.status,body:await response.json()};
  },{path,method,body});
}

test('owner queues, resends, and locally delivers a rotated invitation that the invitee activates',async({browser})=>{
  test.setTimeout(90_000);
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-invitation-runtime-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  mkdirSync(join(rootDir,'assets'));
  copyFileSync(join(repositoryRoot,'index.html'),join(rootDir,'index.html'));
  copyFileSync(join(repositoryRoot,'assets','invite-gate.js'),join(rootDir,'assets','invite-gate.js'));
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  const ownerContext=await browser.newContext();
  const inviteeContext=await browser.newContext();
  const ownerPage=await ownerContext.newPage();
  const inviteePage=await inviteeContext.newPage();
  let runtime=null;
  let copied='';
  await ownerPage.exposeFunction('captureInviteCopy',(value:string)=>{ copied=value; });
  await ownerPage.addInitScript(()=>{
    localStorage.setItem('randori-onboarded','1');
    localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1');
    localStorage.setItem('randori-landing-dismissed','1');
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
      writeText:(value:string)=>(window as typeof window&{
        captureInviteCopy:(copied:string)=>Promise<void>;
      }).captureInviteCopy(value),
    }});
  });
  await inviteePage.addInitScript(()=>{
    localStorage.setItem('randori-onboarded','1');
    localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1');
    localStorage.setItem('randori-landing-dismissed','1');
  });
  try{
    runtime=await startLocalDevelopmentServer({config,logger:silentLogger});
    await ownerPage.goto(runtime.url,{waitUntil:'domcontentloaded'});
    const login=await json(ownerPage,'/api/auth/login','POST',{
      email:LOCAL_OWNER_EMAIL,password:LOCAL_OWNER_PASSWORD,
    });
    expect(login.status).toBe(200);
    await ownerPage.reload({waitUntil:'domcontentloaded'});
    await expect(ownerPage.locator('#meLabel')).toContainText('Local Circle Owner');
    await ownerPage.locator('[data-tab="circle"]').click();
    await expect(ownerPage.getByTestId('circle-invite-email')).toBeVisible();
    await ownerPage.getByTestId('circle-invite-email').fill('delivered.invitee@example.test');
    const createdResponse=ownerPage.waitForResponse(response=>
      response.url().endsWith('/api/invitations')&&response.request().method()==='POST');
    await ownerPage.getByTestId('circle-invite-create').click();
    const created=await createdResponse;
    const createdPayload=await created.json();
    expect(created.status()).toBe(201);
    expect(createdPayload.email_delivery).toEqual({queued:true});
    await expect(ownerPage.getByTestId('circle-invite-link')).toBeVisible();
    await ownerPage.getByTestId('circle-invite-link').click();
    await expect.poll(()=>copied).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/invite#invite=[A-Za-z0-9_-]{43}$/);
    const firstUrl=copied;
    const firstToken=new URL(firstUrl).hash.slice('#invite='.length);

    const db=createClient({url:databaseUrl});
    const captured=[];
    try{
      const stored=(await db.execute(`SELECT payload_json FROM outbox_events
        WHERE event_type='invitation.email.requested'`)).rows;
      expect(stored).toHaveLength(1);
      expect(String(stored[0].payload_json)).not.toContain(firstToken);
      expect(String(stored[0].payload_json)).not.toContain('delivered.invitee@example.test');
      const firstDelivery=await deliverInvitationEmails({db,baseUrl:runtime.url,localRuntime:true,
        workerId:'browser-invitation-create',send:async message=>{
          captured.push(message);
          return {providerName:'local-capture',providerMessageId:'invite-browser-1'};
        },workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
      expect(firstDelivery.delivered).toBe(1);
      expect(captured[0].to).toBe('delivered.invitee@example.test');
      expect(captured[0].html).toContain(firstUrl);
      const duplicate=await deliverInvitationEmails({db,baseUrl:runtime.url,localRuntime:true,
        workerId:'browser-invitation-duplicate',send:async()=>{
          throw new Error('duplicate worker must not redeliver');
        },workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
      expect(duplicate.claimed).toBe(0);

      await db.execute(`UPDATE outbox_events
        SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 seconds')
        WHERE event_type='invitation.email.requested'`);
      const resendResponse=ownerPage.waitForResponse(response=>
        response.url().includes('/api/invitations/')&&response.request().method()==='POST');
      await ownerPage.getByTestId('circle-invite-resend').click();
      const resent=await resendResponse;
      expect(resent.status()).toBe(200);
      await expect(ownerPage.getByTestId('circle-invite-link')).toBeVisible();
      copied='';
      await ownerPage.getByTestId('circle-invite-link').click();
      await expect.poll(()=>copied).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/invite#invite=[A-Za-z0-9_-]{43}$/);
      const secondUrl=copied;
      expect(secondUrl).not.toBe(firstUrl);
      expect((await json(ownerPage,'/api/invitations/prepare','POST',{token:firstToken})).status).toBe(400);

      const secondDelivery=await deliverInvitationEmails({db,baseUrl:runtime.url,localRuntime:true,
        workerId:'browser-invitation-resend',send:async message=>{
          captured.push(message);
          return {providerName:'local-capture',providerMessageId:'invite-browser-2'};
        },workerOptions:{heartbeatIntervalMs:0,leaseDurationMs:1000}});
      expect(secondDelivery.delivered).toBe(1);
      expect(captured).toHaveLength(2);
      expect(captured[1].html).toContain(secondUrl);
      expect(captured[1].html).not.toContain(firstToken);

      await inviteePage.goto(secondUrl,{waitUntil:'domcontentloaded'});
      await expect(inviteePage).toHaveURL(`${runtime.url}/invite`);
      await expect(inviteePage.getByTestId('invite-status')).toContainText('Invitation verified');
      await inviteePage.getByTestId('invite-continue').click();
      await inviteePage.locator('#authEmail').fill('delivered.invitee@example.test');
      await inviteePage.locator('#authName').fill('Delivered Invitee');
      await inviteePage.locator('#authPass').fill('invitee-password-123');
      const signupResponse=inviteePage.waitForResponse(response=>
        response.url().endsWith('/api/auth/signup')&&response.request().method()==='POST');
      await inviteePage.locator('#authSignup').click();
      expect((await signupResponse).status()).toBe(200);
      await expect(inviteePage.locator('#meLabel')).toContainText('Delivered Invitee');
      const invitation=(await db.execute({sql:`SELECT used_by,used_at,token_hash
        FROM circle_invitations WHERE id=?`,args:[createdPayload.invitation.id]})).rows[0];
      expect(Number(invitation.used_by)).toBeGreaterThan(1);
      expect(invitation.used_at).not.toBeNull();
      expect(String(invitation.token_hash)).not.toBe(firstToken);
    }finally{
      await db.close();
    }
  }finally{
    await runtime?.close();
    await ownerContext.close();
    await inviteeContext.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});
