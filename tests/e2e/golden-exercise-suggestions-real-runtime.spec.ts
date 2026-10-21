import AxeBuilder from '@axe-core/playwright';
import {expect,Page,test} from '@playwright/test';

import {openRoomPanel,setCode} from './helpers';
import {
  FOCUS_BLOCK_ROLLUP_SOLUTION,
  LOCAL_OWNER_NAME,
  configureExecutionProvider,
  createPairedCircle,
  installDeterministicExecutionTransport,
  json,
  pathIs,
  startGoldenRuntime,
  waitForWorkspace,
} from './golden-runtime';

// Issue #296 golden path (docs/testing/E2E_GOLDEN_PATHS.md row 15). The real
// loopback runtime runs with EXERCISE_SUGGESTIONS_ENABLED. Markers and
// suggestions come from the production `/api/exercise-suggestions` handler;
// the only replaced boundary is code execution (as in golden paths 8 and 10).

const SUGGESTIONS='/api/exercise-suggestions';

async function crdtSynced(page:Page,room:string){
  await expect.poll(()=>page.evaluate(()=>{
    const crdt=(window as any)._randori_crdt;
    return {room:crdt?.identity?.room||null,status:crdt?.status||null};
  }),{timeout:15_000}).toEqual({room,status:'synced'});
}

// The first request after a page load can be the solo one (sent before the
// room is authorized); pass `room` to wait for the pair request.
function suggestionsResponse(page:Page,room?:string){
  return page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname===SUGGESTIONS&&(!room||url.searchParams.get('room_id')===room);
  },{timeout:15_000});
}

async function suggestedSlugs(page:Page){
  return page.getByTestId('exercise-suggestion-open').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-suggestion-slug')));
}

async function openBrowseList(page:Page){
  const browse=page.getByTestId('catalog-browse');
  if(await browse.getAttribute('open')===null) await browse.locator('summary').click();
  await expect(browse).toHaveAttribute('open','');
}

