import { expect, Page, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const user = {
  id: 1,
  email: 'owner@example.test',
  name: 'Circle Owner',
  display_name: 'Circle Owner',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const currentWeek = {
  id: 20,
  week_label: '2026-W38',
  week_start: '2026-09-13T07:00:00.000Z',
  focus: 'both',
  is_demo: false,
  is_current: true,
  pairs: [{
    pg_id: 30,
    week_id: 20,
    a_id: 1,
    b_id: 2,
    a_name: 'Current Owner',
    b_name: 'Current Partner',
    a_color: '#c8f6a0',
    b_color: '#9cc0b5',
    is_ai: false,
    topic: 'Pick together',
    topic_kind: 'both',
  }],
};

const futureWeek = {
  ...currentWeek,
  id: 99,
  week_label: '2099-W52',
  week_start: '2099-12-27T08:00:00.000Z',
  is_current: false,
  pairs: [{ ...currentWeek.pairs[0], pg_id: 99, week_id: 99, a_name: 'Future Pair' }],
};

function circle(role: 'owner' | 'member') {
  return {
    ok: true,
    circle_meta: { id: 1, public_id: 'circle_e2e', name: 'E2E Circle' },
    membership: { role },
    circle: [user],
    count: 1,
  };
}

function cycleWindow(kind: 'current' | 'future' | 'stale' = 'current') {
  const now = Date.now();
  const startsAt = kind === 'future' ? now + 86_400_000 : now - (kind === 'stale' ? 8 : 1) * 86_400_000;
  const endsAt = startsAt + 7 * 86_400_000;
  return {
    cycleId: kind === 'current' ? '2026-W38' : kind === 'future' ? '2099-W52' : '2026-W37',
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    cutoffAt: new Date(startsAt).toISOString(),
    timeZone: 'Europe/London',
    state: kind === 'future' ? 'upcoming' : 'current',
  };
}

function upcomingAfter(current: ReturnType<typeof cycleWindow>) {
  const startsAt = current.endsAt;
  return {
    cycleId: '2026-W39',
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 7 * 86_400_000).toISOString(),
    cutoffAt: startsAt,
    timeZone: current.timeZone,
    state: 'upcoming',
  };
}

const publicationCycleKey='a'.repeat(64);

function publicationState(
  cycle: ReturnType<typeof cycleWindow>,
  state: 'pending' | 'overdue' | 'published',
  owner = false,
  observedAt?: number,
) {
  const scheduled=Date.parse(cycle.cutoffAt);
  const recovery=scheduled+30*60*1000;
  const observed=observedAt??(state==='pending'?scheduled+5*60*1000:recovery);
  return {
    state,
    cycle_key:publicationCycleKey,
    observed_at:new Date(observed).toISOString(),
    scheduled_at:new Date(scheduled).toISOString(),
    recovery_at:new Date(recovery).toISOString(),
    published_at:state==='published'?new Date(observed).toISOString():null,
    ...(owner?{can_publish_now:state==='overdue'}:{}),
  };
}

function dashboardPair(options: {
  solo?: boolean;
  cycle?: ReturnType<typeof cycleWindow>;
  partnerName?: string;
  weekId?: number;
  pairId?: number;
  partnerId?: number;
} = {}) {
  const cycle = options.cycle || cycleWindow();
  const solo = options.solo === true;
  const weekId = options.weekId || 20;
  const pairId = options.pairId || 30;
  const partnerId = options.partnerId || 2;
  const roomId = `week_${weekId}_pair_${pairId}`;
  return {
    ok: true,
    paired: true,
    pairing_status: solo ? 'solo' : 'paired',
    cycle,
    current_cycle: cycle,
    upcoming_cycle: upcomingAfter(cycle),
    room_id: roomId,
    week_id: weekId,
    week: { id: weekId, week_label: cycle.cycleId, week_start: cycle.startsAt, focus: 'both' },
    pair: {
      pg_id: pairId, week_id: weekId, room_id: roomId, user_a_id: 1,
      user_b_id: solo ? 1 : partnerId, user_c_id: null, is_ai_pair: solo, is_ai: solo,
      solo_practice: solo, topic: 'Pick together', topic_kind: 'both',
    },
    partner: solo
      ? { id: null, name: 'Solo practice', solo_practice: true, is_ai: true }
      : { id: partnerId, name: options.partnerName || 'Current Partner', color: '#9cc0b5', tz: 'UTC', interview_focus: 'both' },
    partners: [],
    me: user,
    schedule: null,
  };
}

async function openDashboard(
  page: Page,
  pairResponse: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>),
  circleResponse: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>) = circle('member'),
) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/circle': circleResponse,
    '/api/my-pair': pairResponse,
    '/api/messages': request => {
      const url = new URL(request.url());
      return {
        ok: true,
        room_id: url.searchParams.get('room_id'),
        messages: [],
        after: Number(url.searchParams.get('after_id') || 0),
      };
    },
  });
  await resetClientState(page, true, {
    'randori-last-room': 'week_3_pair_4',
    'randori-last-my-pair': JSON.stringify({ week_id: 3, pair: { pg_id: 4 }, partner: { name: 'Stale Partner' } }),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
}

test('the owner recovers an overdue cycle and then sees only the published server week', async ({ page }) => {
  let pairingRuns = 0;
  const currentCycle=cycleWindow();
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle('owner'),
    '/api/weeks': () => ({
      ok:true,current_cycle:currentCycle,upcoming_cycle:upcomingAfter(currentCycle),
      current_week_id:pairingRuns?20:null,weeks:pairingRuns?[futureWeek,currentWeek]:[],
      publication_state:publicationState(currentCycle,pairingRuns?'published':'overdue',true),
    }),
    '/api/pairing/run': request => {
      pairingRuns += 1;
      expect(request.postDataJSON()).toEqual({expected_cycle_key:publicationCycleKey});
      return {
        ok: true,
        created: true,
        skipped: false,
        week_label: '2026-W38',
        week_id: 20,
        count: 2,
        pairs: [],
        cycle:currentCycle,
        publication_state:publicationState(currentCycle,'published',true),
        message: 'Current-cycle pairings published.',
      };
    },
  });
  await resetClientState(page, true, {
    'randori-weeks': JSON.stringify([{
      id: 'fake-local', label: 'Fake local week', date: '2098-01-01T00:00:00.000Z',
      pairs: [{ id: 'fake-room', aId: 'a', bId: 'b', isAI: false }],
    }]),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#pairsList')).toContainText('scheduled run did not publish');
  await expect(page.locator('#pairsList')).not.toContainText('Fake local week');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Remix' })).toHaveCount(0);

  const runButton = page.locator('#newWeekBtn');
  await expect(runButton).toHaveText('Publish now');
  await expect(runButton).toBeVisible();
  await runButton.click();
  await expect.poll(() => pairingRuns).toBe(1);
  await expect(page.locator('#pairsList')).toContainText('Current Partner');
  await expect(page.locator('#pairsList')).not.toContainText('Future Pair');
  await expect(runButton).toBeHidden();

  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#roomSelect')).toHaveValue('week_20_pair_30');
  await expect(page.locator('#roomSelect')).not.toContainText('fake-room');
});

test('a signed-in member never sees stale or local fallback pairs as this week', async ({ page }) => {
  const currentCycle=cycleWindow();
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle('member'),
    '/api/weeks': {
      ok: true,
      current_cycle: currentCycle,
      upcoming_cycle: upcomingAfter(currentCycle),
      current_week_id: null,
      weeks: [futureWeek, { ...currentWeek, is_current: false, week_label: '2026-W37' }],
    },
  });
  await resetClientState(page, true, {
    'randori-weeks': JSON.stringify([{
      id: 'fake-local', label: 'Fake local week', date: '2098-01-01T00:00:00.000Z',
      pairs: [{ id: 'fake-room', aId: 'a', bId: null, isAI: true }],
    }]),
    'randori-people': JSON.stringify([{ id: 'a', name: 'Fake Local Person', color: '#ffffff' }]),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#currentWeekMeta')).toContainText('awaiting current-cycle publication');
  await expect(page.locator('#pairsList')).toContainText('No pairings have been published for the current cycle');
  await expect(page.locator('#pairsList')).not.toContainText('Future Pair');
  await expect(page.locator('#pairsList')).not.toContainText('Fake Local Person');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#roomSelect')).toContainText('No current-cycle room');
  await expect(page.locator('#newWeekBtn')).toBeHidden();

  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#roomSelect')).toContainText('No current-cycle room');
  await expect(page.locator('#roomSelect')).not.toContainText('fake-room');
});

for(const kind of ['stale','future'] as const){
  test(`Pairing rejects a server-marked current week with ${kind} cycle boundaries`,async({page})=>{
    const cycle=cycleWindow(kind);
    await mockApi(page,{
      '/api/auth/me':{ok:true,user},
      '/api/circle':circle('member'),
      '/api/weeks':{
        ok:true,current_cycle:cycle,upcoming_cycle:upcomingAfter(cycle),current_week_id:20,
        weeks:[{...currentWeek,week_label:cycle.cycleId,week_start:cycle.startsAt}],
      },
    });
    await resetClientState(page,true,{'randori-last-room':'week_3_pair_4'});
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{
      const app=window as typeof window&{_randori_authorized_room?:string;currentRoom?:string};
      app._randori_authorized_room='week_3_pair_4'; app.currentRoom='week_3_pair_4';
    });
    await page.locator('[data-tab="pair"]').click();

    await expect(page.locator('#currentWeekMeta')).toContainText(kind==='stale'?'ended':'not started');
    await expect(page.locator('#pairsList')).not.toContainText('Current Partner');
    await expect(page.locator('#roomSelect')).toHaveValue('');
    expect(await page.evaluate(()=>localStorage.getItem('randori-last-room'))).toBeNull();
  });
}

