import { randomUUID } from 'node:crypto';

import {
  applyCycleAvailability,
  resolveAvailabilityPublicationScope,
} from './_availability.js';
import { buildFairPairing } from './_pairing.js';
import { resolvePairingCycle } from './_pairing-cycle.js';
import { pairingSchemaV3Ready } from './_pairing-readiness.js';

const PARTICIPANT_SOURCES=new Set(['auth','users']);
const NOTIFICATION_KINDS=new Set(['paired','unavailable']);
const AVAILABILITY_SOURCES=new Set(['user','legacy_bridge','cycle_default']);
const TRANSACTION_ATTEMPTS=4;
const CYCLE_KEY_PATTERN=/^[0-9a-f]{64}$/;

export class PairingPublicationError extends Error{
  constructor(code,message,{cause}={}){
    super(message,{cause});
    this.name='PairingPublicationError';
    this.code=code;
  }
}

function fail(code,message,cause){
  throw new PairingPublicationError(code,message,cause===undefined?undefined:{cause});
}

function positiveId(value,code='PAIRING_PUBLICATION_INPUT_INVALID'){
  const id=Number(value);
  if(!Number.isSafeInteger(id)||id<1) fail(code,'Pairing publication input is invalid.');
  return id;
}

function normalizeParticipants(value){
  if(!Array.isArray(value)||value.length<1){
    fail('PAIRING_PUBLICATION_NO_PARTICIPANTS','At least one eligible participant is required.');
  }
  const seen=new Set();
  const participants=value.map(participant=>{
    if(!participant||typeof participant!=='object'||Array.isArray(participant)){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
    }
    const id=positiveId(participant.id);
    if(seen.has(id)) fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing participants must be unique.');
    seen.add(id);
    const source=participant.source===undefined?'auth':String(participant.source);
    if(!PARTICIPANT_SOURCES.has(source)){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
    }
    // Pair construction needs the caller's display fields, but publication
    // storage intentionally retains only the stable identity and provenance.
    const availabilityCycleKey=participant.availabilityCycleKey===undefined
      ?null:String(participant.availabilityCycleKey);
    const availabilityVersion=participant.availabilityVersion===undefined
      ?null:Number(participant.availabilityVersion);
    const availabilitySource=participant.availabilitySource===undefined
      ?null:String(participant.availabilitySource);
    const hasAvailabilitySnapshot=availabilityCycleKey!==null
      ||availabilityVersion!==null||availabilitySource!==null;
    if(hasAvailabilitySnapshot&&(!CYCLE_KEY_PATTERN.test(availabilityCycleKey||'')
      ||!Number.isSafeInteger(availabilityVersion)||availabilityVersion<0
      ||!AVAILABILITY_SOURCES.has(availabilitySource))){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing availability snapshot is invalid.');
    }
    return Object.freeze({
      ...participant,id,source,
      ...(hasAvailabilitySnapshot?{availabilityCycleKey,availabilityVersion,availabilitySource}:{}),
    });
  });
  participants.sort((left,right)=>left.id-right.id);
  return Object.freeze(participants);
}

function normalizeNotificationRecipients(value,participants){
  if(value===undefined) return Object.freeze([]);
  if(!Array.isArray(value)) fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
  const seen=new Set();
  const participantIds=new Set(participants.map(participant=>participant.id));
  const recipients=[];
  for(const recipient of value){
    if(!recipient||typeof recipient!=='object'||Array.isArray(recipient)){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
    }
    const id=positiveId(recipient.id);
    const kind=String(recipient.kind||'');
    const email=String(recipient.email||'').trim().slice(0,320);
    if(!NOTIFICATION_KINDS.has(kind)||!email
      ||(kind==='paired'&&!participantIds.has(id))
      ||(kind==='unavailable'&&participantIds.has(id))){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
    }
    const key=`${id}:${kind}`;
    if(seen.has(key)) fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing notification recipients must be unique.');
    seen.add(key);
    recipients.push(Object.freeze({id,kind,email}));
  }
  recipients.sort((left,right)=>left.id-right.id||left.kind.localeCompare(right.kind));
  return Object.freeze(recipients);
}

function normalizeHistory(value){
  if(value===undefined) return Object.freeze([]);
  if(!Array.isArray(value)) fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication input is invalid.');
  return Object.freeze([...value]);
}

