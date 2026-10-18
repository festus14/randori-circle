import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {expect,Page,test} from '@playwright/test';

import {deliverEmailActivations} from '../../api/_email-activation.js';
import {deliverPasswordResets} from '../../api/_password-reset.js';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';
import {expectInviteGateLoaded,stageRealRuntimeClient} from './real-runtime-fixture';

// Full email + password journey against the real loopback runtime: no API
// mocks. Emails are produced by the production outbox handlers and captured
// in-process, so the links the browser opens are exactly what a member would
// receive. Every browser request must stay on the runtime origin.

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
const silentLogger=Object.freeze({log(){},error(){}});
const workerOptions=Object.freeze({heartbeatIntervalMs:0,leaseDurationMs:1000});

type CapturedEmail={to:string,subject:string,html:string};

async function startRuntime(prefix:string){
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),prefix)));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  const runtime=await startLocalDevelopmentServer({config,logger:silentLogger});
  return {rootDir,databaseUrl,runtime};
}

async function json(page:Page,path:string,method='GET',body?:unknown){
  return page.evaluate(async input=>{
    const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',
      ...(input.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input.body)})});
    return {status:response.status,body:await response.json().catch(()=>null)};
  },{path,method,body});
}

async function prepareMember(page:Page){
  await page.addInitScript(()=>{
    localStorage.setItem('randori-onboarded','1');
    localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1');
    localStorage.setItem('randori-landing-dismissed','1');
  });
}

function trackExternalRequests(page:Page,external:string[]){
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1') external.push(request.url());
  });
}

async function openSignin(page:Page){
  await page.evaluate(()=>(window as any)._randori_auth.openModal('signin'));
  await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
}

async function signInThroughForm(page:Page,email:string,password:string){
  await openSignin(page);
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill(password);
  const login=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login');
  await page.locator('#authSignin').click();
  return login;
}

async function signOutThroughMenu(page:Page){
  await page.locator('#meLabel').click();
  await expect(page.locator('#meSignOut')).toBeVisible();
  const logout=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/logout');
  await page.locator('#meSignOut').click();
  expect((await logout).status()).toBe(200);
  await expect(page.locator('#authBtn')).toBeVisible();
}

async function ownerInvite(page:Page,runtimeUrl:string,email:string){
  await page.goto(runtimeUrl,{waitUntil:'domcontentloaded'});
  await expectInviteGateLoaded(page);
  const login=await json(page,'/api/auth/login','POST',{email:LOCAL_OWNER_EMAIL,password:LOCAL_OWNER_PASSWORD});
  expect(login.status).toBe(200);
  const created=await json(page,'/api/invitations','POST',{email});
  expect(created.status).toBe(201);
  const inviteUrl=String(created.body.invitation.invite_url);
  expect(inviteUrl).toMatch(/^\/invite#invite=[A-Za-z0-9_-]{43}$/);
  return `${runtimeUrl}${inviteUrl}`;
}

function onlyLink(message:CapturedEmail){
  const links=[...message.html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]);
  expect(links).toHaveLength(1);
  return links[0];
}

