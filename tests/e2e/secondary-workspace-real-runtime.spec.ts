import {expect,Page,test} from '@playwright/test';
import bcrypt from 'bcryptjs';
import {setCode} from './helpers';
import {createPairedCircle,startGoldenRuntime,withDatabase,newGoldenPage,signInMemberSession,
  configureExecutionProvider,installDeterministicExecutionTransport,FOCUS_BLOCK_ROLLUP_SOLUTION} from './golden-runtime';
import {enableWorkspace,seedSecondaryCircle} from '../support/secondary-workspace-fixture.mjs';

test.setTimeout(180_000);
async function raw(page:Page,origin:string,path:string,method='GET',body?:unknown,version?:number){
  const context=await page.request.get(`${origin}/api/circles`);
  const selected=await context.json();
  const response=await page.request.fetch(`${origin}${path}`,{method,headers:{Origin:origin,
    'X-Randori-Circle-Context-Version':String(version??selected.context_version)},
    ...(body===undefined?{}:{data:body})});
  return {status:response.status(),text:await response.text(),body:await response.json()};
}
async function select(page:Page,origin:string,publicId:string){
  const context=await (await page.request.get(`${origin}/api/circles`)).json();
  const switched=await raw(page,origin,'/api/circles','PUT',{circle_public_id:publicId,expected_context_version:context.context_version});
  expect(switched.status,switched.text).toBe(200);
  await page.reload({waitUntil:'domcontentloaded'});
  await expect.poll(()=>page.evaluate(()=>(window as any)._randori_circle_control?.scheduleContext?.()?.circlePublicId)).toBe(publicId);
}
async function switchBeforeReload(page:Page,publicId:string,consumeOldResponse:()=>Promise<void>){
  await page.locator('[data-tab="circle"]').click();
  const selector=page.getByTestId('circle-context-select');
  await expect(selector).toBeVisible();
  let release=()=>{},arrived=()=>{};
  const gate=new Promise<void>(resolve=>release=resolve),committed=new Promise<void>(resolve=>arrived=resolve);
  const handler=async route=>{
    if(route.request().method()!=='PUT')return route.fallback();
    const response=await route.fetch();arrived();await gate;await route.fulfill({response});
  };
  await page.route('**/api/circles',handler);
  try{
    const selecting=selector.selectOption(publicId);
    await committed;
    // The server has switched and the browser has invalidated its epoch.
    // Hold only the live PUT response so the old document can consume its
    // already-completed workspace response before the normal page reload.
    await consumeOldResponse();
    const reloaded=page.waitForEvent('domcontentloaded');
    release();await selecting;await reloaded;
  }finally{release();await page.unroute('**/api/circles',handler);}
  await expect.poll(()=>page.evaluate(()=>(window as any)._randori_circle_control?.scheduleContext?.()?.circlePublicId)).toBe(publicId);
}
const reads=['messages','runs','pair-recap','session-completion','meeting-link','session-controls','code-document','video'];
const writes=['messages','execute','session-completion','meeting-link','session-controls','code-document','video'];
function resource(path:string,room:string){return `/api/${path}?room_id=${encodeURIComponent(room)}${path==='code-document'?'&question_slug=focus-block-rollup&question_version=1&language=javascript':''}`;}

