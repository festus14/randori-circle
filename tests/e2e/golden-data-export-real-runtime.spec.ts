import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';

import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_NAME,
  MEMBER_PASSWORD,
  createPairedCircle,
  json,
  newGoldenPage,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Issue #365 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 25). The real
// loopback runtime runs with DATA_EXPORT_ENABLED. A paired member sends a
// chat message, opens Edit profile where Download my data explains what is
// included and what is not, is refused while their sign-in proof is older
// than ten minutes, confirms their password through Account security,
// downloads a JSON archive holding only their own data (partner by display
// name only), and the partner's own export holds only the partner's message
// and run. With the flag off there is no endpoint, capability, section or
// script.

const FLAG='DATA_EXPORT_ENABLED';
const SCRIPT='/assets/data-export.js';

async function openEditProfile(page:Page){
  await page.locator('#meLabel').click();
  const item=page.getByRole('menuitem',{name:'Edit profile',exact:true});
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#view-profile-setup')).toHaveAttribute('data-mode','edit');
}

async function expectAccessible(page:Page,selector:string,label:string){
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      const results=await new AxeBuilder({page}).include(selector)
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`${label} ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
  await page.emulateMedia({reducedMotion:null});
}

test('data export: a member downloads only their own data after re-authenticating, partners by display name only',async({browser})=>{
  test.setTimeout(240_000);
  const original=process.env[FLAG];
  process.env[FLAG]='true';
  const golden=await startGoldenRuntime('randori-golden-data-export-');
  try{
    const pair=await createPairedCircle(browser,golden,{memberEmail:'export.member@example.test',memberName:'Export Member'});
    const owner=pair.owner.page;
    const member=pair.member.page;
    const memberId=pair.member.user.id;
    const ownerId=pair.owner.user.id;

    // The pair exchange messages, and the member has a schedule, a
    // completion and code runs (one solo, one pair); the owner has a pair run.
    const sent=await json(member,'/api/messages','POST',{room_id:pair.room,message:'My exportable message'});
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);
    const ownerSent=await json(owner,'/api/messages','POST',{room_id:pair.room,message:'Owner partner message'});
    expect(ownerSent.status,JSON.stringify(ownerSent.body)).toBe(201);
    const roomMatch=/^week_(\d+)_pair_(\d+)$/.exec(pair.room);
    expect(roomMatch).not.toBeNull();
    const weekId=Number(roomMatch![1]);
    const pairGroupId=Number(roomMatch![2]);
    await withDatabase(golden,async db=>{
      const group=(await db.execute({sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE id=?`,args:[pairGroupId]})).rows[0];
      await db.execute({sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time) VALUES (?,?,'[]','2098-09-20T10:00:00.000Z')`,args:[weekId,pairGroupId]});
      await db.execute({sql:`INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,'auth',?, ?,NULL,'2098-09-20T12:00:00.000Z')`,args:[weekId,pairGroupId,memberId,group.user_a_id,group.user_b_id]});
      await db.execute({sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,code) VALUES (? ,NULL,NULL,'two-sum','javascript','MY-SOLO-EXPORT-CODE')`,args:[memberId]});
      await db.execute({sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,code) VALUES (?,?,?,'two-sum','javascript','MY-PAIR-EXPORT-CODE')`,args:[memberId,weekId,pairGroupId]});
      await db.execute({sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,code) VALUES (?,?,?,'two-sum','javascript','OWNER-PAIR-EXPORT-CODE')`,args:[ownerId,weekId,pairGroupId]});
    });

    // The sign-in proof from signup is older than ten minutes now.
    await withDatabase(golden,db=>db.execute({
      sql:`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600 WHERE user_id=?`,args:[memberId],
    }));

    // Edit profile shows the section, which explains what is included and what is not.
    await openEditProfile(member);
    const section=member.getByTestId('data-export');
    await expect(section).toBeVisible();
    await expect(section).toContainText('What the download contains');
    await expect(section).toContainText('What it does not contain');
    await expect(section).toContainText('by display name only');
    await expectAccessible(member,'#dataExport','data export section');

    // A stale proof is refused with the re-auth hint, and nothing downloads.
    const refused=member.waitForResponse(pathIs('/api/auth/account/export','GET'));
    await member.getByTestId('data-export-download').click();
    expect((await refused).status()).toBe(403);
    await expect(member.getByTestId('data-export-status')).toContainText('Confirm it’s you first');

    // Confirm through Account security: password, then close the dialog.
    await member.locator('#meLabel').click();
    await member.getByRole('menuitem',{name:'Account security'}).click();
    const identity=member.getByRole('dialog',{name:'Account security'});
    await expect(identity).toBeVisible();
    await member.locator('#identityPasswordConfirm').fill(MEMBER_PASSWORD);
    const confirmed=member.waitForResponse(pathIs('/api/auth/recent-auth','POST'));
    await member.locator('#identityConfirmPassword').click();
    expect((await confirmed).status()).toBe(200);
    await expect(member.locator('#identityRecent')).toBeHidden();
    await member.locator('#identityClose').click();
    await expect(identity).toBeHidden();

    // Back in Edit profile, the download now succeeds as a file.
    await openEditProfile(member);
    await expect(member.getByTestId('data-export')).toBeVisible();
    const downloadPromise=member.waitForEvent('download');
    const downloaded=member.waitForResponse(pathIs('/api/auth/account/export','GET'));
    await member.getByTestId('data-export-download').click();
    expect((await downloaded).status()).toBe(200);
    const download=await downloadPromise;
    expect(download.suggestedFilename()).toBe('randori-circle-data-export.json');
    const archive=JSON.parse(await readFile(await download.path() as string,'utf8'));
    expect(archive.version).toBe(1);
    expect(archive.format).toBe('randori-circle-data-export');
    expect(archive.account).toEqual({id:memberId,email:'export.member@example.test',display_name:'Export Member'});
    expect(archive.profile.email).toBe('export.member@example.test');
    expect(archive.memberships.length).toBe(1);
    expect(typeof archive.memberships[0].circle_public_id).toBe('string');
    expect(archive.pairings.primary[0].partners).toEqual([LOCAL_OWNER_NAME]);
    expect(archive.schedules.primary[0].agreed_time).toBe('2098-09-20T10:00:00.000Z');
    expect(archive.session_completions.length).toBe(1);
    expect(archive.messages.map((row:any)=>row.message)).toEqual(['My exportable message']);
    expect(archive.code_runs.map((row:any)=>row.code).sort()).toEqual(['MY-PAIR-EXPORT-CODE','MY-SOLO-EXPORT-CODE']);
    const text=JSON.stringify(archive);
    expect(text).not.toContain(LOCAL_OWNER_EMAIL);
    expect(text).not.toContain('Owner partner message');
    expect(text).not.toContain('OWNER-PAIR-EXPORT-CODE');
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('google_sub');
    expect(text).not.toContain('session_hash');
    expect(text).not.toContain('token_hash');

    // The partner's own export holds only the partner's message and run.
    const ownerExport=await json(owner,'/api/auth/account/export');
    expect(ownerExport.status,JSON.stringify(ownerExport.body)).toBe(200);
    expect(ownerExport.body.account.email).toBe(LOCAL_OWNER_EMAIL);
    expect(ownerExport.body.messages.map((row:any)=>row.message)).toEqual(['Owner partner message']);
    expect(ownerExport.body.code_runs.map((row:any)=>row.code)).toEqual(['OWNER-PAIR-EXPORT-CODE']);
    expect(JSON.stringify(ownerExport.body)).not.toContain('My exportable message');
    expect(JSON.stringify(ownerExport.body)).not.toContain('MY-SOLO-EXPORT-CODE');

    // With the flag off: no endpoint, no capability, no section, no script.
    process.env[FLAG]='false';
    expect((await json(owner,'/api/auth/account/export')).status).toBe(404);
    const fresh=await newGoldenPage(browser,golden);
    const scriptRequests:string[]=[];
    fresh.page.on('request',request=>{ if(new URL(request.url()).pathname===SCRIPT) scriptRequests.push(request.url()); });
    await signInOwner(fresh.page,golden);
    const capabilities=await json(fresh.page,'/api/auth/capabilities');
    expect(capabilities.body.capabilities.dataExport).toBeUndefined();
    await openEditProfile(fresh.page);
    await expect(fresh.page.getByTestId('data-export')).toBeHidden();
    expect(scriptRequests).toEqual([]);
    expect(await fresh.page.evaluate(()=>document.getElementById('dataExport')?.childElementCount)).toBe(0);

    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    if(original===undefined) delete process.env[FLAG]; else process.env[FLAG]=original;
  }
});
