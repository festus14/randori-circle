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

function materialize(doc){
  const code=doc.getText('code').toString();
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
  const materialized=materialize(doc);
  if(materialized.codeHash!==String(row.code_hash||'')){
    throw new CodeDocumentDataError('stored code hash is invalid');
  }
  return {doc,materialized};
}

function normalizedRow(row,identity){
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
  const decoded=decodeStoredState(row);
  const version=codeDocumentVersion({...identity,revision,stateHash:decoded.materialized.stateHash,codeHash:decoded.materialized.codeHash});
  return Object.freeze({
    revision,version,state:decoded.materialized.stateBase64,stateHash:decoded.materialized.stateHash,
    codeHash:decoded.materialized.codeHash,code:decoded.materialized.code,
    updatedAt:String(row.updated_at||''),doc:decoded.doc,
  });
}

const DOCUMENT_COLUMNS=`week_id,pair_group_id,question_slug,question_version,language,
  y_state_base64,state_hash,code_hash,revision,pair_user_a_id,pair_user_a_source,
  pair_user_b_id,pair_user_b_source,pair_user_c_id,last_actor_id,last_actor_source,
  last_client_id,last_client_seq,created_at,updated_at`;

async function readRow(db,identity){
  const result=await db.execute({
    sql:`SELECT ${DOCUMENT_COLUMNS} FROM pair_code_documents
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
      ON CONFLICT DO NOTHING RETURNING ${DOCUMENT_COLUMNS}`,
    args:[...authorization.accessArgs,identity.weekId,identity.pairGroupId,identity.questionSlug,
      identity.questionVersion,identity.language,state.stateBase64,state.stateHash,state.codeHash,1,
      authorization.pair.userAId,authorization.pair.userBId,viewerId,clientId,clientSeq],
  });
  return {row:inserted?.rows?.[0]||await readRow(db,identity),created:!!inserted?.rows?.length};
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
        AND EXISTS (SELECT 1 FROM access) RETURNING revision`,
    args:[...authorization.accessArgs,revision,serialized,viewerId,identity.roomId,identity.weekId,
      identity.pairGroupId,Number(row.revision)],
  });
  return !!projected?.rows?.length;
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

export async function purgeExpiredCodeDocuments(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const cutoff=`strftime('%Y-%m-%dT%H:%M:%fZ','now','-${CODE_DOCUMENT_RETENTION_DAYS} days')`;
  // The v3 envelope contains a rollback projection of the same private code.
  // Remove it first so expiry cannot resurrect text through a later bootstrap.
  await db.execute(`DELETE FROM pair_room_snapshots
    WHERE EXISTS (SELECT 1 FROM pair_code_documents document
      WHERE document.week_id=pair_room_snapshots.week_id
        AND document.pair_group_id=pair_room_snapshots.pair_group_id
        AND document.updated_at < ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM pair_code_documents active_document
        WHERE active_document.week_id=pair_room_snapshots.week_id
          AND active_document.pair_group_id=pair_room_snapshots.pair_group_id
          AND active_document.updated_at >= ${cutoff})`);
  return db.execute(`DELETE FROM pair_code_documents
    WHERE updated_at < ${cutoff}
       OR NOT EXISTS (SELECT 1 FROM pairing_groups pg
         WHERE pg.id=pair_code_documents.pair_group_id AND pg.week_id=pair_code_documents.week_id)`);
}

export async function getAuthorizedCodeDocument(db,{viewerId,...identity}){
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const authorization=await authorizedPair(transaction,viewerId,identity);
    if(!authorization){ await finish(transaction,'rollback'); finished=true; return null; }
    await purgeExpiredCodeDocuments(transaction);
    let row=await readRow(transaction,identity);
    let created=false;
    if(!row){ const result=await createDocument(transaction,viewerId,identity,authorization); row=result.row; created=result.created; }
    const document=normalizedRow(row,identity);
    await finish(transaction,'commit'); finished=true;
    return {document,created,pair:authorization.pair};
  }catch(error){
    if(!finished){ try{ await finish(transaction,'rollback'); }catch{} }
    throw error;
  }
}

export async function mergeAuthorizedCodeDocument(db,{viewerId,...input}){
  for(let attempt=0;attempt<MAX_TRANSACTION_ATTEMPTS;attempt+=1){
    const transaction=await db.transaction('write');
    let finished=false;
    try{
      const authorization=await authorizedPair(transaction,viewerId,input);
      if(!authorization){ await finish(transaction,'rollback'); finished=true; return null; }
      if(await completedPair(transaction,authorization,input)){
        await finish(transaction,'rollback'); finished=true;
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
        await finish(transaction,'commit'); finished=true;
        return {document:current,idempotent:true,pair:authorization.pair};
      }
      const updated=await transaction.execute({
        sql:`WITH access AS (${authorization.accessSql}) UPDATE pair_code_documents
          SET y_state_base64=?,state_hash=?,code_hash=?,revision=revision+1,last_actor_id=?,
            last_actor_source='auth',last_client_id=?,last_client_seq=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE week_id=? AND pair_group_id=? AND question_slug=? AND question_version=? AND language=?
            AND revision=? AND state_hash=? AND EXISTS (SELECT 1 FROM access)
          RETURNING ${DOCUMENT_COLUMNS}`,
        args:[...authorization.accessArgs,merged.stateBase64,merged.stateHash,merged.codeHash,viewerId,
          input.clientId,input.clientSeq,input.weekId,input.pairGroupId,input.questionSlug,input.questionVersion,
          input.language,current.revision,current.stateHash],
      });
      if(!updated?.rows?.length){ await finish(transaction,'rollback'); finished=true; continue; }
      await projectWorkspaceCode(transaction,input,authorization,{
        code:merged.code,revision:current.revision+1,viewerId,
      });
      const document=normalizedRow(updated.rows[0],input);
      await finish(transaction,'commit'); finished=true;
      return {document,idempotent:false,pair:authorization.pair};
    }catch(error){
      if(!finished){ try{ await finish(transaction,'rollback'); }catch{} }
      throw error;
    }
  }
  throw new CodeDocumentDataError('code document merge contention exceeded its retry bound');
}

export async function readCanonicalCodeForExecution(db,{viewerId,room,questionSlug,questionVersion,language,documentVersion}){
  const identity={...room,questionSlug,questionVersion,language};
  const authorization=await authorizedPair(db,viewerId,identity);
  if(!authorization) return null;
  if(!DOCUMENT_VERSION.test(String(documentVersion||''))){
    throw new CodeDocumentInputError('valid document_version required');
  }
  if(await completedPair(db,authorization,identity)) return {eligible:true,terminal:true,pair:authorization.pair};
  const row=await readRow(db,identity);
  if(!row) return {eligible:true,missing:true,latestVersion:null,pair:authorization.pair};
  const document=normalizedRow(row,identity);
  if(document.version!==documentVersion){
    return {eligible:true,stale:true,latestVersion:document.version,document,pair:authorization.pair};
  }
  return {eligible:true,stale:false,latestVersion:document.version,document,pair:authorization.pair};
}

export async function readCodeProjectionForWorkspace(db,{viewerId,room,questionSlug,questionVersion,language}){
  const identity={...room,questionSlug,questionVersion,language};
  const authorization=await authorizedPair(db,viewerId,identity);
  if(!authorization) return null;
  const row=await readRow(db,identity);
  if(!row) return null;
  const document=normalizedRow(row,identity);
  return {code:document.code,revision:document.revision,version:document.version};
}

export function codeDocumentResponse(result,{afterRevision=0}={}){
  const changed=result.document.revision>afterRevision;
  return {ok:true,...publicDocument(result.document,{changed,created:result.created===true})};
}
