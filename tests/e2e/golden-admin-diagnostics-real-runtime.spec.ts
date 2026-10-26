import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  createPairedCircle,
  json,
  newGoldenPage,
  openApp,
  pathIs,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';
import {waitForThemeSettled} from './golden-theme-settle';

// Issue #310 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 15). The real
// loopback runtime runs with ADMIN_DIAGNOSTICS_ENABLED. A global admin opens
// Circle › Diagnostics, sees every status card (including the stale state and
// the latest provider smoke result, #343), and replays a dead letter through
// the existing audited endpoint after a confirmation. Members, ordinary owners,
// demo admins and visitors are refused.

const CRON_SECRET='golden-admin-diagnostics-cron-secret';
const ENV_KEYS=['ADMIN_DIAGNOSTICS_ENABLED','CRON_SECRET'] as const;

async function drainOutbox(page:Page){
  const response=await page.evaluate(async secret=>{
    const result=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});
    return result.status;
  },CRON_SECRET);
  expect(response).toBe(200);
}

async function refresh(page:Page){
  const loaded=page.waitForResponse(pathIs('/api/admin/diagnostics','GET'));
  await page.getByTestId('admin-diagnostics-refresh').focus();
  await page.keyboard.press('Enter');
  const response=await loaded;
  expect(response.status()).toBe(200);
  await expect(page.locator('#adminDiagnostics')).toHaveAttribute('aria-busy','false');
  return response.json();
}

const MODULE_PATH='/assets/admin-diagnostics.js';

/** Records every request for the lazily loaded diagnostics module. */
function recordModuleRequests(page:Page){
  const requests:string[]=[];
  page.on('request',request=>{ if(new URL(request.url()).pathname===MODULE_PATH) requests.push(request.url()); });
  return requests;
}

/** Reloads, waits for capabilities and the session to settle, and opens Circle. */
async function reloadSettled(page:Page){
  const capabilities=page.waitForResponse(pathIs('/api/auth/capabilities','GET'));
  const me=page.waitForResponse(pathIs('/api/auth/me','GET'));
  await page.reload({waitUntil:'domcontentloaded'});
  await Promise.all([capabilities,me]);
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#view-circle')).toBeVisible();
  await expect(page.locator('#peopleList')).toHaveAttribute('aria-busy','false');
}

const card=(page:Page,id:string)=>page.locator(`[data-testid="admin-diagnostics-card"][data-card="${id}"]`);

