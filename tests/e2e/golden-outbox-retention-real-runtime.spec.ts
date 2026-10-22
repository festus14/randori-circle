import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  createPairedCircle,
  json,
  pathIs,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Issue #341 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 23, ID-83). The
// real loopback runtime runs with OUTBOX_PII_RETENTION_ENABLED and
// ADMIN_DIAGNOSTICS_ENABLED. The invitation, activation and pairing emails of a
// new pair are delivered by the production `/api/cron/outbox`; once they are
// past their window (aged in the database) the next run removes every
// recipient address and sealed credential while keys, statuses and the audit
// trail stay. In Circle › Diagnostics the global admin sees the redacted dead
// letter marked as such with Replay disabled, and the endpoint refuses it.
// With the flag off the cron leaves old rows alone and its response is
// unchanged.

const CRON_SECRET='golden-outbox-retention-cron-secret';
const ENV_KEYS=['OUTBOX_PII_RETENTION_ENABLED','ADMIN_DIAGNOSTICS_ENABLED','CRON_SECRET'] as const;
const PII_TYPES=['pairing.email.requested','invitation.email.requested','auth.emailverification.requested',
  'auth.passwordreset.requested'];
const PII_PRESENT=`(json_type(payload_json,'$.recipient_email') IS NOT NULL
  OR json_type(payload_json,'$.credential_envelope') IS NOT NULL
  OR json_type(payload_json,'$.token_envelope') IS NOT NULL
  OR json_type(payload_json,'$.email_hash') IS NOT NULL)`;
const REDACTED_SUMMARY='recipient details removed by retention; cannot be replayed';

async function drainOutbox(page:Page){
  const response=await page.evaluate(async secret=>{
    const result=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});
    return {status:result.status,body:await result.json()};
  },CRON_SECRET);
  expect(response.status).toBe(200);
  return response.body;
}

/** Re-opens the hourly retention claim, as an hour passing would. */
async function anHourPasses(golden:Awaited<ReturnType<typeof startGoldenRuntime>>){
  await withDatabase(golden,db=>db.execute(
    `UPDATE app_logs SET created_at=datetime(created_at,'-61 minutes') WHERE event='outbox_pii_retention'`));
}

async function reloadSettled(page:Page){
  const capabilities=page.waitForResponse(pathIs('/api/auth/capabilities','GET'));
  const me=page.waitForResponse(pathIs('/api/auth/me','GET'));
  await page.reload({waitUntil:'domcontentloaded'});
  await Promise.all([capabilities,me]);
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#view-circle')).toBeVisible();
  await expect(page.locator('#peopleList')).toHaveAttribute('aria-busy','false');
}

