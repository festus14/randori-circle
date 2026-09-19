import { createHash, randomBytes } from 'node:crypto';

import { validateActiveCircleMutationContext } from './_active-circle.js';
import { MAX_READINESS_SCHEMA_OBJECTS } from './_health.js';
import {
  MAX_SCHEDULE_PROPOSALS,
  nextScheduleUpdatedAt,
  normalizeScheduleInstant,
  ScheduleInputError,
} from './_schedule.js';
import { LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS } from '../db/migration-contract.js';
import {
  assertMigrationLedgerContract,
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from '../db/migration-ledger-readiness.js';
import { inspectSchema, readOnlyDatabase } from '../db/schema-inspector.js';
import { READINESS_SCHEMA_MANIFEST } from '../db/schema-readiness-manifest.js';

const OPAQUE_ID_PATTERN=/^[a-f0-9]{64}$/;
const UUID_V4_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_ATTEMPTS=3;
const SCHEDULE_TABLES=new Set(['circle_pair_schedules','circle_pair_schedule_proposals']);
const SCHEDULE_INDEXES=new Set([
  'uq_circle_pairing_groups_schedule_owner','idx_circle_pair_schedule_proposals_schedule',
]);
const SCHEDULE_MUTATION_FIELDS=Object.freeze({
  propose:Object.freeze(['action','base_version','instant']),
  remove:Object.freeze(['action','base_version','proposal_id']),
  accept:Object.freeze(['action','base_version','proposal_id']),
  clear:Object.freeze(['action','base_version']),
});
const SCHEDULE_READINESS_MANIFEST=Object.freeze({
  version:READINESS_SCHEMA_MANIFEST.version,
  checksum:READINESS_SCHEMA_MANIFEST.checksum,
  artifactScope:'owned',
  tables:READINESS_SCHEMA_MANIFEST.tables.filter(item=>SCHEDULE_TABLES.has(item.name)),
  indexes:READINESS_SCHEMA_MANIFEST.indexes.filter(item=>SCHEDULE_INDEXES.has(item.name)),
  toleratedLegacyTables:[],
});
const __readinessByDatabaseUrl=new Map();
const __readinessByClient=new WeakMap();

export class SecondaryScheduleError extends Error{
  constructor(code,message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='SecondaryScheduleError';
    this.code=code;
  }
}

function fail(code,message,cause){
  throw new SecondaryScheduleError(code,message,cause===undefined?undefined:{cause});
}

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
}

function digest(namespace,value){
  return createHash('sha256').update(`${namespace}\0${value}`,'utf8').digest('hex');
}

export function secondaryScheduleIdentity({generationToken,groupId}={}){
  const group=positiveId(groupId);
  if(typeof generationToken!=='string'||!UUID_V4_PATTERN.test(generationToken)||!group){
    throw new TypeError('valid secondary schedule identity source is required');
  }
  return digest('randori-secondary-schedule-v1',JSON.stringify([generationToken,group]));
}

export function parseSecondaryScheduleMutation(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    throw new ScheduleInputError('request body must be an object');
  }
  const action=body.action;
  const expected=Object.hasOwn(SCHEDULE_MUTATION_FIELDS,action)
    ?SCHEDULE_MUTATION_FIELDS[action]:null;
  if(!expected) throw new ScheduleInputError('unsupported schedule action');
  if(!exactKeys(body,expected)) throw new ScheduleInputError('unexpected or missing schedule fields');
  if(typeof body.base_version!=='string'||!OPAQUE_ID_PATTERN.test(body.base_version)){
    throw new ScheduleInputError('valid base_version required');
  }
  if(action==='propose'){
    const instant=normalizeScheduleInstant(body.instant);
    if(!instant) throw new ScheduleInputError('instant must be strict RFC3339 with an explicit offset');
    return Object.freeze({action,baseVersion:body.base_version,instant});
  }
  if(action==='remove'||action==='accept'){
    if(typeof body.proposal_id!=='string'||!OPAQUE_ID_PATTERN.test(body.proposal_id)){
      throw new ScheduleInputError('valid proposal_id required');
    }
    return Object.freeze({action,baseVersion:body.base_version,proposalId:body.proposal_id});
  }
  return Object.freeze({action,baseVersion:body.base_version});
}

