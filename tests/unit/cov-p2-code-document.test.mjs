// Branch-level coverage for api/_code-document.js using a scripted database.
// The libSQL-backed suites in code-document.test.mjs prove the end-to-end
// behaviour; these tests pin the fail-closed validation, authorization
// scoping, compare-and-swap and retry branches that a real database cannot
// easily be coaxed into (corrupt rows, busy errors, lost CAS races).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import * as Y from 'yjs';

import {
  CODE_DOCUMENT_CODE_LIMIT_BYTES,
  CODE_DOCUMENT_UPDATE_LIMIT_BYTES,
  CodeDocumentDataError,
  CodeDocumentInputError,
  codeDocumentAccessSql,
  codeDocumentResponse,
  codeDocumentVersion,
  getAuthorizedCodeDocument,
  mergeAuthorizedCodeDocument,
  parseCodeDocumentMutation,
  parseCodeDocumentQuery,
  purgeExpiredCodeDocuments,
  readCanonicalCodeForExecution,
  readCodeProjectionForWorkspace,
  readCodeProjectionInTransaction,
} from '../../api/_code-document.js';

const ROOM={roomId:'week_10_pair_20',weekId:10,pairGroupId:20};
const IDENTITY={...ROOM,questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript'};
const QUERY={room_id:'week_10_pair_20',question_slug:'focus-block-rollup',question_version:'1',language:'javascript'};
const PAIR_ROW=Object.freeze({pair_group_id:20,week_id:10,user_a_id:1,user_b_id:2,user_c_id:null,
  is_ai_pair:0,user_a_source:'auth',user_b_source:'auth',user_c_source:null});

afterEach(()=>{ mock.timers.reset(); delete process.env.CIRCLE_MEMBERSHIP_ENABLED; });

const sha256=value=>createHash('sha256').update(value).digest('hex');

function docState(code,edit){
  const doc=new Y.Doc({gc:true});
  if(code) doc.getText('code').insert(0,code);
  edit?.(doc);
  return Buffer.from(Y.encodeStateAsUpdate(doc));
}

function storedRow(code='return base;',overrides={},{edit}={}){
  const state=docState(code,edit);
  return {week_id:10,pair_group_id:20,question_slug:'focus-block-rollup',question_version:1,language:'javascript',
    y_state_base64:state.toString('base64'),state_hash:sha256(state),code_hash:sha256(Buffer.from(code,'utf8')),
    revision:3,pair_user_a_id:1,pair_user_a_source:'auth',pair_user_b_id:2,pair_user_b_source:'auth',
    pair_user_c_id:null,last_actor_id:1,last_actor_source:'auth',last_client_id:'client_A1',last_client_seq:1,
    created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-02T00:00:00.000Z',retention_expired:0,...overrides};
}

function updateFrom(row,edit){
  const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(row.y_state_base64,'base64'));
  const vector=Y.encodeStateVector(doc); edit(doc);
  return Y.encodeStateAsUpdate(doc,vector);
}

// Routes each statement to the first matching handler. A handler may be a
// static result, a function of (statement, log), or throw.
function fakeDb(routes={},{transactions=true,onCommit,onRollback,closeThrows=false}={}){
  const log=[];
  const table=[
    ['access',/^SELECT pg\.id AS pair_group_id/],
    ['completion',/confirmed_count/],
    ['stale',/AS stale/],
    ['read',/retention_expired/],
    ['seed',/SELECT schema_version,language,question_id,code/],
    ['snapshot',/SELECT revision,schema_version,code FROM pair_room_snapshots/],
    ['insert',/INSERT INTO pair_code_documents/],
    ['update',/UPDATE pair_code_documents/],
    ['project',/UPDATE pair_room_snapshots/],
    ['deleteSnapshot',/DELETE FROM pair_room_snapshots/],
    ['deleteDocument',/DELETE FROM pair_code_documents/],
    ['present',/AS present/],
    ['retention',/ORDER BY updated_at/],
  ];
  const defaults={access:{rows:[PAIR_ROW]},completion:{rows:[{confirmed_count:0}]},stale:{rows:[]},
    read:{rows:[storedRow()]},seed:{rows:[]},snapshot:{rows:[]},insert:{rowsAffected:1},update:{rowsAffected:1},
    project:{rowsAffected:1},deleteSnapshot:{rowsAffected:1},deleteDocument:{rowsAffected:1},present:{rows:[{present:1}]},
    retention:{rows:[]}};
  const execute=async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    const entry=table.find(([,pattern])=>pattern.test(sql.trim()));
    const name=entry?.[0]||'unknown';
    log.push({name,args:statement.args});
    const handler=name in routes?routes[name]:defaults[name];
    return typeof handler==='function'?handler(statement,log):(handler??{rows:[],rowsAffected:0});
  };
  const db={log,execute,count:name=>log.filter(entry=>entry.name===name).length};
  if(transactions){
    db.transaction=async mode=>{
      log.push({name:`begin:${mode}`});
      return {execute,
        commit:async()=>{ log.push({name:'commit'}); await onCommit?.(log); },
        rollback:async()=>{ log.push({name:'rollback'}); await onRollback?.(log); },
        close:()=>{ log.push({name:'close'}); if(closeThrows) throw new Error('close failed'); }};
    };
  }
  return db;
}

