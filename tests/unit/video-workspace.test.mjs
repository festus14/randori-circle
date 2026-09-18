import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

const db=createClient({url:'file::memory:'});

function authPayload(req){
  const value=Number(req?.headers?.['x-test-user']);
  return Number.isSafeInteger(value) && value>0 ? {id:value} : null;
}

mock.module('../../api/_db.js', {
  exports: {
    getClient:()=>db,
    verifyRequestAuth:authPayload,
    verifyMutationOrigin:()=>true,
  },
});

const {default:videoHandler}=await import('../../api/video.js');

function invoke({method='GET',url='/api/video/signal',query={},headers={},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
    };
    Promise.resolve(videoHandler({method,url,query,headers,body},response))
      .then(()=>finish(undefined))
      .catch(reject);
  });
}

function workspace(overrides={}){
  return {
    schema_version:2,
    base_revision:0,
    client_id:'client_A1',
    client_seq:0,
    language:'javascript',
    question_id:'focus-block-rollup',
    question_version:1,
    code:'function rollUpFocusBlocks() { return []; }',
    ...overrides,
  };
}

function sampleBoard(){
  return {
    shapes:[
      {id:'pen_1',type:'pen',points:[{x:10,y:20},{x:12.5,y:24}],color:'#e6c07a',width:2.2},
      {id:'rect_1',type:'rect',x:30,y:40,w:120,h:80,color:'#9cc0b5'},
      {id:'ellipse_1',type:'ellipse',x:210,y:80,w:-60,h:45,color:'#d68a8a'},
      {id:'arrow_1',type:'arrow',x1:0,y1:0,x2:100,y2:120,color:'#a3b5d6'},
      {id:'text_1',type:'text',x:80,y:160,text:'Cache boundary',color:'#f4efe8',size:16},
      {id:'sticky_1',type:'sticky',x:260,y:180,w:180,h:120,text:'Validate\nthen publish',bg:'#e6c07a'},
    ],
  };
}

function workspaceV3(overrides={}){
  return workspace({schema_version:3,board:sampleBoard(),...overrides});
}

function post(payload=workspace(),overrides={}){
  return invoke({
    method:'POST',
    headers:{'x-test-user':'2'},
    body:{room_id:'week_10_pair_20',type:'code-sync',payload,...overrides},
  });
}

function get(afterRevision=0,overrides={}){
  return invoke({
    url:`/api/video/signal?room_id=week_10_pair_20&channel=workspace&after_revision=${afterRevision}`,
    query:{room_id:'week_10_pair_20',channel:'workspace',after_revision:String(afterRevision)},
    headers:{'x-test-user':'2'},
    ...overrides,
  });
}

before(async()=>{
  await db.execute(`CREATE TABLE pairing_groups (
    id INTEGER PRIMARY KEY,
    week_id INTEGER NOT NULL,
    user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL,
    user_c_id INTEGER
  )`);
});

