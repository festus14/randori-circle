import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

import {createClient} from '@libsql/client';
import {Browser,BrowserContext,expect,Page} from '@playwright/test';

import {deliverPairingEmails} from '../../api/_pairing-email.js';
import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_NAME,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';
import {expectInviteGateLoaded,stageRealRuntimeClient} from './real-runtime-fixture';

// Shared harness for the golden-path journeys (docs/testing/E2E_GOLDEN_PATHS.md).
//
// Every journey runs against the real loopback runtime: the production request
// handlers, checked-in migrations and a private file-backed SQLite database.
// No API route is mocked. Browser traffic is confined to the runtime origin;
// the only replaced boundaries are the ones a real user never sees directly
// (email delivery is captured in-process, code execution is served by a
// deterministic local transport behind a reserved `.invalid` provider URL, and
// Google is replaced at its network endpoints by the Google spec).
//
// Selectors are restricted to ids, data-testid and role/name so the in-flight
// visual redesign cannot break these journeys.

export const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
export const silentLogger=Object.freeze({log(){},error(){}});
export const workerOptions=Object.freeze({heartbeatIntervalMs:0,leaseDurationMs:1000});
export const MEMBER_PASSWORD='golden-member-password';
export {LOCAL_OWNER_EMAIL,LOCAL_OWNER_NAME,LOCAL_OWNER_PASSWORD};

export type Runtime=Awaited<ReturnType<typeof startLocalDevelopmentServer>>;
export type SafeUser={id:number;email:string;name:string;is_admin:boolean};
export type CapturedEmail={to:string;subject:string;html:string};

export type GoldenRuntime={
  rootDir:string;
  databaseUrl:string;
  config:ReturnType<typeof resolveLocalServerConfig>;
  runtime:Runtime;
  url:string;
  origin:string;
  external:string[];
  close:()=>Promise<void>;
};

export async function startGoldenRuntime(prefix:string):Promise<GoldenRuntime>{
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),prefix)));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  stageRealRuntimeClient(repositoryRoot,rootDir);
  const databaseUrl=pathToFileURL(join(rootDir,'.local','randori.sqlite')).href;
  const config=resolveLocalServerConfig({rootDir,argv:[],env:{
    NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
  }});
  let runtime:Runtime;
  try{ runtime=await startLocalDevelopmentServer({config,logger:silentLogger}); }
  catch(error){ rmSync(rootDir,{recursive:true,force:true}); throw error; }
  const url=runtime.url as string;
  const contexts:BrowserContext[]=[];
  const golden:GoldenRuntime={
    rootDir,databaseUrl,config,runtime,url,origin:new URL(url).origin,external:[],
    close:async()=>{
      await Promise.all(contexts.map(context=>context.close().catch(()=>{})));
      await runtime.close();
      rmSync(rootDir,{recursive:true,force:true});
    },
  };
  (golden as GoldenRuntime&{contexts:BrowserContext[]}).contexts=contexts;
  return golden;
}

/**
 * A fresh, isolated browser identity bound to the runtime origin. Requests to
 * any other origin are recorded and aborted so a journey can never silently
 * depend on (or leak to) the internet.
 */