// Drives retryDelay's setTimeout deterministically under mocked timers.
async function withMockedTimers(operation){
  mock.timers.enable({apis:['setTimeout']});
  const promise=Promise.resolve().then(operation);
  let settled=false;
  promise.then(()=>{ settled=true; },()=>{ settled=true; });
  try{
    while(!settled){
      await new Promise(resolve=>setImmediate(resolve));
      mock.timers.tick(300);
    }
  }finally{ mock.timers.reset(); }
  return promise;
}

const busy=(extra={})=>Object.assign(new Error('write conflict'),{code:'SQLITE_BUSY'},extra);

function assertInput(fn,pattern,status=400){
  assert.throws(fn,error=>error instanceof CodeDocumentInputError&&pattern.test(error.message)&&error.status===status);
}

test('query parsing merges req.query with the URL and rejects ambiguous or unsupported parameters',()=>{
  const fromUrl=parseCodeDocumentQuery({url:`/api/code-document?${new URLSearchParams(QUERY)}`});
  assert.deepEqual({...fromUrl},{...IDENTITY,afterRevision:0});
  // Matching duplicates between req.query and the URL collapse to one value.
  const same=parseCodeDocumentQuery({query:{...QUERY,after_revision:'4'},url:`/x?after_revision=4`});
  assert.equal(same.afterRevision,4);
  // Empty cursor is treated as zero.
  assert.equal(parseCodeDocumentQuery({query:{...QUERY,after_revision:''}}).afterRevision,0);
  // A conflicting value in the URL becomes an array and is refused.
  assertInput(()=>parseCodeDocumentQuery({query:QUERY,url:'/x?language=python'}),/unsupported query parameter/);
  // Repeated URL keys are refused.
  assertInput(()=>parseCodeDocumentQuery({query:QUERY,url:'/x?language=javascript&language=python'}),/unsupported/);
  // An array already in req.query stays an array even when the URL repeats it.
  assertInput(()=>parseCodeDocumentQuery({query:{...QUERY,language:['javascript']},url:'/x?language=javascript'}),/unsupported/);
  assertInput(()=>parseCodeDocumentQuery({query:{...QUERY,extra:'1'}}),/unsupported query parameter/);
  // Array-shaped req.query is ignored instead of being trusted.
  assertInput(()=>parseCodeDocumentQuery({query:['room_id'],url:'/x'}),/canonical room_id required/);
  // A malformed URL is ignored; req.query still drives parsing.
  assert.equal(parseCodeDocumentQuery({query:QUERY,url:'http://['}).language,'javascript');
  for(const after of ['-1','1.5','abc',String(Number.MAX_SAFE_INTEGER+2)]){
    assertInput(()=>parseCodeDocumentQuery({query:{...QUERY,after_revision:after}}),/after_revision/);
  }
});

test('identity parsing requires a canonical room, slug, version, language and a published exercise',()=>{
  const base={...QUERY};
  assertInput(()=>parseCodeDocumentQuery({query:{...base,room_id:undefined}}),/canonical room_id/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,room_id:'week_10_pair_020'}}),/canonical room_id/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,question_slug:undefined}}),/valid question_slug/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,question_slug:'Bad_Slug'}}),/valid question_slug/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,question_slug:'a'.repeat(121)}}),/valid question_slug/);
  for(const version of ['0','-2','x','1.5']){
    assertInput(()=>parseCodeDocumentQuery({query:{...base,question_version:version}}),/positive question_version/);
  }
  assertInput(()=>parseCodeDocumentQuery({query:{...base,language:undefined}}),/javascript or python/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,language:'ruby'}}),/javascript or python/);
  assertInput(()=>parseCodeDocumentQuery({query:{...base,question_version:'99'}}),/question not found/,404);
});

