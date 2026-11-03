import { randomBytes } from 'node:crypto';
import { normalizeMessageTimestamp } from './_messages.js';
import { createEvaluationSuite, listPublicExercises } from './_catalog.js';
import { buildExecutionHarness, executeProgram, executionRuntimeVersion, normalizeRunnerResults, resolveExecutionProvider, ExecutionUnavailableError } from './_execution.js';
import { acquireExecutionLease, releaseExecutionLease, signRunAttestation, verifyRunAttestation } from './data.js';
import { accessStatement, hash, OWNER_COLUMNS, OWNER_SELECT, readSecondaryCompletion, readSecondaryDocument, SecondaryWorkspaceConflictError, SecondaryWorkspaceInputError } from './_secondary-workspace.js';

export function verifySecondaryRun(row){
  let snapshot;try{snapshot=JSON.parse(row.test_cases_snapshot);}catch{return null;}
  if(snapshot?.attestation_version!==4||snapshot.source!=='original-catalog'
    ||Number(snapshot.circle_id)!==Number(row.circle_id)||Number(snapshot.publication_id)!==Number(row.publication_id)
    ||Number(snapshot.group_id)!==Number(row.group_id)||snapshot.code_hash!==hash(row.code)
    ||Number(snapshot.total_count)!==Number(row.total_count))return null;
  const fields={circleId:row.circle_id,publicationId:row.publication_id,groupId:row.group_id,userId:row.user_id,
    questionSlug:row.question_slug,questionVersion:snapshot.version,language:row.language,codeHash:snapshot.code_hash,
    documentRevision:snapshot.document_revision??null,documentStateHash:snapshot.document_state_hash??null,
    documentVersion:snapshot.document_version??null,passedCount:row.passed_count,totalCount:row.total_count,resultsJson:row.results_json};
  if(!normalizeMessageTimestamp(row.created_at))return null;
  if(!verifyRunAttestation(snapshot.attestation,snapshot.attestation_key_id,fields,4))return null;
  return {id:Number(row.id),question_slug:row.question_slug,question_version:Number(snapshot.version),language:row.language,
    passed_count:Number(row.passed_count),total_count:Number(row.total_count),duration_ms:Number(row.duration_ms),created_at:normalizeMessageTimestamp(row.created_at),
    authoritative:true,runner:{id:Number(row.user_id),display_name:String(row.runner_display_name||'Member unavailable').slice(0,80)}};
}

