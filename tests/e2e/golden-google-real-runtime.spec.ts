import {expect,Page,test} from '@playwright/test';

import {GOOGLE_TEST_JWKS,googleTestIdToken} from '../support/google-oidc.mjs';
import {
  GoldenRuntime,
  LOCAL_OWNER_NAME,
  createInvitationThroughUi,
  json,
  newGoldenPage,
  openApp,
  openSignin,
  pathIs,
  signInOwner,
  signOutThroughMenu,
  startGoldenRuntime,
  withDatabase,
} from './golden-runtime';

// Golden path 4: Google sign-in and Google account linking from Account
// security, against the real loopback runtime and database. Google itself is
// replaced only at its network boundary, exactly as the unit suite does:
//   - the browser's navigation to accounts.google.com is answered by a route
//     that immediately redirects back to the real /api/auth/google/callback
//     with a one-time code and the state Randori generated;
//   - the server's token and JWKS requests are answered in-process with an
//     RS256 ID token bound to the nonce Randori generated.
// Linking is exercised with an old and with a missing auth_time (ID-63): Google
// does not force re-entry for an already signed-in device, so Randori must rely
// on its own recent authentication instead of a fresh Google auth_time.

const CLIENT_ID='golden-google-client';
const GOOGLE_TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT='https://www.googleapis.com/oauth2/v3/certs';

type GoogleAccount={sub:string;email:string;name:string;authTime:'old'|'missing'|'fresh'};

function installGoogleProvider(page:Page,golden:GoldenRuntime){
  const nativeFetch=globalThis.fetch;
  const pending=new Map<string,{nonce:string;account:GoogleAccount}>();
  const authorizations:Array<{prompt:string|null;maxAge:string|null;account:string}>=[];
  const unexpected:string[]=[];
  let nextAccount:GoogleAccount|null=null;
  let sequence=0;

  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(new URL(url).origin===golden.origin) return nativeFetch(input,init);
    if(url===GOOGLE_TOKEN_ENDPOINT&&init?.method==='POST'){
      const body=new URLSearchParams(String(init.body||''));
      const grant=pending.get(String(body.get('code')));
      pending.delete(String(body.get('code')));
      if(!grant||body.get('client_id')!==CLIENT_ID||body.get('grant_type')!=='authorization_code'
        ||!body.get('code_verifier')||body.get('redirect_uri')!==`${golden.origin}/api/auth/google/callback`){
        return new Response(JSON.stringify({error:'invalid_grant'}),{status:400});
      }
      const now=Math.floor(Date.now()/1000);
      const claims:Record<string,unknown>={aud:CLIENT_ID,sub:grant.account.sub,email:grant.account.email,
        name:grant.account.name,nonce:grant.nonce};
      if(grant.account.authTime==='old') claims.auth_time=now-7*24*3600;
      else if(grant.account.authTime==='fresh') claims.auth_time=now;
      return new Response(JSON.stringify({id_token:googleTestIdToken(claims)}),{status:200});
    }
    if(url===GOOGLE_JWKS_ENDPOINT) return new Response(JSON.stringify(GOOGLE_TEST_JWKS),{status:200});
    unexpected.push(url);
    throw new Error(`unexpected server-side network request: ${url}`);
  }) as typeof fetch;

  // Answers Google's authorization step: records the request and returns the
  // real Randori callback URL carrying a one-time code and the original state.
  const authorize=(authorizationUrl:string)=>{
    const authorization=new URL(authorizationUrl);
    const account=nextAccount;
    nextAccount=null;
    if(!account||authorization.origin!=='https://accounts.google.com'||authorization.pathname!=='/o/oauth2/v2/auth'
      ||authorization.searchParams.get('client_id')!==CLIENT_ID
      ||authorization.searchParams.get('code_challenge_method')!=='S256'){
      unexpected.push(authorizationUrl);
      return null;
    }
    const code=`golden-google-code-${++sequence}`;
    pending.set(code,{nonce:String(authorization.searchParams.get('nonce')),account});
    authorizations.push({prompt:authorization.searchParams.get('prompt'),
      maxAge:authorization.searchParams.get('max_age'),account:account.sub});
    const callback=new URL(String(authorization.searchParams.get('redirect_uri')));
    callback.searchParams.set('code',code);
    callback.searchParams.set('state',String(authorization.searchParams.get('state')));
    return callback.href;
  };
  // Registered after the origin guard in newGoldenPage, so these take
  // precedence. Linking navigates to Google directly from the page...
  const routedAuthorization=page.context().route('https://accounts.google.com/**',async route=>{
    const callback=authorize(route.request().url());
    if(!callback) return route.abort('blockedbyclient');
    return route.fulfill({status:302,headers:{location:callback},body:''});
  });
  // ...while sign-in reaches Google through a server redirect, which routes
  // never observe. Let the real start endpoint run, keep its transaction
  // cookie, and replace only the hop to Google.
  const routedStart=page.context().route(`${golden.origin}/api/auth/google/start**`,async route=>{
    const response=await route.fetch({maxRedirects:0});
    const location=response.headers().location||'';
    if(response.status()!==302||!location.startsWith('https://accounts.google.com/')) return route.fulfill({response});
    const callback=authorize(location);
    if(!callback) return route.abort('blockedbyclient');
    const cookies=response.headersArray().filter(header=>header.name.toLowerCase()==='set-cookie').map(header=>header.value);
    return route.fulfill({status:302,body:'',headers:{location:callback,...(cookies.length?{'set-cookie':cookies.join('\n')}:{})}});
  });
  return {
    ready:Promise.all([routedAuthorization,routedStart]),
    authorizations,
    unexpected,
    choose(account:GoogleAccount){ nextAccount=account; },
    restore(){ globalThis.fetch=nativeFetch; },
  };
}

