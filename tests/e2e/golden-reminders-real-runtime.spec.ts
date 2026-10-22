import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {
  createPairedCircle,
  json,
  LOCAL_OWNER_EMAIL,
  openDashboard,
  pathIs,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Issue #287 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 14). The real
// loopback runtime runs with REMINDERS_ENABLED; reminders are queued by the
// due-check inside the production `/api/cron/outbox` handler and captured by
// the local email adapter, exactly like the other outbox mail.

const CRON_SECRET='golden-reminders-cron-secret';
const ENV_KEYS=['REMINDERS_ENABLED','REMINDERS_SESSION_SOON_ENABLED','CRON_SECRET'] as const;
type Captured={recipient_email:string;kind:string;subject:string;links:string[]};

async function drainOutbox(page:Page){
  const response=await page.evaluate(async secret=>{
    const result=await fetch('/api/cron/outbox',{method:'POST',headers:{'x-cron-secret':secret},cache:'no-store'});
    return {status:result.status,body:await result.json()};
  },CRON_SECRET);
  expect(response.status,JSON.stringify(response.body)).toBe(200);
  return response.body as {reminder_delivery:{captured?:Captured[]};outbox:{reminders_enqueued:Record<string,number>}};
}

function fixServerTime(iso:string){
  const NativeDate=globalThis.Date;
  const instant=new NativeDate(iso).getTime();
  (globalThis as typeof globalThis&{Date:DateConstructor}).Date=class FixedDate extends NativeDate{
    constructor(...args:ConstructorParameters<DateConstructor>){
      super(...(args.length?args:[instant]));
    }
    static now(){ return instant; }
  } as DateConstructor;
  return ()=>{ globalThis.Date=NativeDate; };
}

async function localInputMinutesFromNow(page:Page,minutes:number){
  return page.evaluate(offset=>{
    const when=new Date(Date.now()+offset*60_000);
    when.setSeconds(0,0);
    const pad=(value:number)=>String(value).padStart(2,'0');
    return {
      input:`${when.getFullYear()}-${pad(when.getMonth()+1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`,
      instant:when.toISOString(),
    };
  },minutes);
}

async function expectReminderRowAccessible(page:Page){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      const results=await new AxeBuilder({page}).include('#psRemindRow')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`reminder row ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
}

function expectOnlyLink(entries:Captured[],link:string){
  for(const entry of entries){
    expect(entry.links).toEqual([link]);
    expect(entry.links.join(' ')).not.toMatch(/#|token|invite|reset|verify/i);
  }
}

test('reminders: one agree-a-time nudge, a one-hour reminder, and a cutoff reminder that respects the email preference',async({browser})=>{
  test.setTimeout(150_000);
  const original=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
  process.env.REMINDERS_ENABLED='true';
  process.env.REMINDERS_SESSION_SOON_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-reminders-');
  let restoreServerTime=()=>{};
  try{
    // The local runtime clears CRON_SECRET at start; the cron route needs one.
    process.env.CRON_SECRET=CRON_SECRET;
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    const member=pair.member.page;
    const roomLink=`${golden.url}/join/${pair.room}`;

    // Nothing is due straight after pairing.
    const fresh=await drainOutbox(owner);
    expect(fresh.reminder_delivery.captured||[]).toEqual([]);

    // Seventy-three hours later, with no time agreed, both partners get one nudge.
    await withDatabase(golden,db=>db.execute(`UPDATE pairing_week_runs
      SET created_at=datetime('now','-73 hours')`));
    const nudged=await drainOutbox(owner);
    expect(nudged.outbox.reminders_enqueued.agree_time).toBe(2);
    const nudges=nudged.reminder_delivery.captured||[];
    expect(nudges.map(entry=>entry.kind)).toEqual(['reminder-agree-time','reminder-agree-time']);
    expect(nudges.map(entry=>entry.recipient_email).sort()).toEqual([LOCAL_OWNER_EMAIL,pair.member.email].sort());
    expect(nudges[0].subject).toBe('Agree a time with your Randori pair');
    expectOnlyLink(nudges,roomLink);
    // Every later run is idempotent.
    expect((await drainOutbox(owner)).reminder_delivery.captured||[]).toEqual([]);

    // The pair agrees a time 40 minutes away through the dashboard: the
    // one-hour reminder is due immediately and carries only the room link.
    await openDashboard(owner);
    const slot=await localInputMinutesFromNow(owner,40);
    await owner.getByTestId('schedule-input').fill(slot.input);
    const proposed=owner.waitForResponse(pathIs('/api/schedule','POST'));
    await owner.getByTestId('schedule-propose').click();
    expect((await proposed).status()).toBe(200);
    await openDashboard(member);
    await expect(member.getByTestId('schedule-proposal')).toHaveCount(1);
    const accepted=member.waitForResponse(pathIs('/api/schedule','POST'));
    await member.getByTestId('schedule-accept').click();
    expect((await accepted).status()).toBe(200);
    await expect(member.getByTestId('schedule-area')).toContainText('Agreed:');
    const soon=await drainOutbox(owner);
    expect(soon.outbox.reminders_enqueued.session_soon).toBe(2);
    const soonMail=soon.reminder_delivery.captured||[];
    expect(soonMail.map(entry=>entry.kind)).toEqual(['reminder-session-soon','reminder-session-soon']);
    expect(soonMail[0].subject).toBe('Your Randori session starts soon');
    expectOnlyLink(soonMail,roomLink);

    // The member reviews the reminder list under notification preferences and
    // turns email off; the list follows the Email setting.
    await member.locator('#dashProfileBtn').click();
    const types=member.getByTestId('reminder-types');
    await expect(types).toBeVisible();
    await expect(types.locator('[data-reminder]:visible')).toHaveCount(3);
    await expect(types).toContainText('Availability cutoff.');
    await expect(types).toContainText('Agree a time.');
    await expect(types).toContainText('1 hour before.');
    await expect(types.locator('[data-reminder-state]').first()).toHaveText('On');
    await expectReminderRowAccessible(member);
    const email=member.locator('#psRemindEmail');
    await expect(email).toBeEnabled();
    // Keyboard only: focus the Email control and toggle it with Space.
    await email.focus();
    const saved=member.waitForResponse(pathIs('/api/notifications/prefs','POST'));
    await member.keyboard.press('Space');
    expect((await saved).status()).toBe(200);
    await expect(email).not.toBeChecked();
    await expect(member.locator('#psRemindStatus')).toContainText('Email reminders are off');
    await expect(types.locator('[data-reminder-state]').first()).toHaveText('Off');

    // The Saturday before the cutoff, only the member who still has email on
    // and has not chosen for the next cycle gets the availability reminder.
    const availability=await json(owner,'/api/settings/availability');
    expect(availability.status,JSON.stringify(availability.body)).toBe(200);
    const cutoffAt=String(availability.body.availability.cycle.cutoffAt);
    restoreServerTime=fixServerTime(new Date(Date.parse(cutoffAt)-23*3600_000).toISOString());
    const cutoff=await drainOutbox(owner);
    restoreServerTime();
    restoreServerTime=()=>{};
    const cutoffMail=cutoff.reminder_delivery.captured||[];
    expect(cutoffMail.map(entry=>[entry.kind,entry.recipient_email])).toEqual([
      ['reminder-availability-cutoff',LOCAL_OWNER_EMAIL],
    ]);
    expect(cutoffMail[0].subject).toBe('Are you in for the next Randori cycle?');
    expectOnlyLink(cutoffMail,`${golden.url}/?view=pair`);

    // The member turns email back on but saves an explicit choice on the
    // Pairing page first: the reminder reads the same availability scope the
    // dev runtime writes, so nothing is queued for them.
    await member.locator('[data-tab="pair"]').click();
    await expect(member.getByTestId('availability-card')).toBeVisible();
    const skip=member.locator('#availSkip');
    await expect(skip).toBeEnabled();
    const decided=member.waitForResponse(pathIs('/api/settings/availability','POST'));
    await skip.click();
    expect((await decided).status()).toBe(200);
    await expect(skip).toHaveAttribute('aria-pressed','true');
    const reenabled=await json(member,'/api/notifications/prefs','POST',{email_enabled:true});
    expect(reenabled.status,JSON.stringify(reenabled.body)).toBe(200);
    restoreServerTime=fixServerTime(new Date(Date.parse(cutoffAt)-22*3600_000).toISOString());
    const decidedRun=await drainOutbox(owner);
    restoreServerTime();
    restoreServerTime=()=>{};
    expect(decidedRun.outbox.reminders_enqueued.availability_cutoff).toBe(0);
    expect(decidedRun.reminder_delivery.captured||[]).toEqual([]);

    // The stored outbox payloads never contain an address, a name, or a link.
    const payloads=await withDatabase(golden,async db=>(await db.execute(`SELECT payload_json FROM outbox_events
      WHERE event_type='reminder.email.requested'`)).rows.map(row=>String(row.payload_json)));
    expect(payloads).toHaveLength(5);
    for(const payload of payloads) expect(payload).not.toMatch(/@|http|join|Golden|Owner/i);
    expect(golden.external).toEqual([]);
  }finally{
    restoreServerTime();
    await golden.close();
    for(const [key,value] of Object.entries(original)){
      if(value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
