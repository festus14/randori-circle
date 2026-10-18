import { createHash } from 'node:crypto';
import * as Y from 'yjs';

import { authPairAccessArgs } from './_pair-access.js';
import { getPublicExercise } from './_catalog.js';
import { parseCanonicalRoomPath } from './_pairing.js';

export const CODE_DOCUMENT_STATE_LIMIT_BYTES=256*1024;
export const CODE_DOCUMENT_UPDATE_LIMIT_BYTES=64*1024;
export const CODE_DOCUMENT_CODE_LIMIT_BYTES=20*1024;
export const CODE_DOCUMENT_RETENTION_DAYS=90;
const DOCUMENT_VERSION=/^[a-f0-9]{64}$/;
const CLIENT_ID=/^[A-Za-z0-9_-]{8,64}$/;
const QUESTION_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const LANGUAGES=new Set(['javascript','python']);
const MAX_TRANSACTION_ATTEMPTS=4;
const documentTails=new Map();

export class CodeDocumentInputError extends Error{
  constructor(message,{status=400}={}){ super(message); this.name='CodeDocumentInputError'; this.status=status; }
}

export class CodeDocumentDataError extends Error{
  constructor(message,{cause}={}){ super(message,cause===undefined?undefined:{cause}); this.name='CodeDocumentDataError'; }
}

function positiveSafeInteger(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
}

function canonicalRoom(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value
    ?{roomId:parsed.roomId,weekId:parsed.weekId,pairGroupId:parsed.pairGroupId}
    :null;
}

function requestQuery(req){
  const result=Object.create(null);
  if(req?.query&&typeof req.query==='object'&&!Array.isArray(req.query)){
    for(const [key,value] of Object.entries(req.query)) result[key]=value;
  }
  try{
    const search=new URL(req?.url||'/','http://localhost').searchParams;
    for(const key of new Set(search.keys())){
      const values=search.getAll(key);
      if(values.length>1) result[key]=values;
      else if(!Object.prototype.hasOwnProperty.call(result,key)) result[key]=values[0];
      else if(Array.isArray(result[key])) continue;
      else if(String(result[key])!==values[0]) result[key]=[result[key],values[0]];
    }
  }catch{}
  return result;
}

function parseIdentity(value){
  const room=canonicalRoom(value.room_id);
  if(!room) throw new CodeDocumentInputError('canonical room_id required');
  const questionSlug=typeof value.question_slug==='string'?value.question_slug:'';
  if(!QUESTION_SLUG.test(questionSlug)||questionSlug.length>120){
    throw new CodeDocumentInputError('valid question_slug required');
  }
  const questionVersion=positiveSafeInteger(value.question_version);
  if(!questionVersion) throw new CodeDocumentInputError('positive question_version required');
  const language=typeof value.language==='string'?value.language:'';
  if(!LANGUAGES.has(language)) throw new CodeDocumentInputError('language must be javascript or python');
  if(!getPublicExercise(questionSlug,questionVersion)){
    throw new CodeDocumentInputError('question not found or unavailable',{status:404});
  }
  return Object.freeze({...room,questionSlug,questionVersion,language});
}

export function parseCodeDocumentQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!['room_id','question_slug','question_version','language','after_revision'].includes(key))
    ||Object.values(query).some(Array.isArray)){
    throw new CodeDocumentInputError('unsupported query parameter');
  }
  const identity=parseIdentity(query);
  const rawAfter=query.after_revision;
  const afterRevision=rawAfter===undefined||rawAfter===''?0:Number(rawAfter);
  if(!Number.isSafeInteger(afterRevision)||afterRevision<0){
    throw new CodeDocumentInputError('after_revision must be a safe non-negative integer');
  }
  return Object.freeze({...identity,afterRevision});
}

function decodeBoundedBase64(value,maxBytes,field){
  if(typeof value!=='string'||value.length<4||!BASE64.test(value)){
    throw new CodeDocumentInputError(`${field} must be canonical base64`);
  }
  const decoded=Buffer.from(value,'base64');
  if(decoded.byteLength===0||decoded.byteLength>maxBytes){
    throw new CodeDocumentInputError(`${field} exceeds its byte limit`,{status:413});
  }
  if(decoded.toString('base64')!==value){
    throw new CodeDocumentInputError(`${field} must be canonical base64`);
  }
  return new Uint8Array(decoded);
}

