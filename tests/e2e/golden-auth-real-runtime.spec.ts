import {expect,test} from '@playwright/test';

import {deliverPasswordResets} from '../../api/_password-reset.js';
import {
  CapturedEmail,
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_NAME,
  LOCAL_OWNER_PASSWORD,
  emailLinks,
  json,
  newGoldenPage,
  openApp,
  openSignin,
  pathIs,
  signInOwner,
  signInThroughForm,
  signOutThroughMenu,
  startGoldenRuntime,
  withDatabase,
  workerOptions,
} from './golden-runtime';

// Golden paths 2 and 3 (docs/testing/E2E_GOLDEN_PATHS.md) against the real
// loopback runtime. The invite → signup → verify → dashboard journey and the
// successful forgot-password journey live in
// password-auth-journey-real-runtime.spec.ts; this file covers the remaining
// session-revocation and terminal reset-link states without API mocks.

test('a member signs in on two devices, a wrong password stays generic, and sign out everywhere revokes both',{tag:'@smoke'},async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-golden-logout-all-');
  try{
    const laptop=await newGoldenPage(browser,golden);
    const phone=await newGoldenPage(browser,golden);

    await openApp(laptop.page,golden);
    const wrong=await signInThroughForm(laptop.page,LOCAL_OWNER_EMAIL,'definitely-not-the-password');
    expect(wrong.status()).toBe(401);
    await expect(laptop.page.locator('#authErr')).toHaveText('Email or password is incorrect.');
    await expect(laptop.page.locator('#meLabel')).toBeHidden();
    const ok=await signInThroughForm(laptop.page,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD,{open:false});
    expect(ok.status()).toBe(200);
    await expect(laptop.page.locator('#meLabel')).toContainText(LOCAL_OWNER_NAME);

    await signInOwner(phone.page,golden);
    expect((await json(phone.page,'/api/auth/me')).status).toBe(200);

    // Ordinary sign-out only ends this device's session.
    await signOutThroughMenu(phone.page);
    expect((await json(phone.page,'/api/auth/me')).status).toBe(401);
    expect((await json(laptop.page,'/api/auth/me')).status).toBe(200);
    await signInOwner(phone.page,golden);
    const phoneCookie=(await phone.context.cookies(golden.url)).find(cookie=>cookie.name==='randori_session');
    expect(phoneCookie?.httpOnly).toBe(true);

    // Sign out everywhere from the laptop revokes the phone's session too.
    await signOutThroughMenu(laptop.page,{everywhere:true});
    expect((await json(laptop.page,'/api/auth/me')).status).toBe(401);
    const replayed=await fetch(new URL('/api/auth/me',golden.url),{
      headers:{cookie:`${phoneCookie!.name}=${phoneCookie!.value}`},
    });
    expect(replayed.status).toBe(401);
    await phone.page.reload({waitUntil:'domcontentloaded'});
    await expect(phone.page.locator('#authBtn')).toBeVisible();
    await expect(phone.page.locator('#meLabel')).toBeHidden();

    // The password itself still works afterwards.
    await signInOwner(laptop.page,golden);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});

