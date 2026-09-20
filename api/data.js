import { captureSentryException, captureSentryMessage, getClient, getAdminEmails, getJwtSecret, initSentry, isSentryConfigured, verifyMutationOrigin, verifyRequestAuth, verifySignedRequestAuth } from './_db.js';
import { createEvaluationSuite, getPublicExercise, listPublicExercises } from './_catalog.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { resolvePairingCycle } from './_pairing-cycle.js';
import { getPairingPublication } from './_pairing-publication.js';
import { pairingPublicationState } from './_pairing-recovery.js';
import { hasPrimaryUnavailableEvidence } from './_pairing-evidence.js';
import { circlePairingFailure, readCirclePairing } from './_circle-pairing.js';
import { authPairAccessArgs, authPairAccessSql, getAuthenticatedPairAccess } from './_pair-access.js';
import {
  applyScheduleMutation,
  assertFutureScheduleInstant,
  nextScheduleUpdatedAt,
  parseScheduleMutation,
  projectSchedule,
  readScheduleDatabaseNow,
  readScheduleState,
  ScheduleDataError,
  ScheduleInputError,
  ScheduleTemporalError,
} from './_schedule.js';
import {
  mutateSecondarySchedule,
  parseSecondaryScheduleMutation,
  readSecondarySchedule,
  secondaryScheduleFailure,
  secondaryScheduleIdentity,
} from './_secondary-schedule.js';
import { scheduleNotificationEvents } from './_schedule-email.js';
import { ensureMessagesReadiness, MAX_MESSAGES_PER_ROOM, MAX_MESSAGES_PER_USER_PER_MINUTE, MESSAGE_RATE_RETRY_SECONDS, messageInsertStatement, messageLimitStateStatement, MessageDataError, MessageInputError, messageReadStatement, parseMessageSend, parseMessagesQuery, projectMessage, validateMessagesPostQuery } from './_messages.js';
import { ensurePairRecapReadiness, MAX_RECAP_ACTIVITY, MAX_RECAP_RUN_SCAN, newestRecapActivity, PairRecapDataError, PairRecapInputError, parsePairRecapQuery, projectRecapMessage, projectRecapPair, projectRecapRun, projectRecapSchedule, projectRecapWorkspace } from './_pair-recap.js';
import {
  canonicalCompletionPair,
  mutateAuthorizedSessionCompletion,
  parseSessionCompletionMutation,
  parseSessionCompletionQuery,
  projectSessionCompletion,
  readAuthorizedSessionCompletion,
  SessionCompletionConflictError,
  SessionCompletionDataError,
  SessionCompletionInputError,
  validateSessionCompletionPostQuery,
} from './_session-completion.js';
import {
  mutateAuthorizedMeetingLink,
  parseMeetingLinkMutation,
  parseMeetingLinkQuery,
  readAuthorizedMeetingLink,
  MeetingLinkConflictError,
  MeetingLinkDataError,
  MeetingLinkInputError,
  validateMeetingLinkPostQuery,
} from './_meeting-link.js';
import { ensureDataAdminReadiness, ensureDataCircleReadiness, ensureDataHistoryReadiness, ensureDataLogReadiness, ensureDataMeetingLinkReadiness, ensureDataProfileReadiness, ensureDataRunsReadiness, ensureDataSessionCompletionReadiness, ensureDataStatsReadiness, ensureDataWeeksReadiness, ensureMyPairDataReadiness } from './_data-readiness.js';
import { circleMembershipEnabled, ensureCircleMembershipReadiness } from './_circle-membership.js';
import { initializePrimaryCircleData } from './_admin-init.js';
import { localRuntimeRequest } from './_local-runtime.js';
import {
  canUseLegacySinglePrimaryCircleFeatures,
  multiCircleControlPlaneEnabled,
  requestMatchesCircleContext,
  resolveActiveCircleContext,
  secondaryCircleCoordinationEnabled,
  secondaryCircleSchedulingEnabled,
  sendMultiCircleFeatureUnavailable,
  validateActiveCircleMutationContext,
} from './_active-circle.js';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  HEALTH_RESPONSE,
  READY_RESPONSE,
  UNAVAILABLE_RESPONSE,
  coalescedDatabaseReadiness,
  databaseReadinessConfiguration,
  readinessTargetExists,
  resolveHealthProbe,
  setHealthHeaders,
} from './_health.js';

function isAdminCheck(email, flag){
  if (flag) return true;
  if (!email) return false;
  try{ return getAdminEmails().has(String(email).toLowerCase().trim()); }catch{ return false; }
}
async function getCallerAdmin(db, payload){
  let callerEmail = '';
  const callerId = payload.id||payload.uid;
  let callerIsAdminFlag=false, callerDbRow=null;
  if (callerId){ try{ const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]}); if(cr.rows.length){ callerDbRow=cr.rows[0]; callerEmail=String(cr.rows[0].email||'').toLowerCase().trim(); callerIsAdminFlag=!!cr.rows[0].is_admin; }}catch{} }
  const callerIsAdmin = !!callerDbRow && isAdminCheck(callerEmail, callerIsAdminFlag);
  return {callerEmail, callerId, callerIsAdminFlag, callerIsAdmin};
}
async function requireAdminDT(req,res){
  const payload=await verifyRequestAuth(req);
  if (!payload){ res.status(401).json({ error:'authentication required' }); return null; }
  let db;
  try{
    db=getClient();
    await ensureDataAdminReadiness(db);
  }catch{
    res.status(503).json({error:'data unavailable'});
    return null;
  }
  const ctx=await getCallerAdmin(db,payload);
  if(!ctx.callerIsAdmin){ res.status(403).json({ error:'admin only', you_are:ctx.callerEmail||'unknown' }); return null; }
  return {db, payload, ...ctx};
}

async function fetchWithTimeout(url, opts={}, timeoutMs=6000){
  const ctrl = new AbortController();
  const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const r = await fetch(url, {...opts, signal: ctrl.signal});
    clearTimeout(id);
    return r;
  }catch(e){ clearTimeout(id); throw e; }
  finally{ clearTimeout(id); }
}
function getEndpoint(req){
  const q = req.query?.endpoint;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url,'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const path = u.pathname.split('/').filter(Boolean).pop();
    return (path||'').toLowerCase();
  }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

function getPathname(req){
  try{ return new URL(req?.url||'/','http://localhost').pathname.toLowerCase(); }
  catch{ return String(req?.url||'').split('?')[0].toLowerCase(); }
}

function resolveDataRoute(req,endpoint){
  const path=getPathname(req);
  if(endpoint==='runs'||endpoint==='session_runs'||endpoint==='session-runs'||path.includes('/runs')) return 'runs';
  if(endpoint==='leetcode-sync'||endpoint==='leetcode_sync'||path.includes('leetcode/sync')||path.includes('leetcode-sync')) return 'leetcode-sync';
  if(endpoint==='leetcode'||endpoint==='leetcode-detail'||endpoint==='leetcode_detail'||path.includes('/leetcode')) return 'leetcode';
  if(endpoint==='circle'||path.includes('/circle')) return 'circle';
  if(endpoint==='weeks'||path.includes('/weeks')) return 'weeks';
  if(endpoint==='history'||path.includes('/history')) return 'history';
  if(endpoint==='stats'||path.includes('/stats')) return 'stats';
  if(endpoint==='init'||path.includes('/init')) return 'init';
  if(endpoint==='profile'||path.includes('/profile')) return 'profile';
  if(endpoint==='my-pair'||endpoint==='mypair'||endpoint==='my_pair'
    ||path.includes('my-pair')||path.includes('my_pair')) return 'my-pair';
  if(endpoint==='pair-recap'||path.includes('/pair-recap')) return 'pair-recap';
  if(endpoint==='session-completion'||path.includes('/session-completion')) return 'session-completion';
  if(endpoint==='meeting-link'||path.includes('/meeting-link')) return 'meeting-link';
  if(endpoint==='schedule'||path.includes('/schedule')) return 'schedule';
  if(endpoint.includes('message')) return 'messages';
  if(endpoint==='execute'||endpoint==='run'||path.includes('/execute')) return 'execute';
  if(endpoint==='health'||endpoint==='healthz'||path.includes('/health')) return 'health';
  if(endpoint==='logs'||endpoint==='applogs'||endpoint==='app_logs'||path.includes('/logs')) return 'logs';
  if(endpoint==='questions'||endpoint==='question'||path.includes('/questions')) return 'questions';
  return null;
}

async function getAuthPayload(req){
  return verifyRequestAuth(req);
}

function requestQueryValue(req,name){
  if(req.query && Object.prototype.hasOwnProperty.call(req.query,name)) return req.query[name];
  try{
    const values=new URL(req.url,'http://localhost').searchParams.getAll(name);
    if(values.length===1) return values[0];
    if(values.length>1) return values;
  }catch{}
  return undefined;
}

function parseCanonicalRoomId(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value ? parsed : null;
}

function parseBoundedQueryInteger(value,{defaultValue,min,max}){
  if(value===undefined) return defaultValue;
  if(typeof value==='number') return Number.isSafeInteger(value)&&value>=min&&value<=max ? value : null;
  if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max ? parsed : null;
}

function authenticatedUserId(payload){
  const value=payload?.id??payload?.uid;
  if(typeof value==='number') return Number.isSafeInteger(value)&&value>0?value:null;
  if(typeof value!=='string'||!/^[1-9]\d*$/.test(value)) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)?parsed:null;
}

function isLoopbackHost(value){
  try{
    const hostname=new URL(`http://${String(value||'')}`).hostname.toLowerCase();
    return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]';
  }catch{ return false; }
}

function isLoopbackAddress(value){
  const address=String(value||'').trim().toLowerCase();
  return address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
}

function strictLocalPairingRuntime(req){
  if(process.env.NODE_ENV!=='development'
    ||process.env.RANDORI_LOCAL_RUNTIME!=='true'
    ||process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
    ||process.env.VERCEL||process.env.VERCEL_ENV||process.env.VERCEL_URL
    ||String(process.env.TURSO_AUTH_TOKEN||'').trim()) return false;
  let databaseUrl,appUrl,requestUrl;
  try{
    databaseUrl=new URL(String(process.env.TURSO_DATABASE_URL||''));
    appUrl=new URL(String(process.env.APP_URL||''));
    requestUrl=new URL(`http://${String(req?.headers?.host||'')}`);
  }catch{ return false; }
  if(databaseUrl.protocol!=='file:'||databaseUrl.host||databaseUrl.username||databaseUrl.password
    ||databaseUrl.search||databaseUrl.hash) return false;
  if(appUrl.protocol!=='http:'||appUrl.username||appUrl.password||appUrl.search||appUrl.hash
    ||(appUrl.pathname!=='/'&&appUrl.pathname!=='')||!isLoopbackHost(appUrl.host)
    ||appUrl.host.toLowerCase()!==requestUrl.host.toLowerCase()) return false;
  return isLoopbackHost(req?.headers?.host)&&isLoopbackAddress(req?.socket?.remoteAddress);
}

async function requireCurrentPairingReader(req,res,db,userId){
  const localRuntime=strictLocalPairingRuntime(req);
  try{
    const result=await db.execute(localRuntime?{
      sql:`SELECT id,is_admin FROM auth_accounts
        WHERE id=? AND COALESCE(is_demo,0)=0
        LIMIT 2`,
      args:[userId],
    }:{
      sql:`SELECT aa.id,c.id AS circle_id,cm.role
        FROM auth_accounts aa
        JOIN circle_memberships cm ON cm.user_id=aa.id
        JOIN circles c ON c.id=cm.circle_id
        WHERE aa.id=? AND cm.status='active'
          AND COALESCE(aa.is_demo,0)=0 AND c.is_primary=1 AND c.archived_at IS NULL
        LIMIT 2`,
      args:[userId],
    });
    const rows=result.rows||[];
    if(rows.length!==1||Number(rows[0].id)!==userId){
      res.status(403).json({error:'circle membership required'});
      return false;
    }
    const circleId=localRuntime?null:Number(rows[0].circle_id);
    if(!localRuntime&&(!Number.isSafeInteger(circleId)||circleId<1)){
      res.status(503).json({error:'pairing unavailable'});
      return false;
    }
    return {
      localRuntime,circleId,userId,
      isOwner:localRuntime?Number(rows[0].is_admin)===1:String(rows[0].role)==='owner',
    };
  }catch{
    res.status(503).json({error:'pairing unavailable'});
    return false;
  }
}

async function requireSelectedPairingReader(req,res,db,payload,userId){
  const localRuntime=strictLocalPairingRuntime(req);
  if(!secondaryCircleCoordinationEnabled()||localRuntime){
    return requireCurrentPairingReader(req,res,db,userId);
  }
  try{
    await ensureCircleMembershipReadiness(db);
    const active=await resolveActiveCircleContext(db,payload);
    if(!active.ok){
      if(active.reason==='selection_required'){
        res.status(409).json({ok:false,error:'select an active circle',code:'active_circle_required'});
      }else res.status(403).json({ok:false,error:'active circle membership required'});
      return false;
    }
    if(!active.implicit&&!requestMatchesCircleContext(req,active)){
      res.status(409).json({ok:false,error:'circle context changed',code:'circle_context_changed'});
      return false;
    }
    const circleId=Number(active.membership.id);
    const common={
      localRuntime:false,circleId,userId,circlePublicId:String(active.membership.public_id),
      circleContextVersion:Number(active.context_version),
      isOwner:active.membership.role==='owner',
      circleContext:{payload,circleId,contextVersion:Number(active.context_version),implicit:active.implicit===true},
    };
    if(active.membership.is_primary) return {...common,mode:'primary'};
    return {
      ...common,mode:'secondary',authority:{
        kind:'session',payload,userId,circleId,contextVersion:Number(active.context_version),
        implicit:active.implicit===true,requireOwner:false,
      },
    };
  }catch{
    res.status(503).json({ok:false,error:'pairing unavailable'});
    return false;
  }
}

function selectedPairingEnvelope(readerAccess){
  if(!readerAccess?.circlePublicId) return {};
  return {
    circle_public_id:readerAccess.circlePublicId,
    circle_context_version:readerAccess.circleContextVersion,
  };
}

async function currentPrimaryPairingOwner(db,readerAccess){
  if(readerAccess.circleContext){
    const valid=await validateActiveCircleMutationContext(
      db,readerAccess.circleContext.payload,readerAccess.circleContext,
    );
    if(!valid) throw Object.assign(new Error('pairing reader context changed'),{
      code:'PAIRING_READER_CONTEXT_CHANGED',
    });
  }
  const result=await db.execute(readerAccess.localRuntime?{
    sql:`SELECT id,is_admin FROM auth_accounts
      WHERE id=? AND COALESCE(is_demo,0)=0
      LIMIT 2`,args:[readerAccess.userId],
  }:{
    sql:`SELECT aa.id,cm.role,c.id AS circle_id
      FROM auth_accounts aa
      JOIN circle_memberships cm ON cm.user_id=aa.id
      JOIN circles c ON c.id=cm.circle_id
      WHERE aa.id=? AND cm.status='active'
        AND c.is_primary=1 AND c.archived_at IS NULL
        AND COALESCE(aa.is_demo,0)=0
      LIMIT 2`,args:[readerAccess.userId],
  });
  const rows=result.rows||[];
  if(rows.length!==1||Number(rows[0].id)!==readerAccess.userId
    ||(!readerAccess.localRuntime&&Number(rows[0].circle_id)!==readerAccess.circleId)){
    throw Object.assign(new Error('pairing reader authorization changed'),{
      code:'PAIRING_READER_REVOKED',
    });
  }
  return readerAccess.localRuntime
    ?Number(rows[0].is_admin)===1
    :String(rows[0].role)==='owner';
}

function sendPrimaryPairingReadFailure(res,error){
  if(error?.code==='PAIRING_READER_CONTEXT_CHANGED'){
    return res.status(409).json({ok:false,error:'circle context changed',code:'circle_context_changed'});
  }
  if(error?.code==='PAIRING_READER_REVOKED'){
    return res.status(403).json({ok:false,error:'active circle membership required'});
  }
  return null;
}

