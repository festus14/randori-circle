import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPresenceView, lineOf, partnerIdentity, presenceLabel } from '../../assets/presence-ui.mjs';

const room='week_10_pair_20';

function fakeDom(){
  const byId=new Map();
  class Node{
    constructor(tag){ this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.attributes={}; this.textContent=''; this.parentNode=null; }
    set id(value){ this._id=value; byId.set(value,this); }
    get id(){ return this._id; }
    setAttribute(name,value){ this.attributes[name]=String(value); }
    appendChild(child){ child.parentNode=this; this.children.push(child); return child; }
    replaceChildren(...children){ this.children=children; for(const child of children) child.parentNode=this; }
    insertAdjacentElement(_where,element){ element.parentNode=this.parentNode; this.parentNode?.children.push(element); return element; }
    remove(){ if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(child=>child!==this); this.parentNode=null; if(this._id) byId.delete(this._id); }
    querySelector(selector){ return selector==='.dot'?this.dot||null:null; }
    get parentElement(){ return this.parentNode; }
    get text(){ return this.children.map(child=>child.text??child.textContent).join('')||this.textContent; }
  }
  const document={head:new Node('head'),body:new Node('body'),
    getElementById:key=>byId.get(key)||null,createElement:tag=>new Node(tag),createTextNode:value=>({textContent:value,text:value})};
  const host=new Node('span'); host.dot=new Node('span');
  const label=new Node('span'); label.id='presenceText'; host.appendChild(label);
  const pane=new Node('div'),textarea=new Node('textarea'); textarea.id='editor'; pane.appendChild(textarea);
  Object.assign(textarea,{value:'line one\nline two\nline three',offsetParent:pane,offsetTop:40,offsetLeft:0,offsetWidth:600,
    offsetHeight:300,scrollTop:12,scrollLeft:0});
  return {document,host,label,textarea,pane,byId};
}

test('partner identity uses only the already-visible pair partner and a validated colour',()=>{
  const pair={room_id:room,partner:{display_name:'  Two   Person ',color:'#9cc0b5',email:'two@example.test'}};
  assert.deepEqual(partnerIdentity(room,pair),{name:'Two Person',color:'#9cc0b5'});
  assert.deepEqual(partnerIdentity('week_11_pair_20',pair),{name:'Your partner',color:'#9cc0b5'});
  assert.deepEqual(partnerIdentity(room,{room_id:room,partner:{name:'Legacy',color:'red;}body{x:y'}}),{name:'Legacy',color:'#9cc0b5'});
  assert.equal(partnerIdentity(room,{room_id:room,partner:{display_name:'x'.repeat(200)}}).name.length,60);
  assert.equal(partnerIdentity(room,null).name,'Your partner');
  assert.deepEqual(partnerIdentity(room,null,{display_name:'Joined',color:'#abcdef'}),{name:'Joined',color:'#abcdef'});
  assert.equal(partnerIdentity(room,pair,{display_name:'Joined'}).name,'Two Person','cached pair wins');
  assert.equal(lineOf('a\nb\nc',0),1); assert.equal(lineOf('a\nb\nc',4),3); assert.equal(lineOf('a',99),1);
});

test('labels state who is here, activity, cursor line and connection health in plain text',()=>{
  assert.equal(presenceLabel({name:'Two',presence:'here',status:'active',line:3,health:'live'}),'Two is here · line 3 · live');
  assert.equal(presenceLabel({name:'Two',presence:'here',status:'idle',line:null,health:'live'}),'Two is here · idle · live');
  assert.equal(presenceLabel({name:'Two',presence:'online',health:'polling'}),'Two online · polling');
  assert.equal(presenceLabel({name:'Two',presence:'away',health:'offline'}),'Two not in the room · reconnecting');
  assert.equal(presenceLabel({name:'Two',presence:'unknown',health:'polling'}),'Checking for Two… · polling');
  // Interview mode (#464): the interviewer sees the waiting or paused candidate.
  assert.equal(presenceLabel({name:'Two',presence:'online',waiting:true,health:'live'}),'Two is waiting in the lobby · live');
  assert.equal(presenceLabel({name:'Two',presence:'away',waiting:true,health:'live'}),'Two not in the room · live');
  assert.equal(presenceLabel({name:'Two',presence:'here',status:'locked',line:4,health:'live'}),'Two is here · editing paused · live');
  assert.equal(presenceLabel({name:'Two',presence:'online',status:'locked',health:'polling'}),'Two online · editing paused · polling');
});

