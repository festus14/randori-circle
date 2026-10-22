import {expect,test,type Page} from '@playwright/test';

import {
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  newGoldenPage,
  openApp,
  openDashboard,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Golden path 20 (docs/testing/E2E_GOLDEN_PATHS.md): client error logging
// (ID-72) against the real loopback runtime. No API route is mocked.

type LoggerWindow=typeof window&{
  _randori_log:{queue:unknown[];flush():void};
  _randori_auth?:{me?:{id?:number}|null;identitySettled?:boolean};
};

function recordLogPosts(page:Page){
  const posts:string[]=[];
  page.on('request',request=>{
    if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/logs') posts.push(request.postData()||'');
  });
  return posts;
}

/** Throws an uncaught error in the page and waits until the logger has seen it. */
async function throwUncaught(page:Page,message:string){
  const mirrored=page.waitForEvent('console',entry=>entry.type()==='error'&&entry.text().includes('[js_exception]')
    &&entry.text().includes(message.slice(0,24)));
  await page.evaluate(text=>{ setTimeout(()=>{ throw new Error(text); }); },message);
  return mirrored;
}

test('a signed-in member error lands in app_logs redacted, a visitor sends nothing, and the admin sees it under client logs',async({browser})=>{
  test.setTimeout(150_000);
  const golden=await startGoldenRuntime('randori-golden-client-logs-');
  try{
    const owner=await newGoldenPage(browser,golden);
    const visitor=await newGoldenPage(browser,golden);
    const memberPage=await newGoldenPage(browser,golden);
    const visitorPosts=recordLogPosts(visitor.page);
    const secret='S'.repeat(43);

    // A signed-out visitor's uncaught error stays in the browser.
    await openApp(visitor.page,golden);
    await expect.poll(()=>visitor.page.evaluate(()=>(window as LoggerWindow)._randori_auth?.identitySettled)).toBe(true);
    await throwUncaught(visitor.page,'golden visitor failure for visitor@example.test');
    await visitor.page.evaluate(()=>(window as LoggerWindow)._randori_log.flush());
    expect(await visitor.page.evaluate(()=>(window as LoggerWindow)._randori_log.queue.length)).toBe(0);

    // An invited member's uncaught error is sent once, redacted.
    await signInOwner(owner.page,golden);
    const invite=await createInvitationThroughUi(owner.page,golden,'logs.member@example.test');
    const member=await acceptInvitationThroughUi(memberPage.page,golden,invite.inviteUrl,{email:'logs.member@example.test',name:'Logs Member'});
    await expect.poll(()=>memberPage.page.evaluate(()=>(window as LoggerWindow)._randori_auth?.me?.id)).toBe(member.id);
    const posted=memberPage.page.waitForResponse(response=>pathIs('/api/logs','POST')(response)
      &&(response.request().postData()||'').includes('golden member failure'));
    await throwUncaught(memberPage.page,`golden member failure for logs.member@example.test at ${golden.origin}/invite#invite=${secret}`);
    const response=await posted;
    expect(response.status()).toBe(200);
    expect((response.request().postData()||'')).not.toContain(secret);

    const rows=await withDatabase(golden,async db=>(await db.execute(
      // The browser prefixes uncaught error messages ("Uncaught Error: …").
      `SELECT level,source,event,message,meta_json,user_id,route FROM app_logs WHERE message LIKE '%golden % failure%' ORDER BY id`,
    )).rows.map(row=>({
      level:String(row.level),source:String(row.source),event:String(row.event),message:String(row.message),
      meta:String(row.meta_json),userId:Number(row.user_id),route:String(row.route),
    })));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({level:'error',source:'client',event:'js_exception',userId:member.id});
    expect(rows[0].route).toMatch(/^\/[^#]*$/);
    expect(rows[0].message).toContain(`golden member failure for [email] at ${golden.origin}/invite`);
    const stored=JSON.stringify(rows);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('logs.member@example.test');
    expect(stored).not.toContain('#invite');

    // The owner (an app admin) finds it in the admin logs panel under the
    // client filter.
    await owner.page.reload({waitUntil:'domcontentloaded'});
    await openDashboard(owner.page);
    await expect(owner.page.locator('#dashDiagnostics')).toBeVisible();
    await owner.page.locator('#dashDiagnostics > summary').click();
    await expect(owner.page.locator('#logsSourceSel')).toBeVisible();
    const clientLogs=owner.page.waitForResponse(response=>pathIs('/api/logs','GET')(response)
      &&new URL(response.url()).searchParams.get('source')==='client');
    await owner.page.locator('#logsSourceSel').selectOption('client');
    expect((await clientLogs).status()).toBe(200);
    await expect(owner.page.locator('#logsList')).toContainText('golden member failure for [email]');
    await expect(owner.page.locator('#logsList')).not.toContainText('golden visitor failure');

    // Nothing from the visitor was ever sent or stored.
    expect(visitorPosts).toEqual([]);
    expect(rows.some(row=>row.message.includes('visitor'))).toBe(false);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