test('mutation parsing requires exact fields, a bounded client identity and canonical bounded base64',()=>{
  const update=Buffer.from(updateFrom(storedRow(''),doc=>doc.getText('code').insert(0,'x'))).toString('base64');
  const body={room_id:QUERY.room_id,question_slug:QUERY.question_slug,question_version:1,language:'javascript',
    update,client_id:'client_A1',client_seq:0};
  const parsed=parseCodeDocumentMutation(body);
  assert.equal(parsed.clientId,'client_A1'); assert.ok(parsed.update instanceof Uint8Array);
  assert.ok(Object.isFrozen(parsed));
  for(const bad of [null,[],'body',{...body,extra:true},(({client_seq,...rest})=>rest)(body)]){
    assertInput(()=>parseCodeDocumentMutation(bad),/unexpected or missing/);
  }
  for(const clientId of [7,'short','x'.repeat(65),'has space!']){
    assertInput(()=>parseCodeDocumentMutation({...body,client_id:clientId}),/client_id must be/);
  }
  for(const clientSeq of [-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){
    assertInput(()=>parseCodeDocumentMutation({...body,client_seq:clientSeq}),/client_seq must be/);
  }
  for(const encoded of [42,'AA','not base64!','A===']){
    assertInput(()=>parseCodeDocumentMutation({...body,update:encoded}),/canonical base64/);
  }
  // "AB==" decodes to the same single byte as "AA==" and is therefore non-canonical.
  assertInput(()=>parseCodeDocumentMutation({...body,update:'AB=='}),/canonical base64/);
  const oversized=Buffer.alloc(CODE_DOCUMENT_UPDATE_LIMIT_BYTES+1,1).toString('base64');
  assertInput(()=>parseCodeDocumentMutation({...body,update:oversized}),/exceeds its byte limit/,413);
});

test('access SQL adds active primary-circle membership joins only when membership is enforced',()=>{
  assert.doesNotMatch(codeDocumentAccessSql(),/circle_memberships/);
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  const sql=codeDocumentAccessSql();
  assert.match(sql,/JOIN circle_memberships AS viewer_membership/);
  assert.match(sql,/viewer_circle\.is_primary=1 AND viewer_circle\.archived_at IS NULL/);
});

test('authorization rejects every row that is not an exact two-person human pair containing the viewer',async()=>{
  const variants=[
    {rows:[]},{rows:[PAIR_ROW,PAIR_ROW]},{},null,
    {rows:[{...PAIR_ROW,week_id:0}]},{rows:[{...PAIR_ROW,pair_group_id:'x'}]},
    {rows:[{...PAIR_ROW,user_a_id:null}]},{rows:[{...PAIR_ROW,user_b_id:-2}]},
    {rows:[{...PAIR_ROW,user_b_id:1}]},{rows:[{...PAIR_ROW,is_ai_pair:1}]},
    {rows:[{...PAIR_ROW,user_c_id:3}]},{rows:[{...PAIR_ROW,user_a_source:'users'}]},
    {rows:[{...PAIR_ROW,user_b_source:'users'}]},{rows:[{...PAIR_ROW,user_c_source:'auth'}]},
    {rows:[{...PAIR_ROW,user_a_id:5,user_b_id:6}]},
  ];
  for(const access of variants){
    const db=fakeDb({access});
    assert.equal(await getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY}),null);
    assert.equal(db.count('read'),0,'no document is read for a denied viewer');
    assert.equal(db.log.at(-1).name,'close');
    assert.ok(db.log.some(entry=>entry.name==='rollback'));
  }
});

test('reading an unchanged revision returns metadata only; a newer cursor returns full state',async()=>{
  const row=storedRow('let x=1;',{revision:5});
  const db=fakeDb({read:{rows:[row]}});
  const unchanged=await getAuthorizedCodeDocument(db,{viewerId:2,...IDENTITY,afterRevision:5});
  assert.equal(unchanged.document.state,null); assert.equal(unchanged.document.code,null);
  assert.equal(unchanged.created,false); assert.equal(db.log[0].name,'begin:read');
  assert.equal(unchanged.document.version,codeDocumentVersion({...IDENTITY,revision:5,stateHash:row.state_hash,codeHash:row.code_hash}));
  assert.deepEqual(codeDocumentResponse(unchanged,{afterRevision:5}),{ok:true,changed:false,created:false,revision:5,
    document_version:unchanged.document.version,state:null,code_hash:row.code_hash,updated_at:row.updated_at});
  assert.equal(db.count('begin:write'),0,'unchanged read never takes a write transaction');

  const behind=await getAuthorizedCodeDocument(fakeDb({read:{rows:[row]}}),{viewerId:2,...IDENTITY,afterRevision:2});
  assert.equal(behind.document.code,'let x=1;'); assert.equal(behind.document.state,row.y_state_base64);
  assert.equal(codeDocumentResponse(behind,{afterRevision:2}).changed,true);

  const denied=fakeDb({access:{rows:[]}});
  assert.equal(await getAuthorizedCodeDocument(denied,{viewerId:1,...IDENTITY,afterRevision:5}),null);
  assert.equal(denied.count('begin:write'),0);
});

test('an expired or missing document on the read path falls through to the write path and rebuilds',async()=>{
  for(const read of [{rows:[storedRow('old',{retention_expired:1})]},{rows:[]}]){
    let reads=0;
    const fresh=storedRow('',{revision:1});
    const db=fakeDb({read:()=>(reads++===0?read:{rows:[fresh]}),insert:{rowsAffected:0}});
    const result=await getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY,afterRevision:3});
    assert.equal(result.document.revision,1);
    assert.equal(db.count('begin:read'),1); assert.equal(db.count('begin:write'),1);
    // Losing the ON CONFLICT race still reads the winner's row and reports created:false.
    if(read.rows.length===0) assert.equal(result.created,false);
  }
});

test('a corrupt row on the unchanged-read path rolls back and surfaces a data error',async()=>{
  const db=fakeDb({read:{rows:[storedRow('x',{revision:0})]}},{closeThrows:true});
  await assert.rejects(getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY,afterRevision:2}),
    error=>error instanceof CodeDocumentDataError&&/metadata is invalid/.test(error.message));
  assert.ok(db.log.some(entry=>entry.name==='rollback'));
});

