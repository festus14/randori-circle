import {type APIResponse,expect,test} from '@playwright/test';
import {
  acceptInvitationThroughUi,createInvitationThroughUi,json,newGoldenPage,
  signInMemberSession,signInOwner,signOutThroughMenu,startGoldenRuntime,withDatabase,
} from './golden-runtime';

test('a delayed list in another tab preserves a concurrently sent address after reload',async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-invitation-address-race-');
  const email='concurrent.recipient@example.test';
  let releaseStaleResponse:()=>void=()=>{};
  const release=new Promise<void>(resolve=>{releaseStaleResponse=resolve;});
  let recordStaleResponse:(body:any)=>void=()=>{};
  const staleResponse=new Promise<any>(resolve=>{recordStaleResponse=resolve;});
  const observations:Record<string,unknown>={};
  try{
    const sender=await newGoldenPage(browser,golden);
    await signInOwner(sender.page,golden);
    await sender.page.locator('[data-tab="circle"]').click();
    await expect(sender.page.getByTestId('circle-invites')).toContainText('No invitations yet.');

    // Both tabs share the sender's real session and localStorage. Fetch the
    // real list before the send, then hold every GET at Tab B's boundary.
    // Boot and tab selection can both load it; reuse the same stale response
    // so neither request can settle before release or observe the later send.
    const tabB=await sender.context.newPage();
    let delayedResponse:Promise<APIResponse>|undefined;
    await tabB.route('**/api/invitations',async route=>{
      if(route.request().method()!=='GET') return route.continue();
      if(!delayedResponse) delayedResponse=route.fetch();
      const response=await delayedResponse;
      expect(response.status()).toBe(200);
      recordStaleResponse(await response.json());
      await release;
      await route.fulfill({response});
    });
    await tabB.goto(golden.url,{waitUntil:'domcontentloaded'});
    await tabB.locator('[data-tab="circle"]').click();
    const staleList=await staleResponse;
    expect(staleList.invitations).toEqual([]);
    await expect(tabB.locator('#circleInvitesMeta')).toHaveText('Loading…');

    const pending=await createInvitationThroughUi(sender.page,golden,email);
    const row=sender.page.locator(`[data-invitation-id="${pending.invitationId}"]`);
    await expect(row.locator('b')).toHaveText(email);
    observations.senderBeforeRelease=await row.innerText();
    observations.staleList=staleList;
    expect(staleList.invitations.some((invite:any)=>invite.id===pending.invitationId)).toBe(false);
    releaseStaleResponse();
    // Wait for B to apply the stale list, including its cache cleanup.
    await expect(tabB.getByTestId('circle-invites')).toContainText('No invitations yet.');
    await expect(tabB.locator('#circleInvitesMeta')).not.toHaveText('Loading…');

    await sender.page.reload({waitUntil:'domcontentloaded'});
    await sender.page.locator('[data-tab="circle"]').click();
    await expect(row.locator('b')).toHaveText(email);
    await expect(row).toContainText('Pending');
    observations.senderAfterReload=await row.innerText();
    const currentList=await json(sender.page,'/api/invitations');
    expect(currentList.status).toBe(200);
    expect(currentList.body.invitations.some((invite:any)=>invite.id===pending.invitationId&&invite.status==='pending')).toBe(true);
    expect(JSON.stringify(currentList.body)).not.toContain(email);
    observations.currentList=currentList;
    await test.info().attach('two-tab-sender-after-reload.png',{body:await sender.page.getByTestId('circle-invites').screenshot(),contentType:'image/png'});
    expect(golden.external).toEqual([]);
  }finally{
    releaseStaleResponse();
    await test.info().attach('two-tab-race-evidence.json',{body:JSON.stringify(observations,null,2),contentType:'application/json'});
    console.log('Two-tab invitation race evidence:',JSON.stringify(observations));
    await golden.close();
  }
});

