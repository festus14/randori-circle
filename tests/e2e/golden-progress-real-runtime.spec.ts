import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  FOCUS_BLOCK_ROLLUP_SOLUTION,
  configureExecutionProvider,
  createPairedCircle,
  installDeterministicExecutionTransport,
  json,
  newGoldenPage,
  openApp,
  pathIs,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';
import {waitForThemeSettled} from './golden-theme-settle';

// Issue #293 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 16). The real
// loopback runtime runs with PROGRESS_DASHBOARD_ENABLED. Setup (a verified
// run, roles, both completion receipts) goes through the production APIs; the
// Progress section in History is driven through the UI and checked against
// /api/history, /api/stats and /api/pair-recap for the same member.

const FLAG='PROGRESS_DASHBOARD_ENABLED';

async function openHistory(page:Page){
  // Leave History first so the tab click re-renders it and reloads progress.
  await page.locator('[data-tab="pair"]').click();
  const history=page.waitForResponse(pathIs('/api/history','GET'));
  const progress=process.env[FLAG]==='true'?page.waitForResponse(pathIs('/api/progress','GET')):null;
  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('#view-history')).toBeVisible();
  expect((await history).status()).toBe(200);
  if(progress) expect((await progress).status()).toBe(200);
  return page.getByTestId('progress-dashboard');
}

async function confirmCompletion(page:Page,room:string){
  const current=await json(page,`/api/session-completion?room_id=${room}`);
  expect(current.status,JSON.stringify(current.body)).toBe(200);
  const confirmed=await json(page,'/api/session-completion','POST',{room_id:room,action:'confirm',base_version:current.body.completion.version});
  expect(confirmed.status,JSON.stringify(confirmed.body)).toBe(200);
  return confirmed.body.completion;
}