function cycleFromOptions(options){
  let cycle;
  try{
    cycle=resolvePairingCycle({
      now:options.now,
      timeZone:options.timeZone,
      state:options.state,
    });
  }catch(error){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication options are invalid.',error);
  }
  if(cycle.state!=='current'){
    fail('PAIRING_PUBLICATION_STATE_INVALID','Only the current pairing cycle can be published.');
  }
  return cycle;
}

function safeCycle(cycle){
  return Object.freeze({
    cycleId:cycle.cycleId,
    startsAt:cycle.startsAt,
    endsAt:cycle.endsAt,
    cutoffAt:cycle.cutoffAt,
    timeZone:cycle.timeZone,
    state:cycle.state,
  });
}

function freezePublication({cycle,run,participants,groups}){
  const safeParticipants=participants.map(row=>Object.freeze({
    userId:positiveId(row.user_id,'PAIRING_PUBLICATION_INTEGRITY'),
    position:Number(row.position),
    source:String(row.source),
  }));
  const safePairs=groups.map(row=>Object.freeze({
    groupId:positiveId(row.id,'PAIRING_PUBLICATION_INTEGRITY'),
    aId:positiveId(row.user_a_id,'PAIRING_PUBLICATION_INTEGRITY'),
    bId:positiveId(row.user_b_id,'PAIRING_PUBLICATION_INTEGRITY'),
    isAI:Number(row.is_ai_pair)===1,
  }));
  return Object.freeze({
    cycle:safeCycle(cycle),
    weekId:positiveId(run.week_id,'PAIRING_PUBLICATION_INTEGRITY'),
    generation:Number(run.generation),
    participantCount:Number(run.participant_count),
    participants:Object.freeze(safeParticipants),
    pairs:Object.freeze(safePairs),
    algorithm:Object.freeze({
      version:String(run.algorithm_version),
      seed:String(run.algorithm_seed),
    }),
    publishedAt:String(run.created_at||''),
  });
}

