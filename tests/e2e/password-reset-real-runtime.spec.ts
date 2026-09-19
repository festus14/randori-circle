import {copyFileSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {expect,test} from '@playwright/test';

import {openPasswordResetToken} from '../../api/_password-reset.js';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));

test('real local password recovery is isolated, fragment-safe, and revokes the previous session',async({browser})=>{
  test.setTimeout(60_000);
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-reset-browser-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  copyFileSync(join(repositoryRoot,'index.html'),join(rootDir,'index.html'));
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  const runtime=await startLocalDevelopmentServer({config,logger:{log(){},error(){}}});
  const context=await browser.newContext();
  const page=await context.newPage();
  const externalRequests:string[]=[];
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1') externalRequests.push(request.url());
  });
  try{
    await page.goto(runtime.url,{waitUntil:'domcontentloaded'});
    await page.locator('#landingSignin').click();
    await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
    await page.locator('#authPass').fill(LOCAL_OWNER_PASSWORD);
    await page.locator('#authSignin').click();
    await expect(page.locator('#meLabel')).toContainText('Local Circle Owner');
    const originalSession=(await context.cookies(runtime.url)).find(cookie=>cookie.name==='randori_session');
    expect(originalSession).toBeDefined();

    await page.evaluate(()=>(window as any)._randori_auth.openModal('signin'));
    await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
    await page.locator('#authForgot').click();
    await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
    const requested=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/password-reset/request');
    await page.locator('#authResetRequest').click();
    expect((await requested).status()).toBe(202);
    await expect(page.locator('#authErr')).toContainText('If that account is eligible');

    const db=createClient({url:databaseUrl});
    const event=(await db.execute(`SELECT payload_json FROM outbox_events
      WHERE event_type='auth.passwordreset.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
    const token=openPasswordResetToken(JSON.parse(String(event.payload_json)).token_envelope);
    await db.close();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await page.goto(`${runtime.url}/reset-password#token=${token}`,{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(`${runtime.url}/reset-password`);
    await page.locator('#passwordResetNew').fill('new-local-owner-password');
    await page.locator('#passwordResetConfirm').fill('new-local-owner-password');
    await page.locator('#passwordResetSubmit').click();
    await expect(page.getByTestId('password-reset-status')).toContainText('all existing sessions were signed out');
    await expect(page.locator('#meLabel')).toBeHidden();
    expect(await page.evaluate(()=>localStorage.getItem('randori-me'))).toBeNull();

    const preserved=await fetch(new URL('/api/auth/me',runtime.url),{
      headers:{cookie:`${originalSession!.name}=${originalSession!.value}`},
    });
    expect(preserved.status).toBe(401);
    await page.locator('#passwordResetSignin').click();
    await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
    await page.locator('#authPass').fill('new-local-owner-password');
    await page.locator('#authSignin').click();
    await expect(page.locator('#meLabel')).toContainText('Local Circle Owner');
    expect(externalRequests).toEqual([]);
  }finally{
    await context.close();
    await runtime.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});
