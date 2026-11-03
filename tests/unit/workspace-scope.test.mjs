import assert from 'node:assert/strict';
import {test} from 'node:test';
let moduleId=0;
class Node{
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';}
  append(...children){this.children.push(...children);}
  prepend(child){this.children.unshift(child);}
  setAttribute(name,value){this[name]=value;}
  remove(){this.removed=true;}
}
async function fixture({enabled=true,body=null}={}){
  const previous=new Map(['window','document','localStorage'].map(key=>[key,globalThis[key]])),nodes=new Map();
  const host=new Node('section');nodes.set('view-code',host);nodes.set('editor',new Node('textarea'));
  const store=new Map([['randori-code','private'],['randori-theme','dark'],['randori-board:week_1_pair_2','private']]);
  const storage={get length(){return store.size;},key:index=>[...store.keys()][index],removeItem:key=>store.delete(key)};
  let epoch=1,version=7,publicId='dojo-20',actor=1;
  const sent=[],events=[],stopped=[];
  const root={location:{origin:'https://app.example.test'},fetch:async(input,options)=>{sent.push({input,options});return new Response(JSON.stringify(body||{ok:true,circle_public_id:publicId,circle_context_version:version,circle:{public_id:publicId,name:'Dojo',is_primary:false},room_id:'circle_20_publication_3_group_4'}));},
    _randori_auth:{me:{id:1},capabilities:{secondaryCircleWorkspace:enabled}},
    _randori_circle_control:{capturePairing:async()=>({epoch,userId:actor,contextVersion:version,circlePublicId:publicId}),
      matchesPairing:(operation,body)=>operation.epoch===epoch&&operation.userId===actor&&operation.contextVersion===version&&operation.circlePublicId===publicId
        &&(!body||body.circle_context_version===version&&body.circle_public_id===publicId)},
    _randori_workspace:{deactivate:()=>stopped.push('workspace')},_randori_crdt:{deactivate:()=>stopped.push('crdt')},
    _randori_video:{leaveVideo:()=>stopped.push('video')},_randori_code:{setCode:()=>stopped.push('code')},
    RandoriCircleUI:{circleBadgeNode:(_doc,circle)=>{const badge=new Node('span');badge.textContent=`In ${circle.name} Secondary`;return badge;}},
    dispatchEvent:event=>events.push(event.type)};
  globalThis.window=root;globalThis.localStorage=storage;globalThis.document={getElementById:id=>nodes.get(id)||null,createElement:tag=>new Node(tag)};
  await import(`../../assets/workspace-scope.js?fixture=${moduleId++}`);
  return {root,sent,nodes,store,events,stopped,switch(){epoch++;version++;publicId='dojo-30';root.RandoriWorkspaceScope.reset();},
    close(){for(const [key,value]of previous){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}};
}
test('workspace fetch fences all pollers and preserves unrelated requests',async()=>{
  const f=await fixture();try{
    for(const endpoint of ['history','messages','runs','execute','pair-recap','session-completion','session-controls','meeting-link','code-document','video/poll','ai/history']){
      const response=await f.root.fetch(`/api/${endpoint}`,{method:'GET'});assert.equal((await response.json()).ok,true);
      assert.equal(f.sent.at(-1).options.headers.get('X-Randori-Circle-Context-Version'),'7');
    }
    await f.root.fetch('/api/catalog');assert.equal(f.sent.at(-1).options.headers,undefined);
    await f.root.fetch('https://other.example.test/api/history');assert.equal(f.sent.at(-1).options.headers,undefined);
    assert.equal(f.root.RandoriWorkspaceScope.canonicalRoom('week_3_pair_4'),true);
    assert.equal(f.root.RandoriWorkspaceScope.secondaryRoom('circle_20_publication_3_group_4'),true);
    assert.equal(f.root.RandoriWorkspaceScope.canonicalRoom('circle_20_publication_3_group_9007199254740992'),false);
    assert.equal(f.root.RandoriWorkspaceScope.canonicalRoom('week_03_pair_4'),false);
  }finally{f.close();}
});
test('switch drops even a response whose HTTP request already completed, clears private caches and stops media',async()=>{
  const f=await fixture();try{
    const response=await f.root.fetch('/api/history');f.switch();
    await assert.rejects(response.json(),{name:'AbortError'});
    assert.equal(f.store.has('randori-code'),false);assert.equal(f.store.has('randori-board:week_1_pair_2'),false);assert.equal(f.store.get('randori-theme'),'dark');
    for(const surface of ['workspace','video','crdt','code'])assert.ok(f.stopped.includes(surface));
    assert.ok(f.events.includes('randori:workspace-scope-reset'));assert.equal(f.root._randori_authorized_room,null);
  }finally{f.close();}
});
test('old responses consumed as text and clones cannot cross the switch',async()=>{
  const f=await fixture();try{
    const response=await f.root.fetch('/api/messages'),copy=response.clone(),textCopy=response.clone();f.switch();
    await assert.rejects(response.text(),{name:'AbortError'});await assert.rejects(copy.json(),{name:'AbortError'});await assert.rejects(textCopy.text(),{name:'AbortError'});
  }finally{f.close();}
});
test('caller abort signals are linked, and a switch aborts outstanding writes',async()=>{
  const f=await fixture();try{
    const controller=new AbortController(),response=await f.root.fetch('/api/messages',{method:'POST',signal:controller.signal});
    controller.abort();assert.equal(f.sent.at(-1).options.signal.aborted,true);
    await response.json();
    await f.root.fetch('/api/execute',{method:'POST'});f.switch();assert.equal(f.sent.at(-1).options.signal.aborted,true);
  }finally{f.close();}
});
test('primary flag-off successes remain compatible with their legacy response shape',async()=>{
  const f=await fixture({enabled:false});try{
    const response=await f.root.fetch('/api/history');assert.equal((await response.json()).ok,true);
    assert.equal(f.root.RandoriWorkspaceScope.enabled(),false);
  }finally{f.close();}
});

test('context revocation and disabled workspace responses erase private editor state and caches',async()=>{
  for(const body of [{code:'circle_context_changed'},{code:'active_circle_required'},
    {error:'active circle membership required'},{code:'circle_feature_unavailable'}]){
    const f=await fixture({body});try{
      f.nodes.get('editor').value='private code';
      const response=await f.root.fetch('/api/messages');assert.deepEqual(await response.json(),body);
      assert.equal(f.store.has('randori-code'),false);assert.equal(f.nodes.get('editor').value,'');
      assert.ok(f.stopped.includes('code'));assert.equal(f.root._randori_authorized_room,null);
      if(body.code==='circle_feature_unavailable')assert.equal(f.nodes.get('view-code').children[0].textContent,'Workspace is not available in this circle yet.');
    }finally{f.close();}
  }
});
test('only current authorised response attribution mounts a badge and solo identity',async()=>{
  const room='circle_20_publication_3_group_4';
  const f=await fixture({body:{ok:true,room_id:room,circle_public_id:'dojo-20',circle_context_version:7,circle:{public_id:'dojo-20',name:'Dojo',is_primary:false},recap:{pair:{solo:true}}}});try{
    f.root._randori_authorized_room=room;
    const response=await f.root.fetch(new Request('https://app.example.test/api/pair-recap'));
    await response.json();assert.equal(f.root.RandoriWorkspaceScope.isSolo(room),true);
    f.root.RandoriWorkspaceScope.showRoomCircle(room);
    assert.equal(f.nodes.get('view-code').children[0].textContent,'In Dojo Secondary');
    f.switch();assert.equal(f.root.RandoriWorkspaceScope.isSolo(room),false);
    assert.equal(f.nodes.get('editor').value,'');
  }finally{f.close();}
  const bad=await fixture({body:{ok:true,circle_public_id:'dojo-30',circle_context_version:8}});try{
    await assert.rejects((await bad.root.fetch('/api/messages')).json(),{name:'AbortError'});
  }finally{bad.close();}
});