test('stored metadata validation fails closed for every identity, actor and hash mismatch',async()=>{
  const bad=[
    {revision:0},{revision:'x'},{pair_user_a_id:null},{pair_user_b_id:0},{pair_user_b_id:1},
    {pair_user_a_source:'users'},{pair_user_b_source:'users'},{pair_user_c_id:3},{last_actor_source:'users'},
    {last_actor_id:9},{week_id:11},{pair_group_id:21},{question_slug:'other'},{question_version:2},
    {language:'python'},
  ];
  for(const overrides of bad){
    await assert.rejects(getAuthorizedCodeDocument(fakeDb({read:{rows:[storedRow('x',overrides)]}}),{viewerId:1,...IDENTITY}),
      error=>error instanceof CodeDocumentDataError&&/metadata is invalid/.test(error.message),JSON.stringify(overrides));
  }
  for(const overrides of [{state_hash:'nothex'},{code_hash:null},{state_hash:undefined}]){
    await assert.rejects(getAuthorizedCodeDocument(fakeDb({read:{rows:[storedRow('x',overrides)]}}),{viewerId:1,...IDENTITY}),
      /hashes are invalid/);
  }
});

test('stored CRDT state must decode, hash-match, parse, stay plain text and match its code hash',async()=>{
  const call=row=>getAuthorizedCodeDocument(fakeDb({read:{rows:[row]}}),{viewerId:1,...IDENTITY});
  const notBase64=storedRow('x',{y_state_base64:'!!!!'});
  await assert.rejects(call(notBase64),error=>error instanceof CodeDocumentDataError
    &&/stored code document is invalid/.test(error.message)&&error.cause instanceof CodeDocumentInputError);
  await assert.rejects(call(storedRow('x',{y_state_base64:null})),/stored code document is invalid/);
  await assert.rejects(call(storedRow('x',{state_hash:'0'.repeat(64)})),/stored code document hash is invalid/);
  const garbage=Buffer.from([0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff]);
  await assert.rejects(call(storedRow('x',{y_state_base64:garbage.toString('base64'),state_hash:sha256(garbage)})),
    error=>error instanceof CodeDocumentDataError&&/corrupt/.test(error.message));
  const mapped=storedRow('x',{},{edit:doc=>doc.getMap('extra').set('k','v')});
  await assert.rejects(call(mapped),error=>error instanceof CodeDocumentDataError&&/unsupported shared types/.test(error.message));
  const rich=storedRow('x',{},{edit:doc=>doc.getText('code').format(0,1,{bold:true})});
  await assert.rejects(call(rich),error=>error instanceof CodeDocumentDataError&&/rich content/.test(error.message));
  await assert.rejects(call(storedRow('x',{code_hash:'a'.repeat(64)})),/stored code hash is invalid/);
  await assert.rejects(getAuthorizedCodeDocument(fakeDb({read:{rows:null}}),{viewerId:1,...IDENTITY}),
    /code document query is invalid/);
});

test('bootstrap seeds only from the matching workspace and validates the v3 envelope and code limit',async()=>{
  const bootstrap=async seedRow=>{
    let inserted=null;
    const db=fakeDb({read:()=>(inserted?{rows:[inserted]}:{rows:[]}),seed:{rows:seedRow?[seedRow]:[]},
      insert:statement=>{
        // Arguments after the six access bindings: week, pair, slug, version, language, state.
        const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(statement.args[11],'base64'));
        inserted=storedRow(doc.getText('code').toString(),{revision:1});
        return {rowsAffected:1};
      }});
    return getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY});
  };
  const seed={schema_version:3,language:'javascript',question_id:'focus-block-rollup@1',
    code:JSON.stringify({code:'seeded();',board:{}})};
  const seeded=await bootstrap(seed);
  assert.equal(seeded.created,true); assert.equal(seeded.document.code,'seeded();');
  assert.equal((await bootstrap({...seed,schema_version:2,code:'legacy();'})).document.code,'legacy();');
  assert.equal((await bootstrap({...seed,language:'python'})).document.code,'');
  assert.equal((await bootstrap({...seed,question_id:'focus-block-rollup@2'})).document.code,'');
  assert.equal((await bootstrap({...seed,question_id:null})).document.code,'');
  assert.equal((await bootstrap(null)).document.code,'');
  assert.equal((await bootstrap({...seed,schema_version:2,code:null})).document.code,'');
  for(const code of ['{',JSON.stringify([1]),JSON.stringify({code:5}),'null']){
    await assert.rejects(bootstrap({...seed,code}),
      error=>error instanceof CodeDocumentDataError&&/bootstrap is invalid/.test(error.message));
  }
  await assert.rejects(bootstrap({...seed,code:JSON.stringify({code:'x'.repeat(CODE_DOCUMENT_CODE_LIMIT_BYTES+1)})}),
    /bootstrap exceeds the code limit/);
});

