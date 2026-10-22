import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {resolvePairingCycle} from '../../api/_pairing-cycle.js';
import {insertPrimaryWeek} from '../support/circle-health-fixture.mjs';
import {
  createPairedCircle,
  json,
  openApp,
  pathIs,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Issue #292 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 18). The real
// loopback runtime runs with CIRCLE_HEALTH_ENABLED. The owner publishes the
// current cycle through the UI (never shown: only finished cycles are); two
// earlier cycles are a hand-built history written straight into the runtime
// database, so every number on screen can be checked against the fixture.
// Only owners see the panel, and the module loads only for them.

const ENV_KEYS=['CIRCLE_HEALTH_ENABLED'] as const;
const HOUR=3600_000;
const ok=(value:number)=>({status:'ok',value});
const untracked={status:'not_tracked',value:null};
const hidden={status:'suppressed',value:null};

async function expectPanelAccessible(page:Page){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      const results=await new AxeBuilder({page}).include('#circleHealthPanel')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`circle health ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
}

function rowCells(page:Page,cycleId:string){
  return page.locator(`[data-testid="circle-health-row"][data-cycle="${cycleId}"] td`);
}

test('circle health: an owner sees fixture-exact metrics for recent finished cycles; a member cannot',async({browser})=>{
  test.setTimeout(150_000);
  const original=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  process.env.CIRCLE_HEALTH_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-circle-health-');
  try{
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    const member=pair.member.page;
    const ownerId=pair.owner.user.id;
    const memberId=pair.member.user.id;

    // The UI published the current cycle, which is never returned. A cycle
    // shows only 49 h after it ends (48 h receipt grace + 1 h clock margin),
    // so the history goes into the two cycles before the one containing
    // now - 49 h, with seven more members in the primary circle.
    const current=await withDatabase(golden,async db=>{
      const week=(await db.execute(`SELECT week_label,week_start FROM pairing_weeks ORDER BY id DESC LIMIT 1`)).rows[0];
      const circleId=Number((await db.execute(`SELECT id FROM circles WHERE is_primary=1 AND archived_at IS NULL`)).rows[0].id);
      const extra=[9101,9102,9103,9104,9105,9106,9107];
      for(const id of extra){
        await db.execute({sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES (?,?,'x',?,'#123456')`,
          args:[id,`fixture${id}@example.test`,`Fixture ${id}`]});
        await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,?,'member','active')`,
          args:[circleId,id]});
      }
      const settled=resolvePairingCycle({now:new Date(Date.now()-49*HOUR)});
      const previous=resolvePairingCycle({now:new Date(Date.parse(settled.startsAt)-1)});
      const older=resolvePairingCycle({now:new Date(Date.parse(previous.startsAt)-1)});
      const published=Date.parse(previous.startsAt);
      const at=(hours:number)=>new Date(published+hours*HOUR).toISOString();
      // Previous cycle: 8 available, all 4 pairs agreed a time, 2 completed
      // (a third has one receipt); 9103-9104 and 9105-9106 repeat from the
      // older cycle.
      await insertPrimaryWeek(db,{label:previous.cycleId,weekStart:previous.startsAt,publishedAt:previous.startsAt,
        participants:[ownerId,memberId,9101,9102,9103,9104,9105,9106],groups:[
          {members:[ownerId,9101],agreed:at(24),receipts:[ownerId,9101]},
          {members:[memberId,9102],agreed:at(36),receipts:[memberId,9102]},
          {members:[9103,9104],agreed:at(60),receipts:[9103]},
          {members:[9105,9106],agreed:at(72)},
        ]});
      // Older cycle: 7 available, one solo, 3 pairs: under the pair floor.
      await insertPrimaryWeek(db,{label:older.cycleId,weekStart:older.startsAt,publishedAt:older.startsAt,
        participants:[9101,9102,9103,9104,9105,9106,9107],groups:[
          {members:[9101,9102]},{members:[9103,9104]},{members:[9105,9106]},{members:[9107]},
        ]});
      return {label:String(week.week_label),previous:previous.cycleId,older:older.cycleId};
    });

    // The API returns exactly the fixture's aggregates for finished cycles,
    // newest first; the current cycle is not included.
    const api=await json(owner,'/api/circle/health');
    expect(api.status,JSON.stringify(api.body)).toBe(200);
    expect(api.body.health.cycles.map((cycle:any)=>cycle.cycle_id)).toEqual([current.previous,current.older]);
    const [previous,older]=api.body.health.cycles;
    const deferred={median_hours_to_agreed_time:untracked,cancelled:untracked,no_show:untracked};
    expect(previous.metrics).toEqual({
      available:ok(8),paired:ok(8),solo:ok(0),pairs:ok(4),scheduled_pairs:ok(4),completed_pairs:ok(2),
      repeat_pair_percent:ok(50),...deferred,
    });
    expect(older.metrics).toEqual({
      available:ok(7),paired:ok(6),solo:ok(1),pairs:ok(3),scheduled_pairs:hidden,completed_pairs:hidden,
      repeat_pair_percent:hidden,...deferred,
    });
    expect(JSON.stringify(api.body)).not.toMatch(new RegExp(`@|Fixture|Golden|Owner|user_id|${current.label}`));

    // The owner sees the same numbers in the Circle tab.
    await owner.locator('[data-tab="circle"]').click();
    const panel=owner.getByTestId('circle-health');
    await expect(panel).toBeVisible();
    await expect(owner.getByTestId('circle-health-row')).toHaveCount(2);
    expect(await rowCells(owner,current.previous).allTextContents())
      .toEqual(['8','8','0','4 of 4','2 of 4','50%']);
    expect(await rowCells(owner,current.older).allTextContents())
      .toEqual(['7','6','1','Hidden','Hidden','Hidden']);
    await expect(owner.getByTestId('circle-health-table').locator('thead th'))
      .toHaveText(['Cycle','Available','Paired','Solo','Agreed a time','Completed','Repeat pairs']);
    await expect(panel).toContainText('A cycle appears two days after it ends');

    // Keyboard only: open the definitions and refresh.
    const summary=panel.locator('summary');
    await summary.focus();
    await owner.keyboard.press('Enter');
    await expect(owner.locator('#circleHealthDefinitions')).toBeVisible();
    await expect(owner.locator('#circleHealthDefinitions')).toContainText('Repeat pairs');
    await owner.keyboard.press('Tab');
    await expect(owner.getByTestId('circle-health-refresh')).toBeFocused();
    const refreshed=owner.waitForResponse(pathIs('/api/circle/health','GET'));
    await owner.keyboard.press('Enter');
    expect((await refreshed).status()).toBe(200);
    await expect(owner.getByTestId('circle-health-row')).toHaveCount(2);
    // The table scrolls sideways on phones, so its region takes focus.
    await owner.locator('#circleHealthTableWrap').focus();
    await expect(owner.locator('#circleHealthTableWrap')).toBeFocused();
    await expectPanelAccessible(owner);

    // A member never sees the panel, never loads the module (watched from a
    // fresh page load), and is refused by the server.
    const memberModuleRequests:string[]=[];
    member.on('request',request=>{ if(new URL(request.url()).pathname==='/assets/circle-health.js') memberModuleRequests.push(request.url()); });
    await openApp(member,golden);
    await expect(member.locator('#meLabel')).toContainText(pair.member.name);
    await member.locator('[data-tab="circle"]').click();
    await expect(member.getByTestId('circle-members')).toBeVisible();
    await expect(member.getByTestId('circle-health')).toBeHidden();
    expect(memberModuleRequests).toEqual([]);
    const denied=await json(member,'/api/circle/health');
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({error:'circle owner required'});
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    for(const [key,value] of Object.entries(original)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
