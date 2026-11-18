import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showExecutionBusy } from '../../assets/execution-busy.js';
import { cardView } from '../../assets/admin-diagnostics.js';
import { readFileSync } from 'node:fs';
function fixture({reason='queued',automatic=true,privateInput=false,seconds=2}={}){
  function node(){return{children:[],dataset:{},listeners:{},disabled:false,isConnected:true,textContent:'',appendChild(c){this.children.push(c);},replaceChildren(){this.children=[];},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},click(){this.listeners.click?.();}};}
  const doc={visibilityState:'visible',createElement:node},out=node();
  let now=0,runs=0,current=true,id=0;const timers=new Map();
  const stop=showExecutionBusy({doc,out,error:{code:'execution_busy',reason,retry_after:seconds},automatic,privateInput,
    now:()=>now,current:()=>current,run:()=>{runs++;},schedule:(fn,ms)=>{const key=++id;timers.set(key,{fn,at:now+ms});return key;},cancel:key=>timers.delete(key)});
  return{out,doc,stop,get runs(){return runs;},get button(){return out.children[0].children[2];},get label(){return out.children[0].children[0].textContent;},
    tick(ms){now+=ms;for(const[key,timer]of [...timers])if(timer.at<=now){timers.delete(key);timer.fn();}},change(){current=false;},timers};
}

test('busy countdown performs exactly one retry, disables early/double clicks and retains no payload',()=>{
  const f=fixture();assert.equal(f.label,'Execution is busy — retrying in 2s');assert.equal(f.button.disabled,true);
  f.button.click();assert.equal(f.runs,0);f.tick(1000);assert.match(f.label,/1s/);
  f.tick(1000);assert.equal(f.runs,1);f.button.click();f.tick(10000);assert.equal(f.runs,1);assert.equal(f.timers.size,0);
});

test('quotas, shed and expired queues offer an explicit retry only, never background provider work',()=>{
  for(const reason of ['quota','queue_full','queue_expired','already_running','pending_run','store']){
    const f=fixture({reason});f.tick(2000);assert.equal(f.runs,0);assert.equal(f.button.disabled,false);
    f.button.click();f.button.click();assert.equal(f.runs,1);
    assert.match(f.out.children[0].children[1].textContent,/not run/);
  }
});

test('private stdin never auto-retries or retains the discarded input',()=>{
  const f=fixture({automatic:false,privateInput:true});assert.match(f.out.children[0].children[1].textContent,/Re-enter private stdin/);
  f.tick(2000);assert.equal(f.runs,0);f.button.click();assert.equal(f.runs,1);
  assert.doesNotMatch(JSON.stringify(f.out),/stdin.*PRIVATE|body|payload/);
});

test('context changes, page hiding, detached results and explicit cancellation stop delayed runs',()=>{
  for(const change of [f=>f.change(),f=>{f.doc.visibilityState='hidden';},f=>{f.out.children[0].isConnected=false;},f=>f.stop()]){
    const f=fixture();change(f);f.tick(2000);f.button.click();assert.equal(f.runs,0);assert.equal(f.timers.size,0);
  }
});

test('malformed retry hints are bounded, numeric-only text; lazy UI has no stored or replayed request bytes',()=>{
  for(const seconds of ['<script>',-1,Infinity]){
    const f=fixture({seconds});assert.doesNotMatch(f.label,/<script>/);assert.match(f.label,/[0-9]+s/);f.stop();
  }
  const source=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  assert.match(source,/await import\('\/assets\/execution-busy\.js'\)/);
  assert.doesNotMatch(source,/<script[^>]+src="\/assets\/execution-busy\.js"/);
  assert.match(source,/verifiedRunPending&&window\._randori_auth\?\.capabilities\?\.executionQueue===true/);
});

test('existing lazy admin execution card renders aggregate queue/spend/latency only, absent fields preserve legacy view',()=>{
  const card={status:'healthy',configured:true,provider:'vercel-sandbox',lastOutcome:'success',recent24h:{},queue:{enabled:true,ready:true,
    queueDepth:3,activeUnits:2,recent:{admitted:4,shed:1,quota:2},waitMs:{p50:1000,p95:5000},providerMs:{p50:1000,p95:2000},
    spend:{globalConcurrency:4,globalPerMinute:60,globalPerDay:150}},warm:{javascript:{configured:true},python:{configured:false}}};
  const view=cardView('execution',card);assert.match(view.lines.join('\n'),/3 waiting · 2\/4 active/);
  assert.match(view.lines.join('\n'),/150 units\/day/);assert.match(view.lines.join('\n'),/Wait p50\/p95/);
  assert.doesNotMatch(cardView('execution',{...card,queue:undefined}).lines.join('\n'),/Queue:|Spend guard/);
});