test('read contention retries with backoff, then reports the retry bound; non-retryable errors fail fast',async()=>{
  let attempts=0;
  const recovering=fakeDb({access:()=>{ attempts+=1; if(attempts<3) throw busy(); return {rows:[PAIR_ROW]}; }});
  const result=await withMockedTimers(()=>getAuthorizedCodeDocument(recovering,{viewerId:1,...IDENTITY}));
  assert.equal(result.document.code,'return base;'); assert.equal(attempts,3);
  assert.equal(recovering.count('rollback'),2);

  const stuck=fakeDb({access:()=>{ throw busy(); }});
  await assert.rejects(withMockedTimers(()=>getAuthorizedCodeDocument(stuck,{viewerId:1,...IDENTITY})),/write conflict/);
  assert.equal(stuck.count('begin:write'),4);

  const fatal=fakeDb({access:()=>{ throw new Error('disk I/O error'); }});
  await assert.rejects(getAuthorizedCodeDocument(fatal,{viewerId:1,...IDENTITY}),/disk I\/O error/);
  assert.equal(fatal.count('begin:write'),1);

  // A rollback failure while recovering is swallowed and the original error wins.
  const rollbackFails=fakeDb({access:()=>{ throw new Error('boom'); }},{onRollback:()=>{ throw new Error('rollback lost'); }});
  await assert.rejects(getAuthorizedCodeDocument(rollbackFails,{viewerId:1,...IDENTITY}),/^Error: boom$/);
});

test('retryable conflict detection follows codes, raw codes, lock messages and nested causes',async()=>{
  const retryable=[
    Object.assign(new Error('x'),{rawCode:'sqlite_locked'}),
    Object.assign(new Error('x'),{code:'TRANSACTION_CONFLICT'}),
    new Error('database is locked'),new Error('SQLITE_BUSY: database is locked'),
    new Error('SQLITE_LOCKED - database table is locked'),new Error('Database is busy'),
    new Error('outer',{cause:new Error('mid',{cause:Object.assign(new Error('inner'),{code:'LIBSQL_TRANSACTION_BUSY'})})}),
  ];
  for(const error of retryable){
    let attempts=0;
    const db=fakeDb({access:()=>{ attempts+=1; if(attempts===1) throw error; return {rows:[PAIR_ROW]}; }});
    await withMockedTimers(()=>getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY}));
    assert.equal(attempts,2,error.message);
  }
  let deep=Object.assign(new Error('deep'),{code:'SQLITE_BUSY'});
  for(let depth=0;depth<6;depth+=1) deep=new Error(`wrap ${depth}`,{cause:deep});
  for(const error of [new Error('database is locked forever'),deep,Object.assign(new Error('x'),{code:'SQLITE_CONSTRAINT'})]){
    let attempts=0;
    const db=fakeDb({access:()=>{ attempts+=1; throw error; }});
    await assert.rejects(getAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY}));
    assert.equal(attempts,1,error.message);
  }
});

test('merge refuses denied viewers and completed sessions without writing',async()=>{
  const update=updateFrom(storedRow(),doc=>doc.getText('code').insert(0,'A'));
  const input={viewerId:1,...IDENTITY,update,clientId:'client_A1',clientSeq:1};
  const denied=fakeDb({access:{rows:[]}});
  assert.equal(await mergeAuthorizedCodeDocument(denied,input),null);
  assert.equal(denied.count('update'),0);
  const completed=fakeDb({completion:{rows:[{confirmed_count:2}]}});
  assert.deepEqual(await mergeAuthorizedCodeDocument(completed,input),{terminal:true});
  assert.equal(completed.count('read'),0); assert.equal(completed.count('rollback'),1);
  // One confirmation is not completion.
  const half=fakeDb({completion:{rows:[{confirmed_count:1}]}});
  assert.equal((await mergeAuthorizedCodeDocument(half,input)).idempotent,false);
  for(const completion of [{rows:[]},{rows:[{},{}]},null]){
    await assert.rejects(mergeAuthorizedCodeDocument(fakeDb({completion}),input),
      error=>error instanceof CodeDocumentDataError&&/completion boundary is unavailable/.test(error.message));
  }
});

test('merge CAS conflicts retry from a fresh read and give up after the bounded attempts',async()=>{
  const row=storedRow();
  const update=updateFrom(row,doc=>doc.getText('code').insert(0,'A'));
  const input={viewerId:2,...IDENTITY,update,clientId:'client_B2',clientSeq:4};
  let updates=0;
  const after=storedRow('Areturn base;',{revision:4,last_actor_id:2});
  const winner=fakeDb({read:()=>({rows:[updates>=2?after:row]}),update:statement=>{
    updates+=1;
    // The CAS predicate binds both the expected revision and state hash.
    assert.deepEqual(statement.args.slice(-2),[3,row.state_hash]);
    return {rowsAffected:updates===1?0:1};
  }});
  const merged=await mergeAuthorizedCodeDocument(winner,input);
  assert.equal(merged.idempotent,false); assert.equal(merged.document.code,'Areturn base;');
  assert.equal(updates,2); assert.equal(winner.count('begin:write'),2);
  assert.equal(winner.count('project'),0,'no v3 snapshot means no projection write');

  const alwaysLoses=fakeDb({update:{rowsAffected:0}});
  await assert.rejects(mergeAuthorizedCodeDocument(alwaysLoses,input),
    error=>error instanceof CodeDocumentDataError&&/merge contention exceeded/.test(error.message));
  assert.equal(alwaysLoses.count('update'),4);
});