test('real runtime: both directions, non-members, scoped History, independent room data, attested execution and pair/solo quorum',async({browser})=>{
  const golden=await startGoldenRuntime('randori-438-parity-'),transport=installDeterministicExecutionTransport(()=>golden.origin);
  let restore=()=>{};
  try{
    const pair=await createPairedCircle(browser,golden),owner=pair.owner.page,primaryOnly=pair.member.page;
    restore=enableWorkspace();configureExecutionProvider();
    const primary=(await (await owner.request.get(`${golden.origin}/api/circles`)).json()).circles[0];
    const secondary=await withDatabase(golden,async db=>{
      const password=await bcrypt.hash('secondary-member-password-438',4);
      const account=await db.execute({sql:`INSERT INTO auth_accounts(email,password_hash,display_name,color,is_available)
        VALUES('secondary438@example.test',?,'Secondary Partner','#234567',1) RETURNING id`,args:[password]});
      return seedSecondaryCircle(db,{users:[pair.owner.user.id,Number(account.rows[0].id)]});
    });
    const secondaryMember=await newGoldenPage(browser,golden),partner=secondaryMember.page;
    await signInMemberSession(partner,golden,'secondary438@example.test','secondary-member-password-438');
    const solo=await withDatabase(golden,db=>seedSecondaryCircle(db,{circleId:30,name:'Solo Dojo',publicId:'67e37755-88c5-4a29-ae64-a7cc5a3e9dc7',users:[pair.owner.user.id]}));
    expect(Number(secondary.group.id)).toBe(Number(pair.room.split('_').at(-1)));
    // U1 belongs to both circles, U2 only to primary, U3 only to secondary.
    for(const [viewer,foreign] of [[primaryOnly,secondary.room],[partner,pair.room]] as const){
      for(const surface of reads){
        const denied=await raw(viewer,golden.origin,resource(surface,foreign));
        const missing=foreign.startsWith('week_')?'week_999999_pair_999999':'circle_999999_publication_999999_group_999999';
        const absent=await raw(viewer,golden.origin,resource(surface,missing));
        expect([denied.status,denied.text],surface).toEqual([404,absent.text]);
        expect(absent.status).toBe(404);
      }
      for(const surface of writes){
        const denied=await raw(viewer,golden.origin,`/api/${surface}`,'POST',{room_id:foreign,message:'non-member must not store'});
        expect([denied.status,denied.body],surface).toEqual([404,{error:'pair not found'}]);
      }
    }
    await select(owner,golden.origin,primary.public_id);
    for(const [active,foreign] of [[secondary, pair.room],[primary,secondary.room]]){
      await select(owner,golden.origin,active.publicId||active.public_id);
      for(const surface of reads){
        const denied=await raw(owner,golden.origin,resource(surface,foreign));
        const absent=await raw(owner,golden.origin,resource(surface,foreign.startsWith('week_')?'week_999999_pair_999999':'circle_999999_publication_999999_group_999999'));
        expect([denied.status,denied.text],surface).toEqual([404,absent.text]);
        expect(absent.status).toBe(404);expect(denied.body).toEqual({error:'pair not found'});
      }
      for(const surface of writes){
        const denied=await raw(owner,golden.origin,`/api/${surface}`,'POST',{room_id:foreign,message:'must not be stored'});
        expect([denied.status,denied.body],surface).toEqual([404,{error:'pair not found'}]);
      }
    }
    await select(owner,golden.origin,primary.public_id);
    const ownMissing=await raw(owner,golden.origin,`/api/code-document?room_id=${pair.room}&question_slug=focus-block-rollup&question_version=1&language=javascript&after_revision=0`);
    // Primary first-document bootstrap is still supported; terminal or unsupported
    // own documents preserve their separately tested legacy not-found body.
    expect(ownMissing.status).toBe(200);
    const primaryHistory=await raw(owner,golden.origin,'/api/history');
    expect(primaryHistory.body.history).toHaveLength(1);
    expect(primaryHistory.body.history[0].circle).toEqual({public_id:primary.public_id,name:primary.name,is_primary:true});
    await select(owner,golden.origin,secondary.publicId);
    const history=await raw(owner,golden.origin,'/api/history');
    expect(history.body.total).toBe(1);expect(history.body.history).toHaveLength(1);
    expect(history.body.history[0]).toMatchObject({room_id:secondary.room,circle:{public_id:secondary.publicId,name:'Secondary Dojo',is_primary:false}});
    expect(history.body.history[0]).not.toHaveProperty('week_id');expect(history.body.history[0]).not.toHaveProperty('pg_id');
    await owner.locator('[data-tab="history"]').click();
    await expect(owner.locator('#historyPersonal')).toContainText('In Secondary Dojo');
    await expect(owner.locator('#historyPersonal')).toContainText('Secondary');
    await owner.getByTestId('pair-history-view-recap').first().click();
    await expect(owner.getByTestId('pair-recap-status')).toHaveText('Recap loaded');
    await expect(owner.locator('#pairRecapArea')).toContainText('In Secondary Dojo');
    await Promise.all([
      owner.waitForURL(`${golden.origin}/join/${secondary.room}`,{waitUntil:'domcontentloaded'}),
      owner.getByTestId('pair-recap-reopen').click(),
    ]);
    await expect(owner.getByTestId('workspace-circle')).toContainText('In Secondary Dojo');
    await expect.poll(()=>owner.evaluate(()=>(window as any)._randori_workspace?.room)).toBe(secondary.room);
    await expect(owner.getByTestId('pair-chat-input')).toBeVisible();
    await owner.getByTestId('pair-chat-input').fill('Secondary private chat');
    await owner.getByTestId('pair-chat-send').click();
    await expect(owner.getByTestId('pair-chat-list')).toContainText('Secondary private chat');
    await select(partner,golden.origin,secondary.publicId);
    const messages=await raw(partner,golden.origin,resource('messages',secondary.room));
    expect(messages.body.messages.map((row:any)=>row.message)).toContain('Secondary private chat');
    const signal=await raw(owner,golden.origin,'/api/video','POST',{room_id:secondary.room,from_id:'owner_peer',type:'join',payload:{name:'Owner'}});
    expect(signal.status,signal.text).toBe(200);
    expect((await raw(partner,golden.origin,resource('video',secondary.room))).body.signals).toHaveLength(1);
    const canonical=await raw(owner,golden.origin,resource('code-document',secondary.room));
    expect(canonical.status,canonical.text).toBe(200);
    await owner.locator('#questionSelect').selectOption('focus-block-rollup');
    await owner.locator('#langSelect').selectOption('javascript');
    await expect.poll(()=>owner.evaluate(()=>(window as any)._randori_crdt?.identity?.questionSlug),{timeout:15_000}).toBe('focus-block-rollup');
    await expect.poll(()=>owner.evaluate(()=>(window as any)._randori_crdt?.acknowledged),{timeout:15_000}).toBe(true);
    // Edit the live document only after hydration; a server-side merge can
    // otherwise race the browser's starter and execute a different document.
    await setCode(owner,FOCUS_BLOCK_ROLLUP_SOLUTION);
    const documentVersion=await owner.evaluate(()=>(window as any)._randori_crdt.flush());
    expect(documentVersion).toMatch(/^[a-f0-9]{64}$/);
    const execution=await raw(owner,golden.origin,'/api/execute','POST',{room_id:secondary.room,question_slug:'focus-block-rollup',question_version:1,language:'javascript',document_version:documentVersion,code:'ignored client code'});
    expect(execution.status,execution.text).toBe(200);expect(execution.body.passed_count).toBe(execution.body.total_count);
    const runs=await raw(partner,golden.origin,resource('runs',secondary.room));expect(runs.body.runs).toHaveLength(1);
    const completion=await raw(owner,golden.origin,resource('session-completion',secondary.room));
    expect(completion.body.completion.required_count).toBe(2);
    const first=await raw(owner,golden.origin,'/api/session-completion','POST',{room_id:secondary.room,action:'confirm',base_version:completion.body.completion.version});
    expect(first.body.completion.state).toBe('awaiting_participants');
    const other=await raw(partner,golden.origin,resource('session-completion',secondary.room));
    const done=await raw(partner,golden.origin,'/api/session-completion','POST',{room_id:secondary.room,action:'confirm',base_version:other.body.completion.version});
    expect(done.body.completion.state).toBe('completed');
    await select(owner,golden.origin,primary.public_id);
    expect((await raw(owner,golden.origin,resource('session-completion',pair.room))).body.completion.confirmed_count).toBe(0);
    expect((await raw(owner,golden.origin,resource('messages',pair.room))).body.messages).toHaveLength(0);
    await select(owner,golden.origin,solo.publicId);
    const soloState=await raw(owner,golden.origin,resource('session-completion',solo.room));expect(soloState.body.completion.required_count).toBe(1);
    expect(soloState.body.completion.version).not.toBe(completion.body.completion.version);
    const soloDone=await raw(owner,golden.origin,'/api/session-completion','POST',{room_id:solo.room,action:'confirm',base_version:soloState.body.completion.version});
    expect(soloDone.body.completion.state).toBe('completed');
    await withDatabase(golden,async db=>{
      await expect(db.execute({sql:'UPDATE circle_pairing_groups SET user_a_id=user_b_id WHERE id=?',args:[secondary.group.id]})).rejects.toThrow();
      await expect(db.execute({sql:'DELETE FROM circle_pairing_eligibility WHERE publication_id=?',args:[secondary.group.publication_id]})).rejects.toThrow();
      expect((await db.execute('SELECT COUNT(*) AS count FROM circle_chat_retention_scopes')).rows[0].count).toBe(1);
      const password=await bcrypt.hash('outsider-password-438',4);
      await db.execute({sql:`INSERT INTO auth_accounts(email,password_hash,display_name,color,is_available) VALUES('outsider438@example.test',?,'Outsider','#123456',0)`,args:[password]});
      const user=(await db.execute(`SELECT id FROM auth_accounts WHERE email='outsider438@example.test'`)).rows[0];
      await db.execute({sql:`INSERT INTO circle_memberships(circle_id,user_id,role,status) VALUES(?,?,'member','active')`,args:[(await db.execute('SELECT id FROM circles WHERE is_primary=1')).rows[0].id,user.id]});
    });
    const outsider=await newGoldenPage(browser,golden);
    await signInMemberSession(outsider.page,golden,'outsider438@example.test','outsider-password-438');
    for(const surface of reads)expect((await raw(outsider.page,golden.origin,resource(surface,secondary.room))).status,surface).toBe(404);
    for(const surface of writes)expect((await raw(outsider.page,golden.origin,`/api/${surface}`,'POST',{room_id:secondary.room})).status,surface).toBe(404);
    expect(golden.external).toEqual([]);expect(transport.unexpectedExternalRequests).toEqual([]);
  }finally{restore();transport.restore();await golden.close();}
});

