import {expect,test,type Page} from '@playwright/test';

import {
  LOCAL_OWNER_PASSWORD,
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  json,
  newGoldenPage,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Golden path 13 (docs/testing/E2E_GOLDEN_PATHS.md): co-owners and app admin
// grants against the real loopback runtime. No API route is mocked.

async function openMembers(page:Page){
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-lifecycle')).toBeVisible();
}

function memberRow(page:Page,id:number){
  return page.getByTestId('circle-lifecycle').locator(`[data-testid="circle-member-row"][data-member-id="${id}"]`);
}

/** Opens a member's Roles menu, picks an action, and accepts the confirm dialog. */
async function chooseRoleAction(page:Page,id:number,testid:string,title:RegExp){
  const row=memberRow(page,id);
  await row.getByTestId('circle-member-menu').locator('summary').click();
  await row.getByTestId(testid).click();
  await expect(page.locator('#confirmTitle')).toHaveText(title);
  await page.locator('#confirmOk').click();
}

async function roleChange(page:Page,id:number,testid:string,title:RegExp){
  const changed=page.waitForResponse(pathIs('/api/members','PATCH'));
  await chooseRoleAction(page,id,testid,title);
  const response=await changed;
  expect(response.status(),JSON.stringify(await response.json().catch(()=>null))).toBe(200);
}

test('an owner makes invited members co-owners and admins, they get owner and admin tools, and demotion removes them',async({browser})=>{
  test.setTimeout(180_000);
  const golden=await startGoldenRuntime('randori-golden-co-owner-');
  try{
    const owner=await newGoldenPage(browser,golden);
    const bobPage=await newGoldenPage(browser,golden);
    const caraPage=await newGoldenPage(browser,golden);
    const ownerUser=await signInOwner(owner.page,golden);

    // Two members join through normal invitations.
    const bobInvite=await createInvitationThroughUi(owner.page,golden,'bob.coowner@example.test');
    const bob=await acceptInvitationThroughUi(bobPage.page,golden,bobInvite.inviteUrl,{email:'bob.coowner@example.test',name:'Bob Coowner'});
    const caraInvite=await createInvitationThroughUi(owner.page,golden,'cara.coowner@example.test');
    const cara=await acceptInvitationThroughUi(caraPage.page,golden,caraInvite.inviteUrl,{email:'cara.coowner@example.test',name:'Cara Coowner'});
    expect(bob.is_admin).toBe(false);
    const bobSessionsBefore=await withDatabase(golden,async db=>Number((await db.execute({
      sql:`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL`,args:[bob.id],
    })).rows[0].count));

    // Members see no owner tools yet.
    await openMembers(bobPage.page);
    await expect(bobPage.page.getByTestId('circle-invite-email')).toBeHidden();
    await expect(bobPage.page.getByTestId('circle-member-row')).toHaveCount(0);

    await owner.page.reload({waitUntil:'domcontentloaded'});
    await openMembers(owner.page);
    await expect(memberRow(owner.page,bob.id)).toHaveAttribute('data-member-role','member');
    await expect(memberRow(owner.page,ownerUser.id).getByTestId('circle-member-admin-badge')).toBeVisible();
    await expect(memberRow(owner.page,ownerUser.id).getByTestId('circle-member-menu')).toHaveCount(0);
    // Existing lifecycle controls are unchanged.
    await expect(memberRow(owner.page,bob.id).getByTestId('circle-member-transfer')).toBeVisible();
    await expect(memberRow(owner.page,bob.id).getByTestId('circle-member-deactivate')).toBeVisible();

    // The first sensitive change asks the owner to confirm it's them once the
    // sign-in proof is older than ten minutes, then resumes the exact action.
    await withDatabase(golden,db=>db.execute({
      sql:`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600 WHERE user_id=?`,args:[ownerUser.id],
    }));
    const challenged=owner.page.waitForResponse(response=>pathIs('/api/members','PATCH')(response)&&response.status()===403);
    await chooseRoleAction(owner.page,bob.id,'circle-member-make-owner',/Make Bob Coowner an owner\?/);
    expect(await (await challenged).json()).toEqual({error:'recent authentication required',code:'recent_auth_required'});
    await expect(owner.page.locator('#identityPasswordConfirm')).toBeVisible();
    await owner.page.locator('#identityPasswordConfirm').fill(LOCAL_OWNER_PASSWORD);
    const resumed=owner.page.waitForResponse(response=>pathIs('/api/members','PATCH')(response)&&response.status()===200);
    await owner.page.locator('#identityConfirmPassword').click();
    expect(await (await resumed).json()).toMatchObject({ok:true,action:'make_owner',member:{id:bob.id,role:'owner'}});
    await expect(memberRow(owner.page,bob.id)).toHaveAttribute('data-member-role','owner');

    await roleChange(owner.page,bob.id,'circle-member-grant-admin',/Make Bob Coowner an app admin\?/);
    await expect(memberRow(owner.page,bob.id).getByTestId('circle-member-admin-badge')).toBeVisible();
    await roleChange(owner.page,cara.id,'circle-member-make-owner',/Make Cara Coowner an owner\?/);
    await roleChange(owner.page,cara.id,'circle-member-grant-admin',/Make Cara Coowner an app admin\?/);
    await expect(memberRow(owner.page,cara.id)).toHaveAttribute('data-member-role','owner');
    await expect(memberRow(owner.page,ownerUser.id)).toHaveAttribute('data-member-role','owner');

    // Bob now has owner tools (invitations, member management, publishing)
    // and admin diagnostics, without signing in again.
    await bobPage.page.reload({waitUntil:'domcontentloaded'});
    await expect.poll(async()=>(await json(bobPage.page,'/api/auth/me')).body?.user?.is_admin).toBe(true);
    await openMembers(bobPage.page);
    await expect(bobPage.page.getByTestId('circle-invite-email')).toBeVisible();
    await expect(memberRow(bobPage.page,ownerUser.id)).toHaveAttribute('data-member-role','owner');
    await expect(memberRow(bobPage.page,cara.id).getByTestId('circle-member-admin-badge')).toBeVisible();
    await bobPage.page.locator('[data-tab="pair"]').click();
    await expect(bobPage.page.locator('#newWeekBtn')).toBeVisible();
    await expect(bobPage.page.locator('#pairDiagnostics')).toBeVisible();

    // A co-owner can demote another co-owner (Bob's sign-up proof is fresh).
    await openMembers(bobPage.page);
    await roleChange(bobPage.page,cara.id,'circle-member-revoke-admin',/Remove admin access from Cara Coowner\?/);
    await roleChange(bobPage.page,cara.id,'circle-member-remove-owner',/Remove Cara Coowner as an owner\?/);
    await expect(memberRow(bobPage.page,cara.id)).toHaveAttribute('data-member-role','member');

    // The original owner removes Bob's admin access and owner role.
    await owner.page.reload({waitUntil:'domcontentloaded'});
    await openMembers(owner.page);
    await roleChange(owner.page,bob.id,'circle-member-revoke-admin',/Remove admin access from Bob Coowner\?/);
    await expect(memberRow(owner.page,bob.id).getByTestId('circle-member-admin-badge')).toHaveCount(0);
    await roleChange(owner.page,bob.id,'circle-member-remove-owner',/Remove Bob Coowner as an owner\?/);
    await expect(memberRow(owner.page,bob.id)).toHaveAttribute('data-member-role','member');

    await bobPage.page.reload({waitUntil:'domcontentloaded'});
    await openMembers(bobPage.page);
    await expect(bobPage.page.getByTestId('circle-invite-email')).toBeHidden();
    await expect(bobPage.page.getByTestId('circle-member-row')).toHaveCount(0);
    await bobPage.page.locator('[data-tab="pair"]').click();
    await expect(bobPage.page.locator('#newWeekBtn')).toBeHidden();
    await expect(bobPage.page.locator('#pairDiagnostics')).toBeHidden();
    expect((await json(bobPage.page,'/api/members','PATCH',{action:'make_owner',member_id:cara.id})).status).toBe(404);

    const evidence=await withDatabase(golden,async db=>({
      audits:(await db.execute(`SELECT event_type,actor_user_id,subject_user_id FROM circle_audit_events
        WHERE event_type IN ('ownership.granted','ownership.revoked','admin.granted','admin.revoked') ORDER BY id`))
        .rows.map(row=>[String(row.event_type),Number(row.actor_user_id),Number(row.subject_user_id)]),
      bobSessions:Number((await db.execute({
        sql:`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL`,args:[bob.id],
      })).rows[0].count),
    }));
    expect(evidence.audits).toEqual([
      ['ownership.granted',ownerUser.id,bob.id],
      ['admin.granted',ownerUser.id,bob.id],
      ['ownership.granted',ownerUser.id,cara.id],
      ['admin.granted',ownerUser.id,cara.id],
      ['admin.revoked',bob.id,cara.id],
      ['ownership.revoked',bob.id,cara.id],
      ['admin.revoked',ownerUser.id,bob.id],
      ['ownership.revoked',ownerUser.id,bob.id],
    ]);
    expect(evidence.bobSessions,'role and admin changes never sign the member out').toBe(bobSessionsBefore);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