function scheduleVersion(state){
  return digest('randori-secondary-schedule-version-v1',JSON.stringify([
    state.scheduleKey,state.revision,state.agreedTime,state.updatedAt,
    state.proposals.map(item=>[item.proposalId,item.instant,item.proposerSlot]),
  ]));
}

function projectState(state,viewerUserId){
  return Object.freeze({
    version:scheduleVersion(state),
    proposals:Object.freeze(state.proposals.map(item=>Object.freeze({
      proposal_id:item.proposalId,value:item.instant,instant:item.instant,
      proposed_by:item.proposedBy===viewerUserId?'self':'partner',legacy:false,
    }))),
    agreed_time:state.agreedTime,
    legacy_agreed_time:null,
    updated_at:state.updatedAt,
  });
}

function responseEnvelope(scope,schedule){
  return Object.freeze({
    ok:true,
    coordination_only:true,
    workspace_available:false,
    circle_public_id:scope.circlePublicId,
    circle_context_version:scope.contextVersion,
    schedule_id:scope.scheduleKey,
    dashboard_path:'/?view=dashboard',
    schedule,
  });
}

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:__readinessByDatabaseUrl,key:databaseUrl}:{cache:__readinessByClient,key:db};
}

/** Read-only request-path probe. Migration v16 is never created here. */
async function probeSecondaryScheduleReadiness(db){
  if(!db||typeof db.execute!=='function') fail('SECONDARY_SCHEDULE_INPUT_INVALID','A database client is required.');
  try{
    const readOnly=readOnlyDatabase(db);
    const schema=await inspectSchema(readOnly,{
      manifest:SCHEDULE_READINESS_MANIFEST,maxSchemaObjects:MAX_READINESS_SCHEMA_OBJECTS,
    });
    if(!schema.ok||schema.warnings.length!==0||!await migrationLedgerExists(readOnly)){
      fail('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE','Schedule schema is unavailable.');
    }
    await assertMigrationLedgerContract(readOnly);
    const ledger=validateMigrationLedger(await readMigrationLedger(readOnly,{
      limit:MIGRATION_CONTRACTS.length+1,
    }),MIGRATION_CONTRACTS);
    if(ledger.currentVersion!==LATEST_MIGRATION_VERSION||ledger.rows.length!==MIGRATION_CONTRACTS.length){
      fail('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE','Schedule schema is unavailable.');
    }
    return true;
  }catch(error){
    if(error instanceof SecondaryScheduleError) throw error;
    fail('SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE','Schedule schema is unavailable.',error);
  }
}

export async function ensureSecondaryScheduleReadiness(db){
  if(!db||typeof db.execute!=='function') fail('SECONDARY_SCHEDULE_INPUT_INVALID','A database client is required.');
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeSecondaryScheduleReadiness(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){
    if(cache.get(key)===pending) cache.delete(key);
    throw error;
  }
}

function normalizeAuthority(authority){
  const userId=positiveId(authority?.userId);
  const circleId=positiveId(authority?.circleId);
  const contextVersion=Number(authority?.contextVersion);
  if(authority?.kind!=='session'||!authority.payload||!userId||!circleId
    ||!Number.isSafeInteger(contextVersion)||contextVersion<0||typeof authority.implicit!=='boolean'){
    fail('SECONDARY_SCHEDULE_INPUT_INVALID','Schedule authority is invalid.');
  }
  return Object.freeze({
    kind:'session',payload:authority.payload,userId,circleId,contextVersion,implicit:authority.implicit,
  });
}