async function expectProgressAccessible(page:Page){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      await waitForThemeSettled(page,'#historyProgress',light);
      const results=await new AxeBuilder({page}).include('#historyProgress')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`progress ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
}

test('progress: a member sees only their own sessions, streak, coverage and role, and the numbers match History',async({browser})=>{
  test.setTimeout(180_000);
  const original=process.env[FLAG];
  process.env[FLAG]='true';
  const golden=await startGoldenRuntime('randori-golden-progress-');
  const transport=installDeterministicExecutionTransport(()=>golden.origin);
  try{
    configureExecutionProvider();
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    const member=pair.member.page;

    // A new pairing: nothing completed yet, every pattern untouched, and the
    // streak copy explains the rule without blame.
    let dashboard=await openHistory(member);
    await expect(dashboard).toBeVisible();
    await expect(dashboard.getByTestId('progress-completed')).toContainText('0');
    await expect(dashboard.getByTestId('progress-streak')).toContainText('0 weeks');
    await expect(dashboard.getByTestId('progress-streak-note')).toContainText('This week still counts once you both confirm it.');
    await expect(dashboard.getByTestId('progress-streak-note')).toContainText('It ends only when a paired week finishes without everyone confirming.');
    await expect(dashboard.getByTestId('progress-weeks-summary')).toHaveText('Last 12 weeks: 0 weeks with a completed session.');
    await expect(dashboard.locator('[data-testid="progress-patterns"] li[data-state="started"]')).toHaveCount(0);

    // The owner makes a verified run; the pair's shared controls make the
    // member the candidate; both participants confirm the session.
    const executed=await json(owner,'/api/execute','POST',{
      language:'javascript',code:FOCUS_BLOCK_ROLLUP_SOLUTION,question_slug:'focus-block-rollup',question_version:1,
    });
    expect(executed.status,JSON.stringify(executed.body)).toBe(200);
    expect(executed.body).toMatchObject({ok:true,passed_count:8,total_count:8});
    const controls=await json(owner,`/api/session-controls?room_id=${pair.room}`);
    expect(controls.status,JSON.stringify(controls.body)).toBe(200);
    const started=await json(owner,'/api/session-controls','POST',{room_id:pair.room,action:'start',base_version:controls.body.session_controls.version});
    expect(started.status,JSON.stringify(started.body)).toBe(200);
    const candidate=await json(owner,'/api/session-controls','POST',{room_id:pair.room,action:'set_candidate',
      base_version:started.body.session_controls.version,candidate_user_id:pair.member.user.id});
    expect(candidate.status,JSON.stringify(candidate.body)).toBe(200);
    expect((await confirmCompletion(owner,pair.room)).state).toBe('awaiting_participants');
    expect((await confirmCompletion(member,pair.room)).state).toBe('completed');

    // An admin demo week (as the demo shuffle creates) also pairs the member.
    // History lists it; Progress, like /api/stats, does not count it.
    const realWeekId=Number(/^week_(\d+)_pair_/.exec(pair.room)?.[1]);
    await withDatabase(golden,async db=>{
      const demoAccount=await db.execute(`INSERT INTO auth_accounts (email,password_hash,display_name,color,is_demo)
        VALUES ('demo.progress@example.test','demo','Demo Partner','#888888',1) RETURNING id`);
      const demoId=Number(demoAccount.rows[0].id);
      const demoWeek=await db.execute({sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo)
        SELECT 'demo-progress',week_start,'both',1 FROM pairing_weeks WHERE id=? RETURNING id`,args:[realWeekId]});
      const demoWeekId=Number(demoWeek.rows[0].id);
      await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (?,?,0,'auth'),(?,?,1,'auth')`,
        args:[demoWeekId,pair.member.user.id,demoWeekId,demoId]});
      await db.execute({sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair) VALUES (?,?,?,0)`,
        args:[demoWeekId,pair.member.user.id,demoId]});
    });

    // The member's Progress section now shows one completed week.
    dashboard=await openHistory(member);
    await expect(dashboard.getByTestId('progress-completed')).toContainText('1');
    await expect(dashboard.getByTestId('progress-streak')).toContainText('1 week');
    await expect(dashboard.getByTestId('progress-weeks-summary')).toContainText('1 week with a completed session');
    await expect(dashboard.getByTestId('progress-roles-summary')).toContainText('the candidate 1 time and the interviewer 0 times');
    await expect(dashboard.getByTestId('progress-demo-note')).toHaveText('Demo sessions aren’t counted here.');
    // The run was the owner's, not the member's.
    await expect(dashboard.getByTestId('progress-runs-summary')).toContainText('No verified runs in the last 12 weeks.');

    // Consistency on the real runtime: the same member's History, stats and
    // recap agree with the dashboard. Completed sessions equal History's
    // completed rows and /api/stats; History rows are the counted pairings
    // plus the reported demo pairings.
    const [history,stats,progress,recap]=await Promise.all([
      json(member,'/api/history'),json(member,'/api/stats'),json(member,'/api/progress'),
      json(member,`/api/pair-recap?room_id=${pair.room}`),
    ]);
    for(const response of [history,stats,progress,recap]) expect(response.status,JSON.stringify(response.body)).toBe(200);
    const completedRows=history.body.history.filter((row:any)=>row.completion?.state==='completed');
    expect(progress.body.sessions.completed).toBe(completedRows.length);
    expect(progress.body.sessions.completed).toBe(stats.body.your_sessions);
    expect(progress.body.sessions).toMatchObject({pairings:1,demo_pairings:1});
    expect(history.body.history.length).toBe(progress.body.sessions.pairings+progress.body.sessions.demo_pairings);
    expect(recap.body.recap.completion.state).toBe('completed');
    expect(progress.body.weeks.at(-1)).toMatchObject({status:'completed',completion:null});
    await expect(member.locator('[data-testid="pair-history-row"]')).toHaveCount(2);
    await expect(member.locator('[data-testid="pair-history-row"] [data-testid="session-completion-badge"]',{hasText:'Completed'}))
      .toHaveCount(progress.body.sessions.completed);

    // Keyboard: the weekly table and the topic list open from the keyboard,
    // and Tab moves from one to the other.
    const weeksTable=dashboard.getByTestId('progress-weeks-table');
    await weeksTable.locator('summary').focus();
    await member.keyboard.press('Enter');
    await expect(weeksTable).toHaveJSProperty('open',true);
    await expect(weeksTable.locator('tbody tr')).toHaveCount(12);
    await expect(weeksTable.locator('tbody tr').last()).toContainText('Session completed');
    await member.keyboard.press('Tab');
    const topics=dashboard.getByTestId('progress-topics');
    await expect(topics.locator('summary')).toBeFocused();
    await member.keyboard.press('Space');
    await expect(topics).toHaveJSProperty('open',true);
    await expectProgressAccessible(member);

    // The owner sees their own verified run and pattern coverage, as the interviewer.
    const ownerDashboard=await openHistory(owner);
    await expect(ownerDashboard.getByTestId('progress-completed')).toContainText('1');
    await expect(ownerDashboard.getByTestId('progress-runs-summary')).toContainText('1 verified run in the last 12 weeks, 1 passed every case.');
    await expect(ownerDashboard.getByTestId('progress-solved')).toContainText('1 of');
    const solved=ownerDashboard.locator('[data-testid="progress-patterns"] li[data-key="array-processing"]');
    await expect(solved).toHaveAttribute('data-state','started');
    await expect(solved).toContainText('Solved');
    const ownerProgress=await json(owner,'/api/progress');
    expect(ownerProgress.body.sessions.demo_pairings).toBe(0);
    await expect(ownerDashboard.getByTestId('progress-demo-note')).toHaveCount(0);
    await expect(ownerDashboard.locator('[data-testid="progress-patterns"] li[data-state="untouched"]'))
      .toHaveCount(ownerProgress.body.coverage.patterns.length-1);
    await expect(ownerDashboard.getByTestId('progress-roles-summary')).toContainText('the candidate 0 times and the interviewer 1 time');

    // Nobody reads anybody else's progress: not the partner, not the owner,
    // and not a signed-out visitor.
    for(const [page,otherId] of [[member,pair.owner.user.id],[owner,pair.member.user.id]] as const){
      const denied=await json(page,`/api/progress?user_id=${otherId}`);
      expect(denied).toEqual({status:404,body:{error:'progress not found'}});
    }
    const visitor=await newGoldenPage(browser,golden);
    await openApp(visitor.page,golden);
    expect((await json(visitor.page,'/api/progress')).status).toBe(401);

    // With the flag off the route is unknown again and History shows no Progress.
    process.env[FLAG]='false';
    expect((await json(member,'/api/progress')).status).toBe(404);
    await openHistory(member);
    await expect(member.getByTestId('progress-dashboard')).toBeHidden();
    await expect(member.locator(`[data-testid="pair-history-row"][data-room-id="${pair.room}"]`)).toBeVisible();

    expect(transport.unexpectedExternalRequests).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    transport.restore();
    await golden.close();
    if(original===undefined) delete process.env[FLAG]; else process.env[FLAG]=original;
  }
});