function primaryPublicationState(readerAccess,cycle,observedAt,publication,isOwner){
  const scope=readerAccess.localRuntime
    ?{kind:'local'}
    :{kind:'circle',circleId:readerAccess.circleId};
  return pairingPublicationState({
    scope,cycle,observedAt,publishedAt:publication?.publishedAt||null,
    isOwner,
  });
}

async function readPrimaryPairingSnapshot(db,readerAccess,{useApplicationClock=false}={}){
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const now=await pairingReadInstant(transaction,{
      localRuntime:useApplicationClock,
    });
    const cycle=resolvePairingCycle({now});
    const upcomingCycle=resolvePairingCycle({now,state:'upcoming'});
    const publication=await getPairingPublication(transaction,{now});
    const isOwner=await currentPrimaryPairingOwner(transaction,readerAccess);
    const accounts=publication
      ?await loadCurrentPublicationAccounts(transaction,publication,readerAccess)
      :new Map();
    const publicationState=primaryPublicationState(
      readerAccess,cycle,now,publication,isOwner,
    );
    await transaction.commit();
    finished=true;
    return Object.freeze({now,cycle,upcomingCycle,publication,publicationState,accounts});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }finally{ try{ await transaction.close?.(); }catch{} }
}

function safeSecondaryGroups(read){
  if(!read.publication) return [];
  return read.publication.groups.filter(group=>{
    if(!read.accounts.has(group.userAId)) return false;
    return group.isSolo||read.accounts.has(group.userBId);
  });
}

function secondaryPairMember(account){
  return {name:account.name,color:account.color};
}

function secondaryWeeksResponse(read,readerAccess){
  const publicationState=pairingPublicationState({
    scope:read.scope,cycle:read.cycle,observedAt:read.observedAt,
    publishedAt:read.publication?.publishedAt||null,isOwner:read.role==='owner',
  });
  const base={
    ok:true,coordination_only:true,workspace_available:false,
    ...selectedPairingEnvelope({...readerAccess,circlePublicId:read.circlePublicId}),current_cycle:read.cycle,
    upcoming_cycle:resolvePairingCycle({now:new Date(read.cycle.startsAt),state:'upcoming'}),
    filtered_demo:true,current_week_id:null,
    publication_state:publicationState,
  };
  if(!read.publication) return {...base,weeks:[]};
  const pairs=safeSecondaryGroups(read).map(group=>{
    const a=read.accounts.get(group.userAId);
    const b=group.isSolo?null:read.accounts.get(group.userBId);
    return {
      members:[secondaryPairMember(a),...(b?[secondaryPairMember(b)]:[])],solo:group.isSolo,
      topic:'Pick together',topic_kind:'both',created_at:read.publication.publishedAt,
      workspace_available:false,
    };
  });
  return {...base,weeks:[{
    week_label:read.publication.cycle.cycleId,week_start:read.publication.cycle.startsAt,
    focus:'both',created_at:read.publication.publishedAt,is_demo:false,is_current:true,
    coordination_only:true,workspace_available:false,pairs,
  }]};
}

function secondaryMyPairResponse(read,readerAccess,userId){
  const publicationState=pairingPublicationState({
    scope:read.scope,cycle:read.cycle,observedAt:read.observedAt,
    publishedAt:read.publication?.publishedAt||null,isOwner:read.role==='owner',
  });
  const base={
    ok:true,coordination_only:true,workspace_available:false,
    ...selectedPairingEnvelope({...readerAccess,circlePublicId:read.circlePublicId}),cycle:read.cycle,current_cycle:read.cycle,
    upcoming_cycle:resolvePairingCycle({now:new Date(read.cycle.startsAt),state:'upcoming'}),
    publication_state:publicationState,
  };
  if(!read.publication) return {
    ...base,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
    message:'No pairing has been published for the current cycle yet.',
  };
  const eligibility=read.publication.eligibility.find(item=>item.userId===userId);
  if(!eligibility||!eligibility.isAvailable) return {
    ...base,paired:false,pairing_status:eligibility?'unavailable':'missed',
    reason:eligibility?'unavailable_current_cycle':'not_paired_this_cycle',
    message:eligibility
      ?'The published eligibility snapshot records you as unavailable for this cycle.'
      :'You are not in the published eligibility snapshot for this cycle.',
  };
  const group=read.publication.groups.find(item=>item.userAId===userId||item.userBId===userId);
  if(!group) throw new Error('incomplete secondary pairing publication');
  if(group.isSolo) return {
    ...base,paired:true,pairing_status:'solo',pair:{solo:true,workspace_available:false},partners:[],
    message:'Solo practice is assigned. Workspace tools are not enabled for this circle.',
  };
  const partnerId=group.userAId===userId?group.userBId:group.userAId;
  const partner=read.accounts.get(partnerId);
  if(!partner) return {
    ...base,paired:false,pairing_status:'partner_unavailable',reason:'partner_unavailable',
    message:'Your pairing partner is no longer available in this circle.',
  };
  const card=secondaryPairMember(partner);
  const schedule=secondaryCircleSchedulingEnabled()?{
    schedule_available:true,
    schedule_id:secondaryScheduleIdentity({
      generationToken:read.publication.generationToken,groupId:group.id,
    }),
    dashboard_path:'/?view=dashboard',
  }:{};
  return {
    ...base,paired:true,pairing_status:'paired',pair:{solo:false,workspace_available:false},
    partner:card,partners:[card],
    message:secondaryCircleSchedulingEnabled()
      ?'Your current pairing is ready. Agree a time below; workspace tools are not enabled for this circle.'
      :'Your current pairing is ready. Workspace tools are not enabled for this circle.',
    ...schedule,
  };
}

async function loadCurrentPublicationAccounts(db,publication,readerAccess){
  if(!publication.participants.every(item=>item.source==='auth')) throw new Error('unsupported pairing participant source');
  const ids=publication.participants.map(item=>item.userId);
  if(!ids.length) return new Map();
  const placeholders=ids.map(()=>'?').join(',');
  const result=await db.execute(readerAccess.localRuntime?{
    sql:`SELECT id,display_name AS name,color FROM auth_accounts
      WHERE COALESCE(is_demo,0)=0 AND id IN (${placeholders})`,args:ids,
  }:{
    sql:`SELECT aa.id,aa.display_name AS name,aa.color
      FROM auth_accounts aa
      JOIN circle_memberships cm ON cm.user_id=aa.id
      JOIN circles c ON c.id=cm.circle_id
      WHERE cm.circle_id=? AND cm.status='active'
        AND c.is_primary=1 AND c.archived_at IS NULL
        AND COALESCE(aa.is_demo,0)=0 AND aa.id IN (${placeholders})`,
    args:[readerAccess.circleId,...ids],
  });
  const accounts=result.rows||[];
  const accountIds=new Set(accounts.map(row=>Number(row.id)));
  if(accounts.length!==ids.length||accountIds.size!==ids.length||ids.some(id=>!accountIds.has(id))){
    throw new Error('pairing publication is outside the active circle');
  }
  return new Map(accounts.map(row=>[
    Number(row.id),
    {name:String(row.name||`Member ${row.id}`).slice(0,80),color:String(row.color||'#999').slice(0,32)},
  ]));
}

async function pairingReadInstant(db,{localRuntime=false}={}){
  if(localRuntime) return new Date();
  const result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
  const raw=result.rows?.[0]?.now_utc;
  const instant=new Date(raw);
  if(!raw||!Number.isFinite(instant.getTime())) throw new Error('pairing time unavailable');
  return instant;
}

async function getPairAccess(db, payload, weekId, pairId){
  const userId=authenticatedUserId(payload);
  if(!userId) return {allowed:false,exists:false,row:null};
  try{
    const row=await getAuthenticatedPairAccess(db,{userId,weekId,pairGroupId:pairId});
    // Do not expose whether a denied room exists: a missing source snapshot, a
    // legacy participant collision, and an absent pair all have one result.
    return {allowed:!!row,exists:!!row,row};
  }catch(error){
    if(error instanceof TypeError) return {allowed:false,exists:false,row:null};
    throw error;
  }
}

// In-memory rate limit map for client logs per IP
const __logRateMap = new Map(); // ip -> [timestamps]
const __activeExecutionsByUser = new Set();
const EXECUTIONS_PER_MINUTE = 10;
function isLogRateLimited(ip){
  const now=Date.now();
  const arr = __logRateMap.get(ip) || [];
  const fresh = arr.filter(t=> now - t < 60000);
  if(fresh.length >= 60){ __logRateMap.set(ip, fresh); return true; }
  fresh.push(now);
  __logRateMap.set(ip, fresh);
  if(__logRateMap.size>500){ // prune
    for(const [k,v] of __logRateMap.entries()){ if(v.length && now - v[0] > 120000) __logRateMap.delete(k); if(__logRateMap.size<400) break; }
  }
  return false;
}


async function handleHealth(req,res){
  setHealthHeaders(res);
  if(!['GET','HEAD'].includes(String(req?.method||'GET').toUpperCase())){
    res.setHeader('Allow','GET, HEAD');
    return res.status(405).json(UNAVAILABLE_RESPONSE);
  }
  const probe=resolveHealthProbe(req);
  if(probe==='live') return res.status(200).json(HEALTH_RESPONSE);
  if(probe!=='ready') return res.status(400).json(UNAVAILABLE_RESPONSE);
  const configuration=databaseReadinessConfiguration();
  if(!configuration||!readinessTargetExists(configuration)){
    return res.status(503).json(UNAVAILABLE_RESPONSE);
  }
  try{
    const db=getClient();
    const ready=await coalescedDatabaseReadiness(configuration.cacheKey,db,{
      membershipRequired:configuration.membershipRequired,
    });
    return ready
      ?res.status(200).json(READY_RESPONSE)
      :res.status(503).json(UNAVAILABLE_RESPONSE);
  }catch{
    return res.status(503).json(UNAVAILABLE_RESPONSE);
  }
}


async function logServer(level, event, message, meta, reqCtx){
  try{
    const db=getClient();
    if(!reqCtx?.skipEnsure) await ensureDataLogReadiness(db);
    const allowed=['info','warn','error','success','debug'];
    let lvl=String(level||'info').toLowerCase();
    if(!allowed.includes(lvl)) lvl='info';
    const src = (reqCtx && reqCtx.source) ? String(reqCtx.source).slice(0,20) : 'server';
    const ev = event ? String(event).slice(0,80) : null;
    let msg = String(message||'').slice(0,2000);
    let metaStr=null;
    if(meta!=null){
      try{ metaStr = typeof meta==='string' ? meta.slice(0,8000) : JSON.stringify(meta).slice(0,8000); }catch{ metaStr=String(meta).slice(0,8000); }
    }
    let user_id=null;
    try{
      if(reqCtx){
        if(reqCtx.user_id) user_id=reqCtx.user_id;
        else if(reqCtx.payload && (reqCtx.payload.id||reqCtx.payload.uid)) user_id=reqCtx.payload.id||reqCtx.payload.uid;
        else if(reqCtx.userId) user_id=reqCtx.userId;
      }
    }catch{}
    let route=null, ua=null, ip=null;
    try{
      if(reqCtx && reqCtx.route) route=String(reqCtx.route).slice(0,300);
      else if(reqCtx && reqCtx.headers && reqCtx.url) route=String(reqCtx.url).slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.url) route=String(reqCtx.req.url).slice(0,300);
      if(reqCtx && reqCtx.ua) ua=String(reqCtx.ua).slice(0,300);
      else if(reqCtx && reqCtx.headers) ua = (reqCtx.headers['user-agent']||reqCtx.headers['User-Agent']||'').toString().slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ua = (reqCtx.req.headers['user-agent']||'').toString().slice(0,300);
      if(reqCtx && reqCtx.ip) ip=String(reqCtx.ip).slice(0,80);
      else if(reqCtx && reqCtx.headers) ip = (reqCtx.headers['x-forwarded-for']||reqCtx.headers['x-real-ip']||'').toString().split(',')[0].trim().slice(0,80);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ip = (reqCtx.req.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
    }catch{}
    await db.execute({sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`, args:[lvl, src, ev, msg, metaStr, user_id, route, ua, ip]});
    // Forward to Sentry server if error/warn
    try{
      if((lvl==='error' || lvl==='warn') && isSentryConfigured() && !reqCtx?.skipSentry){
        const tags={event: ev||'server', level:lvl, source:src};
        if(lvl==='error'){
          if(meta && meta.stack){
            const e=new Error(msg.slice(0,500));
            e.name=String(ev||'ServerError');
            captureSentryException(e, {tags, extra: {meta: metaStr?.slice(0,2000), route, user_id}});
          }else{
            captureSentryMessage(msg, {level:'error', tags, extra:{meta: metaStr?.slice(0,2000), route}});
          }
        }else if(lvl==='warn'){
          captureSentryMessage(msg, {level:'warning', tags, extra:{meta: metaStr?.slice(0,1500)}});
        }
      }
    }catch(e){ try{ console.warn('[sentry server forward fail]', e && e.message);}catch{} }
  }catch(e){
    // never throw — log to console as fallback
    try{ console.warn('[logServer fail]', e && e.message); }catch{}
  }
}

// Serverless instances may serve many pair-feed polls during their lifetime.
// Schedule readiness remains local because its unique constraint is part of
// the route's concurrency contract; the other data contracts live in the
// shared read-only readiness module.
const __scheduleReadinessByDatabaseUrl=new Map();
const __scheduleReadinessByClient=new WeakMap();

function scheduleReadinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl
    ? {cache:__scheduleReadinessByDatabaseUrl,key:databaseUrl}
    : {cache:__scheduleReadinessByClient,key:db};
}

async function probeScheduleSchema(db){
  const tableInfo=await db.execute(`PRAGMA table_info('pair_schedules')`);
  const columns=new Set(tableInfo.rows.map(row=>String(row.name||'')));
  for(const required of ['week_id','pair_group_id','proposed_times','agreed_time','created_at','updated_at']){
    if(!columns.has(required)) throw new Error(`pair_schedules.${required} is unavailable`);
  }

  const indexList=await db.execute(`PRAGMA index_list('pair_schedules')`);
  const uniqueIndexes=indexList.rows.filter(row=>
    Number(row.unique)===1 && Number(row.partial||0)===0 && typeof row.name==='string'
  );
  let hasPairConstraint=false;
  for(const index of uniqueIndexes){
    const quotedName=index.name.replaceAll('"','""');
    const info=await db.execute(`PRAGMA index_info("${quotedName}")`);
    const names=[...info.rows]
      .sort((left,right)=>Number(left.seqno)-Number(right.seqno))
      .map(row=>String(row.name||''));
    if(names.length===2 && names[0]==='week_id' && names[1]==='pair_group_id'){
      hasPairConstraint=true;
      break;
    }
  }
  if(!hasPairConstraint) throw new Error('pair schedule uniqueness constraint is unavailable');
}

async function ensureScheduleReadiness(db){
  const {cache,key}=scheduleReadinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeScheduleSchema(db);
  cache.set(key,pending);
  try{
    return await pending;
  }catch(error){
    if(cache.get(key)===pending) cache.delete(key);
    throw error;
  }
}


async function handleLogs(req,res){
  // POST: client logs ingest, GET: admin fetch
  if(req.method==='POST'){
    const payload = await getAuthPayload(req);
    if(!payload) return res.status(401).json({error:'authentication required'});
    let db;
    try{
      db=getClient();
      await ensureDataLogReadiness(db);
    }
    catch{ return res.status(503).json({error:'logging unavailable'}); }
    // rate limit by IP
    let ip='';
    try{ ip=(req.headers['x-forwarded-for']||req.headers['x-real-ip']||'').toString().split(',')[0].trim(); if(!ip && req.headers['x-forwarded-for']){ ip=req.headers['x-forwarded-for']; } }catch{}
    if(ip && isLogRateLimited(ip)){
      return res.status(429).json({error:'rate limited — too many logs', retry_after:'60s'});
    }
    const userId = payload.id||payload.uid||null;
    const body = req.body || {};
    // support batch array
    let batch = [];
    if(Array.isArray(body)) batch = body;
    else if(Array.isArray(body.logs)) batch = body.logs;
    else batch = [body];
    const allowedLevels = new Set(['info','warn','error','success','debug']);
    let inserted=0;
    for(const entry of batch.slice(0,20)){ // cap 20 per request
      let lvl = String(entry.level||'info').toLowerCase();
      if(!allowedLevels.has(lvl)) lvl='info';
      const requestedSource = String(entry.source||'client').slice(0,20);
      // The runner namespace is a server-side coordination boundary. Never let
      // browser telemetry create rows that can be mistaken for leases or quota
      // records, even when an authenticated client supplies those names.
      let src = requestedSource==='runner' ? 'client' : requestedSource;
      let ev = entry.event ? String(entry.event).slice(0,80) : null;
      if(ev && (ev==='execute_attempt' || ev.startsWith('execute_lease_'))){
        ev=`client_${ev}`.slice(0,80);
      }
      let msg = String(entry.message||'').slice(0,2000);
      if(!msg) continue;
      let metaStr=null;
      try{
        if(entry.meta!=null) metaStr = typeof entry.meta==='string' ? String(entry.meta).slice(0,8000) : JSON.stringify(entry.meta).slice(0,8000);
        else if(entry.meta_json) metaStr = String(entry.meta_json).slice(0,8000);
      }catch{}
      let route = entry.route ? String(entry.route).slice(0,300) : null;
      if(!route){
        try{ route = (req.url||'').toString().slice(0,300); }catch{}
      }
      let ua = entry.ua ? String(entry.ua).slice(0,300) : (req.headers['user-agent']||'').toString().slice(0,300);
      let entryIp = ip || (req.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
      try{
        await db.execute({sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`, args:[lvl, src, ev, msg, metaStr, userId, route, ua, entryIp]});
        inserted++;
      }catch(e){ /* ignore per entry */ }
      // fire console for visibility in Vercel logs
      try{ if(lvl==='error') console.error(`[client][${ev}] ${msg}`); else if(lvl==='warn') console.warn(`[client][${ev}] ${msg}`); else console.log(`[client][${lvl}][${ev}] ${msg}`);}catch{}
    }
    return res.json({ok:true, inserted});
  }
  if(req.method==='GET'){
    // admin only
    const adminCtx = await requireAdminDT(req,res);
    if(!adminCtx) return;
    const db=adminCtx.db;
    try{ await ensureDataLogReadiness(db); }
    catch{ return res.status(503).json({error:'logging unavailable'}); }
    const url = new URL(req.url,'http://localhost');
    const level = (req.query?.level || url.searchParams.get('level') || '').toString().toLowerCase().trim();
    const event = (req.query?.event || url.searchParams.get('event') || '').toString().trim().slice(0,80);
    const source = (req.query?.source || url.searchParams.get('source') || '').toString().trim().slice(0,20);
    const limitRaw = parseInt(String(req.query?.limit || url.searchParams.get('limit') || '100'),10);
    const limit = Math.min(200, Math.max(1, isNaN(limitRaw)?100:limitRaw));
    const sinceRaw = (req.query?.since || url.searchParams.get('since') || '').toString().trim();
    let where=[]; let args=[];
    if(level && ['info','warn','error','success','debug'].includes(level)){ where.push('level=?'); args.push(level); }
    if(event){ where.push('event=?'); args.push(event); }
    if(source){ where.push('source=?'); args.push(source); }
    if(sinceRaw){
      // allow ISO or id > ?
      const idSince = parseInt(sinceRaw,10);
      if(!isNaN(idSince) && String(idSince)===sinceRaw){ where.push('id>?'); args.push(idSince); }
      else { where.push('created_at>=?'); args.push(sinceRaw); }
    }
    let sql = `SELECT id, level, source, event, message, meta_json, user_id, route, ua, ip, created_at FROM app_logs`;
    if(where.length) sql += ` WHERE ` + where.join(' AND ');
    sql += ` ORDER BY id DESC LIMIT ?`;
    args.push(limit);
    try{
      const rs = await db.execute({sql, args});
      const logs = rs.rows.map(r=>{
        let meta=null;
        try{ meta = r.meta_json ? JSON.parse(r.meta_json) : null; }catch{ meta = r.meta_json; }
        return { id:r.id, level:r.level, source:r.source, event:r.event, message:r.message, meta, meta_json:r.meta_json, user_id:r.user_id, route:r.route, ua:r.ua, ip:r.ip, created_at:r.created_at };
      });
      return res.json({ok:true, logs, count:logs.length});
    }catch(e){ return res.status(500).json({error:'logs fetch failed', detail:String(e.message||e).slice(0,300)}); }
  }
  return res.status(405).json({error:'GET or POST only for logs'});
}

