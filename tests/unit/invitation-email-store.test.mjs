import assert from 'node:assert/strict';
import test from 'node:test';
await import('../../assets/circle-ui.js');
const {createInvitationEmailStore,describeInvitation}=globalThis.RandoriCircleUI;
const id='0f8fad5b-d9cb-469f-a165-70867728950e';
const sender={userId:1,circlePublicId:'primary'};
const email='private.recipient@example.test';
const day=86_400_000;
function fixture(){
  let time=Date.parse('2026-11-03T12:00:00Z');
  const data=new Map();
  const storage=()=>({getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
  const store=()=>createInvitationEmailStore({storage,now:()=>time});
  return {data,store,advance:amount=>{time+=amount;}};
}

test('sender cards keep the full address across reload and circle changes, with no address for other viewers',()=>{
  const f=fixture();
  const sent=f.store();
  sent.remember(sender,id,email);
  sent.clear(); // Identity/circle changes clear tab memory, not the sender's browser cache.
  const reloaded=f.store();
  assert.equal(describeInvitation({id,status:'pending'}, {knownEmail:reloaded.get(sender,id)}).title,email);
  for(const scope of [{userId:2,circlePublicId:'primary'},{userId:1,circlePublicId:'another-circle'},null]){
    assert.equal(describeInvitation({id,status:'pending',email}, {knownEmail:reloaded.get(scope,id)}).title,'Private invitation');
  }
  const secondId='7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const anotherTab=f.store();
  anotherTab.remember(sender,secondId,'another.recipient@example.test');
  reloaded.remember(sender,id,email);
  assert.equal(anotherTab.get(sender,id),email);
  assert.equal(f.store().get(sender,secondId),'another.recipient@example.test');
  assert.equal(createInvitationEmailStore().get(sender,id),null); // Fresh browser.
  assert.deepEqual(JSON.parse([...f.data.values()][0]).map(row=>Object.keys(row).sort()),[['email','expiresAt','id'],['email','expiresAt','id']]);
});

test('addresses stop rendering at seven days and are removed when no longer pending',()=>{
  const f=fixture();
  f.store().remember(sender,id,email);
  f.advance(7*day-1);
  assert.equal(f.store().get(sender,id),email);
  f.advance(1);
  assert.equal(f.store().get(sender,id),null);
  assert.equal(f.data.size,0);
  for(const status of ['used','revoked','expired']){
    const store=f.store();
    store.remember(sender,id,email);
    store.retainPending(sender,[{id,status}]);
    assert.equal(store.get(sender,id),null);
    assert.equal(f.data.size,0);
  }
  const store=f.store();
  store.remember(sender,id,email);
  store.retainPending(sender,[{id,status:'pending'}]);
  assert.equal(store.get(sender,id),email);
  store.retainPending(sender,[]);
  assert.equal(store.get(sender,id),null);
});

test('blocked or corrupt storage preserves only valid sender addresses in the current tab',()=>{
  const store=createInvitationEmailStore({storage:()=>{throw new Error('browser storage blocked');}});
  store.remember(sender,id,email);
  assert.equal(store.get(sender,id),email);
  assert.equal(store.get({userId:2,circlePublicId:'primary'},id),null);
  store.clear();
  assert.equal(store.get(sender,id),null);
  const quotaBlocked=createInvitationEmailStore({storage:()=>({getItem:()=>null,setItem:()=>{throw new Error('quota');}})});
  quotaBlocked.remember(sender,id,email);
  assert.equal(quotaBlocked.get(sender,id),email);
  const f=fixture();
  const key='randori-invitation-emails-v1:1:primary';
  for(const bad of ['broken JSON','{}',JSON.stringify([{id,email,expiresAt:0},{id:'bad',email,expiresAt:Infinity}])]){
    f.data.set(key,bad);
    assert.equal(f.store().get(sender,id),null);
  }
  const valid=f.store();
  valid.remember({userId:0,circlePublicId:'primary'},id,email);
  valid.remember({userId:1,circlePublicId:'../other'},id,email);
  valid.remember(sender,'bad',email);
  valid.remember(sender,id,'x'.repeat(255));
  valid.retainPending(null,[]);
  assert.equal(f.data.size,0);
});

test('browser address cache is bounded to the 200 invitations the list can return',()=>{
  const f=fixture();
  const store=f.store();
  for(let i=0;i<201;i++) store.remember(sender,`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,email);
  assert.equal(store.get(sender,'00000000-0000-4000-8000-000000000000'),null);
  assert.equal(store.get(sender,'00000000-0000-4000-8000-000000000200'),email);
  assert.equal(JSON.parse([...f.data.values()][0]).length,200);
});