function validateCompletePublication({cycle,run,weeks,participants,groups}){
  if(!Number.isSafeInteger(Number(run.week_id))||Number(run.week_id)<1
    ||!Number.isSafeInteger(Number(run.generation))||Number(run.generation)<1
    ||!Number.isSafeInteger(Number(run.participant_count))||Number(run.participant_count)<1
    ||!String(run.generation_token||'')||!String(run.algorithm_version||'')
    ||!String(run.algorithm_seed||'')||!String(run.created_at||'')){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }
  if(weeks.length!==1||Number(weeks[0].id)!==Number(run.week_id)
    ||String(weeks[0].week_label)!==cycle.cycleId||String(weeks[0].week_start)!==cycle.startsAt
    ||Number(weeks[0].is_demo)!==0){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }
  const expectedCount=Number(run.participant_count);
  if(participants.length!==expectedCount||groups.length!==Math.ceil(expectedCount/2)){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }

  let snapshot;
  try{ snapshot=JSON.parse(String(run.participants_json||'')); }
  catch{ fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.'); }
  if(!Array.isArray(snapshot)||snapshot.length!==expectedCount){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }
  const expectedSnapshot=new Map();
  let availabilitySnapshotMode=null;
  let availabilityCycleKey=null;
  for(const item of snapshot){
    const userId=positiveId(item?.user_id,'PAIRING_PUBLICATION_INTEGRITY');
    const source=String(item?.source||'');
    const snapshotFields=['availability_cycle_key','availability_version','availability_source'];
    const presentFields=snapshotFields.filter(field=>item?.[field]!==undefined);
    const hasAvailabilitySnapshot=presentFields.length>0;
    if(expectedSnapshot.has(userId)||!PARTICIPANT_SOURCES.has(source)){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    if(presentFields.length!==0&&presentFields.length!==snapshotFields.length){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    if(availabilitySnapshotMode===null) availabilitySnapshotMode=hasAvailabilitySnapshot;
    if(availabilitySnapshotMode!==hasAvailabilitySnapshot){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    let availability=null;
    if(hasAvailabilitySnapshot){
      const cycleKey=String(item.availability_cycle_key||'');
      const version=Number(item.availability_version);
      const decisionSource=String(item.availability_source||'');
      if(!CYCLE_KEY_PATTERN.test(cycleKey)||!Number.isSafeInteger(version)||version<0
        ||!AVAILABILITY_SOURCES.has(decisionSource)
        ||(availabilityCycleKey!==null&&availabilityCycleKey!==cycleKey)){
        fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
      }
      availabilityCycleKey=cycleKey;
      availability={cycleKey,version,source:decisionSource};
    }
    expectedSnapshot.set(userId,{source,availability});
  }

  const participantIds=new Set();
  const positions=new Set();
  for(const [index,participant] of participants.entries()){
    const userId=positiveId(participant.user_id,'PAIRING_PUBLICATION_INTEGRITY');
    const position=Number(participant.position);
    const source=String(participant.source||'');
    if(participantIds.has(userId)||!Number.isSafeInteger(position)||position<0||position>=expectedCount
      ||positions.has(position)||expectedSnapshot.get(userId)?.source!==source
      ||Number(snapshot[index]?.user_id)!==userId||String(snapshot[index]?.source||'')!==source){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    participantIds.add(userId);
    positions.add(position);
  }

  const groupedIds=new Set();
  for(const group of groups){
    const aId=positiveId(group.user_a_id,'PAIRING_PUBLICATION_INTEGRITY');
    const bId=positiveId(group.user_b_id,'PAIRING_PUBLICATION_INTEGRITY');
    const aiFlag=Number(group.is_ai_pair);
    const isAI=aiFlag===1;
    if((aiFlag!==0&&aiFlag!==1)||(group.user_c_id!==null&&group.user_c_id!==undefined)){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    if(!participantIds.has(aId)||groupedIds.has(aId)
      ||(isAI&&aId!==bId)
      ||(!isAI&&(aId===bId||!participantIds.has(bId)||groupedIds.has(bId)))){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    groupedIds.add(aId);
    if(!isAI) groupedIds.add(bId);
  }
  if(groupedIds.size!==participantIds.size){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }
}

async function readPublicationState(db,cycle){
  let results;
  try{
    results=await db.batch([
      {sql:`SELECT week_label,week_id,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json,created_at FROM pairing_week_runs WHERE week_label=?`,args:[cycle.cycleId]},
      {sql:`SELECT id,week_label,week_start,is_demo FROM pairing_weeks WHERE week_label=? ORDER BY id`,args:[cycle.cycleId]},
      {sql:`SELECT pp.user_id,pp.position,pp.source FROM pairing_participants pp JOIN pairing_week_runs pwr ON pwr.week_id=pp.week_id WHERE pwr.week_label=? ORDER BY pp.position,pp.user_id`,args:[cycle.cycleId]},
      {sql:`SELECT pg.id,pg.user_a_id,pg.user_b_id,pg.user_c_id,pg.is_ai_pair FROM pairing_groups pg JOIN pairing_week_runs pwr ON pwr.week_id=pg.week_id WHERE pwr.week_label=? ORDER BY pg.id`,args:[cycle.cycleId]},
    ],'read');
  }catch(error){
    fail('PAIRING_PUBLICATION_FAILED','Pairing publication could not be read.',error);
  }
  const runRows=results[0]?.rows||[];
  const weeks=results[1]?.rows||[];
  const participants=results[2]?.rows||[];
  const groups=results[3]?.rows||[];
  if(runRows.length===0){
    if(weeks.length){
      fail('PAIRING_PUBLICATION_LEGACY_CONFLICT','An unmanaged pairing week already exists for this cycle.');
    }
    return null;
  }
  if(runRows.length!==1){
    fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
  }
  const run=runRows[0];
  validateCompletePublication({cycle,run,weeks,participants,groups});
  return Object.freeze({
    generationToken:String(run.generation_token),
    publication:freezePublication({cycle,run,participants,groups}),
  });
}

function writeStatements({cycle,participants,pairing,recipients,generationToken}){
  const snapshot=JSON.stringify(participants.map(participant=>{
    const item={user_id:participant.id,source:participant.source};
    if(participant.availabilityCycleKey!==undefined){
      item.availability_cycle_key=participant.availabilityCycleKey;
      item.availability_version=participant.availabilityVersion;
      item.availability_source=participant.availabilitySource;
    }
    return item;
  }));
  const statements=[
    {
      sql:`INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json)
        SELECT ?,NULL,?,1,?,?,?,?
        WHERE NOT EXISTS (SELECT 1 FROM pairing_weeks WHERE week_label=?)
        ON CONFLICT(week_label) DO NOTHING`,
      args:[cycle.cycleId,generationToken,pairing.algorithmVersion,pairing.seed,participants.length,snapshot,cycle.cycleId],
    },
    {
      sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo)
        SELECT ?,?,'both',0
        WHERE EXISTS (SELECT 1 FROM pairing_week_runs WHERE week_label=? AND generation_token=? AND week_id IS NULL)
          AND NOT EXISTS (SELECT 1 FROM pairing_weeks WHERE week_label=?)`,
      args:[cycle.cycleId,cycle.startsAt,cycle.cycleId,generationToken,cycle.cycleId],
    },
    {
      sql:`UPDATE pairing_week_runs
        SET week_id=(SELECT id FROM pairing_weeks WHERE week_label=? ORDER BY id LIMIT 1),updated_at=datetime('now')
        WHERE week_label=? AND generation_token=? AND week_id IS NULL`,
      args:[cycle.cycleId,cycle.cycleId,generationToken],
    },
  ];
  participants.forEach((participant,position)=>{
    statements.push({
      sql:`INSERT INTO pairing_participants (week_id,user_id,position,source)
        SELECT week_id,?,?,? FROM pairing_week_runs
        WHERE week_label=? AND generation_token=? AND week_id IS NOT NULL`,
      args:[participant.id,position,participant.source,cycle.cycleId,generationToken],
    });
  });
  pairing.pairs.forEach(pair=>{
    statements.push({
      sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
        SELECT week_id,?,?,NULL,?,'Pick together','both' FROM pairing_week_runs
        WHERE week_label=? AND generation_token=? AND week_id IS NOT NULL`,
      args:[pair.a.id,pair.b?.id||pair.a.id,pair.isAI?1:0,cycle.cycleId,generationToken],
    });
  });
  recipients.forEach(recipient=>{
    statements.push({
      sql:`INSERT INTO pairing_email_outbox (week_id,user_id,kind,recipient_email)
        SELECT week_id,?,?,? FROM pairing_week_runs
        WHERE week_label=? AND generation_token=? AND week_id IS NOT NULL
        ON CONFLICT(week_id,user_id,kind) DO NOTHING`,
      args:[recipient.id,recipient.kind,recipient.email,cycle.cycleId,generationToken],
    });
  });
  return statements;
}

/** Read the immutable publication for the resolved current cycle, if present. */
export async function getPairingPublication(db,options={}){
  if(!db||typeof db.batch!=='function'){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','A database client is required.');
  }
  if(!options||typeof options!=='object'||Array.isArray(options)){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication options are invalid.');
  }
  const cycle=cycleFromOptions(options);
  return (await readPublicationState(db,cycle))?.publication||null;
}

/**
 * Atomically claim and persist a previously authorized eligibility snapshot.
 * The outer publication service owns scope, authorization, and candidate
 * selection; this private primitive owns the immutable token-guarded writes.
 */
async function claimPairingCycle(db,options={}){
  if(!db||typeof db.batch!=='function'){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','A database client is required.');
  }
  if(!options||typeof options!=='object'||Array.isArray(options)){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication options are invalid.');
  }
  const cycle=cycleFromOptions(options);
  const existing=await readPublicationState(db,cycle);
  if(existing) return Object.freeze({created:false,publication:existing.publication});

  const participants=normalizeParticipants(options.participants);
  const recipients=normalizeNotificationRecipients(options.notificationRecipients,participants);
  const history=normalizeHistory(options.history);
  const pairing=buildFairPairing(participants,history,{seed:`${cycle.cycleId}:weekly`});
  const generationToken=randomUUID();
  try{
    await db.batch(writeStatements({cycle,participants,pairing,recipients,generationToken}),'write');
  }catch(error){
    fail('PAIRING_PUBLICATION_FAILED','Pairing publication could not be committed.',error);
  }
  const stored=await readPublicationState(db,cycle);
  if(!stored){
    fail('PAIRING_PUBLICATION_INTEGRITY','Pairing publication was not committed.');
  }
  return Object.freeze({
    created:stored.generationToken===generationToken,
    publication:stored.publication,
  });
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

function retryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1)))));
}