async function handleCircle(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const viewer=await getAuthPayload(req);
  if(!viewer) return res.status(401).json({error:'authentication required'});
  if(circleMembershipEnabled()){
    res.setHeader('Cache-Control','private, no-store');
    const viewerId=authenticatedUserId(viewer);
    if(!viewerId) return res.status(401).json({error:'authentication required'});
    let db;
    try{
      db=getClient();
      await ensureCircleMembershipReadiness(db);
      const activeContext=multiCircleControlPlaneEnabled()
        ?await resolveActiveCircleContext(db,viewer)
        :null;
      if(activeContext&&!activeContext.ok){
        if(activeContext.reason==='selection_required'){
          return res.status(409).json({error:'select an active circle',code:'active_circle_required'});
        }
        return res.status(403).json({error:'circle membership required'});
      }
      if(activeContext&&!activeContext.implicit&&!requestMatchesCircleContext(req,activeContext)){
        return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
      }
      const selectedCircleId=Number(activeContext?.membership?.id||0);
      const result=await db.execute({
	        sql:`WITH viewer_membership AS (
	            SELECT c.id AS circle_id,c.public_id,c.name,cm.role
	            FROM circle_memberships cm
	            JOIN auth_accounts viewer_account ON viewer_account.id=cm.user_id
            JOIN circles c ON c.id=cm.circle_id
            WHERE cm.user_id=? AND cm.status='active'
              AND ${activeContext?'c.id=? AND ':'c.is_primary=1 AND '}c.archived_at IS NULL
            LIMIT 1
          )
          SELECT viewer.circle_id,viewer.public_id,viewer.name AS circle_name,viewer.role,
            account.id,account.display_name,account.color,account.is_available,
            account.bio,account.tz,account.interview_focus,account.leetcode_handle
          FROM viewer_membership viewer
          JOIN circle_memberships member
            ON member.circle_id=viewer.circle_id AND member.status='active'
          JOIN auth_accounts account ON account.id=member.user_id
          WHERE COALESCE(account.is_demo,0)=0
          ORDER BY account.id`,
        args:activeContext?[viewerId,selectedCircleId]:[viewerId],
      });
      const rows=result.rows||[];
      if(!rows.length) return res.status(403).json({error:'circle membership required'});
      const first=rows[0];
      const circle=rows.map(row=>{
        const available=row.is_available==null?true:!!row.is_available;
        const displayName=String(row.display_name||'').trim().slice(0,120);
        return {
          id:Number(row.id),
          display_name:displayName,
          name:displayName,
          color:String(row.color||'').slice(0,32),
          is_available:available,
          isAvailable:available,
          bio:row.bio==null?null:String(row.bio).slice(0,1000),
          tz:row.tz==null?null:String(row.tz).slice(0,100),
          interview_focus:row.interview_focus==null?'both':String(row.interview_focus).slice(0,40),
          leetcode_handle:row.leetcode_handle==null?null:String(row.leetcode_handle).slice(0,100),
          source:'auth',
        };
      });
      return res.json({
        ok:true,
        circle_meta:{id:Number(first.circle_id),public_id:String(first.public_id),name:String(first.circle_name)},
        membership:{role:first.role==='owner'?'owner':'member'},
        ...(activeContext?{circle_context_version:activeContext.context_version||0}:{}),
        circle,
        count:circle.length,
      });
    }catch(error){
      captureSentryException(error,{tags:{event:'circle_membership_fetch_fail',source:'server'}});
      return res.status(503).json({error:'circle unavailable'});
    }
  }
  let db;
  try{
    db=getClient();
    await ensureDataCircleReadiness(db);
  }
  catch{ return res.status(503).json({error:'circle unavailable'}); }
  const includeDemo = (req.query?.include_demo === '1' || req.query?.includeDemo === '1' || req.query?.demo === '1');
  try{
    let sql = includeDemo
      ? `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts ORDER BY id`
      : `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts WHERE COALESCE(is_demo,0)=0 ORDER BY id`;
    const rs = await db.execute(sql);
    if (rs.rows.length){
      const circle = rs.rows.map(r=>{
        const item={ id:r.id, display_name:r.display_name, name:r.display_name, color:r.color, is_demo:!!r.is_demo, source:'auth' };
        item.is_available=r.is_available===null||r.is_available===undefined?true:!!r.is_available;
        item.isAvailable=item.is_available;
        item.bio=r.bio||null;
        item.tz=r.tz||null;
        item.interview_focus=r.interview_focus||'both';
        item.leetcode_handle=r.leetcode_handle||null;
        return item;
      });
      return res.json({ ok:true, circle, count:circle.length, source:'auth_accounts', filtered_demo: !includeDemo });
    }
  }catch{}
  try{
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r=>({ id:r.id, display_name:r.name, name:r.name, color:r.color, created_at:r.created_at, is_available:true, isAvailable:true, is_admin:false, is_demo:false, source:'users' }));
    return res.json({ ok:true, circle, count:circle.length, source:'users' });
  }catch(e){ try{ await logServer('error','circle_fetch_fail', `circle db error ${String(e.message||e).slice(0,150)}`, {err:String(e.message||e).slice(0,500)}, {req, source:'server'}); }catch{} return res.status(500).json({ error:'db error', detail:String(e.message||e).slice(0,200)}); }
}

