import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { database, seedPair } from '../support/interviewer-toolkit.mjs';
import { evaluationInsights, evaluationSchemaInstalled, EVALUATION_RETENTION_SECONDS, EvaluationInputError,
  interviewerToolkitEnabled, parseEvaluationMutation, projectEvaluation, purgeExpiredEvaluations, readEvaluationReport, readOwnedEvaluations,
  RUBRIC_DIMENSIONS, saveEvaluation } from '../../api/_interviewer-toolkit.js';
import { buildDataExport } from '../../api/_data-export.js';
import { deleteAccount, reapplyAccountDeletion, DELETED_ACCOUNT_PASSWORD_HASH } from '../../api/_account-deletion.js';
import { readMemberProgress } from '../../api/_progress.js';

let item,currentDb;const key='toolkit-test-version-key-at-least-thirty-two-characters',room='week_10_pair_20';
process.env.JWT_SECRET=key;
const logged=[];
const auth=req=>Number(req.headers?.['x-test-user'])?{id:Number(req.headers['x-test-user']),email:'member@example.test'}:null;
mock.module('../../api/_db.js',{exports:{
  captureSentryException:e=>logged.push(e),captureSentryMessage:e=>logged.push(e),getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>key,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:req=>req.headers?.origin!=='https://evil.test',verifyRequestAuth:auth,verifySignedRequestAuth:auth,
  deterministicColor:()=>'',issueSession:()=>{},issueSessionInTransaction:()=>{},revokeAccountSessions:()=>{},revokeRequestSession:()=>{},
}});
const {default:data}=await import('../../api/data.js');
const {default:authentication}=await import('../../api/auth.js');
const request=(handler,{user=2,method='GET',endpoint='interviewer-toolkit',query={},body={},origin}={})=>{
  let status=200;const headers={};let payload;
  const response={status(n){status=n;return this;},setHeader(name,value){headers[name.toLowerCase()]=value;},json(value){payload=value;return this;},end(value){payload=value;return this;}};
  return Promise.resolve(handler({method,url:'/api/'+endpoint,query:{endpoint,...query},body,headers:{'x-test-user':String(user),...(origin?{origin}:{})},socket:{remoteAddress:'127.0.0.1'}},response)).then(()=>({status,headers,body:payload}));
};
const body=(revision=0,extra={})=>({room_id:room,revision,rubric:{problem_solving:3,communication:4,code_quality:2,testing:null},notes:'PRIVATE evaluation <script>alert(1)</script>',decision:'hire',...extra});
const save=(user=2,revision=0,extra={})=>request(data,{user,method:'POST',body:body(revision,extra)});
const report=(user=2,value=room)=>request(data,{user,query:{room_id:value}});
const command=async(user,action,extra={})=>{
  const state=await request(data,{user,endpoint:'session-controls',query:{room_id:room}});
  return request(data,{user,method:'POST',endpoint:'session-controls',body:{room_id:room,action,base_version:state.body.session_controls.version,...extra}});
};
beforeEach(async()=>{process.env.INTERVIEWER_TOOLKIT_ENABLED='true';process.env.INTERVIEW_SESSION_ENABLED='true';item=await database();currentDb=item.db;await seedPair(currentDb);logged.length=0;});
afterEach(()=>{for(const name of ['INTERVIEWER_TOOLKIT_ENABLED','INTERVIEW_SESSION_ENABLED','INTERVIEW_EVALUATION_PURGE_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','PROGRESS_DASHBOARD_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'])delete process.env[name];item?.close();currentDb=null;});

