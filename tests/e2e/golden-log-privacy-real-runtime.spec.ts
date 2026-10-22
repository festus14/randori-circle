import {expect,test,type Page} from '@playwright/test';

import {
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  newGoldenPage,
  openDashboard,
  pathIs,
  signInOwner,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Golden path 22 (docs/testing/E2E_GOLDEN_PATHS.md): app_logs keeps no raw
// IP address or user agent (ID-82, issue #340), against the real loopback
// runtime. No API route is mocked. The member's browser presents a forwarded
// address and a desktop Chrome user agent, as Vercel's proxy would. A
// member's row keeps no address at all; rows without a user may keep the
// daily hash.

const MEMBER_ADDRESS='203.0.113.77';
const MEMBER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ADDRESS_HASH=/^h1:[0-9a-f]{16}$/;
const FAMILY=/^(?:bot|other|(?:Edge|Opera|Samsung Internet|Firefox|Headless Chrome|Chrome|Safari|other)(?: \d{1,4})? on (?:iOS \d{1,2}|Android \d{1,2}|Windows(?: 10\/11| 8\.1| 8| 7)?|ChromeOS|macOS|Linux|other))$/;
const RAW_IPV4=/\b\d{1,3}(?:\.\d{1,3}){3}\b/;

type LogRow={ua:string|null;ip:string|null;user_id?:unknown};

function expectReduced(rows:LogRow[],label:string){
  for(const row of rows){
    const text=JSON.stringify(row);
    expect(text,label).not.toContain(MEMBER_ADDRESS);
    expect(text,label).not.toMatch(/Mozilla\/5\.0|AppleWebKit|HeadlessChrome\//);
    if(row.user_id!=null) expect(row.ip,label).toBeNull();
    if(row.ip!==null) expect(row.ip,label).toMatch(ADDRESS_HASH);
    if(row.ua!==null) expect(row.ua,label).toMatch(FAMILY);
    expect(String(row.ip??''),label).not.toMatch(RAW_IPV4);
  }
}

/** Throws an uncaught error in the page and resolves with the /api/logs response whose body holds `marker`. */
async function throwUncaught(page:Page,message:string,marker:string){
  const posted=page.waitForResponse(response=>pathIs('/api/logs','POST')(response)
    &&(response.request().postData()||'').includes(marker));
  await page.evaluate(text=>{ setTimeout(()=>{ throw new Error(text); }); },message);
  return posted;
}

test('a member log row keeps no address and a coarse browser family, and the admin logs panel still shows it',async({browser})=>{
  test.setTimeout(150_000);
  const golden=await startGoldenRuntime('randori-golden-log-privacy-');
  try{
    const owner=await newGoldenPage(browser,golden);
    const memberPage=await newGoldenPage(browser,golden,{
      userAgent:MEMBER_AGENT,
      extraHTTPHeaders:{'x-forwarded-for':`${MEMBER_ADDRESS}, 10.0.0.1`},
    });

    await signInOwner(owner.page,golden);
    const invite=await createInvitationThroughUi(owner.page,golden,'privacy.member@example.test');
    const member=await acceptInvitationThroughUi(memberPage.page,golden,invite.inviteUrl,
      {email:'privacy.member@example.test',name:'Privacy Member'});
    await expect.poll(()=>memberPage.page.evaluate(()=>(window as any)._randori_auth?.me?.id)).toBe(member.id);
    expect(await memberPage.page.evaluate(()=>navigator.userAgent)).toBe(MEMBER_AGENT);

    // A member's uncaught error is stored with the reduced client fields; the
    // address it quotes is redacted before it leaves the browser.
    const response=await throwUncaught(memberPage.page,`golden privacy failure from ${MEMBER_ADDRESS}`,'golden privacy failure');
    expect(response.status()).toBe(200);
    expect(response.request().postData()||'').not.toContain(MEMBER_ADDRESS);
    const memberRows=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT source,user_id,message,ua,ip FROM app_logs WHERE user_id=? AND message LIKE '%golden privacy failure%'`,
      args:[member.id],
    })).rows.map(row=>({source:String(row.source),userId:Number(row.user_id),message:String(row.message),
      ua:row.ua==null?null:String(row.ua),ip:row.ip==null?null:String(row.ip)})));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]).toMatchObject({source:'client',userId:member.id,ua:'Chrome 131 on Windows 10/11',ip:null});
    expect(memberRows[0].message).toContain('golden privacy failure from [ip]');

    // Nothing anywhere in app_logs holds a raw address or user agent: not
    // the member's, and not the owner's headless browser either.
    const allRows=await withDatabase(golden,async db=>(await db.execute(
      `SELECT level,source,event,message,meta_json,user_id,route,ua,ip FROM app_logs ORDER BY id`,
    )).rows.map(row=>({...row,user_id:row.user_id==null?null:Number(row.user_id),
      ua:row.ua==null?null:String(row.ua),ip:row.ip==null?null:String(row.ip)})));
    expect(allRows.length).toBeGreaterThan(0);
    expectReduced(allRows,'stored');

    // The owner (an app admin) still reads the row in the admin logs panel,
    // and the API behind it returns only the reduced values.
    await owner.page.reload({waitUntil:'domcontentloaded'});
    await openDashboard(owner.page);
    await expect(owner.page.locator('#dashDiagnostics')).toBeVisible();
    await owner.page.locator('#dashDiagnostics > summary').click();
    await expect(owner.page.locator('#logsSourceSel')).toBeVisible();
    const clientLogs=owner.page.waitForResponse(response=>pathIs('/api/logs','GET')(response)
      &&new URL(response.url()).searchParams.get('source')==='client');
    await owner.page.locator('#logsSourceSel').selectOption('client');
    const read=await clientLogs;
    expect(read.status()).toBe(200);
    const payload=await read.json() as {logs:Array<LogRow&{message:string;user_id:number}>};
    const shown=payload.logs.find(log=>log.message.includes('golden privacy failure'));
    expect(shown).toMatchObject({user_id:member.id,ua:'Chrome 131 on Windows 10/11',ip:null});
    expectReduced(payload.logs,'returned');
    await expect(owner.page.locator('#logsList')).toContainText('golden privacy failure');
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