export async function executeSecondaryProgram(db,room,req,key){
  const body=req.body||{},viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
  if(['week_id','pair_group_id','pg_id','pair_id','circle_id','publication_id','group_id'].some(field=>Object.hasOwn(body,field)))
    throw new SecondaryWorkspaceInputError('room_id cannot be combined with numeric room identifiers');
  const language=({js:'javascript',javascript:'javascript',py:'python',python:'python'})[String(body.language??body.lang??'javascript').toLowerCase()];
  if(!language)throw new SecondaryWorkspaceInputError('supported languages are javascript and python');
  const slug=String(body.question_slug??body.slug??'').trim().slice(0,120);if(!slug)throw new SecondaryWorkspaceInputError('question_slug required');
  const questionVersion=Number(body.question_version??body.version??listPublicExercises().find(exercise=>exercise.slug===slug)?.version);
  if(!Number.isSafeInteger(questionVersion)||questionVersion<1)throw new SecondaryWorkspaceInputError('question_version must be a positive integer');
  const suite=createEvaluationSuite(slug,questionVersion,language);if(!suite)throw new SecondaryWorkspaceInputError('question not found or unavailable',404);
  const tx=await db.transaction('read');let canonical=null,code=String(body.code||'');
  try{
    const current=await readSecondaryCompletion(tx,room,key);if(!current){await tx.rollback();return null;}
    if(current.completion.state==='completed')throw new SecondaryWorkspaceConflictError('session_completed','session is completed',null);
    if(!Number(current.group.is_solo)){
      if(typeof body.document_version!=='string'||!/^[a-f0-9]{64}$/.test(body.document_version))throw new SecondaryWorkspaceInputError('valid document_version required');
      const result=await readSecondaryDocument(tx,room,{questionSlug:slug,questionVersion,language},{create:false});
      if(!result?.document||result.document.version!==body.document_version)throw new SecondaryWorkspaceConflictError('code_document_changed','code document changed',{latest_document_version:result?.document?.version??null});
      canonical=result.document;code=canonical.code;
    }
    await tx.commit();
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
  if(!code)throw new SecondaryWorkspaceInputError('code required');if(Buffer.byteLength(code)>20000)throw new SecondaryWorkspaceInputError('code exceeds the 20000-byte limit',413);
  const provider=resolveExecutionProvider();if(!provider.configured)throw new ExecutionUnavailableError('code execution is temporarily unavailable');
  let leaseId=null;
  try{
    leaseId=await acquireExecutionLease(db,viewer,req,{question_slug:slug,question_version:questionVersion,language});
    if(!leaseId)throw new SecondaryWorkspaceInputError('an execution is already in progress',429);
    const rate=await db.batch([{
      sql:`INSERT INTO app_logs(level,source,event,message,user_id,created_at) VALUES('info','runner','execute_attempt','execution requested',?,datetime('now'))`,args:[viewer],
    },{sql:`SELECT COUNT(*) AS count FROM app_logs WHERE user_id=? AND source='runner' AND event='execute_attempt' AND datetime(created_at)>=datetime('now','-1 minute')`,args:[viewer]}],'write');
    if(Number(rate[1].rows[0].count)>10)throw new SecondaryWorkspaceInputError('execution rate limit exceeded',429);
    const prefix=`__RANDORI_RESULT_${randomBytes(16).toString('hex')}__:`,started=Date.now();
    const run=await executeProgram({language,source:buildExecutionHarness(language,code,suite,prefix)});
    const results=normalizeRunnerResults(run.stdout,prefix,suite.tests),passed=results.filter(result=>result.pass===true).length,total=suite.tests.length,duration=Date.now()-started;
    const fields={circleId:room.circleId,publicationId:room.publicationId,groupId:room.groupId,userId:viewer,
      questionSlug:slug,questionVersion,language,codeHash:hash(code),documentRevision:canonical?.revision??null,
      documentStateHash:canonical?.stateHash??null,documentVersion:canonical?.version??null,
      passedCount:passed,totalCount:total,resultsJson:JSON.stringify(results)};
    const attestation=signRunAttestation(fields);
    const snapshot=JSON.stringify({source:'original-catalog',version:questionVersion,total_count:total,attestation_version:4,
      attestation_key_id:attestation.keyId,attestation:attestation.signature,circle_id:room.circleId,publication_id:room.publicationId,group_id:room.groupId,
      code_hash:fields.codeHash,document_revision:fields.documentRevision,document_state_hash:fields.documentStateHash,document_version:fields.documentVersion});
    const write=await db.transaction('write');let inserted;
    try{
      // Provider execution grants no persistence authority: repeat the live
      // context and document/receipt checks in the final write transaction.
      const latest=await readSecondaryCompletion(write,room,key);if(!latest)throw new Error('execution pair unavailable');
      if(latest.completion.state==='completed')throw new SecondaryWorkspaceConflictError('session_completed','session is completed',null);
      if(canonical){
        const latestDoc=await readSecondaryDocument(write,room,{questionSlug:slug,questionVersion,language},{create:false});
        if(latestDoc?.document?.version!==canonical.version)throw new SecondaryWorkspaceConflictError('code_document_changed','code document changed',{latest_document_version:latestDoc?.document?.version??null});
      }
      inserted=await write.execute(accessStatement(write,room,`INSERT INTO circle_session_runs
        (${OWNER_COLUMNS},user_id,publication_id,group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
        SELECT ${OWNER_SELECT},?,publication_id,group_id,NULL,?,?,?,?,?,?,?,?,datetime('now') FROM access RETURNING id`,
        [viewer,slug,language,code,snapshot,fields.resultsJson,passed,total,duration]));
      if(inserted.rows.length!==1)throw new Error('run write unavailable');await write.commit();
    }catch(error){try{await write.rollback();}catch{}throw error;}finally{await write.close?.();}
    const runtime=executionRuntimeVersion(provider.provider,language);
    return {question_slug:slug,question_version:questionVersion,language,version:runtime,runtime_version:runtime,
      execution:{provider:run.provider,code:Number.isInteger(run.code)?run.code:null,signal:typeof run.signal==='string'?run.signal.slice(0,64):null,timed_out:run.timedOut===true,has_stderr:!!run.stderr},
      results,passed_count:passed,total_count:total,run_id:inserted.rows[0].id};
  }finally{await releaseExecutionLease(db,viewer,leaseId,req);}
}
