import { randomUUID } from 'node:crypto';

import { validateActiveCircleMutationContext } from './_active-circle.js';
import { applyCycleAvailability, availabilityCycleKey } from './_availability.js';
import { buildFairPairing, PAIRING_ALGORITHM_VERSION } from './_pairing.js';
import { resolvePairingCycle } from './_pairing-cycle.js';

const TRANSACTION_ATTEMPTS=4;
const CYCLE_KEY_PATTERN=/^[0-9a-f]{64}$/;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_INSTANT_PATTERN=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const readinessByClient=new WeakMap();

const TABLE_COLUMNS=Object.freeze({
  circle_pairing_publications:Object.freeze([
    ['id','INTEGER',0,1],['scope_key','TEXT',1,0],['circle_id','INTEGER',1,0],
    ['cycle_key','TEXT',1,0],['cycle_id','TEXT',1,0],['starts_at','TEXT',1,0],
    ['ends_at','TEXT',1,0],['cutoff_at','TEXT',1,0],['time_zone','TEXT',1,0],
    ['generation_token','TEXT',1,0],['algorithm_version','TEXT',1,0],
    ['algorithm_seed','TEXT',1,0],['participant_count','INTEGER',1,0],
    ['created_at','TEXT',1,0],
  ]),
  circle_pairing_eligibility:Object.freeze([
    ['publication_id','INTEGER',1,1],['scope_key','TEXT',1,0],['circle_id','INTEGER',1,0],
    ['cycle_key','TEXT',1,0],['user_id','INTEGER',1,2],['is_available','INTEGER',1,0],
    ['availability_version','INTEGER',1,0],['availability_source','TEXT',1,0],
    ['position','INTEGER',1,0],['created_at','TEXT',1,0],
  ]),
  circle_pairing_groups:Object.freeze([
    ['id','INTEGER',0,1],['publication_id','INTEGER',1,0],['scope_key','TEXT',1,0],
    ['circle_id','INTEGER',1,0],['cycle_key','TEXT',1,0],['position','INTEGER',1,0],
    ['user_a_id','INTEGER',1,0],['user_b_id','INTEGER',0,0],['is_solo','INTEGER',1,0],
    ['created_at','TEXT',1,0],
  ]),
});

const INDEX_COLUMNS=Object.freeze({
  idx_circle_pairing_publications_circle_cycle:Object.freeze(['circle_id','starts_at','id']),
  idx_circle_pairing_eligibility_scope_user:Object.freeze(['scope_key','user_id','publication_id']),
  idx_circle_pairing_groups_user_a:Object.freeze(['publication_id','user_a_id']),
  idx_circle_pairing_groups_user_b:Object.freeze(['publication_id','user_b_id']),
});

export const SECONDARY_PAIRING_CACHE_CONTROL='private, no-store';
export const SECONDARY_PAIRING_CRON_LIMIT=25;

export class CirclePairingError extends Error{
  constructor(code,message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='CirclePairingError';
    this.code=code;
  }
}

function fail(code,message,cause){
  throw new CirclePairingError(code,message,cause===undefined?undefined:{cause});
}

function positiveId(value){
  const id=Number(value);
  if(!Number.isSafeInteger(id)||id<1) fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing input is invalid.');
  return id;
}

function scopeForCircle(circleId){
  const id=positiveId(circleId);
  return Object.freeze({kind:'circle',scopeKey:`circle:${id}`,circleId:id});
}

function columnsMatch(rows,expected){
  return rows.length===expected.length&&expected.every((item,index)=>{
    const row=rows[index];
    return String(row?.name)===item[0]&&String(row?.type).toUpperCase()===item[1]
      &&Number(row?.notnull)===item[2]&&Number(row?.pk)===item[3];
  });
}

