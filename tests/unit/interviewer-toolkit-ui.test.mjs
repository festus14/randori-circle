import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

class Element{
  constructor(tag,doc){this.tagName=tag;this.doc=doc;this.children=[];this.attributes={};this.listeners={};this.value='';this.disabled=false;this.parentNode=null;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='id')this.id=value;}
  addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);}
  append(...children){for(const child of children){child.parentNode=this;this.children.push(child);}}
  insertBefore(child,before){child.parentNode=this;this.children.splice(this.children.indexOf(before),0,child);}
  replaceChildren(...children){this.children=[];this.append(...children);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(child=>child!==this);}
  all(){return this.children.flatMap(child=>[child,...child.all()]);}
  showModal(){this.open=true;}
  async fire(type){for(const handler of this.listeners[type]||[])await handler({preventDefault(){}});}
  click(){return this.fire('click');}
}
const root={listeners:{},addEventListener(type,handler){this.listeners[type]=handler;}};
const old={document:globalThis.document,window:globalThis.window,fetch:globalThis.fetch,confirm:globalThis.confirm};
globalThis.window=root;
const {openToolkit,disposeToolkit,describeEvent,reportDownload}=await import('../../assets/interviewer-toolkit.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let report,requests,mode,revoke=0,created=0;
const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
function fixture(){
  const doc={};doc.createElement=tag=>new Element(tag,doc);doc.body=doc.createElement('body');
  doc.byId=id=>doc.body.all().find(item=>item.id===id);doc.byTestId=id=>doc.body.all().find(item=>item.attributes['data-testid']===id);
  doc.button=text=>doc.body.all().find(item=>item.tagName==='button'&&item.textContent===text);
  globalThis.document=doc;globalThis.confirm=()=>true;
  URL.createObjectURL=()=>{created+=1;return 'blob:private-report';};URL.revokeObjectURL=()=>{revoke+=1;};
  report={room_id:'week_10_pair_20',candidate:'Candidate',phase:'ended',limitations:'Sparse recorded evidence.',
    evaluation:{revision:0,rubric:{problem_solving:null,communication:null,code_quality:null,testing:null},notes:'<script>not HTML</script>',decision:'undecided',expires_at:null},
    timeline:[{kind:'phase',phase:'lobby',source:'pair_created',at:'2026-11-18T10:00:00Z'},
      {kind:'checkpoint',revision:1,question_slug:'focus-block-rollup',language:'javascript',at:'2026-11-18T10:01:00Z',code:'code one'},
      {kind:'run',question_slug:'focus-block-rollup',language:'javascript',passed_count:2,total_count:3,duration_ms:10,at:'2026-11-18T10:02:00Z',code:'code two'}]};
  requests=[];mode='ok';
  globalThis.fetch=async(url,init)=>{
    requests.push({url,init});
    if(mode==='network')throw new Error('raw sensitive error');
    if(mode==='unauthorized')return {ok:false,status:404,json:async()=>({})};
    if(mode==='invalid')return {ok:true,status:200,json:async()=>({report:{room_id:'wrong'}})};
    if(init?.method==='POST'){
      if(mode==='conflict')return {ok:false,status:409,json:async()=>({})};
      const body=JSON.parse(init.body);report.evaluation={...report.evaluation,...body,revision:body.revision+1,expires_at:'2027-02-16T10:00:00Z'};
      return {ok:true,status:200,json:async()=>({ok:true,evaluation:report.evaluation})};
    }
    if(url==='/api/interviewer-toolkit')return {ok:true,status:200,json:async()=>({insights:{evaluated:1,decisions:{hire:1,strong_hire:0,no_hire:0,strong_no_hire:0},truncated:mode==='truncated'}})};
    return {ok:true,status:200,json:async()=>({report:structuredClone(report)})};
  };
  return doc;
}
afterEach(()=>{disposeToolkit();globalThis.document=old.document;globalThis.fetch=old.fetch;globalThis.confirm=old.confirm;URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;});

test('event descriptions and saved download are explicit, stable and plain text',()=>{
  assert.match(describeEvent({kind:'phase',phase:'ended',source:'timer'}),/ended/);
  assert.match(describeEvent({kind:'checkpoint',revision:2,question_slug:'q',language:'js'}),/r2/);
  assert.match(describeEvent({kind:'run',question_slug:'q',language:'js',passed_count:2,total_count:4,duration_ms:7}),/2\/4/);
  assert.equal(describeEvent({kind:'evaluation'}),'Evaluation saved');
  assert.equal(reportDownload({notes:'<script>'}),'{'+'\n  "notes": "<script>"\n}\n');
});
test('lazy UI scores, notes and decides, plays code evolution and downloads only the saved report',async()=>{
  const doc=fixture();await openToolkit(report.room_id);await tick();
  assert.equal(doc.byTestId('interviewer-toolkit').open,true);
  assert.match(doc.byTestId('toolkit-insights').textContent,/1 evaluated/);
  assert.equal(doc.byTestId('toolkit-notes').value,'<script>not HTML</script>');
  doc.byId('toolkit-problem_solving').value='4';doc.byTestId('toolkit-notes').value='Private writing';doc.byTestId('toolkit-decision').value='hire';
  await doc.byTestId('toolkit-form').fire('input');assert.equal(doc.byTestId('toolkit-download').disabled,true);
  await doc.byTestId('toolkit-download').click();assert.equal(created,0);
  await doc.byTestId('toolkit-form').fire('submit');await tick();
  const posted=JSON.parse(requests.find(item=>item.init.method==='POST').init.body);
  assert.equal(posted.rubric.problem_solving,4);assert.equal(posted.notes,'Private writing');assert.equal(posted.revision,0);assert.equal(posted.decision,'hire');
  assert.equal(doc.byTestId('toolkit-status').textContent,'Private evaluation saved.');assert.equal(doc.byTestId('toolkit-download').disabled,false);
  await doc.button('Next event').click();assert.equal(doc.byTestId('toolkit-playback-code').textContent,'code one');
  await doc.button('Next event').click();assert.equal(doc.byTestId('toolkit-playback-code').textContent,'code two');
  await doc.button('Previous event').click();assert.equal(doc.byTestId('toolkit-playback-code').textContent,'code one');
  await doc.byTestId('toolkit-timeline').children[0].children[0].click();assert.match(doc.byTestId('toolkit-playback-code').textContent,/No code/);
  await doc.byTestId('toolkit-download').click();await doc.byTestId('toolkit-download').click();assert.equal(created,2);assert.equal(revoke,1);
  await doc.button('Close').click();assert.equal(doc.body.children.length,0);assert.equal(revoke,2);
});
test('conflict preserves unsent writing and explicit reload may be cancelled or confirmed',async()=>{
  const doc=fixture();await openToolkit(report.room_id);await tick();
  doc.byTestId('toolkit-notes').value='Unsent';await doc.byTestId('toolkit-form').fire('input');mode='conflict';
  await doc.byTestId('toolkit-form').fire('submit');assert.match(doc.byTestId('toolkit-status').textContent,/unsent writing is kept/);assert.equal(doc.byTestId('toolkit-notes').value,'Unsent');
  globalThis.confirm=()=>false;await doc.byTestId('toolkit-reload').click();assert.equal(doc.byTestId('toolkit-notes').value,'Unsent');
  globalThis.confirm=()=>true;mode='ok';await doc.byTestId('toolkit-reload').click();assert.equal(doc.byTestId('toolkit-notes').value,report.evaluation.notes);
  mode='network';await doc.byTestId('toolkit-reload').click();assert.match(doc.byTestId('toolkit-status').textContent,/Private report unavailable/);
});
test('failed loads are generic, stale reads cannot mount private content, and identity/room events clear DOM',async()=>{
  const doc=fixture();mode='invalid';await openToolkit('week_10_pair_20');assert.equal(doc.byTestId('toolkit-form'),undefined);assert.match(doc.byTestId('toolkit-status').textContent,/unavailable/);
  mode='unauthorized';await openToolkit('week_10_pair_20');assert.match(doc.byTestId('toolkit-status').textContent,/unavailable/);
  mode='truncated';await openToolkit('week_10_pair_20');await tick();assert.match(doc.byTestId('toolkit-insights').textContent,/bounded window/);
  const before=requests.length;globalThis.fetch=()=>new Promise(resolve=>{setImmediate(()=>resolve({ok:true,status:200,json:async()=>({report})}));});
  const opening=openToolkit('week_10_pair_20');disposeToolkit();await opening;assert.equal(doc.body.children.length,0);
  assert.ok(before>0);
  for(const name of ['randori:auth-refreshed','randori:room-change','randori:workspace-scope-reset','randori:workspace-deactivated']){assert.equal(typeof root.listeners[name],'function');root.listeners[name]();}
});
test('default hidden entry and first-use import do not load the toolkit with the initial shell',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  assert.match(html,/<button id="toolkitEntry"[^>]+hidden>/);
  assert.doesNotMatch(html,/<script[^>]+src="[^"]*interviewer-toolkit/);
  const coordinator=readFileSync(new URL('../../assets/interview-session.js',import.meta.url),'utf8');
  assert.match(coordinator,/import\('\.\/interviewer-toolkit\.js'\)/);
});