async function handleWeeks(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  res.setHeader('Cache-Control','private, no-store');
  const payload=await getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'authentication required' });
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let db;
  let legacySchemaReady=false;
  try{
    db=getClient();
    if(!secondaryCircleCoordinationEnabled()||strictLocalPairingRuntime(req)){
      await ensureDataWeeksReadiness(db);
      legacySchemaReady=true;
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  const readerAccess=await requireSelectedPairingReader(req,res,db,payload,userId);
  if(!readerAccess) return;
  if(readerAccess.mode==='secondary'){
    try{
      const read=await readCirclePairing(db,{authority:readerAccess.authority});
      return res.json(secondaryWeeksResponse(read,readerAccess));
    }catch(error){
      const failure=circlePairingFailure(error,{
        contextVersion:readerAccess.circleContextVersion,circlePublicId:readerAccess.circlePublicId,
      });
      return res.status(failure.status).json(failure.body);
    }
  }
  try{
    if(!legacySchemaReady){
      await ensureDataWeeksReadiness(db);
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  try{
    const {cycle:currentCycle,upcomingCycle,publication,publicationState,accounts:idTo}
      =await readPrimaryPairingSnapshot(db,readerAccess,{
        useApplicationClock:readerAccess.localRuntime||localRuntimeRequest(req),
      });
    if(!publication){
      return res.json({
        ok:true,weeks:[],current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
        current_week_id:null,filtered_demo:true,publication_state:publicationState,
        ...selectedPairingEnvelope(readerAccess),
      });
    }
    const person=id=>idTo.get(Number(id))||{name:`Member ${Number(id)}`,color:'#999'};
    const pairs=publication.pairs.map(pair=>{
      const a=person(pair.aId);
      const b=pair.isAI?{name:'Solo practice',color:'var(--accent)'}:person(pair.bId);
      return {
        pg_id:pair.groupId,week_id:publication.weekId,a_id:pair.aId,b_id:pair.bId,c_id:null,
        a_name:a.name,b_name:b.name,c_name:null,a_color:a.color,b_color:b.color,c_color:null,
        members:[{id:pair.aId,name:a.name,color:a.color},{id:pair.bId,name:b.name,color:b.color,is_ai:pair.isAI}],
        is_ai:pair.isAI,is_demo_week:false,topic:'Pick together',topic_kind:'both',created_at:publication.publishedAt,
      };
    });
    const week={
      id:publication.weekId,week_label:publication.cycle.cycleId,week_start:publication.cycle.startsAt,
      focus:'both',created_at:publication.publishedAt,is_demo:false,is_current:true,pairs,
    };
    return res.json({
      ok:true,weeks:[week],current_cycle:publication.cycle,upcoming_cycle:upcomingCycle,
      current_week_id:publication.weekId,filtered_demo:true,publication_state:publicationState,
      ...selectedPairingEnvelope(readerAccess),
    });
  }catch(e){
    const accessFailure=sendPrimaryPairingReadFailure(res,e);
    if(accessFailure) return accessFailure;
    try{ await logServer('error','weeks_fetch_fail','current pairing publication could not be read',{code:String(e?.code||'PAIRING_READ_FAILED')},{req,source:'server'}); }catch{}
    return res.status(503).json({ok:false,error:'pairing unavailable'});
  }
}

async function handleHistory(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload = await getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  let db;
  let groups;
  let completionRows;
  let completionVersionKey;
  const userId = payload.id || payload.uid;
  try{
    db=getClient();
    await ensureDataHistoryReadiness(db);
    completionVersionKey=getJwtSecret();
    const results=await db.batch([{ sql:`
      SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.user_c_id,
             pa.source AS user_a_source,pb.source AS user_b_source,pc.source AS user_c_source,
             pg.is_ai_pair, pg.topic, pg.topic_kind, pw.week_label, pw.week_start
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id = pg.week_id
      JOIN pairing_participants viewer ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
      LEFT JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id
      LEFT JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id
      LEFT JOIN pairing_participants pc ON pc.week_id=pg.week_id AND pc.user_id=pg.user_c_id
      WHERE (pg.user_a_id = ? OR pg.user_b_id = ? OR pg.user_c_id = ?)
      ORDER BY pw.week_start DESC, pg.id DESC
    `, args:[userId,userId,userId,userId] },{
      sql:`SELECT receipt.week_id,receipt.pair_group_id,receipt.user_id,receipt.confirmed_at
        FROM session_completion_receipts receipt
        JOIN pairing_groups pg
          ON pg.id=receipt.pair_group_id AND pg.week_id=receipt.week_id
        JOIN pairing_participants viewer
          ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
        WHERE pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?
        ORDER BY receipt.week_id,receipt.pair_group_id,receipt.user_id`,
      args:[userId,userId,userId,userId],
    }],'read');
    if(!Array.isArray(results)||results.length!==2
      ||!Array.isArray(results[0]?.rows)||!Array.isArray(results[1]?.rows)){
      throw new Error('invalid history result');
    }
    [groups]=results;
    completionRows=results[1].rows;
  }catch{
    return res.status(503).json({error:'history unavailable'});
  }
  const safeGroups=groups.rows.filter(row=>[
    [row.user_a_id,row.user_a_source],[row.user_b_id,row.user_b_source],[row.user_c_id,row.user_c_source],
  ].every(([id,source])=>id==null||source==='auth'||source==='users'));
  const authIds=new Set(),legacyIds=new Set();
  safeGroups.forEach(row=>{
    for(const [id,source] of [[row.user_a_id,row.user_a_source],[row.user_b_id,row.user_b_source],[row.user_c_id,row.user_c_source]]){
      if(id==null) continue;
      (source==='auth'?authIds:legacyIds).add(id);
    }
  });
  const idToName=new Map();
  if(authIds.size){
    const ids=[...authIds],placeholders=ids.map(()=>'?').join(',');
    try{
      const rows=await db.execute({sql:`SELECT id,display_name AS name FROM auth_accounts WHERE id IN (${placeholders})`,args:ids});
      rows.rows.forEach(row=>idToName.set(`auth:${row.id}`,row.name));
    }catch{}
  }
  if(legacyIds.size){
    const ids=[...legacyIds],placeholders=ids.map(()=>'?').join(',');
    try{
      const rows=await db.execute({sql:`SELECT id,name FROM users WHERE id IN (${placeholders})`,args:ids});
      rows.rows.forEach(row=>idToName.set(`users:${row.id}`,row.name));
    }catch{}
  }
  const receiptsByPair=new Map();
  for(const receipt of completionRows){
    const key=`${receipt.week_id}:${receipt.pair_group_id}`;
    const existing=receiptsByPair.get(key)||[];
    existing.push(receipt); receiptsByPair.set(key,existing);
  }
  let enriched;
  try{ enriched = safeGroups.map(r=>{
    const isA = Number(r.user_a_id)===Number(userId);
    const participants=[
      {id:r.user_a_id,source:r.user_a_source},
      {id:r.user_b_id,source:r.user_b_source},
      {id:r.user_c_id,source:r.user_c_source},
    ].filter(member=>member.id!=null&&Number(member.id)!==Number(userId));
    const partners=r.is_ai_pair?[]:participants;
    const partnerIds=partners.map(partner=>partner.id);
    const partnerNames=r.is_ai_pair
      ? ['Solo practice']
      : partners.map(partner=>idToName.get(`${partner.source}:${partner.id}`)||`User ${partner.id}`);
    const pair=canonicalCompletionPair({
      pair_group_id:r.pg_id,week_id:r.week_id,is_ai_pair:r.is_ai_pair,
      user_a_id:r.user_a_id,user_b_id:r.user_b_id,user_c_id:r.user_c_id,
      user_a_source:r.user_a_source,user_b_source:r.user_b_source,user_c_source:r.user_c_source,
    },userId);
    const completion=projectSessionCompletion(pair,
      receiptsByPair.get(`${r.week_id}:${r.pg_id}`)||[],completionVersionKey);
    return { pg_id:r.pg_id, week_id:r.week_id, week_label:r.week_label, week_start:r.week_start, is_ai:!!r.is_ai_pair, topic:r.topic, topic_kind:r.topic_kind, partner_id:partnerIds[0]??null, partner_name:partnerNames.join(' & '), partner_ids:partnerIds, partner_names:partnerNames, you_are_a:isA, completion };
  }); }catch{ return res.status(503).json({error:'history unavailable'}); }
  const partnerCounts={}; enriched.forEach(e=>{ if(!e.is_ai) e.partner_names.forEach(name=>{ partnerCounts[name]=(partnerCounts[name]||0)+1; }); });
  return res.json({ ok:true, user:{ id:payload.id, name:payload.name }, history:enriched, partner_counts:partnerCounts, total:enriched.length });
}

async function handleSessionCompletion(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  if(req.method!=='GET'&&req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({error:'GET or POST only'});
  }
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let input;
  try{
    if(req.method==='GET') input=parseSessionCompletionQuery(req);
    else{ validateSessionCompletionPostQuery(req); input=parseSessionCompletionMutation(req.body); }
  }catch(error){
    if(error instanceof SessionCompletionInputError) return res.status(400).json({error:error.message});
    throw error;
  }
  let db;
  let completionVersionKey;
  try{
    db=getClient();
    await ensureDataSessionCompletionReadiness(db);
    completionVersionKey=getJwtSecret();
  }
  catch{ return res.status(503).json({error:'session completion unavailable'}); }
  try{
    if(req.method==='GET'){
      const read=await readAuthorizedSessionCompletion(db,{
        viewerId:userId,weekId:input.weekId,pairGroupId:input.pairGroupId,
        versionKey:completionVersionKey,
      });
      if(!read) return res.status(404).json({error:'pair not found'});
      return res.json({ok:true,room_id:input.roomId,completion:read.completion});
    }
    const result=await mutateAuthorizedSessionCompletion(db,{
      viewerId:userId,mutation:input,versionKey:completionVersionKey,
    });
    if(result.notFound) return res.status(404).json({error:'pair not found'});
    return res.json({ok:true,room_id:input.roomId,completion:result.completion});
  }catch(error){
    if(error instanceof SessionCompletionConflictError){
      return res.status(409).json({
        error:error.message,code:error.code,room_id:input.roomId,completion:error.completion,
      });
    }
    if(error instanceof SessionCompletionDataError){
      return res.status(503).json({error:'session completion unavailable'});
    }
    return res.status(503).json({error:'session completion unavailable'});
  }
}

async function handleMeetingLink(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  if(req.method!=='GET'&&req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({error:'GET or POST only'});
  }
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let input;
  try{
    if(req.method==='GET') input=parseMeetingLinkQuery(req);
    else{ validateMeetingLinkPostQuery(req); input=parseMeetingLinkMutation(req.body); }
  }catch(error){
    if(error instanceof MeetingLinkInputError) return res.status(400).json({error:error.message});
    throw error;
  }
  let db,versionKey;
  try{
    db=getClient(); await ensureDataMeetingLinkReadiness(db); versionKey=getJwtSecret();
  }catch{ return res.status(503).json({error:'meeting link unavailable'}); }
  if(multiCircleControlPlaneEnabled()&&!strictLocalPairingRuntime(req)){
    const selectionResponse={statusCode:200,body:null,status(code){ this.statusCode=code; return this; },json(body){ this.body=body; return this; }};
    const selected=await requireSelectedPairingReader(req,selectionResponse,db,payload,userId);
    if(!selected){
      if(selectionResponse.statusCode===503) return res.status(503).json({error:'meeting link unavailable'});
      return res.status(404).json({error:'pair not found'});
    }
    if(selected.mode==='secondary') return res.status(404).json({error:'pair not found'});
  }
  try{
    if(req.method==='GET'){
      const transaction=await db.transaction('read');
      let finished=false;
      try{
        const read=await readAuthorizedMeetingLink(transaction,{
          viewerId:userId,weekId:input.weekId,pairGroupId:input.pairGroupId,versionKey,
        });
        if(!read){ await transaction.rollback(); finished=true; return res.status(404).json({error:'pair not found'}); }
        await transaction.commit(); finished=true;
        return res.json({ok:true,room_id:input.roomId,meeting_link:read.state});
      }catch(error){
        if(!finished){ try{ await transaction.rollback(); }catch{} }
        throw error;
      }finally{ try{ await transaction.close?.(); }catch{} }
    }
    const result=await mutateAuthorizedMeetingLink(db,{viewerId:userId,mutation:input,versionKey});
    if(result.notFound) return res.status(404).json({error:'pair not found'});
    return res.json({ok:true,room_id:input.roomId,meeting_link:result.state});
  }catch(error){
    if(error instanceof MeetingLinkConflictError){
      return res.status(409).json({
        error:error.message,code:error.code,room_id:input.roomId,meeting_link:error.state,
      });
    }
    if(error instanceof MeetingLinkDataError) return res.status(503).json({error:'meeting link unavailable'});
    return res.status(503).json({error:'meeting link unavailable'});
  }
}

async function handleInit(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only' });
  const nowSeconds=Math.floor(Date.now()/1000);
  let actor;
  try{ actor=verifySignedRequestAuth(req,{nowSeconds}); }
  catch{ return res.status(503).json({error:'data unavailable'}); }
  if(!actor) return res.status(401).json({error:'authentication required'});
  try{
    const initialized=await initializePrimaryCircleData(getClient(),{
      actor,adminEmails:[...getAdminEmails()],nowSeconds,
    });
    if(!initialized.ok){
      if(initialized.reason==='authentication_required'){
        return res.status(401).json({error:'authentication required'});
      }
      return res.status(403).json({error:'admin only',you_are:initialized.email||'unknown'});
    }
    return res.json({
      ok:true,
      message:'Primary circle data ready',
      circle_id:initialized.circleId,
      changed:initialized.changed,
    });
  }catch(error){
    try{ captureSentryException(error,{tags:{event:'admin_init_failed',source:'server'}}); }catch{}
    return res.status(503).json({error:'data unavailable'});
  }
}

// ----- NEW ENDPOINTS: profile, my-pair, schedule, messages, questions -----

async function handleProfile(req,res){
  const payload = await getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  let db;
  try{
    db=getClient();
    await ensureDataProfileReadiness(db);
  }
  catch{ return res.status(503).json({error:'profile unavailable'}); }
  const userId = payload.id || payload.uid;
  if (!userId) return res.status(401).json({ error:'invalid token payload' });
  if (req.method === 'GET'){
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle FROM auth_accounts WHERE id=?`, args:[userId] });
    if (!rs.rows.length) return res.status(404).json({ error:'user not found' });
    const r = rs.rows[0];
    return res.json({ ok:true, user:{ id:r.id, email:r.email, name:r.display_name, display_name:r.display_name, color:r.color, created_at:r.created_at, last_login:r.last_login, is_available: r.is_available===null?true:!!r.is_available, isAvailable: r.is_available===null?true:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, is_demo:!!r.is_demo, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'' }});
  }
  if (req.method === 'POST'){
    const body = req.body||{};
    const allowed = ['display_name','name','color','bio','tz','interview_focus','leetcode_handle'];
    if(Object.prototype.hasOwnProperty.call(body,'is_available')||Object.prototype.hasOwnProperty.call(body,'isAvailable')){
      return res.status(400).json({
        error:'weekly availability must be updated through /api/settings/availability',
        allowed,
      });
    }
    const updates={};
    if (body.display_name!==undefined) updates.display_name = String(body.display_name).trim().slice(0,32);
    if (body.name!==undefined && updates.display_name===undefined) updates.display_name = String(body.name).trim().slice(0,32);
    if (body.color!==undefined) updates.color = String(body.color).trim().slice(0,16);
    if (body.bio!==undefined) updates.bio = String(body.bio).trim().slice(0,500);
    if (body.tz!==undefined) updates.tz = String(body.tz).trim().slice(0,64);
    if (body.interview_focus!==undefined){
      const v = String(body.interview_focus).toLowerCase();
      if (['dsa','system','both'].includes(v)||['dsa','system_design','both'].includes(v)) updates.interview_focus = v.includes('system')?'system': (v==='dsa'?'dsa':'both');
      else updates.interview_focus = 'both';
    }
    if (body.leetcode_handle!==undefined) updates.leetcode_handle = String(body.leetcode_handle).trim().slice(0,64);
    if (Object.keys(updates).length===0) return res.status(400).json({ error:'no fields to update', allowed });
    const cols = Object.keys(updates);
    const setSql = cols.map(c=>`${c}=?`).join(', ');
    const args = cols.map(c=>updates[c]).concat([userId]);
    try{
      await db.execute({ sql:`UPDATE auth_accounts SET ${setSql} WHERE id=?`, args });
    }catch(e){ return res.status(500).json({ error:'update failed', detail:String(e.message||e).slice(0,200)}); }
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,is_available,availability_updated_at,is_admin,bio,tz,interview_focus,leetcode_handle FROM auth_accounts WHERE id=?`, args:[userId] });
    const r = rs.rows[0];
    return res.json({ ok:true, user:{ id:r.id, email:r.email, name:r.display_name, display_name:r.display_name, color:r.color, is_available:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'' }});
  }
  return res.status(405).json({ error:'GET or POST only' });
}

async function handleMyPair(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  res.setHeader('Cache-Control','private, no-store');
  const payload = await getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let db;
  let legacySchemaReady=false;
  try{
    db=getClient();
    if(!secondaryCircleCoordinationEnabled()||strictLocalPairingRuntime(req)){
      await ensureMyPairDataReadiness(db);
      legacySchemaReady=true;
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  const readerAccess=await requireSelectedPairingReader(req,res,db,payload,userId);
  if(!readerAccess) return;
  if(readerAccess.mode==='secondary'){
    try{
      const read=await readCirclePairing(db,{authority:readerAccess.authority});
      return res.json(secondaryMyPairResponse(read,readerAccess,userId));
    }catch(error){
      const failure=circlePairingFailure(error,{
        contextVersion:readerAccess.circleContextVersion,circlePublicId:readerAccess.circlePublicId,
      });
      return res.status(failure.status).json(failure.body);
    }
  }
  try{
    if(!legacySchemaReady){
      await ensureMyPairDataReadiness(db);
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  let weekId=null, weekRow=null, cycle=null, upcomingCycle=null;
  let publication=null,publicationState=null;
  try{
    const snapshot=await readPrimaryPairingSnapshot(db,readerAccess,{
      useApplicationClock:readerAccess.localRuntime||localRuntimeRequest(req),
    });
    ({cycle,upcomingCycle,publication,publicationState}=snapshot);
    if(publication){
      cycle=publication.cycle;
      weekId=publication.weekId;
      weekRow={id:weekId,week_label:cycle.cycleId,week_start:cycle.startsAt,focus:'both'};
    }
  }catch(error){
    const accessFailure=sendPrimaryPairingReadFailure(res,error);
    if(accessFailure) return accessFailure;
    return res.status(503).json({error:'pairing unavailable'});
  }
  if (!weekId) return res.json({
    ok:true,paired:false,pairing_status:'unpublished',reason:'no_pairing_for_current_cycle',
    cycle,current_cycle:cycle,upcoming_cycle:upcomingCycle,
    publication_state:publicationState,
    message:'No pairing has been published for the current cycle yet.',
    ...selectedPairingEnvelope(readerAccess),
  });
  const isParticipant=publication.participants.some(item=>item.userId===userId&&item.source==='auth');
  const publishedPair=isParticipant
    ?publication.pairs.find(pair=>pair.aId===userId||(!pair.isAI&&pair.bId===userId))
    :null;
  let grp=publishedPair?{
    pg_id:publishedPair.groupId,week_id:weekId,user_a_id:publishedPair.aId,user_b_id:publishedPair.bId,
    user_c_id:null,is_ai_pair:publishedPair.isAI?1:0,topic:'Pick together',topic_kind:'both',
  }:null;
  if (!grp){
    let unavailable=false;
    try{
      unavailable=await hasPrimaryUnavailableEvidence(db,{weekId,userId});
    }catch{
      return res.status(503).json({error:'pairing unavailable'});
    }
    const pairingStatus=unavailable?'unavailable':'missed';
    return res.json({
      ok:true,paired:false,pairing_status:pairingStatus,
      cycle,current_cycle:cycle,upcoming_cycle:upcomingCycle,
      publication_state:publicationState,
      week_id:weekId,week:weekRow||null,
      reason:unavailable?'unavailable_current_cycle':'not_paired_this_cycle',
      message:unavailable
        ?'The published eligibility snapshot records you as unavailable for this cycle.'
        :'You are not in the published eligibility snapshot for this cycle.',
      ...selectedPairingEnvelope(readerAccess),
    });
  }
  const isAI = !!grp.is_ai_pair;
  let partner=null, partners=[];
  if (isAI){
    partner={ id:null, name:'Solo practice', display_name:'Solo practice', color:'#c8f6a0', is_ai:true, is_ai_partner:true, solo_practice:true };
    partners=[partner];
  }else{
    const partnerIds=[grp.user_a_id,grp.user_b_id,grp.user_c_id]
      .filter(id=>id!=null && Number(id)!==Number(userId));
    try{
      const placeholders=partnerIds.map(()=>'?').join(',');
      const accessArgs=authPairAccessArgs({userId,weekId,pairGroupId:grp.pg_id});
      const pr = await db.execute({ sql:`WITH pair_access AS (${authPairAccessSql()})
        SELECT aa.id,aa.display_name,aa.color,aa.bio,aa.tz,aa.interview_focus,aa.leetcode_handle
        FROM auth_accounts aa
        JOIN pairing_participants member
          ON member.week_id=? AND member.user_id=aa.id AND member.source='auth'
        WHERE aa.id IN (${placeholders}) AND EXISTS (SELECT 1 FROM pair_access)`,
        args:[...accessArgs,weekId,...partnerIds] });
      const byId=new Map(pr.rows.map(r=>[Number(r.id),r]));
      partners=partnerIds.map(id=>{
        const r=byId.get(Number(id));
        return r
          ? { id:r.id, name:r.display_name, display_name:r.display_name, color:r.color, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'', is_ai:false }
          : { id, name:`User ${id}`, display_name:`User ${id}`, color:'#9aa0a6', is_ai:false };
      });
    }catch{
      partners=partnerIds.map(id=>({ id, name:`User ${id}`, display_name:`User ${id}`, color:'#9aa0a6', is_ai:false }));
    }
    partner=partners[0]||null;
  }
  let schedule=projectSchedule(readScheduleState(null));
  let scheduleRow=null;
  try{
    const accessArgs=authPairAccessArgs({userId,weekId,pairGroupId:grp.pg_id});
    const s = await db.execute({ sql:`WITH pair_access AS (${authPairAccessSql()}), selected AS (
        SELECT id,week_id,pair_group_id,proposed_times,agreed_time,updated_at
        FROM pair_schedules
        WHERE week_id=? AND pair_group_id=? AND EXISTS (SELECT 1 FROM pair_access)
        LIMIT 1
      )
      SELECT id,week_id,pair_group_id,proposed_times,agreed_time,updated_at,1 AS access_present FROM selected
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,1
        WHERE EXISTS (SELECT 1 FROM pair_access) AND NOT EXISTS (SELECT 1 FROM selected)`,
      args:[...accessArgs,weekId,grp.pg_id] });
    if(!s.rows.length) grp=null;
    else scheduleRow=s.rows.find(row=>row.id!==null&&row.id!==undefined)||null;
  }catch{
    return res.status(503).json({error:'pairing unavailable'});
  }
  if(!grp) return res.status(503).json({error:'pairing unavailable'});
  if(scheduleRow){
    try{ schedule=projectSchedule(readScheduleState(scheduleRow)); }
    catch(error){
      if(error instanceof ScheduleDataError) schedule=null;
      else throw error;
    }
  }
  const meRow = await db.execute({ sql:`SELECT id, display_name, color, tz, interview_focus FROM auth_accounts WHERE id=?`, args:[userId] }).catch(()=>({rows:[]}));
  const me = meRow.rows && meRow.rows[0] ? { id:meRow.rows[0].id, name:meRow.rows[0].display_name, color:meRow.rows[0].color, tz:meRow.rows[0].tz, interview_focus:meRow.rows[0].interview_focus } : { id:userId };
  const roomId = `week_${weekId}_pair_${grp.pg_id}`;
  return res.json({
    ok:true,paired:true,pairing_status:isAI?'solo':'paired',
    cycle,current_cycle:cycle,upcoming_cycle:upcomingCycle,
    publication_state:publicationState,
    room_id:roomId,week_id:weekId,
    week:weekRow
      ?{id:weekRow.id||weekId,week_label:weekRow.week_label,week_start:weekRow.week_start,focus:weekRow.focus}
      :{id:weekId},
    pair:{
      pg_id:grp.pg_id,week_id:weekId,room_id:roomId,
      user_a_id:grp.user_a_id,user_b_id:grp.user_b_id,user_c_id:grp.user_c_id??null,
      is_ai_pair:isAI,is_ai:isAI,solo_practice:isAI,topic:grp.topic,topic_kind:grp.topic_kind,
    },
    partner,partners,me,schedule,...selectedPairingEnvelope(readerAccess),
  });
}

async function fetchAuthorizedScheduleState(db,accessArgs,weekId,pairId){
  const result=await db.execute({
    sql:`WITH pair_access AS (${authPairAccessSql()}), selected AS (
        SELECT proposed_times,agreed_time,updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=?
          AND EXISTS (SELECT 1 FROM pair_access)
        LIMIT 1
      )
      SELECT proposed_times,agreed_time,updated_at,1 AS data_present FROM selected
      UNION ALL SELECT NULL,NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM pair_access) AND NOT EXISTS (SELECT 1 FROM selected)`,
    args:[...accessArgs,weekId,pairId],
  });
  if(!result.rows.length) return {authorized:false,state:null};
  const row=result.rows.find(item=>Number(item.data_present)===1)||null;
  return {authorized:true,state:readScheduleState(row)};
}

async function logScheduleTemporalRejection(scope,error){
  if(!(error instanceof ScheduleTemporalError)) return;
  await logServer('info','schedule_temporal_rejected','schedule mutation rejected by database time',{
    scope:scope==='secondary'?'secondary':'primary',reason:error.reason,
  },{source:'server',skipEnsure:true,skipSentry:true});
}

async function handleSchedule(req,res){
  if(req.method!=='GET' && req.method!=='POST') return res.status(405).json({error:'GET or POST only'});
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  res.setHeader('Cache-Control','private, no-store');
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let db=null;

  if(secondaryCircleSchedulingEnabled()&&!strictLocalPairingRuntime(req)){
    try{ db=getClient(); }
    catch{ return res.status(503).json({error:'schedule unavailable'}); }
    const readerAccess=await requireSelectedPairingReader(req,res,db,payload,userId);
    if(!readerAccess) return;
    if(readerAccess.mode==='secondary'){
      const forbiddenFields=['circle_id','circle_public_id','publication_id','group_id','pair_group_id','pair_id','pg_id','room_id'];
      if(forbiddenFields.some(field=>requestQueryValue(req,field)!==undefined)){
        return res.status(400).json({ok:false,error:'schedule scope is derived from the active circle'});
      }
      try{
        if(req.method==='GET') return res.json(await readSecondarySchedule(db,{authority:readerAccess.authority}));
        const mutation=parseSecondaryScheduleMutation(req.body);
        const result=await mutateSecondarySchedule(db,{authority:readerAccess.authority,mutation});
        return res.status(result.conflict?409:200).json(result.conflict
          ?{...result.response,error:'schedule changed'}:result.response);
      }catch(error){
        try{ await logScheduleTemporalRejection('secondary',error); }catch{}
        const failure=secondaryScheduleFailure(error,{contextVersion:readerAccess.circleContextVersion});
        return res.status(failure.status).json(failure.body);
      }
    }
  }
  const numericRoomFields=['week_id','pair_group_id','pair_id','pg_id'];
  if(numericRoomFields.some(field=>requestQueryValue(req,field)!==undefined)){
    return res.status(400).json({error:'canonical room_id required'});
  }

  let mutation=null;
  let rawRoomId;
  if(req.method==='POST'){
    try{
      mutation=parseScheduleMutation(req.body);
      rawRoomId=mutation.roomId;
    }catch(error){
      if(error instanceof ScheduleInputError) return res.status(400).json({error:error.message});
      throw error;
    }
  }else{
    rawRoomId=requestQueryValue(req,'room_id');
  }
  const room=parseCanonicalRoomId(rawRoomId);
  if(!room) return res.status(400).json({error:'canonical room_id required'});
  if(!db) db=getClient();

  let accessArgs,accessRow;
  try{
    const access=await getPairAccess(db,payload,room.weekId,room.pairGroupId);
    if(!access.allowed) return res.status(404).json({error:'pair not found'});
    accessRow=access.row;
    accessArgs=authPairAccessArgs({userId,weekId:room.weekId,pairGroupId:room.pairGroupId});
  }catch{
    return res.status(503).json({error:'schedule unavailable'});
  }

  try{ await ensureScheduleReadiness(db); }
  catch{ return res.status(503).json({error:'schedule unavailable'}); }

  if(req.method==='GET'){
    try{
      const fetched=await fetchAuthorizedScheduleState(db,accessArgs,room.weekId,room.pairGroupId);
      if(!fetched.authorized) return res.status(404).json({error:'pair not found'});
      return res.json({ok:true,room_id:room.roomId,schedule:projectSchedule(fetched.state)});
    }catch{
      return res.status(503).json({error:'schedule unavailable'});
    }
  }

  try{
    // The version, selected proposal, and database clock are resolved in the
    // same write transaction. A proposal cannot cross the boundary between a
    // preflight read and its compare-and-swap write.
    const transaction=await db.transaction('write');
    let finished=false;
    try{
      const fetched=await fetchAuthorizedScheduleState(
        transaction,accessArgs,room.weekId,room.pairGroupId,
      );
      if(!fetched.authorized){
        await transaction.rollback(); finished=true;
        return res.status(404).json({error:'pair not found'});
      }
      const current=fetched.state;
      if(mutation.baseVersion!==current.version){
        await transaction.rollback(); finished=true;
        return res.status(409).json({
          error:'schedule changed',room_id:room.roomId,schedule:projectSchedule(current),
        });
      }
      const nextValues=applyScheduleMutation(current,mutation,userId);
      const nowUtc=['propose','accept'].includes(mutation.action)
        ?await readScheduleDatabaseNow(transaction):null;
      if(nowUtc) assertFutureScheduleInstant(
        mutation.action,mutation.action==='propose'?mutation.instant:nextValues.agreedTime,nowUtc,
      );
      const nextUpdatedAt=nextScheduleUpdatedAt(
        current.rawUpdatedAt,nowUtc?Date.parse(nowUtc):Date.now(),
      );
      const currentSchedule=projectSchedule(current);
      const nextState=readScheduleState({
        proposed_times:nextValues.proposedTimes,agreed_time:nextValues.agreedTime,updated_at:nextUpdatedAt,
      });
      const nextSchedule=projectSchedule(nextState);
      const notifications=scheduleNotificationEvents({
        weekId:room.weekId,pairGroupId:room.pairGroupId,actorUserId:userId,
        participants:[accessRow.user_a_id,accessRow.user_b_id,accessRow.user_c_id],
        mutation,currentSchedule,nextSchedule,
      });
      let written;
      if(current.exists){
        written=await transaction.execute({
          sql:`UPDATE pair_schedules
            SET proposed_times=?,agreed_time=?,updated_at=?
            WHERE week_id=? AND pair_group_id=?
              AND proposed_times IS ? AND agreed_time IS ? AND updated_at IS ?
              AND EXISTS (${authPairAccessSql()})
            RETURNING proposed_times,agreed_time,updated_at`,
          args:[nextValues.proposedTimes,nextValues.agreedTime,nextUpdatedAt,
            room.weekId,room.pairGroupId,current.rawProposedTimes,current.rawAgreedTime,current.rawUpdatedAt,...accessArgs],
        });
      }else{
        written=await transaction.execute({
          sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
            SELECT ?,?,?,?,?,? WHERE EXISTS (${authPairAccessSql()})
            ON CONFLICT(week_id,pair_group_id) DO NOTHING
            RETURNING proposed_times,agreed_time,updated_at`,
          args:[room.weekId,room.pairGroupId,nextValues.proposedTimes,nextValues.agreedTime,nextUpdatedAt,nextUpdatedAt,...accessArgs],
        });
      }
      if(!written.rows.length){
        await transaction.rollback(); finished=true;
        const latest=await fetchAuthorizedScheduleState(db,accessArgs,room.weekId,room.pairGroupId);
        if(!latest.authorized) return res.status(404).json({error:'pair not found'});
        return res.status(409).json({error:'schedule changed',room_id:room.roomId,schedule:projectSchedule(latest.state)});
      }
      for(const notification of notifications) await transaction.execute(notification);
      await transaction.commit(); finished=true;
      return res.json({ok:true,room_id:room.roomId,schedule:nextSchedule});
    }catch(error){
      if(!finished){ try{ await transaction.rollback(); }catch{} }
      throw error;
    }finally{ try{ await transaction.close?.(); }catch{} }
  }catch(error){
    if(error instanceof ScheduleTemporalError){
      try{ await logScheduleTemporalRejection('primary',error); }catch{}
      return res.status(400).json({error:error.message,code:error.code});
    }
    if(error instanceof ScheduleInputError) return res.status(400).json({error:error.message});
    return res.status(503).json({error:'schedule unavailable'});
  }
}

async function handleMessages(req,res){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='GET'&&req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({error:'GET or POST only'});
  }
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});

  let input;
  try{
    if(req.method==='GET') input=parseMessagesQuery(req);
    else{ validateMessagesPostQuery(req); input=parseMessageSend(req.body); }
  }
  catch(error){
    if(error instanceof MessageInputError) return res.status(error.statusCode).json({error:error.message});
    throw error;
  }

  const db=getClient();
  let access;
  try{ access=await getPairAccess(db,payload,input.weekId,input.pairGroupId); }
  catch{ return res.status(503).json({error:'messages unavailable'}); }
  if(!access.exists||!access.allowed) return res.status(404).json({error:'pair not found'});
  const userId=Number(payload.id||payload.uid);
  const accessArgs=authPairAccessArgs({userId,weekId:input.weekId,pairGroupId:input.pairGroupId});

  try{ await ensureMessagesReadiness(db); }
  catch{ return res.status(503).json({error:'messages unavailable'}); }

  if(req.method==='GET'){
    try{
      const statement=messageReadStatement({
        accessSql:authPairAccessSql(),accessArgs,
        weekId:input.weekId,pairGroupId:input.pairGroupId,
        afterId:input.afterId,limit:input.limit,
      });
      const result=await db.execute(statement);
      if(!result.rows.length){
        let latest;
        try{ latest=await getPairAccess(db,payload,input.weekId,input.pairGroupId); }
        catch{ return res.status(503).json({error:'messages unavailable'}); }
        if(!latest.exists||!latest.allowed) return res.status(404).json({error:'pair not found'});
        return res.status(503).json({error:'messages unavailable'});
      }
      const messages=result.rows.filter(row=>row.id!==null&&row.id!==undefined).map(projectMessage);
      return res.json({ok:true,room_id:input.roomId,messages,after:messages.length?messages.at(-1).id:input.afterId});
    }catch(error){
      if(error instanceof MessageDataError) return res.status(503).json({error:'messages unavailable'});
      return res.status(503).json({error:'messages unavailable'});
    }
  }

  try{
    const senderResult=await db.execute({
      sql:`SELECT id,display_name FROM auth_accounts WHERE id=? LIMIT 1`,
      args:[userId],
    });
    if(!senderResult.rows.length) return res.status(503).json({error:'messages unavailable'});
    const inserted=await db.execute(messageInsertStatement({
      accessSql:authPairAccessSql(),accessArgs,
      weekId:input.weekId,pairGroupId:input.pairGroupId,userId,message:input.message,
    }));
    if(!inserted.rows.length){
      let state;
      try{
        state=await db.execute(messageLimitStateStatement({
          accessSql:authPairAccessSql(),accessArgs,
          weekId:input.weekId,pairGroupId:input.pairGroupId,userId,
        }));
      }
      catch{ return res.status(503).json({error:'messages unavailable'}); }
      const latest=state.rows[0];
      if(!latest||!Number(latest.allowed)){
        return res.status(404).json({error:'pair not found'});
      }
      if(Number(latest.recent_count)>=MAX_MESSAGES_PER_USER_PER_MINUTE){
        res.setHeader('Retry-After',String(MESSAGE_RATE_RETRY_SECONDS));
        return res.status(429).json({error:'message rate limit exceeded'});
      }
      if(Number(latest.room_count)>=MAX_MESSAGES_PER_ROOM){
        return res.status(409).json({error:'message room is full'});
      }
      return res.status(503).json({error:'messages unavailable'});
    }
    const message=projectMessage({...inserted.rows[0],sender_name:senderResult.rows[0].display_name});
    return res.status(201).json({ok:true,room_id:input.roomId,message});
  }catch(error){
    if(error instanceof MessageDataError) return res.status(503).json({error:'messages unavailable'});
    return res.status(503).json({error:'messages unavailable'});
  }
}

async function handlePairRecap(req,res){
  res.setHeader('Cache-Control','private, no-store');
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  if(req.method!=='GET'){
    res.setHeader('Allow','GET');
    return res.status(405).json({error:'GET only'});
  }

  let room;
  try{ room=parsePairRecapQuery(req); }
  catch(error){
    if(error instanceof PairRecapInputError) return res.status(400).json({error:error.message});
    throw error;
  }

  const userId=Number(payload.id||payload.uid);
  let db;
  let completionVersionKey;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'pair recap unavailable'}); }
  const accessSql=authPairAccessSql();
  const accessArgs=authPairAccessArgs({userId,weekId:room.weekId,pairGroupId:room.pairGroupId});
  try{
    const access=await db.execute({sql:accessSql,args:accessArgs});
    if(!access.rows?.length) return res.status(404).json({error:'pair not found'});
    await ensurePairRecapReadiness(db);
    completionVersionKey=getJwtSecret();
  }catch{ return res.status(503).json({error:'pair recap unavailable'}); }

  const pairStatement={
    sql:`WITH access AS (${accessSql})
      SELECT pg.id AS pair_id,pg.week_id,pw.week_label,pw.week_start,
        pg.topic,pg.topic_kind,pg.is_ai_pair,
        pg.user_a_id,CASE pa.source WHEN 'auth' THEN COALESCE(ua.display_name,printf('User %d',pg.user_a_id)) WHEN 'users' THEN COALESCE(ula.name,printf('User %d',pg.user_a_id)) END AS user_a_name,
        pg.user_b_id,CASE pb.source WHEN 'auth' THEN COALESCE(ub.display_name,printf('User %d',pg.user_b_id)) WHEN 'users' THEN COALESCE(ulb.name,printf('User %d',pg.user_b_id)) END AS user_b_name,
        pg.user_c_id,CASE pc.source WHEN 'auth' THEN COALESCE(uc.display_name,printf('User %d',pg.user_c_id)) WHEN 'users' THEN COALESCE(ulc.name,printf('User %d',pg.user_c_id)) END AS user_c_name,
        pa.source AS user_a_source,pb.source AS user_b_source,pc.source AS user_c_source
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id=pg.week_id
      LEFT JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id
      LEFT JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id
      LEFT JOIN pairing_participants pc ON pc.week_id=pg.week_id AND pc.user_id=pg.user_c_id
      LEFT JOIN auth_accounts ua ON ua.id=pg.user_a_id
      LEFT JOIN auth_accounts ub ON ub.id=pg.user_b_id
      LEFT JOIN auth_accounts uc ON uc.id=pg.user_c_id
      LEFT JOIN users ula ON ula.id=pg.user_a_id
      LEFT JOIN users ulb ON ulb.id=pg.user_b_id
      LEFT JOIN users ulc ON ulc.id=pg.user_c_id
      WHERE pg.id=? AND pg.week_id=?
        AND EXISTS (SELECT 1 FROM access)
      LIMIT 1`,
    args:[...accessArgs,room.pairGroupId,room.weekId],
  };
  const scheduleStatement={
    sql:`WITH access AS (${accessSql}), selected AS (
        SELECT ps.agreed_time,ps.updated_at
        FROM pair_schedules ps
        WHERE ps.week_id=? AND ps.pair_group_id=? AND EXISTS (SELECT 1 FROM access)
        LIMIT 1
      )
      SELECT agreed_time,updated_at,1 AS data_present FROM selected
      UNION ALL SELECT NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM access) AND NOT EXISTS (SELECT 1 FROM selected)`,
    args:[...accessArgs,room.weekId,room.pairGroupId],
  };
  const messagesStatement={
    sql:`WITH access AS (${accessSql}), selected AS (
        SELECT pm.id,pm.sender_id,pm.message,pm.created_at,
          CASE sender.source WHEN 'auth' THEN COALESCE(aa.display_name,printf('User %d',pm.sender_id)) WHEN 'users' THEN COALESCE(legacy.name,printf('User %d',pm.sender_id)) END AS sender_name
        FROM pair_messages pm LEFT JOIN auth_accounts aa ON aa.id=pm.sender_id
        LEFT JOIN users legacy ON legacy.id=pm.sender_id
        LEFT JOIN pairing_participants sender ON sender.week_id=pm.week_id AND sender.user_id=pm.sender_id
        WHERE pm.week_id=? AND pm.pair_group_id=? AND sender.source='auth'
          AND EXISTS (SELECT 1 FROM access)
        ORDER BY julianday(pm.created_at) DESC,pm.id DESC LIMIT 50
      )
      SELECT id,sender_id,message,created_at,sender_name,1 AS data_present FROM selected
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM access) AND NOT EXISTS (SELECT 1 FROM selected)
      ORDER BY id DESC`,
    args:[...accessArgs,room.weekId,room.pairGroupId],
  };
  const runsStatement={
    sql:`WITH access AS (${accessSql}), selected AS (
        SELECT sr.id,sr.user_id,sr.question_slug,sr.language,sr.test_cases_snapshot,
          sr.results_json,sr.passed_count,sr.total_count,sr.duration_ms,sr.created_at,
          CASE runner.source WHEN 'auth' THEN COALESCE(aa.display_name,printf('User %d',sr.user_id)) WHEN 'users' THEN COALESCE(legacy.name,printf('User %d',sr.user_id)) END AS runner_display_name
        FROM session_runs sr LEFT JOIN auth_accounts aa ON aa.id=sr.user_id
        LEFT JOIN users legacy ON legacy.id=sr.user_id
        LEFT JOIN pairing_participants runner ON runner.week_id=sr.week_id AND runner.user_id=sr.user_id
        WHERE sr.week_id=? AND sr.pair_group_id=? AND runner.source='auth'
          AND EXISTS (SELECT 1 FROM access)
        ORDER BY julianday(sr.created_at) DESC,sr.id DESC LIMIT ?
      )
      SELECT id,user_id,question_slug,language,test_cases_snapshot,results_json,
        passed_count,total_count,duration_ms,created_at,runner_display_name,1 AS data_present
        FROM selected
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM access) AND NOT EXISTS (SELECT 1 FROM selected)
      ORDER BY id DESC`,
    args:[...accessArgs,room.weekId,room.pairGroupId,MAX_RECAP_RUN_SCAN+1],
  };
  const workspaceStatement={
    sql:`WITH access AS (${accessSql}), selected AS (
        SELECT revision,schema_version,language,question_id,updated_at
        FROM pair_room_snapshots
        WHERE room_id=? AND week_id=? AND pair_group_id=?
          AND EXISTS (SELECT 1 FROM access)
        LIMIT 1
      )
      SELECT revision,schema_version,language,question_id,updated_at,1 AS data_present FROM selected
      UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM access) AND NOT EXISTS (SELECT 1 FROM selected)`,
    args:[...accessArgs,room.roomId,room.weekId,room.pairGroupId],
  };
  const completionStatement={
    sql:`WITH access AS (${accessSql})
      SELECT receipt.user_id,receipt.confirmed_at
      FROM session_completion_receipts receipt
      WHERE receipt.week_id=? AND receipt.pair_group_id=?
        AND EXISTS (SELECT 1 FROM access)
      ORDER BY receipt.user_id`,
    args:[...accessArgs,room.weekId,room.pairGroupId],
  };

  try{
    const results=await db.batch([
      pairStatement,scheduleStatement,messagesStatement,runsStatement,workspaceStatement,
      completionStatement,
    ],'read');
    if(!Array.isArray(results)||results.length!==6){
      return res.status(503).json({error:'pair recap unavailable'});
    }
    const [pairRows,scheduleRows,messageRows,runRows,workspaceRows,completionRows]=results;
    if(!pairRows?.rows?.length||!scheduleRows?.rows?.length||!messageRows?.rows?.length
      ||!runRows?.rows?.length||!workspaceRows?.rows?.length||!completionRows?.rows){
      return res.status(404).json({error:'pair not found'});
    }

    const pair=projectRecapPair(pairRows.rows[0],userId);
    const completionPair=canonicalCompletionPair({
      ...pairRows.rows[0],pair_group_id:pairRows.rows[0].pair_id,
    },userId);
    const completion=projectSessionCompletion(completionPair,completionRows.rows,completionVersionKey);
    const memberIds=new Set(pair.members.filter(member=>!member.is_ai).map(member=>member.id));
    const scheduleRow=scheduleRows.rows.find(row=>Number(row.data_present)===1)||null;
    const schedule=projectRecapSchedule(scheduleRow);
    const messages=messageRows.rows
      .filter(row=>Number(row.data_present)===1)
      .map(projectRecapMessage);
    const storedRuns=runRows.rows.filter(row=>Number(row.data_present)===1);
    const runScanOverflow=storedRuns.length>MAX_RECAP_RUN_SCAN;
    const runs=storedRuns.slice(0,MAX_RECAP_RUN_SCAN)
      .map(row=>projectRecapRun(row,verifyRunAttestation))
      .filter(Boolean);
    if(messages.some(event=>!memberIds.has(event.actor.id))||runs.some(event=>!memberIds.has(event.actor.id))){
      return res.status(503).json({error:'pair recap unavailable'});
    }
    const activity=newestRecapActivity(messages,runs);
    if(runScanOverflow&&runs.length<MAX_RECAP_ACTIVITY){
      return res.status(503).json({error:'pair recap unavailable'});
    }
    const workspaceRow=workspaceRows.rows.find(row=>Number(row.data_present)===1)||null;
    const workspace=projectRecapWorkspace(workspaceRow);
    return res.json({ok:true,room_id:room.roomId,recap:{pair,schedule,activity,workspace,completion}});
  }catch(error){
    if(error instanceof PairRecapDataError) return res.status(503).json({error:'pair recap unavailable'});
    return res.status(503).json({error:'pair recap unavailable'});
  }
}

async function handleQuestions(req,res){
  if(!await getAuthPayload(req)) return res.status(401).json({error:'authentication required'});
  if(req.method!=='GET') return res.status(405).json({error:'the bundled question catalogue is read-only'});

  const requestedSlug=String(req.query?.slug||req.query?.question_slug||'').trim();
  if(requestedSlug){
    const rawVersion=req.query?.version??req.query?.question_version;
    const activeQuestion=rawVersion==null || rawVersion===''
      ? listPublicExercises().find(question=>question.slug===requestedSlug)
      : null;
    if((rawVersion==null || rawVersion==='') && !activeQuestion){
      return res.status(404).json({error:'question not found or unavailable'});
    }
    const requestedVersion=activeQuestion?.version??Number(rawVersion);
    if(!Number.isInteger(requestedVersion) || requestedVersion<1){
      return res.status(400).json({error:'a positive integer question version is required'});
    }
    const question=getPublicExercise(requestedSlug,requestedVersion);
    if(!question) return res.status(404).json({error:'question not found or unavailable'});
    return res.json({ok:true,question});
  }

  const questions=listPublicExercises();
  return res.json({ok:true,questions,count:questions.length});
}

function runResultsDigest(resultsJson){
  return createHash('sha256').update(String(resultsJson||''),'utf8').digest('hex');
}

function runAttestationPayload({userId,questionSlug,questionVersion,language,passedCount,totalCount,resultsJson}){
  return JSON.stringify([
    2,
    Number(userId),
    String(questionSlug),
    Number(questionVersion),
    String(language),
    Number(passedCount),
    Number(totalCount),
    runResultsDigest(resultsJson),
  ]);
}

function runAttestationKeyId(secret){
  return createHash('sha256').update(`randori-run-key\0${secret}`,'utf8').digest('hex').slice(0,16);
}

function runAttestationKeyring(){
  const configured=String(process.env.RUN_ATTESTATION_SECRET||'').trim();
  const current=configured||getJwtSecret();
  if(current.length<32) throw new Error('RUN_ATTESTATION_SECRET must contain at least 32 characters');
  const previous=String(process.env.RUN_ATTESTATION_PREVIOUS_SECRETS||'')
    .split(',')
    .map(value=>value.trim())
    .filter(Boolean);
  if(previous.some(secret=>secret.length<32)){
    throw new Error('every RUN_ATTESTATION_PREVIOUS_SECRETS value must contain at least 32 characters');
  }
  return [current,...previous]
    .filter((secret,index,values)=>values.indexOf(secret)===index)
    .map(secret=>({id:runAttestationKeyId(secret),secret}));
}

function signRunAttestation(fields){
  const key=runAttestationKeyring()[0];
  return {
    keyId:key.id,
    signature:createHmac('sha256',key.secret)
      .update(`randori-run-attestation-v2\0${runAttestationPayload(fields)}`,'utf8')
      .digest('hex'),
  };
}

function verifyRunAttestation(signature,keyId,fields){
  try{
    if(typeof signature!=='string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
    if(typeof keyId!=='string' || !/^[a-f0-9]{16}$/.test(keyId)) return false;
    const key=runAttestationKeyring().find(candidate=>candidate.id===keyId);
    if(!key) return false;
    const supplied=Buffer.from(signature,'hex');
    const expected=Buffer.from(
      createHmac('sha256',key.secret)
        .update(`randori-run-attestation-v2\0${runAttestationPayload(fields)}`,'utf8')
        .digest('hex'),
      'hex',
    );
    return supplied.length===expected.length && timingSafeEqual(supplied,expected);
  }catch{ return false; }
}

function runSummary(row,{includeRunner=false}={}){
  let questionVersion=null;
  let authoritative=false;
  try{
    const snapshot=row.test_cases_snapshot?JSON.parse(row.test_cases_snapshot):null;
    const version=positiveInteger(snapshot?.version);
    const submittingUserId=positiveInteger(row.user_id);
    if(
      submittingUserId
      && snapshot?.source==='original-catalog'
      && snapshot?.attestation_version===2
      && version
      && Number(snapshot.total_count)===Number(row.total_count)
    ){
      authoritative=verifyRunAttestation(snapshot.attestation,snapshot.attestation_key_id,{
        userId:submittingUserId,
        questionSlug:row.question_slug,
        questionVersion:version,
        language:row.language,
        passedCount:row.passed_count,
        totalCount:row.total_count,
        resultsJson:row.results_json,
      });
      if(authoritative) questionVersion=version;
    }
  }catch{}

  const summary={
    id:row.id,
    question_slug:row.question_slug,
    question_version:questionVersion,
    language:row.language,
    passed_count:row.passed_count,
    total_count:row.total_count,
    duration_ms:row.duration_ms,
    created_at:row.created_at,
    authoritative,
  };
  if(includeRunner){
    summary.runner={id:row.user_id,display_name:String(row.runner_display_name||'Member').slice(0,80)};
  }else{
    // Preserve the legacy personal-history projection. Pair feeds deliberately
    // omit the code preview because every member can read those rows.
    summary.week_id=row.week_id;
    summary.pair_group_id=row.pair_group_id;
    summary.question_id=row.question_id;
    summary.code_preview=row.code_preview;
  }
  return summary;
}

async function handleRuns(req,res){
  if(req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET only' });
  const payload = await getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'authentication required' });
  if (req.method === 'POST'){
    return res.status(405).json({error:'run records are created only by the execution service'});
  }
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  const rawRoomId=requestQueryValue(req,'room_id');
  const room=rawRoomId===undefined?null:parseCanonicalRoomId(rawRoomId);
  if(rawRoomId!==undefined&&!room) return res.status(400).json({error:'canonical room_id required'});
  const pairAfterId=room?parseBoundedQueryInteger(requestQueryValue(req,'after_id'),{defaultValue:0,min:0,max:Number.MAX_SAFE_INTEGER}):0;
  if(room&&pairAfterId===null) return res.status(400).json({error:'after_id must be a safe non-negative integer'});
  const pairLimit=room?parseBoundedQueryInteger(requestQueryValue(req,'limit'),{defaultValue:20,min:1,max:20}):null;
  if(room&&pairLimit===null) return res.status(400).json({error:'limit must be an integer from 1 to 20'});
  let db;
  try{
    db=getClient();
    await ensureDataRunsReadiness(db);
  }catch{
    return res.status(503).json({error:'runs unavailable'});
  }
  if (req.method === 'GET'){
    const slug = req.query?.question_slug || req.query?.slug ? String(req.query.question_slug||req.query.slug).slice(0,120) : null;
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query?.limit||'20'),10)||20));
    try{
      if(room){
        const access=await getPairAccess(db,payload,room.weekId,room.pairGroupId);
        if(!access.allowed) return res.status(404).json({error:'pair not found'});
        const accessArgs=authPairAccessArgs({userId,weekId:room.weekId,pairGroupId:room.pairGroupId});
        let pairSql;
        let pairArgs;
        const pairProjection=`sr.id,sr.user_id,sr.question_slug,sr.language,sr.test_cases_snapshot,sr.results_json,sr.passed_count,sr.total_count,sr.duration_ms,sr.created_at,aa.display_name AS runner_display_name`;
        const selectedProjection=`id,user_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at,runner_display_name`;
        if(pairAfterId===0){
          // Bootstrap from the newest bounded window, but return it in the same
          // ascending order used by subsequent incremental requests.
          pairSql=`WITH pair_access AS (${authPairAccessSql()}), selected AS (
            SELECT ${pairProjection}
            FROM session_runs sr
            JOIN pairing_participants runner
              ON runner.week_id=sr.week_id AND runner.user_id=sr.user_id AND runner.source='auth'
            LEFT JOIN auth_accounts aa ON aa.id=sr.user_id
            WHERE sr.week_id=? AND sr.pair_group_id=?
              AND EXISTS (SELECT 1 FROM pair_access
                WHERE sr.user_id=user_a_id OR sr.user_id=user_b_id OR sr.user_id=user_c_id)`;
          pairArgs=[...accessArgs,room.weekId,room.pairGroupId];
          if(slug){ pairSql+=` AND sr.question_slug=?`; pairArgs.push(slug); }
          pairSql+=` ORDER BY sr.id DESC LIMIT ?)
            SELECT ${selectedProjection} FROM selected
            UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
              WHERE EXISTS (SELECT 1 FROM pair_access) AND NOT EXISTS (SELECT 1 FROM selected)
            ORDER BY id ASC`;
          pairArgs.push(pairLimit);
        }else{
          pairSql=`WITH pair_access AS (${authPairAccessSql()}), selected AS (
            SELECT ${pairProjection}
            FROM session_runs sr
            JOIN pairing_participants runner
              ON runner.week_id=sr.week_id AND runner.user_id=sr.user_id AND runner.source='auth'
            LEFT JOIN auth_accounts aa ON aa.id=sr.user_id
            WHERE sr.week_id=? AND sr.pair_group_id=? AND sr.id>?
              AND EXISTS (SELECT 1 FROM pair_access
                WHERE sr.user_id=user_a_id OR sr.user_id=user_b_id OR sr.user_id=user_c_id)`;
          pairArgs=[...accessArgs,room.weekId,room.pairGroupId,pairAfterId];
          if(slug){ pairSql+=` AND sr.question_slug=?`; pairArgs.push(slug); }
          pairSql+=` ORDER BY sr.id ASC LIMIT ?)
            SELECT ${selectedProjection} FROM selected
            UNION ALL SELECT NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL
              WHERE EXISTS (SELECT 1 FROM pair_access) AND NOT EXISTS (SELECT 1 FROM selected)
            ORDER BY id ASC`;
          pairArgs.push(pairLimit);
        }
        const pairRows=await db.execute({sql:pairSql,args:pairArgs});
        if(!pairRows.rows.length) return res.status(404).json({error:'pair not found'});
        const pairRuns=pairRows.rows.filter(row=>row.id!==null&&row.id!==undefined).map(row=>runSummary(row,{includeRunner:true}));
        return res.json({ok:true,room_id:room.roomId,runs:pairRuns,after:pairRuns.length?pairRuns[pairRuns.length-1].id:pairAfterId});
      }
      let sql = `SELECT id,user_id,week_id,pair_group_id,question_id,question_slug,language,substr(code,1,500) as code_preview,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at FROM session_runs WHERE user_id=?`;
      let args=[userId];
      if (slug){ sql+=` AND question_slug=?`; args.push(slug); }
      sql+=` ORDER BY id DESC LIMIT ?`; args.push(limit);
      const rs = await db.execute({ sql, args });
      const runs=rs.rows.map(row=>runSummary(row));
      return res.json({ ok:true, runs, count:runs.length });
    }catch(e){
      if(room) return res.status(503).json({error:'runs unavailable'});
      return res.status(500).json({ error:'fetch failed', detail:String(e.message||e).slice(0,200)});
    }
  }
}

async function handleStats(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  let db;
  try{
    db=getClient();
    await ensureDataStatsReadiness(db);
  }
  catch{ return res.status(503).json({error:'stats unavailable'}); }
  const payload = await getAuthPayload(req); // optional
  let total_users=0, total_weeks=0, total_pairs=0;
  try{
    const u = await db.execute(`SELECT COUNT(*) as c FROM auth_accounts WHERE COALESCE(is_demo,0)=0`);
    total_users = u.rows[0]?.c ?? 0;
  }catch{}
  try{
    const w = await db.execute(`SELECT COUNT(*) as c FROM pairing_weeks WHERE COALESCE(is_demo,0)=0`);
    total_weeks = w.rows[0]?.c ?? 0;
  }catch{}
  try{
    // count pairs in non-demo weeks
    const p = await db.execute(`SELECT COUNT(*) as c FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id WHERE COALESCE(pw.is_demo,0)=0`);
    total_pairs = p.rows[0]?.c ?? 0;
  }catch{
    try{
      const p2 = await db.execute(`SELECT COUNT(*) as c FROM pairing_groups`);
      total_pairs = p2.rows[0]?.c ?? 0;
    }catch{}
  }
  const completedGroupsSql=`WITH completion_counts AS (
      SELECT pg.id,pg.week_id,
        (SELECT COUNT(DISTINCT participant.user_id)
          FROM pairing_participants participant
          WHERE participant.week_id=pg.week_id AND participant.source='auth'
            AND participant.user_id IN (pg.user_a_id,pg.user_b_id,pg.user_c_id)) AS required_count,
        (SELECT COUNT(*) FROM session_completion_receipts receipt
          WHERE receipt.week_id=pg.week_id AND receipt.pair_group_id=pg.id
            AND receipt.user_id IN (pg.user_a_id,pg.user_b_id,pg.user_c_id)
            AND EXISTS (SELECT 1 FROM pairing_participants participant
              WHERE participant.week_id=receipt.week_id AND participant.user_id=receipt.user_id
                AND participant.source='auth')) AS confirmed_count,
        (SELECT COUNT(*) FROM session_completion_receipts receipt
          WHERE receipt.week_id=pg.week_id AND receipt.pair_group_id=pg.id) AS receipt_count
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id=pg.week_id
      WHERE COALESCE(pw.is_demo,0)=0
    )`;
  let total_sessions;
  try{
    const completed=await db.execute(`${completedGroupsSql}
      SELECT COUNT(*) AS c FROM completion_counts
      WHERE required_count>0 AND confirmed_count=required_count AND receipt_count=confirmed_count`);
    total_sessions=Number(completed.rows[0]?.c??0);
    if(!Number.isSafeInteger(total_sessions)||total_sessions<0) throw new Error('invalid completion count');
  }catch{ return res.status(503).json({error:'stats unavailable'}); }
  // Pairing counts and genuinely completed session counts are separate facts.
  const out = { ok:true, total_users, total_weeks, total_pairs, total_sessions, generated_at: new Date().toISOString() };
  if (payload){
    const userId = payload.id || payload.uid;
    try{
      const my = await db.execute({ sql:`SELECT COUNT(*) as c FROM pairing_groups
        JOIN pairing_participants viewer
          ON viewer.week_id=pairing_groups.week_id AND viewer.user_id=? AND viewer.source='auth'
        WHERE user_a_id=? OR user_b_id=? OR user_c_id=?`, args:[userId,userId,userId,userId] });
      out.your_pairings = my.rows[0]?.c ?? 0;
    }catch{}
    try{
      const completed=await db.execute({sql:`${completedGroupsSql}
        SELECT COUNT(*) AS c FROM completion_counts counts
        JOIN pairing_groups pg ON pg.id=counts.id AND pg.week_id=counts.week_id
        JOIN pairing_participants viewer
          ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
        WHERE (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)
          AND counts.required_count>0 AND counts.confirmed_count=counts.required_count
          AND counts.receipt_count=counts.confirmed_count`,args:[userId,userId,userId,userId]});
      out.your_sessions=Number(completed.rows[0]?.c??0);
      if(!Number.isSafeInteger(out.your_sessions)||out.your_sessions<0) throw new Error('invalid completion count');
    }catch{ return res.status(503).json({error:'stats unavailable'}); }
    try{
      const last = await db.execute({ sql:`SELECT pg.id as pg_id, pg.week_id, pw.week_label, pw.week_start, pg.is_ai_pair FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id
        JOIN pairing_participants viewer ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
        WHERE (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?) AND COALESCE(pw.is_demo,0)=0
        ORDER BY pw.week_start DESC,pg.id DESC LIMIT 1`, args:[userId,userId,userId,userId] });
      if (last.rows.length) out.your_last = last.rows[0];
    }catch{}
    try{
      const yWeeks = await db.execute({ sql:`SELECT COUNT(DISTINCT pairing_groups.week_id) as c FROM pairing_groups
        JOIN pairing_participants viewer
          ON viewer.week_id=pairing_groups.week_id AND viewer.user_id=? AND viewer.source='auth'
        WHERE user_a_id=? OR user_b_id=? OR user_c_id=?`, args:[userId,userId,userId,userId] });
      out.your_weeks = yWeeks.rows[0]?.c ?? 0;
    }catch{}
  }
  // The shared cycle resolver keeps this boundary correct across GMT/BST.
  try{
    const nextCycle=resolvePairingCycle({state:'upcoming'});
    const next = new Date(nextCycle.startsAt);
    const nextLabel=new Intl.DateTimeFormat('en-GB',{
      timeZone:nextCycle.timeZone,weekday:'long',year:'numeric',month:'short',day:'numeric',
      hour:'2-digit',minute:'2-digit',timeZoneName:'short',
    }).format(next);
    out.next_cycle=nextCycle;
    out.next_shuffle_utc = next.toISOString();
    out.next_shuffle_label = `${nextLabel} • ${nextCycle.timeZone}`;
  }catch{}
  return res.json(out);
}

// ----- Manual external problem link; remote ingestion is intentionally absent -----
async function handleLeetcode(req,res){
  if (req.method!=='GET') return res.status(405).json({ error:'GET only for external problem links' });
  if(!await getAuthPayload(req)) return res.status(401).json({error:'authentication required'});
  const externalRequestUrl = new URL(req.url, 'http://localhost');
  let externalSlug = String(
    req.query?.slug || externalRequestUrl.searchParams.get('slug') || '',
  ).trim().toLowerCase();
  if (!externalSlug) {
    const parts = externalRequestUrl.pathname.split('/').filter(Boolean);
    const index = parts.findIndex(part => part.toLowerCase() === 'leetcode');
    if (index >= 0 && parts[index + 1] && parts[index + 1].toLowerCase() !== 'sync') {
      externalSlug = parts[index + 1].toLowerCase();
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(externalSlug) || externalSlug.length > 120) {
    return res.status(400).json({error:'a lowercase kebab-case slug is required'});
  }
  return res.json({
    ok:true,
    content_available:false,
    source:'external-link',
    slug:externalSlug,
    external_url:`https://leetcode.com/problems/${encodeURIComponent(externalSlug)}/`,
    automated_fetch:false,
  });
}

async function handleLeetcodeSync(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for leetcode-sync' });
  if(!await getAuthPayload(req)) return res.status(401).json({error:'authentication required'});
  return res.status(410).json({
    error:'automated LeetCode ingestion is unavailable; use the external-link workflow',
    automated_fetch:false,
  });
}


async function pistonVersions(){
  try{
    const r = await fetchWithTimeout('https://emkc.org/api/v2/piston/runtimes', {}, 6000);
    if(r.ok){ const j=await r.json(); return j; }
  }catch{} return [];
}

async function callPistonAPI(language, version, files){
  const body = { language, version, files: files.map(f=>({name:f.name, content:f.content})) };
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  const maxResponseBytes=256*1024;
  try{
    const r=await fetch('https://emkc.org/api/v2/piston/execute',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body),
      signal:controller.signal,
    });
    if(!r.ok) throw new Error(`piston request failed with status ${r.status}`);
    const declaredLength=Number(r.headers.get('content-length'));
    if(Number.isFinite(declaredLength) && declaredLength>maxResponseBytes){
      controller.abort();
      throw new Error('piston response exceeded size limit');
    }
    const reader=r.body?.getReader?.();
    if(!reader){
      const text=await r.text();
      if(Buffer.byteLength(text,'utf8')>maxResponseBytes) throw new Error('piston response exceeded size limit');
      return JSON.parse(text);
    }
    const chunks=[];
    let received=0;
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      received+=value.byteLength;
      if(received>maxResponseBytes){
        await reader.cancel().catch(()=>{});
        throw new Error('piston response exceeded size limit');
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks,received).toString('utf8'));
  }finally{
    clearTimeout(timeout);
  }
}

function encodeRunnerPayload(value){
  return Buffer.from(JSON.stringify(value),'utf8').toString('base64');
}

function buildJsHarness(userCode,testSuite,resultPrefix){
  const encodedSuite=encodeRunnerPayload({
    entrypoint:testSuite.entrypoint,
    tests:testSuite.tests.map(test=>({args:test.args})),
  });
  const encodedCode=Buffer.from(userCode,'utf8').toString('base64');
  return `;(function(){
  const __randori_bundle=JSON.parse(Buffer.from('${encodedSuite}','base64').toString('utf8'));
  const __randori_source=Buffer.from('${encodedCode}','base64').toString('utf8');
  const __randori_vm=require('node:vm');
  const __randori_context=__randori_vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  let __randori_ready=true;
  try{ __randori_vm.runInContext(__randori_source,__randori_context,{timeout:1000}); }catch{ __randori_ready=false; }
  for(let index=0;index<__randori_bundle.tests.length;index++){
    const test=__randori_bundle.tests[index];
    let got=null, ok=false, error=null;
    try{
      if(!__randori_ready) throw new Error('submission did not load');
      __randori_context.__randori_args_json__=JSON.stringify(test.args);
      const expression='JSON.stringify('+__randori_bundle.entrypoint+'(...JSON.parse(__randori_args_json__)))';
      const serialized=__randori_vm.runInContext(expression,__randori_context,{timeout:1000});
      got=JSON.parse(serialized);
      ok=true;
    }catch{ error='runtime error'; }
    process.stdout.write('${resultPrefix}'+JSON.stringify({idx:index,ok,got,error})+'\\n');
  }
})();
`;
}

function buildPythonHarness(userCode,testSuite,resultPrefix){
  const encodedSuite=encodeRunnerPayload({
    entrypoint:testSuite.entrypoint,
    tests:testSuite.tests.map(test=>({args:test.args})),
  });
  const encodedCode=Buffer.from(userCode,'utf8').toString('base64');
  return `import base64 as __randori_base64
import json as __randori_json

def __randori_run():
    bundle=__randori_json.loads(__randori_base64.b64decode('${encodedSuite}').decode('utf-8'))
    source=__randori_base64.b64decode('${encodedCode}').decode('utf-8')
    safe_builtins={
        'Exception':Exception,'IndexError':IndexError,'KeyError':KeyError,'TypeError':TypeError,
        'ValueError':ValueError,'abs':abs,'all':all,'any':any,'bool':bool,'chr':chr,'dict':dict,'divmod':divmod,
        'enumerate':enumerate,'filter':filter,'float':float,'int':int,'isinstance':isinstance,
        'len':len,'list':list,'map':map,'max':max,'min':min,'next':next,'object':object,'ord':ord,
        'pow':pow,'range':range,'reversed':reversed,'round':round,'set':set,'sorted':sorted,
        'str':str,'sum':sum,'tuple':tuple,'zip':zip,
    }
    namespace={'__builtins__':safe_builtins}
    ready=True
    try:
        exec(compile(source,'submission.py','exec'),namespace,namespace)
    except Exception:
        ready=False
    fn=namespace.get(bundle['entrypoint'])
    for index,test in enumerate(bundle['tests']):
        ok=False
        got=None
        error=None
        try:
            if not ready or not callable(fn):
                raise RuntimeError('entrypoint not found')
            got=fn(*test['args'])
            __randori_json.dumps(got,separators=(',',':'))
            ok=True
        except Exception:
            error='runtime error'
        print('${resultPrefix}'+__randori_json.dumps({'idx':index,'ok':ok,'got':got,'error':error},separators=(',',':')))

__randori_run()
`;
}

function runnerValuesEqual(a,b){
  if(Object.is(a,b)) return true;
  if(Array.isArray(a) && Array.isArray(b)){
    return a.length===b.length && a.every((value,index)=>runnerValuesEqual(value,b[index]));
  }
  if(a && b && typeof a==='object' && typeof b==='object'){
    const aKeys=Object.keys(a), bKeys=Object.keys(b);
    return aKeys.length===bKeys.length
      && aKeys.every(key=>Object.prototype.hasOwnProperty.call(b,key) && runnerValuesEqual(a[key],b[key]));
  }
  return false;
}

function normalizeRunnerResults(stdout,resultPrefix,tests){
  const byIndex=new Map();
  for(const line of String(stdout||'').split('\n')){
    const value=line.trim();
    if(!value.startsWith(resultPrefix) || value.length>100000) continue;
    try{
      const parsed=JSON.parse(value.slice(resultPrefix.length));
      if(!Number.isInteger(parsed.idx) || parsed.idx<0 || parsed.idx>=tests.length || typeof parsed.ok!=='boolean') continue;
      const pass=parsed.ok && runnerValuesEqual(parsed.got,tests[parsed.idx].expected);
      byIndex.set(parsed.idx,{idx:parsed.idx,pass,error:parsed.error ? 'runtime error' : null});
    }catch{}
  }
  return tests.map((_,idx)=>byIndex.get(idx)||{idx,pass:false,error:'no result'});
}

function positiveInteger(value){
  const parsed=Number(value);
  return Number.isInteger(parsed) && parsed>0 ? parsed : null;
}

async function acquireExecutionLease(db,userId,req,metadata){
  const route=String(req.url||'').slice(0,300);
  const userAgent=String(req.headers?.['user-agent']||'').slice(0,300);
  const ip=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80);
  const result=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
      SELECT 'info','runner','execute_lease_start','execution lease acquired',?,?,?,?,?, datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM app_logs lease_start
        WHERE lease_start.user_id=?
          AND lease_start.source='runner'
          AND lease_start.event='execute_lease_start'
          AND datetime(lease_start.created_at)>=datetime('now','-30 seconds')
          AND NOT EXISTS (
            SELECT 1 FROM app_logs lease_end
            WHERE lease_end.user_id=lease_start.user_id
              AND lease_end.source='runner'
              AND lease_end.event='execute_lease_end'
              AND lease_end.id>lease_start.id
              AND lease_end.message=CAST(lease_start.id AS TEXT)
          )
      )
      RETURNING id`,
    args:[JSON.stringify(metadata),userId,route,userAgent,ip,userId],
  });
  return positiveInteger(result.rows[0]?.id);
}

async function releaseExecutionLease(db,userId,leaseId,req){
  if(!leaseId) return;
  try{
    await db.execute({
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES ('info','runner','execute_lease_end',?,?,?,?,?,?, datetime('now'))`,
      args:[String(leaseId),JSON.stringify({lease_id:leaseId}),userId,String(req.url||'').slice(0,300),String(req.headers?.['user-agent']||'').slice(0,300),String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80)],
    });
  }catch(e){
    captureSentryException(e,{tags:{event:'execute_lease_release_fail',source:'runner'}});
  }
}

