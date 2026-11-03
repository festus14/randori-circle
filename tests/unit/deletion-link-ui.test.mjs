// Public proof page: no app boot/session/storage, history scrubbing, explicit
// DELETE confirmation, replay fencing and accessible results.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
const sourceUrl=new URL('../../assets/deletion-link.js',import.meta.url);
const source=readFileSync(sourceUrl,'utf8');
function harness({hash='',responses=[]}={}){
  const requests=[],historyCalls=[],listeners={};
  const doc={title:'Delete your account',activeElement:null};
  const nodes=Object.fromEntries(['requestForm','confirmForm','cancelForm','status','confirm','confirmButton','email','intro'].map(id=>[id,{
    id,hidden:false,disabled:false,value:'',textContent:'',listeners:{},
    addEventListener(type,fn){this.listeners[type]=fn;},focus(){doc.activeElement=this;},
    fire(type){return this.listeners[type]?.({currentTarget:this,preventDefault(){}});},
  }]));
  for(const id of ['requestForm','confirmForm','cancelForm']){
    const button=id==='confirmForm'?nodes.confirmButton:{disabled:false,focus(){doc.activeElement=this;}};
    nodes[id].querySelector=()=>button;
  }
  doc.getElementById=id=>nodes[id];
  const location={hash,pathname:'/delete-account'};
  const context={document:doc,location,URLSearchParams,Date,history:{replaceState(state,title,path){historyCalls.push(path);location.hash='';}},
    window:{addEventListener(type,fn){listeners[type]=fn;}},fetch:async(path,options)=>{
      requests.push({path,...options,body:JSON.parse(options.body)});
      const next=responses.shift();if(next instanceof Error)throw next;
      if(typeof next==='function')return next();
      return {ok:next?.status===undefined||next.status<400,status:next?.status||200,json:async()=>next?.body||{}};
    }};
  runInNewContext(source,context,{filename:fileURLToPath(sourceUrl)});
  return {nodes,doc,location,requests,historyCalls,submit:mode=>nodes[`${mode}Form`].fire('submit'),
    link:hash=>{location.hash=hash;listeners.hashchange();},input:value=>{nodes.confirm.value=value;nodes.confirm.fire('input');}};
}
function assertAnonymous(request,path,body){
  assert.equal(request.path,`/api/auth/account/delete/${path}`);
  assert.equal(request.method,'POST');assert.equal(request.credentials,'omit');assert.equal(request.cache,'no-store');
  assert.equal(JSON.stringify(request.body),JSON.stringify(body));
}
test('request is public, clears the fragment and shows the generic server result',async()=>{
  const ui=harness({responses:[{status:202,body:{message:'If that account can request deletion, a confirmation email will arrive shortly.'}}]});
  assert.equal(ui.nodes.requestForm.hidden,false);assert.equal(ui.nodes.confirmForm.hidden,true);assert.equal(ui.nodes.cancelForm.hidden,true);
  assert.deepEqual(ui.historyCalls,['/delete-account']);ui.nodes.email.value='removed@example.test';
  await ui.submit('request');assertAnonymous(ui.requests[0],'link',{email:'removed@example.test'});
  assert.match(ui.nodes.status.textContent,/If that account/);assert.equal(ui.doc.activeElement,ui.nodes.status);
  assert.equal(ui.nodes.requestForm.querySelector('button').disabled,false);
});
test('DELETE is explicit, the emailed proof stays in memory and a successful confirmation hides the form',async()=>{
  const ui=harness({hash:'#token=proof',responses:[{body:{scheduled_for:'2030-01-15T00:00:00.000Z'}}]});
  assert.equal(ui.location.hash,'');assert.equal(ui.doc.activeElement,ui.nodes.confirm);
  assert.equal(ui.nodes.confirmButton.disabled,true);await ui.submit('confirm');assert.equal(ui.requests.length,0);
  ui.input('delete');assert.equal(ui.nodes.confirmButton.disabled,true);ui.input('DELETE');assert.equal(ui.nodes.confirmButton.disabled,false);
  await ui.submit('confirm');assertAnonymous(ui.requests[0],'confirm-token',{token:'proof',confirm:'DELETE'});
  assert.match(ui.nodes.status.textContent,/locked and scheduled/);assert.match(ui.nodes.status.textContent,/does not restore circle membership/);
  assert.equal(ui.nodes.confirmForm.hidden,true);assert.equal(ui.doc.activeElement,ui.nodes.status);
});
test('cancellation needs only its own purpose proof and states that membership stays removed',async()=>{
  const ui=harness({hash:'#cancel=cancel-proof&token=wrong-purpose'});
  assert.equal(ui.doc.activeElement,ui.nodes.cancelForm.querySelector('button'));
  await ui.submit('cancel');assertAnonymous(ui.requests[0],'cancel-token',{token:'cancel-proof'});
  assert.match(ui.nodes.status.textContent,/alive, but circle membership is not restored/);
  assert.match(ui.nodes.status.textContent,/need a new invitation/);assert.equal(ui.nodes.cancelForm.hidden,true);
});
test('unusable proof, rate limit, unavailable response and network failure reveal no account facts',async()=>{
  for(const [response,message] of [[{status:409},/This link cannot be used/],[{status:429},/Too many attempts/],[{status:503},/unavailable/],[new Error('private message'),/could not confirm the result/]]){
    const ui=harness({hash:'#cancel=proof',responses:[response]});await ui.submit('cancel');
    assert.match(ui.nodes.status.textContent,message);assert.equal(ui.nodes.cancelForm.hidden,false);
    assert.equal(ui.nodes.cancelForm.querySelector('button').disabled,false);
    assert.doesNotMatch(ui.nodes.status.textContent,/private message/);
  }
});
test('in-flight request fences double submits and scrubs incoming proof fragments without rebinding it',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const ui=harness({hash:'#token=original',responses:[()=>pending]});ui.input('DELETE');
  const submitted=ui.submit('confirm');await ui.submit('confirm');assert.equal(ui.requests.length,1);
  ui.link('#cancel=other-proof');assert.equal(ui.location.hash,'');
  assertAnonymous(ui.requests[0],'confirm-token',{token:'original',confirm:'DELETE'});
  finish({ok:false,status:409,json:async()=>({})});await submitted;
  ui.link('#cancel=new-proof');await ui.submit('cancel');
  assertAnonymous(ui.requests[1],'cancel-token',{token:'new-proof'});
});
