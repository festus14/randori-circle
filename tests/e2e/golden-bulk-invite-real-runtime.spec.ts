import {expect,test} from '@playwright/test';

import {
  LOCAL_OWNER_EMAIL,
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  newGoldenPage,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Golden path 11b (docs/testing/E2E_GOLDEN_PATHS.md, ID-68): the owner pastes
// a mixed list into the Circle invite card, gets one result per address, and
// an invitee joins through one of the created links — real loopback runtime,
// real database, no API mocks.

test('the owner pastes a mixed list, sees per-email results, and an invitee joins through a created link',async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-golden-bulk-invite-');
  try{
    const owner=await newGoldenPage(browser,golden);
    const invitee=await newGoldenPage(browser,golden);
    let copied='';
    await owner.page.exposeFunction('captureBulkInviteCopy',(value:string)=>{ copied=value; });
    await owner.page.addInitScript(()=>{
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
        writeText:(value:string)=>(window as any).captureBulkInviteCopy(value),
      }});
    });
    await signInOwner(owner.page,golden);
    // One live invitation already exists, so the batch reports "Already invited".
    await createInvitationThroughUi(owner.page,golden,'pending.person@example.test');

    const card=owner.page.getByTestId('circle-bulk-invite');
    const summary=card.locator('summary');
    await summary.focus();
    await owner.page.keyboard.press('Enter');
    const input=owner.page.getByTestId('circle-bulk-invite-input');
    await expect(input).toBeVisible();
    await expect(input).toHaveAccessibleName('Paste emails');
    const submit=owner.page.getByTestId('circle-bulk-invite-submit');
    await expect(submit).toBeDisabled();

    await input.fill([
      'Ada Lovelace <Ada.Bulk@Example.test>, "Hopper, Grace" <grace.bulk@example.test>',
      'ada.bulk@example.test; pending.person@example.test',
      LOCAL_OWNER_EMAIL,
      'not-an-email two@@example.test',
    ].join('\n'));
    await expect(owner.page.getByTestId('circle-bulk-invite-count'))
      .toHaveText('4 ready to invite · 2 to fix · 1 duplicate merged');
    const preview=owner.page.getByTestId('circle-bulk-invite-preview');
    await expect(preview.locator('[data-testid="circle-bulk-invite-preview-row"]')).toHaveCount(6);
    await expect(preview.locator('[data-valid="false"]')).toHaveCount(2);
    await expect(preview).toContainText('This address is missing the @ sign.');
    await expect(submit).toHaveText('Invite 4 people');

    const bulkResponse=owner.page.waitForResponse(pathIs('/api/invitations','POST'));
    await submit.focus();
    await owner.page.keyboard.press('Enter');
    const response=await bulkResponse;
    const payload=await response.json();
    expect(response.status(),JSON.stringify(payload)).toBe(200);
    expect(response.request().postDataJSON()).toEqual({emails:[
      'ada.bulk@example.test','grace.bulk@example.test','pending.person@example.test',LOCAL_OWNER_EMAIL,
    ]});
    expect(payload.results.map((result:any)=>result.status))
      .toEqual(['created','created','already_invited','already_member']);
    expect(payload.summary).toEqual({created:2,invalid:0,duplicate_in_request:0,already_member:1,already_invited:1,failed:0});

    const results=owner.page.getByTestId('circle-bulk-invite-results');
    await expect(results.locator('[data-testid="circle-bulk-invite-result"]')).toHaveCount(6);
    expect(await results.locator('[data-testid="circle-bulk-invite-result"]').evaluateAll(rows=>
      rows.map(row=>(row as HTMLElement).dataset.status)))
      .toEqual(['created','created','already_invited','already_member','invalid','invalid']);
    await expect(owner.page.getByTestId('circle-bulk-invite-status'))
      .toHaveText('Invited 2 people · 1 already in the circle · 1 already invited · 2 to fix.');
    await expect(input).toHaveValue('not-an-email\ntwo@@example.test');
    // The owner recognises the new invitations in the pending list (memory only).
    await expect(owner.page.getByTestId('circle-invites')).toContainText('ada.bulk@example.test');
    await expect(owner.page.getByTestId('circle-invites')).toContainText('grace.bulk@example.test');

    // Each created invitation went through the normal outbox path.
    const queued=await withDatabase(golden,async db=>(await db.execute(`SELECT idempotency_key FROM outbox_events
      WHERE event_type='invitation.email.requested' ORDER BY id`)).rows.map(row=>String(row.idempotency_key)));
    expect(queued.slice(1)).toEqual(payload.results.slice(0,2).map((result:any)=>
      `invitation-email/v1/${result.invitation.id}/1`));

    // Copy link for one created row.
    const adaUrl=new URL(payload.results[0].invitation.invite_url,golden.url);
    await results.getByRole('button',{name:'Copy invitation link for ada.bulk@example.test'}).click();
    await expect.poll(()=>copied).toBe(adaUrl.href);

    // Resend the already-invited address once its resend cooldown has passed.
    await withDatabase(golden,db=>db.execute(`UPDATE outbox_events
      SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-61 seconds')
      WHERE event_type='invitation.email.requested'`));
    const resendResponse=owner.page.waitForResponse(pathIs(`/api/invitations/${payload.results[2].invitation.id}`,'POST'));
    await results.getByRole('button',{name:'Resend invitation to pending.person@example.test'}).click();
    expect((await resendResponse).status()).toBe(200);
    await expect(results.locator('[data-testid="circle-bulk-invite-result"]').nth(2)).toHaveAttribute('data-status','created');

    // The invitee joins through the created link with the invited address.
    const joined=await acceptInvitationThroughUi(invitee.page,golden,adaUrl,{
      email:'ada.bulk@example.test',name:'Ada Bulk',
    });
    expect(joined.email).toBe('ada.bulk@example.test');
    await owner.page.reload({waitUntil:'domcontentloaded'});
    await owner.page.locator('[data-tab="circle"]').click();
    await expect(owner.page.getByTestId('circle-members')).toContainText('Ada Bulk');

    // Pasting the same list again now reports the new member and the pending invitation.
    await owner.page.getByTestId('circle-bulk-invite').locator('summary').click();
    await owner.page.getByTestId('circle-bulk-invite-input').fill('ada.bulk@example.test\ngrace.bulk@example.test');
    const again=owner.page.waitForResponse(pathIs('/api/invitations','POST'));
    await owner.page.getByTestId('circle-bulk-invite-submit').click();
    expect((await (await again).json()).results.map((result:any)=>result.status)).toEqual(['already_member','already_invited']);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