test('merge creates a missing document with the client identity and rejects malformed Yjs updates',async()=>{
  let inserted=null;
  const db=fakeDb({read:()=>({rows:inserted?[inserted]:[]}),insert:statement=>{
    assert.deepEqual(statement.args.slice(-3),[1,'client_A1',7]);
    inserted=storedRow('',{revision:1}); return {rowsAffected:1};
  },update:()=>{ inserted=storedRow('A',{revision:2}); return {rowsAffected:1}; }});
  const update=updateFrom(storedRow(''),doc=>doc.getText('code').insert(0,'A'));
  const merged=await mergeAuthorizedCodeDocument(db,{viewerId:1,...IDENTITY,update,clientId:'client_A1',clientSeq:7});
  assert.equal(merged.document.revision,2);

  await assert.rejects(mergeAuthorizedCodeDocument(fakeDb(),{viewerId:1,...IDENTITY,
    update:new Uint8Array([0xff,0xff,0xff,0xff,0xff,0xff]),clientId:'client_A1',clientSeq:1}),
  error=>error instanceof CodeDocumentInputError&&/not a valid Yjs update/.test(error.message));
});

test('merged content is bounded to plain text and the code byte limit',async()=>{
  const row=storedRow('');
  const merge=update=>mergeAuthorizedCodeDocument(fakeDb({read:{rows:[row]}}),{viewerId:1,...IDENTITY,update,clientId:'client_A1',clientSeq:1});
  await assert.rejects(merge(updateFrom(row,doc=>doc.getMap('meta').set('x',1))),
    error=>error instanceof CodeDocumentInputError&&error.status===400&&/unsupported shared types/.test(error.message));
  await assert.rejects(merge(updateFrom(row,doc=>doc.getText('code').insert(0,'x',{bold:true}))),
    /unformatted text only/);
  await assert.rejects(merge(updateFrom(row,doc=>doc.getText('code').insert(0,'é'.repeat(CODE_DOCUMENT_CODE_LIMIT_BYTES/2+1)))),
    error=>error instanceof CodeDocumentInputError&&error.status===413&&/20000-byte limit/.test(error.message));
});

test('merge projects code into a v3 workspace snapshot and refuses a corrupt projection envelope',async()=>{
  const row=storedRow();
  const update=updateFrom(row,doc=>doc.getText('code').insert(0,'A'));
  const input={viewerId:1,...IDENTITY,update,clientId:'client_A1',clientSeq:2};
  let written=false;
  const snapshot={revision:8,schema_version:3,code:JSON.stringify({code:'old',board:{shapes:[1]}})};
  let projected;
  const db=fakeDb({read:()=>({rows:[written?storedRow('Areturn base;',{revision:4}):row]}),
    update:()=>{ written=true; return {rowsAffected:1}; },snapshot:{rows:[snapshot]},
    project:statement=>{ projected=statement.args.slice(6); return {rowsAffected:0}; }});
  const merged=await mergeAuthorizedCodeDocument(db,input);
  assert.equal(merged.document.revision,4);
  // client_seq is the new revision, code keeps the board, and the CAS binds the snapshot revision.
  assert.deepEqual(projected,[4,JSON.stringify({code:'Areturn base;',board:{shapes:[1]}}),1,'week_10_pair_20',10,20,8]);

  const legacy=fakeDb({snapshot:{rows:[{revision:1,schema_version:2,code:'x'}]}});
  await mergeAuthorizedCodeDocument(legacy,input);
  assert.equal(legacy.count('project'),0);

  for(const code of ['{',JSON.stringify(null),JSON.stringify([]),JSON.stringify({code:1,board:{}}),
    JSON.stringify({code:'x'}),JSON.stringify({code:'x',board:[]}),JSON.stringify({code:'x',board:'b'}),null]){
    const broken=fakeDb({snapshot:{rows:[{revision:1,schema_version:3,code}]}});
    await assert.rejects(mergeAuthorizedCodeDocument(broken,input),
      error=>error instanceof CodeDocumentDataError&&/workspace projection is invalid/.test(error.message));
    assert.equal(broken.count('commit'),0); assert.equal(broken.count('rollback'),1);
  }
});

test('merge retries busy errors and a failing commit is not rolled back twice',async()=>{
  const row=storedRow();
  const update=updateFrom(row,doc=>doc.getText('code').insert(0,'A'));
  const input={viewerId:1,...IDENTITY,update,clientId:'client_A1',clientSeq:2};
  let attempts=0;
  const db=fakeDb({completion:()=>{ attempts+=1; if(attempts===1) throw busy(); return {rows:[{confirmed_count:0}]}; },
    read:()=>({rows:[attempts>1&&db.count('update')?storedRow('Areturn base;',{revision:4}):row]})});
  const merged=await withMockedTimers(()=>mergeAuthorizedCodeDocument(db,input));
  assert.equal(merged.document.revision,4);

  const idempotentUpdate=updateFrom(row,()=>{});
  const commitFails=fakeDb({},{onCommit:()=>{ throw new Error('commit failed'); }});
  await assert.rejects(mergeAuthorizedCodeDocument(commitFails,{...input,update:idempotentUpdate}),/commit failed/);
  assert.equal(commitFails.count('rollback'),0,'an ambiguous commit is never followed by a rollback');
});