beforeEach(async()=>{
  await db.execute(`DELETE FROM pairing_groups`);
  await db.execute({
    sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (?,?,?,?,?)`,
    args:[20,10,2,4,6],
  });
  try{ await db.execute(`DELETE FROM pair_room_snapshots`); }catch{}
  try{ await db.execute(`DELETE FROM video_signals`); }catch{}
});

after(()=>db.close());

test('workspace reads and writes require authentication and exact room membership', async()=>{
  const anonymous=await invoke({
    query:{room_id:'week_10_pair_20',channel:'workspace'},
  });
  assert.equal(anonymous.status,401);

  const outsider=await get(0,{headers:{'x-test-user':'99'}});
  assert.equal(outsider.status,403);

  const malformedRooms=[
    'week_01_pair_20',
    'week_10_pair_020',
    'week_10_pair_20/extra',
    ' week_10_pair_20',
    'WEEK_10_PAIR_20',
    'w10-p20',
  ];
  for(const room_id of malformedRooms){
    const result=await post(workspace(),{room_id});
    assert.equal(result.status,400,room_id);
  }

  const supportedThirdMember=await invoke({
    url:'/api/video/signal?room_id=week_10_pair_20&channel=workspace',
    query:{room_id:'week_10_pair_20',channel:'workspace'},
    headers:{'x-test-user':'6'},
  });
  assert.equal(supportedThirdMember.status,200);

  const objectRoom=await invoke({
    method:'POST',
    headers:{'x-test-user':'2'},
    body:{room_id:{toString:'not-callable'},type:'code-sync',payload:workspace()},
  });
  assert.equal(objectRoom.status,400);
});

test('workspace payload validation is strict and byte-based', async()=>{
  const invalidPayloads=[
    workspace({schema_version:3}),
    workspace({base_revision:-1}),
    workspace({base_revision:Number.MAX_SAFE_INTEGER+1}),
    workspace({client_id:'short'}),
    workspace({client_id:'not+urlsafe'}),
    workspace({client_seq:-1}),
    workspace({client_seq:1.5}),
    workspace({language:'typescript'}),
    workspace({question_version:0}),
    workspace({question_version:1.5}),
    workspace({question_id:'../two-sum'}),
    workspace({question_id:'Two-Sum'}),
    {...workspace(),unexpected:true},
  ];
  for(const payload of invalidPayloads){
    const result=await post(payload);
    assert.equal(result.status,400,JSON.stringify(payload));
  }

  const malformedJson=await post('{not-json');
  assert.equal(malformedJson.status,400);

  const legacyPayload=workspace({schema_version:1});
  delete legacyPayload.question_version;
  const legacy=await post(legacyPayload);
  assert.equal(legacy.status,200);
  assert.equal(legacy.body.snapshot.schema_version,1);
  assert.equal(legacy.body.snapshot.question_version,null);
  assert.deepEqual(legacy.body.snapshot.board,{shapes:[]});
  await db.execute(`DELETE FROM pair_room_snapshots`);

  const exactLimit=await post(workspace({code:'é'.repeat(10*1024)}));
  assert.equal(exactLimit.status,200);
  assert.equal(exactLimit.body.snapshot.revision,1);

  await db.execute(`DELETE FROM pair_room_snapshots`);
  const overCodeLimit=await post(workspace({code:'é'.repeat((10*1024)+1)}));
  assert.equal(overCodeLimit.status,413);

  const overSerializedLimit=await post(workspace({code:'\0'.repeat(20*1024)}));
  assert.equal(overSerializedLimit.status,413);
});

test('workspace v3 stores code and strict board shapes in the existing text envelope', async()=>{
  const payload=workspaceV3();
  const created=await post(payload);
  assert.equal(created.status,200);
  assert.equal(created.body.snapshot.schema_version,3);
  assert.equal(created.body.snapshot.code,payload.code);
  assert.deepEqual(created.body.snapshot.board,payload.board);

  const stored=await db.execute(`SELECT schema_version,code FROM pair_room_snapshots WHERE room_id='week_10_pair_20'`);
  assert.equal(Number(stored.rows[0].schema_version),3);
  assert.deepEqual(JSON.parse(stored.rows[0].code),{code:payload.code,board:payload.board});

  const retry=await post(workspaceV3({code:'must not replace the accepted retry',board:{shapes:[]}}));
  assert.equal(retry.status,200);
  assert.equal(retry.body.idempotent,true);
  assert.equal(retry.body.snapshot.code,payload.code);
  assert.deepEqual(retry.body.snapshot.board,payload.board);

  const restored=await get(0);
  assert.equal(restored.status,200);
  assert.equal(restored.body.snapshot.code,payload.code);
  assert.deepEqual(restored.body.snapshot.board,payload.board);
});

test('workspace v3 rejects malformed and resource-exhausting boards before persistence', async()=>{
  const withoutBoard=workspaceV3();
  delete withoutBoard.board;
  const extraBoardField=workspaceV3({board:{shapes:[],viewport:{x:0,y:0,scale:1}}});
  const duplicateIds=workspaceV3({board:{shapes:[
    {id:'same_id',type:'rect',x:0,y:0,w:10,h:10,color:'#123456'},
    {id:'same_id',type:'ellipse',x:0,y:0,w:10,h:10,color:'#123456'},
  ]}});
  const malformedCases=[
    withoutBoard,
    workspaceV3({board:[]}),
    extraBoardField,
    workspaceV3({board:{shapes:[{id:'shape_1',type:'video',x:0,y:0}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'rect',x:0,y:0,w:10,h:10,color:'#123456',extra:true}]}}),
    workspaceV3({board:{shapes:[{id:'bad id',type:'rect',x:0,y:0,w:10,h:10,color:'#123456'}]}}),
    duplicateIds,
    workspaceV3({board:{shapes:[{id:'shape_1',type:'rect',x:100001,y:0,w:10,h:10,color:'#123456'}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'arrow',x1:0,y1:0,x2:null,y2:10,color:'#123456'}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'text',x:0,y:0,text:'safe',color:'red',size:16}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'text',x:0,y:0,text:'safe',color:'#123456',size:7}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'sticky',x:0,y:0,w:20,h:20,text:42,bg:'#123456'}]}}),
    workspaceV3({board:{shapes:[{id:'shape_1',type:'pen',points:[{x:0,y:0}],color:'#123456',width:2}]}}),
  ];
  for(const payload of malformedCases){
    const result=await post(payload);
    assert.equal(result.status,400,JSON.stringify(payload));
  }

  // V3 reserves room for the board while retaining the independent 20 KiB
  // source-code ceiling. Escaped JSON bytes no longer consume the legacy
  // protocol's entire 24 KiB envelope.
  const escapedCodeAtLimit=await post(workspaceV3({code:'\0'.repeat(20*1024)}));
  assert.equal(escapedCodeAtLimit.status,200);

  const tooManyShapes=workspaceV3({board:{shapes:Array.from({length:501},(_,index)=>({
    id:`shape_${index}`,type:'rect',x:0,y:0,w:1,h:1,color:'#123456',
  }))}});
  assert.equal((await post(tooManyShapes)).status,413);

  const tooManyPenPoints=workspaceV3({board:{shapes:[{
    id:'pen_large',type:'pen',points:Array.from({length:2001},()=>({x:0,y:0})),color:'#123456',width:2,
  }]}});
  assert.equal((await post(tooManyPenPoints)).status,413);

  const tooManyTotalPoints=workspaceV3({board:{shapes:Array.from({length:6},(_,index)=>({
    id:`pen_${index}`,type:'pen',points:Array.from({length:1667},()=>({x:0,y:0})),color:'#123456',width:2,
  }))}});
  assert.equal((await post(tooManyTotalPoints)).status,413);

  const oversizedText=workspaceV3({board:{shapes:[{
    id:'text_large',type:'text',x:0,y:0,text:'é'.repeat(101),color:'#123456',size:16,
  }]}});
  assert.equal((await post(oversizedText)).status,413);

  const oversizedSticky=workspaceV3({board:{shapes:[{
    id:'sticky_large',type:'sticky',x:0,y:0,w:20,h:20,text:'é'.repeat(151),bg:'#123456',
  }]}});
  assert.equal((await post(oversizedSticky)).status,413);

  const oversizedBoard=workspaceV3({board:{shapes:Array.from({length:5},(_,index)=>({
    id:`pen_wide_${index}`,
    type:'pen',
    points:Array.from({length:2000},()=>({x:100000,y:-100000})),
    color:'#123456',
    width:2,
  }))}});
  const boardResult=await post(oversizedBoard);
  assert.equal(boardResult.status,413);
  assert.match(boardResult.body.error,/board too large/i);
});

test('workspace v3 keeps legacy reads compatible and prevents every schema downgrade', async()=>{
  const legacyV2=await post();
  assert.equal(legacyV2.status,200);
  assert.deepEqual(legacyV2.body.snapshot.board,{shapes:[]});

  const upgraded=await post(workspaceV3({
    base_revision:1,
    client_id:'client_V3',
    client_seq:1,
    code:'const upgraded = true;',
  }));
  assert.equal(upgraded.status,200);
  assert.equal(upgraded.body.snapshot.schema_version,3);

  const v2Downgrade=await post(workspace({
    base_revision:2,
    client_id:'client_V2',
    client_seq:2,
    code:'const downgrade = true;',
  }));
  assert.equal(v2Downgrade.status,409);
  assert.match(v2Downgrade.body.error,/schema version 2 cannot overwrite workspace schema version 3/i);
  assert.deepEqual(v2Downgrade.body.current.board,sampleBoard());

  const v1Downgrade=workspace({
    schema_version:1,
    base_revision:2,
    client_id:'client_V1',
    client_seq:2,
    code:'legacy downgrade',
  });
  delete v1Downgrade.question_version;
  const v1Result=await post(v1Downgrade);
  assert.equal(v1Result.status,409);
  assert.match(v1Result.body.error,/schema version 1 cannot overwrite workspace schema version 3/i);
});

test('workspace v3 CAS conflicts carry code and board so a rebased update preserves both', async()=>{
  const emptyBoard={shapes:[]};
  assert.equal((await post(workspaceV3({board:emptyBoard}))).status,200);

  const boardEdit={shapes:[{id:'rect_edit',type:'rect',x:10,y:15,w:40,h:30,color:'#9cc0b5'}]};
  const [codeResult,boardResult]=await Promise.all([
    post(workspaceV3({base_revision:1,client_id:'client_CODE',client_seq:1,code:'const concurrent = true;',board:emptyBoard})),
    post(workspaceV3({base_revision:1,client_id:'client_BOARD',client_seq:1,board:boardEdit})),
  ]);
  assert.deepEqual([codeResult.status,boardResult.status].sort(),[200,409]);
  const conflict=codeResult.status===409 ? codeResult : boardResult;
  assert.equal(conflict.body.current.revision,2);
  assert.equal(typeof conflict.body.current.code,'string');
  assert.ok(Array.isArray(conflict.body.current.board.shapes));

  const rebased=await post(workspaceV3({
    base_revision:2,
    client_id:'client_REBASE',
    client_seq:2,
    code:'const concurrent = true;',
    board:boardEdit,
  }));
  assert.equal(rebased.status,200);
  assert.equal(rebased.body.snapshot.revision,3);
  assert.equal(rebased.body.snapshot.code,'const concurrent = true;');
  assert.deepEqual(rebased.body.snapshot.board,boardEdit);
});

test('workspace v3 snapshots remain isolated by canonical room', async()=>{
  await db.execute({
    sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (?,?,?,?,?)`,
    args:[21,10,2,7,null],
  });
  const firstBoard={shapes:[{id:'first',type:'rect',x:1,y:2,w:3,h:4,color:'#123456'}]};
  const secondBoard={shapes:[{id:'second',type:'ellipse',x:5,y:6,w:7,h:8,color:'#abcdef'}]};
  assert.equal((await post(workspaceV3({board:firstBoard}))).status,200);
  assert.equal((await post(workspaceV3({client_id:'client_ROOM2',board:secondBoard}),{room_id:'week_10_pair_21'})).status,200);

  const first=await get();
  const second=await get(0,{
    url:'/api/video/signal?room_id=week_10_pair_21&channel=workspace&after_revision=0',
    query:{room_id:'week_10_pair_21',channel:'workspace',after_revision:'0'},
  });
  assert.deepEqual(first.body.snapshot.board,firstBoard);
  assert.deepEqual(second.body.snapshot.board,secondBoard);
});