test('expired and replaced reset links explain why and offer a new link that still works',{tag:'@smoke'},async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-golden-reset-terminal-');
  const {page}=await newGoldenPage(browser,golden);
  const deliverResets=async()=>withDatabase(golden,async db=>{
    const sent:CapturedEmail[]=[];
    const result=await deliverPasswordResets({db,baseUrl:golden.url,workerId:`golden-reset-${Date.now()}`,workerOptions,
      send:async(message:CapturedEmail)=>{ sent.push(message); return {providerName:'local-capture',providerMessageId:`golden-reset-${sent.length}`}; }});
    expect(result.delivered).toBe(sent.length);
    return sent.map(message=>emailLinks(message)[0]);
  });
  // Test-only clock advancement: age the stored reset row consistently
  // (created/sent/expiry move together to satisfy the table constraints).
  const ageResetRow=(seconds:number)=>withDatabase(golden,db=>db.execute({sql:`UPDATE auth_password_resets
    SET created_at=created_at-?,last_sent_at=last_sent_at-?,expires_at=expires_at-?`,args:[seconds,seconds,seconds]}));
  const requestReset=async()=>{
    await openSignin(page);
    await page.locator('#authForgot').click();
    await expect(page.getByRole('dialog',{name:'Reset your password'})).toBeVisible();
    await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
    const requested=page.waitForResponse(pathIs('/api/auth/password-reset/request','POST'));
    await page.locator('#authResetRequest').click();
    expect((await requested).status()).toBe(202);
    await expect(page.locator('#authErr')).toContainText('If that account is eligible');
    await page.locator('#authCancel').click();
  };
  const submitReset=async(link:string,password:string)=>{
    // Open each emailed link as a fresh document load, as a mail client does
    // (a same-tab hash-only change is not a new navigation).
    await page.goto('about:blank');
    await page.goto(link,{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(`${golden.url}/reset-password`);
    await expect(page.getByTestId('password-reset-landing')).toBeVisible();
    await page.locator('#passwordResetNew').fill(password);
    await page.locator('#passwordResetConfirm').fill(password);
    const consumed=page.waitForResponse(pathIs('/api/auth/password-reset/consume','POST'));
    await page.locator('#passwordResetSubmit').click();
    return consumed;
  };
  const expectTerminal=async(reason:RegExp)=>{
    await expect(page.getByTestId('password-reset-status')).toContainText(reason);
    await expect(page.locator('#passwordResetNew')).toBeHidden();
    await expect(page.locator('#passwordResetSubmit')).toBeHidden();
    await expect(page.getByTestId('password-reset-request-new')).toBeVisible();
  };
  try{
    await openApp(page,golden);

    // 1. Replaced: a newer reset email invalidates the earlier link.
    await requestReset();
    const [firstLink]=await deliverResets();
    expect(firstLink).toMatch(/\/reset-password#token=[A-Za-z0-9_-]{43}$/);
    // Move past the 60-second resend cooldown (well inside the 30-minute
    // lifetime); the second request still goes through the real endpoint.
    await ageResetRow(120);
    await openApp(page,golden);
    await requestReset();
    const [secondLink]=await deliverResets();
    expect(secondLink).toMatch(/\/reset-password#token=[A-Za-z0-9_-]{43}$/);
    expect(secondLink).not.toBe(firstLink);
    const replaced=await submitReset(firstLink,'replaced-link-password');
    expect(replaced.status()).toBe(409);
    await expectTerminal(/replaced by a newer reset email/);

    // 2. Expired: the newest link is refused once its 30-minute lifetime ends.
    await ageResetRow(3600);
    const expired=await submitReset(secondLink,'expired-link-password');
    expect(expired.status()).toBe(409);
    await expectTerminal(/valid for 30 minutes/);

    // Neither refused link changed the password.
    expect((await json(page,'/api/auth/login','POST',{email:LOCAL_OWNER_EMAIL,password:'expired-link-password'})).status).toBe(401);
    expect((await json(page,'/api/auth/login','POST',{email:LOCAL_OWNER_EMAIL,password:'replaced-link-password'})).status).toBe(401);

    // 3. "Request a new link" reopens the request form; the fresh link works.
    await page.getByTestId('password-reset-request-new').click();
    await expect(page.getByRole('dialog',{name:'Reset your password'})).toBeVisible();
    await expect(page).toHaveURL(`${golden.url}/`);
    await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
    const requested=page.waitForResponse(pathIs('/api/auth/password-reset/request','POST'));
    await page.locator('#authResetRequest').click();
    expect((await requested).status()).toBe(202);
    const [freshLink]=await deliverResets();
    const fresh=await submitReset(freshLink,'fresh-link-password');
    expect(fresh.status()).toBe(200);
    await expect(page.getByTestId('password-reset-status')).toContainText('all existing sessions were signed out');
    await page.locator('#passwordResetSignin').click();
    const oldPassword=await signInThroughForm(page,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD,{open:false});
    expect(oldPassword.status()).toBe(401);
    await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
    const newPassword=await signInThroughForm(page,LOCAL_OWNER_EMAIL,'fresh-link-password',{open:false});
    expect(newPassword.status()).toBe(200);
    await expect(page.locator('#meLabel')).toContainText(LOCAL_OWNER_NAME);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
