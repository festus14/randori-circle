import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {expect,test} from '@playwright/test';

import {newGoldenPage,repositoryRoot,startGoldenRuntime} from './golden-runtime';

// Golden path 12: every client route serves the single-page app and boots into
// its own landing state, on the real loopback runtime and on the static
// checkout server the rest of the suite uses. Vercel's own routing cannot run
// here; its SPA fallback is pinned by `npm run check:deployability` and the
// rewrite assertion below.

const CLIENT_ROUTES=[
  {path:'/',ready:'#view-landing'},
  {path:'/invite',ready:'[data-testid="invite-landing"]'},
  {path:'/verify',ready:'[data-testid="activation-landing"]'},
  {path:'/reset-password',ready:'[data-testid="password-reset-landing"]'},
  {path:'/join/week_1_pair_1',ready:'#authOverlay'},
] as const;

test('every client route serves the app shell and boots its landing state on the real runtime',async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-golden-routes-');
  try{
    for(const route of CLIENT_ROUTES){
      const response=await fetch(new URL(route.path,golden.url));
      expect(response.status,route.path).toBe(200);
      expect(response.headers.get('content-type'),route.path).toContain('text/html');
      expect(response.headers.get('content-security-policy'),route.path).toBeTruthy();
      const html=await response.text();
      expect(html,route.path).toContain('id="view-landing"');
      expect(html,route.path).toContain('id="authOverlay"');
    }
    for(const probe of ['/api/health/live','/api/healthz']){
      const response=await fetch(new URL(probe,golden.url));
      expect(response.status,probe).toBe(200);
    }

    const {page}=await newGoldenPage(browser,golden);
    const pageErrors:string[]=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    for(const route of CLIENT_ROUTES){
      await page.goto(`${golden.url}${route.path}`,{waitUntil:'domcontentloaded'});
      await expect(page.locator(route.ready),route.path).toBeVisible();
    }
    // A signed-out room link keeps its URL and asks for sign-in.
    await expect(page).toHaveURL(`${golden.url}/join/week_1_pair_1`);
    await expect(page.getByRole('dialog',{name:'Sign in to join your pairing room'})).toBeVisible();
    expect(pageErrors,pageErrors.join('\n')).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});

test('the static checkout server and the Vercel config route every client path to the app',async({request})=>{
  for(const route of CLIENT_ROUTES){
    const response=await request.get(route.path);
    expect(response.status(),route.path).toBe(200);
    expect(await response.text(),route.path).toContain('id="view-landing"');
  }
  const vercel=JSON.parse(readFileSync(join(repositoryRoot,'vercel.json'),'utf8')) as {
    cleanUrls?:boolean;rewrites?:Array<{source:string;destination:string}>;
  };
  const fallback=vercel.rewrites?.at(-1);
  expect(fallback).toEqual({source:'/(.*)',destination:'/'});
  for(const route of CLIENT_ROUTES.filter(item=>item.path!=='/')){
    const earlier=vercel.rewrites!.slice(0,-1).find(rewrite=>{
      const pattern=new RegExp(`^${rewrite.source.replace(/:\w+\*?/g,'[^/]+').replace(/\(\.\*\)/g,'.*')}$`);
      return pattern.test(route.path);
    });
    expect(earlier,`${route.path} must reach the SPA fallback`).toBeUndefined();
  }
});
