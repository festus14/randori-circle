import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  MEMBER_PASSWORD,
  type GoldenRuntime,
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  createPairedCircle,
  json,
  newGoldenPage,
  pathIs,
  signInThroughForm,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';
import {waitForThemeSettled} from './golden-theme-settle';

// Issue #372 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 26). The real
// loopback runtime runs with ACCOUNT_DELETION_ENABLED +
// ACCOUNT_DELETION_GRACE_ENABLED. A paired member requests deletion by
// keyboard, gets a scheduled-deletion notice and a confirmation email,
// signs in again to find only the cancel screen, cancels (restored),
// requests again (a new 14 days), and is deleted on schedule by the
// production `/api/cron/outbox` route. A second member who is the only
// owner of a secondary circle stays locked and notifies admins until a
// co-owner exists.

const DELETION_FLAG='ACCOUNT_DELETION_ENABLED';
const GRACE_FLAG='ACCOUNT_DELETION_GRACE_ENABLED';
const CRON_SECRET='golden-deletion-grace-cron-secret';
const ENV_KEYS=[DELETION_FLAG,GRACE_FLAG,'CRON_SECRET'] as const;
type Captured={recipient_email:string;kind:string;subject:string;links:string[]};
type CronBody={account_deletion_confirmation_delivery?:{captured?:Captured[]};
  account_deletion_reminder_delivery?:{captured?:Captured[]};
  account_deletion_blocked_delivery?:{captured?:Captured[]};
  outbox?:{account_deletion_grace?:{ran?:boolean;executed?:number;blocked?:number;
    blocked_notifications?:number;reminders_queued?:number;errors?:unknown[]}}};

async function drainOutbox(page:Page){
  const response=await page.evaluate(async secret=>{
    const result=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});
    return {status:result.status,body:await result.json()};
  },CRON_SECRET);
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  return response.body as CronBody;
}

async function openEditProfile(page:Page){
  await page.locator('#meLabel').click();
  const item=page.getByRole('menuitem',{name:'Edit profile',exact:true});
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#view-profile-setup')).toHaveAttribute('data-mode','edit');
}

async function ageRecentProofs(golden:GoldenRuntime,userId:number){
  await withDatabase(golden,db=>db.execute({
    sql:`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600 WHERE user_id=?`,args:[userId],
  }));
}