async function handleExecute(req,res){
  const _execStart=Date.now();
  if(req.method!=='POST') return res.status(405).json({error:'POST only for execute'});
  const payload=await getAuthPayload(req);
  if(!payload) return res.status(401).json({error:'authentication required'});
  const body = req.body || {};
  const language = String(body.language||body.lang||'javascript').toLowerCase();
  const map = {js:'javascript', javascript:'javascript', py:'python', python:'python'};
  const pistonLang = map[language];
  if(!pistonLang) return res.status(400).json({error:'supported languages are javascript and python'});
  const code = String(body.code||'');
  if(!code) return res.status(400).json({error:'code required'});
  if(Buffer.byteLength(code,'utf8')>20000) return res.status(413).json({error:'code exceeds the 20000-byte limit'});

  const questionSlug=String(body.question_slug||body.slug||'').trim().slice(0,120);
  if(!questionSlug) return res.status(400).json({error:'question_slug required'});
  const rawQuestionVersion=body.question_version??body.version;
  const questionVersion=rawQuestionVersion==null || rawQuestionVersion===''
    ? listPublicExercises().find(question=>question.slug===questionSlug)?.version??null
    : positiveInteger(rawQuestionVersion);
  if(rawQuestionVersion!=null && rawQuestionVersion!=='' && !questionVersion){
    return res.status(400).json({error:'question_version must be a positive integer'});
  }
  const testSuite=createEvaluationSuite(questionSlug,questionVersion,pistonLang);
  if(!testSuite) return res.status(404).json({error:'question not found or unavailable'});

  const hasRoomId=Object.prototype.hasOwnProperty.call(body,'room_id');
  const numericRoomFields=['week_id','pair_group_id','pg_id','pair_id'];
  if(hasRoomId&&numericRoomFields.some(field=>Object.prototype.hasOwnProperty.call(body,field))){
    return res.status(400).json({error:'room_id cannot be combined with numeric room identifiers'});
  }
  const room=hasRoomId?parseCanonicalRoomId(body.room_id):null;
  if(hasRoomId&&!room) return res.status(400).json({error:'canonical room_id required'});

  let weekId=room?.weekId??null;
  let pairId=room?.pairGroupId??null;
  if(!hasRoomId){
    weekId=body.week_id==null || body.week_id==='' ? null : positiveInteger(body.week_id);
    const rawPairId=body.pair_group_id??body.pg_id??body.pair_id;
    pairId=rawPairId==null || rawPairId==='' ? null : positiveInteger(rawPairId);
    if((weekId===null)!==(pairId===null)) return res.status(400).json({error:'week_id and pair_group_id must be provided together'});
    if((body.week_id!=null && body.week_id!=='' && !weekId) || (rawPairId!=null && rawPairId!=='' && !pairId)){
      return res.status(400).json({error:'week_id and pair_group_id must be positive integers'});
    }
  }

  // Schema creation is a deploy-time migration concern. Request handling stays
  // read/write-only and fails closed if the deployment has not been prepared.
  // Resolve and validate client room identifiers before touching the database.
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'execution service unavailable'}); }
  let accessArgs=null;
  if(weekId && pairId){
    try{
      const access=await getPairAccess(db,payload,weekId,pairId);
      if(!access.allowed) return res.status(404).json({error:'pair not found'});
      accessArgs=authPairAccessArgs({userId:Number(payload.id||payload.uid),weekId,pairGroupId:pairId});
    }catch{
      return res.status(503).json({error:'execution service unavailable'});
    }
  }

  // Client test cases and result/count fields are deliberately ignored. The exact
  // versioned suite is resolved above from the private server catalogue.
  const runtimeVersions={javascript:'18.15.0',python:'3.10.0'};
  const runtimeVersion=runtimeVersions[pistonLang];
  const resultPrefix=`__RANDORI_RESULT_${randomBytes(16).toString('hex')}__:`;
  const harness=pistonLang==='javascript'
    ? buildJsHarness(code,testSuite,resultPrefix)
    : buildPythonHarness(code,testSuite,resultPrefix);
  const filename=pistonLang==='javascript' ? 'main.js' : 'main.py';

  const userId=positiveInteger(payload.id||payload.uid);
  if(!userId) return res.status(401).json({error:'authentication required'});
  const executionKey=String(userId);
  if(__activeExecutionsByUser.has(executionKey)){
    return res.status(429).json({error:'an execution is already in progress',retry_after_seconds:1});
  }
  __activeExecutionsByUser.add(executionKey);
  let leaseId=null;
  try{
    leaseId=await acquireExecutionLease(db,userId,req,{question_slug:questionSlug,question_version:questionVersion,language:pistonLang});
    if(!leaseId){
      __activeExecutionsByUser.delete(executionKey);
      return res.status(429).json({error:'an execution is already in progress',retry_after_seconds:30});
    }
    const rateResults=await db.batch([{
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES ('info','runner','execute_attempt','execution requested',?,?,?,?,?, datetime('now'))`,
      args:[JSON.stringify({question_slug:questionSlug,question_version:questionVersion,language:pistonLang}),userId,String(req.url||'').slice(0,300),String(req.headers?.['user-agent']||'').slice(0,300),String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim().slice(0,80)],
    },{
      sql:`SELECT COUNT(*) as c FROM app_logs WHERE user_id=? AND source='runner' AND event='execute_attempt' AND datetime(created_at)>=datetime('now','-1 minute')`,
      args:[userId],
    }],'write');
    const recent=rateResults[1];
    if(Number(recent?.rows?.[0]?.c||0)>EXECUTIONS_PER_MINUTE){
      await releaseExecutionLease(db,userId,leaseId,req);
      leaseId=null;
      __activeExecutionsByUser.delete(executionKey);
      return res.status(429).json({error:'execution rate limit exceeded',retry_after_seconds:60});
    }
  }catch(e){
    await releaseExecutionLease(db,userId,leaseId,req);
    leaseId=null;
    __activeExecutionsByUser.delete(executionKey);
    captureSentryException(e,{tags:{event:'execute_rate_limit_fail',source:'runner'}});
    return res.status(503).json({error:'execution service unavailable'});
  }

  try{
    const pistonRes = await callPistonAPI(pistonLang,runtimeVersion,[{name:filename,content:harness}]);
    const run = pistonRes.run || {};
    const stdout = String(run.stdout||'');
    const stderr = String(run.stderr||'');
    const results=normalizeRunnerResults(stdout,resultPrefix,testSuite.tests);
    const passed = results.filter(r=>r.pass===true).length;
    const dur = Date.now()-_execStart;
    const total=testSuite.tests.length;
    let runId=null;
    try{
      const storedResults=JSON.stringify(results);
      const attestation=signRunAttestation({
        userId,
        questionSlug,
        questionVersion,
        language:pistonLang,
        passedCount:passed,
        totalCount:total,
        resultsJson:storedResults,
      });
      const testSnapshot=JSON.stringify({source:'original-catalog',version:questionVersion,total_count:total,attestation_version:2,attestation_key_id:attestation.keyId,attestation:attestation.signature});
      const runArgs=[payload.id||payload.uid,weekId,pairId,null,questionSlug,pistonLang,code,testSnapshot,storedResults,passed,total,dur];
      const inserted=accessArgs
        ? await db.execute({
          sql:`WITH pair_access AS (${authPairAccessSql()})
            INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')
            WHERE EXISTS (SELECT 1 FROM pair_access)
            RETURNING id`,
          args:[...accessArgs,...runArgs],
        })
        : await db.execute({
          sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')) RETURNING id`,
          args:runArgs,
        });
      if(accessArgs&&!inserted.rows.length){
        const latest=await getPairAccess(db,payload,weekId,pairId);
        if(!latest.allowed) return res.status(404).json({error:'pair not found'});
        throw new Error('authorized run insert returned no row');
      }
      runId=inserted.rows[0]?.id??null;
    }catch(e){
      captureSentryException(e,{tags:{event:'run_persist_fail',source:'runner'},extra:{question_slug:questionSlug,question_version:questionVersion}});
      if(accessArgs) return res.status(503).json({ok:false,error:'execution service unavailable'});
      return res.status(500).json({ok:false,error:'execution result could not be saved'});
    }
    try{ await logServer(passed===total?'success':'info','execute_success',`piston ${pistonLang} ${passed}/${total} in ${dur}ms`,{language:pistonLang,runtimeVersion,questionSlug,questionVersion,passed,total,dur,hasStderr:!!stderr,runId},{req,payload,source:'runner',route:req.url,skipEnsure:true}); }catch{}
    await releaseExecutionLease(db,userId,leaseId,req);
    leaseId=null;
    __activeExecutionsByUser.delete(executionKey);
    return res.json({
      ok:true,
      question_slug:questionSlug,
      question_version:questionVersion,
      language:pistonLang,
      version:runtimeVersion,
      runtime_version:runtimeVersion,
      piston:{
        code:Number.isInteger(run.code)?run.code:null,
        signal:typeof run.signal==='string'?run.signal.slice(0,64):null,
        has_stderr:!!stderr,
      },
      results,
      passed_count:passed,
      total_count:total,
      run_id:runId,
    });
  }catch(e){
    try{ await logServer('error','execute_fail',`piston ${pistonLang} request failed`,{language:pistonLang},{req,source:'runner',route:req.url,skipEnsure:true}); }catch{}
    return res.status(500).json({ok:false,error:'piston execute failed',language:pistonLang});
  }finally{
    await releaseExecutionLease(db,userId,leaseId,req);
    __activeExecutionsByUser.delete(executionKey);
  }
}

