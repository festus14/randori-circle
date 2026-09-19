import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { expect, Page, test } from '@playwright/test';
import { deliverScheduleEmails } from '../../api/_schedule-email.js';

import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const silentLogger = Object.freeze({ log() {}, error() {} });
const memberPassword = 'member-password-123';

type Runtime = Awaited<ReturnType<typeof startLocalDevelopmentServer>>;
type SafeUser = { id: number; email: string; name: string; is_admin: boolean };
type Cycle = { cycleId: string; startsAt: string; endsAt: string; cutoffAt: string };

function createRuntimeFixture() {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'randori-real-browser-')));
  mkdirSync(join(rootDir, '.local'), { mode: 0o700 });
  copyFileSync(join(repositoryRoot, 'index.html'), join(rootDir, 'index.html'));
  const databaseUrl = pathToFileURL(join(rootDir, '.local', 'randori.sqlite')).href;
  const config = resolveLocalServerConfig({
    rootDir,
    argv: [],
    env: {
      NODE_ENV: 'development',
      RANDORI_LOCAL_HOST: '127.0.0.1',
      RANDORI_LOCAL_PORT: '0',
      RANDORI_LOCAL_DATABASE_URL: databaseUrl,
    },
  });
  return { rootDir, databaseUrl, config };
}

async function preparePage(page: Page, externalRequests: string[]) {
  page.on('request', request => {
    const target = new URL(request.url());
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  await page.route(/^https?:\/\//, route => {
    const target = new URL(route.request().url());
    if (target.protocol === 'http:' && target.hostname === '127.0.0.1') return route.continue();
    return route.abort('blockedbyclient');
  });
  await page.addInitScript(() => {
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
  });
}

async function refreshAuthenticatedState(page: Page) {
  const state = await page.evaluate(async () => {
    const app = window as typeof window & {
      _randori_auth?: { me?: SafeUser | null; refreshMe?: () => Promise<unknown> };
      _randori_availability?: {
        current?: { cycleKey?: string; version?: number };
        refresh?: () => Promise<unknown>;
      };
    };
    await app._randori_auth?.refreshMe?.();
    await app._randori_availability?.refresh?.();
    return JSON.parse(JSON.stringify({
      user: app._randori_auth?.me || null,
      availability: app._randori_availability?.current || null,
    }));
  });
  expect(state.user?.id).toEqual(expect.any(Number));
  return state as {
    user: SafeUser;
    availability: { cycleKey?: string; version?: number } | null;
  };
}

async function signInOwner(page: Page, baseUrl: string) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#landingSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await page.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
  await page.locator('#authPass').fill(LOCAL_OWNER_PASSWORD);
  const responsePromise = page.waitForResponse(response =>
    response.url() === `${baseUrl}/api/auth/login` && response.request().method() === 'POST');
  await page.locator('#authSignin').click();
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  await expect(page.locator('#meLabel')).toContainText('Local Circle Owner');
  await refreshAuthenticatedState(page);
  return payload.user as SafeUser;
}

async function createInvitation(page: Page, baseUrl: string, email: string) {
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-invite-email')).toBeVisible();
  await page.getByTestId('circle-invite-email').fill(email);
  const responsePromise = page.waitForResponse(response =>
    response.url() === `${baseUrl}/api/invitations` && response.request().method() === 'POST');
  await page.getByTestId('circle-invite-create').click();
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.status(), JSON.stringify(payload)).toBe(201);
  const inviteUrl = new URL(String(payload.invitation?.invite_url || ''), baseUrl);
  expect(inviteUrl.pathname).toBe('/invite');
  expect(inviteUrl.hash).toMatch(/^#invite=[A-Za-z0-9_-]{43}$/);
  return inviteUrl;
}

async function acceptInvitation(
  page: Page,
  baseUrl: string,
  inviteUrl: URL,
  user: { email: string; name: string },
) {
  await page.goto(inviteUrl.href, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(`${baseUrl}/invite`);
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await expect(page.getByTestId('invite-continue')).toHaveText('Create local account');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeVisible();
  await page.locator('#authEmail').fill(user.email);
  await page.locator('#authName').fill(user.name);
  await page.locator('#authPass').fill(memberPassword);
  const responsePromise = page.waitForResponse(response =>
    response.url() === `${baseUrl}/api/auth/signup` && response.request().method() === 'POST');
  await page.locator('#authSignup').click();
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.status(), JSON.stringify(payload)).toBe(200);
  await expect(page.locator('#meLabel')).toContainText(user.name);
  await refreshAuthenticatedState(page);
  return payload.user as SafeUser;
}

