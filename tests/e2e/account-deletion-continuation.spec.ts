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