test('execution lookup binds the exact document version and reports terminal, missing and stale states',async()=>{
  const row=storedRow('run();');
  const version=codeDocumentVersion({...IDENTITY,revision:3,stateHash:row.state_hash,codeHash:row.code_hash});
  const request=documentVersion=>({viewerId:1,room:ROOM,questionSlug:IDENTITY.questionSlug,
    questionVersion:1,language:'javascript',documentVersion});
  const fresh=await readCanonicalCodeForExecution(fakeDb({read:{rows:[row]}}),request(version));
  assert.equal(fresh.stale,false); assert.equal(fresh.document.code,'run();');
  const stale=await readCanonicalCodeForExecution(fakeDb({read:{rows:[row]}}),request('b'.repeat(64)));
  assert.equal(stale.stale,true); assert.equal(stale.latestVersion,version);
  for(const read of [{rows:[]},{rows:[{...row,retention_expired:1}]}]){
    assert.deepEqual(await readCanonicalCodeForExecution(fakeDb({read}),request(version)),
      {eligible:true,missing:true,latestVersion:null,pair:{weekId:10,pairGroupId:20,userAId:1,userBId:2,viewerId:1}});
  }
  const terminal=await readCanonicalCodeForExecution(fakeDb({completion:{rows:[{confirmed_count:2}]}}),request(version));
  assert.equal(terminal.terminal,true);
  assert.equal(await readCanonicalCodeForExecution(fakeDb({access:{rows:[]}}),request(version)),null);
  for(const bad of [undefined,'abc','A'.repeat(64)]){
    const db=fakeDb();
    await assert.rejects(readCanonicalCodeForExecution(db,request(bad)),
      error=>error instanceof CodeDocumentInputError&&/document_version/.test(error.message));
    assert.equal(db.count('read'),0); assert.equal(db.count('rollback'),1);
  }
  let attempts=0;
  const retried=fakeDb({read:()=>{ attempts+=1; if(attempts===1) throw busy(); return {rows:[row]}; }});
  assert.equal((await withMockedTimers(()=>readCanonicalCodeForExecution(retried,request(version)))).stale,false);
  const exhausted=fakeDb({read:()=>{ throw busy(); }});
  await assert.rejects(withMockedTimers(()=>readCanonicalCodeForExecution(exhausted,request(version))),/write conflict/);
  assert.equal(exhausted.count('begin:read'),4);
});

test('workspace projection reads expired, missing, denied and pre-v20 documents safely',async()=>{
  const row=storedRow('shown();');
  const request={viewerId:1,room:ROOM,questionSlug:IDENTITY.questionSlug,questionVersion:1,language:'javascript'};
  const live=await readCodeProjectionInTransaction(fakeDb({read:{rows:[row]}}),request);
  assert.equal(live.code,'shown();'); assert.equal(live.expired,undefined);
  const expired=await readCodeProjectionInTransaction(fakeDb({read:{rows:[{...row,retention_expired:1}]}}),request);
  assert.equal(expired.code,''); assert.equal(expired.expired,true); assert.equal(expired.revision,3);
  assert.equal(await readCodeProjectionInTransaction(fakeDb({read:{rows:[]}}),request),null);
  assert.equal(await readCodeProjectionInTransaction(fakeDb({access:{rows:[]}}),request),null);
  const noTable=()=>{ throw new Error('SQLITE_ERROR: no such table: pair_code_documents'); };
  assert.equal(await readCodeProjectionInTransaction(fakeDb({read:noTable}),request),null);
  await assert.rejects(readCodeProjectionInTransaction(fakeDb({read:()=>{ throw new Error('no such table: other'); }}),request),
    /no such table: other/);

  assert.equal(await readCodeProjectionForWorkspace(fakeDb({present:{rows:[]}}),request),null);
  assert.equal(await readCodeProjectionForWorkspace(fakeDb({present:null}),request),null);
  assert.equal(await readCodeProjectionForWorkspace(fakeDb({present:noTable}),request),null);
  await assert.rejects(readCodeProjectionForWorkspace(fakeDb({present:()=>{ throw new Error('network down'); }}),request),
    /network down/);
  const viaTransaction=fakeDb({read:{rows:[row]}});
  assert.equal((await readCodeProjectionForWorkspace(viaTransaction,request)).code,'shown();');
  assert.equal(viaTransaction.count('begin:read'),1); assert.equal(viaTransaction.count('commit'),1);

  let attempts=0;
  const retried=fakeDb({access:()=>{ attempts+=1; if(attempts<2) throw busy(); return {rows:[PAIR_ROW]}; }});
  assert.equal((await withMockedTimers(()=>readCodeProjectionForWorkspace(retried,request))).code,'return base;');
  const exhausted=fakeDb({access:()=>{ throw busy(); }});
  await assert.rejects(withMockedTimers(()=>readCodeProjectionForWorkspace(exhausted,request)),/write conflict/);
  assert.equal(exhausted.count('begin:read'),4);
  const fatal=fakeDb({access:()=>{ throw new Error('fatal'); }});
  await assert.rejects(readCodeProjectionForWorkspace(fatal,request),/fatal/);
  assert.equal(fatal.count('begin:read'),1);
});