test('Pairing failure revokes a previously authorized live-room fallback',async({page})=>{
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},
    '/api/circle':circle('member'),
    '/api/weeks':{_status:503,ok:false,error:'pairing unavailable'},
  });
  await resetClientState(page,true,{'randori-last-room':'week_3_pair_4'});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{
    const app=window as typeof window&{_randori_authorized_room?:string;currentRoom?:string};
    app._randori_authorized_room='week_3_pair_4'; app.currentRoom='week_3_pair_4';
  });
  await page.locator('[data-tab="pair"]').click();

  await expect(page.locator('#pairsList')).toContainText('Local or cached pairs are not shown');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#roomSelect')).not.toContainText('Authorized pairing room');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_authorized_room?:string|null})._randori_authorized_room||null)).toBeNull();
  expect(await page.evaluate(()=>localStorage.getItem('randori-last-room'))).toBeNull();
});

test('the home countdown uses the server cycle boundary instead of a fixed UTC hour',async({page})=>{
  await mockApi(page,{
    '/api/stats':{
      ok:true,total_users:0,total_weeks:0,total_pairs:0,total_sessions:0,
      next_cycle:{
        cycleId:'2099-W44',startsAt:'2099-10-31T19:00:00.000Z',endsAt:'2099-11-07T19:00:00.000Z',
        cutoffAt:'2099-10-31T19:00:00.000Z',timeZone:'Pacific/Auckland',state:'upcoming',
      },
      next_shuffle_utc:'2099-10-31T19:00:00.000Z',
      next_shuffle_label:'server fallback should not win',
    },
  });
  await resetClientState(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  await expect(page.locator('#landingNextLabel')).toContainText('2099-W44');
  await expect(page.locator('#landingNextLabel')).not.toContainText('London');
  await expect(page.locator('#landingNextCountdown')).toHaveText(/^\d{4,}d \d+h to pairing$/);
});

test('client cycle classification uses half-open start and end boundaries',async({page})=>{
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const states=await page.evaluate(()=>{
    const cycle={
      cycleId:'2026-W38',startsAt:'2026-09-20T07:00:00.000Z',endsAt:'2026-09-27T07:00:00.000Z',
      cutoffAt:'2026-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'current',
    };
    const classify=(window as typeof window&{_randori_cycle_ui:{classify:(cycle:unknown,now:number)=>string}})._randori_cycle_ui.classify;
    return [
      classify(cycle,Date.parse(cycle.startsAt)-1),
      classify(cycle,Date.parse(cycle.startsAt)),
      classify(cycle,Date.parse(cycle.endsAt)-1),
      classify(cycle,Date.parse(cycle.endsAt)),
    ];
  });
  expect(states).toEqual(['future','current','current','stale']);
});

for (const fixture of [
  { status: 'unpublished', title: 'Current pairing is not published yet' },
  { status: 'unavailable', title: 'Unavailable for this cycle' },
  { status: 'missed', title: "Not in this cycle's snapshot" },
] as const) {
  test(`dashboard renders the durable ${fixture.status} state with safe solo practice`, async ({ page }) => {
    const current = cycleWindow();
    await openDashboard(page, {
      ok: true,
      paired: false,
      pairing_status: fixture.status,
      reason: `${fixture.status}_current_cycle`,
      current_cycle: current,
      upcoming_cycle: upcomingAfter(current),
    });

    const state = page.getByTestId('dashboard-pair-state');
    await expect(state).toBeVisible();
    await expect(state).toHaveAttribute('data-state', fixture.status);
    await expect(state).toContainText(fixture.title);
    await expect(page.locator('#dashPairArea')).not.toContainText('Stale Partner');
    await expect(page.locator('#roomSelect')).toHaveValue('');
    await expect(page.locator('#roomSelect')).not.toContainText('week_3_pair_4');
    expect(await page.evaluate(() => (window as typeof window & { _randori_authorized_room?: string | null })._randori_authorized_room || null)).toBeNull();

    await page.getByRole('button', { name: 'Practice solo from catalogue' }).click();
    await expect(page.locator('#view-code')).toBeVisible();
    await expect(page.locator('#roomSelect')).toHaveValue('');
    await expect(page.locator('#roomSelect')).not.toContainText('week_3_pair_4');
  });
}

test('dashboard gives owners and members truthful pending and overdue recovery states',async({page})=>{
  const current=cycleWindow();
  let state:'pending'|'overdue'='pending';
  let role:'owner'|'member'='owner';
  await openDashboard(page,()=>({
    ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
    current_cycle:current,upcoming_cycle:upcomingAfter(current),
    publication_state:publicationState(current,state,role==='owner'),
  }),()=>circle(role));

  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','pending');
  await expect(page.getByTestId('dashboard-pair-state')).toContainText('scheduled');
  await expect(page.getByTestId('dashboard-publish-now')).toBeHidden();

  state='overdue'; role='member';
  await page.evaluate(async()=>{
    await (window as typeof window&{_randori_journey:{showDashboard:()=>Promise<void>}})._randori_journey.showDashboard();
  });
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','overdue');
  await expect(page.getByTestId('dashboard-pair-state')).toContainText('circle owner can retry');
  await expect(page.getByTestId('dashboard-publish-now')).toBeHidden();
});

test('a pending dashboard refetches automatically when the server grace expires',async({page})=>{
  await page.clock.install({time:Date.now()});
  const current=cycleWindow();
  const recovery=Date.parse(current.cutoffAt)+30*60*1000;
  let state:'pending'|'overdue'='pending';
  let pairReads=0;
  await openDashboard(page,()=>{
    pairReads+=1;
    return {
      ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
      current_cycle:current,upcoming_cycle:upcomingAfter(current),
      publication_state:publicationState(
        current,state,true,state==='pending'?recovery-1000:recovery,
      ),
    };
  },circle('owner'));
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','pending');
  const before=pairReads;
  state='overdue';
  await page.clock.fastForward(1100);
  await expect.poll(()=>pairReads).toBeGreaterThan(before);
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','overdue');
  await expect(page.getByTestId('dashboard-publish-now')).toBeVisible();
});

test('an ambiguous owner publication refetches truth and leaves a persistent Retry action',async({page})=>{
  const current=cycleWindow();
  let pairReads=0;
  let pairingRuns=0;
  await page.route(/^https:\/\//,route=>route.abort());
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user},
    '/api/circle':circle('owner'),
    '/api/my-pair':()=>{
      pairReads+=1;
      return {
        ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
        current_cycle:current,upcoming_cycle:upcomingAfter(current),
        publication_state:publicationState(current,'overdue',true),
      };
    },
    '/api/pairing/run':request=>{
      pairingRuns+=1;
      expect(request.postDataJSON()).toEqual({expected_cycle_key:publicationCycleKey});
      return {_status:503,ok:false,error:'pairing unavailable'};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('dashboard-publish-now')).toBeVisible();
  const before=pairReads;
  await page.getByTestId('dashboard-publish-now').click();
  await expect.poll(()=>pairingRuns).toBe(1);
  await expect.poll(()=>pairReads).toBeGreaterThan(before);
  await expect(page.getByTestId('dashboard-publish-now')).toHaveText('Retry publication');
  await expect(page.getByTestId('dashboard-publish-now')).toBeEnabled();
});

test('a cross-tab publication hint carries identifiers only and refetches matching state',async({page,context})=>{
  const other=await context.newPage();
  const current=cycleWindow();
  let published=false;
  let otherReads=0;
  const install=async(target:Page,isOther=false)=>{
    await target.route(/^https:\/\//,route=>route.abort());
    await mockApi(target,{
      '/api/auth/me':{ok:true,user},
      '/api/profile':{ok:true,user},
      '/api/circle':circle('owner'),
      '/api/my-pair':()=>{
        if(isOther) otherReads+=1;
        return {
          ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
          current_cycle:current,upcoming_cycle:upcomingAfter(current),
          publication_state:publicationState(current,published?'published':'overdue',true),
        };
      },
      '/api/pairing/run':request=>{
        expect(request.postDataJSON()).toEqual({expected_cycle_key:publicationCycleKey});
        published=true;
        return {ok:true,created:true,count:0,cycle:current,
          publication_state:publicationState(current,'published',true)};
      },
    });
    await resetClientState(target,true,{},true);
  };
  await Promise.all([install(page),install(other,true)]);
  await Promise.all([
    page.goto('/',{waitUntil:'domcontentloaded'}),
    other.goto('/',{waitUntil:'domcontentloaded'}),
  ]);
  await expect(page.getByTestId('dashboard-publish-now')).toBeVisible();
  await expect(other.getByTestId('dashboard-publish-now')).toBeVisible();

  await other.evaluate(()=>{
    const app=window as typeof window&{__pairingSignals?:unknown[]};
    app.__pairingSignals=[];
    const observer=new BroadcastChannel('randori-pairing-publication-v1');
    observer.onmessage=event=>{ app.__pairingSignals?.push(event.data); };
  });
  const beforeWrong=otherReads;
  await page.evaluate(key=>{
    const channel=new BroadcastChannel('randori-pairing-publication-v1');
    channel.postMessage({type:'pairing-publication',v:1,account_id:999,
      circle_public_id:null,context_version:null,cycle_key:key,nonce:'wrong-actor'});
    channel.postMessage({type:'pairing-publication',v:1,account_id:1,
      circle_public_id:'wrong-circle',context_version:null,cycle_key:key,nonce:'wrong-circle'});
    channel.postMessage({type:'pairing-publication',v:1,account_id:1,
      circle_public_id:null,context_version:null,cycle_key:'b'.repeat(64),nonce:'wrong-cycle'});
    channel.close();
  },publicationCycleKey);
  await expect.poll(()=>other.evaluate(()=>(window as typeof window&{__pairingSignals?:unknown[]})
    .__pairingSignals?.length||0)).toBe(3);
  expect(otherReads).toBe(beforeWrong);

  await page.getByTestId('dashboard-publish-now').click();
  await expect.poll(()=>otherReads).toBeGreaterThan(beforeWrong);
  await expect(other.getByTestId('dashboard-publish-now')).toBeHidden();
  const signal=await other.evaluate(()=>(window as typeof window&{__pairingSignals?:Record<string,unknown>[]})
    .__pairingSignals?.find(item=>!Object.hasOwn(item,'nonce')));
  expect(Object.keys(signal||{}).sort()).toEqual([
    'account_id','circle_public_id','context_version','cycle_key','type','v',
  ]);
});

test('an envelope observed outside its cycle never exposes an owner publication action',async({page})=>{
  const current=cycleWindow();
  await openDashboard(page,{
    ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
    current_cycle:current,upcoming_cycle:upcomingAfter(current),
    publication_state:publicationState(current,'overdue',true,Date.parse(current.endsAt)),
  },circle('owner'));
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','error');
  await expect(page.getByTestId('dashboard-publish-now')).toBeHidden();
});

test('an authoritative overdue envelope ignores a skewed browser wall clock',async({page})=>{
  const current=cycleWindow();
  await page.clock.install({time:Date.parse(current.endsAt)+24*60*60*1000});
  await openDashboard(page,{
    ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
    current_cycle:current,upcoming_cycle:upcomingAfter(current),
    publication_state:publicationState(current,'overdue',true),
  },circle('owner'));
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','overdue');
  await expect(page.getByTestId('dashboard-publish-now')).toBeVisible();
});

test('an overdue owner action expires and refetches at the cycle boundary',async({page})=>{
  const observed=Date.now();
  await page.clock.install({time:observed});
  const expiring={
    cycleId:'expiring-cycle',startsAt:new Date(observed-60*60*1000).toISOString(),
    endsAt:new Date(observed+1000).toISOString(),
    cutoffAt:new Date(observed-60*60*1000).toISOString(),
    timeZone:'Europe/London',state:'current' as const,
  };
  const next={
    cycleId:'next-cycle',startsAt:expiring.endsAt,
    endsAt:new Date(observed+7*86_400_000).toISOString(),cutoffAt:expiring.endsAt,
    timeZone:'Europe/London',state:'current' as const,
  };
  let rolled=false;
  let pairReads=0;
  await openDashboard(page,()=>{
    pairReads+=1;
    const cycle=rolled?next:expiring;
    return {
      ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
      current_cycle:cycle,upcoming_cycle:upcomingAfter(cycle),
      publication_state:publicationState(cycle,rolled?'pending':'overdue',true,
        rolled?observed+1100:observed),
    };
  },circle('owner'));
  await expect(page.getByTestId('dashboard-publish-now')).toBeVisible();
  const before=pairReads;
  rolled=true;
  await page.clock.fastForward(1100);
  await expect.poll(()=>pairReads).toBeGreaterThan(before);
  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','pending');
  await expect(page.getByTestId('dashboard-publish-now')).toBeHidden();
});

for (const fixture of [
  { kind: 'stale', title: 'Previous pairing cycle ended' },
  { kind: 'future', title: 'Future pairing is not active yet' },
] as const) {
  test(`dashboard rejects a ${fixture.kind} assignment without leaking its partner or room`, async ({ page }) => {
    await openDashboard(page, dashboardPair({ cycle: cycleWindow(fixture.kind), partnerName: '<img src=x onerror=alert(1)> Future Partner' }));

    const state = page.getByTestId('dashboard-pair-state');
    await expect(state).toHaveAttribute('data-state', fixture.kind);
    await expect(state).toContainText(fixture.title);
    await expect(page.locator('#dashPairArea')).not.toContainText('Future Partner');
    await expect(page.locator('#roomSelect')).toHaveValue('');
    expect(await page.evaluate(() => (window as typeof window & { _randori_authorized_room?: string | null })._randori_authorized_room || null)).toBeNull();
  });
}

test('odd-member assignment is truthful solo practice without partner or AI claims', async ({ page }) => {
  await openDashboard(page, dashboardPair({ solo: true }));

  const card = page.getByTestId('solo-practice-card');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Solo practice');
  await expect(card).toContainText('odd-member assignment');
  await expect(card).not.toContainText(/AI partner|invite/i);
  await expect(card.getByRole('button', { name: 'Open Solo Catalogue + Code' })).toBeVisible();
  await expect(card.getByRole('button', { name: /copy|email|invite/i })).toHaveCount(0);
  await expect(page.locator('#dashScheduleArea')).toBeEmpty();
  await expect(page.locator('#dashChatArea')).toBeEmpty();
});

test('partner card escapes names and does not claim local focus is shared', async ({ page }) => {
  await openDashboard(page, dashboardPair({ partnerName: '<img src=x onerror=alert(1)> Partner' }));

  await expect(page.locator('#dashPairArea')).toContainText('<img src=x onerror=alert(1)> Partner');
  await expect(page.locator('#dashPairArea img')).toHaveCount(0);
  await expect(page.getByTestId('pair-focus-copy')).toContainText('not shared until you agree');
  await expect(page.locator('#dashTopicPicker')).toHaveCount(0);
});

for(const fixture of [
  {name:'missing',cycle:null},
  {name:'malformed',cycle:{cycleId:'bad',startsAt:'not-a-date',endsAt:'also-bad',state:'current'}},
] as const){
  test(`dashboard fails closed for ${fixture.name} current-cycle metadata`,async({page})=>{
    await openDashboard(page,{
      ...dashboardPair(),
      current_cycle:fixture.cycle,
      cycle:fixture.cycle,
    });
    await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','error');
    await expect(page.getByTestId('dashboard-pair-state')).toContainText('temporarily unavailable');
    await expect(page.locator('#dashPairArea')).not.toContainText('Current Partner');
    await expect(page.locator('#roomSelect')).toHaveValue('');
  });
}

test('a hidden dashboard cancels an old response and refreshes from durable state when visible', async ({ page }) => {
  let pairRequests = 0;
  const current = cycleWindow();
  await openDashboard(page, async () => {
    pairRequests += 1;
    if (pairRequests === 1) {
      await new Promise(resolve => setTimeout(resolve, 700));
      return dashboardPair({ partnerName: 'Late Stale Partner' });
    }
    return {
      ok: true, paired: false, pairing_status: 'unpublished',
      current_cycle: current, upcoming_cycle: upcomingAfter(current),
    };
  });
  await expect.poll(() => pairRequests).toBeGreaterThanOrEqual(1);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state', 'unpublished');
  await page.waitForTimeout(800);
  await expect(page.locator('#dashPairArea')).not.toContainText('Late Stale Partner');
  await expect.poll(() => pairRequests).toBeGreaterThanOrEqual(2);
});

test('refreshing the same current pair preserves its active workspace lifecycle',async({page})=>{
  let holdRefresh=false;
  let pairRequests=0;
  let releaseRefresh:()=>void=()=>{};
  const refreshGate=new Promise<void>(resolve=>{ releaseRefresh=resolve; });
  await openDashboard(page,async()=>{
    pairRequests+=1;
    if(holdRefresh) await refreshGate;
    return dashboardPair();
  });
  await page.locator('#dashJoinSession').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string}})._randori_workspace?.room||null)).toBe('week_20_pair_30');
  await page.evaluate(()=>{
    const app=window as typeof window&{
      _randori_workspace?:Record<string,unknown>&{deactivate?:()=>void};
      __testWorkspaceDeactivations?:number;
    };
    const original=app._randori_workspace;
    app.__testWorkspaceDeactivations=0;
    if(original) original.deactivate=()=>{ app.__testWorkspaceDeactivations=(app.__testWorkspaceDeactivations||0)+1; };
  });

  holdRefresh=true;
  await page.evaluate(()=>{ void (window as typeof window&{_randori_journey:{showDashboard:()=>Promise<void>}})._randori_journey.showDashboard(); });
  await expect.poll(()=>pairRequests).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#dashPairArea')).not.toContainText('Current Partner');
  await expect(page.locator('#dashPairArea').getByRole('button',{name:/copy|email|invite/i})).toHaveCount(0);
  releaseRefresh();

  await expect(page.locator('#dashPairArea')).toContainText('Current Partner');
  expect(await page.evaluate(()=>(window as typeof window&{__testWorkspaceDeactivations?:number}).__testWorkspaceDeactivations)).toBe(0);
  expect(await page.evaluate(()=>(window as typeof window&{_randori_authorized_room?:string|null})._randori_authorized_room||null)).toBe('week_20_pair_30');
});