test('invited member signs up, signs in, recovers a forgotten password from the emailed link, and signs in again',async({browser})=>{
  test.setTimeout(120_000);
  const {rootDir,databaseUrl,runtime}=await startRuntime('randori-password-journey-');
  const ownerContext=await browser.newContext();
  const memberContext=await browser.newContext();
  const otherDeviceContext=await browser.newContext();
  const ownerPage=await ownerContext.newPage();
  const page=await memberContext.newPage();
  const otherDevice=await otherDeviceContext.newPage();
  const external:string[]=[];
  for(const tracked of [ownerPage,page,otherDevice]) trackExternalRequests(tracked,external);
  await prepareMember(page);
  await prepareMember(otherDevice);
  const db=createClient({url:databaseUrl});
  const memberEmail='journey.member@example.test';
  const resetEvents=async()=>Number((await db.execute(`SELECT count(*) AS n FROM outbox_events
    WHERE event_type='auth.passwordreset.requested'`)).rows[0].n);
  try{
    // 1. Owner invites; invitee creates an email + password account.
    const inviteUrl=await ownerInvite(ownerPage,runtime.url,memberEmail);
    await page.goto(inviteUrl,{waitUntil:'domcontentloaded'});
    await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
    await page.getByTestId('invite-continue').click();
    await page.locator('#authEmail').fill(memberEmail);
    await page.locator('#authName').fill('Journey Member');
    await page.locator('#authPass').fill('original-member-password');
    const signup=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/signup');
    await page.locator('#authSignup').click();
    expect((await signup).status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText('Journey Member');

    // 2. Sign out, then sign back in through the form (case-insensitive email).
    await signOutThroughMenu(page);
    const wrong=await signInThroughForm(page,memberEmail,'not-the-password');
    expect(wrong.status()).toBe(401);
    await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
    await page.locator('#authCancel').click();
    const unknown=await signInThroughForm(page,'nobody.here@example.test','not-the-password');
    expect(unknown.status()).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
    await page.locator('#authCancel').click();
    const login=await signInThroughForm(page,'Journey.Member@EXAMPLE.test','original-member-password');
    expect(login.status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText('Journey Member');
    const sessionCookie=(await memberContext.cookies(runtime.url)).find(cookie=>cookie.name==='randori_session');
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect((await json(page,'/api/circle')).status).toBe(200);

    // A second device stays signed in until the password is reset.
    await otherDevice.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await expectInviteGateLoaded(otherDevice);
    expect((await signInThroughForm(otherDevice,memberEmail,'original-member-password')).status()).toBe(200);
    await expect(otherDevice.locator('#meLabel')).toContainText('Journey Member');

    // 3. Forgot password: the response is generic and only eligible accounts queue mail.
    await signOutThroughMenu(page);
    await openSignin(page);
    await page.locator('#authForgot').click();
    await page.locator('#authEmail').fill('nobody.here@example.test');
    let requested=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/password-reset/request');
    await page.locator('#authResetRequest').click();
    const unknownReset=await requested;
    expect(unknownReset.status()).toBe(202);
    await expect(page.locator('#authErr')).toContainText('If that account is eligible');
    expect(await resetEvents()).toBe(0);
    await page.locator('#authEmail').fill(memberEmail);
    requested=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/password-reset/request');
    await page.locator('#authResetRequest').click();
    const knownReset=await requested;
    expect(knownReset.status()).toBe(202);
    expect(await knownReset.json()).toEqual(await unknownReset.json());
    await expect(page.locator('#authErr')).toContainText('If that account is eligible');
    expect(await resetEvents()).toBe(1);

    // 4. The outbox delivers the email; its only link is APP_URL/reset-password#token=…
    const sent:CapturedEmail[]=[];
    const delivery=await deliverPasswordResets({db,baseUrl:runtime.url,workerId:'journey-reset',workerOptions,
      send:async(message:CapturedEmail)=>{ sent.push(message); return {providerName:'local-capture',providerMessageId:'journey-reset-1'}; }});
    expect(delivery.delivered).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(memberEmail);
    expect(sent[0].subject).toBe('Reset your Randori password');
    expect(sent[0].html).toContain('expires in 30 minutes');
    const resetLink=onlyLink(sent[0]);
    expect(resetLink).toMatch(new RegExp(`^${runtime.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/reset-password#token=[A-Za-z0-9_-]{43}$`));

    // 5. Open the link, satisfy the password policy, and replace the password.
    await page.goto(resetLink,{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(`${runtime.url}/reset-password`);
    await expect(page.getByTestId('password-reset-landing')).toBeVisible();
    await page.locator('#passwordResetNew').fill('too-short');
    await page.locator('#passwordResetConfirm').fill('too-short');
    await page.locator('#passwordResetSubmit').click();
    await expect(page.getByTestId('password-reset-status')).toContainText('10–72 UTF-8 bytes');
    await page.locator('#passwordResetNew').fill('replacement-member-password');
    await page.locator('#passwordResetConfirm').fill('replacement-member-password');
    const consumed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/password-reset/consume');
    await page.locator('#passwordResetSubmit').click();
    expect((await consumed).status()).toBe(200);
    await expect(page.getByTestId('password-reset-status')).toContainText('all existing sessions were signed out');

    // Every pre-existing session is revoked server-side.
    expect((await json(otherDevice,'/api/auth/me')).status).toBe(401);

    // 6. Old password fails; the new password signs in.
    await page.locator('#passwordResetSignin').click();
    await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
    await page.locator('#authEmail').fill(memberEmail);
    await page.locator('#authPass').fill('original-member-password');
    let relogin=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login');
    await page.locator('#authSignin').click();
    expect((await relogin).status()).toBe(401);
    await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
    await page.locator('#authPass').fill('replacement-member-password');
    relogin=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login');
    await page.locator('#authSignin').click();
    expect((await relogin).status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText('Journey Member');

    // 7. The emailed link is single-use.
    const replay=await otherDeviceContext.newPage();
    trackExternalRequests(replay,external);
    await replay.goto(resetLink,{waitUntil:'domcontentloaded'});
    await replay.locator('#passwordResetNew').fill('a-third-member-password');
    await replay.locator('#passwordResetConfirm').fill('a-third-member-password');
    const replayed=replay.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/password-reset/consume');
    await replay.locator('#passwordResetSubmit').click();
    expect((await replayed).status()).toBe(409);
    await expect(replay.getByTestId('password-reset-status')).toContainText('already been used');

    // 8. An inactive member is refused with a clear message, and recovery queues nothing.
    const memberId=Number((await db.execute({sql:`SELECT id FROM auth_accounts WHERE email=?`,args:[memberEmail]})).rows[0].id);
    await db.execute({sql:`UPDATE circle_memberships SET status='inactive' WHERE user_id=?`,args:[memberId]});
    const removedContext=await browser.newContext();
    try{
      const removed=await removedContext.newPage();
      trackExternalRequests(removed,external);
      await removed.goto(runtime.url,{waitUntil:'domcontentloaded'});
      await expectInviteGateLoaded(removed);
      expect((await signInThroughForm(removed,memberEmail,'replacement-member-password')).status()).toBe(403);
      await expect(removed.locator('#authErr')).toContainText('circle membership is no longer active');
      const before=await resetEvents();
      expect((await json(removed,'/api/auth/password-reset/request','POST',{email:memberEmail})).status).toBe(202);
      expect(await resetEvents()).toBe(before);
    }finally{ await removedContext.close(); }
    expect(external).toEqual([]);
  }finally{
    db.close();
    await ownerContext.close();
    await memberContext.close();
    await otherDeviceContext.close();
    await runtime.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});

test('production-shaped invite activation verifies email before the account can sign in with a password',async({browser})=>{
  test.setTimeout(120_000);
  const {rootDir,databaseUrl,runtime}=await startRuntime('randori-activation-journey-');
  // Switch this in-process runtime from the local identity adapter to the
  // production verified-email activation path (same handlers, same database).
  const priorActivation=process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED;
  process.env.RANDORI_LOCAL_IDENTITY='false';
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  const ownerContext=await browser.newContext();
  const inviteeContext=await browser.newContext();
  const ownerPage=await ownerContext.newPage();
  const page=await inviteeContext.newPage();
  const external:string[]=[];
  for(const tracked of [ownerPage,page]) trackExternalRequests(tracked,external);
  await prepareMember(page);
  const db=createClient({url:databaseUrl});
  const email='verified.member@example.test';
  try{
    const inviteUrl=await ownerInvite(ownerPage,runtime.url,email);
    await page.goto(inviteUrl,{waitUntil:'domcontentloaded'});
    await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
    await page.getByTestId('invite-continue').click();
    await expect(page.getByRole('dialog',{name:'Join Randori Circle'})).toBeVisible();
    await page.locator('#authEmail').fill(email);
    await page.locator('#authName').fill('Verified Member');
    await page.locator('#authPass').fill('verified-member-password');
    const signup=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/signup');
    await page.locator('#authSignup').click();
    expect((await signup).status()).toBe(202);
    await expect(page.getByTestId('activation-pending')).toBeVisible();
    await expect(page.locator('#meLabel')).toBeHidden();
    expect((await json(page,'/api/auth/login','POST',{email,password:'verified-member-password'})).status).toBe(401);

    const sent:CapturedEmail[]=[];
    const delivery=await deliverEmailActivations({db,baseUrl:runtime.url,workerId:'journey-activation',workerOptions,
      send:async(message:CapturedEmail)=>{ sent.push(message); return {providerName:'local-capture',providerMessageId:'journey-activation-1'}; }});
    expect(delivery.delivered).toBe(1);
    expect(sent[0].to).toBe(email);
    const verifyLink=onlyLink(sent[0]);
    expect(verifyLink.startsWith(`${runtime.url}/verify#token=`)).toBe(true);

    await page.goto(verifyLink,{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(`${runtime.url}/verify`);
    await expect(page.getByTestId('activation-status')).toContainText('account is ready');
    await page.getByTestId('activation-continue').click();
    await expect(page.locator('#meLabel')).toContainText('Verified Member');
    expect((await json(page,'/api/circle')).status).toBe(200);

    await signOutThroughMenu(page);
    const login=await signInThroughForm(page,email,'verified-member-password');
    expect(login.status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText('Verified Member');
    expect(external).toEqual([]);
  }finally{
    db.close();
    await ownerContext.close();
    await inviteeContext.close();
    await runtime.close();
    if(priorActivation===undefined) delete process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED;
    else process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED=priorActivation;
    rmSync(rootDir,{recursive:true,force:true});
  }
});