async function optInForUpcomingCycle(page: Page) {
  await page.locator('[data-tab="pair"]').click();
  const toggle = page.locator('#availToggle');
  await expect(page.getByTestId('availability-card')).toBeVisible();
  const initialState = await refreshAuthenticatedState(page);
  await expect(toggle).toBeEnabled();
  await expect(page.getByTestId('availability-cycle')).toContainText('Upcoming cycle starts');

  const persistViaUi = async (isAvailable: boolean) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [response] = await Promise.all([
          page.waitForResponse(candidate =>
            candidate.url().includes('/api/settings/availability')
              && candidate.request().method() === 'POST'),
          toggle.evaluate((element, desired) => {
            const input = element as HTMLInputElement;
            if (input.disabled || input.checked === desired) {
              throw new Error('availability toggle changed before click');
            }
            input.click();
          }, isAvailable),
        ]);
        const payload = await response.json();
        expect(response.status(), JSON.stringify(payload)).toBe(200);
        expect(payload.availability?.isAvailable).toBe(isAvailable);
        return payload;
      } catch (error) {
        if (!String(error).includes('availability toggle changed before click') || attempt === 2) throw error;
        await page.evaluate(async () => {
          await (window as typeof window & {
            _randori_availability?: { refresh?: () => Promise<unknown> };
          })._randori_availability?.refresh?.();
        });
        await expect(toggle).toBeEnabled();
      }
    }
    throw new Error('availability toggle did not become actionable');
  };

  // Establish a deterministic off baseline through the real endpoint. The
  // acceptance action under test is the subsequent browser checkbox opt-in;
  // bootstrap GETs can no longer restore a stale default between observation
  // and that click because the persisted source is already false.
  const current = initialState.availability;
  expect(current?.cycleKey).toMatch(/^[a-f0-9]{64}$/);
  expect(current?.version).toEqual(expect.any(Number));
  const off = await browserJson(page, '/api/settings/availability', 'POST', {
    cycle_key: current!.cycleKey,
    expected_version: current!.version,
    is_available: false,
  });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  expect((off.body as { availability?: { isAvailable?: boolean } }).availability?.isAvailable).toBe(false);
  await page.evaluate(async () => {
    await (window as typeof window & {
      _randori_availability?: { refresh?: () => Promise<unknown> };
    })._randori_availability?.refresh?.();
  });
  await expect(toggle).not.toBeChecked();
  const saved = await persistViaUi(true);
  await expect(page.locator('#availLabel')).toContainText('ON (included)');
  expect(saved.availability?.cycle?.cycleId).toMatch(/^\d{4}-W\d{2}$/);
  return JSON.parse(JSON.stringify(saved.availability?.cycle || null)) as Cycle | null;
}

async function browserJson(page: Page, path: string, method = 'GET', body?: object) {
  return page.evaluate(async input => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(input.body === undefined ? {} : {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.body),
      }),
    });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}

async function openDashboard(page: Page) {
  await page.evaluate(async () => {
    const journey = (window as typeof window & {
      _randori_journey?: { showDashboard?: () => Promise<void> };
    })._randori_journey;
    if (!journey?.showDashboard) throw new Error('dashboard journey unavailable');
    await journey.showDashboard();
  });
  await expect(page.locator('#view-dashboard')).toBeVisible();
}

async function roomSnapshot(page: Page) {
  return page.evaluate(() => {
    const state = (window as typeof window & {
      _randori_schedule?: {
        room?: string | null;
        version?: string;
        schedule?: { proposals?: unknown[]; agreed_time?: string | null } | null;
      };
    })._randori_schedule;
    return JSON.parse(JSON.stringify({
      room: state?.room || null,
      version: state?.version || '',
      schedule: state?.schedule || null,
    }));
  });
}

async function countRows(databaseUrl: string, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('unsafe table name');
  const db = createClient({ url: databaseUrl });
  try {
    const result = await db.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    return Number(result.rows[0]?.count || 0);
  } finally {
    await db.close();
  }
}

function fixServerTime(iso: string) {
  const NativeDate = globalThis.Date;
  const instant = new NativeDate(iso).getTime();
  (globalThis as typeof globalThis & { Date: DateConstructor }).Date = class FixedDate extends NativeDate {
    constructor(...args: ConstructorParameters<DateConstructor>) {
      super(...(args.length ? args : [instant]));
    }
    static now() { return instant; }
  } as DateConstructor;
  return () => { globalThis.Date = NativeDate; };
}

