import {expect,test} from '@playwright/test';

import {setCode} from './helpers';
import {
  FOCUS_BLOCK_ROLLUP_SOLUTION,
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_NAME,
  LOCAL_OWNER_PASSWORD,
  MEMBER_PASSWORD,
  acceptInvitationThroughUi,
  configureExecutionProvider,
  createInvitationThroughUi,
  installDeterministicExecutionTransport,
  json,
  newGoldenPage,
  openApp,
  pathIs,
  signInOwner,
  signInThroughForm,
  startGoldenRuntime,
} from './golden-runtime';

// Golden paths 10 and 11 (docs/testing/E2E_GOLDEN_PATHS.md) against the real
// loopback runtime.

test('the owner revokes an invitation, sees a new member join the roster, and removes them so they are blocked',async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-golden-circle-admin-');
  try{
    const owner=await newGoldenPage(browser,golden);
    const outsider=await newGoldenPage(browser,golden);
    const member=await newGoldenPage(browser,golden);
    await signInOwner(owner.page,golden);

    // Create → revoke: the revoked link is dead for the invitee.
    const revokedInvite=await createInvitationThroughUi(owner.page,golden,'revoked.invitee@example.test');
    const invites=owner.page.getByTestId('circle-invites');
    await expect(invites.getByTestId('circle-invite-revoke')).toHaveCount(1);
    const revoked=owner.page.waitForResponse(pathIs(`/api/invitations/${revokedInvite.invitationId}`,'DELETE'));
    await invites.getByTestId('circle-invite-revoke').click();
    expect((await revoked).status()).toBe(200);
    await expect(invites).toContainText('revoked');
    await outsider.page.goto(revokedInvite.inviteUrl.href,{waitUntil:'domcontentloaded'});
    await expect(outsider.page.getByTestId('invite-status')).toContainText('unavailable');
    await expect(outsider.page.getByTestId('invite-continue')).toBeDisabled();

    // A second invitation is accepted; the member appears in the roster.
    const {inviteUrl}=await createInvitationThroughUi(owner.page,golden,'removable.member@example.test');
    const joined=await acceptInvitationThroughUi(member.page,golden,inviteUrl,{
      email:'removable.member@example.test',name:'Removable Member',
    });
    await owner.page.reload({waitUntil:'domcontentloaded'});
    await owner.page.locator('[data-tab="circle"]').click();
    await expect(owner.page.getByTestId('circle-members')).toContainText('Removable Member');
    const panel=owner.page.getByTestId('circle-lifecycle');
    const row=panel.locator(`[data-testid="circle-member-row"][data-member-id="${joined.id}"]`);
    await expect(row).toHaveAttribute('data-member-status','active');
    await expect(row).toHaveAttribute('data-member-role','member');
    await expect(row).toContainText('Active');

    // Remove (deactivate) the member through the owner controls.
    await row.getByRole('button',{name:'Deactivate Removable Member'}).click();
    await expect(owner.page.locator('#confirmTitle')).toHaveText(/Deactivate Removable Member/);
    const deactivated=owner.page.waitForResponse(pathIs('/api/members','PATCH'));
    await owner.page.locator('#confirmOk').click();
    expect((await deactivated).status()).toBe(200);
    await expect(row).toHaveAttribute('data-member-status','inactive');
    await expect(row).toHaveAttribute('data-member-role','member');
    await expect(row).toContainText('Inactive');

    // The removed member's existing session no longer reaches circle data,
    // the app returns them to signed-out, and signing in again is refused.
    expect((await json(member.page,'/api/circle')).status).toBe(401);
    await member.page.reload({waitUntil:'domcontentloaded'});
    await expect(member.page.locator('#authBtn')).toBeVisible();
    await expect(member.page.locator('#meLabel')).toBeHidden();
    const refused=await signInThroughForm(member.page,'removable.member@example.test',MEMBER_PASSWORD);
    expect(refused.status()).toBe(403);
    await expect(member.page.locator('#authErr')).toContainText('circle membership is no longer active');
    await expect(member.page.locator('#meLabel')).toBeHidden();
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});

test('solo practice browses, filters and searches the catalogue, opens an exercise, and runs it',async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-golden-catalogue-');
  const transport=installDeterministicExecutionTransport(()=>golden.origin);
  try{
    configureExecutionProvider();
    const {page}=await newGoldenPage(browser,golden);
    // Regression: the member-only catalogue is first requested anonymously on
    // the landing page. Let that 401 settle, then sign in without a reload;
    // the catalogue must load for the signed-in member.
    await openApp(page,golden);
    await expect.poll(()=>page.evaluate(()=>(window as any)._randori_questions?.state)).toBe('failed');
    const owner=await signInThroughForm(page,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD);
    expect(owner.status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText(LOCAL_OWNER_NAME);
    await page.locator('[data-tab="code"]').click();
    await expect(page.locator('#view-code')).toBeVisible();
    await expect(page.getByTestId('catalog-filters')).toBeVisible();
    const options=page.locator('#questionSelect option');
    await expect.poll(()=>options.count()).toBeGreaterThan(5);
    const total=await options.count();

    // Filter by difficulty and type, then search by free text.
    await page.getByTestId('catalog-difficulty').selectOption('Easy');
    await expect.poll(()=>options.count()).toBeLessThan(total);
    await page.getByTestId('catalog-difficulty').selectOption('all');
    await expect.poll(()=>options.count()).toBe(total);
    await page.getByTestId('catalog-type').selectOption('binary-search');
    await expect(page.locator('#questionSelect option[value="capacity-upgrade-index"]')).toHaveCount(1);
    await expect.poll(()=>options.count()).toBeLessThan(total);
    await page.getByTestId('catalog-type').selectOption('all');
    await page.getByTestId('catalog-search').fill('nothing matches this zzz');
    await expect(page.getByTestId('catalog-empty')).toBeVisible();
    await page.getByTestId('catalog-search').fill('  FOCUS block ');
    await expect(page.locator('#questionSelect')).toHaveValue('focus-block-rollup');
    await expect(page.locator('#qTitle')).toHaveText('Focus Block Roll-up');

    // Open it in JavaScript and run a correct solution against the server cases.
    await page.locator('#langSelect').selectOption('javascript');
    await setCode(page,FOCUS_BLOCK_ROLLUP_SOLUTION);
    const executed=page.waitForResponse(pathIs('/api/execute','POST'));
    await page.locator('#runBtn').click();
    const execution=await executed;
    expect(execution.status()).toBe(200);
    expect(await execution.json()).toMatchObject({ok:true,question_slug:'focus-block-rollup',passed_count:8,total_count:8});
    await expect(page.locator('#runOut')).toContainText('Result: 8/8 passed');
    await expect(page.locator('#runOut')).toContainText('Checked on the server');
    expect(transport.requests).toEqual([{language:'javascript',version:'18.15.0',files:['main.js']}]);

    // A wrong solution reports the authoritative failure rather than passing.
    await setCode(page,'function rollUpFocusBlocks(blocks) { return []; }');
    const failed=page.waitForResponse(pathIs('/api/execute','POST'));
    await page.locator('#runBtn').click();
    expect(await (await failed).json()).toMatchObject({ok:true,total_count:8});
    await expect(page.locator('#runOut')).toContainText(/Result: [0-7]\/8 passed/);
    await expect(page.locator('#runOut')).toContainText('✗ fail');
    expect(transport.unexpectedExternalRequests).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    transport.restore();
    await golden.close();
  }
});
