import AxeBuilder from '@axe-core/playwright';
import {BrowserContext,expect,Page,test} from '@playwright/test';

import {newGoldenPage,openSignin,signInOwner,startGoldenRuntime,waitForAppFetchesSettled,type GoldenRuntime} from './golden-runtime';

// Golden path 19 (ID-79): the public Privacy Policy and Terms of Service that
// Google's OAuth branding page links to. A signed-out visitor finds both from
// the landing page, each loads as its own static document (not the app shell)
// with a main heading and a way back, and neither page makes any API request:
// no /api/logs, no auth, nothing. A signed-in member reaches both from the
// account menu, in a new tab so a live call or room is never dropped. Runs on the real loopback runtime; Vercel serves the same
// files through cleanUrls (pinned by tests/unit/vercel-routing-contract.test.mjs).

const PAGES=[
  // The privacy policy was updated for the durable deletion ledger
  // (issue #383); the terms keep their earlier date.
  {path:'/privacy',heading:'Privacy Policy',landingLink:'landing-privacy-policy-link',menuItem:'Privacy Policy',updated:'28 October 2026'},
  {path:'/terms',heading:'Terms of Service',landingLink:'landing-terms-link',menuItem:'Terms of Service',updated:'22 October 2026'},
] as const;
// Everything a public page may load: itself, its stylesheet, the self-hosted
// font and the favicon. All same-origin; anything else is a regression.
const ALLOWED_PAGE_REQUESTS=new Set(['/privacy','/terms','/assets/legal.css',
  '/assets/fonts/geist-sans-latin-var.woff2','/assets/brand/favicon.svg']);

async function expectPublicPage(page:Page,golden:GoldenRuntime,item:typeof PAGES[number]){
  await expect(page).toHaveURL(`${golden.url}${item.path}`);
  await expect(page.getByRole('heading',{level:1,name:item.heading})).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await expect(page.getByText(`Last updated: ${item.updated}`)).toBeVisible();
  const back=page.getByTestId('public-page-back');
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href','/');
  await expect(page.getByRole('navigation',{name:'Legal'}).getByRole('link',{name:item.heading}))
    .toHaveAttribute('aria-current','page');
  // No script can run here, so nothing can call /api/logs or auth later on.
  expect(await page.evaluate(()=>document.scripts.length)).toBe(0);
  expect(await page.locator('#appMain').count()).toBe(0);
}

/** Loads a public page in a fresh tab and returns every same-origin path it requested. */
async function requestsMadeBy(context:BrowserContext,golden:GoldenRuntime,path:string){
  const page=await context.newPage();
  const paths:string[]=[];
  page.on('request',request=>{
    const url=new URL(request.url());
    if(url.origin===golden.origin) paths.push(url.pathname);
  });
  const response=await page.goto(`${golden.url}${path}`,{waitUntil:'load'});
  expect(response?.status(),path).toBe(200);
  expect(await page.evaluate(()=>document.scripts.length)).toBe(0);
  await page.close();
  return paths;
}

async function expectAccessible(page:Page,label:string){
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    for(const colorScheme of ['dark','light'] as const){
      await page.emulateMedia({colorScheme});
      const results=await new AxeBuilder({page})
        .withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']).analyze();
      expect(results.violations,`${label} ${width}px ${colorScheme}`).toEqual([]);
    }
  }
  await page.setViewportSize({width:1280,height:900});
  await page.emulateMedia({colorScheme:null});
}