async function requestDeletionByKeyboard(page:Page,userId:number){
  await openEditProfile(page);
  const section=page.getByTestId('account-deletion');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('account-deletion-grace-note')).toBeVisible();
  const open=page.getByTestId('account-deletion-open');
  await expect(open).toBeEnabled();
  const recentCheck=page.waitForResponse(pathIs('/api/auth/recent-auth','GET'));
  await open.focus();
  await page.keyboard.press('Enter');
  expect((await recentCheck).status()).toBe(200);
  const dialog=page.getByRole('dialog',{name:'Confirm it’s you'});
  await expect(dialog).toBeVisible();
  const password=dialog.getByLabel('Current password');
  await expect(password).toBeFocused();
  await password.focus();
  await page.keyboard.type(MEMBER_PASSWORD);
  const confirmed=page.waitForResponse(pathIs('/api/auth/recent-auth','POST'));
  await page.keyboard.press('Enter');
  expect((await confirmed).status()).toBe(200);
  const typeDialog=page.getByRole('dialog',{name:'Type DELETE to confirm'});
  await expect(typeDialog).toBeVisible();
  const word=typeDialog.getByLabel('Type DELETE');
  await expect(word).toBeFocused();
  await page.keyboard.type('DELETE');
  await expect(typeDialog.getByRole('button',{name:'Continue'})).toBeEnabled();
  await page.keyboard.press('Enter');
  const finalDialog=page.getByRole('dialog',{name:'Delete your account permanently?'});
  await expect(finalDialog).toBeVisible();
  await expect(finalDialog).toContainText('locked straight away and deleted in 14 days');
  await expect(finalDialog.getByRole('button',{name:'Cancel'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('account-deletion-confirm')).toBeFocused();
  const requested=page.waitForResponse(pathIs('/api/auth/account/delete','POST'));
  const reloaded=page.waitForEvent('domcontentloaded');
  await page.keyboard.press('Enter');
  const response=await requested;
  expect(response.status()).toBe(200);
  const body=await response.json();
  expect(body.status).toBe('pending_deletion');
  expect(typeof body.scheduled_for).toBe('string');
  await reloaded;
  return body.scheduled_for as string;
}

function formatDate(iso:string){
  return new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'})
    .format(new Date(iso));
}

test('account deletion grace: a member schedules deletion, cancels from the pending screen, re-requests, and is deleted on schedule by the cron',async({browser})=>{
  test.setTimeout(300_000);
  const original=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  process.env[DELETION_FLAG]='true';
  process.env[GRACE_FLAG]='true';
  const golden=await startGoldenRuntime('randori-golden-account-deletion-grace-');
  try{
    // The local runtime clears CRON_SECRET at start; the cron route needs one.
    process.env.CRON_SECRET=CRON_SECRET;
    const pair=await createPairedCircle(browser,golden,{memberEmail:'leaving.member@example.test',memberName:'Leaving Member'});
    const owner=pair.owner.page;
    const member=pair.member.page;
    const memberId=pair.member.user.id;

    // Request deletion by keyboard (the sign-in proof is aged first).
    await ageRecentProofs(golden,memberId);
    const firstScheduled=await requestDeletionByKeyboard(member,memberId);
    await expect(member.locator('#view-landing')).toBeVisible();
    await expect(member.getByTestId('account-deleted-notice')).toHaveText(
      `Your account is scheduled for deletion on ${formatDate(firstScheduled)}. We emailed you how to cancel — sign in again before then to cancel.`);
    const pending=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT requested_at,scheduled_for,cancelled_at,executed_at FROM account_deletion_requests WHERE user_id=?`,
      args:[memberId],
    })).rows.map(row=>({...row})));
    expect(pending.length).toBe(1);
    expect(pending[0].cancelled_at).toBeNull();
    expect(pending[0].executed_at).toBeNull();
    expect(new Date(Number(pending[0].scheduled_for)*1000).toISOString()).toBe(firstScheduled);

    // The confirmation email is captured through the production cron route, once.
    const confirmed=await drainOutbox(owner);
    const confirmations=confirmed.account_deletion_confirmation_delivery?.captured||[];
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].recipient_email).toBe(pair.member.email);
    expect(confirmations[0].kind).toBe('account-deletion-confirmation');
    expect(confirmations[0].subject).toBe('Your Randori Circle account is scheduled for deletion');
    expect((await drainOutbox(owner)).account_deletion_confirmation_delivery?.captured||[]).toEqual([]);

    // The owner roster shows the member as Leaving.
    const roster=await json(owner,'/api/members');
    expect(roster.status,JSON.stringify(roster.body)).toBe(200);
    const rosterEntry=roster.body.members.find((person:any)=>person.id===memberId);
    expect(rosterEntry?.deletion_pending).toBe(true);

    // Signing in again shows only the cancel screen — and nothing else works.
    const login=await signInThroughForm(member,pair.member.email,MEMBER_PASSWORD);
    expect(login.status()).toBe(200);
    await expect(member.getByTestId('deletion-pending-cancel')).toBeVisible();
    await expect(member.locator('#deletionPendingText')).toContainText(
      `scheduled for deletion on ${formatDate(firstScheduled)}`);
    // The overlay covers the app: the dashboard DOM stays behind it, so
    // the assertion is that the pending screen itself is up, not that the
    // dashboard nodes are gone.
    await expect(member.locator('#deletionPendingOverlay.show')).toBeVisible();
    expect((await json(member,'/api/auth/me')).status).toBe(409);
    expect((await json(member,'/api/auth/me')).body.code).toBe('deletion_pending');
    expect((await json(member,'/api/history')).status).toBe(401);

    // The cancel screen is accessible in both themes.
    for(const light of [false,true]){
      const isLight=await member.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await member.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await waitForThemeSettled(member,'#deletionPendingOverlay',light);
      const results=await new AxeBuilder({page:member}).include('#deletionPendingOverlay')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`cancel screen ${light?'light':'dark'}`).toEqual([]);
    }

    // Cancel: the account is restored, still paired, still a member.
    const cancelled=member.waitForResponse(pathIs('/api/auth/account/delete/cancel','POST'));
    await member.getByTestId('deletion-pending-cancel').click();
    expect((await cancelled).status()).toBe(200);
    await expect(member.locator('#dashPairArea')).toContainText('Local Circle Owner');
    expect((await json(member,'/api/auth/me')).status).toBe(200);
    const cancelledRow=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT cancelled_at,executed_at FROM account_deletion_requests WHERE user_id=?`,args:[memberId],
    })).rows.map(row=>({...row})));
    expect(cancelledRow[0].cancelled_at).not.toBeNull();
    const cancelledAudit=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT event_type FROM circle_audit_events WHERE event_type='account.deletion_cancelled' AND subject_user_id=?`,
      args:[memberId],
    })).rows.map(row=>({...row})));
    expect(cancelledAudit).toHaveLength(1);
    const rosterAfter=await json(owner,'/api/members');
    expect(rosterAfter.body.members.find((person:any)=>person.id===memberId)?.deletion_pending).toBeUndefined();

    // Requesting again starts a new 14 days.
    await ageRecentProofs(golden,memberId);
    const secondScheduled=await requestDeletionByKeyboard(member,memberId);
    expect(secondScheduled).not.toBe(firstScheduled);
    const rows=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT cancelled_at,executed_at FROM account_deletion_requests WHERE user_id=? ORDER BY id`,
      args:[memberId],
    })).rows.map(row=>({...row})));
    expect(rows).toHaveLength(2);
    expect(rows[0].cancelled_at).not.toBeNull();
    expect(rows[1].cancelled_at).toBeNull();

    // Age the second request past its scheduled date (requested 15 days ago,
    // due an hour ago, keeping scheduled_for > requested_at); the cron executes it.
    await withDatabase(golden,db=>db.execute({
      sql:`UPDATE account_deletion_requests
        SET requested_at=strftime('%s','now')-15*24*3600, scheduled_for=strftime('%s','now')-3600
        WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL`,args:[memberId],
    }));
    const executed=await drainOutbox(owner);
    expect(executed.outbox?.account_deletion_grace?.executed).toBe(1);
    expect(executed.outbox?.account_deletion_grace?.errors).toEqual([]);
    const tombstone=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT email,display_name FROM auth_accounts WHERE id=?`,args:[memberId],
    })).rows.map(row=>({...row})));
    expect(tombstone).toEqual([{email:`deleted-${memberId}@account-deleted.invalid`,display_name:'Deleted member'}]);
    const history=await json(owner,'/api/history');
    expect(history.status,JSON.stringify(history.body)).toBe(200);
    expect(history.body.history[0].partner_names).toEqual(['Deleted member']);
    expect((await json(member,'/api/auth/me')).status).toBe(401);
    const relogin=await json(member,'/api/auth/login','POST',{email:pair.member.email,password:MEMBER_PASSWORD});
    expect(relogin).toEqual({status:401,body:{error:'invalid credentials'}});

    // A last-owner execution stays locked and notifies admins until a co-owner exists.
    const {inviteUrl}=await createInvitationThroughUi(owner,golden,'blocked.member@example.test');
    const blockedPage=(await newGoldenPage(browser,golden)).page;
    const blocked=await acceptInvitationThroughUi(blockedPage,golden,inviteUrl,{email:'blocked.member@example.test',name:'Blocked Member'});
    const blockedId=blocked.id;
    await withDatabase(golden,async db=>{
      await db.execute({sql:`INSERT INTO circles (public_id,slug,name,is_primary,created_by,archived_at)
        VALUES ('circle-blocked','blocked','Blocked Club',0,?,NULL)`,args:[blockedId]});
      const circle=await db.execute({sql:`SELECT id FROM circles WHERE public_id='circle-blocked'`,args:[]});
      const circleId=Number(circle.rows[0].id);
      await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
        VALUES (?,?, 'owner','active',NULL)`,args:[circleId,blockedId]});
    });
    const blockedRequest=await json(blockedPage,'/api/auth/account/delete','POST',{confirm:'DELETE'});
    expect(blockedRequest.status,JSON.stringify(blockedRequest.body)).toBe(200);
    expect(blockedRequest.body.status).toBe('pending_deletion');
    await withDatabase(golden,db=>db.execute({
      sql:`UPDATE account_deletion_requests
        SET requested_at=strftime('%s','now')-15*24*3600, scheduled_for=strftime('%s','now')-3600
        WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL`,args:[blockedId],
    }));
    const blockedRun=await drainOutbox(owner);
    expect(blockedRun.outbox?.account_deletion_grace?.blocked).toBe(1);
    expect(blockedRun.outbox?.account_deletion_grace?.blocked_notifications).toBe(1);
    const blockedMails=blockedRun.account_deletion_blocked_delivery?.captured||[];
    expect(blockedMails).toHaveLength(1);
    expect(blockedMails[0].subject).toBe('A Randori Circle account deletion is blocked');
    const stillLocked=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT password_hash FROM auth_accounts WHERE id=?`,args:[blockedId],
    })).rows.map(row=>({...row})));
    expect(stillLocked[0].password_hash).not.toBe('!account-deleted');
    // A second blocked run does not re-notify.
    expect((await drainOutbox(owner)).outbox?.account_deletion_grace?.blocked_notifications).toBe(0);
    // Once the owner co-owns the circle, the deletion runs.
    await withDatabase(golden,async db=>{
      const circle=await db.execute({sql:`SELECT id FROM circles WHERE public_id='circle-blocked'`,args:[]});
      const circleId=Number(circle.rows[0].id);
      const ownerRow=await db.execute({sql:`SELECT id FROM auth_accounts WHERE email='owner@randori.test'`,args:[]});
      await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
        VALUES (?,?, 'owner','active',?)`,args:[circleId,Number(ownerRow.rows[0].id),blockedId]});
    });
    const unblocked=await drainOutbox(owner);
    expect(unblocked.outbox?.account_deletion_grace?.executed).toBe(1);
    const blockedTombstone=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT email FROM auth_accounts WHERE id=?`,args:[blockedId],
    })).rows.map(row=>({...row})));
    expect(blockedTombstone).toEqual([{email:`deleted-${blockedId}@account-deleted.invalid`}]);

    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    for(const key of ENV_KEYS){
      if(original[key]===undefined) delete process.env[key]; else process.env[key]=original[key];
    }
  }
});
