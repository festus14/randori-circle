import { createHash, createHmac, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { getPublicExercise } from './_catalog.js';
import { materializeCodeDocument, CodeDocumentInputError, CODE_DOCUMENT_UPDATE_LIMIT_BYTES } from './_code-document.js';
import { projectSessionControls, SESSION_TIMER_DURATION_MS } from './_session-controls.js';
import { normalizeMeetingUrl } from './_meeting-link.js';
import { secondaryScheduleIdentity } from './_secondary-schedule.js';
import { parseWorkspacePayload, snapshotFromRow, storedWorkspaceCode } from './video.js';
import { projectMessage, MAX_MESSAGES_PER_ROOM, MAX_MESSAGES_PER_USER_PER_MINUTE, MESSAGE_RATE_RETRY_SECONDS } from './_messages.js';
import { secondaryPairAccessSql, secondaryPairAccessArgs, parseSecondaryRoomPath, secondaryRoomId, scopedWorkspaceClient, workspaceEnvelope, WorkspaceContextError } from './_workspace-access.js';

const VERSION=/^[a-f0-9]{64}$/;
const OWNER_COLUMNS='scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo';
const OWNER_SELECT='scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo';

export class SecondaryWorkspaceInputError extends Error{
  constructor(message,status=400){super(message);this.status=status;}
}
export class SecondaryWorkspaceConflictError extends Error{
  constructor(code,message,state){super(message);this.code=code;this.state=state;this.status=409;}
}

function exactFields(body,fields){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==[...fields].sort().join(','))
    throw new SecondaryWorkspaceInputError('unexpected or missing workspace fields');
}
function validVersion(value){if(typeof value!=='string'||!VERSION.test(value))throw new SecondaryWorkspaceInputError('valid base_version required');return value;}
function hash(value){return createHash('sha256').update(value).digest('hex');}
function version(key,domain,value){if(typeof key!=='string'||key.length<32)throw new Error('workspace version key unavailable');return createHmac('sha256',key).update(`${domain}\0${JSON.stringify(value)}`).digest('hex');}

export function secondaryRequestRoom(value,context){
  const room=typeof value==='string'?parseSecondaryRoomPath(`/join/${value}`):null;
  return room&&room.circleId===context.membership.id?room:null;
}

function accessStatement(db,room,sql,args=[],{pairedOnly=false}={}){
  return {sql:`WITH access AS (${secondaryPairAccessSql(db.workspaceContext,{pairedOnly})}) ${sql}`,
    args:[...secondaryPairAccessArgs({userId:db.workspaceContext.payload.id??db.workspaceContext.payload.uid,...room}),...args]};
}
function owned(alias){return `${alias}.publication_id=access.publication_id AND ${alias}.group_id=access.group_id
  AND ${alias}.scope_key=access.scope_key AND ${alias}.circle_id=access.circle_id AND ${alias}.cycle_key=access.cycle_key`;}