test('outbox retention: old recipient details are removed, keys and audit stay, and a redacted dead letter cannot be replayed',async({browser})=>{
  test.setTimeout(180_000);
  const original=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  process.env.OUTBOX_PII_RETENTION_ENABLED='true';
  process.env.ADMIN_DIAGNOSTICS_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-outbox-retention-');
  try{
    // The local runtime clears CRON_SECRET at start; the cron route needs one.
    process.env.CRON_SECRET=CRON_SECRET;
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    expect(pair.owner.user.is_admin).toBe(true);

    // Fresh mail is delivered and kept: nothing is old enough yet.
    const first=await drainOutbox(owner);
    expect(first.outbox.outbox_pii_retention).toEqual({ran:true,more:false,
      redacted:{delivered:0,suppressed:0,dead_letter:0,legacy_pairing:0}});
    const delivered=await withDatabase(golden,async db=>(await db.execute(
      `SELECT id,event_type,idempotency_key,status FROM outbox_events ORDER BY id`)).rows
      .map(row=>({id:Number(row.id),type:String(row.event_type),key:String(row.idempotency_key),status:String(row.status)})));
    // Two pairing emails were delivered; the invitation email was suppressed
    // because the member had already used the link.
    expect(delivered.filter(row=>row.type==='pairing.email.requested'&&row.status==='delivered').length).toBe(2);
    expect(delivered.every(row=>['delivered','suppressed'].includes(row.status))).toBe(true);
    const withAddress=await withDatabase(golden,async db=>Number((await db.execute(
      `SELECT COUNT(*) AS c FROM outbox_events WHERE payload_json LIKE '%@%'`)).rows[0].c));
    expect(withAddress).toBeGreaterThan(0);

    // Age everything past its window: the owner's pairing email becomes a
    // provider-rejected dead letter 31 days old, the rest finished 8 days ago.
    const deadId=delivered.find(row=>row.type==='pairing.email.requested')!.id;
    const expected=await withDatabase(golden,async db=>{
      await db.execute({sql:`UPDATE outbox_events SET status='dead_letter',delivered_at=NULL,provider_name=NULL,
        provider_message_id=NULL,last_error_code='PROVIDER_REJECTED',attempt_count=5,
        dead_lettered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days'),
        next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days') WHERE id=?`,args:[deadId]});
      await db.execute({sql:`INSERT INTO outbox_audit_events (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
        VALUES (?,'dead_lettered','worker','golden-worker','processing','dead_letter','403:validation_error:domain_not_verified',5)`,args:[deadId]});
      await db.execute(`UPDATE outbox_events SET
        delivered_at=CASE WHEN status='delivered' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') ELSE delivered_at END,
        next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days') WHERE status IN ('delivered','suppressed')`);
      const count=async(status:string)=>Number((await db.execute({sql:`SELECT COUNT(*) AS c FROM outbox_events WHERE status=?
        AND event_type IN (${PII_TYPES.map(()=>'?').join(',')}) AND ${PII_PRESENT}`,args:[status,...PII_TYPES]})).rows[0].c);
      return {delivered:await count('delivered'),suppressed:await count('suppressed')};
    });
    expect(expected.delivered).toBe(1);
    expect(expected.suppressed).toBe(1);
    await anHourPasses(golden);

    const second=await drainOutbox(owner);
    expect(second.outbox.outbox_pii_retention).toEqual({ran:true,more:false,
      redacted:{...expected,dead_letter:1,legacy_pairing:0}});
    expect(JSON.stringify(second.outbox)).not.toContain('@');
    const after=await withDatabase(golden,async db=>({
      rows:(await db.execute(`SELECT id,event_type,idempotency_key,status,payload_json FROM outbox_events ORDER BY id`)).rows,
      logged:JSON.parse(String((await db.execute(`SELECT meta_json FROM app_logs WHERE event='outbox_invocation'
        ORDER BY id DESC LIMIT 1`)).rows[0].meta_json)),
    }));
    // No address or sealed credential is left; keys, types and statuses are unchanged.
    for(const row of after.rows){
      expect(String(row.payload_json)).not.toContain('@');
      expect(String(row.payload_json)).not.toMatch(/envelope|_hash/);
    }
    expect(after.rows.map(row=>String(row.idempotency_key))).toEqual(delivered.map(row=>row.key));
    expect(after.rows.map(row=>String(row.event_type))).toEqual(delivered.map(row=>row.type));
    const deadPayload=JSON.parse(String(after.rows.find(row=>Number(row.id)===deadId)!.payload_json));
    expect(deadPayload).toMatchObject({kind:'paired',retention_redacted:1});
    expect(deadPayload.week_id).toEqual(expect.any(Number));
    expect(after.logged.outbox_pii_retention).toEqual(second.outbox.outbox_pii_retention);

    // The admin still sees the dead letter with its provider reason, marked as
    // redacted with Replay disabled; the endpoint itself refuses it too.
    await reloadSettled(owner);
    const diagnostics=owner.getByTestId('admin-diagnostics');
    await expect(diagnostics).toBeVisible();
    const firstLoad=owner.waitForResponse(pathIs('/api/admin/diagnostics','GET'));
    await diagnostics.locator('summary').focus();
    await owner.keyboard.press('Enter');
    const snapshot=await (await firstLoad).json();
    expect(snapshot.cards.deadLetters.items.find((item:{id:number})=>item.id===deadId)).toMatchObject({redacted:true});
    const row=owner.locator(`[data-testid="admin-dead-letter"][data-event-id="${deadId}"]`);
    await expect(row).toContainText('pairing.email.requested');
    await expect(row).toContainText('provider: domain_not_verified');
    await expect(row).toContainText(REDACTED_SUMMARY);
    const replayButton=row.getByTestId('admin-dead-letter-replay');
    await expect(replayButton).toBeDisabled();
    await expect(replayButton).toHaveAttribute('aria-label',`Replay event #${deadId} unavailable: recipient details removed`);
    const replay=await json(owner,'/api/admin/outbox/replay','POST',{event_id:deadId,reason_code:'OPERATOR_RETRY'});
    expect(replay).toEqual({status:409,body:{error:'event is not replayable: retention removed its recipient details',
      code:'outbox_event_redacted'}});
    await expect(row).toBeVisible();
    const state=await withDatabase(golden,async db=>({
      status:String((await db.execute({sql:`SELECT status FROM outbox_events WHERE id=?`,args:[deadId]})).rows[0].status),
      replays:Number((await db.execute({sql:`SELECT COUNT(*) AS c FROM outbox_audit_events WHERE outbox_event_id=? AND action='replayed'`,
        args:[deadId]})).rows[0].c),
    }));
    expect(state).toEqual({status:'dead_letter',replays:0});
    for(const light of [false,true]){
      const isLight=await owner.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await owner.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      const results=await new AxeBuilder({page:owner}).include('#adminDiagnostics')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`diagnostics ${light?'light':'dark'}`).toEqual([]);
    }

    // Flag off: an old row with an address is left alone and the cron
    // response has no retention entry.
    process.env.OUTBOX_PII_RETENTION_ENABLED='false';
    const keptId=await withDatabase(golden,async db=>Number((await db.execute(`INSERT INTO outbox_events
      (event_type,event_version,idempotency_key,payload_json,status,not_before,next_attempt_at,attempt_count,max_attempts,
       delivery_timeout_ms,provider_name,delivered_at,created_at,updated_at)
      VALUES ('pairing.email.requested',1,'randori/999/paired/999',
        json_object('week_id',999,'user_id',999,'kind','paired','recipient_email','kept@example.test'),'delivered',
        strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'),1,5,10000,
        'local-capture',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 days')) RETURNING id`)).rows[0].id));
    await anHourPasses(golden);
    const third=await drainOutbox(owner);
    expect(Object.keys(third.outbox)).not.toContain('outbox_pii_retention');
    const kept=await withDatabase(golden,async db=>({
      payload:JSON.parse(String((await db.execute({sql:`SELECT payload_json FROM outbox_events WHERE id=?`,args:[keptId]})).rows[0].payload_json)),
      runs:Number((await db.execute(`SELECT COUNT(*) AS c FROM app_logs WHERE event='outbox_pii_retention'`)).rows[0].c),
    }));
    expect(kept.payload.recipient_email).toBe('kept@example.test');
    expect(kept.runs).toBe(2);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
    for(const key of ENV_KEYS){
      if(original[key]===undefined) delete process.env[key];
      else process.env[key]=original[key] as string;
    }
  }
});