test('real runtime: flag-off gates and delayed prior-circle responses, context writes and cross-tab switch fencing',async({browser})=>{
  const golden=await startGoldenRuntime('randori-438-switch-');let restore=()=>{};
  const previousProgress=process.env.PROGRESS_DASHBOARD_ENABLED;
  try{
    const pair=await createPairedCircle(browser,golden),owner=pair.owner.page;
    restore=enableWorkspace();process.env.PROGRESS_DASHBOARD_ENABLED='true';
    const primary=(await (await owner.request.get(`${golden.origin}/api/circles`)).json()).circles[0];
    const secondary=await withDatabase(golden,db=>seedSecondaryCircle(db,{users:[pair.owner.user.id,pair.member.user.id]}));
    await select(owner,golden.origin,secondary.publicId);
    process.env.SECONDARY_CIRCLE_WORKSPACE_ENABLED='false';
    const unavailable={error:'pairing and workspace features are not available for this circle context',code:'circle_feature_unavailable'};
    for(const surface of ['runs','history','progress','stats','pair-recap','session-completion','messages','execute','ai/history','video','code-document']){
      const response=await raw(owner,golden.origin,resource(surface,secondary.room),surface==='execute'?'POST':'GET',surface==='execute'?{room_id:secondary.room}:undefined);
      expect([response.status,response.body],surface).toEqual([409,unavailable]);
    }
    for(const surface of ['meeting-link','session-controls']){
      const response=await raw(owner,golden.origin,resource(surface,secondary.room));
      expect([response.status,response.body],surface).toEqual([400,{error:'canonical room_id required'}]);
    }
    process.env.SECONDARY_CIRCLE_WORKSPACE_ENABLED='true';await select(owner,golden.origin,primary.public_id);
    const before=(await (await owner.request.get(`${golden.origin}/api/circles`)).json()).context_version;
    const secondTab=await pair.owner.context.newPage();await secondTab.goto(golden.url,{waitUntil:'domcontentloaded'});
    await expect.poll(()=>secondTab.evaluate(()=>(window as any)._randori_circle_control?.scheduleContext?.()?.circlePublicId)).toBe(primary.public_id);
    await owner.evaluate(()=>{
      const originalFetch=window.fetch.bind(window);
      let release=()=>{};
      const gate=new Promise<void>(resolve=>release=resolve);
      (window as any)._438ReleaseHistory=release;
      (window as any)._438HistoryArrived=false;
      window.fetch=async(input,options)=>{
        const response=await originalFetch(input,options);
        const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.origin);
        if(url.pathname==='/api/history'&&!(window as any)._438HistoryArrived){
          (window as any)._438HistoryArrived=true;await gate;
        }
        return response;
      };
    });
    await owner.locator('[data-tab="history"]').click();
    await owner.waitForFunction(()=>(window as any)._438HistoryArrived===true);
    await switchBeforeReload(owner,secondary.publicId,async()=>{
      await owner.evaluate(()=>(window as any)._438ReleaseHistory());
      await owner.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      await expect(owner.locator('#historyPersonal [data-testid="pair-history-row"]')).toHaveCount(0);
    });
    await expect.poll(()=>secondTab.evaluate(()=>(window as any)._randori_circle_control?.scheduleContext?.()?.circlePublicId)).toBe(secondary.publicId);
    await owner.locator('[data-tab="history"]').click();
    await expect(owner.locator('#historyPersonal')).toContainText('Secondary Dojo');
    await expect(owner.locator('#historyPersonal [data-testid="pair-history-row"]')).toHaveCount(1);
    expect(await owner.locator('#historyPersonal [data-testid="pair-history-row"]').getAttribute('data-room-id')).toBe(secondary.room);
    const stale=await raw(owner,golden.origin,'/api/messages','POST',{room_id:pair.room,message:'stale must not commit'},before);
    expect(stale.status).toBe(409);expect(stale.body.code).toBe('circle_context_changed');
    await withDatabase(golden,async db=>expect((await db.execute(`SELECT COUNT(*) AS count FROM pair_messages WHERE message='stale must not commit'`)).rows[0].count).toBe(0));
    // A completed HTTP response must still be rejected when its body is consumed
    // after a selector switch, for both chat and completion pollers.
    for(const surface of ['messages','session-completion']){
      await select(owner,golden.origin,secondary.publicId);
      await owner.evaluate(async({surface,room})=>{
        const response=await fetch(`/api/${surface}?room_id=${encodeURIComponent(room)}`);
        if(response.status!==200)throw new Error('workspace response was not authorized');
        // Circle selection reloads the page; retain only the generic outcome
        // so the assertion observes the old document's abort after navigation.
        sessionStorage.setItem('_438Delayed','pending');
        (window as any)._438ReadBody=async()=>{
          try{
            await response.json();sessionStorage.setItem('_438Delayed','consumed');
            document.getElementById('historyPersonal')?.append('stale private workspace response');
          }catch(error){sessionStorage.setItem('_438Delayed',error.name);}
        };
      },{surface,room:secondary.room});
      await switchBeforeReload(owner,primary.public_id,async()=>{
        await owner.evaluate(()=>(window as any)._438ReadBody());
        expect(await owner.evaluate(()=>sessionStorage.getItem('_438Delayed'))).toBe('AbortError');
      });
      await expect.poll(()=>owner.evaluate(()=>sessionStorage.getItem('_438Delayed'))).toBe('AbortError');
      await expect(owner.locator('#historyPersonal')).not.toContainText('stale private workspace response');
      await expect(owner.locator('#workspaceChatArea [data-testid="pair-chat-input"]')).toHaveCount(0);
      expect(await owner.evaluate(()=>localStorage.getItem('randori-code'))).toBeNull();
    }
    // Losing membership invalidates a live workspace and clears private state.
    await select(owner,golden.origin,secondary.publicId);
    await owner.goto(`${golden.origin}/join/${secondary.room}`,{waitUntil:'domcontentloaded'});
    await expect.poll(()=>owner.evaluate(()=>(window as any)._randori_authorized_room)).toBe(secondary.room);
    await expect(owner.getByTestId('pair-chat-input')).toBeVisible();
    await owner.getByTestId('pair-chat-input').fill('private unsent draft');
    await withDatabase(golden,db=>db.execute({sql:"UPDATE circle_memberships SET status='inactive' WHERE circle_id=? AND user_id=?",args:[20,pair.owner.user.id]}));
    await owner.evaluate(async room=>{await fetch(`/api/messages?room_id=${encodeURIComponent(room)}`).then(response=>response.json()).catch(()=>{});},secondary.room);
    await expect.poll(()=>owner.evaluate(()=>(window as any)._randori_authorized_room)).toBeNull();
    await expect(owner.locator('#workspaceChatArea [data-testid="pair-chat-input"]')).toHaveCount(0);
    expect(await owner.evaluate(()=>localStorage.getItem('randori-code'))).toBeNull();
    await secondTab.close();
  }finally{restore();if(previousProgress===undefined)delete process.env.PROGRESS_DASHBOARD_ENABLED;else process.env.PROGRESS_DASHBOARD_ENABLED=previousProgress;await golden.close();}
});