export async function newGoldenPage(browser:Browser,golden:GoldenRuntime,options:Parameters<Browser['newContext']>[0]={}){
  const context=await browser.newContext(options);
  (golden as GoldenRuntime&{contexts:BrowserContext[]}).contexts.push(context);
  // Routes do not see redirect hops, so record every request (including
  // server-issued redirects) and additionally abort direct off-origin fetches.
  context.on('request',request=>{
    const url=request.url();
    if(/^https?:\/\//.test(url)&&new URL(url).origin!==golden.origin) golden.external.push(url);
  });
  await context.route(/^https?:\/\//,route=>{
    const target=new URL(route.request().url());
    if(target.origin===golden.origin) return route.continue();
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(()=>{
    localStorage.setItem('randori-onboarded','1');
    localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1');
    localStorage.setItem('randori-landing-dismissed','1');
  });
  const page=await context.newPage();
  return {context,page};
}

export async function json(page:Page,path:string,method='GET',body?:unknown){
  return page.evaluate(async input=>{
    const response=await fetch(input.path,{method:input.method,credentials:'same-origin',cache:'no-store',
      ...(input.body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(input.body)})});
    return {status:response.status,body:await response.json().catch(()=>null)} as {status:number;body:any};
  },{path,method,body});
}

export function pathIs(pathname:string,method?:string){
  return (response:{url():string;request():{method():string}})=>
    new URL(response.url()).pathname===pathname&&(!method||response.request().method()===method);
}

export async function openApp(page:Page,golden:GoldenRuntime,path='/'){
  await page.goto(`${golden.url}${path}`,{waitUntil:'domcontentloaded'});
  await expectInviteGateLoaded(page);
}

export async function openSignin(page:Page){
  await page.evaluate(()=>(window as any)._randori_auth.openModal('signin'));
  await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
}

/** Signs in through the visible form and returns the login response. */
export async function signInThroughForm(page:Page,email:string,password:string,{open=true}={}){
  if(open) await openSignin(page);
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPass').fill(password);
  const login=page.waitForResponse(pathIs('/api/auth/login','POST'));
  await page.locator('#authSignin').click();
  return login;
}

export async function signInOwner(page:Page,golden:GoldenRuntime){
  await openApp(page,golden);
  const login=await signInThroughForm(page,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD);
  const payload=await login.json();
  expect(login.status(),JSON.stringify(payload)).toBe(200);
  await expect(page.locator('#meLabel')).toContainText(LOCAL_OWNER_NAME);
  return payload.user as SafeUser;
}

/** Re-establishes a known member session in a context without UI ceremony. */
export async function signInMemberSession(page:Page,golden:GoldenRuntime,email:string,password=MEMBER_PASSWORD){
  await openApp(page,golden);
  const login=await json(page,'/api/auth/login','POST',{email,password});
  expect(login.status,JSON.stringify(login.body)).toBe(200);
  await openApp(page,golden);
  return login.body.user as SafeUser;
}

export async function signOutThroughMenu(page:Page,{everywhere=false}={}){
  await page.locator('#meLabel').click();
  const item=page.getByRole('menuitem',{name:everywhere?'Sign out everywhere':'Sign out',exact:true});
  await expect(item).toBeVisible();
  const logout=page.waitForResponse(pathIs(everywhere?'/api/auth/logout-all':'/api/auth/logout','POST'));
  const reloaded=page.waitForEvent('domcontentloaded');
  await item.click();
  expect((await logout).status()).toBe(200);
  await reloaded;
  await expectInviteGateLoaded(page);
  await expect(page.locator('#authBtn')).toBeVisible();
}

export async function createInvitationThroughUi(page:Page,golden:GoldenRuntime,email:string){
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-invite-email')).toBeVisible();
  await page.getByTestId('circle-invite-email').fill(email);
  const created=page.waitForResponse(pathIs('/api/invitations','POST'));
  await page.getByTestId('circle-invite-create').click();
  const response=await created;
  const payload=await response.json();
  expect(response.status(),JSON.stringify(payload)).toBe(201);
  const inviteUrl=new URL(String(payload.invitation?.invite_url||''),golden.url);
  expect(inviteUrl.pathname).toBe('/invite');
  expect(inviteUrl.hash).toMatch(/^#invite=[A-Za-z0-9_-]{43}$/);
  return {inviteUrl,invitationId:String(payload.invitation.id)};
}

export async function acceptInvitationThroughUi(page:Page,golden:GoldenRuntime,inviteUrl:URL,user:{email:string;name:string}){
  await page.goto(inviteUrl.href,{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(`${golden.url}/invite`);
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('dialog',{name:'Join Randori Circle'})).toBeVisible();
  await page.locator('#authEmail').fill(user.email);
  await page.locator('#authName').fill(user.name);
  await page.locator('#authPass').fill(MEMBER_PASSWORD);
  const signup=page.waitForResponse(pathIs('/api/auth/signup','POST'));
  await page.locator('#authSignup').click();
  const response=await signup;
  const payload=await response.json();
  expect(response.status(),JSON.stringify(payload)).toBe(200);
  await expect(page.locator('#meLabel')).toContainText(user.name);
  const profile=await json(page,'/api/profile','POST',{
    display_name:user.name,bio:'Golden path member.',tz:'UTC',interview_focus:'both',
  });
  expect(profile.status,JSON.stringify(profile.body)).toBe(200);
  return payload.user as SafeUser;
}

export async function openDashboard(page:Page){
  await page.evaluate(async()=>{
    const journey=(window as any)._randori_journey;
    if(!journey?.showDashboard) throw new Error('dashboard journey unavailable');
    await journey.showDashboard();
  });
  await expect(page.locator('#view-dashboard')).toBeVisible();
}

export async function currentRoom(page:Page){
  return page.evaluate(()=>(window as any)._randori_schedule?.room||null) as Promise<string|null>;
}

export type PairedCircle={
  owner:{page:Page;context:BrowserContext;user:SafeUser};
  member:{page:Page;context:BrowserContext;user:SafeUser;email:string;name:string};
  room:string;
};

/**
 * Owner invites a member through the Circle tab, the member signs up from the
 * invitation, and the owner publishes the current cycle from the Pairing tab.
 * Returns both signed-in browsers already showing the shared pair.
 */
export async function createPairedCircle(browser:Browser,golden:GoldenRuntime,{
  memberEmail='golden.partner@example.test',memberName='Golden Partner',
  ownerContextOptions={},memberContextOptions={},
}:{memberEmail?:string;memberName?:string;
  ownerContextOptions?:Parameters<Browser['newContext']>[0];
  memberContextOptions?:Parameters<Browser['newContext']>[0];}={}):Promise<PairedCircle>{
  const owner=await newGoldenPage(browser,golden,ownerContextOptions);
  const member=await newGoldenPage(browser,golden,memberContextOptions);
  const ownerUser=await signInOwner(owner.page,golden);
  const {inviteUrl}=await createInvitationThroughUi(owner.page,golden,memberEmail);
  const memberUser=await acceptInvitationThroughUi(member.page,golden,inviteUrl,{email:memberEmail,name:memberName});

  await owner.page.locator('[data-tab="pair"]').click();
  await expect(owner.page.locator('#newWeekBtn')).toBeVisible();
  const published=owner.page.waitForResponse(pathIs('/api/pairing/run','POST'));
  await owner.page.locator('#newWeekBtn').click();
  const publication=await published;
  const publicationBody=await publication.json();
  expect(publication.status(),JSON.stringify(publicationBody)).toBe(200);
  expect(publicationBody).toMatchObject({ok:true,pair_count:1,participant_count:2});

  await Promise.all([openDashboard(owner.page),openDashboard(member.page)]);
  await expect(owner.page.locator('#dashPairArea')).toContainText(memberName);
  await expect(member.page.locator('#dashPairArea')).toContainText(LOCAL_OWNER_NAME);
  for(const page of [owner.page,member.page]){
    await expect.poll(()=>currentRoom(page)).toMatch(/^week_[1-9]\d*_pair_[1-9]\d*$/);
  }
  const room=String(await currentRoom(owner.page));
  expect(await currentRoom(member.page)).toBe(room);
  return {
    owner:{...owner,user:ownerUser},
    member:{...member,user:memberUser,email:memberEmail,name:memberName},
    room,
  };
}

/** Drains queued pairing emails through the production worker into memory. */
export async function capturePairingEmails(golden:GoldenRuntime){
  const db=createClient({url:golden.databaseUrl});
  const sent:CapturedEmail[]=[];
  try{
    const result=await deliverPairingEmails({db,baseUrl:golden.url,localRuntime:true,workerId:'golden-pairing',
      workerOptions,send:async(message:CapturedEmail)=>{
        sent.push(message);
        return {providerName:'local-capture',providerMessageId:`golden-pairing-${sent.length}`};
      }});
    expect(result.delivered).toBe(sent.length);
  }finally{ db.close(); }
  return sent;
}

export function emailLinks(message:CapturedEmail){
  return [...message.html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1].replaceAll('&amp;','&'));
}

export async function withDatabase<T>(golden:GoldenRuntime,action:(db:ReturnType<typeof createClient>)=>Promise<T>){
  const db=createClient({url:golden.databaseUrl});
  try{ return await action(db); }
  finally{ db.close(); }
}

export async function waitForWorkspace(page:Page,room:string){
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>{
    const workspace=(window as any)._randori_workspace;
    return {room:workspace?.room||null,hydrated:workspace?.hydrated===true};
  }),{timeout:15_000}).toEqual({room,hydrated:true});
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#codeSyncStatus')).toHaveText('synced',{timeout:15_000});
}