export function parseCodeDocumentMutation(body){
  if(!exactKeys(body,['room_id','question_slug','question_version','language','update','client_id','client_seq'])){
    throw new CodeDocumentInputError('unexpected or missing code-document fields');
  }
  const identity=parseIdentity(body);
  if(typeof body.client_id!=='string'||!CLIENT_ID.test(body.client_id)){
    throw new CodeDocumentInputError('client_id must be an 8-64 character URL-safe identifier');
  }
  if(!Number.isSafeInteger(body.client_seq)||body.client_seq<0){
    throw new CodeDocumentInputError('client_seq must be a safe non-negative integer');
  }
  return Object.freeze({
    ...identity,clientId:body.client_id,clientSeq:body.client_seq,
    update:decodeBoundedBase64(body.update,CODE_DOCUMENT_UPDATE_LIMIT_BYTES,'update'),
  });
}

function sha256(value){ return createHash('sha256').update(value).digest('hex'); }

export function codeDocumentVersion({weekId,pairGroupId,questionSlug,questionVersion,language,revision,stateHash,codeHash}){
  return sha256(JSON.stringify([1,weekId,pairGroupId,questionSlug,questionVersion,language,revision,stateHash,codeHash]));
}

function exactHumanPair(row,viewerId){
  const weekId=positiveSafeInteger(row?.week_id);
  const pairGroupId=positiveSafeInteger(row?.pair_group_id);
  const userAId=positiveSafeInteger(row?.user_a_id);
  const userBId=positiveSafeInteger(row?.user_b_id);
  if(!weekId||!pairGroupId||!userAId||!userBId||userAId===userBId
    ||Number(row?.is_ai_pair)!==0||(row?.user_c_id!==null&&row?.user_c_id!==undefined)
    ||row?.user_a_source!=='auth'||row?.user_b_source!=='auth'
    ||(row?.user_c_source!==null&&row?.user_c_source!==undefined)
    ||![userAId,userBId].includes(viewerId)) return null;
  return Object.freeze({weekId,pairGroupId,userAId,userBId,viewerId});
}

async function authorizedPair(db,viewerId,identity){
  const accessSql=codeDocumentAccessSql();
  const accessArgs=authPairAccessArgs({userId:viewerId,weekId:identity.weekId,pairGroupId:identity.pairGroupId});
  const result=await db.execute({sql:accessSql,args:accessArgs});
  if(result?.rows?.length!==1) return null;
  const pair=exactHumanPair(result.rows[0],viewerId);
  return pair?{pair,accessSql,accessArgs}:null;
}

