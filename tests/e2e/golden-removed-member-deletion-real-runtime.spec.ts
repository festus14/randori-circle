import AxeBuilder from '@axe-core/playwright';
import {expect,test,Page} from '@playwright/test';
import {createPairedCircle,startGoldenRuntime,newGoldenPage,withDatabase,json,GoldenRuntime} from './golden-runtime';

const CRON_SECRET='golden-removed-deletion-cron-secret';
const keys=['ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED','CRON_SECRET'] as const;
type Mail={recipient_email:string;links:string[]};
async function drain(page:Page){
  const response=await page.evaluate(async secret=>{
    const res=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});
    return {status:res.status,body:await res.json()};
  },CRON_SECRET);
  expect(response.status,JSON.stringify(response.body)).toBe(200);return response.body;
}
async function requestLink(page:Page,golden:GoldenRuntime,email:string){
  await page.goto(`${golden.url}/delete-account`);
  await page.getByLabel('Account email').fill(email);
  const sent=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/auth/account/delete/link');
  await page.getByRole('button',{name:'Email me a deletion link'}).click();
  expect((await sent).status()).toBe(202);
  await expect(page.getByRole('status')).toContainText('If that account can request deletion');
  const messages=(await drain(page)).account_deletion_link_delivery?.captured as Mail[];
  expect(messages).toHaveLength(1);expect(messages[0].recipient_email).toBe(email);
  return messages[0].links.find(link=>link.includes('#token='))!;
}
async function followAndConfirm(page:Page,url:string){
  await page.goto(url);
  await expect(page.getByLabel('Type DELETE')).toBeFocused();
  expect(new URL(page.url()).hash).toBe('');
  await expect(page.getByRole('button',{name:'Schedule account deletion'})).toBeDisabled();
  await page.getByLabel('Type DELETE').fill('DELETE');
  const response=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/auth/account/delete/confirm-token');
  await page.getByRole('button',{name:'Schedule account deletion'}).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole('status')).toContainText('Your account is locked and scheduled for deletion');
}

for(const google of [false,true])test(`removed ${google?'Google-only':'password'} member: emailed request → locked → cancel without membership restore → request → day 14 deleted`,async({browser})=>{
  test.setTimeout(180_000);
  const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.ACCOUNT_DELETION_ENABLED='true';process.env.ACCOUNT_DELETION_GRACE_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-removed-deletion-');
  try{
    process.env.CRON_SECRET=CRON_SECRET;
    const pair=await createPairedCircle(browser,golden,{memberEmail:`removed-${google?'google':'password'}@example.test`,memberName:'Removed Member'});
    const owner=pair.owner.page,userId=pair.member.user.id;
    // Remove through the existing owner API; no pairing code is changed.
    const removal=await json(owner,'/api/members','PATCH',{action:'deactivate',member_id:userId});
    expect(removal.status,JSON.stringify(removal.body)).toBe(200);
    if(google)await withDatabase(golden,db=>db.execute({sql:"UPDATE auth_accounts SET password_hash='!oauth:only',google_sub='removed-google' WHERE id=?",args:[userId]}));
    // Reproduce Resolution 2: retained admin flag with no active memberships.
    await withDatabase(golden,db=>db.execute({sql:'UPDATE auth_accounts SET is_admin=1 WHERE id=?',args:[userId]}));
    const {context,page}=await newGoldenPage(browser,golden);
    const link=await requestLink(page,golden,pair.member.email);
    await followAndConfirm(page,link);
    expect(await context.cookies()).toEqual([],'email proof creates no session');
    const locked=await json(pair.member.page,'/api/auth/me');expect([401,403]).toContain(locked.status);
    const roster=await json(owner,'/api/members');
    expect(roster.body.members.find((row:any)=>row.id===userId)?.deletion_pending).toBe(true);
    const confirmations=(await drain(page)).account_deletion_confirmation_delivery?.captured as Mail[];
    expect(confirmations).toHaveLength(1);
    const cancel=confirmations[0].links.find(link=>link.includes('#cancel='))!;expect(cancel).toBeTruthy();
    // The public proof page has no account details and works by keyboard.
    await page.goto(cancel);
    const violations=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    expect(violations.violations).toEqual([]);
    await expect(page.getByRole('button',{name:'Cancel account deletion'})).toBeFocused();
    const response=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/auth/account/delete/cancel-token');
    await page.keyboard.press('Enter');expect((await response).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText('circle membership is not restored');
    const membership=await withDatabase(golden,db=>db.execute({sql:'SELECT status FROM circle_memberships WHERE user_id=?',args:[userId]}));
    expect(membership.rows.map(row=>row.status)).toEqual(['inactive']);
    const account=await withDatabase(golden,db=>db.execute({sql:'SELECT email FROM auth_accounts WHERE id=?',args:[userId]}));
    expect(account.rows[0].email).toBe(pair.member.email);
    const second=await requestLink(page,golden,pair.member.email);
    await followAndConfirm(page,second);
    await drain(page);
    await withDatabase(golden,db=>db.execute({sql:`UPDATE account_deletion_requests
      SET requested_at=strftime('%s','now')-15*24*3600,scheduled_for=strftime('%s','now')-3600
      WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL`,args:[userId]}));
    const executed=await drain(page);expect(executed.outbox.account_deletion_grace.executed).toBe(1);
    expect(executed.outbox.account_deletion_grace.errors).toEqual([]);
    const tombstone=await withDatabase(golden,db=>db.execute({sql:'SELECT email,display_name FROM auth_accounts WHERE id=?',args:[userId]}));
    expect(tombstone.rows.map(row=>({...row}))).toEqual([{email:`deleted-${userId}@account-deleted.invalid`,display_name:'Deleted member'}]);
    expect((await json(owner,'/api/health/ready')).status).toBe(200);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
  }
});