/**
 * Production-shaped Google configuration for an in-process runtime (the
 * loopback adapter deliberately never advertises Google). Same handlers and
 * database; the runtime restores every one of these keys when it closes.
 */
function enableProductionGoogle(){
  process.env.RANDORI_LOCAL_RUNTIME='false';
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  process.env.GOOGLE_CLIENT_ID=CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET='golden-google-secret';
}

async function openAccountSecurity(page:Page){
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  const dialog=page.getByRole('dialog',{name:'Account security'});
  await expect(dialog).toBeVisible();
  return dialog;
}

test('Google links from Account security with an old or missing auth_time and then signs the member in',async({browser})=>{
  test.setTimeout(120_000);
  const golden=await startGoldenRuntime('randori-golden-google-');
  enableProductionGoogle();
  const {page}=await newGoldenPage(browser,golden);
  const google=installGoogleProvider(page,golden);
  page.on('dialog',dialog=>dialog.accept());
  const identities=async()=>withDatabase(golden,async db=>(await db.execute(
    `SELECT subject,user_id FROM auth_provider_identities ORDER BY subject`)).rows.map(row=>({...row})));
  try{
    await google.ready;
    const owner=await signInOwner(page,golden);

    // 1. Link with an old auth_time (Google reused an existing device session).
    let dialog=await openAccountSecurity(page);
    await expect(page.locator('#identityPasswordState')).toHaveText('linked');
    await expect(page.locator('#identityGoogleState')).toHaveText('not linked');
    await expect(page.locator('#identityGoogleAction')).toHaveText('Link Google');
    google.choose({sub:'golden-google-old',email:'owner@randori.test',name:LOCAL_OWNER_NAME,authTime:'old'});
    await page.locator('#identityGoogleAction').click();
    await expect(page).toHaveURL(`${golden.url}/`);
    dialog=page.getByRole('dialog',{name:'Account security'});
    await expect(dialog).toBeVisible();
    await expect(page.locator('#identityGoogleState')).toHaveText('linked');
    expect(await identities()).toEqual([{subject:'golden-google-old',user_id:owner.id}]);

    // 2. Sign out, then sign in with Google through the sign-in dialog.
    await page.locator('#identityClose').click();
    await expect(dialog).toBeHidden();
    await signOutThroughMenu(page);
    await openSignin(page);
    await expect(page.locator('#authGoogle')).toBeVisible();
    google.choose({sub:'golden-google-old',email:'owner@randori.test',name:LOCAL_OWNER_NAME,authTime:'old'});
    await page.locator('#authGoogle').click();
    await expect(page).toHaveURL(`${golden.url}/`);
    await expect(page.locator('#meLabel')).toContainText(LOCAL_OWNER_NAME);

    // 3. Remove Google, then link again when Google omits auth_time entirely.
    dialog=await openAccountSecurity(page);
    await expect(page.locator('#identityGoogleAction')).toHaveText('Remove Google');
    const unlinked=page.waitForResponse(pathIs('/api/auth/identities/google','POST'));
    await page.locator('#identityGoogleAction').click();
    expect((await unlinked).status()).toBe(200);
    await expect(page.locator('#identityGoogleState')).toHaveText('not linked');
    expect(await identities()).toEqual([]);
    google.choose({sub:'golden-google-missing',email:'owner@randori.test',name:LOCAL_OWNER_NAME,authTime:'missing'});
    await page.locator('#identityGoogleAction').click();
    await expect(page).toHaveURL(`${golden.url}/`);
    await expect(page.getByRole('dialog',{name:'Account security'})).toBeVisible();
    await expect(page.locator('#identityGoogleState')).toHaveText('linked');
    expect(await identities()).toEqual([{subject:'golden-google-missing',user_id:owner.id}]);

    // Linking asked Google for explicit account selection each time.
    expect(google.authorizations.map(item=>[item.account,item.prompt])).toEqual([
      ['golden-google-old','select_account'],
      ['golden-google-old',null],
      ['golden-google-missing','select_account'],
    ]);
    expect(google.unexpected).toEqual([]);
    // The only off-origin requests are the two direct link navigations, which
    // were answered locally and never reached Google.
    expect(golden.external.map(url=>new URL(url).origin+new URL(url).pathname)).toEqual([
      'https://accounts.google.com/o/oauth2/v2/auth','https://accounts.google.com/o/oauth2/v2/auth',
    ]);
  }finally{
    google.restore();
    await golden.close();
  }
});