test('a different current pair revokes the old workspace before authorizing the new room',async({page})=>{
  let pairResponse:Record<string,unknown>=dashboardPair();
  let releaseCircle:()=>void=()=>{};
  let circleResponses=0;
  const circleGate=new Promise<void>(resolve=>{ releaseCircle=resolve; });
  await openDashboard(page,()=>pairResponse,async()=>{
    await circleGate;
    circleResponses+=1;
    return circle('member');
  });
  await page.locator('#dashJoinSession').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string}})._randori_workspace?.room||null)).toBe('week_20_pair_30');
  await page.evaluate(()=>{
    const app=window as typeof window&{
      _randori_video?:Record<string,unknown>&{leaveVideo?:()=>void};
      __testVideoLeaves?:number;
    };
    const original=app._randori_video;
    let joined=true;
    app.__testVideoLeaves=0;
    app._randori_video={
      ...original,
      get joined(){ return joined; },
      leaveVideo:()=>{ joined=false; app.__testVideoLeaves=(app.__testVideoLeaves||0)+1; original?.leaveVideo?.(); },
    };
  });
  pairResponse=dashboardPair({weekId:21,pairId:31,partnerId:3,partnerName:'Next Partner'});
  await page.evaluate(async()=>{
    await (window as typeof window&{_randori_journey:{showDashboard:()=>Promise<void>}})._randori_journey.showDashboard();
  });

  await expect(page.locator('#dashPairArea')).toContainText('Next Partner');
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_schedule?:{room?:string}})._randori_schedule?.room||null)).toBe('week_21_pair_31');
  releaseCircle();
  await expect.poll(()=>circleResponses).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#peopleCount')).toHaveText('1');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string|null}})._randori_workspace?.room||null)).toBeNull();
  expect(await page.evaluate(()=>(window as typeof window&{__testVideoLeaves?:number}).__testVideoLeaves)).toBe(1);
  expect(await page.evaluate(()=>(window as typeof window&{_randori_authorized_room?:string|null})._randori_authorized_room||null)).toBe('week_21_pair_31');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_pair_cache?:{room_id?:string}|null})._randori_pair_cache?.room_id||null)).toBe('week_21_pair_31');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  expect(await page.evaluate(()=>localStorage.getItem('randori-last-room'))).toBeNull();

  await page.locator('#dashJoinSession').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#roomSelect')).toHaveValue('week_21_pair_31');
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string}})._randori_workspace?.room||null)).toBe('week_21_pair_31');
});