test('a signed-out visitor opens the Privacy Policy and Terms from the landing page, and a member reaches them from the account menu',{tag:'@smoke'},async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-golden-public-pages-');
  try{
    // Raw HTTP, no cookies: 200, its own document with the page security headers, never the shell.
    for(const item of PAGES){
      const response=await fetch(new URL(item.path,golden.url),{redirect:'manual'});
      expect(response.status,item.path).toBe(200);
      expect(response.headers.get('content-type'),item.path).toContain('text/html');
      expect(response.headers.get('content-security-policy'),item.path).toContain("default-src 'self'");
      expect(response.headers.get('x-frame-options'),item.path).toBe('DENY');
      const html=await response.text();
      expect(html,item.path).toContain(`data-public-page="${item.path.slice(1)}"`);
      expect(html,item.path).not.toContain('id="appMain"');
      expect(html,item.path).not.toMatch(/<script\b/i);
    }

    const {context,page}=await newGoldenPage(browser,golden);
    const pageErrors:string[]=[];
    page.on('pageerror',error=>pageErrors.push(error.message));

    for(const item of PAGES){
      await page.goto(`${golden.url}/`,{waitUntil:'domcontentloaded'});
      await expect(page.locator('#view-landing')).toBeVisible();
      // Let the boot fetches settle before navigating away (see
      // waitForAppFetchesSettled): WebKit reports a pageerror for a fetch
      // aborted by navigation, even though the app catches it.
      await waitForAppFetchesSettled(page);
      const link=page.getByTestId(item.landingLink);
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href',item.path);
      const navigation=page.waitForResponse(response=>new URL(response.url()).pathname===item.path
        &&response.request().isNavigationRequest());
      await link.click();
      expect((await navigation).status(),item.path).toBe(200);
      await expectPublicPage(page,golden,item);
      await expectAccessible(page,item.path);
      // The back link returns to the signed-out landing page.
      await page.getByTestId('public-page-back').click();
      await expect(page).toHaveURL(`${golden.url}/`);
      await expect(page.locator('#view-landing')).toBeVisible();
      // Let the boot fetches settle before the next navigation (see
      // waitForAppFetchesSettled).
      await waitForAppFetchesSettled(page);
    }

    // The in-page privacy note links the full policy too.
    await page.locator('#landingPrivacy summary').click();
    await expect(page.locator('#landingPrivacy').getByRole('link',{name:'Privacy Policy'})).toHaveAttribute('href','/privacy');
    await expect(page.locator('#landingPrivacy').getByRole('link',{name:'Terms of Service'})).toHaveAttribute('href','/terms');

    // Loaded on their own, the pages request nothing beyond their static files.
    for(const item of PAGES){
      const paths=await requestsMadeBy(context,golden,item.path);
      expect(paths[0]).toBe(item.path);
      expect(paths.filter(path=>path.startsWith('/api/')),item.path).toEqual([]);
      expect(paths.filter(path=>!ALLOWED_PAGE_REQUESTS.has(path)),item.path).toEqual([]);
    }

    // The sign-in dialog does not show the sign-up legal line (sign-up does: golden-runtime's
    // acceptInvitationThroughUi checks it on the invitation journeys).
    await openSignin(page);
    await expect(page.locator('#authLegal')).toBeHidden();

    // A signed-in member opens both from the account menu in a new tab; the app tab stays put.
    await signInOwner(page,golden);
    const appUrl=page.url();
    for(const item of PAGES){
      await page.locator('#meLabel').click();
      const menuItem=page.getByRole('menu',{name:'Account'}).getByRole('menuitem',{name:item.menuItem,exact:true});
      await expect(menuItem).toBeVisible();
      await expect(menuItem).toHaveAttribute('href',item.path);
      await expect(menuItem).toHaveAttribute('target','_blank');
      const opened=context.waitForEvent('page');
      await menuItem.click();
      const legalPage=await opened;
      await legalPage.waitForLoadState('load');
      await expectPublicPage(legalPage,golden,item);
      await legalPage.close();
      expect(page.url()).toBe(appUrl);
      await expect(page.locator('#meLabel')).toBeVisible();
    }
    const signedIn=await requestsMadeBy(context,golden,'/privacy');
    expect(signedIn.filter(path=>path.startsWith('/api/'))).toEqual([]);

    expect(pageErrors,pageErrors.join('\n')).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    await golden.close();
  }
});