async function resolveScope(db,authority){
  let valid=false;
  try{
    valid=await validateActiveCircleMutationContext(db,authority.payload,{
      circleId:authority.circleId,contextVersion:authority.contextVersion,implicit:authority.implicit,
    });
  }catch(error){ fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule authorization is unavailable.',error); }
  if(!valid) fail('SECONDARY_SCHEDULE_CONTEXT_CHANGED','The active circle context changed.');
  let result;
  try{
    result=await db.execute({
      sql:`SELECT publication.id AS publication_id,publication.scope_key,publication.circle_id,
          publication.cycle_key,publication.generation_token,circle.public_id AS circle_public_id,
          group_row.id AS group_id,group_row.member_count,group_row.user_a_id,group_row.user_b_id,
          group_row.is_solo
        FROM circle_pairing_publications publication
        JOIN circle_pairing_groups group_row
          ON group_row.publication_id=publication.id AND group_row.scope_key=publication.scope_key
            AND group_row.circle_id=publication.circle_id AND group_row.cycle_key=publication.cycle_key
        JOIN circles circle ON circle.id=publication.circle_id
        JOIN circle_memberships caller
          ON caller.circle_id=circle.id AND caller.user_id=? AND caller.status='active'
        JOIN auth_accounts caller_account ON caller_account.id=caller.user_id
        JOIN circle_memberships member_a
          ON member_a.circle_id=circle.id AND member_a.user_id=group_row.user_a_id
            AND member_a.status='active'
        JOIN auth_accounts account_a ON account_a.id=member_a.user_id
        JOIN circle_memberships member_b
          ON member_b.circle_id=circle.id AND member_b.user_id=group_row.user_b_id
            AND member_b.status='active'
        JOIN auth_accounts account_b ON account_b.id=member_b.user_id
        WHERE publication.circle_id=? AND publication.scope_key=('circle:'||publication.circle_id)
          AND publication.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND publication.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND circle.is_primary=0 AND circle.archived_at IS NULL
          AND group_row.member_count=2 AND group_row.is_solo=0
          AND ? IN (group_row.user_a_id,group_row.user_b_id)
          AND COALESCE(caller_account.is_demo,0)=0
          AND COALESCE(account_a.is_demo,0)=0 AND COALESCE(account_b.is_demo,0)=0
        ORDER BY publication.id,group_row.id LIMIT 2`,
      args:[authority.userId,authority.circleId,authority.userId],
    });
  }catch(error){ fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule assignment is unavailable.',error); }
  if((result.rows?.length||0)!==1) fail('SECONDARY_SCHEDULE_PAIR_UNAVAILABLE','Current paired assignment is unavailable.');
  const row=result.rows[0];
  const scope={
    publicationId:positiveId(row.publication_id),scopeKey:String(row.scope_key||''),
    circleId:positiveId(row.circle_id),cycleKey:String(row.cycle_key||''),
    groupId:positiveId(row.group_id),memberCount:Number(row.member_count),
    userAId:positiveId(row.user_a_id),userBId:positiveId(row.user_b_id),isSolo:Number(row.is_solo),
    circlePublicId:String(row.circle_public_id||''),contextVersion:authority.contextVersion,
  };
  if(!scope.publicationId||scope.scopeKey!==`circle:${authority.circleId}`||scope.circleId!==authority.circleId
    ||!OPAQUE_ID_PATTERN.test(scope.cycleKey)||!scope.groupId||scope.memberCount!==2
    ||!scope.userAId||!scope.userBId||scope.userAId===scope.userBId||scope.isSolo!==0
    ||![scope.userAId,scope.userBId].includes(authority.userId)||!scope.circlePublicId){
    fail('SECONDARY_SCHEDULE_INTEGRITY','Current paired assignment is invalid.');
  }
  scope.scheduleKey=secondaryScheduleIdentity({
    generationToken:String(row.generation_token||''),groupId:scope.groupId,
  });
  return Object.freeze(scope);
}

async function readStoredState(db,scope){
  let result;
  try{
    result=await db.batch([{
      sql:`SELECT id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
          member_count,user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at
        FROM circle_pair_schedules
        WHERE publication_id=? AND group_id=? LIMIT 2`,
      args:[scope.publicationId,scope.groupId],
    },{
      sql:`SELECT proposal.id,proposal.schedule_id,proposal.schedule_key,proposal.publication_id,
          proposal.scope_key,proposal.circle_id,proposal.cycle_key,proposal.group_id,
          proposal.member_count,proposal.user_a_id,proposal.user_b_id,proposal.is_solo,
          proposal.proposal_key,proposal.instant,proposal.proposed_by,proposal.created_at
        FROM circle_pair_schedule_proposals proposal
        JOIN circle_pair_schedules schedule
          ON schedule.id=proposal.schedule_id AND schedule.schedule_key=proposal.schedule_key
            AND schedule.publication_id=proposal.publication_id AND schedule.scope_key=proposal.scope_key
            AND schedule.circle_id=proposal.circle_id AND schedule.cycle_key=proposal.cycle_key
            AND schedule.group_id=proposal.group_id AND schedule.member_count=proposal.member_count
            AND schedule.user_a_id=proposal.user_a_id AND schedule.user_b_id=proposal.user_b_id
            AND schedule.is_solo=proposal.is_solo
        WHERE schedule.publication_id=? AND schedule.group_id=?
        ORDER BY proposal.created_at,proposal.id`,
      args:[scope.publicationId,scope.groupId],
    }],'read');
  }catch(error){ fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule data is unavailable.',error); }
  const schedules=result?.[0]?.rows||[];
  const rows=result?.[1]?.rows||[];
  if(!schedules.length){
    if(rows.length) fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule data is invalid.');
    return Object.freeze({
      exists:false,scheduleId:null,scheduleKey:scope.scheduleKey,revision:0,
      agreedTime:null,updatedAt:null,proposals:Object.freeze([]),
    });
  }
  if(schedules.length!==1||rows.length>MAX_SCHEDULE_PROPOSALS){
    fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule data is invalid.');
  }
  const schedule=schedules[0];
  const scheduleId=positiveId(schedule.id);
  const revision=Number(schedule.revision);
  const agreedTime=schedule.agreed_time==null?null:normalizeScheduleInstant(String(schedule.agreed_time));
  if(!scheduleId||String(schedule.schedule_key)!==scope.scheduleKey
    ||Number(schedule.publication_id)!==scope.publicationId||String(schedule.scope_key)!==scope.scopeKey
    ||Number(schedule.circle_id)!==scope.circleId||String(schedule.cycle_key)!==scope.cycleKey
    ||Number(schedule.group_id)!==scope.groupId||Number(schedule.member_count)!==scope.memberCount
    ||Number(schedule.user_a_id)!==scope.userAId||Number(schedule.user_b_id)!==scope.userBId
    ||Number(schedule.is_solo)!==0||!Number.isSafeInteger(revision)||revision<1
    ||(schedule.agreed_time!=null&&agreedTime!==String(schedule.agreed_time))){
    fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule data is invalid.');
  }
  const proposalIds=new Set();
  const instants=new Set();
  const proposals=rows.map(row=>{
    const proposalId=String(row.proposal_key||'');
    const instant=normalizeScheduleInstant(String(row.instant||''));
    const proposedBy=positiveId(row.proposed_by);
    if(Number(row.schedule_id)!==scheduleId||String(row.schedule_key)!==scope.scheduleKey
      ||Number(row.publication_id)!==scope.publicationId||String(row.scope_key)!==scope.scopeKey
      ||Number(row.circle_id)!==scope.circleId||String(row.cycle_key)!==scope.cycleKey
      ||Number(row.group_id)!==scope.groupId||Number(row.member_count)!==scope.memberCount
      ||Number(row.user_a_id)!==scope.userAId||Number(row.user_b_id)!==scope.userBId
      ||Number(row.is_solo)!==0||!OPAQUE_ID_PATTERN.test(proposalId)||proposalIds.has(proposalId)
      ||!instant||instant!==String(row.instant)||instants.has(instant)
      ||![scope.userAId,scope.userBId].includes(proposedBy)){
      fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule data is invalid.');
    }
    proposalIds.add(proposalId); instants.add(instant);
    return Object.freeze({
      proposalId,instant,proposedBy,proposerSlot:proposedBy===scope.userAId?'a':'b',
    });
  });
  return Object.freeze({
    exists:true,scheduleId,scheduleKey:scope.scheduleKey,revision,agreedTime,
    updatedAt:String(schedule.updated_at||''),proposals:Object.freeze(proposals),
  });
}

function nextMutation(state,mutation,userId,scope){
  const proposals=[...state.proposals];
  let agreedTime=state.agreedTime;
  if(mutation.action==='propose'){
    if(proposals.length>=MAX_SCHEDULE_PROPOSALS){
      throw new ScheduleInputError('schedule has the maximum 12 proposals');
    }
    if(proposals.some(item=>item.instant===mutation.instant)){
      throw new ScheduleInputError('that instant is already proposed');
    }
    proposals.push(Object.freeze({
      proposalId:randomBytes(32).toString('hex'),instant:mutation.instant,proposedBy:userId,
      proposerSlot:userId===scope.userAId?'a':'b',
    }));
  }else if(mutation.action==='remove'||mutation.action==='accept'){
    const index=proposals.findIndex(item=>item.proposalId===mutation.proposalId);
    if(index<0) throw new ScheduleInputError('proposal not found');
    if(mutation.action==='remove') proposals.splice(index,1);
    else agreedTime=proposals[index].instant;
  }else if(mutation.action==='clear') agreedTime=null;
  else throw new ScheduleInputError('unsupported schedule action');
  return {proposals,agreedTime};
}

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>code==='5'||code==='6'||code==='SQLITE_BUSY'
      ||code==='SQLITE_BUSY_SNAPSHOT'||code==='SQLITE_LOCKED')) return true;
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(25,attempt*5)));
}

