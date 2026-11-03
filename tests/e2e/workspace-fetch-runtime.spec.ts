import {expect,test} from '@playwright/test';
import {LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD,json,newGoldenPage,signInMemberSession,startGoldenRuntime} from './golden-runtime';
import {enableWorkspace} from '../support/secondary-workspace-fixture.mjs';

test('flag-off wrapped fetch preserves an explicit current header despite a stale browser context',async({browser})=>{
  const restore=enableWorkspace();
  process.env.SECONDARY_CIRCLE_WORKSPACE_ENABLED='false';
  const golden=await startGoldenRuntime('randori-438-fetch-header-');
  try{
    const {page,context}=await newGoldenPage(browser,golden);
    await context.addInitScript(()=>{ (window as any)._nativeFetch=window.fetch.bind(window); });
    const user=await signInMemberSession(page,golden,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD);
    await expect.poll(()=>page.evaluate(()=>(window as any)._randori_circle_control?.scheduleContext?.()?.contextVersion)).toBe(0);
    expect(await page.evaluate(()=>(window as any).RandoriWorkspaceScope.enabled())).toBe(false);
    // An API caller can advance the session without refreshing the UI cache.
    const created=await json(page,'/api/circles','POST',{name:'Fetch Header Circle',request_id:'workspace-fetch-header-0001'});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    expect(created.body.context_version).toBe(1);
    expect(await page.evaluate(async id=>(window as any)._randori_circle_control.capturePairing(id),user.id)).toMatchObject({contextVersion:0});
    const transmitted:string[]=[];
    page.on('request',request=>{
      if(new URL(request.url()).pathname==='/api/my-pair') transmitted.push(request.headers()['x-randori-circle-context-version']);
    });
    const probe=await page.evaluate(async()=>{
      const headers={'X-Randori-Circle-Context-Version':'1'};
      const native=await (window as any)._nativeFetch('/api/my-pair',{headers});
      const wrapped=await fetch('/api/my-pair',{headers});
      return {native:native.status,wrapped:wrapped.status,body:await wrapped.json()};
    });
    console.log('[workspace-fetch probe]',JSON.stringify({cached:0,current:1,transmitted,...probe}));
    expect(probe.native).toBe(200);
    expect(probe.wrapped,JSON.stringify(probe.body)).toBe(200);
    expect(transmitted).toEqual(['1','1']);
  }finally{ await golden.close();restore(); }
});
