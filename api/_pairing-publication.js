import { randomUUID } from 'node:crypto';

import { buildFairPairing } from './_pairing.js';
import { resolvePairingCycle } from './_pairing-cycle.js';

const PARTICIPANT_SOURCES=new Set(['auth','users']);
const NOTIFICATION_KINDS=new Set(['paired','unavailable']);

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
    return Object.freeze({...participant,id,source});
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
  for(const item of snapshot){
    const userId=positiveId(item?.user_id,'PAIRING_PUBLICATION_INTEGRITY');
    const source=String(item?.source||'');
    if(expectedSnapshot.has(userId)||!PARTICIPANT_SOURCES.has(source)){
      fail('PAIRING_PUBLICATION_INTEGRITY','Stored pairing publication is incomplete.');
    }
    expectedSnapshot.set(userId,source);
  }

  const participantIds=new Set();
  const positions=new Set();
  for(const [index,participant] of participants.entries()){
    const userId=positiveId(participant.user_id,'PAIRING_PUBLICATION_INTEGRITY');
    const position=Number(participant.position);
    const source=String(participant.source||'');
    if(participantIds.has(userId)||!Number.isSafeInteger(position)||position<0||position>=expectedCount
      ||positions.has(position)||expectedSnapshot.get(userId)!==source
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
  const snapshot=JSON.stringify(participants.map(participant=>({
    user_id:participant.id,
    source:participant.source,
  })));
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
 * Publish exactly one pairing set for the current London cycle.
 *
 * Eligibility, tenant, availability, and notification filtering belong to the
 * authorized caller. This service validates the supplied snapshot, but never
 * broadens it by querying accounts. The unique run claim and token-guarded
 * writes make owner/cron races idempotent without replacing existing pairs.
 */
export async function publishPairingCycle(db,options={}){
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