async function expectDiagnosticsAccessible(page:Page){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      await waitForThemeSettled(page,'#adminDiagnostics',light);
      const results=await new AxeBuilder({page}).include('#adminDiagnostics')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`diagnostics ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
}

test('admin diagnostics: a global admin reads every card, sees stale evidence, and replays a dead letter after confirming',async({browser})=>{
  test.setTimeout(180_000);
  const original=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  process.env.ADMIN_DIAGNOSTICS_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-admin-diagnostics-');
  try{
    // The local runtime clears CRON_SECRET at start; the cron route needs one.
    process.env.CRON_SECRET=CRON_SECRET;
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    const member=pair.member.page;
    expect(pair.owner.user.is_admin).toBe(true);

    // Visitors, members, ordinary owners and demo admins are refused. The
    // member and the demo admin never see the disclosure or download its script.
    const visitor=await newGoldenPage(browser,golden);
    await openApp(visitor.page,golden);
    expect((await json(visitor.page,'/api/admin/diagnostics')).status).toBe(401);
    const memberModule=recordModuleRequests(member);
    await reloadSettled(member);
    expect((await json(member,'/api/admin/diagnostics')).status).toBe(403);
    await expect(member.getByTestId('admin-diagnostics')).toBeHidden();
    await withDatabase(golden,db=>db.execute({sql:`UPDATE circle_memberships SET role='owner' WHERE user_id=?`,args:[pair.member.user.id]}));
    expect((await json(member,'/api/admin/diagnostics')).body).toEqual({ok:false,error:'global admin required'});
    await withDatabase(golden,db=>db.execute({sql:`UPDATE auth_accounts SET is_admin=1,is_demo=1 WHERE id=?`,args:[pair.member.user.id]}));
    expect((await json(member,'/api/admin/diagnostics')).status).toBe(403);
    await reloadSettled(member);
    expect((await json(member,'/api/auth/me')).body.user).toMatchObject({is_admin:true,is_demo:true});
    await expect(member.getByTestId('admin-diagnostics')).toBeHidden();
    // Other admin UI is unchanged for a demo admin.
    await member.locator('[data-tab="pair"]').click();
    await expect(member.locator('#pairDiagnostics')).toBeVisible();
    expect(memberModule).toEqual([]);
    await withDatabase(golden,db=>db.execute({sql:`UPDATE auth_accounts SET is_admin=0,is_demo=0 WHERE id=?`,args:[pair.member.user.id]}));

    // The admin's browser loads the module once the session and capability
    // settle (the positive control for the checks above), then opens Circle ›
    // Diagnostics with the keyboard.
    const ownerModule=recordModuleRequests(owner);
    await reloadSettled(owner);
    await expect.poll(()=>ownerModule.length).toBe(1);
    const diagnostics=owner.getByTestId('admin-diagnostics');
    await expect(diagnostics).toBeVisible();
    const firstLoad=owner.waitForResponse(pathIs('/api/admin/diagnostics','GET'));
    await diagnostics.locator('summary').focus();
    await owner.keyboard.press('Enter');
    const first=await (await firstLoad).json();
    await expect(owner.getByTestId('admin-diagnostics-card')).toHaveCount(6);

    // Aggregate counts and categories only: no addresses, tokens or payloads.
    const serialized=JSON.stringify(first);
    for(const secret of [pair.owner.user.email,pair.member.email,'@','payload','idempotency']) expect(serialized).not.toContain(secret);

    // Before any dispatcher run the outbox card is stale; the published pairing
    // emails are queued for the pairing type.
    await expect(card(owner,'outbox')).toHaveAttribute('data-stale','true');
    await expect(card(owner,'outbox').getByTestId('admin-diagnostics-stale')).toBeVisible();
    await expect(card(owner,'outbox')).toContainText('No dispatcher run recorded yet');
    await expect(card(owner,'outbox').getByTestId('admin-outbox-types')).toContainText('pairing.email.requested');
    await expect(card(owner,'readiness')).toHaveAttribute('data-status','healthy');
    await expect(card(owner,'readiness')).toContainText('(current)');
    await expect(card(owner,'execution')).toHaveAttribute('data-status','failed');
    await expect(card(owner,'execution')).toContainText('No execution provider is configured');
    // No member run and no smoke run: the execution card has no evidence yet.
    await expect(card(owner,'execution')).toHaveAttribute('data-stale','true');
    // The provider smoke check (#343) has not run yet.
    const smoke=card(owner,'execution').getByTestId('admin-diagnostics-smoke');
    await expect(smoke).toHaveAttribute('data-status','none');
    await expect(smoke).toHaveAttribute('data-stale','true');
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-evidence')).toHaveText('No smoke run recorded yet; expected at least every 26 h.');
    for(const id of ['outboxWatchdog','backupWatchdog']){
      await expect(card(owner,id)).toHaveAttribute('data-status','deferred');
      await expect(card(owner,id)).toContainText('GitHub Actions');
      await expect(card(owner,id).getByTestId('admin-diagnostics-stale')).toBeHidden();
    }
    await expect(card(owner,'errors')).toBeVisible();

    // Seed one smoke claim and the result saved for it, the way
    // /api/cron/execution-smoke records them (server-only runner rows).
    await withDatabase(golden,async db=>{
      const claim=await db.execute(`INSERT INTO app_logs (level,source,event,message,created_at)
        VALUES ('info','runner','execution_smoke_claim','schedule',datetime('now','-3 hours'))`);
      await db.execute({sql:`INSERT INTO app_logs (level,source,event,message,meta_json,created_at)
        VALUES ('warn','runner','execution_smoke_result',?,?,datetime('now','-3 hours'))`,
      args:[String(claim.lastInsertRowid),JSON.stringify({javascript:{status:'ok',durationMs:700},python:{status:'timeout',durationMs:45000}})]});
    });
    const seeded=await refresh(owner);
    expect(seeded.cards.execution.smoke.languages).toEqual({javascript:{status:'ok',durationMs:700},python:{status:'timeout',durationMs:45000}});
    await expect(smoke).toHaveAttribute('data-status','failed');
    await expect(smoke).toHaveAttribute('data-stale','false');
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-status')).toHaveText('Failed');
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-stale')).toBeHidden();
    await expect(card(owner,'execution')).toContainText('JavaScript: ok · Python: timed out.');
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-evidence')).toHaveText('Last smoke result 3 h ago; expected at least every 26 h.');
    // The smoke run is fresh card evidence, but an unconfigured provider keeps
    // the card failed even after a fresh smoke failure.
    await expect(card(owner,'execution')).toHaveAttribute('data-stale','false');
    await expect(card(owner,'execution')).toHaveAttribute('data-status','failed');
    await expect(card(owner,'execution')).toContainText('Last run 3 h ago');
    // Past the 26-hour cadence the smoke result is stale.
    await withDatabase(golden,db=>db.execute(`UPDATE app_logs SET created_at=datetime('now','-27 hours') WHERE event IN ('execution_smoke_claim','execution_smoke_result')`));
    await refresh(owner);
    await expect(smoke).toHaveAttribute('data-stale','true');
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-stale')).toBeVisible();
    await expect(card(owner,'execution').getByTestId('admin-diagnostics-smoke-evidence')).toHaveText('Last smoke result 27 h ago; expected at least every 26 h.');
    await expect(card(owner,'execution')).toHaveAttribute('data-stale','true');

    // A dispatcher run is fresh evidence.
    await drainOutbox(owner);
    await refresh(owner);
    await expect(card(owner,'outbox')).toHaveAttribute('data-stale','false');
    await expect(card(owner,'outbox').getByTestId('admin-diagnostics-stale')).toBeHidden();

    // Seed one dead letter the way the worker records a provider rejection.
    const eventId=await withDatabase(golden,async db=>{
      const row=(await db.execute(`SELECT id FROM outbox_events WHERE event_type='pairing.email.requested' ORDER BY id LIMIT 1`)).rows[0];
      const id=Number(row.id);
      await db.execute({sql:`UPDATE outbox_events SET status='dead_letter',delivered_at=NULL,provider_name=NULL,provider_message_id=NULL,
        last_error_code='PROVIDER_REJECTED',attempt_count=5,dead_lettered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,args:[id]});
      await db.execute({sql:`INSERT INTO outbox_audit_events (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
        VALUES (?,'dead_lettered','worker','golden-worker','processing','dead_letter','403:validation_error:domain_not_verified',5)`,args:[id]});
      return id;
    });
    await refresh(owner);
    await expect(card(owner,'outbox')).toHaveAttribute('data-status','degraded');
    await expect(card(owner,'outbox')).toContainText('domain_not_verified ×1');
    const row=owner.locator(`[data-testid="admin-dead-letter"][data-event-id="${eventId}"]`);
    await expect(row).toContainText('pairing.email.requested');
    await expect(row).toContainText('PROVIDER_REJECTED');
    await expect(row).toContainText('provider: domain_not_verified');
    await expectDiagnosticsAccessible(owner);

    // Cancelling the confirmation changes nothing.
    await owner.getByTestId('admin-replay-reason').selectOption('PROVIDER_RECOVERED');
    await row.getByTestId('admin-dead-letter-replay').focus();
    await owner.keyboard.press('Enter');
    await expect(owner.locator('#confirmTitle')).toHaveText(`Replay dead letter #${eventId}?`);
    await expect(owner.locator('#confirmMsg')).toContainText('Provider recovered');
    await owner.keyboard.press('Escape');
    await expect(owner.getByTestId('admin-diagnostics-status')).toHaveText('Replay cancelled. Nothing changed.');
    expect(await withDatabase(golden,async db=>String((await db.execute({sql:`SELECT status FROM outbox_events WHERE id=?`,args:[eventId]})).rows[0].status))).toBe('dead_letter');

    // Confirming replays through the audited endpoint with the chosen reason.
    await row.getByTestId('admin-dead-letter-replay').focus();
    await owner.keyboard.press('Enter');
    await expect(owner.locator('#confirmCancel')).toBeFocused();
    await owner.keyboard.press('Tab');
    await expect(owner.locator('#confirmOk')).toBeFocused();
    const replayed=owner.waitForResponse(pathIs('/api/admin/outbox/replay','POST'));
    const reloaded=owner.waitForResponse(pathIs('/api/admin/diagnostics','GET'));
    await owner.keyboard.press('Enter');
    const replay=await replayed;
    expect(replay.status()).toBe(200);
    expect(replay.request().postDataJSON()).toEqual({event_id:eventId,reason_code:'PROVIDER_RECOVERED'});
    await reloaded;
    await expect(owner.getByTestId('admin-diagnostics-status')).toContainText(`Event #${eventId} is queued for delivery again.`);
    await expect(row).toHaveCount(0);
    await expect(owner.getByTestId('admin-dead-letters')).toContainText('No dead letters.');
    await expect(owner.locator('#adminDeadLettersTitle')).toBeFocused();
    const audit=await withDatabase(golden,async db=>(await db.execute({
      sql:`SELECT event.status,audit.action,audit.actor_ref,audit.reason_code FROM outbox_events event
        JOIN outbox_audit_events audit ON audit.outbox_event_id=event.id WHERE event.id=? ORDER BY audit.id DESC LIMIT 1`,
      args:[eventId],
    })).rows[0]);
    expect({status:audit.status,action:audit.action,actor:audit.actor_ref,reason:audit.reason_code})
      .toEqual({status:'pending',action:'replayed',actor:`user:${pair.owner.user.id}`,reason:'PROVIDER_RECOVERED'});

    // Evidence older than the 15-minute dispatcher cadence turns the card stale.
    await withDatabase(golden,db=>db.execute(`UPDATE app_logs SET created_at=datetime('now','-30 minutes') WHERE event='outbox_invocation'`));
    await refresh(owner);
    await expect(card(owner,'outbox')).toHaveAttribute('data-stale','true');
    await expect(card(owner,'outbox').getByTestId('admin-diagnostics-stale')).toBeVisible();
    await expect(card(owner,'outbox')).toContainText('Last dispatcher run 30 min ago');

    // The related tools stay where they are and are one click away.
    await owner.getByTestId('admin-open-demo').click();
    await expect(owner.locator('#pairDiagnostics')).toHaveAttribute('open','');
    await expect(owner.locator('#pairDiagnostics > summary')).toBeFocused();

    // Turning the flag off hides the view, the script is not downloaded, and
    // the API answers like an unknown endpoint.
    process.env.ADMIN_DIAGNOSTICS_ENABLED='false';
    const flagOff=await json(owner,'/api/admin/diagnostics');
    expect(flagOff.status).toBe(404);
    expect(flagOff.body.error).toBe("unknown ops endpoint 'admin-diagnostics'");
    ownerModule.splice(0);
    await reloadSettled(owner);
    await expect(owner.getByTestId('admin-diagnostics')).toBeHidden();
    expect(ownerModule).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    for(const key of ENV_KEYS){
      if(original[key]===undefined) delete process.env[key];
      else process.env[key]=original[key] as string;
    }
  }
});