test('retention sweep validates its inputs, rows and limit, and rolls back on failure',async()=>{
  await assert.rejects(purgeExpiredCodeDocuments(null),TypeError);
  await assert.rejects(purgeExpiredCodeDocuments({}),/database client is required/);
  for(const limit of [0,-1,1.5,'2']){
    await assert.rejects(purgeExpiredCodeDocuments(fakeDb(),{limit}),/retention limit must be a positive integer/);
  }
  const empty=fakeDb();
  assert.deepEqual(await purgeExpiredCodeDocuments(empty),{purged:0,more:false});
  assert.equal(empty.count('commit'),1);

  const invalidQuery=fakeDb({retention:{rows:'nope'}});
  await assert.rejects(purgeExpiredCodeDocuments(invalidQuery),/retention query is invalid/);
  assert.equal(invalidQuery.count('rollback'),1); assert.equal(invalidQuery.count('commit'),0);

  const good={week_id:10,pair_group_id:20,question_slug:'focus-block-rollup',question_version:1,language:'javascript'};
  for(const overrides of [{week_id:0},{pair_group_id:null},{question_version:'x'},{question_slug:'Bad Slug'},
    {question_slug:null},{language:'ruby'},{language:null}]){
    const db=fakeDb({retention:{rows:[{...good,...overrides}]}});
    await assert.rejects(purgeExpiredCodeDocuments(db),/retention row is invalid/);
    assert.equal(db.count('deleteDocument'),0); assert.equal(db.count('rollback'),1);
  }
  // A rollback failure does not mask the original error.
  const rollbackFails=fakeDb({retention:{rows:[{...good,week_id:0}]}},{onRollback:()=>{ throw new Error('lost'); }});
  await assert.rejects(purgeExpiredCodeDocuments(rollbackFails),/retention row is invalid/);
});

test('retention sweep works on a non-transactional client and scrubs or deletes each projection shape',async()=>{
  const good={week_id:10,pair_group_id:20,question_slug:'focus-block-rollup',question_version:1,language:'javascript'};
  const sweep=async(snapshot,extra={})=>{
    const db=fakeDb({retention:{rows:[good,good]},stale:{rows:[{stale:1}]},snapshot:{rows:snapshot?[snapshot]:[]},...extra},
      {transactions:false});
    const result=await purgeExpiredCodeDocuments(db,{limit:1});
    return {db,result};
  };
  const none=await sweep(null);
  assert.deepEqual(none.result,{purged:1,more:true});
  assert.equal(none.db.count('deleteDocument'),1); assert.equal(none.db.count('deleteSnapshot'),0);
  assert.equal(none.db.count('commit'),0,'a caller-owned client is not committed by the sweep');

  const legacy=await sweep({revision:2,schema_version:2,code:'raw'});
  assert.equal(legacy.db.count('deleteSnapshot'),1);
  assert.deepEqual(legacy.db.log.find(entry=>entry.name==='deleteSnapshot').args,['week_10_pair_20',10,20,2]);

  for(const code of ['{',null,JSON.stringify([]),JSON.stringify({code:'x'}),JSON.stringify({code:'x',board:[]}),
    JSON.stringify({code:'x',board:'b'})]){
    const broken=await sweep({revision:5,schema_version:3,code});
    assert.equal(broken.db.count('deleteSnapshot'),1,String(code)); assert.equal(broken.db.count('project'),0);
  }

  let scrubbed;
  const kept=await sweep({revision:6,schema_version:3,code:JSON.stringify({code:'secret',board:{a:1}})},
    {project:statement=>{ scrubbed=statement.args; return {rowsAffected:1}; }});
  assert.equal(kept.result.purged,1);
  assert.deepEqual(scrubbed,[JSON.stringify({code:'',board:{a:1}}),'week_10_pair_20',10,20,6]);

  await assert.rejects(sweep({revision:6,schema_version:3,code:JSON.stringify({code:'s',board:{}})},{project:{rowsAffected:0}}),
    error=>error instanceof CodeDocumentDataError&&/retention scrub conflicted/.test(error.message));

  // A row that is no longer stale by the time it is visited is skipped.
  const raced=await sweep(null,{stale:{rows:[]}});
  assert.deepEqual(raced.result,{purged:0,more:true}); assert.equal(raced.db.count('deleteDocument'),0);
});

test('a failing transaction close never masks a successful result',async()=>{
  const db=fakeDb({},{closeThrows:true});
  const result=await purgeExpiredCodeDocuments(db);
  assert.deepEqual(result,{purged:0,more:false});
  const read=await getAuthorizedCodeDocument(fakeDb({},{closeThrows:true}),{viewerId:1,...IDENTITY,afterRevision:3});
  assert.equal(read.document.state,null);
});

test('same-document requests are serialized while a failed holder still releases the lock',async()=>{
  const order=[];
  let releaseFirst;
  const gate=new Promise(resolve=>{ releaseFirst=resolve; });
  const slow=fakeDb({access:async()=>{ order.push('first:start'); await gate; order.push('first:end'); throw new Error('first failed'); }});
  const fast=fakeDb({access:()=>{ order.push('second'); return {rows:[PAIR_ROW]}; }});
  const first=getAuthorizedCodeDocument(slow,{viewerId:1,...IDENTITY});
  const second=getAuthorizedCodeDocument(fast,{viewerId:1,...IDENTITY});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,['first:start']);
  releaseFirst();
  await assert.rejects(first,/first failed/);
  assert.equal((await second).document.code,'return base;');
  assert.deepEqual(order,['first:start','first:end','second']);
});