test('an unlinked Google account with the same email is told to use its password and gains no identity',async({browser})=>{
  test.setTimeout(60_000);
  const golden=await startGoldenRuntime('randori-golden-google-conflict-');
  enableProductionGoogle();
  const {page}=await newGoldenPage(browser,golden);
  const google=installGoogleProvider(page,golden);
  try{
    await google.ready;
    await openApp(page,golden);
    await openSignin(page);
    await expect(page.locator('#authGoogle')).toBeVisible();
    google.choose({sub:'golden-google-stranger',email:'owner@randori.test',name:'Stranger',authTime:'fresh'});
    await page.locator('#authGoogle').click();
    await expect(page).toHaveURL(`${golden.url}/`);
    await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
    await expect(page.locator('#authErr')).toHaveText('This email already uses password sign-in. Sign in with your password.');
    await expect(page.locator('#meLabel')).toBeHidden();
    expect(await withDatabase(golden,async db=>Number((await db.execute(
      `SELECT COUNT(*) AS n FROM auth_provider_identities`)).rows[0].n))).toBe(0);
    expect(google.unexpected).toEqual([]);
    expect(golden.external).toEqual([]);
  }finally{
    google.restore();
    await golden.close();
  }
});

test('an invited member signs up with Google from the invitation and lands in the circle',async({browser})=>{
  test.setTimeout(90_000);
  const golden=await startGoldenRuntime('randori-golden-google-invite-');
  const owner=await newGoldenPage(browser,golden);
  const {page}=await newGoldenPage(browser,golden);
  let google:ReturnType<typeof installGoogleProvider>|null=null;
  try{
    await signInOwner(owner.page,golden);
    const {inviteUrl}=await createInvitationThroughUi(owner.page,golden,'google.invitee@example.test');
    enableProductionGoogle();
    google=installGoogleProvider(page,golden);
    await google.ready;

    await page.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
    await expect(page).toHaveURL(`${golden.url}/invite`);
    await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
    google.choose({sub:'golden-google-invitee',email:'google.invitee@example.test',name:'Google Invitee',authTime:'fresh'});
    await page.getByTestId('invite-continue').click();
    await expect(page.locator('#meLabel')).toContainText('Google Invitee');
    const circle=await json(page,'/api/circle');
    expect(circle.status).toBe(200);
    expect(circle.body).toMatchObject({ok:true,membership:{role:'member'},count:2});
    expect(await withDatabase(golden,async db=>(await db.execute(
      `SELECT identity.subject,account.email FROM auth_provider_identities identity
        JOIN auth_accounts account ON account.id=identity.user_id`)).rows.map(row=>({...row}))))
      .toEqual([{subject:'golden-google-invitee',email:'google.invitee@example.test'}]);
    // The consumed invitation cannot be replayed by anyone else.
    const replay=await newGoldenPage(browser,golden);
    await replay.page.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
    await expect(replay.page.getByTestId('invite-status')).toContainText('unavailable');
    expect(google.authorizations.map(item=>item.prompt)).toEqual(['select_account']);
    expect(google.unexpected).toEqual([]);
  }finally{
    google?.restore();
    await golden.close();
  }
});