async function pair(db,room,pairedOnly=false){
  const result=await db.execute(accessStatement(db,room,'SELECT * FROM access',[],{pairedOnly}));
  return result.rows?.[0]||null;
}
async function clock(db){const result=await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc");const now=result.rows?.[0]?.now_utc;if(typeof now!=='string'||new Date(now).toISOString()!==now)throw new Error('workspace clock unavailable');return now;}

export function projectSecondaryCompletion(group,receipts,viewerId,key){
  const required=[Number(group.user_a_id),...(group.user_b_id==null?[]:[Number(group.user_b_id)])].sort((a,b)=>a-b);
  if(required.length!==(Number(group.is_solo)===1?1:2)||new Set(required).size!==required.length||!required.includes(Number(viewerId)))throw new Error('invalid secondary quorum');
  const seen=new Set();
  const evidence=receipts.map(row=>{
    const id=Number(row.user_id),at=row.confirmed_at;
    if(!required.includes(id)||seen.has(id)||typeof at!=='string'||new Date(at).toISOString()!==at)throw new Error('invalid completion receipt');
    seen.add(id);return [id,at];
  }).sort((a,b)=>a[0]-b[0]);
  const state=evidence.length===0?'not_recorded':evidence.length===required.length?'completed':'awaiting_participants';
  return Object.freeze({state,viewer_confirmed:seen.has(Number(viewerId)),confirmed_count:evidence.length,required_count:required.length,
    version:version(key,'randori-session-completion-v1',[Number(group.circle_id),Number(group.publication_id),Number(group.group_id),required,evidence]),
    completed_at:state==='completed'?evidence.map(row=>row[1]).sort().at(-1):null});
}

export async function readSecondaryCompletion(db,room,key){
  const group=await pair(db,room);if(!group)return null;
  const receipts=await db.execute(accessStatement(db,room,`SELECT receipt.user_id,receipt.confirmed_at
    FROM circle_session_completion_receipts receipt JOIN access ON ${owned('receipt')} ORDER BY receipt.user_id`));
  return {group,completion:projectSecondaryCompletion(group,receipts.rows,db.workspaceContext.payload.id??db.workspaceContext.payload.uid,key)};
}

export async function mutateSecondaryCompletion(db,room,body,key){
  exactFields(body,['room_id','action','base_version']);validVersion(body.base_version);
  if(!['confirm','withdraw'].includes(body.action))throw new SecondaryWorkspaceInputError('unsupported session completion action');
  const tx=await db.transaction('write');
  try{
    const current=await readSecondaryCompletion(tx,room,key);if(!current){await tx.rollback();return null;}
    const desired=body.action==='confirm',viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
    if(current.completion.state==='completed'&&!desired)throw new SecondaryWorkspaceConflictError('session_completion_terminal','A completed session cannot be withdrawn.',current.completion);
    if(current.completion.viewer_confirmed===desired){await tx.commit();return current;}
    if(current.completion.version!==body.base_version)throw new SecondaryWorkspaceConflictError('session_completion_changed','Session completion changed. Review the latest state.',current.completion);
    const written=desired?await tx.execute(accessStatement(tx,room,`INSERT INTO circle_session_completion_receipts
      (${OWNER_COLUMNS},publication_id,group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      SELECT ${OWNER_SELECT},publication_id,group_id,?,'auth',user_a_id,user_b_id,NULL,? FROM access
      WHERE 1 ON CONFLICT(publication_id,group_id,user_id) DO NOTHING RETURNING user_id`,[viewer,await clock(tx)]))
      :await tx.execute(accessStatement(tx,room,`DELETE FROM circle_session_completion_receipts
        WHERE publication_id=? AND group_id=? AND circle_id=? AND user_id=? AND EXISTS(SELECT 1 FROM access) RETURNING user_id`,[room.publicationId,room.groupId,room.circleId,viewer]));
    if(written.rows?.length!==1)throw new Error('completion write unavailable');
    const next=await readSecondaryCompletion(tx,room,key);if(!next)throw new Error('completion authorization changed');await tx.commit();return next;
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function readSecondaryMessages(db,room,{afterId=0,limit=50,newest=false}={}){
  if(!await pair(db,room))return null;
  const rows=await db.execute(accessStatement(db,room,`SELECT message.id,message.sender_id,message.message,message.created_at,
    CASE WHEN sender.status='active' THEN account.display_name ELSE 'Member unavailable' END AS sender_name
    FROM circle_pair_messages message JOIN access ON ${owned('message')}
    LEFT JOIN circle_memberships sender ON sender.circle_id=access.circle_id AND sender.user_id=message.sender_id
    LEFT JOIN auth_accounts account ON account.id=sender.user_id
    WHERE message.id>? ORDER BY message.id ${newest?'DESC':'ASC'} LIMIT ?`,[afterId,limit]));
  const messages=rows.rows.map(projectMessage).sort((a,b)=>a.id-b.id);return {messages,after:messages.at(-1)?.id??afterId};
}

export async function sendSecondaryMessage(db,room,body){
  exactFields(body,['room_id','message']);
  if(typeof body.message!=='string'||!body.message.trim())throw new SecondaryWorkspaceInputError('message must not be empty');
  const message=body.message.trim();if([...message].length>2000||Buffer.byteLength(message)>8000)throw new SecondaryWorkspaceInputError('message is too long');
  const viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid),tx=await db.transaction('write');
  try{
    if(!await pair(tx,room)){await tx.rollback();return null;}
    const limits=await tx.execute(accessStatement(tx,room,`SELECT
      (SELECT COUNT(*) FROM circle_pair_messages message WHERE ${owned('message')}) AS room_count,
      (SELECT COUNT(*) FROM circle_pair_messages message WHERE message.sender_id=? AND message.circle_id=access.circle_id
        AND datetime(message.created_at)>=datetime('now','-1 minute')) AS recent_count FROM access`,[viewer]));
    if(Number(limits.rows[0].recent_count)>=MAX_MESSAGES_PER_USER_PER_MINUTE)throw new SecondaryWorkspaceInputError('message rate limit exceeded',429);
    if(Number(limits.rows[0].room_count)>=MAX_MESSAGES_PER_ROOM)throw new SecondaryWorkspaceInputError('message room is full',409);
    const inserted=await tx.execute(accessStatement(tx,room,`INSERT INTO circle_pair_messages
      (${OWNER_COLUMNS},publication_id,group_id,sender_id,message,created_at)
      SELECT ${OWNER_SELECT},publication_id,group_id,?,?,datetime('now') FROM access RETURNING id,sender_id,message,created_at`,[viewer,message]));
    if(inserted.rows?.length!==1)throw new Error('message write unavailable');
    // Parallel registry ownership is established in the same transaction as
    // the first message. The legacy registry is never read or mutated here.
    await tx.execute(accessStatement(tx,room,`INSERT INTO circle_chat_retention_scopes
      (${OWNER_COLUMNS},publication_id,group_id,registered_at)
      SELECT ${OWNER_SELECT},publication_id,group_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM access
      WHERE 1 ON CONFLICT(circle_id,group_id) DO NOTHING`));
    const sender=await tx.execute(accessStatement(tx,room,`SELECT account.display_name FROM auth_accounts account
      JOIN access ON account.id=?`,[viewer]));
    await tx.commit();return {message:projectMessage({...inserted.rows[0],sender_name:sender.rows[0].display_name})};
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function readSecondaryRuns(db,room,{afterId=0,limit=20,verify,failOnOverflow=false}={}){
  if(!await pair(db,room))return null;
  const rows=await db.execute(accessStatement(db,room,`SELECT run.*,account.display_name AS runner_display_name
    FROM circle_session_runs run JOIN access ON ${owned('run')}
    JOIN circle_memberships runner ON runner.circle_id=access.circle_id AND runner.user_id=run.user_id AND runner.status='active'
    JOIN auth_accounts account ON account.id=runner.user_id WHERE run.id>?
    ORDER BY run.id ${afterId===0?'DESC':'ASC'} LIMIT ?`,[afterId,limit]));
  if(failOnOverflow&&rows.rows.length===limit)throw new Error('recap run scan overflow');
  const runs=rows.rows.map(row=>verify(row)).filter(Boolean).sort((a,b)=>a.id-b.id);
  return {runs,after:rows.rows.reduce((id,row)=>Math.max(id,Number(row.id)),afterId)};
}

export function secondaryDocumentIdentity(body){
  const questionSlug=body.question_slug,questionVersion=body.question_version,language=body.language;
  if(typeof questionSlug!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(questionSlug)||questionSlug.length>120)
    throw new SecondaryWorkspaceInputError('valid question_slug required');
  if(!Number.isSafeInteger(Number(questionVersion))||Number(questionVersion)<1)throw new SecondaryWorkspaceInputError('positive question_version required');
  if(!['javascript','python'].includes(language))throw new SecondaryWorkspaceInputError('language must be javascript or python');
  if(!getPublicExercise(questionSlug,Number(questionVersion)))throw new SecondaryWorkspaceInputError('question not found or unavailable',404);
  return {questionSlug,questionVersion:Number(questionVersion),language};
}

function documentVersion(room,identity,document){
  return hash(`randori-circle-code-document-v1\0${JSON.stringify([room.circleId,room.publicationId,room.groupId,
    identity.questionSlug,identity.questionVersion,identity.language,document.revision,document.stateHash,document.codeHash])}`);
}
function materializedDocument(row,room,identity){
  const doc=new Y.Doc();
  try{
    const state=Buffer.from(String(row.y_state_base64),'base64');
    if(state.toString('base64')!==row.y_state_base64)throw new Error('invalid stored document');
    Y.applyUpdate(doc,state);const materialized=materializeCodeDocument(doc,{stored:true});
    if(materialized.stateHash!==row.state_hash||materialized.codeHash!==row.code_hash)throw new Error('invalid stored document hashes');
    const result={...materialized,revision:Number(row.revision),updatedAt:row.updated_at};
    return {...result,version:documentVersion(room,identity,result)};
  }finally{doc.destroy();}
}
async function documentRow(db,room,identity){
  const rows=await db.execute(accessStatement(db,room,`SELECT document.*,CASE WHEN document.updated_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days') THEN 1 ELSE 0 END AS retention_expired FROM circle_pair_code_documents document
    JOIN access ON ${owned('document')} WHERE document.question_slug=? AND document.question_version=? AND document.language=? LIMIT 1`,
    [identity.questionSlug,identity.questionVersion,identity.language],{pairedOnly:true}));
  return rows.rows[0]||null;
}
export function secondaryDocumentResponse(result,afterRevision=0){
  const document=result.document,changed=document.revision!==afterRevision;
  return {ok:true,changed,created:result.created===true,revision:document.revision,document_version:document.version,
    state:changed?document.stateBase64:null,code_hash:document.codeHash,updated_at:document.updatedAt};
}

export async function readSecondaryDocument(db,room,identity,{create=true}={}){
  if(!await pair(db,room,true))return null;
  let row=await documentRow(db,room,identity);
  let expired=false;
  if(row&&Number(row.retention_expired)===1&&!create)return {document:null,created:false,expired:true};
  if(row&&Number(row.retention_expired)===1){
    expired=true;
    const snapshot=await db.execute(accessStatement(db,room,`SELECT snapshot.* FROM circle_pair_room_snapshots snapshot JOIN access ON ${owned('snapshot')}
      WHERE snapshot.question_id=? AND snapshot.language=?`,[`${identity.questionSlug}@${identity.questionVersion}`,identity.language],{pairedOnly:true}));
    const stored=snapshot.rows[0];
    if(stored){
      let envelope;try{envelope=JSON.parse(stored.code);}catch{}
      if(Number(stored.schema_version)>=3&&envelope?.board){
        await db.execute(accessStatement(db,room,`UPDATE circle_pair_room_snapshots SET code=?,revision=revision+1,client_id='retention-scrub',client_seq=revision+1,updated_at=datetime('now')
          WHERE room_id=? AND revision=? AND EXISTS(SELECT 1 FROM access)`,[JSON.stringify({code:'',board:envelope.board}),room.roomId,stored.revision]));
      }else await db.execute(accessStatement(db,room,`DELETE FROM circle_pair_room_snapshots WHERE room_id=? AND revision=? AND EXISTS(SELECT 1 FROM access)`,[room.roomId,stored.revision]));
    }
    await db.execute(accessStatement(db,room,`DELETE FROM circle_pair_code_documents WHERE publication_id=? AND group_id=? AND circle_id=?
      AND question_slug=? AND question_version=? AND language=? AND updated_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')
      AND EXISTS(SELECT 1 FROM access)`,[room.publicationId,room.groupId,room.circleId,identity.questionSlug,identity.questionVersion,identity.language],{pairedOnly:true}));
    row=null;
  }
  if(row)return {document:materializedDocument(row,room,identity),created:false};
  if(!create)return {document:null,created:false,expired};
  const current=await readSecondaryCompletion(db,room,'unused-document-completion-key-at-least-32-characters');
  if(current?.completion.state==='completed')return null;
  const snapshot=await db.execute(accessStatement(db,room,`SELECT snapshot.code,snapshot.schema_version FROM circle_pair_room_snapshots snapshot
    JOIN access ON ${owned('snapshot')} WHERE snapshot.room_id=? AND snapshot.language=? AND snapshot.question_id=? LIMIT 1`,
    [room.roomId,identity.language,`${identity.questionSlug}@${identity.questionVersion}`],{pairedOnly:true}));
  let seed='';if(snapshot.rows[0])seed=Number(snapshot.rows[0].schema_version)>=3?JSON.parse(snapshot.rows[0].code).code:snapshot.rows[0].code;
  const doc=new Y.Doc();let materialized;
  try{doc.getText('code').insert(0,seed);materialized=materializeCodeDocument(doc);}finally{doc.destroy();}
  const now=await clock(db),viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
  const inserted=await db.execute(accessStatement(db,room,`INSERT INTO circle_pair_code_documents
    (${OWNER_COLUMNS},publication_id,group_id,question_slug,question_version,language,y_state_base64,state_hash,code_hash,revision,
      pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,last_actor_id,last_actor_source,last_client_id,last_client_seq,created_at,updated_at)
    SELECT ${OWNER_SELECT},publication_id,group_id,?,?,?,?,?,?,1,user_a_id,'auth',user_b_id,'auth',NULL,?,'auth','server-bootstrap',0,?,?
    FROM access WHERE 1 ON CONFLICT(publication_id,group_id,question_slug,question_version,language) DO NOTHING RETURNING revision`,
    [identity.questionSlug,identity.questionVersion,identity.language,materialized.stateBase64,materialized.stateHash,materialized.codeHash,viewer,now,now],{pairedOnly:true}));
  row=await documentRow(db,room,identity);if(!row)throw new Error('document bootstrap unavailable');
  return {document:materializedDocument(row,room,identity),created:inserted.rows.length===1};
}

export async function mutateSecondaryDocument(db,room,body,key){
  exactFields(body,['room_id','question_slug','question_version','language','client_id','client_seq','update']);
  const identity=secondaryDocumentIdentity(body);
  if(typeof body.client_id!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(body.client_id)||!Number.isSafeInteger(body.client_seq)||body.client_seq<0)
    throw new SecondaryWorkspaceInputError('valid code document client identity required');
  if(typeof body.update!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(body.update))throw new SecondaryWorkspaceInputError('update must be canonical base64');
  const update=Buffer.from(body.update,'base64');
  if(!update.length||update.length>CODE_DOCUMENT_UPDATE_LIMIT_BYTES)throw new SecondaryWorkspaceInputError('update exceeds its byte limit',413);
  if(update.toString('base64')!==body.update)throw new SecondaryWorkspaceInputError('update must be canonical base64');
  const tx=await db.transaction('write');
  try{
    if(!await pair(tx,room,true)){await tx.rollback();return null;}
    const completion=await readSecondaryCompletion(tx,room,key);
    if(completion.completion.state==='completed')throw new SecondaryWorkspaceConflictError('session_completed','session is completed',null);
    const current=await readSecondaryDocument(tx,room,identity);if(!current)throw new Error('document unavailable');
    const doc=new Y.Doc();let merged;
    try{Y.applyUpdate(doc,current.document.state);Y.applyUpdate(doc,update);merged=materializeCodeDocument(doc);}
    catch(error){if(error instanceof CodeDocumentInputError)throw error;throw new SecondaryWorkspaceInputError('invalid code document update');}
    finally{doc.destroy();}
    if(merged.stateHash===current.document.stateHash){await tx.commit();return {...current,idempotent:true};}
    const now=await clock(tx),viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
    const written=await tx.execute(accessStatement(tx,room,`UPDATE circle_pair_code_documents
      SET y_state_base64=?,state_hash=?,code_hash=?,revision=revision+1,last_actor_id=?,last_actor_source='auth',last_client_id=?,last_client_seq=?,updated_at=?
      WHERE publication_id=? AND group_id=? AND circle_id=? AND question_slug=? AND question_version=? AND language=?
        AND revision=? AND state_hash=? AND EXISTS(SELECT 1 FROM access) RETURNING revision`,
      [merged.stateBase64,merged.stateHash,merged.codeHash,viewer,body.client_id,body.client_seq,now,room.publicationId,room.groupId,room.circleId,
        identity.questionSlug,identity.questionVersion,identity.language,current.document.revision,current.document.stateHash],{pairedOnly:true}));
    if(written.rows.length!==1)throw new Error('document CAS unavailable');
    // The board stays in the snapshot; canonical code is projected atomically.
    const snapshot=await tx.execute(accessStatement(tx,room,`SELECT snapshot.* FROM circle_pair_room_snapshots snapshot
      JOIN access ON ${owned('snapshot')} WHERE snapshot.room_id=? AND snapshot.language=? AND snapshot.question_id=? LIMIT 1`,
      [room.roomId,identity.language,`${identity.questionSlug}@${identity.questionVersion}`],{pairedOnly:true}));
    if(snapshot.rows[0]){
      const row=snapshot.rows[0],code=Number(row.schema_version)>=3?JSON.stringify({...JSON.parse(row.code),code:merged.code}):merged.code;
      await tx.execute(accessStatement(tx,room,`UPDATE circle_pair_room_snapshots SET code=?,revision=revision+1,updated_by=?,updated_at=datetime('now')
        WHERE room_id=? AND publication_id=? AND group_id=? AND circle_id=? AND revision=? AND EXISTS(SELECT 1 FROM access)`,
        [code,viewer,room.roomId,room.publicationId,room.groupId,room.circleId,row.revision],{pairedOnly:true}));
    }
    const result=await readSecondaryDocument(tx,room,identity);await tx.commit();return {...result,idempotent:false};
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function readSecondaryControls(db,room,key){
  const group=await pair(db,room,true);if(!group)return null;
  const rows=await db.execute(accessStatement(db,room,`SELECT controls.* FROM circle_pair_session_controls controls JOIN access ON ${owned('controls')} LIMIT 1`,[],{pairedOnly:true}));
  const row=rows.rows[0]||null,completion=(await readSecondaryCompletion(db,room,key)).completion,databaseNow=await clock(db);
  const logicalPair={weekId:room.publicationId,pairGroupId:room.groupId,viewerId:Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid),userAId:Number(group.user_a_id),userBId:Number(group.user_b_id)};
  const projectedRow=row?{...row,week_id:row.publication_id,pair_group_id:row.group_id}:null;
  const state=projectSessionControls(logicalPair,projectedRow,{databaseNow,completion,
    versionKey:version(key,'randori-circle-session-controls-key-v1',[room.circleId])});
  return {group,row,state,completion,databaseNow};
}

export async function mutateSecondaryControls(db,room,body,key){
  const action=body.action;exactFields(body,action==='set_candidate'?['room_id','action','base_version','candidate_user_id']:['room_id','action','base_version']);validVersion(body.base_version);
  if(!['set_candidate','start','pause','reset'].includes(action))throw new SecondaryWorkspaceInputError('unsupported session-controls action');
  const tx=await db.transaction('write');
  try{
    const current=await readSecondaryControls(tx,room,key);if(!current){await tx.rollback();return null;}
    if(current.state.terminal)throw new SecondaryWorkspaceConflictError('session_controls_completed','The session is completed.',current.state);
    let candidate=current.state.candidate_user_id,timer=current.row?.timer_state??'paused',remaining=current.row?.remaining_ms??SESSION_TIMER_DURATION_MS,anchor=current.row?.anchor_at??null;
    if(action==='set_candidate'){
      if(!Number.isSafeInteger(body.candidate_user_id)||![Number(current.group.user_a_id),Number(current.group.user_b_id)].includes(body.candidate_user_id))throw new SecondaryWorkspaceInputError('candidate must be a participant in this pair');
      candidate=body.candidate_user_id;
    }else if(action==='start'){
      if(current.state.remaining_ms===0)throw new SecondaryWorkspaceConflictError('session_controls_reset_required','Reset the expired timer before starting it again.',current.state);
      if(current.state.timer_state!=='running'){timer='running';remaining=current.state.remaining_ms;anchor=current.databaseNow;}
    }else if(action==='pause'){
      if(current.state.timer_state==='running'){timer='paused';remaining=current.state.remaining_ms;anchor=null;}
    }else{timer='paused';remaining=SESSION_TIMER_DURATION_MS;anchor=null;}
    const unchanged=candidate===current.state.candidate_user_id&&timer===(current.row?.timer_state??'paused')&&remaining===(current.row?.remaining_ms??SESSION_TIMER_DURATION_MS)&&anchor===(current.row?.anchor_at??null);
    if(unchanged){await tx.commit();return current;}
    if(body.base_version!==current.state.version)throw new SecondaryWorkspaceConflictError('session_controls_changed','Session controls changed. Review the latest state.',current.state);
    const viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
    const written=await tx.execute(accessStatement(tx,room,`INSERT INTO circle_pair_session_controls
      (${OWNER_COLUMNS},publication_id,group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,
        candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
      SELECT ${OWNER_SELECT},publication_id,group_id,user_a_id,'auth',user_b_id,'auth',NULL,?,'auth',?,?,?,1,?,'auth',?,?
      FROM access WHERE 1 ON CONFLICT(publication_id,group_id) DO UPDATE SET candidate_user_id=excluded.candidate_user_id,
        timer_state=excluded.timer_state,remaining_ms=excluded.remaining_ms,anchor_at=excluded.anchor_at,revision=circle_pair_session_controls.revision+1,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at RETURNING revision`,
      [candidate,timer,remaining,anchor,viewer,current.databaseNow,current.databaseNow],{pairedOnly:true}));
    if(written.rows.length!==1)throw new Error('controls write unavailable');
    const next=await readSecondaryControls(tx,room,key);await tx.commit();return next;
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

async function secondaryRoomSchedule(db,room){
  const rows=await db.execute(accessStatement(db,room,`SELECT schedule.*,publication.generation_token
    FROM access JOIN circle_pairing_publications publication ON publication.id=access.publication_id
    LEFT JOIN circle_pair_schedules schedule ON ${owned('schedule')} LIMIT 1`));
  const row=rows.rows[0];if(!row)throw new Error('schedule authorization unavailable');
  const proposals=await db.execute(accessStatement(db,room,`SELECT proposal.* FROM circle_pair_schedule_proposals proposal
    JOIN access ON ${owned('proposal')} ORDER BY proposal.created_at,proposal.id`));
  const scheduleKey=row.schedule_key||secondaryScheduleIdentity({generationToken:row.generation_token,groupId:room.groupId});
  const evidence=[scheduleKey,Number(row.revision||0),row.agreed_time??null,row.updated_at??null,
    proposals.rows.map(proposal=>[proposal.proposal_key,proposal.instant,Number(proposal.proposed_by)===Number(row.user_a_id)?'a':'b'])];
  return {agreed_time:row.agreed_time??null,legacy_agreed_time:null,updated_at:row.updated_at??null,
    version:hash(`randori-secondary-schedule-version-v1\0${JSON.stringify(evidence)}`)};
}

export async function readSecondaryMeetingLink(db,room,key){
  const completion=await readSecondaryCompletion(db,room,key);if(!completion)return null;
  const schedule=await secondaryRoomSchedule(db,room);
  const lifecycle=completion.completion.state==='completed'?'completed':schedule.agreed_time?'active':'unscheduled';
  if(lifecycle!=='active')return {state:{lifecycle,accepted_schedule_at:schedule.agreed_time,schedule_version:schedule.version,
    completion_version:completion.completion.version,version:null,url:null,hostname:null,updated_at:null},completion:completion.completion,schedule,row:null};
  const rows=await db.execute(accessStatement(db,room,`SELECT link.* FROM circle_pair_meeting_links link JOIN access ON ${owned('link')}
    WHERE link.accepted_schedule_at=? LIMIT 1`,[schedule.agreed_time]));
  const row=rows.rows[0]||null,normalized=row?.meeting_url?normalizeMeetingUrl(row.meeting_url):null;
  const state={lifecycle,accepted_schedule_at:schedule.agreed_time,schedule_version:schedule.version,completion_version:completion.completion.version,
    version:version(key,'randori-meeting-link-v1',[room.roomId,schedule.version,schedule.agreed_time,Number(row?.revision||0),normalized?.url??null]),
    url:normalized?.url??null,hostname:normalized?.hostname??null,updated_at:row?.updated_at??null};
  return {state,schedule,completion:completion.completion,row};
}

export async function mutateSecondaryMeetingLink(db,room,body,key){
  exactFields(body,body.action==='set'?['room_id','action','base_version','schedule_version','completion_version','url']:['room_id','action','base_version','schedule_version','completion_version']);
  for(const field of ['base_version','schedule_version','completion_version'])validVersion(body[field]);
  if(!['set','clear'].includes(body.action))throw new SecondaryWorkspaceInputError('unsupported meeting-link action');
  const desired=body.action==='set'?normalizeMeetingUrl(body.url).url:null,tx=await db.transaction('write');
  try{
    const current=await readSecondaryMeetingLink(tx,room,key);if(!current){await tx.rollback();return null;}
    if(current.state.lifecycle==='completed')throw new SecondaryWorkspaceConflictError('meeting_link_session_completed','The completed session no longer exposes a meeting link.',current.state);
    if(current.state.lifecycle!=='active')throw new SecondaryWorkspaceConflictError('meeting_link_schedule_required','Agree on a session time before adding a meeting link.',current.state);
    if(current.state.schedule_version!==body.schedule_version)throw new SecondaryWorkspaceConflictError('meeting_link_schedule_changed','The accepted schedule changed. Review the latest session time.',current.state);
    if(current.completion.version!==body.completion_version)throw new SecondaryWorkspaceConflictError('meeting_link_completion_changed','Session completion changed. Review the latest state.',current.state);
    if(current.state.url===desired){await tx.commit();return current;}
    if(current.state.version!==body.base_version)throw new SecondaryWorkspaceConflictError('meeting_link_changed','The meeting link changed. Review the latest value.',current.state);
    const viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid),now=await clock(tx);
    const written=await tx.execute(accessStatement(tx,room,`INSERT INTO circle_pair_meeting_links
      (${OWNER_COLUMNS},publication_id,group_id,accepted_schedule_at,meeting_url,revision,updated_by,updated_by_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,created_at,updated_at)
      SELECT ${OWNER_SELECT},publication_id,group_id,?,?,1,?,'auth',user_a_id,user_b_id,NULL,?,? FROM access
      WHERE EXISTS(SELECT 1 FROM circle_pair_schedules schedule WHERE ${owned('schedule')} AND schedule.agreed_time=?)
      ON CONFLICT(publication_id,group_id) DO UPDATE SET meeting_url=excluded.meeting_url,revision=circle_pair_meeting_links.revision+1,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE circle_pair_meeting_links.accepted_schedule_at=excluded.accepted_schedule_at
      RETURNING revision`,[current.schedule.agreed_time,desired,viewer,now,now,current.schedule.agreed_time]));
    if(written.rows.length!==1)throw new Error('meeting link write unavailable');
    const next=await readSecondaryMeetingLink(tx,room,key);await tx.commit();return next;
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function readSecondarySnapshot(db,room,{afterRevision=0}={}){
  if(!await pair(db,room))return null;
  const rows=await db.execute(accessStatement(db,room,`SELECT snapshot.* FROM circle_pair_room_snapshots snapshot JOIN access ON ${owned('snapshot')}
    WHERE snapshot.room_id=? LIMIT 1`,[room.roomId]));
  let snapshot=snapshotFromRow(rows.rows[0]);
  if(snapshot&&snapshot.question_version){
    const document=await readSecondaryDocument(db,room,{questionSlug:snapshot.question_id,questionVersion:snapshot.question_version,language:snapshot.language},{create:false});
    if(document&&document.document)snapshot={...snapshot,code:document.document.code};
    else if(document?.expired)snapshot={...snapshot,code:''};
  }
  return {snapshot:snapshot&&snapshot.revision>afterRevision?snapshot:null,revision:snapshot?.revision||0};
}

export async function mutateSecondarySnapshot(db,room,body,key){
  const parsed=parseWorkspacePayload(body.payload);if(parsed.error)throw new SecondaryWorkspaceInputError(parsed.error,parsed.status);
  const workspace=parsed.payload,tx=await db.transaction('write');
  try{
    const completion=await readSecondaryCompletion(tx,room,key);if(!completion){await tx.rollback();return null;}
    if(completion.completion.state==='completed')throw new SecondaryWorkspaceConflictError('session_completed','session is completed',null);
    const current=(await readSecondarySnapshot(tx,room)).snapshot;
    if(current&&workspace.schema_version<current.schema_version)throw new SecondaryWorkspaceConflictError('workspace_schema_changed',`schema version ${workspace.schema_version} cannot overwrite workspace schema version ${current.schema_version}`,current);
    if(current?.client_id===workspace.client_id&&current.client_seq===workspace.client_seq){await tx.commit();return {snapshot:current,revision:current.revision,idempotent:true};}
    if((current?.revision||0)!==workspace.base_revision)throw new SecondaryWorkspaceConflictError('workspace_revision_changed','revision conflict',current);
    let code=workspace.code;
    if(workspace.question_version&&!Number(completion.group.is_solo)){
      const document=await readSecondaryDocument(tx,room,{questionSlug:workspace.question_id,questionVersion:workspace.question_version,language:workspace.language},{create:false});
      if(document?.document)code=document.document.code;
    }
    const stored=storedWorkspaceCode({...workspace,code}),question=workspace.question_version?`${workspace.question_id}@${workspace.question_version}`:workspace.question_id;
    const viewer=Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid);
    const written=await tx.execute(accessStatement(tx,room,`INSERT INTO circle_pair_room_snapshots
      (${OWNER_COLUMNS},room_id,publication_id,group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
      SELECT ${OWNER_SELECT},?,publication_id,group_id,1,?,?,?,?,?,?,? FROM access WHERE 1
      ON CONFLICT(room_id) DO UPDATE SET revision=circle_pair_room_snapshots.revision+1,schema_version=excluded.schema_version,
        client_id=excluded.client_id,client_seq=excluded.client_seq,language=excluded.language,question_id=excluded.question_id,
        code=excluded.code,updated_by=excluded.updated_by,updated_at=datetime('now')
      WHERE circle_pair_room_snapshots.revision=? RETURNING revision`,
      [room.roomId,workspace.schema_version,workspace.client_id,workspace.client_seq,workspace.language,question,stored,viewer,workspace.base_revision]));
    if(written.rows.length!==1)throw new Error('snapshot write unavailable');
    const next=await readSecondarySnapshot(tx,room);await tx.commit();return next;
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function readSecondarySignals(db,room,{after=0,peerId=''}={}){
  if(!await pair(db,room))return null;
  const rows=await db.execute(accessStatement(db,room,`SELECT signal.id,signal.room_id,signal.from_id,signal.to_id,signal.type,signal.payload,signal.created_at
    FROM circle_video_signals signal JOIN access ON ${owned('signal')}
    WHERE signal.id>? AND signal.created_at>datetime('now','-1 hour') AND (?='' OR signal.from_id<>?)
      AND (?='' OR signal.to_id IS NULL OR signal.to_id='' OR signal.to_id=?) ORDER BY signal.id LIMIT 100`,[after,peerId,peerId,peerId,peerId]));
  return {signals:rows.rows,after:rows.rows.at(-1)?.id??after,count:rows.rows.length};
}

export async function mutateSecondarySignals(db,room,body,{purge=false}={}){
  const tx=await db.transaction('write');
  try{
    if(!await pair(tx,room)){await tx.rollback();return null;}
    if(purge){
      await tx.execute(accessStatement(tx,room,`DELETE FROM circle_video_signals WHERE room_id=? AND circle_id=? AND EXISTS(SELECT 1 FROM access)`,[room.roomId,room.circleId]));
      await tx.commit();return {purged:true};
    }
    const from=String(body.from_id??body.fromId??body.peer_id??'').trim().slice(0,128),to=String(body.to_id??body.toId??'').trim().slice(0,128)||null,type=String(body.type??'').trim().toLowerCase();
    if(!from||!['offer','answer','ice','candidate','join','leave'].includes(type)||body.payload===undefined)throw new SecondaryWorkspaceInputError('room_id, from_id, type, payload required');
    const payload=typeof body.payload==='string'?body.payload:JSON.stringify(body.payload);
    if(typeof payload!=='string')throw new SecondaryWorkspaceInputError('signal payload required');
    if(payload.length>20000)throw new SecondaryWorkspaceInputError('signal payload too large',413);
    const inserted=await tx.execute(accessStatement(tx,room,`INSERT INTO circle_video_signals
      (${OWNER_COLUMNS},publication_id,group_id,room_id,from_id,to_id,type,payload)
      SELECT ${OWNER_SELECT},publication_id,group_id,?,?,?,?,? FROM access RETURNING id`,[room.roomId,from,to,type,payload]));
    if(inserted.rows.length!==1)throw new Error('signal write unavailable');
    await tx.execute(accessStatement(tx,room,`DELETE FROM circle_video_signals WHERE room_id=? AND circle_id=? AND EXISTS(SELECT 1 FROM access)
      AND (created_at<datetime('now','-1 hour') OR id NOT IN (SELECT id FROM circle_video_signals WHERE room_id=? AND circle_id=? ORDER BY id DESC LIMIT 500))`,[room.roomId,room.circleId,room.roomId,room.circleId]));
    await tx.commit();return {id:inserted.rows[0].id,from_id:from,type};
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export { accessStatement, clock, exactFields, hash, owned, OWNER_COLUMNS, OWNER_SELECT, pair, version, validVersion };