test('the view announces joins and leaves once, not per tick, and restores the bar on teardown',()=>{
  const dom=fakeDom(); let refreshed=0;
  const window={_randori_pair_cache:{room_id:room,partner:{display_name:'Two',color:'#123456'}},
    _randori_refresh_presence:()=>{ refreshed+=1; },getComputedStyle:node=>node===dom.pane?{position:node.style.position||'static'}:({fontFamily:'mono',lineHeight:'1.6',paddingTop:'16px'})};
  const view=createPresenceView({document:dom.document,window,room});
  view.render({presence:'unknown',health:'polling',selection:null,text:''});
  const announcer=dom.byId.get('presenceAnnouncer');
  assert.equal(announcer,undefined,'no announcement before anything is known');
  view.render({presence:'away',health:'polling',selection:null,text:''});
  assert.equal(dom.byId.get('presenceAnnouncer').textContent,'','initial absence is not a "left" event');
  view.render({presence:'online',health:'polling',selection:null,text:''});
  const live=dom.byId.get('presenceAnnouncer');
  assert.equal(live.textContent,'Two joined the room'); assert.equal(live.attributes['aria-live'],'polite');
  assert.equal(live.attributes.role,'status'); assert.equal(live.parentNode,dom.document.body);
  live.textContent='';
  view.render({presence:'here',status:'active',health:'live',selection:{anchor:9,head:13},text:dom.textarea.value});
  assert.equal(live.textContent,'','online→here is not a new join');
  assert.equal(dom.label.textContent,'Two is here · line 2 · live');
  assert.equal(dom.host.dataset.partner,'here'); assert.equal(dom.host.dataset.health,'live');
  assert.equal(dom.host.dot.style.background,'#123456');
  assert.match(dom.byId.get('rcPresenceStyle').textContent,/#123456/);
  // Plain-editor overlay: caret after the forward selection, no local caret change.
  const layer=dom.byId.get('rcRemoteCursorLayer');
  assert.ok(layer); assert.equal(layer.attributes['aria-hidden'],'true');
  assert.equal(dom.pane.style.position,'relative','only the textarea wrapper becomes a containing block');
  assert.doesNotMatch(dom.byId.get('rcPresenceStyle').textContent,/roomPanel-code/,'no global layout rule');
  const inner=layer.children[0];
  assert.equal(inner.style.transform,'translate(0px,-12px)','follows textarea scroll');
  const [before,mark,caret]=inner.children;
  assert.equal(before.textContent,'line one\n'); assert.equal(mark.textContent,'line');
  assert.equal(mark.dataset.testid,'remote-selection'); assert.equal(caret.dataset.testid,'remote-cursor');
  assert.equal(caret.dataset.offset,'13');
  view.render({presence:'here',status:'active',health:'live',selection:{anchor:13,head:9},text:dom.textarea.value});
  assert.equal(layer.children[0].children[1].dataset.testid,'remote-cursor','backward selection puts the caret first');
  view.render({presence:'here',status:'idle',health:'live',selection:{anchor:4,head:4},text:dom.textarea.value});
  assert.equal(layer.children[0].children.length,3,'collapsed cursor has no selection mark');
  dom.textarea.style.display='none';
  view.render({presence:'here',status:'idle',health:'live',selection:{anchor:4,head:4},text:dom.textarea.value});
  assert.equal(dom.byId.get('rcRemoteCursorLayer'),undefined,'hidden editor has no overlay');
  assert.equal(dom.pane.style.position,'','wrapper position restored');
  dom.textarea.style.display='';
  view.render({presence:'away',health:'live',selection:{anchor:4,head:4},text:''});
  assert.equal(live.textContent,'Two left the room'); assert.equal(dom.host.dot.style.background,'');
  assert.equal(dom.byId.get('rcRemoteCursorLayer'),undefined,'absent partner has no cursor');
  view.destroy(); view.destroy();
  assert.equal(refreshed,1); assert.equal(dom.host.dataset.partner,undefined);
  assert.equal(dom.byId.get('presenceAnnouncer'),undefined,'announcer removed');
  assert.equal(dom.byId.get('rcPresenceStyle'),undefined,'injected style removed');
  assert.equal(live.parentNode,null);
  view.render({presence:'here',health:'live',selection:null,text:''});
  assert.equal(dom.host.dataset.partner,undefined,'destroyed view ignores renders');
});

test('Monaco cursors are decorations only: no caret, selection or scroll calls on the local editor',()=>{
  const dom=fakeDom(),calls=[];
  class Range{ constructor(...args){ this.args=args; } }
  const collection={sets:[],cleared:0,set(items){ this.sets.push(items); },clear(){ this.cleared+=1; }};
  const model={getPositionAt:offset=>({lineNumber:1+Math.floor(offset/10),column:1+offset%10})};
  const editor=new Proxy({getModel:()=>model,createDecorationsCollection:items=>{ collection.sets.push(items); return collection; }},{
    get(target,property){ if(!(property in target)) return (...args)=>calls.push([property,args]); return target[property]; }});
  const window={monaco:{Range},_randori_code:{getEditor:()=>editor}};
  const view=createPresenceView({document:dom.document,window,room});
  view.render({presence:'here',status:'active',health:'live',selection:{anchor:12,head:3},text:''});
  const [selection,caret]=collection.sets[0];
  assert.deepEqual(selection.range.args,[1,4,2,3]); assert.equal(selection.options.className,'rc-remote-selection');
  assert.deepEqual(caret.range.args,[1,4,1,4]); assert.equal(caret.options.beforeContentClassName,'rc-remote-caret');
  view.render({presence:'here',status:'active',health:'live',selection:{anchor:5,head:5},text:''});
  assert.equal(collection.sets[1].length,1,'collapsed cursor is a caret only');
  view.render({presence:'online',health:'polling',selection:null,text:''});
  assert.deepEqual(collection.sets[2],[],'no cursor without live awareness');
  assert.deepEqual(calls,[],'never setSelection/revealLine/setScrollTop/focus');
  assert.equal(dom.byId.get('rcRemoteCursorLayer'),undefined);
  view.destroy(); assert.equal(collection.cleared,1);
  // Decoration failures fall back to clearing, never throwing into the editor.
  const broken=createPresenceView({document:dom.document,room,window:{monaco:{Range},
    _randori_code:{getEditor:()=>({getModel:()=>model,createDecorationsCollection:()=>{ throw new Error('disposed'); }})}}});
  broken.render({presence:'here',status:'active',health:'live',selection:{anchor:1,head:1},text:''});
  broken.destroy();
  // No DOM at all (worker/vm): rendering is a no-op.
  const headless=createPresenceView({document:null,window:null,room});
  headless.render({presence:'here',health:'live',selection:{anchor:1,head:1},text:''}); headless.destroy();
});
