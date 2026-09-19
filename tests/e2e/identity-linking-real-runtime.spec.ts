import {copyFileSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {expect,test} from '@playwright/test';

import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));

test('real local account security stays isolated and refuses removal of the final credential',async({browser})=>{
  test.setTimeout(60_000);
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-identity-browser-')));
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

    await page.locator('#meLabel').click();
    await page.getByRole('menuitem',{name:'Account security'}).click();
    await expect(page.getByRole('dialog',{name:'Account security'})).toBeVisible();
    await expect(page.locator('#identityPasswordState')).toHaveText('linked');
    await expect(page.locator('#identityGoogleState')).toHaveText('not linked');
    await expect(page.locator('#identityPasswordAction')).toBeDisabled();
    await expect(page.locator('#identityPasswordHelp')).toContainText('final sign-in method');

    const denied=await page.evaluate(async()=>{
      const response=await fetch('/api/auth/identities/password',{
        method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        body:JSON.stringify({action:'unlink'}),
      });
      return {status:response.status,body:await response.json()};
    });
    expect(denied.status).toBe(409);
    expect(denied.body.status).toBe('final_credential');

    const db=createClient({url:databaseUrl});
    const audit=(await db.execute(`SELECT event_type,provider,outcome,reason_code
      FROM auth_identity_audit_events ORDER BY id DESC LIMIT 1`)).rows[0];
    await db.close();
    expect(audit).toEqual({event_type:'unlink_denied',provider:'password',outcome:'denied',reason_code:'final_credential'});
    expect(externalRequests).toEqual([]);
  }finally{
    await context.close();
    await runtime.close();
    rmSync(rootDir,{recursive:true,force:true});
  }
});
