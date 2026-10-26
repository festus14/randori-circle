import {expect,test} from '@playwright/test';

import {
  acceptInvitationThroughUi,
  createInvitationThroughUi,
  json,
  newGoldenPage,
  openApp,
  openDashboard,
  pathIs,
  signInOwner,
  signOutThroughMenu,
  startGoldenRuntime,
} from './golden-runtime';

// Golden path 24 (docs/testing/E2E_GOLDEN_PATHS.md): circle-wide totals from
// /api/stats are for signed-in members only (issue #333, ID-86), against the
// real loopback runtime. No API route is mocked. The public landing makes no
// /api/stats call, a signed-out request is refused with 401 and no totals, a
// member's dashboard still shows the circle summary, and signing out closes
// the route again.

const REFUSED={status:401,body:{error:'authentication required'}};

test('signed-out visitors get no circle totals while a member dashboard still shows them',async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-golden-stats-privacy-');
  try{
    // A signed-out visitor: the landing never asks for stats, and asking
    // directly returns 401 with no totals.
    const visitor=await newGoldenPage(browser,golden);
    const visitorStats:string[]=[];
    visitor.page.on('request',request=>{
      if(new URL(request.url()).pathname==='/api/stats') visitorStats.push(request.url());
    });
    await openApp(visitor.page,golden);
    await expect(visitor.page.locator('#view-landing')).toBeVisible();
    await visitor.page.evaluate(()=>(window as any)._randori_home.bootHome());
    await visitor.page.waitForTimeout(1500);
    expect(visitorStats).toEqual([]);
    expect(await json(visitor.page,'/api/stats')).toEqual(REFUSED);
    expect(await json(visitor.page,'/api/stats?_=1234')).toEqual(REFUSED);

    // A member who joins by invitation sees the circle summary on the
    // dashboard, and the API returns the totals and the member's own counts.
    const owner=await newGoldenPage(browser,golden);
    const memberPage=await newGoldenPage(browser,golden);
    await signInOwner(owner.page,golden);
    const invite=await createInvitationThroughUi(owner.page,golden,'stats.member@example.test');
    const member=await acceptInvitationThroughUi(memberPage.page,golden,invite.inviteUrl,
      {email:'stats.member@example.test',name:'Stats Member'});
    await expect.poll(()=>memberPage.page.evaluate(()=>(window as any)._randori_auth?.me?.id)).toBe(member.id);
    await openDashboard(memberPage.page);
    const loaded=memberPage.page.waitForResponse(response=>pathIs('/api/stats','GET')(response)&&response.status()===200);
    await memberPage.page.evaluate(()=>{ void (window as any)._randori_home.bootHome(); });
    const shown=await (await loaded).json();
    expect(shown).toMatchObject({ok:true,your_sessions:0,total_sessions:0});
    expect(Number(shown.total_users)).toBeGreaterThanOrEqual(2);
    await expect(memberPage.page.locator('#dashStatCircle')).toHaveText(String(shown.total_users));
    await expect(memberPage.page.locator('#dashStatWeeks')).toHaveText(`${shown.total_weeks} weeks`);
    await expect(memberPage.page.locator('#dashStatYou')).toHaveText('0');
    const direct=await json(memberPage.page,'/api/stats');
    expect(direct.status).toBe(200);
    expect(direct.body).toMatchObject({ok:true,total_users:shown.total_users,your_sessions:0,your_pairings:0});

    // After signing out, the same browser is a visitor again and the route
    // refuses it.
    await signOutThroughMenu(memberPage.page);
    await expect(memberPage.page.locator('#view-landing')).toBeVisible();
    expect(await json(memberPage.page,'/api/stats')).toEqual(REFUSED);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