const MULTI_CIRCLE_UNSCOPED_DATA_ENDPOINTS=new Set([
  'runs','session_runs','session-runs','weeks','history','stats','my-pair','mypair','my_pair',
  'pair-recap','session-completion','meeting-link','schedule','messages','message','execute','run',
]);

async function requireSingleCircleDataFeature(req,res,endpoint){
  if(!multiCircleControlPlaneEnabled()||!MULTI_CIRCLE_UNSCOPED_DATA_ENDPOINTS.has(endpoint)) return true;
  if(endpoint==='meeting-link') return true;
  if(secondaryCircleCoordinationEnabled()&&(endpoint==='weeks'||endpoint==='my-pair')) return true;
  if(secondaryCircleSchedulingEnabled()&&endpoint==='schedule') return true;
  try{
    const payload=await getAuthPayload(req);
    const userId=authenticatedUserId(payload);
    if(!userId) return true;
    const db=getClient();
    await ensureCircleMembershipReadiness(db);
    if(!await canUseLegacySinglePrimaryCircleFeatures(db,payload)){
      sendMultiCircleFeatureUnavailable(res);
      return false;
    }
    return true;
  }catch{
    res.status(503).json({error:'circle context unavailable'});
    return false;
  }
}

export default async function handler(req,res){
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  try{ 
    try{ initSentry(); }catch{}
  }catch{}
  try{
  const ep=getEndpoint(req);
  const route=resolveDataRoute(req,ep);
  if(!await requireSingleCircleDataFeature(req,res,route)) return;
  if(route==='runs') return await handleRuns(req,res);
  if(route==='leetcode-sync') return await handleLeetcodeSync(req,res);
  if(route==='leetcode') return await handleLeetcode(req,res);
  if(route==='circle') return await handleCircle(req,res);
  if(route==='weeks') return await handleWeeks(req,res);
  if(route==='history') return await handleHistory(req,res);
  if(route==='stats') return await handleStats(req,res);
  if(route==='init') return await handleInit(req,res);
  if(route==='profile') return await handleProfile(req,res);
  if(route==='my-pair') return await handleMyPair(req,res);
  if(route==='pair-recap') return await handlePairRecap(req,res);
  if(route==='session-completion') return await handleSessionCompletion(req,res);
  if(route==='meeting-link') return await handleMeetingLink(req,res);
  if(route==='schedule') return await handleSchedule(req,res);
  if(route==='messages') return await handleMessages(req,res);
  if(route==='execute') return await handleExecute(req,res);
  if(route==='health') return await handleHealth(req,res);
  if(route==='logs') return await handleLogs(req,res);
  if(route==='questions') return await handleQuestions(req,res);
  return res.status(404).json({ error:`unknown data endpoint '${ep}'`, available:['health','runs','execute','logs','leetcode','leetcode-sync','circle','weeks','history','stats','init','profile','my-pair','pair-recap','session-completion','meeting-link','schedule','messages','questions'] });
  }catch(e){
    const failedEndpoint=getEndpoint(req);
    const failedPath=String(req?.url||'').toLowerCase();
    const skipEnsure=failedEndpoint==='execute'||failedEndpoint==='run'||failedPath.includes('/execute');
    try{ await logServer('error','api_unhandled', String(e && e.message||e).slice(0,500), {stack: e && e.stack ? String(e.stack).slice(0,2000):'', url: req && req.url}, {req, source:'server', route: req && req.url, skipSentry:true, skipEnsure}); }catch{}
    captureSentryException(e, {tags:{event:'api_unhandled', source:'server'}, extra:{route:req && req.url}});
    try{ console.error('[api unhandled]', e && e.stack||e); }catch{}
    return res.status(500).json({error:'internal', detail: String(e && e.message||e).slice(0,300)});
  }
}
