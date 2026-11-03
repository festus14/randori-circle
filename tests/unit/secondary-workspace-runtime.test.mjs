import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,chmodSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';
import * as Y from 'yjs';
import {copyMigratedDatabase} from '../support/migrated-db.mjs';
import {enableWorkspace,seedSecondaryCircle} from '../support/secondary-workspace-fixture.mjs';
import {resolveLocalServerConfig,startLocalDevelopmentServer,LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD} from '../../scripts/local-server.mjs';
import {prepareMigrationConnection} from '../../db/migration-runner.js';
import {verifySecondaryRun} from '../../api/_secondary-execution.js';

const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const ABSENT='circle_999_publication_999_group_999';
const IDENTITY={question_slug:'focus-block-rollup',question_version:1,language:'javascript'};
const SOLUTION='function rollUpFocusBlocks(blocks) { const result=[]; for(const block of blocks){ const prev=result.at(-1); if(prev&&prev.label===block.label)prev.minutes+=block.minutes;else result.push({...block}); } return result; }';
async function runtime(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'438-runtime-')));mkdirSync(join(dir,'.local'),{mode:0o700});copyFileSync(join(ROOT,'index.html'),join(dir,'index.html'));
 const path=join(dir,'.local','randori.sqlite');await copyMigratedDatabase(path);chmodSync(path,0o600);
 const config=resolveLocalServerConfig({rootDir:dir,argv:[],env:{NODE_ENV:'development',RANDORI_LOCAL_HOST:'127.0.0.1',RANDORI_LOCAL_PORT:'0',RANDORI_LOCAL_DATABASE_URL:pathToFileURL(path).href}});
 const server=await startLocalDevelopmentServer({config,logger:{log(){},error(){}}});
 const db=createClient({url:pathToFileURL(path).href});await prepareMigrationConnection(db);
 const nativeFetch=globalThis.fetch;
 async function request(cookie,path,method='GET',body,version){
  const response=await nativeFetch(server.url+path,{method,headers:{cookie,origin:server.url,...(version===undefined?{}:{'X-Randori-Circle-Context-Version':String(version)}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();return {status:response.status,body:JSON.parse(text),text,response};
 }
 async function login(email,password){const r=await request('','/api/auth/login','POST',{email,password});assert.equal(r.status,200,r.text);return {cookie:r.response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),id:r.body.user.id};}
 const owner=await login(LOCAL_OWNER_EMAIL,LOCAL_OWNER_PASSWORD);
 for(const id of [2,3])await db.execute({sql:"INSERT INTO auth_accounts(id,email,password_hash,display_name,color,is_available) VALUES(?,?,?,?,?,0)",args:[id,`runtime-${id}@example.test`,await bcrypt.hash('runtime-pass',4),`Partner ${id}`,'#123456']});
 const restore=enableWorkspace();
 const a=await seedSecondaryCircle(db,{circleId:20,users:[owner.id,2],name:'Dojo A'});
 const b=await seedSecondaryCircle(db,{circleId:30,users:[owner.id,3],name:'Dojo B',publicId:'67e37755-88c5-4a29-ae64-a7cc5a3e9dc7'});
 const u2=await login('runtime-2@example.test','runtime-pass'),u3=await login('runtime-3@example.test','runtime-pass');
 async function select(user,circle){const current=await request(user.cookie,'/api/circles');const r=await request(user.cookie,'/api/circles','PUT',{circle_public_id:circle.publicId,expected_context_version:current.body.context_version});assert.equal(r.status,200,r.text);user.version=r.body.context_version;}
 return {db,server,a,b,owner,u2,u3,request,select,async close(){restore();db.close();await server.close();rmSync(dir,{recursive:true,force:true});}};
}
function path(surface,room){return `/api/${surface}?room_id=${room}${surface==='code-document'?'&question_slug=focus-block-rollup&question_version=1&language=javascript':''}`;}
const READS=['messages','runs','pair-recap','session-completion','session-controls','meeting-link','code-document','video'];
const WRITES=['messages','execute','session-completion','session-controls','meeting-link','code-document','video'];

test('HTTP runtime rejects reads, writes and existence leaks between two secondary circles and for non-members',async()=>{
 const f=await runtime();try{
  for(const [circle,foreign] of [[f.a,f.b],[f.b,f.a]]){
   await f.select(f.owner,circle);
   const invoke=(p,m='GET',body)=>f.request(f.owner.cookie,p,m,body,f.owner.version);
   await invoke('/api/messages','POST',{room_id:circle.room,message:`chat ${circle.name}`});
   for(const surface of READS){const denied=await invoke(path(surface,foreign.room)),absent=await invoke(path(surface,ABSENT));assert.deepEqual([denied.status,denied.text],[404,absent.text],surface);assert.deepEqual(denied.body,{error:'pair not found'});}
   const before=(await f.db.execute('SELECT COUNT(*) AS n FROM circle_pair_messages')).rows[0].n;
   for(const surface of WRITES){const denied=await invoke(`/api/${surface}`,'POST',{room_id:foreign.room,message:'rejected'});assert.deepEqual([denied.status,denied.body],[404,{error:'pair not found'}],surface);}
   assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM circle_pair_messages')).rows[0].n,before);
   const history=await invoke('/api/history');assert.equal(history.body.total,1);assert.deepEqual(history.body.history.map(row=>row.room_id),[circle.room]);assert.equal(history.body.history[0].circle.name,circle.name);
  }
  for(const [user,circle,foreign] of [[f.u2,f.a,f.b],[f.u3,f.b,f.a]]){
   await f.select(user,circle);
   for(const surface of READS){const denied=await f.request(user.cookie,path(surface,foreign.room),'GET',undefined,user.version),absent=await f.request(user.cookie,path(surface,ABSENT),'GET',undefined,user.version);assert.deepEqual([denied.status,denied.text],[404,absent.text],surface);}
  }
  const stale=await f.request(f.owner.cookie,'/api/messages','POST',{room_id:f.b.room,message:'stale'},f.owner.version-1);assert.equal(stale.status,409);assert.equal(stale.body.code,'circle_context_changed');
  const missing=await f.request(f.owner.cookie,path('messages',f.b.room));assert.equal(missing.body.code,'circle_context_changed');
  await f.db.execute({sql:"UPDATE circle_memberships SET status='inactive' WHERE circle_id=30 AND user_id=?",args:[f.owner.id]});
  const removed=await f.request(f.owner.cookie,'/api/messages','POST',{room_id:f.b.room,message:'removed'},f.owner.version);assert.equal(removed.status,409);
  assert.equal((await f.db.execute("SELECT COUNT(*) AS n FROM circle_pair_messages WHERE message IN ('stale','removed')")).rows[0].n,0);
 }finally{await f.close();}
});

test('HTTP runtime executes acknowledged documents, rejects tampered evidence, isolates quorum and terminal writes',async()=>{
 const f=await runtime(),nativeFetch=globalThis.fetch;try{
  await f.select(f.owner,f.a);await f.select(f.u2,f.a);
  const invoke=(surface,method='GET',body)=>f.request(f.owner.cookie,method==='GET'?path(surface,f.a.room):`/api/${surface}`,method,body,f.owner.version);
  const initial=await invoke('code-document');assert.equal(initial.status,200,initial.text);
  const doc=new Y.Doc();Y.applyUpdate(doc,Buffer.from(initial.body.state,'base64'));doc.getText('code').insert(0,SOLUTION);const update=Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');doc.destroy();
  const merged=await invoke('code-document','POST',{room_id:f.a.room,...IDENTITY,client_id:'runtime_client_438',client_seq:1,update});assert.equal(merged.status,200,merged.text);
  const wrong=await invoke('execute','POST',{room_id:f.a.room,...IDENTITY,document_version:'a'.repeat(64)});assert.equal(wrong.body.code,'code_document_changed');
  process.env.EXECUTION_PROVIDER='piston';process.env.EXECUTION_API_URL='https://execution-438.invalid/api/v2/execute';
  globalThis.fetch=async(input,init)=>{
   const url=String(input);if(url===process.env.EXECUTION_API_URL){const body=JSON.parse(init.body);const result=spawnSync(process.execPath,['--input-type=commonjs'],{input:body.files[0].content,encoding:'utf8',timeout:20000,maxBuffer:4*1024*1024});return new Response(JSON.stringify({language:'javascript',version:'18.15.0',run:{stdout:result.stdout,stderr:result.stderr,code:result.status,signal:result.signal}}),{status:200});}
   assert.equal(new URL(url).origin,f.server.url);return nativeFetch(input,init);
  };
  const execution=await invoke('execute','POST',{room_id:f.a.room,...IDENTITY,document_version:merged.body.document_version,code:'untrusted client input'});assert.equal(execution.status,200,execution.text);assert.equal(execution.body.passed_count,execution.body.total_count);
  const runs=await invoke('runs');assert.equal(runs.body.runs.length,1);
  const row=(await f.db.execute('SELECT * FROM circle_session_runs')).rows[0];assert.equal(row.code,SOLUTION);assert.ok(verifySecondaryRun(row));assert.equal(verifySecondaryRun({...row,circle_id:30}),null);assert.equal(verifySecondaryRun({...row,code:'forged'}),null);
  const state=await invoke('session-completion');const first=await invoke('session-completion','POST',{room_id:f.a.room,action:'confirm',base_version:state.body.completion.version});assert.equal(first.body.completion.confirmed_count,1);
  const other=await f.request(f.u2.cookie,path('session-completion',f.a.room),'GET',undefined,f.u2.version);
  const done=await f.request(f.u2.cookie,'/api/session-completion','POST',{room_id:f.a.room,action:'confirm',base_version:other.body.completion.version},f.u2.version);assert.equal(done.body.completion.state,'completed');
  const terminal=await invoke('session-completion','POST',{room_id:f.a.room,action:'withdraw',base_version:done.body.completion.version});assert.equal(terminal.body.code,'session_completion_terminal');
  const controls=await invoke('session-controls');assert.equal(controls.body.session_controls.terminal,true);
  const terminalDoc=await invoke('code-document','POST',{room_id:f.a.room,...IDENTITY,client_id:'runtime_client_438',client_seq:2,update});assert.equal(terminalDoc.body.code,'session_completed');
  await f.select(f.owner,f.b);const independent=await f.request(f.owner.cookie,path('session-completion',f.b.room),'GET',undefined,f.owner.version);assert.equal(independent.body.completion.confirmed_count,0);assert.notEqual(independent.body.completion.version,done.body.completion.version);
 }finally{globalThis.fetch=nativeFetch;await f.close();}
});


test('account deletion redacts secondary chat and preserves the partner publication and retention ownership',async()=>{
 const f=await runtime();try{
  await f.select(f.u2,f.a);
  const message=await f.request(f.u2.cookie,'/api/messages','POST',{room_id:f.a.room,message:'personal content'},f.u2.version);assert.equal(message.status,201,message.text);
  const {verifyRequestAuth}=await import('../../api/_db.js');
  const {recordRecentAuth}=await import('../../api/_recent-auth.js');
  const {deleteAccount}=await import('../../api/_account-deletion.js');
  const payload=await verifyRequestAuth({headers:{cookie:f.u2.cookie}},f.db);
  await recordRecentAuth(f.db,{sessionHash:payload.sessionHash,userId:f.u2.id,method:'password'});
  const result=await deleteAccount(f.db,{userId:f.u2.id,sessionHash:payload.sessionHash,hashInvitationEmail:()=>null});
  assert.equal(result.status,'deleted');
  assert.equal((await f.db.execute('SELECT message FROM circle_pair_messages')).rows[0].message,'Message deleted');
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM circle_chat_retention_scopes')).rows[0].n,1);
  assert.equal((await f.db.execute('SELECT COUNT(*) AS n FROM circle_pairing_groups')).rows[0].n,2);
 }finally{await f.close();}
});