// ---------------------------------------------------------------------------
// Deterministic execution transport
// ---------------------------------------------------------------------------

export const E2E_EXECUTION_API_URL='https://execution.e2e.invalid/api/v2/execute';

/**
 * Points the production execution gateway at its self-hosted
 * Piston-compatible provider (a reserved `.invalid` host). The local runtime
 * clears execution configuration at start, so call this after starting it.
 */
export function configureExecutionProvider(){
  process.env.EXECUTION_PROVIDER='piston';
  process.env.EXECUTION_API_URL=E2E_EXECUTION_API_URL;
}

function executeLocalHarness(source:string){
  return new Promise<{stdout:string;stderr:string;code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=commonjs'],{stdio:['pipe','pipe','pipe']});
    const stdout:Buffer[]=[];
    const stderr:Buffer[]=[];
    let bytes=0;
    let settled=false;
    const finish=(error:Error|null,code:number|null=null,signal:NodeJS.Signals|null=null)=>{
      if(settled) return;
      settled=true;
      clearTimeout(timer);
      if(error) reject(error);
      else resolve({stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),code,signal});
    };
    const capture=(target:Buffer[])=>(chunk:Buffer)=>{
      bytes+=chunk.length;
      if(bytes>4*1024*1024){ child.kill('SIGKILL'); finish(new Error('deterministic execution output exceeded 4 MiB')); return; }
      target.push(chunk);
    };
    child.stdout.on('data',capture(stdout));
    child.stderr.on('data',capture(stderr));
    child.once('error',error=>finish(error));
    child.once('close',(code,signal)=>finish(null,code,signal));
    child.stdin.once('error',error=>finish(error));
    const timer=setTimeout(()=>{ child.kill('SIGKILL'); finish(new Error('deterministic execution timed out')); },20_000);
    child.stdin.end(source);
  });
}