test('workspace snapshots use monotonic CAS revisions and idempotent client sequence retries', async()=>{
  const created=await post();
  assert.equal(created.status,200);
  assert.equal(created.body.idempotent,false);
  assert.equal(created.body.snapshot.revision,1);
  assert.equal(created.body.snapshot.updated_by,2);
  assert.equal(created.body.snapshot.question_version,1);
  const stored=await db.execute(`SELECT question_id FROM pair_room_snapshots WHERE room_id='week_10_pair_20'`);
  assert.equal(stored.rows[0].question_id,'focus-block-rollup@1');

  const retry=await post(workspace({code:'this changed but must not overwrite the accepted retry'}));
  assert.equal(retry.status,200);
  assert.equal(retry.body.idempotent,true);
  assert.equal(retry.body.snapshot.code,'function rollUpFocusBlocks() { return []; }');
  assert.equal(retry.body.snapshot.question_version,1);

  const stale=await post(workspace({client_id:'client_B2',client_seq:0,code:'stale'}));
  assert.equal(stale.status,409);
  assert.equal(stale.body.current.revision,1);
  assert.equal(stale.body.current.code,'function rollUpFocusBlocks() { return []; }');

  const updated=await post(workspace({
    base_revision:1,
    client_id:'client_B2',
    client_seq:1,
    language:'python',
    code:'def roll_up_focus_blocks():\n    return []',
  }));
  assert.equal(updated.status,200);
  assert.equal(updated.body.snapshot.revision,2);
  assert.equal(updated.body.snapshot.language,'python');
  assert.equal(updated.body.snapshot.question_version,1);

  const downgradePayload=workspace({
    schema_version:1,
    base_revision:2,
    client_id:'legacy-client',
    client_seq:2,
    code:'legacy overwrite',
  });
  delete downgradePayload.question_version;
  const downgrade=await post(downgradePayload);
  assert.equal(downgrade.status,409);
  assert.match(downgrade.body.error,/cannot overwrite/i);
  assert.equal(downgrade.body.current.revision,2);
  assert.equal(downgrade.body.current.question_version,1);

  const changed=await get(1);
  assert.equal(changed.status,200);
  assert.equal(changed.body.revision,2);
  assert.equal(changed.body.snapshot.code,'def roll_up_focus_blocks():\n    return []');

  const unchanged=await get(2);
  assert.equal(unchanged.status,200);
  assert.equal(unchanged.body.revision,2);
  assert.equal(unchanged.body.snapshot,null);

  const invalidAfter=await get('01');
  assert.equal(invalidAfter.status,400);

  const signals=await db.execute(`SELECT COUNT(*) AS count FROM video_signals`);
  assert.equal(Number(signals.rows[0].count),0,'workspace code must never enter transient video_signals');
});

