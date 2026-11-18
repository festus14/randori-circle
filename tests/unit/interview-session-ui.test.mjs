import assert from 'node:assert/strict';
import test from 'node:test';
import { installInterviewSession } from '../../assets/interview-session.js';

function fixture(){
  const root=new EventTarget();
  const calls=[];
  root._randori_session_controls={room:'week_10_pair_20',ended:false};
  root._randori_workspace={endInterview:room=>calls.push(['workspace',room])};
  root._randori_video={disposeForScopeChange:()=>calls.push(['video'])};
  root._randori_chat={stop:options=>calls.push(['chat',options])};
  root._randori_schedule={stop:options=>calls.push(['schedule',options])};
  root._randori_pair_runs={stop:()=>calls.push(['runs'])};
  const nodes=new Map(['runBtn','questionSelect','langSelect','formatBtn','editorResetBtn','vidJoinBtn','chatSend','chatIn'].map(id=>[id,{disabled:id==='formatBtn'}]));
  const editor={readOnly:false};
  const doc={getElementById:id=>id==='editor'?editor:nodes.get(id)||null};
  return {root,doc,calls,nodes,editor,event(name,detail){root.dispatchEvent(new CustomEvent(name,{detail}));}};
}

test('terminal coordinator is inert without a validated, matching interview end',()=>{
  assert.equal(installInterviewSession({window:null,document:null}),null);
  const f=fixture();
  const controller=installInterviewSession({window:f.root,document:f.doc});
  assert.equal(controller.room,null); assert.equal(f.calls.length,0);
  assert.equal(controller.stop({room:'week_10_pair_20'}),false);
  f.root._randori_session_controls.ended=true;
  assert.equal(controller.stop({room:'week_10_pair_999'}),false);
  assert.equal(f.calls.length,0);
});

test('one matching end stops workspace, call, chat, schedule, and run work; wrap-up remains mounted',()=>{
  const f=fixture();
  const controller=installInterviewSession({window:f.root,document:f.doc});
  f.root._randori_session_controls.ended=true;
  f.event('randori:interview-ended',{room:'week_10_pair_20'});
  assert.equal(controller.room,'week_10_pair_20');
  assert.deepEqual(f.calls,[['workspace','week_10_pair_20'],['video'],['chat',{clear:false}],['schedule',{clear:false}],['runs']]);
  assert.equal([...f.nodes.values()].every(node=>node.disabled),true);
  assert.equal(f.editor.readOnly,true);
  f.event('randori:interview-ended',{room:'week_10_pair_20'});
  assert.equal(f.calls.length,5,'repeated terminal receipt observations do not repeat disposal');
  f.event('randori:auth-refreshed');
  assert.equal(controller.room,'week_10_pair_20','same-account refresh cannot reopen terminal work');
  f.root._randori_session_controls.ended=false;
  f.event('randori:auth-refreshed');
  assert.equal(controller.room,null);
  assert.equal(f.nodes.get('runBtn').disabled,false);
  assert.equal(f.editor.readOnly,false);
  assert.equal(f.nodes.get('formatBtn').disabled,true,'pre-existing disabled controls are restored, not enabled');
});

test('Monaco termination preserves CRDT locks and tolerates an unavailable editor',()=>{
  for(const throws of [false,true]){
    const f=fixture(); let updates=0;
    f.root._randori_crdt={};
    f.root._randori_code={getEditor:()=>({updateOptions:options=>{updates+=1; assert.equal(options.readOnly,true); if(throws) throw new Error('disposed');}})};
    f.root._randori_session_controls.ended=true;
    const controller=installInterviewSession({window:f.root,document:f.doc});
    assert.equal(updates,1);
    assert.equal(f.nodes.get('runBtn').disabled,true);
    controller.unlock();
    assert.equal(f.editor.readOnly,true,'the mounted CRDT module alone may release its editor lock');
  }
});

