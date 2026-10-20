import {readFileSync} from 'node:fs';

import {expect,Page,test} from '@playwright/test';

import {openRoomPanel, setCode} from './helpers';
import {
  FOCUS_BLOCK_ROLLUP_SOLUTION,
  LOCAL_OWNER_NAME,
  MEMBER_PASSWORD,
  capturePairingEmails,
  configureExecutionProvider,
  createPairedCircle,
  emailLinks,
  installDeterministicExecutionTransport,
  newGoldenPage,
  openDashboard,
  pathIs,
  signInThroughForm,
  startGoldenRuntime,
  waitForWorkspace,
} from './golden-runtime';

// Golden paths 5–9 (docs/testing/E2E_GOLDEN_PATHS.md) driven through the UI
// of two real browsers against the real loopback runtime. Each test builds its
// own invited, published pair so the tests are independent and can run on
// separate workers.

async function scheduleSnapshot(page:Page){
  return page.evaluate(()=>{
    const state=(window as any)._randori_schedule;
    return JSON.parse(JSON.stringify({version:state?.version||'',schedule:state?.schedule||null}));
  });
}

/** A future local datetime-local value in the page's own timezone. */
async function localInputHoursFromNow(page:Page,hours:number){
  return page.evaluate(offset=>{
    const when=new Date(Date.now()+offset*3600_000);
    when.setMinutes(0,0,0);
    const pad=(value:number)=>String(value).padStart(2,'0');
    return {
      input:`${when.getFullYear()}-${pad(when.getMonth()+1)}-${pad(when.getDate())}T${pad(when.getHours())}:00`,
      instant:when.toISOString(),
    };
  },hours);
}

function icsStamp(instant:string,plusMinutes=0){
  return new Date(Date.parse(instant)+plusMinutes*60_000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
}

async function crdtSynced(page:Page,room:string){
  await expect.poll(()=>page.evaluate(()=>{
    const crdt=(window as any)._randori_crdt;
    return {room:crdt?.identity?.room||null,status:crdt?.status||null};
  }),{timeout:15_000}).toEqual({room,status:'synced'});
}

async function insertAt(page:Page,offset:number,value:string){
  const editor=page.locator('#editor');
  await editor.focus();
  await editor.evaluate((node,index)=>(node as HTMLTextAreaElement).setSelectionRange(index,index),offset);
  await page.keyboard.type(value);
}

async function boardShapes(page:Page){
  return page.evaluate(()=>JSON.parse(JSON.stringify((window as any)._randori_board?.shapes||[]))) as Promise<Array<{type:string}>>;
}

test('the pairing email link opens the room after sign-in and partners chat with a recoverable failed send',async({browser})=>{
  test.setTimeout(150_000);
  const golden=await startGoldenRuntime('randori-golden-join-chat-');
  try{
    const pair=await createPairedCircle(browser,golden);

    // Path 5: the published pairing email links each member to /join/<room>.
    const emails=await capturePairingEmails(golden);
    expect(emails.map(email=>email.to).sort()).toEqual(['golden.partner@example.test','owner@randori.test']);
    const memberEmail=emails.find(email=>email.to===pair.member.email)!;
    expect(memberEmail.subject).toContain('your pairing is ready');
    const joinLink=emailLinks(memberEmail).find(link=>link.includes('/join/'));
    expect(joinLink).toBe(`${golden.url}/join/${pair.room}`);

    // Opened on a signed-out device it keeps the room URL, asks for sign-in,
    // and lands in the authorized room afterwards.
    const device=await newGoldenPage(browser,golden);
    await device.page.goto(joinLink!,{waitUntil:'domcontentloaded'});
    await expect(device.page).toHaveURL(`${golden.url}/join/${pair.room}`);
    await expect(device.page.getByRole('dialog',{name:'Sign in to join your pairing room'})).toBeVisible();
    await expect(device.page.locator('#view-code')).toBeHidden();
    // Let the anonymous (member-only) catalogue request settle first so the
    // sign-in below always happens without a page reload after it.
    await expect.poll(()=>device.page.evaluate(()=>(window as any)._randori_questions?.state)).toBe('failed');
    const login=await signInThroughForm(device.page,pair.member.email,MEMBER_PASSWORD,{open:false});
    expect(login.status()).toBe(200);
    await expect(device.page).toHaveURL(`${golden.url}/join/${pair.room}`);
    await waitForWorkspace(device.page,pair.room);

    // Path 7: chat from the dashboard; the partner receives it by polling.
    const ownerChat=pair.owner.page;
    const memberChat=pair.member.page;
    await expect(ownerChat.getByTestId('pair-chat')).toBeVisible();
    await expect(memberChat.getByTestId('pair-chat')).toBeVisible();
    await ownerChat.getByTestId('pair-chat-input').fill('Ready when you are — I will drive first.');
    const ownerSend=ownerChat.waitForResponse(pathIs('/api/messages','POST'));
    await ownerChat.getByTestId('pair-chat-send').click();
    expect((await ownerSend).status()).toBe(201);
    await expect(ownerChat.getByTestId('pair-chat-input')).toHaveValue('');
    await expect(memberChat.getByTestId('pair-chat-list')).toContainText('Ready when you are — I will drive first.',{timeout:15_000});

    // Failed sends keep the exact draft until an explicit retry. Faults are
    // injected for single requests only; everything else is the real API.
    const draft='  Sounds good, I will navigate.  ';
    let fault:'reset'|'reject'|null='reset';
    await memberChat.route('**/api/messages',route=>{
      if(route.request().method()!=='POST'||!fault) return route.fallback();
      const injected=fault;
      fault=null;
      return injected==='reset'
        ?route.abort('connectionreset')
        :route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'messages unavailable'})});
    });
    // Lost in transit: delivery is uncertain, so the client re-reads the room
    // and asks the member to check before retrying; the draft is untouched.
    await memberChat.getByTestId('pair-chat-input').fill(draft);
    await memberChat.getByTestId('pair-chat-send').click();
    await expect(memberChat.getByTestId('pair-chat-status')).toHaveText('Latest messages loaded — check before retry');
    await expect(memberChat.getByTestId('pair-chat-input')).toHaveValue(draft);
    await expect(memberChat.getByTestId('pair-chat-list')).not.toContainText('Sounds good, I will navigate.');
    // Rejected by the server: definitely not sent; the draft is untouched.
    fault='reject';
    await memberChat.getByTestId('pair-chat-send').click();
    await expect(memberChat.getByTestId('pair-chat-status')).toHaveText('Not sent — retry');
    await expect(memberChat.getByTestId('pair-chat-input')).toHaveValue(draft);
    const retried=memberChat.waitForResponse(pathIs('/api/messages','POST'));
    await memberChat.getByTestId('pair-chat-send').click();
    expect((await retried).status()).toBe(201);
    await expect(memberChat.getByTestId('pair-chat-input')).toHaveValue('');
    await expect(memberChat.getByTestId('pair-chat-list')).toContainText('Sounds good, I will navigate.');
    await expect(ownerChat.getByTestId('pair-chat-list')).toContainText('Sounds good, I will navigate.',{timeout:15_000});
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});