/** Read-only request-path readiness. Migration v13 is never created here. */
export async function ensureCirclePairingReadiness(db){
  if(!db||typeof db.execute!=='function') fail('CIRCLE_PAIRING_INPUT_INVALID','A database client is required.');
  const cached=readinessByClient.get(db);
  if(cached) return cached;
  const pending=(async()=>{
    try{
      for(const [table,expected] of Object.entries(TABLE_COLUMNS)){
        await db.execute(`SELECT * FROM ${table} LIMIT 0`);
        const info=await db.execute(`PRAGMA table_info('${table}')`);
        if(!columnsMatch(info.rows||[],expected)) fail('CIRCLE_PAIRING_SCHEMA_UNAVAILABLE','Pairing schema is unavailable.');
      }
      for(const [name,expected] of Object.entries(INDEX_COLUMNS)){
        const info=await db.execute(`PRAGMA index_info('${name}')`);
        const columns=[...(info.rows||[])].sort((a,b)=>Number(a.seqno)-Number(b.seqno)).map(row=>String(row.name));
        if(JSON.stringify(columns)!==JSON.stringify(expected)){
          fail('CIRCLE_PAIRING_SCHEMA_UNAVAILABLE','Pairing schema is unavailable.');
        }
      }
      return true;
    }catch(error){
      if(error instanceof CirclePairingError) throw error;
      fail('CIRCLE_PAIRING_SCHEMA_UNAVAILABLE','Pairing schema is unavailable.',error);
    }
  })();
  readinessByClient.set(db,pending);
  try{ return await pending; }
  catch(error){ readinessByClient.delete(db); throw error; }
}

