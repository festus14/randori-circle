import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  MEMBER_PASSWORD,
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  createPairedCircle,
  json,
  newGoldenPage,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Issue #339 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 21). The real
// loopback runtime runs with ACCOUNT_DELETION_ENABLED. A paired member deletes
// their account from Edit profile by keyboard (re-auth, type DELETE, final
// confirm), lands signed out on the landing page with a notice, cannot sign in
// again, and the partner's history shows "Deleted member". The only owner is
// blocked, the same email joins again as a new account, and with the flag off
// neither the endpoint nor the UI nor its script exists.

const FLAG='ACCOUNT_DELETION_ENABLED';
const SCRIPT='/assets/account-deletion.js';

async function openEditProfile(page:Page){
  await page.locator('#meLabel').click();
  const item=page.getByRole('menuitem',{name:'Edit profile',exact:true});
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#view-profile-setup')).toHaveAttribute('data-mode','edit');
}

async function expectAccessible(page:Page,selector:string,label:string){
  // Theme switches animate colours; check the settled state, not a transition frame.
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

test('account deletion: a member deletes their account by keyboard, partners keep an anonymised history, and the email can join again',async({browser})=>{
  test.setTimeout(240_000);
  const original=process.env[FLAG];
  process.env[FLAG]='true';
  const golden=await startGoldenRuntime('randori-golden-account-deletion-');
  try{
    const pair=await createPairedCircle(browser,golden,{memberEmail:'leaving.member@example.test',memberName:'Leaving Member'});
    const owner=pair.owner.page;
    const member=pair.member.page;
    const memberId=pair.member.user.id;

    // The member leaves a chat message the partner can see in the recap.
    const sent=await json(member,'/api/messages','POST',{room_id:pair.room,message:'My number is 07700 900123'});
    expect(sent.status,JSON.stringify(sent.body)).toBe(201);

    // Edit profile shows the section, which explains what is deleted and what stays.
    const eligibility=member.waitForResponse(pathIs('/api/auth/account/delete','GET'));
    await openEditProfile(member);
    expect((await eligibility).status()).toBe(200);
    const section=member.getByTestId('account-deletion');
    await expect(section).toBeVisible();
    await expect(section).toContainText('What is deleted');
    await expect(section).toContainText('What stays, anonymised');
    await expect(section).toContainText('shown as “Deleted member”');
    const open=member.getByTestId('account-deletion-open');
    await expect(open).toBeEnabled();
    await expectAccessible(member,'#accountDeletion','deletion section');

    // The sign-in proof from signup is older than ten minutes now.
    await withDatabase(golden,db=>db.execute({
      sql:`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600 WHERE user_id=?`,args:[memberId],
    }));

    // Keyboard only: open, confirm the password, type DELETE, confirm.
    await open.focus();
    const recentCheck=member.waitForResponse(pathIs('/api/auth/recent-auth','GET'));
    await member.keyboard.press('Enter');
    expect((await recentCheck).status()).toBe(200);
    const dialog=member.getByRole('dialog',{name:'Confirm it’s you'});
    await expect(dialog).toBeVisible();
    const password=dialog.getByLabel('Current password');
    await expect(password).toBeFocused();
    await expectAccessible(member,'#accountDeletionDialog','re-auth dialog');
    await password.focus();
    await member.keyboard.type('not the password');
    let confirmed=member.waitForResponse(pathIs('/api/auth/recent-auth','POST'));
    await member.keyboard.press('Enter');
    expect((await confirmed).status()).toBe(401);
    await expect(dialog).toContainText('That password isn’t right.');
    await password.focus();
    await member.keyboard.type(MEMBER_PASSWORD);
    confirmed=member.waitForResponse(pathIs('/api/auth/recent-auth','POST'));
    await member.keyboard.press('Enter');
    expect((await confirmed).status()).toBe(200);

    const typeDialog=member.getByRole('dialog',{name:'Type DELETE to confirm'});
    await expect(typeDialog).toBeVisible();
    const word=typeDialog.getByLabel('Type DELETE');
    await expect(word).toBeFocused();
    await member.keyboard.type('delete');
    await expect(typeDialog.getByRole('button',{name:'Continue'})).toBeDisabled();
    await word.fill('');
    await member.keyboard.type('DELETE');
    await expect(typeDialog.getByRole('button',{name:'Continue'})).toBeEnabled();
    await member.keyboard.press('Enter');

    const finalDialog=member.getByRole('dialog',{name:'Delete your account permanently?'});
    await expect(finalDialog).toBeVisible();
    await expect(finalDialog.getByRole('button',{name:'Cancel'})).toBeFocused();
    await expectAccessible(member,'#accountDeletionDialog','final confirmation');
    await member.keyboard.press('Tab');
    await expect(member.getByTestId('account-deletion-confirm')).toBeFocused();
    const deleted=member.waitForResponse(pathIs('/api/auth/account/delete','POST'));
    const reloaded=member.waitForEvent('domcontentloaded');
    await member.keyboard.press('Enter');
    // The page reloads as soon as the answer arrives, so its body is checked
    // through the database rather than read back from the browser.
    expect((await deleted).status()).toBe(200);
    await reloaded;
    const tombstone=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT email,display_name FROM auth_accounts WHERE id=?`,args:[memberId],
    })).rows.map(row=>({...row})));
    expect(tombstone).toEqual([{email:`deleted-${memberId}@account-deleted.invalid`,display_name:'Deleted member'}]);

    // Signed out on the landing page with a notice, and nothing about the
    // account left in this browser.
    await expect(member.locator('#view-landing')).toBeVisible();
    await expect(member.getByTestId('account-deleted-notice')).toHaveText(
      'Your account was deleted. Thank you for practising with Randori Circle.');
    await expect(member.locator('#authBtn')).toBeVisible();
    const stored=await member.evaluate(()=>[localStorage,sessionStorage].flatMap(store=>
      Object.keys(store).map(key=>`${key}=${store.getItem(key)}`)));
    expect(stored.filter(entry=>entry.startsWith('randori-me=')||entry.startsWith('randori-crdt-pending-v1=')
      ||entry.startsWith('randori-account-deleted-v1=')||entry.includes(pair.member.email)
      ||entry.includes('Leaving Member'))).toEqual([]);
    expect((await json(member,'/api/auth/me')).status).toBe(401);
    const relogin=await json(member,'/api/auth/login','POST',{email:pair.member.email,password:MEMBER_PASSWORD});
    expect(relogin).toEqual({status:401,body:{error:'invalid credentials'}});

    // The partner's current pairing, history and recap stay readable as
    // "Deleted member".
    const ownerPair=await json(owner,'/api/my-pair');
    expect(ownerPair.status,JSON.stringify(ownerPair.body)).toBe(200);
    expect(JSON.stringify(ownerPair.body)).toContain('Deleted member');
    expect(JSON.stringify(ownerPair.body)).not.toContain('Leaving Member');
    const history=await json(owner,'/api/history');
    expect(history.status,JSON.stringify(history.body)).toBe(200);
    expect(history.body.history[0].partner_names).toEqual(['Deleted member']);
    const recap=await json(owner,`/api/pair-recap?room_id=${pair.room}`);
    expect(recap.status,JSON.stringify(recap.body)).toBe(200);
    expect(recap.body.recap.pair.members.map((person:any)=>person.display_name)).toContain('Deleted member');
    const messages=recap.body.recap.activity.filter((item:any)=>item.kind==='message');
    expect(messages).toEqual([expect.objectContaining({actor:{id:memberId,display_name:'Deleted member'},message:'Message deleted'})]);
    await owner.locator('[data-tab="pair"]').click();
    await owner.locator('[data-tab="history"]').click();
    await expect(owner.locator(`[data-testid="pair-history-row"][data-room-id="${pair.room}"]`)).toContainText('Deleted member');
    const audit=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT event_type,actor_user_id,subject_user_id,invitation_id FROM circle_audit_events WHERE event_type='account.deleted'`,
    })).rows.map(row=>({...row})));
    expect(audit).toEqual([{event_type:'account.deleted',actor_user_id:memberId,subject_user_id:memberId,invitation_id:null}]);
    const roster=await json(owner,'/api/members');
    expect(roster.status,JSON.stringify(roster.body)).toBe(200);
    expect(JSON.stringify(roster.body)).not.toContain('Leaving Member');
    expect(roster.body.members.some((person:any)=>person.id===memberId)).toBe(false);

    // The only owner of the circle is blocked with guidance.
    const ownerEligibility=owner.waitForResponse(pathIs('/api/auth/account/delete','GET'));
    await openEditProfile(owner);
    expect((await ownerEligibility).status()).toBe(200);
    await expect(owner.getByTestId('account-deletion-blocked')).toContainText('You’re the only owner of');
    await expect(owner.getByTestId('account-deletion-open')).toBeDisabled();
    const ownerRefused=await json(owner,'/api/auth/account/delete','POST',{confirm:'DELETE'});
    expect(ownerRefused.status).toBe(409);
    expect(ownerRefused.body.code).toBe('last_owner');

    // The same email joins again as a brand-new account.
    await owner.locator('[data-tab="circle"]').click();
    const {inviteUrl}=await createInvitationThroughUi(owner,golden,pair.member.email);
    const returning=await newGoldenPage(browser,golden);
    const again=await acceptInvitationThroughUi(returning.page,golden,inviteUrl,{email:pair.member.email,name:'Returning Member'});
    expect(again.id).not.toBe(memberId);
    expect((await json(owner,'/api/history')).body.history[0].partner_names).toEqual(['Deleted member']);

    // With the flag off: no endpoint, no capability, no section, no script.
    process.env[FLAG]='false';
    expect((await json(owner,'/api/auth/account/delete')).status).toBe(404);
    const fresh=await newGoldenPage(browser,golden);
    const scriptRequests:string[]=[];
    fresh.page.on('request',request=>{ if(new URL(request.url()).pathname===SCRIPT) scriptRequests.push(request.url()); });
    await signInOwner(fresh.page,golden);
    const capabilities=await json(fresh.page,'/api/auth/capabilities');
    expect(capabilities.body.capabilities.accountDeletion).toBeUndefined();
    await openEditProfile(fresh.page);
    await expect(fresh.page.getByTestId('account-deletion')).toBeHidden();
    expect(scriptRequests).toEqual([]);
    expect(await fresh.page.evaluate(()=>document.getElementById('accountDeletion')?.childElementCount)).toBe(0);

    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    if(original===undefined) delete process.env[FLAG]; else process.env[FLAG]=original;
  }
});