/**
 * Replaces this worker's server-side fetch for the duration of a test. Loopback
 * runtime traffic passes through; the exact production JavaScript execution
 * envelope is executed in an isolated child Node process; every other
 * destination is recorded and refused.
 */
export function installDeterministicExecutionTransport(getRuntimeOrigin:()=>string|null){
  const nativeFetch=globalThis.fetch;
  const requests:Array<{language:string;version:string;files:string[]}>=[];
  const unexpectedExternalRequests:string[]=[];
  const localFetch:typeof fetch=async(input,init)=>{
    const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
    if(new URL(url).origin===getRuntimeOrigin()) return nativeFetch(input,init);
    if(url!==E2E_EXECUTION_API_URL){
      unexpectedExternalRequests.push(url);
      throw new Error(`unexpected server-side network request: ${url}`);
    }
    const request=JSON.parse(String(init?.body||'{}')) as {language?:string;version?:string;files?:Array<{name?:string;content?:string}>};
    const files=request.files||[];
    if(init?.method!=='POST'||request.language!=='javascript'||request.version!=='18.15.0'
      ||files.length!==1||files[0]?.name!=='main.js'||typeof files[0]?.content!=='string'){
      throw new Error('invalid deterministic execution request');
    }
    requests.push({language:request.language,version:request.version,files:files.map(file=>String(file.name))});
    const result=await executeLocalHarness(files[0].content as string);
    return new Response(JSON.stringify({language:request.language,version:request.version,run:result}),
      {status:200,headers:{'content-type':'application/json'}});
  };
  globalThis.fetch=localFetch;
  return {requests,unexpectedExternalRequests,restore(){ globalThis.fetch=nativeFetch; }};
}

/** A correct solution for the original `focus-block-rollup` exercise (8 server cases). */
export const FOCUS_BLOCK_ROLLUP_SOLUTION=`function rollUpFocusBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous && previous.label === block.label) previous.minutes += block.minutes;
    else result.push({ label: block.label, minutes: block.minutes });
  }
  return result;
}`;