export function codeDocumentAccessSql(){
  const membership=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'?`
    JOIN circle_memberships AS viewer_membership
      ON viewer_membership.user_id=viewer.user_id AND viewer_membership.status='active'
    JOIN circles AS viewer_circle
      ON viewer_circle.id=viewer_membership.circle_id
     AND viewer_circle.is_primary=1 AND viewer_circle.archived_at IS NULL`:'';
  return `SELECT pg.id AS pair_group_id,pg.week_id,pg.user_a_id,pg.user_b_id,pg.user_c_id,
      pg.is_ai_pair,pa.source AS user_a_source,pb.source AS user_b_source,NULL AS user_c_source
    FROM pairing_groups pg
    JOIN pairing_participants viewer
      ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
    JOIN pairing_participants pa
      ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id AND pa.source='auth'
    JOIN pairing_participants pb
      ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id AND pb.source='auth'${membership}
    WHERE pg.id=? AND pg.week_id=? AND pg.is_ai_pair=0 AND pg.user_c_id IS NULL
      AND pg.user_a_id<>pg.user_b_id
      AND (?=pg.user_a_id OR ?=pg.user_b_id) AND ? IN (pg.user_a_id,pg.user_b_id)
    LIMIT 1`;
}

async function completedPair(db,authorization,identity){
  const result=await db.execute({
    sql:`WITH access AS (${authorization.accessSql})
      SELECT COUNT(*) AS confirmed_count FROM session_completion_receipts receipt
      WHERE receipt.week_id=? AND receipt.pair_group_id=?
        AND receipt.participant_source='auth'
        AND receipt.user_id IN (SELECT user_a_id FROM access UNION ALL SELECT user_b_id FROM access)
        AND EXISTS (SELECT 1 FROM access)`,
    args:[...authorization.accessArgs,identity.weekId,identity.pairGroupId],
  });
  if(result?.rows?.length!==1) throw new CodeDocumentDataError('completion boundary is unavailable');
  return Number(result.rows[0].confirmed_count)===2;
}

function storedWorkspaceSeed(row,identity){
  if(!row||String(row.language)!==identity.language) return '';
  const storedQuestion=String(row.question_id||'');
  if(storedQuestion!==`${identity.questionSlug}@${identity.questionVersion}`) return '';
  let code=String(row.code||'');
  if(Number(row.schema_version)>=3){
    let envelope;
    try{ envelope=JSON.parse(code); }catch{ throw new CodeDocumentDataError('stored workspace bootstrap is invalid'); }
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||typeof envelope.code!=='string'){
      throw new CodeDocumentDataError('stored workspace bootstrap is invalid');
    }
    code=envelope.code;
  }
  if(Buffer.byteLength(code,'utf8')>CODE_DOCUMENT_CODE_LIMIT_BYTES){
    throw new CodeDocumentDataError('stored workspace bootstrap exceeds the code limit');
  }
  return code;
}

function materialize(doc,{stored=false}={}){
  const invalid=message=>{
    if(stored) throw new CodeDocumentDataError(message);
    throw new CodeDocumentInputError(message);
  };
  const text=doc.getText('code');
  const roots=[...doc.share.entries()];
  if(roots.length!==1||roots[0][0]!=='code'||!(roots[0][1] instanceof Y.Text)){
    invalid(stored?'stored code document has unsupported shared types':'update contains unsupported shared types');
  }
  if(text.toDelta().some(operation=>typeof operation.insert!=='string'||Object.keys(operation).some(key=>key!=='insert'))){
    invalid(stored?'stored code document contains rich content':'update must contain unformatted text only');
  }
  const code=text.toString();
  if(Buffer.byteLength(code,'utf8')>CODE_DOCUMENT_CODE_LIMIT_BYTES){
    throw new CodeDocumentInputError('merged code exceeds the 20000-byte limit',{status:413});
  }
  const state=Y.encodeStateAsUpdate(doc);
  if(state.byteLength>CODE_DOCUMENT_STATE_LIMIT_BYTES){
    throw new CodeDocumentInputError('merged document exceeds the state byte limit',{status:413});
  }
  const stateBuffer=Buffer.from(state);
  return Object.freeze({
    state,stateBase64:stateBuffer.toString('base64'),stateHash:sha256(stateBuffer),
    code,codeHash:sha256(Buffer.from(code,'utf8')),
  });
}

function decodeStoredState(row){
  const encoded=String(row?.y_state_base64||'');
  let state;
  try{ state=decodeBoundedBase64(encoded,CODE_DOCUMENT_STATE_LIMIT_BYTES,'stored state'); }
  catch(error){ throw new CodeDocumentDataError('stored code document is invalid',{cause:error}); }
  if(sha256(Buffer.from(state))!==String(row.state_hash||'')){
    throw new CodeDocumentDataError('stored code document hash is invalid');
  }
  const doc=new Y.Doc({gc:true});
  try{ Y.applyUpdate(doc,state,'server-load'); }
  catch(error){ throw new CodeDocumentDataError('stored code document is corrupt',{cause:error}); }
  const materialized=materialize(doc,{stored:true});
  if(materialized.codeHash!==String(row.code_hash||'')){
    throw new CodeDocumentDataError('stored code hash is invalid');
  }
  return {doc,materialized};
}

function normalizedMetadata(row,identity){
  if(!row) return null;
  const revision=Number(row.revision);
  const pairUserAId=positiveSafeInteger(row.pair_user_a_id);
  const pairUserBId=positiveSafeInteger(row.pair_user_b_id);
  if(!Number.isSafeInteger(revision)||revision<1||!pairUserAId||!pairUserBId
    ||pairUserAId===pairUserBId||row.pair_user_a_source!=='auth'||row.pair_user_b_source!=='auth'
    ||(row.pair_user_c_id!==null&&row.pair_user_c_id!==undefined)||row.last_actor_source!=='auth'
    ||![pairUserAId,pairUserBId].includes(Number(row.last_actor_id))
    ||Number(row.week_id)!==identity.weekId||Number(row.pair_group_id)!==identity.pairGroupId
    ||String(row.question_slug)!==identity.questionSlug||Number(row.question_version)!==identity.questionVersion
    ||String(row.language)!==identity.language){
    throw new CodeDocumentDataError('stored code document metadata is invalid');
  }
  const stateHash=String(row.state_hash||'');
  const codeHash=String(row.code_hash||'');
  if(!DOCUMENT_VERSION.test(stateHash)||!DOCUMENT_VERSION.test(codeHash)){
    throw new CodeDocumentDataError('stored code document hashes are invalid');
  }
  return {revision,stateHash,codeHash,updatedAt:String(row.updated_at||'')};
}

function normalizedRow(row,identity){
  const metadata=normalizedMetadata(row,identity);
  if(!metadata) return null;
  const decoded=decodeStoredState(row);
  const version=codeDocumentVersion({...identity,revision:metadata.revision,stateHash:decoded.materialized.stateHash,codeHash:decoded.materialized.codeHash});
  return Object.freeze({
    revision:metadata.revision,version,state:decoded.materialized.stateBase64,stateHash:decoded.materialized.stateHash,
    codeHash:decoded.materialized.codeHash,code:decoded.materialized.code,
    updatedAt:metadata.updatedAt,doc:decoded.doc,
  });
}

const DOCUMENT_COLUMNS=`week_id,pair_group_id,question_slug,question_version,language,
  y_state_base64,state_hash,code_hash,revision,pair_user_a_id,pair_user_a_source,
  pair_user_b_id,pair_user_b_source,pair_user_c_id,last_actor_id,last_actor_source,
  last_client_id,last_client_seq,created_at,updated_at`;

async function readRow(db,identity){
  const result=await db.execute({
    sql:`SELECT ${DOCUMENT_COLUMNS},
        CASE WHEN updated_at < ${RETENTION_CUTOFF_SQL} THEN 1 ELSE 0 END AS retention_expired
      FROM pair_code_documents
      WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=? LIMIT 1`,
    args:[identity.weekId,identity.pairGroupId,identity.questionSlug,identity.questionVersion,identity.language],
  });
  if(!Array.isArray(result?.rows)) throw new CodeDocumentDataError('code document query is invalid');
  return result.rows[0]||null;
}

async function createDocument(db,viewerId,identity,authorization,{clientId='server-bootstrap',clientSeq=0}={}){
  const workspace=await db.execute({
    sql:`SELECT schema_version,language,question_id,code FROM pair_room_snapshots
      WHERE room_id=? AND week_id=? AND pair_group_id=? LIMIT 1`,
    args:[identity.roomId,identity.weekId,identity.pairGroupId],
  });
  const seed=storedWorkspaceSeed(workspace?.rows?.[0],identity);
  const doc=new Y.Doc({gc:true});
  if(seed) doc.getText('code').insert(0,seed);
  const state=materialize(doc);
  const inserted=await db.execute({
    sql:`WITH access AS (${authorization.accessSql})
      INSERT INTO pair_code_documents (${DOCUMENT_COLUMNS})
      SELECT ?,?,?,?,?,?,?,?,?,?,'auth',?,'auth',NULL,?,'auth',?,?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE EXISTS (SELECT 1 FROM access)
      ON CONFLICT DO NOTHING`,
    args:[...authorization.accessArgs,identity.weekId,identity.pairGroupId,identity.questionSlug,
      identity.questionVersion,identity.language,state.stateBase64,state.stateHash,state.codeHash,1,
      authorization.pair.userAId,authorization.pair.userBId,viewerId,clientId,clientSeq],
  });
  return {row:await readRow(db,identity),created:Number(inserted?.rowsAffected)===1};
}

async function projectWorkspaceCode(db,identity,authorization,{code,revision,viewerId}){
  const snapshot=await db.execute({
    sql:`SELECT revision,schema_version,code FROM pair_room_snapshots
      WHERE room_id=? AND week_id=? AND pair_group_id=? AND language=? AND question_id=? LIMIT 1`,
    args:[identity.roomId,identity.weekId,identity.pairGroupId,identity.language,
      `${identity.questionSlug}@${identity.questionVersion}`],
  });
  const row=snapshot?.rows?.[0];
  if(!row||Number(row.schema_version)<3) return false;
  let envelope;
  try{ envelope=JSON.parse(String(row.code||'')); }catch{ throw new CodeDocumentDataError('stored workspace projection is invalid'); }
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||typeof envelope.code!=='string'
    ||!envelope.board||typeof envelope.board!=='object'||Array.isArray(envelope.board)){
    throw new CodeDocumentDataError('stored workspace projection is invalid');
  }
  const serialized=JSON.stringify({code,board:envelope.board});
  const projected=await db.execute({
    sql:`WITH access AS (${authorization.accessSql}) UPDATE pair_room_snapshots
      SET revision=revision+1,client_id='crdt-projection',client_seq=?,code=?,updated_by=?,updated_at=datetime('now')
      WHERE room_id=? AND week_id=? AND pair_group_id=? AND revision=?
        AND EXISTS (SELECT 1 FROM access)`,
    args:[...authorization.accessArgs,revision,serialized,viewerId,identity.roomId,identity.weekId,
      identity.pairGroupId,Number(row.revision)],
  });
  return Number(projected?.rowsAffected)===1;
}

function publicDocument(document,{changed=true,created=false}={}){
  return {
    changed,created,revision:document.revision,document_version:document.version,
    state:changed?document.state:null,code_hash:document.codeHash,updated_at:document.updatedAt,
  };
}

async function finish(transaction,method){
  try{ await transaction[method](); }
  finally{ try{ await transaction.close?.(); }catch{} }
}

const RETENTION_CUTOFF_SQL=`strftime('%Y-%m-%dT%H:%M:%fZ','now','-${CODE_DOCUMENT_RETENTION_DAYS} days')`;

async function scrubWorkspaceProjection(db,identity){
  const snapshot=await db.execute({
    sql:`SELECT revision,schema_version,code FROM pair_room_snapshots
      WHERE room_id=? AND week_id=? AND pair_group_id=? AND language=? AND question_id=? LIMIT 1`,
    args:[identity.roomId,identity.weekId,identity.pairGroupId,identity.language,
      `${identity.questionSlug}@${identity.questionVersion}`],
  });
  const row=snapshot?.rows?.[0];
  if(!row) return false;
  if(Number(row.schema_version)<3){
    await db.execute({
      sql:`DELETE FROM pair_room_snapshots WHERE room_id=? AND week_id=? AND pair_group_id=? AND revision=?`,
      args:[identity.roomId,identity.weekId,identity.pairGroupId,Number(row.revision)],
    });
    return true;
  }
  let envelope;
  try{ envelope=JSON.parse(String(row.code||'')); }catch{}
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)
    ||!envelope.board||typeof envelope.board!=='object'||Array.isArray(envelope.board)){
    await db.execute({
      sql:`DELETE FROM pair_room_snapshots WHERE room_id=? AND week_id=? AND pair_group_id=? AND revision=?`,
      args:[identity.roomId,identity.weekId,identity.pairGroupId,Number(row.revision)],
    });
    return true;
  }
  const updated=await db.execute({
    sql:`UPDATE pair_room_snapshots
      SET revision=revision+1,client_id='retention-scrub',client_seq=revision+1,
        code=?,updated_at=datetime('now')
      WHERE room_id=? AND week_id=? AND pair_group_id=? AND revision=?`,
    args:[JSON.stringify({code:'',board:envelope.board}),identity.roomId,identity.weekId,
      identity.pairGroupId,Number(row.revision)],
  });
  if(Number(updated?.rowsAffected)!==1) throw new CodeDocumentDataError('workspace retention scrub conflicted');
  return true;
}

async function purgeExpiredCodeDocumentIdentity(db,identity){
  const stale=await db.execute({
    sql:`SELECT 1 AS stale FROM pair_code_documents
      WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=?
        AND updated_at < ${RETENTION_CUTOFF_SQL} LIMIT 1`,
    args:[identity.weekId,identity.pairGroupId,identity.questionSlug,identity.questionVersion,identity.language],
  });
  if(!stale?.rows?.length) return false;
  await scrubWorkspaceProjection(db,identity);
  await db.execute({
    sql:`DELETE FROM pair_code_documents
      WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=?
        AND updated_at < ${RETENTION_CUTOFF_SQL}`,
    args:[identity.weekId,identity.pairGroupId,identity.questionSlug,identity.questionVersion,identity.language],
  });
  return true;
}

export async function purgeExpiredCodeDocuments(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const ownsTransaction=typeof db.transaction==='function';
  const transaction=ownsTransaction?await db.transaction('write'):db; let finished=false;
  try{
    const stale=await transaction.execute(`SELECT week_id,pair_group_id,question_slug,question_version,language
      FROM pair_code_documents WHERE updated_at < ${RETENTION_CUTOFF_SQL}
      ORDER BY updated_at,week_id,pair_group_id,question_slug,question_version,language`);
    if(!Array.isArray(stale?.rows)) throw new CodeDocumentDataError('retention query is invalid');
    let purged=0;
    for(const row of stale.rows){
      const identity={
        weekId:positiveSafeInteger(row.week_id),pairGroupId:positiveSafeInteger(row.pair_group_id),
        roomId:`week_${row.week_id}_pair_${row.pair_group_id}`,questionSlug:String(row.question_slug||''),
        questionVersion:positiveSafeInteger(row.question_version),language:String(row.language||''),
      };
      if(!identity.weekId||!identity.pairGroupId||!identity.questionVersion
        ||!QUESTION_SLUG.test(identity.questionSlug)||!LANGUAGES.has(identity.language)){
        throw new CodeDocumentDataError('retention row is invalid');
      }
      if(await purgeExpiredCodeDocumentIdentity(transaction,identity)) purged+=1;
    }
    if(ownsTransaction) await finish(transaction,'commit');
    finished=true;
    return {purged};
  }catch(error){
    if(ownsTransaction&&!finished){ try{ await finish(transaction,'rollback'); }catch{} }
    throw error;
  }
}

async function readUnchangedCodeDocument(db,viewerId,identity,afterRevision){
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const authorization=await authorizedPair(transaction,viewerId,identity);
    if(!authorization){ await finish(transaction,'rollback'); finished=true; return {done:true,result:null}; }
    const row=await readRow(transaction,identity);
    if(!row||Number(row.retention_expired)===1){
      await finish(transaction,'commit'); finished=true; return {done:false};
    }
    const metadata=normalizedMetadata(row,identity);
    const document=metadata.revision===afterRevision
      ?Object.freeze({
        revision:metadata.revision,
        version:codeDocumentVersion({...identity,revision:metadata.revision,stateHash:metadata.stateHash,codeHash:metadata.codeHash}),
        state:null,stateHash:metadata.stateHash,codeHash:metadata.codeHash,code:null,updatedAt:metadata.updatedAt,doc:null,
      })
      :normalizedRow(row,identity);
    await finish(transaction,'commit'); finished=true;
    return {done:true,result:{document,created:false,pair:authorization.pair}};
  }catch(error){
    if(!finished){ try{ await finish(transaction,'rollback'); }catch{} }
    throw error;
  }
}

async function getAuthorizedCodeDocumentUnlocked(db,{viewerId,afterRevision=0,...identity}){
  if(afterRevision>0){
    const unchanged=await readUnchangedCodeDocument(db,viewerId,identity,afterRevision);
    if(unchanged.done) return unchanged.result;
  }
  for(let attempt=0;attempt<MAX_TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction=null;
    let settled=false;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const authorization=await authorizedPair(transaction,viewerId,identity);
      if(!authorization){ await transaction.rollback(); settled=true; return null; }
      await purgeExpiredCodeDocumentIdentity(transaction,identity);
      let row=await readRow(transaction,identity);
      let created=false;
      if(!row){ const result=await createDocument(transaction,viewerId,identity,authorization); row=result.row; created=result.created; }
      const document=normalizedRow(row,identity);
      commitStarted=true; await transaction.commit(); settled=true;
      return {document,created,pair:authorization.pair};
    }catch(error){
      if(transaction&&!settled&&!commitStarted){ try{ await transaction.rollback(); settled=true; }catch{} }
      // Document creation is deterministic and ON CONFLICT-safe, so an
      // ambiguous busy commit can be reconciled by the next exact read.
      if(attempt===MAX_TRANSACTION_ATTEMPTS-1||!retryableConflict(error)) throw error;
      try{ await transaction?.close?.(); }catch{}
      transaction=null;
      await retryDelay(attempt);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  throw new CodeDocumentDataError('code document read contention exceeded its retry bound');
}

export async function getAuthorizedCodeDocument(db,request){
  return withDocumentLock(request,()=>getAuthorizedCodeDocumentUnlocked(db,request));
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>[
      'SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY',
    ].includes(code))) return true;
    const message=String(current.message||'').trim();
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(message)
      ||/^database is busy$/i.test(message)) return true;
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt,seed=''){
  let jitter=0;
  for(const character of String(seed)) jitter=(jitter*33+character.charCodeAt(0))%31;
  return new Promise(resolve=>setTimeout(resolve,Math.min(250,30*(2**attempt)+jitter)));
}

async function mergeAuthorizedCodeDocumentUnlocked(db,{viewerId,...input}){
  for(let attempt=0;attempt<MAX_TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction=null;
    let settled=false;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const authorization=await authorizedPair(transaction,viewerId,input);
      if(!authorization){ await transaction.rollback(); settled=true; return null; }
      await purgeExpiredCodeDocumentIdentity(transaction,input);
      if(await completedPair(transaction,authorization,input)){
        await transaction.rollback(); settled=true;
        return {terminal:true};
      }
      let row=await readRow(transaction,input);
      if(!row) row=(await createDocument(transaction,viewerId,input,authorization,{clientId:input.clientId,clientSeq:input.clientSeq})).row;
      const current=normalizedRow(row,input);
      const doc=current.doc;
      try{ Y.applyUpdate(doc,input.update,'client-update'); }
      catch(error){ throw new CodeDocumentInputError('update is not a valid Yjs update',{cause:error}); }
      const merged=materialize(doc);
      if(merged.stateHash===current.stateHash){
        commitStarted=true; await transaction.commit(); settled=true;
        return {document:current,idempotent:true,pair:authorization.pair};
      }
      const updated=await transaction.execute({
        sql:`WITH access AS (${authorization.accessSql}) UPDATE pair_code_documents
          SET y_state_base64=?,state_hash=?,code_hash=?,revision=revision+1,last_actor_id=?,
            last_actor_source='auth',last_client_id=?,last_client_seq=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=?
            AND revision=? AND state_hash=? AND EXISTS (SELECT 1 FROM access)`,
        args:[...authorization.accessArgs,merged.stateBase64,merged.stateHash,merged.codeHash,viewerId,
          input.clientId,input.clientSeq,input.weekId,input.pairGroupId,input.questionSlug,input.questionVersion,
          input.language,current.revision,current.stateHash],
      });
      if(Number(updated?.rowsAffected)!==1){ await transaction.rollback(); settled=true; continue; }
      await projectWorkspaceCode(transaction,input,authorization,{
        code:merged.code,revision:current.revision+1,viewerId,
      });
      const document=normalizedRow(await readRow(transaction,input),input);
      commitStarted=true; await transaction.commit(); settled=true;
      return {document,idempotent:false,pair:authorization.pair};
    }catch(error){
      if(transaction&&!settled&&!commitStarted){ try{ await transaction.rollback(); settled=true; }catch{} }
      if(attempt===MAX_TRANSACTION_ATTEMPTS-1||!retryableConflict(error)) throw error;
      try{ await transaction?.close?.(); }catch{}
      transaction=null;
      await retryDelay(attempt,input.clientId);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  throw new CodeDocumentDataError('code document merge contention exceeded its retry bound');
}

export async function mergeAuthorizedCodeDocument(db,request){
  return withDocumentLock(request,()=>mergeAuthorizedCodeDocumentUnlocked(db,request));
}

async function withDocumentLock(request,operation){
  const key=JSON.stringify([request.weekId,request.pairGroupId,request.questionSlug,request.questionVersion,request.language]);
  const previous=documentTails.get(key)||Promise.resolve();
  let release;
  const turn=new Promise(resolve=>{ release=resolve; });
  documentTails.set(key,turn);
  await previous.catch(()=>{});
  try{ return await operation(); }
  finally{
    release();
    if(documentTails.get(key)===turn) documentTails.delete(key);
  }
}

async function readCanonicalCodeForExecutionUnlocked(db,{viewerId,room,questionSlug,questionVersion,language,documentVersion}){
  const identity={...room,questionSlug,questionVersion,language};
  for(let attempt=0;attempt<MAX_TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction=null; let settled=false; let commitStarted=false;
    try{
      transaction=await db.transaction('read');
      const authorization=await authorizedPair(transaction,viewerId,identity);
      if(!authorization){ await transaction.rollback(); settled=true; return null; }
      if(!DOCUMENT_VERSION.test(String(documentVersion||''))){
        await transaction.rollback(); settled=true;
        throw new CodeDocumentInputError('valid document_version required');
      }
      if(await completedPair(transaction,authorization,identity)){
        commitStarted=true; await transaction.commit(); settled=true;
        return {eligible:true,terminal:true,pair:authorization.pair};
      }
      const row=await readRow(transaction,identity);
      if(!row||Number(row.retention_expired)===1){
        commitStarted=true; await transaction.commit(); settled=true;
        return {eligible:true,missing:true,latestVersion:null,pair:authorization.pair};
      }
      const document=normalizedRow(row,identity);
      commitStarted=true; await transaction.commit(); settled=true;
      if(document.version!==documentVersion){
        return {eligible:true,stale:true,latestVersion:document.version,document,pair:authorization.pair};
      }
      return {eligible:true,stale:false,latestVersion:document.version,document,pair:authorization.pair};
    }catch(error){
      if(transaction&&!settled&&!commitStarted){ try{ await transaction.rollback(); settled=true; }catch{} }
      if(attempt===MAX_TRANSACTION_ATTEMPTS-1||!retryableConflict(error)) throw error;
      try{ await transaction?.close?.(); }catch{}
      transaction=null;
      await retryDelay(attempt);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  throw new CodeDocumentDataError('code document execution lookup contention exceeded its retry bound');
}

export async function readCanonicalCodeForExecution(db,request){
  return withDocumentLock({...request.room,...request},()=>readCanonicalCodeForExecutionUnlocked(db,request));
}

export async function readCodeProjectionInTransaction(db,{viewerId,room,questionSlug,questionVersion,language}){
  const identity={...room,questionSlug,questionVersion,language};
  try{
    const authorization=await authorizedPair(db,viewerId,identity);
    if(!authorization) return null;
    const row=await readRow(db,identity);
    if(Number(row?.retention_expired)===1){
      const metadata=normalizedMetadata(row,identity);
      return {code:'',revision:metadata.revision,
        version:codeDocumentVersion({...identity,revision:metadata.revision,
          stateHash:metadata.stateHash,codeHash:metadata.codeHash}),
        stateHash:metadata.stateHash,codeHash:metadata.codeHash,expired:true};
    }
    const document=row?normalizedRow(row,identity):null;
    return document?{code:document.code,revision:document.revision,version:document.version,
      stateHash:document.stateHash,codeHash:document.codeHash}:null;
  }catch(error){
    if(/(?:^|:\s*)no such table:\s*pair_code_documents$/i.test(String(error?.message||''))) return null;
    throw error;
  }
}

async function readCodeProjectionForWorkspaceUnlocked(db,request){
  for(let attempt=0;attempt<MAX_TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction=null; let settled=false; let commitStarted=false;
    try{
      transaction=await db.transaction('read');
      const result=await readCodeProjectionInTransaction(transaction,request);
      commitStarted=true; await transaction.commit(); settled=true;
      return result;
    }catch(error){
      if(transaction&&!settled&&!commitStarted){ try{ await transaction.rollback(); settled=true; }catch{} }
      if(attempt===MAX_TRANSACTION_ATTEMPTS-1||!retryableConflict(error)) throw error;
      try{ await transaction?.close?.(); }catch{}
      transaction=null;
      await retryDelay(attempt);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  throw new CodeDocumentDataError('workspace code projection contention exceeded its retry bound');
}

export async function readCodeProjectionForWorkspace(db,request){
  // Board v3 predates v20 and remains the rollback path during a rolling
  // migration. Avoid opening a transaction unless this exact document exists;
  // libSQL in-memory clients may attach transactions to a separate connection,
  // and pre-v20 deployments legitimately have no document table yet.
  try{
    const existing=await db.execute({
      sql:`SELECT 1 AS present FROM pair_code_documents
        WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=? LIMIT 1`,
      args:[request.room.weekId,request.room.pairGroupId,request.questionSlug,
        request.questionVersion,request.language],
    });
    if(!existing?.rows?.length) return null;
  }catch(error){
    if(/(?:^|:\s*)no such table:\s*pair_code_documents$/i.test(String(error?.message||''))) return null;
    throw error;
  }
  return withDocumentLock({...request.room,...request},()=>readCodeProjectionForWorkspaceUnlocked(db,request));
}

export function codeDocumentResponse(result,{afterRevision=0}={}){
  const changed=result.document.revision!==afterRevision;
  return {ok:true,...publicDocument(result.document,{changed,created:result.created===true})};
}