test('competing writes from the same base allow exactly one CAS winner', async()=>{
  // Create the runtime tables before racing so the test isolates snapshot CAS.
  assert.equal((await get(0)).status,200);
  const [left,right]=await Promise.all([
    post(workspace({client_id:'client_C3',code:'left'})),
    post(workspace({client_id:'client_D4',code:'right'})),
  ]);
  assert.deepEqual([left.status,right.status].sort(),[200,409]);

  const current=await get(0);
  assert.equal(current.body.snapshot.revision,1);
  assert.ok(['left','right'].includes(current.body.snapshot.code));

  const [updateLeft,updateRight]=await Promise.all([
    post(workspace({base_revision:1,client_id:'client_E5',client_seq:1,code:'updated-left'})),
    post(workspace({base_revision:1,client_id:'client_F6',client_seq:1,code:'updated-right'})),
  ]);
  assert.deepEqual([updateLeft.status,updateRight.status].sort(),[200,409]);
  const updated=await get(1);
  assert.equal(updated.body.snapshot.revision,2);
  assert.ok(['updated-left','updated-right'].includes(updated.body.snapshot.code));
});

test('workspace query parameters can be parsed from the URL without framework query hydration', async()=>{
  const result=await invoke({
    url:'/api/video/signal?room_id=week_10_pair_20&channel=workspace&after_revision=0',
    headers:{'x-test-user':'2'},
  });
  assert.equal(result.status,200);
  assert.equal(result.body.revision,0);
});
