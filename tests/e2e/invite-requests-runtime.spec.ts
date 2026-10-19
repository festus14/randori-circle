import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { expect, test, type Page } from '@playwright/test';

import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';
import { expectInviteGateLoaded, stageRealRuntimeClient } from './real-runtime-fixture';

// Golden path for WP-L2 on the real local runtime (migrated SQLite, real
// handlers, real routing): an anonymous visitor requests an invite, the owner
// sees it in the review API, approves it, and the resulting normal invitation
// verifies and activates in the browser. The landing form and owner panel UI
// ship in later packages, so the visitor and owner act through same-origin
// fetches from their own browser contexts.

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
const silentLogger=Object.freeze({log(){},error(){}});
const ACCEPTED="Thanks — if the circle has room, you'll get an invitation by email.";

async function json(page:Page,path:string,method='GET',body?:unknown){
  return page.evaluate(async input=>{
    const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',
      ...(input.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input.body)})});
    return {status:response.status,body:await response.json()};
  },{path,method,body});
}

async function primeOnboarding(page:Page){
  await page.addInitScript(()=>{
    localStorage.setItem('randori-onboarded','1');
    localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1');
    localStorage.setItem('randori-landing-dismissed','1');
  });
}

test('a public invite request is approved by the owner into a working single-use invitation',async({browser})=>{
  test.setTimeout(90_000);
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-invite-request-runtime-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  const visitorContext=await browser.newContext();
  const ownerContext=await browser.newContext();
  const visitorPage=await visitorContext.newPage();
  const ownerPage=await ownerContext.newPage();
  await primeOnboarding(visitorPage);
  await primeOnboarding(ownerPage);
  let runtime=null;
  try{
    runtime=await startLocalDevelopmentServer({config,logger:silentLogger});
    await visitorPage.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await expectInviteGateLoaded(visitorPage);

    const capabilities=await json(visitorPage,'/api/auth/capabilities');
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.capabilities.inviteRequests).toBe(true);

    const request={name:'Runtime Requester',email:'Runtime.Requester@Example.Test',
      note:'Preparing for system design loops',website:''};
    const submitted=await json(visitorPage,'/api/invite-requests','POST',request);
    expect(submitted).toEqual({status:202,body:{ok:true,message:ACCEPTED}});
    const duplicate=await json(visitorPage,'/api/invite-requests','POST',{...request,name:'Second Try'});
    expect(duplicate).toEqual(submitted);
    const honeypot=await json(visitorPage,'/api/invite-requests','POST',{...request,
      email:'bot@example.test',website:'https://spam.example'});
    expect(honeypot).toEqual(submitted);
    expect((await json(visitorPage,'/api/invite-requests')).status).toBe(401);

    await ownerPage.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await expectInviteGateLoaded(ownerPage);
    const login=await json(ownerPage,'/api/auth/login','POST',{email:LOCAL_OWNER_EMAIL,password:LOCAL_OWNER_PASSWORD});
    expect(login.status).toBe(200);
    const pending=await json(ownerPage,'/api/invite-requests?status=pending');
    expect(pending.status).toBe(200);
    expect(pending.body.pending_count).toBe(1);
    expect(pending.body.requests).toHaveLength(1);
    const [entry]=pending.body.requests;
    expect(entry).toMatchObject({name:'Runtime Requester',email:'runtime.requester@example.test',
      note:'Preparing for system design loops'});

    const approved=await json(ownerPage,'/api/invite-requests/decision','POST',
      {id:entry.id,decision:'approve',expected_status:'pending'});
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({id:entry.id,status:'approved'});
    expect(approved.body.invitation).toMatchObject({email:'runtime.requester@example.test',status:'pending'});
    expect(approved.body.invitation.invite_url).toMatch(/^\/invite#invite=[A-Za-z0-9_-]{43}$/);
    const replay=await json(ownerPage,'/api/invite-requests/decision','POST',
      {id:entry.id,decision:'approve',expected_status:'pending'});
    expect(replay.body).toMatchObject({ok:true,replayed:true,invitation:{id:approved.body.invitation.id}});
    expect((await json(ownerPage,'/api/invite-requests')).body.pending_count).toBe(0);

    const invitations=await json(ownerPage,'/api/invitations');
    expect(invitations.status).toBe(200);
    expect(invitations.body.invitations.filter((item:{id:string})=>item.id===approved.body.invitation.id))
      .toEqual([expect.objectContaining({status:'pending'})]);

    const db=createClient({url:databaseUrl});
    try{
      const rows=(await db.execute(`SELECT status,email,name,note,invitation_id FROM invite_requests`)).rows;
      expect(rows.map(row=>({...row}))).toEqual([{status:'approved',email:null,name:null,note:null,
        invitation_id:approved.body.invitation.id}]);
      const digest=(await db.execute(`SELECT payload_json FROM outbox_events
        WHERE event_type='inviterequest.email.requested'`)).rows;
      expect(digest).toHaveLength(1);
      expect(String(digest[0].payload_json)).not.toContain('runtime.requester');
      expect((await db.execute(`SELECT COUNT(*) AS count FROM invite_requests WHERE email='bot@example.test'`))
        .rows[0].count).toBe(0);
    }finally{ db.close(); }

    // The invitee follows the approved link exactly like an owner-created invitation.
    await visitorPage.goto(`${runtime.url}${approved.body.invitation.invite_url}`,{waitUntil:'domcontentloaded'});
    await expect(visitorPage).toHaveURL(`${runtime.url}/invite`);
    await expect(visitorPage.getByTestId('invite-status')).toContainText('Invitation verified');
    await visitorPage.getByTestId('invite-continue').click();
    await visitorPage.locator('#authEmail').fill('runtime.requester@example.test');
    await visitorPage.locator('#authName').fill('Runtime Requester');
    await visitorPage.locator('#authPass').fill('requester-password-123');
    const signupResponse=visitorPage.waitForResponse(response=>
      response.url().endsWith('/api/auth/signup')&&response.request().method()==='POST');
    await visitorPage.locator('#authSignup').click();
    expect((await signupResponse).status()).toBe(200);
    await expect(visitorPage.locator('#meLabel')).toContainText('Runtime Requester');
  }finally{
    await runtime?.close();
    await visitorContext.close();
    await ownerContext.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});