async function readWithinTransaction(transaction,authority){
  const scope=await resolveScope(transaction,authority);
  const state=await readStoredState(transaction,scope);
  return {scope,state};
}

export async function readSecondarySchedule(db,{authority}={}){
  if(!db||typeof db.transaction!=='function') fail('SECONDARY_SCHEDULE_INPUT_INVALID','A transactional database client is required.');
  const safeAuthority=normalizeAuthority(authority);
  await ensureSecondaryScheduleReadiness(db);
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const {scope,state}=await readWithinTransaction(transaction,safeAuthority);
    await transaction.commit(); finished=true;
    return responseEnvelope(scope,projectState(state,safeAuthority.userId));
  }catch(error){
    if(!finished) await rollback(transaction);
    if(error instanceof SecondaryScheduleError) throw error;
    fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule is unavailable.',error);
  }finally{ try{ await transaction.close?.(); }catch{} }
}

export async function mutateSecondarySchedule(db,{authority,mutation}={}){
  if(!db||typeof db.transaction!=='function') fail('SECONDARY_SCHEDULE_INPUT_INVALID','A transactional database client is required.');
  const safeAuthority=normalizeAuthority(authority);
  await ensureSecondaryScheduleReadiness(db);
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction;
    let finished=false;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const {scope,state}=await readWithinTransaction(transaction,safeAuthority);
      if(mutation.baseVersion!==scheduleVersion(state)){
        await rollback(transaction); finished=true;
        return Object.freeze({conflict:true,response:responseEnvelope(scope,projectState(state,safeAuthority.userId))});
      }
      const next=nextMutation(state,mutation,safeAuthority.userId,scope);
      const updatedAt=nextScheduleUpdatedAt(state.updatedAt);
      let scheduleId=state.scheduleId;
      if(state.exists){
        const updated=await transaction.execute({
          sql:`UPDATE circle_pair_schedules SET revision=revision+1,agreed_time=?,updated_at=?
            WHERE id=? AND schedule_key=? AND publication_id=? AND scope_key=? AND circle_id=?
              AND cycle_key=? AND group_id=? AND revision=?
            RETURNING id,revision`,
          args:[next.agreedTime,updatedAt,state.scheduleId,scope.scheduleKey,scope.publicationId,
            scope.scopeKey,scope.circleId,scope.cycleKey,scope.groupId,state.revision],
        });
        if(updated.rows?.length!==1){
          await rollback(transaction); finished=true;
          const latest=await readSecondarySchedule(db,{authority:safeAuthority});
          return Object.freeze({conflict:true,response:latest});
        }
      }else{
        const inserted=await transaction.execute({
          sql:`INSERT INTO circle_pair_schedules
              (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
               user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)
            ON CONFLICT(publication_id,group_id) DO NOTHING RETURNING id,revision`,
          args:[scope.scheduleKey,scope.publicationId,scope.scopeKey,scope.circleId,scope.cycleKey,
            scope.groupId,scope.memberCount,scope.userAId,scope.userBId,scope.isSolo,
            next.agreedTime,updatedAt,updatedAt],
        });
        if(inserted.rows?.length!==1){
          await rollback(transaction); finished=true;
          const latest=await readSecondarySchedule(db,{authority:safeAuthority});
          return Object.freeze({conflict:true,response:latest});
        }
        scheduleId=positiveId(inserted.rows[0].id);
        if(!scheduleId) fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule write is invalid.');
      }

      if(mutation.action==='propose'){
        const proposal=next.proposals.at(-1);
        const inserted=await transaction.execute({
          sql:`INSERT INTO circle_pair_schedule_proposals
              (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
               member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
          args:[scheduleId,scope.scheduleKey,scope.publicationId,scope.scopeKey,scope.circleId,
            scope.cycleKey,scope.groupId,scope.memberCount,scope.userAId,scope.userBId,scope.isSolo,
            proposal.proposalId,proposal.instant,proposal.proposedBy,updatedAt],
        });
        if(inserted.rows?.length!==1) fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule proposal write is invalid.');
      }else if(mutation.action==='remove'){
        const removed=await transaction.execute({
          sql:`DELETE FROM circle_pair_schedule_proposals
            WHERE schedule_id=? AND schedule_key=? AND proposal_key=? RETURNING id`,
          args:[scheduleId,scope.scheduleKey,mutation.proposalId],
        });
        if(removed.rows?.length!==1) fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule proposal write is invalid.');
      }
      const stored=await readStoredState(transaction,scope);
      if(stored.revision!==state.revision+1) fail('SECONDARY_SCHEDULE_INTEGRITY','Schedule revision is invalid.');
      commitStarted=true;
      await transaction.commit(); finished=true;
      return Object.freeze({conflict:false,response:responseEnvelope(scope,projectState(stored,safeAuthority.userId))});
    }catch(error){
      if(transaction&&!finished) await rollback(transaction);
      if(!commitStarted&&attempt<TRANSACTION_ATTEMPTS&&retryableConflict(error)){
        await retryDelay(attempt);
        continue;
      }
      if(error instanceof SecondaryScheduleError||error instanceof ScheduleInputError) throw error;
      fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule update is unavailable.',error);
    }finally{ try{ await transaction?.close?.(); }catch{} }
  }
  fail('SECONDARY_SCHEDULE_UNAVAILABLE','Schedule update is unavailable.');
}

export function secondaryScheduleFailure(error,{contextVersion}={}){
  const context=contextVersion===undefined?{}:{circle_context_version:contextVersion};
  if(error instanceof ScheduleInputError){
    return {status:400,body:{ok:false,error:error.message,...context}};
  }
  const code=error instanceof SecondaryScheduleError?error.code:'SECONDARY_SCHEDULE_UNAVAILABLE';
  if(code==='SECONDARY_SCHEDULE_CONTEXT_CHANGED'){
    return {status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'}};
  }
  if(code==='SECONDARY_SCHEDULE_PAIR_UNAVAILABLE'){
    return {status:404,body:{ok:false,error:'current paired assignment unavailable',...context}};
  }
  return {status:503,body:{ok:false,error:'schedule unavailable',...context}};
}
