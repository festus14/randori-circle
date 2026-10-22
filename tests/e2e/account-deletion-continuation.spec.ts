import {expect,Page,test} from '@playwright/test';
import {mockApi,resetClientState} from './helpers';

// Issue #339: the account-deletion dialog stores a Google step-up marker in
// sessionStorage. Only a fresh marker that belongs to the member now signed
// in turns a Google return into a deletion continuation; a stale or foreign
// marker is dropped and the ordinary Account security flow runs.

const owner={id:1,email:'owner@example.test',name:'Circle Owner',display_name:'Circle Owner',color:'#c8f6a0',
  is_admin:false,is_available:true,tz:'Europe/London',interview_focus:'both'};
const MARKER='randori-account-deletion-reauth-v1';

async function openGoogleReturn(page:Page,marker:{actor_id:number;ageMs:number}){
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      identityManagement:true,accountDeletion:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},membership:{role:'member'},
      circle:[owner],count:1},
    '/api/auth/identities':{ok:true,identity:{accountEmail:owner.email,recentAuth:{ok:true,method:'google'},
      password:{linked:true,canUnlink:true,canAdd:false},google:{linked:true,canUnlink:true}}},
    '/api/auth/recent-auth':{ok:true,recentAuth:{ok:true,method:'google'},methods:{password:true,google:true}},
    '/api/auth/account/delete':{ok:true,eligible:true},
  });
  await resetClientState(page,true);
  await page.addInitScript(({key,actor,ageMs})=>{
    if(window.top!==window) return;
    sessionStorage.setItem(key,JSON.stringify({v:1,actor_id:actor,created_at:Date.now()-ageMs}));
  },{key:MARKER,actor:marker.actor_id,ageMs:marker.ageMs});
  await page.goto('/?google_reauth=success',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL('/');
}

for(const [label,marker] of [
  ['a stale marker',{actor_id:1,ageMs:20*60*1000}],
  ['a marker for another member',{actor_id:99,ageMs:1000}],
] as const){
  test(`${label} does not capture a Google return`,async({page})=>{
    await openGoogleReturn(page,marker);
    await expect(page.getByRole('dialog',{name:'Account security'})).toBeVisible();
    await expect(page.locator('#identityStatus')).toHaveText('Google confirmation complete.');
    await expect(page.getByTestId('account-deletion-dialog')).toBeHidden();
    await expect.poll(()=>page.evaluate(key=>sessionStorage.getItem(key),MARKER)).toBeNull();
  });
}

test('a fresh marker for the signed-in member resumes the deletion at Type DELETE',async({page})=>{
  await openGoogleReturn(page,{actor_id:1,ageMs:1000});
  await expect(page.getByRole('dialog',{name:'Type DELETE to confirm'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Type DELETE',exact:true})).toBeFocused();
  await expect(page.getByRole('dialog',{name:'Account security'})).toBeHidden();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),MARKER)).toBeNull();
});

test('Account security’s own Google confirmation clears a deletion marker before leaving',async({page})=>{
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      identityManagement:true,accountDeletion:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},membership:{role:'member'},
      circle:[owner],count:1},
    '/api/auth/identities':{ok:true,identity:{accountEmail:owner.email,recentAuth:{ok:false},
      password:{linked:true,canUnlink:true,canAdd:false},google:{linked:true,canUnlink:true}}},
    '/api/auth/recent-auth':{ok:true,recentAuth:{ok:true,method:'google'},methods:{password:true,google:true}},
    '/api/auth/account/delete':{ok:true,eligible:true},
    '/api/auth/google/reauth/start':{ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=identity'},
  });
  await resetClientState(page,true,{},true);
  // A deletion dialog started a Google step-up a moment ago and was abandoned.
  await page.addInitScript(key=>{
    if(window.top!==window||sessionStorage.getItem('e2e-marker-seeded')) return;
    sessionStorage.setItem('e2e-marker-seeded','1');
    sessionStorage.setItem(key,JSON.stringify({v:1,actor_id:1,created_at:Date.now()-1000}));
  },MARKER);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  const origin=new URL(page.url()).origin;
  await page.route('https://accounts.google.com/**',route=>route.fulfill({status:302,
    headers:{location:`${origin}/?google_reauth=success`}}));
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  const identity=page.getByRole('dialog',{name:'Account security'});
  await expect(identity).toBeVisible();
  const returned=page.waitForRequest(request=>request.isNavigationRequest()
    &&new URL(request.url()).searchParams.get('google_reauth')==='success');
  await identity.getByRole('button',{name:'Confirm with Google'}).click();
  await returned;
  await expect(page.getByRole('dialog',{name:'Account security'})).toBeVisible();
  await expect(page.locator('#identityStatus')).toHaveText('Google confirmation complete.');
  await expect(page.getByTestId('account-deletion-dialog')).toBeHidden();
  expect(await page.evaluate(key=>sessionStorage.getItem(key),MARKER)).toBeNull();
});
