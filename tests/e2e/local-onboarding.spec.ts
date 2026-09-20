import { expect, test } from '@playwright/test';
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
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
import { createInvitationToken, hashInvitationEmail, hashInvitationToken } from '../../api/_circle-membership.js';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));

test.describe('unmocked local onboarding',()=>{
  test.describe.configure({mode:'serial'});
  let directory='';
  let config:ReturnType<typeof resolveLocalServerConfig>;
  let runtime:Awaited<ReturnType<typeof startLocalDevelopmentServer>>|null=null;
  const requestSql:string[]=[];

  test.beforeAll(async()=>{
    directory=realpathSync(mkdtempSync(join(tmpdir(),'randori-local-onboarding-e2e-')));
    mkdirSync(join(directory,'.local'),{mode:0o700});
    mkdirSync(join(directory,'assets'));
    copyFileSync(join(repositoryRoot,'index.html'),join(directory,'index.html'));
    copyFileSync(join(repositoryRoot,'assets','invite-gate.js'),join(directory,'assets','invite-gate.js'));
    const databaseUrl=pathToFileURL(join(directory,'.local','onboarding.sqlite')).href;
    config=resolveLocalServerConfig({
      rootDir:directory,
      argv:[],
      env:{
        NODE_ENV:'development',
        RANDORI_LOCAL_HOST:'127.0.0.1',
        RANDORI_LOCAL_PORT:'0',
        RANDORI_LOCAL_DATABASE_URL:databaseUrl,
      },
    });
    runtime=await startLocalDevelopmentServer({
      config,
      logger:{log(){},error(){}},
      sqlObserver:(sql:string)=>requestSql.push(sql),
    });
  });

  test.afterAll(async()=>{
    await runtime?.close();
    if(directory) rmSync(directory,{recursive:true,force:true});
  });

  test('owner invites, invited identity signs up, joins the circle, and receives an authenticated pair',async({browser})=>{
    test.setTimeout(90_000);
    if(!runtime?.url) throw new Error('local runtime unavailable');
    const ownerContext=await browser.newContext();
    const memberContext=await browser.newContext();
    const noInviteContext=await browser.newContext();
    const reusedInviteContext=await browser.newContext();
    const externalRequests:string[]=[];
    for(const context of [ownerContext,memberContext,noInviteContext,reusedInviteContext]){
      context.on('request',request=>{
        const url=new URL(request.url());
        if(url.protocol!=='http:'||url.hostname!=='127.0.0.1') externalRequests.push(request.url());
      });
    }
    const owner=await ownerContext.newPage();
    const member=await memberContext.newPage();
    const noInvite=await noInviteContext.newPage();
    const reusedInvite=await reusedInviteContext.newPage();
    try{
      await noInvite.goto(runtime.url,{waitUntil:'domcontentloaded'});
      expect(await noInvite.evaluate(()=>(window as any).__RANDORI_LOCAL_RUNTIME__)).toBe(true);
      const noInviteSignup=await noInvite.evaluate(async()=>{
        const response=await fetch('/api/auth/signup',{
          method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
          body:JSON.stringify({email:'no.invite@example.test',password:'member-password-123',name:'No Invite'}),
        });
        return {status:response.status,body:await response.json()};
      });
      expect(noInviteSignup).toEqual({status:403,body:{error:'a valid local invitation is required'}});

      await owner.goto(runtime.url,{waitUntil:'domcontentloaded'});
      await owner.locator('#landingSignin').click();
      await owner.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
      await owner.locator('#authPass').fill(LOCAL_OWNER_PASSWORD);
      await owner.locator('#authSignin').click();
      await expect(owner.locator('#meLabel')).toContainText('Local Circle Owner');

      const csrfResponse=await ownerContext.request.post(new URL('/api/invitations',runtime.url).href,{
        headers:{origin:'https://attacker.example.test'},
        data:{email:'csrf@example.test'},
      });
      expect(csrfResponse.status()).toBe(403);

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

      const preparedResponse=member.waitForResponse(response=>
        new URL(response.url()).pathname==='/api/invitations/prepare'
          &&response.request().method()==='POST',
      );
      await member.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
      const preparedPayload=await (await preparedResponse).json();
      expect(preparedPayload.binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(member).toHaveURL(/\/invite$/);
      await expect(member.getByTestId('invite-status')).toContainText('Invitation verified');
      await expect(member.getByTestId('invite-continue')).toHaveText('Create local account');
      await member.getByTestId('invite-continue').click();
      await expect(member.locator('#authOverlay')).toHaveClass(/show/);
      await member.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
      await member.locator('#authName').fill('Wrong Identity');
      await member.locator('#authPass').fill('member-password-123');
      const wrongIdentityResponse=member.waitForResponse(response=>
        new URL(response.url()).pathname==='/api/auth/signup'&&response.request().method()==='POST',
      );
      await member.locator('#authSignup').click();
      const rejectedIdentity=await wrongIdentityResponse;
      expect(rejectedIdentity.status()).toBe(403);
      expect(await rejectedIdentity.json()).toEqual({error:'invitation unavailable or does not match this email'});
      await expect(member.locator('#authErr')).toContainText('invitation unavailable');

      await member.locator('#authEmail').fill('invited.member@example.test');
      await member.locator('#authName').fill('Invited Member');
      await member.locator('#authSignup').click();

      await expect(member).toHaveURL(new RegExp(`${runtime.url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}/?$`));
      await expect(member.locator('#view-profile-setup')).toBeVisible();
      const profileResponse=member.waitForResponse(response=>
        new URL(response.url()).pathname==='/api/profile'&&response.request().method()==='POST',
      );
      await member.locator('#psSave').click();
      const savedProfile=await profileResponse;
      expect(savedProfile.status()).toBe(200);
      expect(Number((await savedProfile.json()).user?.id)).toBeGreaterThan(0);
      await expect(member.locator('#view-dashboard')).toBeVisible();
      await expect(member.locator('#dashWelcome')).toContainText('Invited Member');
      const memberCookies=await memberContext.cookies(new URL('/api/auth/signup',runtime.url).href);
      expect(memberCookies.some(cookie=>cookie.name==='randori_session'&&cookie.httpOnly)).toBe(true);
      const inertInviteClaim=memberCookies.find(cookie=>cookie.name==='randori_invite_claim');
      expect(inertInviteClaim).toEqual(expect.objectContaining({httpOnly:true,path:'/api'}));

      const reuseResponse=await memberContext.request.post(new URL('/api/auth/signup',runtime.url).href,{
        headers:{origin:runtime.url},data:{
          email:'second.member@example.test',password:'another correct horse battery',name:'Second Member',
          invite_binding:preparedPayload.binding,
        },
      });
      expect(reuseResponse.status()).toBe(403);
      expect(await reuseResponse.json()).toEqual({error:'invitation unavailable or does not match this email'});

      const meResponse=await memberContext.request.get(new URL('/api/auth/me',runtime.url).href);
      expect(meResponse.status()).toBe(200);
      expect((await meResponse.json()).user.email).toBe('invited.member@example.test');
      const preferencesResponse=await memberContext.request.get(new URL('/api/notifications/prefs',runtime.url).href);
      expect(preferencesResponse.status()).toBe(200);
      const savePreferencesResponse=await memberContext.request.post(new URL('/api/notifications/prefs',runtime.url).href,{
        headers:{origin:runtime.url},data:{email_enabled:true,sms_enabled:false},
      });
      expect(savePreferencesResponse.status()).toBe(200);
      const clientLogResponse=await memberContext.request.post(new URL('/api/logs',runtime.url).href,{
        headers:{origin:runtime.url},
        data:{level:'info',source:'client',event:'local_sql_trace',message:'authenticated local log'},
      });
      expect(clientLogResponse.status()).toBe(200);
      expect((await clientLogResponse.json()).inserted).toBe(1);

      await reusedInvite.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
      await expect(reusedInvite.getByTestId('invite-status')).toContainText('unavailable');
      expect((await reusedInviteContext.cookies(runtime.url)).some(cookie=>cookie.name==='randori_invite_claim')).toBe(false);

      const createNegativeInvite=async(email:string)=>{
        const response=await ownerContext.request.post(new URL('/api/invitations',runtime!.url).href,{
          headers:{origin:runtime!.url},data:{email},
        });
        expect(response.status()).toBe(201);
        const payload=await response.json();
        return {
          id:String(payload.invitation.id),
          url:new URL(String(payload.invitation.invite_url),runtime!.url),
        };
      };
      const expectUnavailable=async(url:URL)=>{
        await reusedInvite.goto(runtime!.url,{waitUntil:'domcontentloaded'});
        await reusedInvite.goto(url.href,{waitUntil:'domcontentloaded'});
        await expect(reusedInvite.getByTestId('invite-status')).toContainText('unavailable');
        expect((await reusedInviteContext.cookies(runtime!.url)).some(cookie=>cookie.name==='randori_invite_claim')).toBe(false);
      };

      const revokedInvite=await createNegativeInvite('revoked.member@example.test');
      const revoked=await ownerContext.request.delete(new URL(`/api/invitations/${revokedInvite.id}`,runtime.url).href,{
        headers:{origin:runtime.url},
      });
      expect(revoked.status()).toBe(200);
      await expectUnavailable(revokedInvite.url);

      const expiredInvite=await createNegativeInvite('expired.member@example.test');
      const directDatabase=createClient({url:config.databaseUrl});
      try{
        await directDatabase.execute({
          sql:`UPDATE circle_invitations SET expires_at=datetime('now','-1 second') WHERE id=?`,
          args:[expiredInvite.id],
        });
        const crossCircleToken=createInvitationToken();
        const crossCircleId=randomUUID();
        await directDatabase.batch([{
          sql:`INSERT INTO circles (public_id,slug,name,is_primary,created_by,created_at)
            VALUES (?,'e2e-secondary-circle','Secondary Circle',0,1,datetime('now'))`,
          args:[randomUUID()],
        },{
          sql:`INSERT INTO circle_invitations
              (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
            SELECT ?,id,?,?,1,datetime('now'),datetime('now','+7 days')
            FROM circles WHERE slug='e2e-secondary-circle'`,
          args:[crossCircleId,hashInvitationToken(crossCircleToken),hashInvitationEmail('cross.circle@example.test')],
        }],'write');
        await expectUnavailable(expiredInvite.url);
        await expectUnavailable(new URL(`/invite#invite=${crossCircleToken}`,runtime.url));
      }finally{
        await directDatabase.close();
      }

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
      await member.locator('[data-tab="code"]').click();
      await expect(member.locator('#editor')).toBeVisible();

      await runtime.close();
      runtime=await startLocalDevelopmentServer({
        config,
        logger:{log(){},error(){}},
        sqlObserver:(sql:string)=>requestSql.push(sql),
      });
      await member.goto(runtime.url,{waitUntil:'domcontentloaded'});
      await expect(member.locator('#view-dashboard')).toBeVisible();
      await expect(member.locator('#dashPairArea')).toContainText('Local Circle Owner');
      expect(requestSql.filter(sql=>/^\s*(?:CREATE|ALTER|DROP)\b/iu.test(sql))).toEqual([]);
      expect(externalRequests).toEqual([]);
    }finally{
      await Promise.all([ownerContext.close(),memberContext.close(),noInviteContext.close(),reusedInviteContext.close()]);
    }
  });
});