test('strict full replacement parser validates scores, bounds, revision, room and enum without author fields',()=>{
  assert.equal(parseEvaluationMutation(body()).rubric.problem_solving,3);
  for(const value of [null,[],{},body(-1),body(1.5),body(0,{room_id:'secondary_10_pair_20'}),body(0,{notes:'a'.repeat(4001)}),body(0,{notes:'\0'}),body(0,{notes:7}),body(0,{decision:'yes'}),body(0,{evaluator_user_id:2}),body(0,{rubric:{}}),body(0,{rubric:{...body().rubric,testing:0}}),body(0,{rubric:{...body().rubric,testing:2.5}})]) assert.throws(()=>parseEvaluationMutation(value),EvaluationInputError);
  assert.equal(parseEvaluationMutation(body(0,{notes:'😀'.repeat(4000)})).notes.length,8000);
  assert.equal(projectEvaluation(null).revision,0);
  assert.equal(interviewerToolkitEnabled({INTERVIEWER_TOOLKIT_ENABLED:'TRUE',INTERVIEW_SESSION_ENABLED:'true'}),false);
});
test('only interviewer creates; candidate, outsiders and absent rooms uniformly 404; origin and forged author rejected',async()=>{
  const absent=await report(9);
  const unscored=await request(data,{endpoint:'history'});
  assert.equal(unscored.body.history[0].interviewer_toolkit,true,'a past interviewer may score from History without an existing evaluation');
  for(const user of [1,9]){
    assert.deepEqual((await report(user)).body,absent.body);
    for(const revision of [0,1,99]){const denied=await save(user,revision);assert.equal(denied.status,404);assert.deepEqual(denied.body,absent.body);}
  }
  assert.equal((await report(2,'week_10_pair_999')).status,404);
  assert.equal((await save(1,0,{viewer_role:'interviewer'})).status,400);
  assert.equal((await request(data,{method:'POST',body:body(),origin:'https://evil.test'})).status,403);
  assert.equal((await report(0)).status,401);
  assert.equal((await request(data,{method:'PATCH'})).status,405);
  assert.equal((await request(data,{query:{room_id:[room,room]}})).status,400);
  assert.equal((await request(data,{query:{user_id:2}})).status,400);
  assert.equal((await report()).headers['cache-control'],'private, no-store');
  assert.deepEqual(logged,[]);
});
test('CAS preserves unsent writing; after end owner can score, note and decide',async()=>{
  const created=await save();assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal(created.body.evaluation.revision,1);
  const stale=await save(2,0,{notes:'lost update'});assert.equal(stale.status,409);assert.equal(stale.body.code,'evaluation_changed');
  assert.equal((await report()).body.report.evaluation.notes,body().notes);
  assert.equal((await command(2,'end')).status,200);
  const after=await save(2,1,{notes:'after end',decision:'strong_hire'});assert.equal(after.status,200);
  const summary=(await report()).body.report;
  assert.equal(summary.phase,'ended');assert.equal(summary.evaluation.revision,2);assert.equal(summary.evaluation.notes,'after end');
  assert.ok(summary.timeline.some(event=>event.phase==='ended'));
});
test('role swap never transfers writing: former interviewer edits only own, new interviewer has a separate empty evaluation',async()=>{
  await save();
  await currentDb.execute({sql:`INSERT INTO pair_room_snapshots(room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by) VALUES(?,10,20,1,3,'handoff',1,'javascript','focus-block-rollup@1',?,2)`,args:[room,JSON.stringify({code:'PREPARED SECRET',board:{shapes:[]}})]});
  assert.equal((await command(2,'set_candidate',{candidate_user_id:2})).status,200);
  const former=(await report(2)).body.report;
  assert.equal(former.evaluation.notes,body().notes);
  assert.equal(former.timeline.some(event=>event.kind==='checkpoint'||event.kind==='run'),false,'evaluation ownership cannot bypass the current candidate lobby read gate');
  assert.equal((await report(1)).body.report.evaluation.notes,'');
  assert.equal((await save(1,0,{notes:'separate evaluation'})).status,200);
  assert.equal((await report(2)).body.report.evaluation.notes,body().notes);
  assert.equal((await save(2,1,{notes:'own after swap'})).status,200);
  assert.equal((await report(1)).body.report.evaluation.notes,'separate evaluation');
  assert.equal((await readOwnedEvaluations(currentDb,2)).evaluations.length,1);
});
test('flag off and v26 without v27 preserve legacy routes and advertise no toolkit, without request DDL',async()=>{
  for(const name of ['INTERVIEWER_TOOLKIT_ENABLED','INTERVIEW_SESSION_ENABLED']){
    process.env[name]='false';assert.equal((await report()).status,404);
    assert.equal((await request(authentication,{endpoint:'capabilities'})).body.capabilities.interviewerToolkit,undefined);process.env[name]='true';
  }
  const cap=await request(authentication,{endpoint:'capabilities'});assert.equal(cap.body.capabilities.interviewerToolkit,true);
  item.close();item=await database(26);currentDb=item.db;await seedPair(currentDb);
  assert.equal((await report()).status,404);assert.equal((await save()).status,404);
  assert.equal((await request(authentication,{endpoint:'capabilities'})).body.capabilities.interviewerToolkit,undefined);
  const controls=await request(data,{endpoint:'session-controls',query:{room_id:room}});
  assert.equal(controls.status,200);assert.equal(controls.body.session_controls.phase,'lobby');assert.equal(controls.body.session_controls.interviewer_toolkit,undefined);
  assert.equal(await evaluationSchemaInstalled(currentDb),false);
  assert.equal((await currentDb.execute("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='interview_evaluations'")).rows[0].n,0);
});
test('storage statement reauthorizes creation when a role swap races the preflight',async()=>{
  const raw=currentDb;let raced=false;
  currentDb={execute:raw.execute.bind(raw),transaction:async mode=>{
    const tx=await raw.transaction(mode),execute=tx.execute.bind(tx);
    tx.execute=async statement=>{
      if(!raced&&/INSERT INTO interview_evaluations/.test(statement.sql||'')){
        raced=true;
        await execute(`INSERT INTO pair_session_controls(week_id,pair_group_id,pair_user_a_id,pair_user_b_id,candidate_user_id,timer_state,remaining_ms,revision,updated_by,created_at,updated_at)
          VALUES(10,20,1,2,2,'paused',1500000,1,2,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
      }
      return execute(statement);
    };return tx;
  }};
  const result=await save();assert.equal(result.status,409);assert.equal(raced,true);
  assert.equal((await raw.execute('SELECT COUNT(*) AS n FROM interview_evaluations')).rows[0].n,0);
  assert.equal((await raw.execute('SELECT COUNT(*) AS n FROM pair_session_controls')).rows[0].n,0,'whole transaction rolled back');
});
test('private report projects only shared checkpoint code and verified v3 run code; excludes private stdin and v2 code',async()=>{
  await currentDb.execute({sql:`INSERT INTO pair_room_snapshots(room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by) VALUES(?,10,20,2,3,'client',2,'javascript','focus-block-rollup@1',?,2)`,args:[room,JSON.stringify({code:'SHARED checkpoint',board:{shapes:[]},stdin:'PRIVATE stdin'})]});
  const summary=(await report()).body.report;
  const checkpoint=summary.timeline.find(event=>event.kind==='checkpoint');assert.equal(checkpoint.code,'SHARED checkpoint');
  assert.equal(checkpoint.question_slug,'focus-block-rollup');assert.ok(!JSON.stringify(summary).includes('PRIVATE stdin'));
  await currentDb.execute({sql:`INSERT INTO session_runs(user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms) VALUES(1,10,20,'focus-block-rollup','javascript','LEGACY PRIVATE CODE',?,'[]',1,1,10)`,args:[JSON.stringify({source:'original-catalog',version:1,total_count:1,attestation_version:2,attestation:'test',attestation_key_id:'test',stdin:'DO NOT PROJECT'})]});
  const raw=await readEvaluationReport(currentDb,{viewerId:2,room:parseEvaluationMutation(body()),versionKey:key,verifyAttestation:()=>true});
  assert.equal(raw.timeline.filter(event=>event.kind==='run').length,1);assert.equal(raw.timeline.find(event=>event.kind==='run').code,undefined);
  assert.ok(!JSON.stringify(raw).includes('LEGACY PRIVATE CODE'));assert.ok(!JSON.stringify(raw).includes('DO NOT PROJECT'));
});
test('evaluations never enter candidate recap, feeds, chat, history, progress, data export or AI storage',async()=>{
  await save();const created=await request(data,{endpoint:'history'});
  assert.equal(created.body.history[0].interviewer_toolkit,true);
  process.env.PROGRESS_DASHBOARD_ENABLED='true';
  for(const endpoint of ['pair-recap','messages','runs','history','progress','session-controls']){
    const query=['pair-recap','messages','session-controls'].includes(endpoint)?{room_id:room}:{};
    const view=await request(data,{user:1,endpoint,query});
    assert.ok(!JSON.stringify(view.body).includes('PRIVATE evaluation'),endpoint);
    assert.ok(!JSON.stringify(view.body).includes('strong_hire'),endpoint);
    if(endpoint==='progress')assert.equal(view.body.interviews,undefined);
  }
  const ownProgress=await readMemberProgress(currentDb,{userId:2,versionKey:key,verifyAttestation:()=>false});
  assert.equal(ownProgress.interviews.decisions.hire,1);assert.ok(!JSON.stringify(ownProgress.interviews).includes('notes'));
  const exported=await buildDataExport(currentDb,{userId:2,hashInvitationEmail:()=>null});
  assert.equal(exported.interview_evaluations[0].notes,body().notes);assert.equal(exported.interview_evaluations[0].candidate,'One');
  const candidate=await buildDataExport(currentDb,{userId:1,hashInvitationEmail:()=>null});
  assert.deepEqual(candidate.interview_evaluations,[]);
  assert.equal((await currentDb.execute('SELECT COUNT(*) AS n FROM ai_sessions')).rows[0].n,0);
});
test('retention uses fixed first-write lifetime; exact cutoff remains, expired rows disappear from all views and a purge is bounded/default OFF',async()=>{
  await save();const saved=(await currentDb.execute('SELECT * FROM interview_evaluations')).rows[0];
  assert.equal(Number(saved.expires_at)-Number(saved.created_at),EVALUATION_RETENTION_SECONDS);
  await save(2,1);assert.equal((await currentDb.execute('SELECT expires_at FROM interview_evaluations')).rows[0].expires_at,saved.expires_at);
  assert.deepEqual(await purgeExpiredEvaluations(currentDb),{deleted:0,disabled:true});
  await assert.rejects(()=>purgeExpiredEvaluations(currentDb,{limit:101}),TypeError);
  // Seed expired rows through the immutable insert contract, never mutate lifetime.
  await currentDb.execute('DELETE FROM interview_evaluations');
  await currentDb.execute(`INSERT INTO interview_evaluations(week_id,pair_group_id,evaluator_user_id,candidate_user_id,notes,decision,revision,created_at,updated_at,expires_at)
    VALUES(10,20,2,1,'expired','no_hire',1,CAST(strftime('%s','now') AS INTEGER)-7776001,CAST(strftime('%s','now') AS INTEGER)-7776001,CAST(strftime('%s','now') AS INTEGER)-1)`);
  assert.equal((await report()).status,404);assert.equal((await save(2,1)).status,404);
  assert.deepEqual((await readOwnedEvaluations(currentDb,2)).evaluations,[]);
  process.env.INTERVIEW_EVALUATION_PURGE_ENABLED='true';assert.equal((await purgeExpiredEvaluations(currentDb,{enabled:true,limit:1})).deleted,1);
  await currentDb.execute("UPDATE pairing_groups SET created_at=datetime('now','-91 days')");
  assert.equal((await save()).status,404,'purge cannot resurrect an old interview');
  assert.equal(evaluationInsights([],true).truncated,true);
});
test('exact 90-day boundary stays visible and purge-eligible only after the database second advances',async()=>{
  const now=Number((await currentDb.execute("SELECT CAST(strftime('%s','now') AS INTEGER) AS seconds")).rows[0].seconds);
  await currentDb.execute({sql:`INSERT INTO interview_evaluations(week_id,pair_group_id,evaluator_user_id,candidate_user_id,notes,decision,revision,created_at,updated_at,expires_at) VALUES(10,20,2,1,'boundary','hire',1,?,?,?)`,args:[now-EVALUATION_RETENTION_SECONDS,now-EVALUATION_RETENTION_SECONDS,now]});
  let databaseSecond=now;
  const raw=currentDb;
  const wrap=target=>({execute:statement=>target.execute(typeof statement==='string'?statement.replaceAll("CAST(strftime('%s','now') AS INTEGER)",String(databaseSecond)):{...statement,sql:statement.sql.replaceAll("CAST(strftime('%s','now') AS INTEGER)",String(databaseSecond))}),
    commit:target.commit?.bind(target),rollback:target.rollback?.bind(target),close:target.close?.bind(target)});
  const clocked={...wrap(raw),transaction:async mode=>wrap(await raw.transaction(mode))};
  assert.equal((await readOwnedEvaluations(clocked,2)).evaluations.length,1);
  process.env.INTERVIEW_EVALUATION_PURGE_ENABLED='true';
  assert.equal((await purgeExpiredEvaluations(clocked,{enabled:true})).deleted,0);
  databaseSecond+=1;
  assert.deepEqual((await readOwnedEvaluations(clocked,2)).evaluations,[]);
  assert.equal((await purgeExpiredEvaluations(clocked,{enabled:true})).deleted,1);
});

test('schema failures fail closed and never log sensitive content; lifecycle ignores flag rollback',async()=>{
  await save();const raw=currentDb;
  currentDb={execute:async statement=>{if(String(statement.sql||statement).includes('schema_migrations'))return raw.execute(statement);throw new Error('PRIVATE evaluation raw SQL failure');}};
  assert.equal((await report()).status,503);assert.deepEqual(logged,[]);
  await assert.rejects(()=>evaluationSchemaInstalled(currentDb),/PRIVATE/);
  currentDb=raw;
  // Restore reapplication invokes the exact production deletion statements.
  process.env.INTERVIEWER_TOOLKIT_ENABLED='false';
  const entry=id=>({account_id:id,created_at:'2026-01-01T00:00:00.000Z',deleted_at:'2026-11-17T00:00:00.000Z'});
  const candidate=await reapplyAccountDeletion(currentDb,{entry:entry(1),restorePoint:'2026-11-16T00:00:00.000Z',hashInvitationEmail:()=>null});
  assert.equal(candidate.ok,true);assert.equal((await currentDb.execute('SELECT COUNT(*) AS n FROM interview_evaluations')).rows[0].n,1);
  process.env.INTERVIEWER_TOOLKIT_ENABLED='true';assert.equal((await report()).body.report.candidate,'Deleted member');
  process.env.INTERVIEWER_TOOLKIT_ENABLED='false';
  const evaluator=await reapplyAccountDeletion(currentDb,{entry:entry(2),restorePoint:'2026-11-16T00:00:00.000Z',hashInvitationEmail:()=>null});
  assert.equal(evaluator.summary.interview_evaluations_deleted,1);assert.equal((await currentDb.execute('SELECT COUNT(*) AS n FROM interview_evaluations')).rows[0].n,0);
});