test('only the sending browser can identify a pending invitation after reload',async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-invitation-addresses-');
  const email='private.recipient@example.test';
  const observations:Record<string,unknown>={};
  try{
    const sender=await newGoldenPage(browser,golden);
    const other=await newGoldenPage(browser,golden);
    const senderUser=await signInOwner(sender.page,golden);
    const memberInvite=await createInvitationThroughUi(sender.page,golden,'another.member@example.test');
    const member=await acceptInvitationThroughUi(other.page,golden,memberInvite.inviteUrl,{
      email:'another.member@example.test',name:'Another Member',
    });
    expect((await json(other.page,'/api/invitations/prepare','POST',{token:memberInvite.inviteUrl.hash.slice('#invite='.length)})).status).toBe(400);
    const pending=await createInvitationThroughUi(sender.page,golden,email);
    const row=sender.page.locator(`[data-invitation-id="${pending.invitationId}"]`);
    await expect(row.locator('b')).toHaveText(email);
    observations.senderImmediately=await row.innerText();
    await test.info().attach('sender-immediately.png',{body:await sender.page.getByTestId('circle-invites').screenshot(),contentType:'image/png'});
    const senderList=await json(sender.page,'/api/invitations');
    expect(senderList.status).toBe(200);
    expect(JSON.stringify(senderList.body)).not.toContain(email);
    observations.senderApi=senderList;

    await sender.page.reload({waitUntil:'domcontentloaded'});
    await sender.page.locator('[data-tab="circle"]').click();
    await expect(row).toBeVisible();
    await expect(row.locator('b')).toHaveText(email);
    await expect(row).toContainText('expires in 7 days');
    await expect(row.getByTestId('circle-invite-resend')).toBeVisible();
    await expect(row.getByTestId('circle-invite-revoke')).toBeVisible();
    observations.senderAfterReload=await row.innerText();
    const sameBrowserTab=await sender.context.newPage();
    await sameBrowserTab.goto(golden.url,{waitUntil:'domcontentloaded'});
    await sameBrowserTab.locator('[data-tab="circle"]').click();
    await expect(sameBrowserTab.locator(`[data-invitation-id="${pending.invitationId}"] b`)).toHaveText(email);
    await sameBrowserTab.close();
    await test.info().attach('sender-after-reload.png',{body:await sender.page.getByTestId('circle-invites').screenshot(),contentType:'image/png'});

    await other.page.locator('[data-tab="circle"]').click();
    await expect(other.page.locator('#circleOwnerPanel')).toBeHidden();
    const memberList=await json(other.page,'/api/invitations');
    expect(memberList).toEqual({status:403,body:{error:'circle owner required'}});
    observations.ordinaryMember={panel:'hidden',api:memberList};
    await expect(other.page.locator('body')).not.toContainText(email);

    // A co-owner is allowed to list the same cards, but did not send this one.
    await withDatabase(golden,db=>db.execute({sql:`UPDATE circle_memberships SET role='owner' WHERE user_id=?`,args:[member.id]}));
    await other.page.reload({waitUntil:'domcontentloaded'});
    await other.page.locator('[data-tab="circle"]').click();
    const otherRow=other.page.locator(`[data-invitation-id="${pending.invitationId}"]`);
    await expect(otherRow.locator('b')).toHaveText('Private invitation');
    await expect(other.page.locator('body')).not.toContainText(email);
    const otherList=await json(other.page,'/api/invitations');
    expect(otherList.status).toBe(200);
    expect(JSON.stringify(otherList.body)).not.toContain(email);
    observations.otherOwner={card:await otherRow.innerText(),api:otherList};
    await test.info().attach('other-owner.png',{body:await other.page.getByTestId('circle-invites').screenshot(),contentType:'image/png'});

    // Even the sender account in a fresh browser has no local address.
    const fresh=await newGoldenPage(browser,golden);
    expect((await signInOwner(fresh.page,golden)).id).toBe(senderUser.id);
    await fresh.page.locator('[data-tab="circle"]').click();
    const freshRow=fresh.page.locator(`[data-invitation-id="${pending.invitationId}"]`);
    await expect(freshRow.locator('b')).toHaveText('Private invitation');
    await expect(fresh.page.locator('body')).not.toContainText(email);
    observations.senderFreshBrowser=await freshRow.innerText();

    // The unregistered invitee cannot access the management list either.
    const anonymous=await newGoldenPage(browser,golden);
    await anonymous.page.goto(golden.url,{waitUntil:'domcontentloaded'});
    const anonymousList=await json(anonymous.page,'/api/invitations');
    expect(anonymousList).toEqual({status:401,body:{error:'authentication required'}});
    observations.inviteeWithoutSession=anonymousList;

    // Resend rotates the bearer without changing its original expiry; revoke
    // then invalidates it. No raw bearer is written into browser storage.
    await withDatabase(golden,db=>db.execute({sql:`UPDATE outbox_events
      SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 seconds')
      WHERE event_type='invitation.email.requested' AND json_extract(payload_json,'$.invitation_id')=?`,args:[pending.invitationId]}));
    const oldToken=pending.inviteUrl.hash.slice('#invite='.length);
    const resent=await json(sender.page,`/api/invitations/${pending.invitationId}`,'POST',{action:'resend'});
    expect(resent.status).toBe(200);
    const newToken=new URL(resent.body.invitation.invite_url,golden.url).hash.slice('#invite='.length);
    expect(newToken).not.toBe(oldToken);
    const refreshed=await json(sender.page,'/api/invitations');
    expect(refreshed.body.invitations.find((invite:any)=>invite.id===pending.invitationId).expires_at)
      .toBe(senderList.body.invitations.find((invite:any)=>invite.id===pending.invitationId).expires_at);
    expect((await json(sender.page,'/api/invitations/prepare','POST',{token:oldToken})).status).toBe(400);
    expect((await json(sender.page,'/api/invitations/prepare','POST',{token:newToken})).status).toBe(200);
    expect((await sender.page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})))).not.toContain(newToken);

    // A second account in the sending browser must not inherit its labels.
    await signOutThroughMenu(sender.page);
    await signInMemberSession(sender.page,golden,member.email);
    await sender.page.locator('[data-tab="circle"]').click();
    await expect(row.locator('b')).toHaveText('Private invitation');
    await expect(sender.page.locator('body')).not.toContainText(email);
    observations.otherAccountInSendingBrowser=await row.innerText();
    // Returning to the sender account in the same browser restores its label.
    await signOutThroughMenu(sender.page);
    await signInOwner(sender.page,golden);
    await sender.page.locator('[data-tab="circle"]').click();
    await expect(row.locator('b')).toHaveText(email);
    expect((await json(sender.page,`/api/invitations/${pending.invitationId}`,'DELETE')).status).toBe(200);
    expect((await json(sender.page,'/api/invitations/prepare','POST',{token:newToken})).status).toBe(400);
    expect(golden.external).toEqual([]);
  }finally{
    await test.info().attach('viewer-evidence.json',{body:JSON.stringify(observations,null,2),contentType:'application/json'});
    console.log('Invitation viewer evidence:',JSON.stringify(observations));
    await golden.close();
  }
});