test('partners in different timezones propose, accept, export, add a meeting link, reschedule, and clear a session time',async({browser})=>{
  test.setTimeout(150_000);
  const golden=await startGoldenRuntime('randori-golden-schedule-');
  try{
    const pair=await createPairedCircle(browser,golden,{
      ownerContextOptions:{timezoneId:'Europe/London',acceptDownloads:true},
      memberContextOptions:{timezoneId:'America/New_York'},
    });
    const owner=pair.owner.page;
    const member=pair.member.page;

    // Propose → accept.
    const first=await localInputHoursFromNow(owner,48);
    await owner.getByTestId('schedule-input').fill(first.input);
    const proposed=owner.waitForResponse(pathIs('/api/schedule','POST'));
    await owner.getByTestId('schedule-propose').click();
    expect((await proposed).status()).toBe(200);
    await expect(owner.getByTestId('schedule-proposal')).toHaveCount(1);
    await openDashboard(member);
    await expect(member.getByTestId('schedule-proposal')).toHaveCount(1);
    await expect(member.getByTestId('schedule-proposal').locator(`time[datetime="${first.instant}"]`)).toHaveCount(1);
    await expect(member.getByTestId('schedule-proposal')).toContainText(`Proposed by ${LOCAL_OWNER_NAME}`);
    const accepted=member.waitForResponse(pathIs('/api/schedule','POST'));
    await member.getByTestId('schedule-accept').click();
    expect((await accepted).status()).toBe(200);
    await expect(member.getByTestId('schedule-area')).toContainText('Agreed:');
    await openDashboard(owner);
    await expect.poll(async()=>(await scheduleSnapshot(owner)).schedule?.agreed_time).toBe(first.instant);
    await expect(owner.getByTestId('schedule-area')).toContainText('Agreed:');

    // Calendar export carries the agreed slot and the private room link only.
    const download=owner.waitForEvent('download');
    await owner.getByTestId('schedule-calendar-export').click();
    const ics=readFileSync(await (await download).path(),'utf8');
    expect(ics).toContain(`DTSTART:${icsStamp(first.instant)}`);
    expect(ics).toContain(`DTEND:${icsStamp(first.instant,60)}`);
    expect(ics).toContain(`URL:${golden.url}/join/${pair.room}`);
    expect(ics).not.toMatch(/example\.test|randori\.test|password/i);

    // Meeting link: one partner saves it, the other sees the same host.
    const ownerMeeting=owner.getByTestId('meeting-link-dashboard');
    await ownerMeeting.getByTestId('meeting-link-add').click();
    await ownerMeeting.getByTestId('meeting-link-input').fill('https://meet.example.test/golden-room');
    const saved=owner.waitForResponse(pathIs('/api/meeting-link','POST'));
    await ownerMeeting.getByTestId('meeting-link-save').click();
    expect((await saved).status()).toBe(200);
    await expect(ownerMeeting.getByTestId('meeting-link-hostname')).toHaveText('meet.example.test');
    await openDashboard(member);
    await member.evaluate(()=>(window as any)._randori_meeting_link?.load?.());
    const memberMeeting=member.getByTestId('meeting-link-dashboard');
    await expect(memberMeeting.getByTestId('meeting-link-hostname')).toHaveText('meet.example.test');
    await expect(memberMeeting.getByTestId('meeting-link-join')).toHaveAttribute('href','https://meet.example.test/golden-room');

    // Reschedule: the partner proposes a new time and the owner accepts it.
    const second=await localInputHoursFromNow(member,72);
    await member.getByTestId('schedule-input').fill(second.input);
    await member.getByTestId('schedule-propose').click();
    await expect(member.getByTestId('schedule-proposal').locator(`time[datetime="${second.instant}"]`)).toHaveCount(1);
    await openDashboard(owner);
    const newProposal=owner.getByTestId('schedule-proposal').filter({has:owner.locator(`time[datetime="${second.instant}"]`)});
    await expect(newProposal).toHaveCount(1);
    await newProposal.getByTestId('schedule-accept').click();
    await expect.poll(async()=>(await scheduleSnapshot(owner)).schedule?.agreed_time).toBe(second.instant);
    const rescheduledDownload=owner.waitForEvent('download');
    await owner.getByTestId('schedule-calendar-export').click();
    const rescheduledIcs=readFileSync(await (await rescheduledDownload).path(),'utf8');
    expect(rescheduledIcs).toContain(`DTSTART:${icsStamp(second.instant)}`);
    expect(rescheduledIcs).not.toContain(`DTSTART:${icsStamp(first.instant)}`);
    await openDashboard(member);
    await expect.poll(async()=>(await scheduleSnapshot(member)).schedule?.agreed_time).toBe(second.instant);

    // Clear: the agreement, its export and meeting controls disappear for both.
    const cleared=owner.waitForResponse(pathIs('/api/schedule','POST'));
    await owner.getByTestId('schedule-clear').click();
    expect((await cleared).status()).toBe(200);
    await expect(owner.getByTestId('schedule-area')).toContainText('No time agreed yet.');
    await expect(owner.getByTestId('schedule-calendar-export')).toHaveCount(0);
    await openDashboard(member);
    await expect.poll(async()=>(await scheduleSnapshot(member)).schedule?.agreed_time??null).toBeNull();
    await expect(member.getByTestId('schedule-area')).toContainText('No time agreed yet.');
    await expect(member.getByTestId('schedule-calendar-export')).toHaveCount(0);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});

test('partners co-edit one document without conflicts, sketch, run it into a shared feed, complete the session, and see it in History',async({browser})=>{
  test.setTimeout(180_000);
  const golden=await startGoldenRuntime('randori-golden-workspace-');
  const transport=installDeterministicExecutionTransport(()=>golden.origin);
  try{
    configureExecutionProvider();
    const pair=await createPairedCircle(browser,golden);
    const owner=pair.owner.page;
    const member=pair.member.page;
    await Promise.all([owner,member].map(page=>page.goto(`${golden.url}/join/${pair.room}`,{waitUntil:'domcontentloaded'})));
    for(const page of [owner,member]){
      await waitForWorkspace(page,pair.room);
      await crdtSynced(page,pair.room);
    }
    await expect(owner.locator('#questionSelect')).toHaveValue('focus-block-rollup');

    // Path 8a: one member replaces the starter; the partner converges on it.
    await setCode(owner,FOCUS_BLOCK_ROLLUP_SOLUTION);
    expect(await owner.evaluate(()=>(window as any)._randori_crdt.flush())).toMatch(/^[a-f0-9]{64}$/);
    await expect.poll(()=>member.locator('#editor').inputValue(),{timeout:15_000}).toBe(FOCUS_BLOCK_ROLLUP_SOLUTION);

    // Path 8b: both type at the same position at the same time; the CRDT
    // keeps both edits and every browser converges on one document.
    await Promise.all([insertAt(owner,0,'// owner note\n'),insertAt(member,0,'// member note\n')]);
    const converged=async()=>{
      const [a,b]=await Promise.all([owner.locator('#editor').inputValue(),member.locator('#editor').inputValue()]);
      return a===b&&a.includes('// owner note\n')&&a.includes('// member note\n')&&a.endsWith(FOCUS_BLOCK_ROLLUP_SOLUTION);
    };
    await expect.poll(converged,{timeout:20_000}).toBe(true);
    for(const page of [owner,member]) await crdtSynced(page,pair.room);

    // Path 8c: a whiteboard sketch reaches the partner and becomes part of the
    // durable workspace checkpoint.
    await member.locator('[data-tab="board"]').click();
    await expect(member.locator('#board')).toBeVisible();
    await member.getByRole('button',{name:'Draw a rectangle'}).click();
    const canvas=await member.locator('#board').boundingBox();
    if(!canvas) throw new Error('whiteboard canvas has no layout box');
    await member.mouse.move(canvas.x+70,canvas.y+70);
    await member.mouse.down();
    await member.mouse.move(canvas.x+190,canvas.y+150,{steps:5});
    await member.mouse.up();
    await expect.poll(()=>boardShapes(member)).toHaveLength(1);
    await expect.poll(()=>boardShapes(owner),{timeout:15_000}).toEqual([expect.objectContaining({type:'rect'})]);
    await member.locator('[data-tab="code"]').click();
    await expect(member.locator('#view-code')).toBeVisible();

    // Path 8d: Run executes the canonical shared document; both see the run.
    await expect(owner.locator('#runBtn')).toBeEnabled();
    const executed=owner.waitForResponse(pathIs('/api/execute','POST'));
    await owner.locator('#runBtn').click();
    const execution=await (await executed).json();
    expect(execution).toMatchObject({ok:true,question_slug:'focus-block-rollup',passed_count:8,total_count:8});
    expect(transport.requests).toHaveLength(1);
    for(const page of [owner,member]){
      await expect(page.locator('#pairRunsList')).toContainText('8/8',{timeout:15_000});
      await expect(page.locator('#pairRunsList')).toContainText(LOCAL_OWNER_NAME);
    }

    // Path 9: completion needs both participants. Wrap-up lives in the
    // room's Session panel.
    for(const page of [owner,member]) await openRoomPanel(page,'session');
    const ownerStatus=owner.locator('#sessionCompletionStatus');
    const memberStatus=member.locator('#sessionCompletionStatus');
    await expect(owner.locator('#sessionCompletionAction')).toHaveText('Confirm session completed');
    await owner.locator('#sessionCompletionAction').click();
    await expect(ownerStatus).toHaveText('You confirmed. Waiting for 1 participant.');
    // The partner's bounded poll observes the first receipt.
    await expect(memberStatus).toHaveText('1 of 2 participants confirmed.',{timeout:15_000});
    await expect(member.locator('#sessionCompletionAction')).toHaveText('Confirm session completed');
    await member.locator('#sessionCompletionAction').click();
    await expect(memberStatus).toContainText('Session completed');
    await expect(ownerStatus).toContainText('Session completed',{timeout:15_000});
    await expect(owner.locator('#sessionCompletionAction')).toBeHidden();

    // History shows the completed pairing and its recap.
    await member.locator('[data-tab="history"]').click();
    const row=member.locator(`[data-testid="pair-history-row"][data-room-id="${pair.room}"]`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('session-completion-badge')).toHaveText('Completed');
    await row.getByTestId('pair-history-view-recap').click();
    const recap=member.getByTestId('pair-recap');
    await expect(recap.getByTestId('pair-recap-completion')).toContainText('Completed');
    await expect(recap.getByTestId('pair-recap-workspace')).toContainText(/Checkpoint r\d+ · focus-block-rollup/);
    await expect(recap.getByTestId('pair-recap-activity')).toContainText('Verified run · Focus block rollup');
    await expect(recap.getByTestId('pair-recap-activity')).toContainText('8/8 passed');
    expect(transport.unexpectedExternalRequests).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    transport.restore();
    await golden.close();
  }
});
