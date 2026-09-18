import { expect, test } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));

test.describe('unmocked local onboarding',()=>{
  test.describe.configure({mode:'serial'});
  let directory='';
  let runtime:Awaited<ReturnType<typeof startLocalDevelopmentServer>>|null=null;

  test.beforeAll(async()=>{
    directory=realpathSync(mkdtempSync(join(tmpdir(),'randori-local-onboarding-e2e-')));
    mkdirSync(join(directory,'.local'),{mode:0o700});
    copyFileSync(join(repositoryRoot,'index.html'),join(directory,'index.html'));
    const databaseUrl=pathToFileURL(join(directory,'.local','onboarding.sqlite')).href;
    const config=resolveLocalServerConfig({
      rootDir:directory,
      argv:[],
      env:{
        NODE_ENV:'development',
        RANDORI_LOCAL_HOST:'127.0.0.1',
        RANDORI_LOCAL_PORT:'0',
        RANDORI_LOCAL_DATABASE_URL:databaseUrl,
      },
    });
    runtime=await startLocalDevelopmentServer({config,logger:{log(){},error(){}}});
  });

  test.afterAll(async()=>{
    await runtime?.close();
    if(directory) rmSync(directory,{recursive:true,force:true});
  });

  test('owner invites, invited identity signs up, joins the circle, and receives an authenticated pair',async({browser})=>{
    test.setTimeout(60_000);
    if(!runtime?.url) throw new Error('local runtime unavailable');
    const ownerContext=await browser.newContext();
    const memberContext=await browser.newContext();
    await Promise.all([ownerContext,memberContext].map(context=>context.route('https://**/*',route=>route.abort())));
    const owner=await ownerContext.newPage();
    const member=await memberContext.newPage();
    try{
      await owner.goto(runtime.url,{waitUntil:'domcontentloaded'});
      await owner.locator('#landingSignin').click();
      await owner.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
      await owner.locator('#authPass').fill(LOCAL_OWNER_PASSWORD);
      await owner.locator('#authSignin').click();
      await expect(owner.locator('#meLabel')).toContainText('Local Circle Owner');

      await owner.locator('[data-tab="circle"]').click();
      await expect(owner.getByTestId('circle-invite-email')).toBeVisible();
      await owner.getByTestId('circle-invite-email').fill('invited.member@example.test');
      const createResponse=owner.waitForResponse(response=>
        new URL(response.url()).pathname==='/api/invitations'&&response.request().method()==='POST',
      );
      await owner.getByTestId('circle-invite-create').click();
      const invitationResponse=await createResponse;
      expect(invitationResponse.status()).toBe(201);
      const invitationPayload=await invitationResponse.json();
      const inviteUrl=new URL(String(invitationPayload.invitation?.invite_url||''),runtime.url);
      expect(inviteUrl.pathname).toBe('/invite');
      expect(inviteUrl.hash).toMatch(/^#invite=[A-Za-z0-9_-]{43}$/);

      await member.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
      await expect(member).toHaveURL(/\/invite$/);
      await expect(member.getByTestId('invite-status')).toContainText('Invitation verified');
      await expect(member.getByTestId('invite-continue')).toHaveText('Create local account');
      await member.getByTestId('invite-continue').click();
      await expect(member.locator('#authOverlay')).toHaveClass(/show/);
      await member.locator('#authEmail').fill('invited.member@example.test');
      await member.locator('#authName').fill('Invited Member');
      await member.locator('#authPass').fill('member-password-123');
      await member.locator('#authSignup').click();

      await expect(member).toHaveURL(new RegExp(`${runtime.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/?$`));
      await expect(member.locator('#view-profile-setup')).toBeVisible();
      await member.locator('#psSave').click();
      await expect(member.locator('#view-dashboard')).toBeVisible();
      await expect(member.locator('#dashWelcome')).toContainText('Invited Member');

      await owner.locator('[data-tab="pair"]').click();
      await expect(owner.locator('#newWeekBtn')).toBeVisible();
      const pairingResponse=owner.waitForResponse(response=>
        new URL(response.url()).pathname==='/api/pairing/run'&&response.request().method()==='POST',
      );
      await owner.locator('#newWeekBtn').click();
      expect((await pairingResponse).status()).toBe(200);

      await member.reload({waitUntil:'domcontentloaded'});
      await expect(member.locator('#view-dashboard')).toBeVisible();
      await expect(member.locator('#dashPairArea')).toContainText('Local Circle Owner');
      const session=await memberContext.cookies(runtime.url);
      expect(session.some(cookie=>cookie.name==='randori_session'&&cookie.httpOnly)).toBe(true);
    }finally{
      await Promise.all([ownerContext.close(),memberContext.close()]);
    }
  });
});