test('real invited members opt in, publish that cycle, share a room, and agree a schedule', async ({ browser }) => {
  test.setTimeout(120_000);
  const fixture = createRuntimeFixture();
  const requestSql: string[] = [];
  const externalRequests: string[] = [];
  let runtime: Runtime | null = null;
  let restoreServerTime = () => {};
  const contexts = await Promise.all([
    browser.newContext({ timezoneId: 'Europe/London' }),
    browser.newContext({ timezoneId: 'America/New_York' }),
    browser.newContext({ timezoneId: 'Europe/London' }),
  ]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all(pages.map(page => preparePage(page, externalRequests)));

  try {
    runtime = await startLocalDevelopmentServer({
      config: fixture.config,
      logger: silentLogger,
      sqlObserver: (sql: string) => requestSql.push(sql),
    });
    const owner = await signInOwner(pages[0], runtime.url);
    expect(owner).toMatchObject({ email: LOCAL_OWNER_EMAIL, is_admin: true });

    await pages[2].goto(runtime.url, { waitUntil: 'domcontentloaded' });
    const noInvite = await browserJson(pages[2], '/api/auth/signup', 'POST', {
      email: 'no.invite@example.test', password: memberPassword, name: 'No Invite',
    });
    expect(noInvite).toEqual({ status: 403, body: { error: 'a valid local invitation is required' } });

    const invitedEmail = 'invited.member@example.test';
    const invitation = await createInvitation(pages[0], runtime.url, invitedEmail);
    const member = await acceptInvitation(pages[1], runtime.url, invitation, {
      email: invitedEmail, name: 'Invited Member',
    });
    expect(member.is_admin).toBe(false);

    const [ownerCycle, memberCycle] = await Promise.all([
      optInForUpcomingCycle(pages[0]),
      optInForUpcomingCycle(pages[1]),
    ]);
    expect(ownerCycle).toEqual(memberCycle);
    expect(ownerCycle?.cycleId).toMatch(/^\d{4}-W\d{2}$/);
    const publicationInstant = new Date(Date.parse(ownerCycle!.startsAt) + 1_000).toISOString();
    restoreServerTime = fixServerTime(publicationInstant);

    // The cycle boundary is more than the 12-hour session lifetime away. Use
    // the real password-login endpoint again after advancing the application
    // clock instead of extending or forging either browser's session.
    const ownerRelogin = await browserJson(pages[0], '/api/auth/login', 'POST', {
      email: LOCAL_OWNER_EMAIL, password: LOCAL_OWNER_PASSWORD,
    });
    expect(ownerRelogin).toMatchObject({ status: 200, body: { user: { id: owner.id } } });
    const memberRelogin = await browserJson(pages[1], '/api/auth/login', 'POST', {
      email: invitedEmail, password: memberPassword,
    });
    expect(memberRelogin).toMatchObject({ status: 200, body: { user: { id: member.id } } });
    await Promise.all([
      refreshAuthenticatedState(pages[0]),
      refreshAuthenticatedState(pages[1]),
    ]);
    await pages[0].locator('[data-tab="pair"]').click();

    await expect(pages[1].getByRole('button', { name: 'Run current cycle' })).toBeHidden();
    const denied = await browserJson(pages[1], '/api/pairing/run', 'POST', {});
    expect(denied).toEqual({ status: 403, body: { error: 'primary circle owner required' } });

    const faultClient = createClient({ url: fixture.databaseUrl });
    try {
      const outboxBeforePublication = await countRows(fixture.databaseUrl, 'outbox_events');
      expect(outboxBeforePublication).toBe(1, 'the consumed invitation email remains durable until its worker runs');
      await faultClient.execute(`CREATE TRIGGER reject_pairing_outbox
        BEFORE INSERT ON outbox_events BEGIN
          SELECT RAISE(ABORT,'injected publication failure');
        END`);
      const failedResponse = pages[0].waitForResponse(response =>
        response.url().endsWith('/api/pairing/run') && response.request().method() === 'POST');
      await pages[0].getByRole('button', { name: 'Run current cycle' }).click();
      const failed = await failedResponse;
      expect(failed.status()).toBe(503);
      expect(await failed.json()).toEqual({ error: 'pairing unavailable' });
      for (const table of ['pairing_week_runs', 'pairing_groups', 'pairing_participants']) {
        expect(await countRows(fixture.databaseUrl, table), table).toBe(0);
      }
      expect(await countRows(fixture.databaseUrl, 'outbox_events')).toBe(outboxBeforePublication);
      await faultClient.execute('DROP TRIGGER reject_pairing_outbox');
    } finally {
      await faultClient.close();
    }

    const publishedResponse = pages[0].waitForResponse(response =>
      response.url().endsWith('/api/pairing/run') && response.request().method() === 'POST');
    await pages[0].getByRole('button', { name: 'Run current cycle' }).click();
    const published = await publishedResponse;
    const publication = await published.json();
    expect(published.status(), JSON.stringify(publication)).toBe(200);
    expect(publication).toMatchObject({
      ok: true,
      created: true,
      cycle: { cycleId: ownerCycle!.cycleId },
      participant_count: 2,
      pair_count: 1,
      solo_count: 0,
      email_delivery: { sent: 0, failed: 0, exhausted: 0, pending: 0, suppressed: 0 },
    });
    expect(publication.email_delivery.captured).toHaveLength(2);
    const publicationOutbox = createClient({ url: fixture.databaseUrl });
    expect(Number((await publicationOutbox.execute(`SELECT COUNT(*) AS count FROM outbox_events
      WHERE event_type='pairing.email.requested'`)).rows[0].count)).toBe(2);
    await publicationOutbox.close();
    expect(await countRows(fixture.databaseUrl, 'pairing_email_outbox')).toBe(0);

    await Promise.all(pages.slice(0, 2).map(page => page.clock.setFixedTime(publicationInstant)));
    await Promise.all([openDashboard(pages[0]), openDashboard(pages[1])]);
    await expect(pages[0].locator('#dashPairArea')).toContainText('Invited Member');
    await expect(pages[1].locator('#dashPairArea')).toContainText('Local Circle Owner');
    for (const page of pages.slice(0, 2)) {
      await expect.poll(() => roomSnapshot(page)).toMatchObject({
        room: expect.stringMatching(/^week_[1-9]\d*_pair_[1-9]\d*$/),
        version: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    }
    const ownerRoom = (await roomSnapshot(pages[0])).room;
    expect((await roomSnapshot(pages[1])).room).toBe(ownerRoom);

    await pages[0].getByTestId('schedule-input').fill('2030-10-06T18:30');
    await pages[0].getByTestId('schedule-propose').click();
    await expect.poll(async () => (await roomSnapshot(pages[0])).schedule?.proposals?.length).toBe(1);
    await openDashboard(pages[1]);
    await expect.poll(async () => (await roomSnapshot(pages[1])).schedule?.proposals?.length).toBe(1);
    await pages[1].getByTestId('schedule-accept').click();
    await expect.poll(async () => (await roomSnapshot(pages[1])).schedule?.agreed_time)
      .toMatch(/^2030-10-06T/);
    const agreedTime = (await roomSnapshot(pages[1])).schedule?.agreed_time;
    await openDashboard(pages[0]);
    await expect.poll(async () => (await roomSnapshot(pages[0])).schedule?.agreed_time).toBe(agreedTime);

    const scheduleOutbox = createClient({ url: fixture.databaseUrl });
    const capturedScheduleEmails: Array<{ to: string; subject: string; html: string; idempotencyKey: string }> = [];
    try {
      const immediate = await deliverScheduleEmails({
        db: scheduleOutbox,
        baseUrl: runtime.url,
        localRuntime: true,
        workerId: 'browser-schedule-immediate',
        send: async message => {
          capturedScheduleEmails.push(message);
          return { providerName: 'local-capture', providerMessageId: `schedule-${capturedScheduleEmails.length}` };
        },
        workerOptions: { heartbeatIntervalMs: 0, leaseDurationMs: 1_000 },
      });
      expect(immediate.delivered).toBe(3);
      expect(capturedScheduleEmails.map(message => message.to).sort()).toEqual([
        LOCAL_OWNER_EMAIL, invitedEmail, invitedEmail,
      ].sort());
      expect(capturedScheduleEmails.some(message => message.subject.includes('proposed'))).toBe(true);
      expect(capturedScheduleEmails.filter(message => message.subject.includes('scheduled'))).toHaveLength(2);
      expect(capturedScheduleEmails.every(message => message.html.includes(`/join/${ownerRoom}`))).toBe(true);
      expect(capturedScheduleEmails.every(message => !message.idempotencyKey.includes('@'))).toBe(true);

      await scheduleOutbox.execute(`UPDATE outbox_events
        SET not_before=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE event_type='schedule.email.requested' AND json_extract(payload_json,'$.kind')='reminder'`);
      const reminder = await deliverScheduleEmails({
        db: scheduleOutbox,
        baseUrl: runtime.url,
        localRuntime: true,
        workerId: 'browser-schedule-reminder',
        send: async message => {
          capturedScheduleEmails.push(message);
          return { providerName: 'local-capture', providerMessageId: `schedule-${capturedScheduleEmails.length}` };
        },
        workerOptions: { heartbeatIntervalMs: 0, leaseDurationMs: 1_000 },
      });
      expect(reminder.delivered).toBe(2);
      expect(capturedScheduleEmails.filter(message => message.subject.includes('Reminder'))).toHaveLength(2);
    } finally {
      await scheduleOutbox.close();
    }

    const repeat = await browserJson(pages[0], '/api/pairing/run', 'POST', {});
    expect(repeat).toMatchObject({ status: 200, body: { ok: true, created: false, skipped: true } });
    const cycleOutbox = createClient({ url: fixture.databaseUrl });
    expect(Number((await cycleOutbox.execute(`SELECT COUNT(*) AS count FROM outbox_events
      WHERE event_type IN ('pairing.email.requested','schedule.email.requested')`)).rows[0].count)).toBe(7);
    await cycleOutbox.close();

    const laterEmail = 'later.member@example.test';
    const laterInvitation = await createInvitation(pages[0], runtime.url, laterEmail);
    const laterMember = await acceptInvitation(pages[2], runtime.url, laterInvitation, {
      email: laterEmail, name: 'Later Member',
    });
    expect(laterMember.is_admin).toBe(false);
    const laterSession = (await contexts[2].cookies(runtime.url))
      .find(cookie => cookie.name === 'randori_session');
    expect(laterSession).toBeDefined();
    const preservedSessionCookie = `${laterSession!.name}=${laterSession!.value}`;
    await pages[2].clock.setFixedTime(publicationInstant);
    await openDashboard(pages[2]);
    await expect(pages[2].getByTestId('dashboard-pair-state')).toHaveAttribute('data-state', 'missed');

    // Keep the account and browser session real, then simulate an owner/admin
    // revocation to prove authorization is rechecked independently of the
    // already published participant ledger.
    const revocationClient = createClient({ url: fixture.databaseUrl });
    try {
      const revoked = await revocationClient.execute({
        sql: `UPDATE circle_memberships SET status='inactive'
          WHERE user_id=? AND status='active'`,
        args: [laterMember.id],
      });
      expect(revoked.rowsAffected).toBe(1);
    } finally {
      await revocationClient.close();
    }
    // Use a preserved copy of the real HttpOnly cookie so a background
    // /auth/me refresh cannot turn this into a weaker anonymous-only check.
    const requestWithPreservedSession = async (path: string) => {
      const response = await fetch(new URL(path, runtime!.url), {
        headers: { cookie: preservedSessionCookie },
      });
      return { status: response.status, body: await response.json() };
    };
    const roomAccess = await requestWithPreservedSession(
      `/api/schedule?room_id=${encodeURIComponent(String(ownerRoom))}`,
    );
    expect(roomAccess).toEqual({ status: 401, body: { error: 'authentication required' } });
    const revokedCircle = await requestWithPreservedSession('/api/circle');
    expect(revokedCircle).toEqual({ status: 401, body: { error: 'authentication required' } });
    expect((await roomSnapshot(pages[2])).room).toBeNull();

    const outbox = createClient({ url: fixture.databaseUrl });
    const reminders = await outbox.execute(`SELECT event_type,status,attempt_count,provider_message_id
      FROM outbox_events
      WHERE event_type IN ('pairing.email.requested','schedule.email.requested') ORDER BY id`);
    await outbox.close();
    expect(reminders.rows).toHaveLength(7);
    expect(reminders.rows.every(row => row.status === 'delivered' && Number(row.attempt_count) === 1)).toBe(true);
    expect(reminders.rows.filter(row => row.event_type === 'pairing.email.requested')
      .every(row => /^local-[0-9a-f-]{36}$/.test(String(row.provider_message_id)))).toBe(true);
    expect(reminders.rows.filter(row => row.event_type === 'schedule.email.requested')
      .every(row => /^schedule-[1-5]$/.test(String(row.provider_message_id)))).toBe(true);
    expect(requestSql.filter(sql => /^\s*(?:CREATE|ALTER|DROP)\b/iu.test(sql))).toEqual([]);
    expect(externalRequests).toEqual([]);
  } finally {
    restoreServerTime();
    await runtime?.close();
    await Promise.all(contexts.map(context => context.close()));
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});