async function expectSuggestionsAccessible(page:Page){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    await openRoomPanel(page,'problem');
    await openBrowseList(page);
    for(const light of [false,true]){
      const isLight=await page.evaluate(()=>document.documentElement.classList.contains('light'));
      if(isLight!==light) await page.evaluate(()=>(document.getElementById('themeToggle') as HTMLButtonElement).click());
      await expect(page.locator('html')).toHaveClass(light?/light/:/^(?!.*\blight\b).*$/);
      const results=await new AxeBuilder({page}).include('#exerciseSuggestions').include('#catalogList')
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
      expect(results.violations,`suggestions ${width}px ${light?'light':'dark'}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
}

test('pair suggestions: attempted markers after a run, partner privacy, keyboard hide and choose, solo history only',async({browser})=>{
  test.setTimeout(180_000);
  const original=process.env.EXERCISE_SUGGESTIONS_ENABLED;
  process.env.EXERCISE_SUGGESTIONS_ENABLED='true';
  const golden=await startGoldenRuntime('randori-golden-suggestions-');
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

    // With no history the pair gets three Easy exercises on uncovered topics.
    await openRoomPanel(owner,'problem');
    const ownerCard=owner.getByTestId('exercise-suggestions');
    await expect(ownerCard).toBeVisible();
    await expect(owner.locator('#exerciseSuggestionsTitle')).toHaveText('Suggested for this pair');
    await expect.poll(()=>suggestedSlugs(owner)).toEqual([
      'balanced-template-markers','capacity-upgrade-index','command-prefix-census',
    ]);
    await expect(ownerCard.locator('.catalog-suggestion-reason').first())
      .toHaveText('Neither of you has practised stack yet. An Easy exercise is a good place to start.');
    await expect(owner.locator('#exerciseSuggestionsNote')).toContainText('never scores, code or dates');

    // The owner runs the room's exercise; the shared run is verified on the
    // server and the exercise is marked as attempted in the browse list and
    // in the exercise picker.
    await expect(owner.locator('#questionSelect')).toHaveValue('focus-block-rollup');
    await setCode(owner,FOCUS_BLOCK_ROLLUP_SOLUTION);
    expect(await owner.evaluate(()=>(window as any)._randori_crdt.flush())).toMatch(/^[a-f0-9]{64}$/);
    await expect(owner.locator('#runBtn')).toBeEnabled();
    const executed=owner.waitForResponse(pathIs('/api/execute','POST'));
    const refreshed=suggestionsResponse(owner);
    await owner.locator('#runBtn').click();
    expect(await (await executed).json()).toMatchObject({ok:true,question_slug:'focus-block-rollup',passed_count:8});
    expect((await refreshed).status()).toBe(200);
    await openRoomPanel(owner,'problem');
    await openBrowseList(owner);
    await expect(owner.locator('#catalogList .catalog-card[data-slug="focus-block-rollup"] [data-testid="catalog-attempted"]'))
      .toHaveText('Attempted by you');
    await expect(owner.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveText(/ · attempted by you$/);

    // The partner sees only "attempted by your partner" and suggestions one
    // step up from the pair's recent Easy work, on topics neither has covered.
    const memberLoaded=suggestionsResponse(member,pair.room);
    await member.reload({waitUntil:'domcontentloaded'});
    await waitForWorkspace(member,pair.room);
    const memberResponse=await memberLoaded;
    const memberBody=await memberResponse.json();
    expect(memberBody).toMatchObject({ok:true,mode:'pair',room_id:pair.room,partner_count:1});
    expect(memberBody.attempted).toEqual([{slug:'focus-block-rollup',by_me:false,by_partner:true}]);
    const serialized=JSON.stringify(memberBody);
    expect(serialized).not.toMatch(/passed|total_count|created_at|2\d{3}-\d{2}-\d{2}|rollUpFocusBlocks|@/);
    expect(serialized).not.toContain(LOCAL_OWNER_NAME);
    await openRoomPanel(member,'problem');
    await openBrowseList(member);
    await expect(member.locator('#catalogList .catalog-card[data-slug="focus-block-rollup"] [data-testid="catalog-attempted"]'))
      .toHaveText('Attempted by your partner');
    await expect.poll(()=>suggestedSlugs(member)).toEqual([
      'compatible-review-orders','connectivity-checkpoints','coverage-gap-finder',
    ]);
    await expect(member.getByTestId('exercise-suggestions').locator('.catalog-suggestion-reason').first())
      .toHaveText('Neither of you has practised backtracking yet. One step up from your recent Easy exercises.');

    // Keyboard only: hide the first suggestion; focus moves to the next one
    // and the hide list is stored for this member in this browser only.
    const hide=member.getByRole('button',{name:'Hide Compatible Review Orders from suggestions'});
    await hide.focus();
    const hidden=suggestionsResponse(member);
    await member.keyboard.press('Enter');
    expect(new URL((await hidden).url()).searchParams.get('hidden')).toBe('compatible-review-orders');
    await expect.poll(()=>suggestedSlugs(member)).not.toContain('compatible-review-orders');
    await expect(member.getByTestId('exercise-suggestion-open').first()).toBeFocused();
    expect(await member.evaluate(id=>localStorage.getItem(`randori-hidden-suggestions:${id}`),pair.member.user.id))
      .toBe('["compatible-review-orders"]');
    const showHidden=member.getByTestId('exercise-suggestions-show-hidden');
    await expect(showHidden).toHaveText('Show 1 hidden exercise');

    // Keyboard only: choose a suggestion; it opens through the exercise picker.
    const first=member.getByTestId('exercise-suggestion-open').first();
    const chosen=String(await first.getAttribute('data-suggestion-slug'));
    await first.focus();
    await member.keyboard.press('Enter');
    const overlay=member.locator('#confirmOverlay.show');
    if(await overlay.isVisible()) await member.locator('#confirmOk').click();
    await expect(member.locator('#questionSelect')).toHaveValue(chosen);

    // Show hidden exercises brings the hidden one back.
    await showHidden.focus();
    const restored=suggestionsResponse(member);
    await member.keyboard.press('Enter');
    expect(new URL((await restored).url()).searchParams.has('hidden')).toBe(false);
    await expect.poll(()=>suggestedSlugs(member)).toContain('compatible-review-orders');

    await expectSuggestionsAccessible(member);

    // Solo practice uses only the member's own history: the partner's run
    // does not appear without the pair room.
    const memberSolo=await json(member,SUGGESTIONS);
    expect(memberSolo.status).toBe(200);
    expect(memberSolo.body).toMatchObject({mode:'solo',room_id:null,partner_count:0,attempted:[]});
    const ownerSolo=await json(owner,SUGGESTIONS);
    expect(ownerSolo.body.attempted).toEqual([{slug:'focus-block-rollup',by_me:true,by_partner:false}]);
    expect(transport.unexpectedExternalRequests).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    transport.restore();
    await golden.close();
    if(original===undefined) delete process.env.EXERCISE_SUGGESTIONS_ENABLED;
    else process.env.EXERCISE_SUGGESTIONS_ENABLED=original;
  }
});