async function databaseNow(db,provided){
  if(provided!==undefined){
    const value=typeof provided==='function'?await provided(db):provided;
    const instant=value instanceof Date?new Date(value.getTime()):new Date(value);
    if(!Number.isFinite(instant.getTime())) fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing time is invalid.');
    return instant;
  }
  let result;
  try{ result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`); }
  catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing time is unavailable.',error); }
  const raw=result.rows?.[0]?.now_utc;
  const instant=new Date(raw);
  if(!raw||!Number.isFinite(instant.getTime())) fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing time is unavailable.');
  return instant;
}

function currentCycle(now,timeZone){
  try{ return resolvePairingCycle({now,timeZone,state:'current'}); }
  catch(error){ fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing cycle is invalid.',error); }
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>[
      'SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY',
    ].includes(code))) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message||'').trim())
      ||/^database is busy$/i.test(String(current.message||'').trim())) return true;
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1)))));
}

function normalizeSessionAuthority(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.kind!=='session'
    ||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)
    ||typeof value.implicit!=='boolean'){
    fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing authority is invalid.');
  }
  const circleId=positiveId(value.circleId);
  const userId=positiveId(value.userId);
  const contextVersion=Number(value.contextVersion);
  if(!Number.isSafeInteger(contextVersion)||contextVersion<0
    ||Number(value.payload.id??value.payload.uid)!==userId){
    fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing authority is invalid.');
  }
  return Object.freeze({
    kind:'session',payload:value.payload,userId,circleId,contextVersion,
    implicit:value.implicit,requireOwner:value.requireOwner===true,
  });
}

function normalizeSystemAuthority(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.kind!=='system'){
    fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing authority is invalid.');
  }
  return Object.freeze({kind:'system',circleId:positiveId(value.circleId)});
}

async function assertAuthority(db,authority){
  if(authority.kind==='session'){
    let valid=false;
    try{
      valid=await validateActiveCircleMutationContext(db,authority.payload,{
        circleId:authority.circleId,contextVersion:authority.contextVersion,implicit:authority.implicit,
      });
    }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing authorization is unavailable.',error); }
    if(!valid) fail('CIRCLE_PAIRING_CONTEXT_CHANGED','The active circle context changed.');
    let result;
    try{
      result=await db.execute({
        sql:`SELECT membership.role,circle.public_id
          FROM circle_memberships membership
          JOIN circles circle ON circle.id=membership.circle_id
          JOIN auth_accounts account ON account.id=membership.user_id
          WHERE membership.circle_id=? AND membership.user_id=?
            AND membership.status='active' AND circle.is_primary=0 AND circle.archived_at IS NULL
            AND COALESCE(account.is_demo,0)=0 LIMIT 2`,
        args:[authority.circleId,authority.userId],
      });
    }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing authorization is unavailable.',error); }
    if(result.rows?.length!==1) fail('CIRCLE_PAIRING_FORBIDDEN','Active circle membership is required.');
    if(authority.requireOwner&&String(result.rows[0].role)!=='owner'){
      fail('CIRCLE_PAIRING_OWNER_REQUIRED','Circle owner permission is required.');
    }
    return String(result.rows[0].public_id||'');
  }
  let result;
  try{
    result=await db.execute({
      sql:`SELECT circle.public_id
        FROM circles circle
        WHERE circle.id=? AND circle.is_primary=0 AND circle.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM circle_memberships owner
            JOIN auth_accounts account ON account.id=owner.user_id
            WHERE owner.circle_id=circle.id AND owner.status='active' AND owner.role='owner'
              AND COALESCE(account.is_demo,0)=0)
        LIMIT 2`,
      args:[authority.circleId],
    });
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing authorization is unavailable.',error); }
  if(result.rows?.length!==1) fail('CIRCLE_PAIRING_FORBIDDEN','Active circle membership is required.');
  return String(result.rows[0].public_id||'');
}

async function circleAccounts(db,circleId){
  let result;
  try{
    result=await db.execute({
      sql:`SELECT account.id
        FROM circle_memberships membership
        JOIN auth_accounts account ON account.id=membership.user_id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.circle_id=? AND membership.status='active'
          AND circle.is_primary=0 AND circle.archived_at IS NULL
          AND COALESCE(account.is_demo,0)=0
        ORDER BY account.id`,
      args:[circleId],
    });
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing eligibility is unavailable.',error); }
  const seen=new Set();
  const accounts=[];
  for(const row of result.rows||[]){
    const id=positiveId(row.id);
    if(seen.has(id)) fail('CIRCLE_PAIRING_INTEGRITY','Pairing eligibility is invalid.');
    seen.add(id);
    accounts.push(Object.freeze({id}));
  }
  return Object.freeze(accounts);
}

async function circleHistory(db,{scopeKey,cycleKey}){
  try{
    const result=await db.execute({
      sql:`SELECT group_row.user_a_id,COALESCE(group_row.user_b_id,group_row.user_a_id) AS user_b_id,
          group_row.is_solo,publication.id AS week_id
        FROM circle_pairing_groups group_row
        JOIN circle_pairing_publications publication
          ON publication.id=group_row.publication_id AND publication.scope_key=group_row.scope_key
            AND publication.circle_id=group_row.circle_id AND publication.cycle_key=group_row.cycle_key
        JOIN circle_pairing_eligibility eligible_a
          ON eligible_a.publication_id=group_row.publication_id AND eligible_a.scope_key=group_row.scope_key
            AND eligible_a.circle_id=group_row.circle_id AND eligible_a.cycle_key=group_row.cycle_key
            AND eligible_a.user_id=group_row.user_a_id AND eligible_a.is_available=1
        LEFT JOIN circle_pairing_eligibility eligible_b
          ON eligible_b.publication_id=group_row.publication_id AND eligible_b.scope_key=group_row.scope_key
            AND eligible_b.circle_id=group_row.circle_id AND eligible_b.cycle_key=group_row.cycle_key
            AND eligible_b.user_id=group_row.user_b_id AND eligible_b.is_available=1
        WHERE publication.scope_key=? AND publication.cycle_key<>?
          AND (group_row.user_b_id IS NULL OR eligible_b.user_id IS NOT NULL)
        ORDER BY publication.starts_at DESC,publication.id DESC,group_row.position ASC LIMIT 1000`,
      args:[scopeKey,cycleKey],
    });
    return (result.rows||[]).map(row=>({...row,is_ai_pair:Number(row.is_solo)===1?1:0}));
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing history is unavailable.',error); }
}

async function readStoredPublication(db,{scope,cycle}){
  let result;
  try{
    result=await db.batch([{
      sql:`SELECT id,scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
          generation_token,algorithm_version,algorithm_seed,participant_count,created_at
        FROM circle_pairing_publications WHERE scope_key=? AND cycle_key=?`,
      args:[scope.scopeKey,cycle.cycleKey],
    },{
      sql:`SELECT eligibility.publication_id,eligibility.scope_key,eligibility.circle_id,
          eligibility.cycle_key,eligibility.user_id,eligibility.is_available,
          eligibility.availability_version,eligibility.availability_source,eligibility.position
        FROM circle_pairing_eligibility eligibility
        JOIN circle_pairing_publications publication
          ON publication.id=eligibility.publication_id AND publication.scope_key=eligibility.scope_key
            AND publication.circle_id=eligibility.circle_id AND publication.cycle_key=eligibility.cycle_key
        WHERE publication.scope_key=? AND publication.cycle_key=?
        ORDER BY eligibility.position,eligibility.user_id`,
      args:[scope.scopeKey,cycle.cycleKey],
    },{
      sql:`SELECT group_row.id,group_row.publication_id,group_row.scope_key,group_row.circle_id,
          group_row.cycle_key,group_row.position,group_row.user_a_id,group_row.user_b_id,group_row.is_solo
        FROM circle_pairing_groups group_row
        JOIN circle_pairing_publications publication
          ON publication.id=group_row.publication_id AND publication.scope_key=group_row.scope_key
            AND publication.circle_id=group_row.circle_id AND publication.cycle_key=group_row.cycle_key
        JOIN circle_pairing_eligibility eligible_a
          ON eligible_a.publication_id=group_row.publication_id AND eligible_a.scope_key=group_row.scope_key
            AND eligible_a.circle_id=group_row.circle_id AND eligible_a.cycle_key=group_row.cycle_key
            AND eligible_a.user_id=group_row.user_a_id
        LEFT JOIN circle_pairing_eligibility eligible_b
          ON eligible_b.publication_id=group_row.publication_id AND eligible_b.scope_key=group_row.scope_key
            AND eligible_b.circle_id=group_row.circle_id AND eligible_b.cycle_key=group_row.cycle_key
            AND eligible_b.user_id=group_row.user_b_id
        WHERE publication.scope_key=? AND publication.cycle_key=?
          AND (group_row.user_b_id IS NULL OR eligible_b.user_id IS NOT NULL)
        ORDER BY group_row.position,group_row.id`,
      args:[scope.scopeKey,cycle.cycleKey],
    }],'read');
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication is unavailable.',error); }
  const publications=result[0]?.rows||[];
  if(!publications.length){
    if((result[1]?.rows||[]).length||(result[2]?.rows||[]).length){
      fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
    }
    return null;
  }
  if(publications.length!==1) fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
  const row=publications[0];
  const publicationId=positiveId(row.id);
  const participantCount=Number(row.participant_count);
  const eligibility=result[1]?.rows||[];
  const groups=result[2]?.rows||[];
  if(String(row.scope_key)!==scope.scopeKey||Number(row.circle_id)!==scope.circleId
    ||String(row.cycle_key)!==cycle.cycleKey||String(row.cycle_id)!==cycle.cycleId
    ||String(row.starts_at)!==cycle.startsAt||String(row.ends_at)!==cycle.endsAt
    ||String(row.cutoff_at)!==cycle.cutoffAt||String(row.time_zone)!==cycle.timeZone
    ||!CYCLE_KEY_PATTERN.test(String(row.cycle_key))
    ||!UUID_PATTERN.test(String(row.generation_token))
    ||String(row.algorithm_version)!==PAIRING_ALGORITHM_VERSION
    ||String(row.algorithm_seed)!==`${scope.scopeKey}:${cycle.cycleKey}:weekly`
    ||!ISO_INSTANT_PATTERN.test(String(row.created_at))
    ||!Number.isSafeInteger(participantCount)||participantCount<0
    ||eligibility.length!==participantCount||groups.length!==Math.ceil(eligibility.filter(item=>Number(item.is_available)===1).length/2)){
    fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
  }
  const eligibleIds=new Set();
  const availableIds=new Set();
  const positions=new Set();
  for(const item of eligibility){
    const userId=positiveId(item.user_id);
    const position=Number(item.position);
    const available=Number(item.is_available);
    const version=Number(item.availability_version);
    if(Number(item.publication_id)!==publicationId||String(item.scope_key)!==scope.scopeKey
      ||Number(item.circle_id)!==scope.circleId||String(item.cycle_key)!==cycle.cycleKey
      ||eligibleIds.has(userId)||!Number.isSafeInteger(position)||position<0||position>=participantCount||positions.has(position)
      ||![0,1].includes(available)||!Number.isSafeInteger(version)||version<0
      ||!['user','cycle_default'].includes(String(item.availability_source))){
      fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
    }
    eligibleIds.add(userId); positions.add(position);
    if(available===1) availableIds.add(userId);
  }
  const groupedIds=new Set();
  const groupPositions=new Set();
  for(const item of groups){
    const aId=positiveId(item.user_a_id);
    const bId=item.user_b_id==null?null:positiveId(item.user_b_id);
    const soloValue=Number(item.is_solo);
    const solo=soloValue===1;
    const position=Number(item.position);
    if(Number(item.publication_id)!==publicationId||String(item.scope_key)!==scope.scopeKey
      ||Number(item.circle_id)!==scope.circleId||String(item.cycle_key)!==cycle.cycleKey
      ||!Number.isSafeInteger(position)||position<0||position>=groups.length||groupPositions.has(position)
      ||![0,1].includes(soloValue)
      ||!availableIds.has(aId)||groupedIds.has(aId)
      ||(solo&&bId!==null)||(!solo&&(!bId||bId===aId||!availableIds.has(bId)||groupedIds.has(bId)))){
      fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
    }
    groupPositions.add(position);
    groupedIds.add(aId); if(bId) groupedIds.add(bId);
  }
  if(groupedIds.size!==availableIds.size) fail('CIRCLE_PAIRING_INTEGRITY','Stored pairing publication is incomplete.');
  return Object.freeze({
    id:publicationId,scopeKey:scope.scopeKey,circleId:scope.circleId,cycle:Object.freeze({...cycle}),
    participantCount,eligibility:Object.freeze(eligibility.map(item=>Object.freeze({
      userId:Number(item.user_id),isAvailable:Number(item.is_available)===1,
      availabilityVersion:Number(item.availability_version),availabilitySource:String(item.availability_source),
      position:Number(item.position),
    }))),
    groups:Object.freeze(groups.map(item=>Object.freeze({
      id:Number(item.id),position:Number(item.position),userAId:Number(item.user_a_id),
      userBId:item.user_b_id==null?null:Number(item.user_b_id),isSolo:Number(item.is_solo)===1,
    }))),
    algorithm:Object.freeze({version:String(row.algorithm_version),seed:String(row.algorithm_seed)}),
    publishedAt:String(row.created_at),generationToken:String(row.generation_token),
  });
}

async function createPublication(db,{scope,cycle,availability}){
  const cycleKey=availability[0]?.cycleKey;
  if(!cycleKey) fail('CIRCLE_PAIRING_INTEGRITY','Pairing eligibility is invalid.');
  const publicationCycle={...cycle,cycleKey};
  const participants=availability.filter(item=>item.isAvailable).map(item=>({id:item.id,source:'auth'}));
  const pairing=buildFairPairing(participants,await circleHistory(db,{scopeKey:scope.scopeKey,cycleKey}),{
    seed:`${scope.scopeKey}:${cycleKey}:weekly`,
  });
  const generationToken=randomUUID();
  let claim;
  try{
    claim=await db.execute({
      sql:`INSERT INTO circle_pairing_publications
          (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
           generation_token,algorithm_version,algorithm_seed,participant_count)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_key,cycle_key) DO NOTHING RETURNING id`,
      args:[scope.scopeKey,scope.circleId,cycleKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,
        cycle.cutoffAt,cycle.timeZone,generationToken,pairing.algorithmVersion,pairing.seed,availability.length],
    });
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication could not be claimed.',error); }
  if(claim.rows?.length!==1) return {created:false};
  const publicationId=positiveId(claim.rows[0].id);
  try{
    for(const [position,item] of availability.entries()){
      await db.execute({
        sql:`INSERT INTO circle_pairing_eligibility
            (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,
             availability_version,availability_source,position)
          VALUES (?,?,?,?,?,?,?,?,?)`,
        args:[publicationId,scope.scopeKey,scope.circleId,cycleKey,item.id,item.isAvailable?1:0,
          item.availabilityVersion,item.availabilitySource,position],
      });
    }
    for(const [position,pair] of pairing.pairs.entries()){
      await db.execute({
        sql:`INSERT INTO circle_pairing_groups
            (publication_id,scope_key,circle_id,cycle_key,position,user_a_id,user_b_id,is_solo)
          VALUES (?,?,?,?,?,?,?,?)`,
        args:[publicationId,scope.scopeKey,scope.circleId,cycleKey,position,pair.a.id,
          pair.isAI?null:pair.b.id,pair.isAI?1:0],
      });
    }
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication could not be written.',error); }
  return {created:true,generationToken,cycle:publicationCycle};
}

/** Publish one secondary circle from session or authenticated cron authority. */
export async function publishCirclePairing(db,{authority,now,timeZone}={}){
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'||typeof db.transaction!=='function'){
    fail('CIRCLE_PAIRING_INPUT_INVALID','A transactional database client is required.');
  }
  const safeAuthority=authority?.kind==='system'?normalizeSystemAuthority(authority):normalizeSessionAuthority(authority);
  await ensureCirclePairingReadiness(db);
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      await assertAuthority(transaction,safeAuthority);
      const instant=await databaseNow(transaction,now);
      const resolved=currentCycle(instant,timeZone);
      const scope=scopeForCircle(safeAuthority.circleId);
      const accounts=await circleAccounts(transaction,scope.circleId);
      if(!accounts.length) fail('CIRCLE_PAIRING_NO_PARTICIPANTS','No eligible members are available.');
      const availability=await applyCycleAvailability(transaction,{
        scope,cycle:resolved,accounts,bridgeLegacyAvailability:false,
      });
      const cycle={...resolved,cycleKey:availability[0]?.cycleKey};
      if(!cycle.cycleKey){
        // The scope has members, so the complete availability snapshot must
        // always carry one shared cycle key.
        fail('CIRCLE_PAIRING_INTEGRITY','Pairing eligibility is invalid.');
      }
      const existing=await readStoredPublication(transaction,{scope,cycle});
      if(existing){
        await transaction.rollback();
        return Object.freeze({created:false,publication:existing});
      }
      const claimed=await createPublication(transaction,{scope,cycle:resolved,availability});
      const stored=await readStoredPublication(transaction,{scope,cycle});
      if(!stored) fail('CIRCLE_PAIRING_INTEGRITY','Pairing publication was not committed.');
      if(!claimed.created){
        await transaction.rollback();
        return Object.freeze({created:false,publication:stored});
      }
      if(stored.generationToken!==claimed.generationToken){
        fail('CIRCLE_PAIRING_INTEGRITY','Pairing publication ownership changed.');
      }
      commitStarted=true;
      await transaction.commit();
      return Object.freeze({created:true,publication:stored});
    }catch(error){
      lastError=error;
      if(transaction){ try{ await transaction.rollback(); }catch{} }
      if(!commitStarted&&attempt<TRANSACTION_ATTEMPTS&&retryableConflict(error)){
        await retryDelay(attempt); continue;
      }
      if(error instanceof CirclePairingError) throw error;
      fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication failed.',error);
    }finally{ try{ await transaction?.close?.(); }catch{} }
  }
  if(lastError instanceof CirclePairingError) throw lastError;
  fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication failed.',lastError);
}

/**
 * Read one selected secondary circle through a transaction-stable authority
 * check. Names are resolved only for members who are still active at read time.
 */
export async function readCirclePairing(db,{authority,now,timeZone}={}){
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'||typeof db.transaction!=='function'){
    fail('CIRCLE_PAIRING_INPUT_INVALID','A transactional database client is required.');
  }
  const safeAuthority=normalizeSessionAuthority({...authority,requireOwner:false});
  await ensureCirclePairingReadiness(db);
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const circlePublicId=await assertAuthority(transaction,safeAuthority);
    const instant=await databaseNow(transaction,now);
    const resolved=currentCycle(instant,timeZone);
    const scope=scopeForCircle(safeAuthority.circleId);
    const cycle={...resolved,cycleKey:availabilityCycleKey(scope,resolved)};
    const publication=await readStoredPublication(transaction,{scope,cycle});
    if(!publication){
      await transaction.commit(); finished=true;
      return Object.freeze({circlePublicId,cycle:Object.freeze({...resolved}),publication:null,accounts:new Map()});
    }
    const ids=[...new Set(publication.groups.flatMap(group=>[group.userAId,group.userBId]).filter(Boolean))];
    let result={rows:[]};
    if(ids.length){
      const placeholders=ids.map(()=>'?').join(',');
      result=await transaction.execute({
        sql:`SELECT account.id,account.display_name,account.color
          FROM circle_memberships membership
          JOIN auth_accounts account ON account.id=membership.user_id
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.circle_id=? AND membership.status='active'
            AND circle.is_primary=0 AND circle.archived_at IS NULL
            AND COALESCE(account.is_demo,0)=0 AND account.id IN (${placeholders})
          ORDER BY account.id`,
        args:[scope.circleId,...ids],
      });
    }
    const accounts=new Map((result.rows||[]).map(row=>[Number(row.id),Object.freeze({
      name:String(row.display_name||'Member').slice(0,80),color:String(row.color||'#999').slice(0,32),
    })]));
    await transaction.commit(); finished=true;
    return Object.freeze({circlePublicId,cycle:Object.freeze({...resolved}),publication,accounts});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    if(error instanceof CirclePairingError) throw error;
    fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing publication is unavailable.',error);
  }finally{ try{ await transaction.close?.(); }catch{} }
}

/** Deterministically enumerate bounded secondary scopes before any mutation. */
export async function listSecondaryPairingScopes(db,{limit=SECONDARY_PAIRING_CRON_LIMIT}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>100) fail('CIRCLE_PAIRING_INPUT_INVALID','Pairing batch limit is invalid.');
  await ensureCirclePairingReadiness(db);
  let result;
  try{
    result=await db.execute({
      sql:`SELECT circle.id
        FROM circles circle
        WHERE circle.is_primary=0 AND circle.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM circle_memberships owner
            JOIN auth_accounts owner_account ON owner_account.id=owner.user_id
            WHERE owner.circle_id=circle.id AND owner.status='active' AND owner.role='owner'
              AND COALESCE(owner_account.is_demo,0)=0)
          AND EXISTS (SELECT 1 FROM circle_memberships member
            JOIN auth_accounts member_account ON member_account.id=member.user_id
            WHERE member.circle_id=circle.id AND member.status='active'
              AND COALESCE(member_account.is_demo,0)=0)
        ORDER BY circle.id LIMIT ?`,
      args:[limit+1],
    });
  }catch(error){ fail('CIRCLE_PAIRING_UNAVAILABLE','Pairing scopes are unavailable.',error); }
  const rows=result.rows||[];
  if(rows.length>limit) fail('CIRCLE_PAIRING_BATCH_OVERFLOW','Secondary pairing batch limit was exceeded.');
  return Object.freeze(rows.map(row=>positiveId(row.id)));
}

export function circlePairingFailure(error,{contextVersion}={}){
  const code=error instanceof CirclePairingError?error.code:'CIRCLE_PAIRING_UNAVAILABLE';
  const context=contextVersion===undefined?{}:{circle_context_version:contextVersion};
  if(code==='CIRCLE_PAIRING_CONTEXT_CHANGED') return {
    status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'},
  };
  if(code==='CIRCLE_PAIRING_OWNER_REQUIRED') return {
    status:403,body:{ok:false,error:'circle owner required',...context},
  };
  if(code==='CIRCLE_PAIRING_FORBIDDEN') return {
    status:403,body:{ok:false,error:'active circle membership required'},
  };
  if(code==='CIRCLE_PAIRING_NO_PARTICIPANTS') return {
    status:400,body:{ok:false,error:'at least one active member is required',...context},
  };
  if(code==='CIRCLE_PAIRING_BATCH_OVERFLOW') return {
    status:503,body:{ok:false,error:'secondary pairing batch limit exceeded',code:'pairing_batch_overflow',retryable:true},
  };
  return {status:503,body:{ok:false,error:'pairing unavailable',...context}};
}