test('navigating away during a pair refresh revokes the retained room and ignores the late response',async({page})=>{
  let pairRequests=0;
  let holdRefresh=false;
  let releaseRefresh:()=>void=()=>{};
  const refreshGate=new Promise<void>(resolve=>{ releaseRefresh=resolve; });
  await openDashboard(page,async()=>{
    pairRequests+=1;
    if(holdRefresh) await refreshGate;
    return pairRequests===1
      ?dashboardPair()
      :dashboardPair({weekId:21,pairId:31,partnerId:3,partnerName:'Late Next Partner'});
  });
  await page.locator('#dashJoinSession').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string}})._randori_workspace?.room||null)).toBe('week_20_pair_30');

  holdRefresh=true;
  await page.evaluate(()=>{
    void (window as typeof window&{_randori_journey:{showDashboard:()=>Promise<void>}})._randori_journey.showDashboard();
  });
  await expect.poll(()=>pairRequests).toBeGreaterThanOrEqual(2);
  await page.locator('[data-tab="code"]').click();

  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#roomSelect')).toHaveValue('');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string|null}})._randori_workspace?.room||null)).toBeNull();
  expect(await page.evaluate(()=>(window as typeof window&{_randori_authorized_room?:string|null})._randori_authorized_room||null)).toBeNull();
  expect(await page.evaluate(()=>(window as typeof window&{_randori_pair_cache?:unknown})._randori_pair_cache||null)).toBeNull();
  expect(await page.evaluate(()=>localStorage.getItem('randori-last-room'))).toBeNull();

  releaseRefresh();
  await page.waitForTimeout(100);
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#dashPairArea')).not.toContainText('Late Next Partner');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_authorized_room?:string|null})._randori_authorized_room||null)).toBeNull();
});