function canonicalAppUrl(value,{allowLocalAppUrl,localRuntime}){
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>2048){
    fail('PAIRING_PUBLICATION_CONFIG_INVALID','Pairing publication configuration is invalid.');
  }
  let url;
  try{ url=new URL(value); }
  catch(error){ fail('PAIRING_PUBLICATION_CONFIG_INVALID','Pairing publication configuration is invalid.',error); }
  const loopback=url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='[::1]';
  const localUrlAllowed=localRuntime||allowLocalAppUrl;
  if(url.username||url.password||url.search||url.hash||(url.pathname!==''&&url.pathname!=='/')
    ||(localUrlAllowed?(url.protocol!=='http:'||!loopback):(url.protocol!=='https:'||loopback))){
    fail('PAIRING_PUBLICATION_CONFIG_INVALID','Pairing publication configuration is invalid.');
  }
  return url.origin;
}

async function publicationNow(db,value){
  if(value!==undefined){
    const instant=value instanceof Date?new Date(value.getTime()):new Date(value);
    if(!Number.isFinite(instant.getTime())){
      fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication time is invalid.');
    }
    return instant;
  }
  let result;
  try{ result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`); }
  catch(error){ fail('PAIRING_PUBLICATION_FAILED','Pairing publication time is unavailable.',error); }
  const valueFromDatabase=result.rows?.[0]?.now_utc;
  const instant=new Date(valueFromDatabase);
  if(!valueFromDatabase||!Number.isFinite(instant.getTime())){
    fail('PAIRING_PUBLICATION_FAILED','Pairing publication time is unavailable.');
  }
  return instant;
}

async function assertSchemaV3Readiness(db,{localRuntime}){
  let ready;
  try{ ready=await pairingSchemaV3Ready(db,{requireClosedMembership:!localRuntime}); }
  catch(error){ fail('PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE','Pairing publication schema is unavailable.',error); }
  if(ready!==true){
    fail('PAIRING_PUBLICATION_SCHEMA_UNAVAILABLE','Pairing publication schema is unavailable.');
  }
}

function assertScopeMatches(actual,expected){
  if(!expected) return;
  if(!actual||!expected||actual.kind!==expected.kind||actual.scopeKey!==expected.scopeKey
    ||actual.circleId!==expected.circleId){
    fail('PAIRING_PUBLISHER_REVOKED','Pairing publisher authorization changed.');
  }
}

async function assertPublisher(db,{scope,localRuntime,callerId}){
  if(callerId===null||callerId===undefined) return;
  const publisherId=positiveId(callerId);
  let result;
  try{
    result=await db.execute(localRuntime?{
      sql:`SELECT id,is_admin FROM auth_accounts
        WHERE id=? AND COALESCE(is_demo,0)=0 LIMIT 2`,args:[publisherId],
    }:{
      sql:`SELECT account.id,membership.role,circle.id AS circle_id
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.user_id=account.id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE account.id=? AND membership.circle_id=?
          AND membership.status='active' AND membership.role='owner'
          AND COALESCE(account.is_demo,0)=0
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        LIMIT 2`,args:[publisherId,scope.circleId],
    });
  }catch(error){ fail('PAIRING_PUBLICATION_FAILED','Pairing publisher could not be verified.',error); }
  const rows=result.rows||[];
  const authorized=localRuntime
    ?rows.length===1&&Number(rows[0].id)===publisherId&&Number(rows[0].is_admin)===1
    :rows.length===1&&Number(rows[0].id)===publisherId&&String(rows[0].role)==='owner'
      &&Number(rows[0].circle_id)===scope.circleId;
  if(!authorized) fail('PAIRING_PUBLISHER_REVOKED','Pairing publisher authorization changed.');
}

async function pairingAccounts(db,scope){
  let result;
  try{
    result=await db.execute(scope.kind==='local'
      ?`SELECT id,email,is_available FROM auth_accounts
        WHERE COALESCE(is_demo,0)=0 ORDER BY id`
      :{
        sql:`SELECT account.id,account.email,account.is_available
          FROM auth_accounts account
          JOIN circle_memberships membership
            ON membership.user_id=account.id AND membership.circle_id=?
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE COALESCE(account.is_demo,0)=0 AND membership.status='active'
            AND circle.is_primary=1 AND circle.archived_at IS NULL
          ORDER BY account.id`,
        args:[scope.circleId],
      });
  }catch(error){ fail('PAIRING_PUBLICATION_FAILED','Pairing eligibility could not be read.',error); }
  const seen=new Set();
  const accounts=[];
  for(const row of result.rows||[]){
    const id=positiveId(row.id,'PAIRING_PUBLICATION_INTEGRITY');
    if(seen.has(id)) fail('PAIRING_PUBLICATION_INTEGRITY','Pairing eligibility is invalid.');
    seen.add(id);
    accounts.push(Object.freeze({
      id,email:String(row.email||'').trim().slice(0,320),is_available:row.is_available,
    }));
  }
  return Object.freeze(accounts);
}

async function pairingHistory(db,cycleId){
  try{
    const result=await db.execute({sql:`SELECT group_row.user_a_id,group_row.user_b_id,
        group_row.is_ai_pair,week.id AS week_id,week.week_label
      FROM pairing_groups group_row
      JOIN pairing_weeks week ON week.id=group_row.week_id
      JOIN pairing_week_runs run ON run.week_id=week.id AND run.week_label=week.week_label
      JOIN pairing_participants participant_a
        ON participant_a.week_id=group_row.week_id AND participant_a.user_id=group_row.user_a_id
          AND participant_a.source='auth'
      JOIN pairing_participants participant_b
        ON participant_b.week_id=group_row.week_id AND participant_b.user_id=group_row.user_b_id
          AND participant_b.source='auth'
      WHERE week.week_label<>? AND COALESCE(week.is_demo,0)=0
        AND group_row.user_c_id IS NULL
      ORDER BY week.week_start DESC,week.id DESC,group_row.id ASC LIMIT 1000`,args:[cycleId]});
    return result.rows||[];
  }catch(error){ fail('PAIRING_PUBLICATION_FAILED','Pairing history could not be read.',error); }
}

async function publicationCandidates(db,{scope,cycle}){
  const accounts=await applyCycleAvailability(db,{
    scope,cycle,accounts:await pairingAccounts(db,scope),
  });
  const participants=accounts.filter(account=>account.isAvailable).map(account=>({
    id:account.id,
    source:'auth',
    availabilityCycleKey:account.cycleKey,
    availabilityVersion:account.availabilityVersion,
    availabilitySource:account.availabilitySource,
  }));
  const notificationRecipients=[
    ...accounts.filter(account=>account.isAvailable&&account.email)
      .map(account=>({id:account.id,email:account.email,kind:'paired'})),
    ...accounts.filter(account=>!account.isAvailable&&account.email)
      .map(account=>({id:account.id,email:account.email,kind:'unavailable'})),
  ];
  return {participants,notificationRecipients};
}

/**
 * Publish the current cycle from one transaction-bound authorization and
 * eligibility snapshot. Both the owner endpoint and cron call this service.
 */
export async function publishPairingCycle(db,options={}){
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'
    ||typeof db.transaction!=='function'){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','A transactional database client is required.');
  }
  if(!options||typeof options!=='object'||Array.isArray(options)
    ||typeof options.localRuntime!=='boolean'
    ||(options.allowLocalAppUrl!==undefined&&typeof options.allowLocalAppUrl!=='boolean')){
    fail('PAIRING_PUBLICATION_INPUT_INVALID','Pairing publication options are invalid.');
  }
  const appUrl=canonicalAppUrl(options.appUrl,{
    localRuntime:options.localRuntime,
    allowLocalAppUrl:options.allowLocalAppUrl===true,
  });
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      await assertSchemaV3Readiness(transaction,{localRuntime:options.localRuntime});
      const now=await publicationNow(transaction,options.now);
      const scope=await resolveAvailabilityPublicationScope(transaction,{
        localRuntime:options.localRuntime,
      });
      assertScopeMatches(scope,options.authorizedScope);
      await assertPublisher(transaction,{
        scope,localRuntime:options.localRuntime,callerId:options.callerId,
      });
      const cycle=cycleFromOptions({now,timeZone:options.timeZone,state:'current'});
      const existing=await readPublicationState(transaction,cycle);
      if(existing){
        // No mutation was attempted, so end the read snapshot without creating
        // an ambiguous commit outcome on SQLite/libSQL concurrent readers.
        await transaction.rollback();
        return Object.freeze({created:false,publication:existing.publication,appUrl});
      }
      const candidates=await publicationCandidates(transaction,{scope,cycle});
      const result=await claimPairingCycle(transaction,{
        now,timeZone:options.timeZone,participants:candidates.participants,
        history:await pairingHistory(transaction,cycle.cycleId),
        notificationRecipients:candidates.notificationRecipients,
      });
      commitStarted=true;
      await transaction.commit();
      return Object.freeze({...result,appUrl});
    }catch(error){
      lastError=error;
      if(transaction){ try{ await transaction.rollback(); }catch{} }
      if(!commitStarted&&attempt<TRANSACTION_ATTEMPTS&&retryableConflict(error)){
        await retryDelay(attempt);
        continue;
      }
      if(error instanceof PairingPublicationError) throw error;
      fail('PAIRING_PUBLICATION_FAILED','Pairing publication failed.',error);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  if(lastError instanceof PairingPublicationError) throw lastError;
  fail('PAIRING_PUBLICATION_FAILED','Pairing publication failed.',lastError);
}