test('room and authorization fences reset the terminal display lock, and mounting after end is safe',()=>{
  for(const event of ['randori:room-change','randori:workspace-scope-reset','randori:workspace-deactivated']){
    const f=fixture(); f.root._randori_session_controls.ended=true;
    const controller=installInterviewSession({window:f.root,document:f.doc});
    assert.equal(controller.room,'week_10_pair_20');
    f.event(event);
    assert.equal(controller.room,null);
    assert.equal(f.nodes.get('runBtn').disabled,false);
  }
  const root=new EventTarget(); root._randori_session_controls={room:'week_10_pair_20',ended:true};
  const controller=installInterviewSession({window:root,document:{getElementById:()=>null}});
  assert.equal(controller.room,'week_10_pair_20');
  controller.unlock();
  assert.equal(controller.room,null);
});

test('lobby/lock access holds the candidate selection, editor and lobby Run, and restores them exactly',()=>{
  const f=fixture();
  const observed=[];
  f.root.MutationObserver=class{ constructor(callback){ this.callback=callback; } observe(node){ observed.push([this,node]); } };
  const gate=f.root._randori_session_controls;
  Object.assign(gate,{editBlocked:true,selectionOwned:true,inLobby:true});
  let monaco=null;
  f.root._randori_code={getEditor:()=>({updateOptions:options=>{ monaco=options.readOnly; }})};
  const controller=installInterviewSession({window:f.root,document:f.doc});
  f.event('randori:interview-access',{room:'week_10_pair_999'});
  assert.equal(f.nodes.get('questionSelect').disabled,false,'another room is ignored');
  f.event('randori:interview-access',{room:'week_10_pair_20'});
  for(const id of ['questionSelect','langSelect','editorResetBtn','formatBtn','runBtn']) assert.equal(f.nodes.get(id).disabled,true,id);
  assert.equal(f.editor.readOnly,true); assert.equal(monaco,true);
  // Catalogue code re-enabling a held control is recorded and undone.
  const select=f.nodes.get('questionSelect'); select.disabled=false;
  const [observer]=observed.find(([,node])=>node===select);
  observer.callback([{target:select}]);
  assert.equal(select.disabled,true);
  Object.assign(gate,{editBlocked:false,inLobby:false});
  f.event('randori:interview-access',{room:'week_10_pair_20'});
  assert.equal(f.nodes.get('runBtn').disabled,false,'admission releases Run');
  assert.equal(f.nodes.get('formatBtn').disabled,true,'formatBtn returns to its own earlier disabled state');
  assert.equal(f.nodes.get('questionSelect').disabled,true,'the candidate still never chooses the question');
  assert.equal(f.editor.readOnly,false); assert.equal(monaco,false);
  Object.assign(gate,{selectionOwned:false});
  f.event('randori:interview-access',{room:'week_10_pair_20'});
  assert.equal(select.disabled,false,'the re-enable observed while held is the restored value');
  assert.equal(f.nodes.get('langSelect').disabled,false);
  Object.assign(gate,{editBlocked:true,selectionOwned:true,inLobby:true});
  controller.access({room:'week_10_pair_20'});
  f.event('randori:room-change');
  assert.equal(f.nodes.get('langSelect').disabled,false,'a room change releases every hold');
  assert.equal(f.editor.readOnly,false);
});

test('access never unlocks a terminal room and leaves the editor to a mounted CRDT',()=>{
  const f=fixture();
  f.root._randori_crdt={};
  const gate=f.root._randori_session_controls;
  Object.assign(gate,{editBlocked:true,selectionOwned:true,inLobby:false});
  installInterviewSession({window:f.root,document:f.doc});
  f.event('randori:interview-access',{room:'week_10_pair_20'});
  assert.equal(f.editor.readOnly,false,'CRDT owns the editor lock when mounted');
  assert.equal(f.nodes.get('langSelect').disabled,true);
  gate.ended=true;
  f.event('randori:interview-ended',{room:'week_10_pair_20'});
  f.event('randori:interview-access',{room:'week_10_pair_20'});
  assert.equal(f.nodes.get('langSelect').disabled,true,'the terminal lock keeps released holds disabled');
  assert.equal(f.nodes.get('runBtn').disabled,true);
});