test('dashboard rollover stops old workspace and video activity before showing no-pair state',async({page})=>{
  let pairResponse:Record<string,unknown>=dashboardPair();
  let workspaceRequests=0;
  await page.route(/^https:\/\//,route=>route.abort());
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user},
    '/api/circle':circle('member'),
    '/api/my-pair':()=>pairResponse,
    '/api/messages':request=>{
      const url=new URL(request.url());
      return {ok:true,room_id:url.searchParams.get('room_id'),messages:[],after:Number(url.searchParams.get('after_id')||0)};
    },
    '/api/video/signal':()=>{ workspaceRequests+=1; return {ok:true,revision:0,snapshot:null}; },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#dashJoinSession')).toBeVisible();
  await page.locator('#dashJoinSession').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#roomSelect')).toHaveValue('week_20_pair_30');
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string}})._randori_workspace?.room||null)).toBe('week_20_pair_30');
  await page.evaluate(()=>{
    const app=window as typeof window&{
      _randori_video?:Record<string,unknown>&{leaveVideo?:()=>void};
      __testVideoLeaves?:number;
    };
    const original=app._randori_video;
    let joined=true;
    app.__testVideoLeaves=0;
    app._randori_video={
      ...original,
      get joined(){ return joined; },
      leaveVideo:()=>{ joined=false; app.__testVideoLeaves=(app.__testVideoLeaves||0)+1; original?.leaveVideo?.(); },
    };
  });
  const current=cycleWindow();
  pairResponse={
    ok:true,paired:false,pairing_status:'missed',reason:'not_paired_this_cycle',
    current_cycle:current,upcoming_cycle:upcomingAfter(current),
  };
  await page.evaluate(async()=>{ await (window as typeof window&{_randori_journey:{showDashboard:()=>Promise<void>}})._randori_journey.showDashboard(); });

  await expect(page.getByTestId('dashboard-pair-state')).toHaveAttribute('data-state','missed');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#videoRoomLabel')).toHaveText('room —');
  expect(await page.evaluate(()=>(window as typeof window&{_randori_workspace?:{room?:string|null}})._randori_workspace?.room||null)).toBeNull();
  expect(await page.evaluate(()=>(window as typeof window&{__testVideoLeaves?:number}).__testVideoLeaves)).toBe(1);
  expect(await page.evaluate(()=>localStorage.getItem('randori-last-room'))).toBeNull();
  await page.waitForTimeout(200);
  const settledRequests=workspaceRequests;
  await page.waitForTimeout(1400);
  expect(workspaceRequests).toBe(settledRequests);
});
