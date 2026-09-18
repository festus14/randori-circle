import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getClient, getCronSecret, getAdminEmails, isoWeekLabel, deterministicColor, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { buildFairPairing, canonicalRoomId, escapeHtml } from './_pairing.js';
import { pairingCronIsDue, resolvePairingCycle } from './_pairing-cycle.js';
import { getPairingPublication, publishPairingCycle } from './_pairing-publication.js';
import { localIdentityAdapterEnabled } from './_local-runtime.js';

const MAX_EMAIL_ATTEMPTS=5;
const PAIRING_TRANSACTION_ATTEMPTS=4;

function pairingRetryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1)))));
}

function isRetryablePairingConflict(error){
  let current=error;
  for(let depth=0;current&&depth<5;depth+=1){
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

function productionAccountQuery({availableOnly=false,includePhone=false,countOnly=false}={}){
  const membership=`EXISTS (
    SELECT 1
    FROM circle_memberships cm
    JOIN circles c ON c.id=cm.circle_id
    WHERE cm.user_id=auth_accounts.id
      AND cm.status='active'
      AND c.is_primary=1
      AND c.archived_at IS NULL
  )`;
  const availability=availableOnly?' AND COALESCE(is_available,1)=1':'';
  if(countOnly) return `SELECT COUNT(*) as c FROM auth_accounts WHERE COALESCE(is_demo,0)=0${availability} AND ${membership}`;
  const phone=includePhone?', phone':'';
  return `SELECT id, display_name as name, email, color, is_available, is_demo${phone} FROM auth_accounts WHERE COALESCE(is_demo,0)=0${availability} AND ${membership} ORDER BY id`;
}

async function logServerOps(level, event, message, meta, req){
  try{
    const db = getClient();
    if(localIdentityAdapterEnabled(req)){
      await db.execute(`SELECT id,level,source,event,message,meta_json,user_id,route,ua,ip,created_at FROM app_logs LIMIT 0`);
    }else{
      try{ await db.execute("CREATE TABLE IF NOT EXISTS app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT, source TEXT, event TEXT, message TEXT, meta_json TEXT, user_id INTEGER, route TEXT, ua TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')))"); }catch{}
    }
    let metaStr=null; try{ metaStr = meta ? JSON.stringify(meta).slice(0,8000) : null; }catch{ metaStr=String(meta).slice(0,2000); }
    const lvl=String(level||"info").toLowerCase();
    const ev=String(event).slice(0,80);
    const msg=String(message).slice(0,2000);
    const route = req && req.url ? String(req.url).slice(0,300) : null;
    const ua = req && req.headers ? (req.headers["user-agent"]||"").toString().slice(0,300) : null;
    const ip = req && req.headers ? (req.headers["x-forwarded-for"]||"").toString().split(",")[0].slice(0,80) : null;
    await db.execute({sql:"INSERT INTO app_logs (level, source, event, message, meta_json, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?, ?, datetime('now'))", args:[lvl, "server", ev, msg, metaStr, route, ua, ip]});
  }catch(e){ try{ console.warn("[logServerOps fail]", e && e.message); }catch{} }
}

async function ensureNotifPrefs(db,req){
  if(localIdentityAdapterEnabled(req)){
    await db.execute(`SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0`);
    return;
  }
  try{ await db.execute("CREATE TABLE IF NOT EXISTS user_notification_prefs (user_id INTEGER PRIMARY KEY, email_enabled INTEGER DEFAULT 1, sms_enabled INTEGER DEFAULT 0, phone TEXT, email TEXT, updated_at TEXT DEFAULT (datetime('now')))"); }catch{}
}

async function handleNotificationPrefs(req,res){
  if(req.method!=="GET"&&req.method!=="POST"&&req.method!=="PUT"){
    return res.status(405).json({error:"GET or POST/PUT"});
  }
  const payload=await verifyRequestAuth(req);
  if(!payload) return res.status(401).json({error:"authentication required"});
  const db=getClient();
  try{ await ensureNotifPrefs(db,req); }
  catch{ return res.status(503).json({error:"notification preferences unavailable"}); }
  if(req.method==="GET"){
    const uid=payload.id||payload.uid;
    try{
      const rs=await db.execute({sql:"SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs WHERE user_id=?", args:[uid]});
      if(rs.rows.length) return res.json({ok:true, prefs:rs.rows[0]});
      return res.json({ok:true, prefs:{user_id:uid,email_enabled:1,sms_enabled:0,phone:null}});
    }catch(e){ return res.status(500).json({error:"fetch failed"}); }
  }
  if(req.method==="POST" || req.method==="PUT"){
    const uid=payload.id||payload.uid;
    const body=req.body||{};
    const email_enabled = body.email_enabled!=null ? (body.email_enabled?1:0) : 1;
    const sms_enabled = body.sms_enabled!=null ? (body.sms_enabled?1:0) : 0;
    const phone = body.phone ? String(body.phone).slice(0,20) : null;
    const email = body.email ? String(body.email).slice(0,120) : null;
    try{
      await db.execute({sql:"INSERT INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email,updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled, sms_enabled=excluded.sms_enabled, phone=COALESCE(excluded.phone,phone), email=COALESCE(excluded.email,email), updated_at=datetime('now')", args:[uid,email_enabled,sms_enabled,phone,email]});
    }catch{
      try{ await db.execute({sql:"INSERT OR IGNORE INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email) VALUES (?,?,?,?,?)", args:[uid,email_enabled,sms_enabled,phone,email]}); }catch{}
      try{ await db.execute({sql:"UPDATE user_notification_prefs SET email_enabled=?, sms_enabled=?, phone=COALESCE(?,phone), email=COALESCE(?,email), updated_at=datetime('now') WHERE user_id=?", args:[email_enabled,sms_enabled,phone,email,uid]}); }catch{}
    }
    try{ await logServerOps("info","notif_prefs_updated","prefs uid "+uid+" email="+email_enabled+" sms="+sms_enabled, {uid,email_enabled,sms_enabled}, req); }catch{}
    return res.json({ok:true, prefs:{user_id:uid,email_enabled:!!email_enabled,sms_enabled:!!sms_enabled,phone,email}});
  }
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
function isAdminCheck(email, flag){
  if (flag) return true;
  if (!email) return false;
  return getAdminEmails().has(String(email).toLowerCase().trim());
}
function verifyCronAuth(req){
  let secret;
  try{ secret=getCronSecret(); }catch{ return false; }
  const raw = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'] || req.headers['authorization'] || req.headers['Authorization'] || '';
  const presented = typeof raw==='string' && raw.startsWith('Bearer ') ? raw.slice(7) : String(raw||'');
  if(!presented) return false;
  const expectedBuf=Buffer.from(secret);
  const presentedBuf=Buffer.from(presented);
  return expectedBuf.length===presentedBuf.length && timingSafeEqual(expectedBuf,presentedBuf);
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

async function requirePairingPublisher(req,res){
  const payload=await verifyRequestAuth(req);
  if(!payload){ res.status(401).json({error:'authentication required'}); return null; }
  let db;
  try{ db=getClient(); }
  catch{ res.status(503).json({error:'pairing unavailable'}); return null; }
  const callerId=Number(payload.id||payload.uid);
  if(!Number.isSafeInteger(callerId)||callerId<1){
    res.status(401).json({error:'authentication required'});
    return null;
  }
  const localRuntime=strictLocalPairingRuntime(req);
  try{
    const result=await db.execute(localRuntime?{
      sql:`SELECT id,is_admin FROM auth_accounts
        WHERE id=? AND COALESCE(is_demo,0)=0`,
      args:[callerId],
    }:{
      sql:`SELECT aa.id,cm.role
        FROM auth_accounts aa
        JOIN circle_memberships cm ON cm.user_id=aa.id
        JOIN circles c ON c.id=cm.circle_id
        WHERE aa.id=? AND cm.status='active' AND cm.role='owner'
          AND COALESCE(aa.is_demo,0)=0 AND c.is_primary=1 AND c.archived_at IS NULL
        LIMIT 2`,
      args:[callerId],
    });
    const rows=result.rows||[];
    const allowed=localRuntime
      ? rows.length===1&&Number(rows[0].id)===callerId&&Number(rows[0].is_admin)===1
      : rows.length===1&&Number(rows[0].id)===callerId&&String(rows[0].role)==='owner';
    if(!allowed){ res.status(403).json({error:'primary circle owner required'}); return null; }
  }catch{
    res.status(503).json({error:'pairing unavailable'});
    return null;
  }
  return {db,callerId,localRuntime};
}

async function ensureMigrations(db){
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_week_runs (week_label TEXT PRIMARY KEY, week_id INTEGER, generation_token TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, algorithm_version TEXT NOT NULL, algorithm_seed TEXT NOT NULL, participant_count INTEGER NOT NULL, participants_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_participants (week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auth', created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (week_id, user_id))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, recipient_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, provider_message_id TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE (week_id,user_id,kind))`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pairing_email_outbox_pending ON pairing_email_outbox(week_id,status,created_at)`);}catch{}
  // New installs get a direct invariant; pairing_week_runs remains the concurrency guard
  // for older databases where historical duplicate labels prevent this index.
  try{ await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_weeks_week_label ON pairing_weeks(week_label)`);}catch{}
  const alters=[
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN phone TEXT`,
    `ALTER TABLE pairing_week_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`,
];
  for(const sql of alters){ try{ await db.execute(sql); }catch{} }
}

async function loadPairingHistory(db,weekLabel,{includeDemo=false,includeCurrent=false,strict=false,authOnly=false,managedOnly=false}={}){
  try{
    const demoFilter=includeDemo?'':`AND COALESCE(pw.is_demo,0)=0`;
    const currentFilter=includeCurrent?'1=1':'pw.week_label<>?';
    const runJoin=managedOnly?'JOIN pairing_week_runs pwr ON pwr.week_id=pw.id AND pwr.week_label=pw.week_label':'';
    const participantJoins=authOnly?`
      JOIN pairing_participants ppa ON ppa.week_id=pg.week_id AND ppa.user_id=pg.user_a_id AND ppa.source='auth'
      JOIN pairing_participants ppb ON ppb.week_id=pg.week_id AND ppb.user_id=pg.user_b_id AND ppb.source='auth'
      LEFT JOIN pairing_participants ppc ON ppc.week_id=pg.week_id AND ppc.user_id=pg.user_c_id AND ppc.source='auth'`:'';
    const participantFilter=authOnly?'AND (pg.user_c_id IS NULL OR ppc.user_id IS NOT NULL)':'';
    const rs=await db.execute({sql:`SELECT pg.user_a_id,pg.user_b_id,pg.is_ai_pair,pw.id AS week_id,pw.week_label
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id=pg.week_id
      ${runJoin}
      ${participantJoins}
      WHERE ${currentFilter} ${demoFilter} ${participantFilter}
      ORDER BY pw.week_start DESC,pw.id DESC,pg.id ASC LIMIT 1000`,args:includeCurrent?[]:[weekLabel]});
    return rs.rows;
  }catch(error){
    if(strict) throw error;
    return [];
  }
}

function pairingMetadata(pairing){
  return {
    version:pairing.algorithmVersion,
    seed:pairing.seed,
    generation:pairing.generation,
    attempts:pairing.attempts,
    previous_week_repeats:pairing.score.previousWeekRepeats,
    historical_repeats:pairing.score.historicalRepeats,
    prior_ai_assignments:pairing.score.aiHistory,
  };
}

/** Persist the week, participant snapshot, and every pair in one write transaction. */
async function persistPairingWeek(db, {weekLabel, weekStart, participants, pairing, isDemoWeek=0, replace=false, notificationRecipients=[], generation=1, expectedGeneration=null}){
  const generationToken=randomUUID();
  const participantSnapshot=JSON.stringify(participants.map(p=>({user_id:Number(p.id),source:p.source||'auth'})));
  const runArgs=[weekLabel,generationToken,generation,pairing.algorithmVersion,pairing.seed,participants.length,participantSnapshot];
  const statements=[];

  if(replace){
    statements.push({sql:`INSERT INTO pairing_week_runs (week_label,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(week_label) DO UPDATE SET generation_token=excluded.generation_token,generation=excluded.generation,algorithm_version=excluded.algorithm_version,algorithm_seed=excluded.algorithm_seed,participant_count=excluded.participant_count,participants_json=excluded.participants_json,updated_at=datetime('now') WHERE pairing_week_runs.generation=?`,args:[...runArgs,expectedGeneration]});
  }else{
    statements.push({sql:`INSERT INTO pairing_week_runs (week_label,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(week_label) DO NOTHING`,args:runArgs});
  }

  statements.push({sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo) SELECT ?,?,'both',? WHERE EXISTS (SELECT 1 FROM pairing_week_runs WHERE week_label=? AND generation_token=?) AND NOT EXISTS (SELECT 1 FROM pairing_weeks WHERE week_label=?)`,args:[weekLabel,weekStart,isDemoWeek,weekLabel,generationToken,weekLabel]});
  statements.push({sql:`UPDATE pairing_week_runs SET week_id=(SELECT MIN(id) FROM pairing_weeks WHERE week_label=?),updated_at=datetime('now') WHERE week_label=? AND generation_token=?`,args:[weekLabel,weekLabel,generationToken]});

  if(replace){
    statements.push({sql:`UPDATE pairing_weeks SET week_start=?,is_demo=? WHERE id=(SELECT week_id FROM pairing_week_runs WHERE week_label=? AND generation_token=?)`,args:[weekStart,isDemoWeek,weekLabel,generationToken]});
    statements.push({sql:`DELETE FROM pairing_groups WHERE week_id=(SELECT week_id FROM pairing_week_runs WHERE week_label=? AND generation_token=?)`,args:[weekLabel,generationToken]});
    statements.push({sql:`DELETE FROM pairing_participants WHERE week_id=(SELECT week_id FROM pairing_week_runs WHERE week_label=? AND generation_token=?)`,args:[weekLabel,generationToken]});
  }

  participants.forEach((participant,index)=>{
    statements.push({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) SELECT week_id,?,?,? FROM pairing_week_runs WHERE week_label=? AND generation_token=?`,args:[Number(participant.id),index,participant.source||'auth',weekLabel,generationToken]});
  });
  pairing.pairs.forEach(pair=>{
    statements.push({sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) SELECT week_id,?,?,?,?,'both' FROM pairing_week_runs WHERE week_label=? AND generation_token=?`,args:[Number(pair.a.id),Number(pair.b?.id||pair.a.id),pair.isAI?1:0,'Pick together',weekLabel,generationToken]});
  });
  notificationRecipients.forEach(recipient=>{
    if(!recipient.email) return;
    statements.push({sql:`INSERT INTO pairing_email_outbox (week_id,user_id,kind,recipient_email) SELECT week_id,?,?,? FROM pairing_week_runs WHERE week_label=? AND generation_token=? ON CONFLICT(week_id,user_id,kind) DO NOTHING`,args:[Number(recipient.id),recipient.kind,String(recipient.email).slice(0,320),weekLabel,generationToken]});
  });

  await db.batch(statements,'write');
  const runRs=await db.execute({sql:`SELECT week_id,generation_token,generation FROM pairing_week_runs WHERE week_label=?`,args:[weekLabel]});
  const run=runRs.rows[0];
  if(!run || run.generation_token!==generationToken) return {created:false,weekId:run?.week_id||null,generation:run?.generation||null,pairs:[]};
  const groups=await db.execute({sql:`SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups WHERE week_id=? ORDER BY id`,args:[run.week_id]});
  const queues=new Map();
  for(const group of groups.rows){
    const key=`${group.user_a_id}:${group.user_b_id}:${group.is_ai_pair?1:0}`;
    if(!queues.has(key)) queues.set(key,[]);
    queues.get(key).push(group);
  }
  const pairs=pairing.pairs.map(pair=>{
    const key=`${pair.a.id}:${pair.b?.id||pair.a.id}:${pair.isAI?1:0}`;
    const group=queues.get(key)?.shift();
    return {...pair,groupId:group?.id||null};
  });
  return {created:true,weekId:run.week_id,generation:Number(run.generation),pairs};
}

async function lookupDisplayName(db,userId){
  try{
    const auth=await db.execute({sql:`SELECT display_name AS name FROM auth_accounts WHERE id=? AND COALESCE(is_demo,0)=0`,args:[userId]});
    if(auth.rows.length) return auth.rows[0].name;
  }catch{}
  try{
    const legacy=await db.execute({sql:`SELECT name FROM users WHERE id=?`,args:[userId]});
    if(legacy.rows.length) return legacy.rows[0].name;
  }catch{}
  return 'your partner';
}

async function renderOutboxEmail(db,item,weekLabel,baseUrl){
  const safeWeekLabel=escapeHtml(weekLabel);
  const safeBaseUrl=escapeHtml(baseUrl);
  if(item.kind==='unavailable'){
    return {
      subject:`You missed Randori ${weekLabel} — toggle back to available`,
      html:`<h2>Randori Circle — you missed ${safeWeekLabel}</h2><p>You were excluded from this week's shuffle because you marked <b>Unavailable</b>.</p><p>No worries — you'll be back next Sunday automatically unless you stay unavailable.</p><p><a href="${safeBaseUrl}">Open app → Settings → set Available this week = ON</a> to re-join.</p>`,
    };
  }
  const groupRs=await db.execute({sql:`SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups WHERE week_id=? AND (user_a_id=? OR (user_b_id=? AND COALESCE(is_ai_pair,0)=0)) LIMIT 1`,args:[item.week_id,item.user_id,item.user_id]});
  if(!groupRs.rows.length) throw new Error('pair group missing for notification recipient');
  const group=groupRs.rows[0];
  const partnerName=group.is_ai_pair?'Solo practice':await lookupDisplayName(db,Number(group.user_a_id)===Number(item.user_id)?group.user_b_id:group.user_a_id);
  const room=canonicalRoomId(item.week_id,group.id);
  const joinUrl=`${baseUrl}/join/${room}`;
  return {
    subject:`Randori ${weekLabel} — your pairing is ready`,
    html:`<h2>Randori Circle — ${safeWeekLabel}</h2><p>You're paired with <b>${escapeHtml(partnerName)}</b>.</p><p><a href="${escapeHtml(joinUrl)}">Join your private pairing room</a></p><p><a href="${safeBaseUrl}">Open Randori Circle</a> to choose DSA, System Design, or Both.</p><p style="color:#888;font-size:12px">Turn off availability in settings if you want to skip next week.</p>`,
  };
}

async function deliverPendingPairingEmails(db,weekId,baseUrl,req){
  let exhausted=0;
  let pending;
  try{
    const exhaustedResult=await db.execute({sql:`UPDATE pairing_email_outbox SET status='exhausted',last_error=COALESCE(last_error,'maximum delivery attempts reached'),updated_at=datetime('now') WHERE week_id=? AND attempt_count>=? AND (status IN ('pending','failed') OR (status='sending' AND claimed_at<datetime('now','-15 minutes')))`,args:[weekId,MAX_EMAIL_ATTEMPTS]});
    exhausted=Number(exhaustedResult.rowsAffected||0);
    pending=await db.execute({sql:`SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count FROM pairing_email_outbox WHERE week_id=? AND attempt_count<? AND (status IN ('pending','failed') OR (status='sending' AND claimed_at<datetime('now','-15 minutes'))) ORDER BY id LIMIT 100`,args:[weekId,MAX_EMAIL_ATTEMPTS]});
  }catch(e){
    return {summary:'email outbox unavailable',sent:0,failed:0,exhausted,pending:0,error:String(e.message||e).slice(0,180)};
  }
  if(!pending.rows.length) return {summary:exhausted?`${exhausted} email reminder(s) exhausted after ${MAX_EMAIL_ATTEMPTS} attempts`:'no pending email reminders',sent:0,failed:0,exhausted,pending:0};
  if(localIdentityAdapterEnabled(req)){
    const weekRs=await db.execute({sql:`SELECT week_label FROM pairing_weeks WHERE id=?`,args:[weekId]});
    const weekLabel=weekRs.rows[0]?.week_label;
    if(!weekLabel) return {summary:'local mail capture unavailable — pairing week missing',sent:0,failed:0,exhausted,pending:pending.rows.length,captured:[]};
    const captured=[];
    let failed=0,suppressed=0;
    for(const item of pending.rows){
      try{
        const pref=await db.execute({sql:`SELECT email_enabled FROM user_notification_prefs WHERE user_id=?`,args:[item.user_id]});
        if(pref.rows[0]?.email_enabled===0){ suppressed+=1; continue; }
        const content=await renderOutboxEmail(db,item,weekLabel,baseUrl);
        const links=[...content.html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]).slice(0,4);
        captured.push({recipient_email:String(item.recipient_email),kind:String(item.kind),subject:content.subject,links});
      }catch{
        failed+=1;
      }
    }
    return {
      summary:`captured ${captured.length} local email reminder(s), failed ${failed}; no external delivery`,
      sent:0,failed,exhausted,pending:pending.rows.length,suppressed,captured,
    };
  }
  if(!process.env.RESEND_API_KEY||!process.env.RESEND_FROM) return {summary:`${pending.rows.length} email reminder(s) pending — email disabled until RESEND_API_KEY + RESEND_FROM are set`,sent:0,failed:0,exhausted,pending:pending.rows.length};

  const resendMod=await import('resend').catch(()=>null);
  if(!resendMod?.Resend) return {summary:`${pending.rows.length} email reminder(s) pending — resend package unavailable`,sent:0,failed:0,exhausted,pending:pending.rows.length};
  const weekRs=await db.execute({sql:`SELECT week_label FROM pairing_weeks WHERE id=?`,args:[weekId]});
  const weekLabel=weekRs.rows[0]?.week_label;
  if(!weekLabel) return {summary:'email reminders pending — pairing week missing',sent:0,failed:pending.rows.length,exhausted,pending:pending.rows.length};

  const resend=new resendMod.Resend(process.env.RESEND_API_KEY);
  const from=process.env.RESEND_FROM;
  let sent=0,failed=0,suppressed=0;
  for(const item of pending.rows){
    let claimedAttempt=null;
    try{
      const claim=await db.execute({sql:`UPDATE pairing_email_outbox SET status='sending',attempt_count=attempt_count+1,claimed_at=datetime('now'),last_error=NULL,updated_at=datetime('now') WHERE id=? AND attempt_count<? AND (status IN ('pending','failed') OR (status='sending' AND claimed_at<datetime('now','-15 minutes'))) RETURNING id,attempt_count`,args:[item.id,MAX_EMAIL_ATTEMPTS]});
      if(!claim.rows.length) continue;
      claimedAttempt=Number(claim.rows[0].attempt_count);
      const account=await db.execute({sql:`SELECT is_demo FROM auth_accounts WHERE id=?`,args:[item.user_id]});
      if(account.rows[0]?.is_demo){
        const transition=await db.execute({sql:`UPDATE pairing_email_outbox SET status='suppressed',last_error='demo account excluded from production reminders',updated_at=datetime('now') WHERE id=? AND status='sending' AND attempt_count=? RETURNING id`,args:[item.id,claimedAttempt]});
        if(transition.rows.length) suppressed+=1;
        continue;
      }
      const pref=await db.execute({sql:`SELECT email_enabled FROM user_notification_prefs WHERE user_id=?`,args:[item.user_id]});
      if(pref.rows[0]?.email_enabled===0){
        const transition=await db.execute({sql:`UPDATE pairing_email_outbox SET status='suppressed',last_error='email disabled by user',updated_at=datetime('now') WHERE id=? AND status='sending' AND attempt_count=? RETURNING id`,args:[item.id,claimedAttempt]});
        if(transition.rows.length) suppressed+=1;
        continue;
      }
      const content=await renderOutboxEmail(db,item,weekLabel,baseUrl);
      const idempotencyKey=`randori/${item.week_id}/${item.kind}/${item.user_id}`;
      const result=await resend.emails.send({from,to:item.recipient_email,subject:content.subject,html:content.html},{idempotencyKey});
      if(result?.error) throw new Error(result.error.message||'email provider rejected request');
      const transition=await db.execute({sql:`UPDATE pairing_email_outbox SET status='sent',sent_at=datetime('now'),provider_message_id=?,last_error=NULL,updated_at=datetime('now') WHERE id=? AND status='sending' AND attempt_count=? RETURNING id`,args:[result?.data?.id||null,item.id,claimedAttempt]});
      if(transition.rows.length) sent+=1;
    }catch(e){
      if(claimedAttempt!==null){
        try{
          const transition=await db.execute({sql:`UPDATE pairing_email_outbox SET status=CASE WHEN attempt_count>=? THEN 'exhausted' ELSE 'failed' END,last_error=?,updated_at=datetime('now') WHERE id=? AND status='sending' AND attempt_count=? RETURNING status`,args:[MAX_EMAIL_ATTEMPTS,String(e.message||e).slice(0,500),item.id,claimedAttempt]});
          if(transition.rows.length){
            failed+=1;
            if(transition.rows[0].status==='exhausted') exhausted+=1;
          }
        }catch{}
      }
    }
  }
  const remaining=await db.execute({sql:`SELECT COUNT(*) AS c FROM pairing_email_outbox WHERE week_id=? AND status IN ('pending','failed','sending')`,args:[weekId]}).catch(()=>({rows:[{c:failed}]}));
  const pendingCount=Number(remaining.rows[0]?.c||0);
  const summary=`sent ${sent}, failed ${failed}, exhausted ${exhausted}, suppressed ${suppressed}, pending ${pendingCount}`;
  try{ await logServerOps(failed?'warn':'success','pairing_email_delivery',summary,{week_id:weekId,sent,failed,exhausted,suppressed,pending:pendingCount},req); }catch{}
  return {summary,sent,failed,exhausted,suppressed,pending:pendingCount};
}

async function getCallerAdmin(db, payload){
  let callerEmail = '';
  const callerId = payload.id||payload.uid;
  let callerIsAdminFlag=false, callerDbRow=null;
  if (callerId){ try{ const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]}); if(cr.rows.length){ callerDbRow=cr.rows[0]; callerEmail=String(cr.rows[0].email||'').toLowerCase().trim(); callerIsAdminFlag=!!cr.rows[0].is_admin; }}catch{} }
  if (getAdminEmails().has(callerEmail) && callerDbRow && !callerIsAdminFlag){ try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[callerDbRow.id]}); callerIsAdminFlag=true; }catch{} }
  const callerIsAdmin = !!callerDbRow && isAdminCheck(callerEmail, callerIsAdminFlag);
  return {callerEmail, callerId, callerIsAdminFlag, callerDbRow, callerIsAdmin};
}

async function requireAdmin(req,res){
  const payload=await verifyRequestAuth(req);
  if (!payload) { res.status(401).json({ error:'authentication required' }); return null; }
  const db = getClient();
  await ensureMigrations(db);
  const ctx = await getCallerAdmin(db, payload);
  if (!ctx.callerIsAdmin){ res.status(403).json({ error:'forbidden: admin only' }); return null; }
  return {db, payload, ...ctx};
}

async function handleAvailability(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only' });
  const payload=await verifyRequestAuth(req);
  if (!payload) return res.status(401).json({ error:'authentication required' });
  const { is_available, isAvailable } = req.body||{};
  const raw = (is_available!==undefined ? is_available : isAvailable);
  if (raw===undefined||raw===null) return res.status(400).json({ error:'is_available boolean required' });
  const val = raw?1:0;
  const userId=payload.id||payload.uid;
  const db = getClient();
  await ensureMigrations(db);
  try{
    await db.execute({ sql:`UPDATE auth_accounts SET is_available=?, availability_updated_at=datetime('now') WHERE id=?`, args:[val, userId]});
    const rs = await db.execute({ sql:`SELECT id,email,display_name,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args:[userId]});
    if(!rs.rows.length) return res.status(401).json({error:'account not found'});
    const u = rs.rows[0];
    return res.json({ ok:true, user:{ id:u.id, email:u.email, name:u.display_name, is_available: !!u.is_available, isAvailable: !!u.is_available, availability_updated_at:u.availability_updated_at }, message: val ? 'You are marked AVAILABLE — you will be included Sunday at 08:00 London time' : 'You are marked UNAVAILABLE — you will be SKIPPED Sunday at 08:00 London time until you re-enable' });
  }catch(e){ return res.status(500).json({ ok:false, error:'update failed', detail:String(e.message||e).slice(0,200)}); }
}

async function handleReshuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for reshuffle or promote' });
  const body = req.body||{};
  const queryAction=req.query?.action;
  const action=(body.action||queryAction||'').toString().toLowerCase();
  // Preserve the legacy promotion operation, but make the old reshuffle URL a
  // compatibility alias for the immutable current-cycle publication. There is
  // deliberately no force/remix operation for a published cycle.
  if(action!=='promote') return handlePairingRun(req,res);
  const adminCtx = await requireAdmin(req,res);
  if (!adminCtx) return;
  const {db, callerEmail, callerIsAdminFlag} = adminCtx;
  const targetEmailRaw = body.email||body.target||req.query?.email;
  if (!targetEmailRaw) return res.status(400).json({ error:'email required for promotion', example:{ action:'promote', email:'newadmin@example.com'}});
  const targetEmail = String(targetEmailRaw).trim().toLowerCase();
  if (!targetEmail.includes('@')) return res.status(400).json({ error:'invalid email'});
  try{
    const existing = await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)=?`, args:[targetEmail]});
    if (!existing.rows.length){ return res.status(404).json({ ok:false, error:'user not found in auth_accounts — ask them to sign up first, then promote, or add them to ADMIN_EMAILS env var to auto-admin on signup', target:targetEmail, note:'Adding to ADMIN_EMAILS env var will auto-promote on next signup/login/Google'}); }
    await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE lower(email)=?`, args:[targetEmail]});
    return res.json({ ok:true, promoted:targetEmail, id:existing.rows[0].id, by:callerEmail, is_admin_via:callerIsAdminFlag?'db':'env', note:'User is now admin (is_admin=1). They will get admin flag on next login/token refresh.' });
  }catch(e){ return res.status(500).json({ error:'db error promoting', detail:String(e.message||e).slice(0,200)}); }
}

function safeEmailDelivery(value){
  const delivery=value&&typeof value==='object'?value:{};
  const result={
    summary:String(delivery.summary||'email delivery unavailable').slice(0,180),
    sent:Number(delivery.sent||0),
    failed:Number(delivery.failed||0),
    exhausted:Number(delivery.exhausted||0),
    pending:Number(delivery.pending||0),
    suppressed:Number(delivery.suppressed||0),
  };
  if(Array.isArray(delivery.captured)){
    result.captured=delivery.captured.slice(0,100).map(item=>({
      recipient_email:String(item?.recipient_email||'').slice(0,254),
      kind:String(item?.kind||'').slice(0,32),
      subject:String(item?.subject||'').slice(0,200),
      links:Array.isArray(item?.links)?item.links.slice(0,4).map(link=>String(link).slice(0,2048)):[],
    }));
  }
  return result;
}

async function pairingCandidates(db,{localRuntime}){
  const result=await db.execute(localRuntime
    ? `SELECT id,display_name AS name,email,color,is_available
       FROM auth_accounts
       WHERE COALESCE(is_demo,0)=0
       ORDER BY id`
    : productionAccountQuery());
  const accounts=(result.rows||[]).map(row=>({
    id:Number(row.id),
    name:String(row.name||`Member ${row.id}`).slice(0,80),
    color:String(row.color||'#9aa0a6').slice(0,32),
    email:String(row.email||'').trim().slice(0,320),
    isAvailable:row.is_available===null||row.is_available===undefined||Number(row.is_available)===1,
  })).filter(account=>Number.isSafeInteger(account.id)&&account.id>0);
  const participants=accounts.filter(account=>account.isAvailable).map(account=>({
    id:account.id,name:account.name,color:account.color,source:'auth',
  }));
  const notificationRecipients=[
    ...accounts.filter(account=>account.isAvailable&&account.email).map(account=>({id:account.id,email:account.email,kind:'paired'})),
    ...accounts.filter(account=>!account.isAvailable&&account.email).map(account=>({id:account.id,email:account.email,kind:'unavailable'})),
  ];
  return {accounts,participants,notificationRecipients};
}

function pairingPublicationPayload(result,accounts,emailDelivery){
  const publication=result.publication;
  const names=new Map(accounts.map(account=>[account.id,account.name]));
  const displayName=id=>names.get(Number(id))||`Member ${Number(id)}`;
  return {
    ok:true,
    created:result.created,
    skipped:!result.created,
    cycle:publication.cycle,
    week_label:publication.cycle.cycleId,
    week_id:publication.weekId,
    generation:publication.generation,
    count:publication.participantCount,
    participant_count:publication.participantCount,
    available_count:publication.participantCount,
    total_accounts:accounts.length,
    unavailable_count:Math.max(0,accounts.length-publication.participantCount),
    pairs:publication.pairs.map(pair=>({
      a:displayName(pair.aId),
      b:pair.isAI?'Solo practice':displayName(pair.bId),
      a_id:pair.aId,
      b_id:pair.isAI?null:pair.bId,
      isAI:pair.isAI,
      solo_practice:pair.isAI,
      pg_id:pair.groupId,
      room:canonicalRoomId(publication.weekId,pair.groupId),
    })),
    algorithm:publication.algorithm,
    email_delivery:safeEmailDelivery(emailDelivery),
    message:result.created
      ?'Current-cycle pairings published. Solo members receive a Solo practice room.'
      :'Current-cycle pairings were already published; no pairs were changed.',
  };
}

function pairingFailure(res,error){
  if(error?.code==='PAIRING_PUBLISHER_REVOKED'){
    return res.status(403).json({error:'primary circle owner required'});
  }
  if(error?.code==='PAIRING_PUBLICATION_NO_PARTICIPANTS'){
    return res.status(400).json({error:'At least one available member is required. A single member receives Solo practice.'});
  }
  if(error?.code==='PAIRING_PUBLICATION_LEGACY_CONFLICT'){
    return res.status(409).json({error:'The current cycle cannot be published because legacy pairing data already exists.'});
  }
  return res.status(503).json({error:'pairing unavailable'});
}

async function runCurrentPairing(req,res,{db,localRuntime,callerId=null,now=new Date()}){
  try{
    const cycle=resolvePairingCycle({now});
    if(typeof db.transaction!=='function') throw new Error('pairing transaction unavailable');
    let completed=null;
    let lastError=null;
    for(let attempt=1;attempt<=PAIRING_TRANSACTION_ATTEMPTS;attempt+=1){
      let transaction=null;
      let commitStarted=false;
      try{
        transaction=await db.transaction('write');
        if(callerId){
          const publisherId=Number(callerId);
          const authorization=await transaction.execute(localRuntime?{
            sql:`SELECT id,is_admin FROM auth_accounts
              WHERE id=? AND COALESCE(is_demo,0)=0`,args:[publisherId],
          }:{
            sql:`SELECT aa.id,cm.role
              FROM auth_accounts aa
              JOIN circle_memberships cm ON cm.user_id=aa.id
              JOIN circles c ON c.id=cm.circle_id
              WHERE aa.id=? AND cm.status='active' AND cm.role='owner'
                AND COALESCE(aa.is_demo,0)=0 AND c.is_primary=1 AND c.archived_at IS NULL
              LIMIT 2`,args:[publisherId],
          });
          const rows=authorization.rows||[];
          const allowed=localRuntime
            ?rows.length===1&&Number(rows[0].id)===publisherId&&Number(rows[0].is_admin)===1
            :rows.length===1&&Number(rows[0].id)===publisherId&&String(rows[0].role)==='owner';
          if(!allowed){ const error=new Error('publisher authorization was revoked'); error.code='PAIRING_PUBLISHER_REVOKED'; throw error; }
        }
        const existing=await getPairingPublication(transaction,{now});
        const {accounts,participants,notificationRecipients}=await pairingCandidates(transaction,{localRuntime});
        const result=existing
          ?{created:false,publication:existing}
          :await publishPairingCycle(transaction,{
            now,participants,
            history:await loadPairingHistory(transaction,cycle.cycleId,{strict:true,authOnly:true,managedOnly:true}),
            notificationRecipients,
          });
        commitStarted=true;
        await transaction.commit();
        completed={accounts,result};
        break;
      }catch(error){
        lastError=error;
        if(transaction){ try{ await transaction.rollback(); }catch{} }
        if(commitStarted||attempt===PAIRING_TRANSACTION_ATTEMPTS||!isRetryablePairingConflict(error)) throw error;
        await pairingRetryDelay(attempt);
      }finally{
        try{ transaction?.close?.(); }catch{}
      }
    }
    if(!completed) throw lastError||new Error('pairing transaction failed');
    const {accounts,result}=completed;
    const baseUrl=(process.env.APP_URL || (process.env.VERCEL_URL? `https://${process.env.VERCEL_URL}`:'https://randori-circle-self.vercel.app')).replace(/\/$/,'');
    let emailDelivery;
    try{ emailDelivery=await deliverPendingPairingEmails(db,result.publication.weekId,baseUrl,req); }
    catch{ emailDelivery={summary:'email delivery unavailable'}; }
    return res.json(pairingPublicationPayload(result,accounts,emailDelivery));
  }catch(error){
    return pairingFailure(res,error);
  }
}

async function handlePairingRun(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const context=await requirePairingPublisher(req,res);
  if(!context) return;
  const body=req.body===undefined?{}:req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){
    return res.status(400).json({error:'request body must be empty; published cycles cannot be remixed'});
  }
  return runCurrentPairing(req,res,context);
}

async function handleWeekly(req,res){
  // Vercel Cron invokes configured paths with GET; authentication below is mandatory.
  if (req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET or POST'});
  if (!verifyCronAuth(req)){
    if(process.env.TURSO_DATABASE_URL){ try{ await logServerOps('warn','cron_auth_fail','weekly unauthorized', {headers:Object.keys(req.headers||{})}, req); }catch{} }
    return res.status(401).json({ error:'unauthorized cron', hint:'send x-cron-secret: <CRON_SECRET> or Authorization: Bearer <CRON_SECRET>'});
  }
  const now=new Date();
  let cycle;
  try{
    cycle=resolvePairingCycle({now});
    if(!pairingCronIsDue({now})){
      return res.json({ok:true,skipped:true,reason:'outside_due_window',cycle,message:'Pairing publication is only due during the configured Sunday 08:00 UTC run window.'});
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'pairing unavailable'}); }
  return runCurrentPairing(req,res,{db,localRuntime:strictLocalPairingRuntime(req),now});
}


async function handleDemoSeed(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-seed' });
  const ctx=await requireAdmin(req,res); if(!ctx) return; const db=ctx.db;
  await ensureMigrations(db);
  const names=['Mia Chen','Alex Rivera','Priya Shah','Jordan Kim','Samir Desai','Lena Wu'];
  const palette=['#e6c07a','#9cc0b5','#d68a8a','#a3b5d6','#c7b29a','#8ec0a5'];
  const ts=Date.now();
  const seeded=[];
  for(let i=0;i<names.length;i++){
    const name=names[i]; const color=palette[i%palette.length];
    const email = `demo+${ts}+${i+1}@randori.demo`.toLowerCase();
    try{
      await db.execute({ sql:`INSERT OR IGNORE INTO auth_accounts (email, password_hash, display_name, color, is_available, is_admin, is_demo) VALUES (?,?,?,?,?,?,?)`, args:[email, 'demo_hash_placeholder_$2a$10$demo', name, color, 1, 0, 1]});
      const row=await db.execute({ sql:`SELECT id FROM auth_accounts WHERE email=?`, args:[email]});
      if(row.rows.length) seeded.push({ id:row.rows[0].id, name, email, color });
    }catch(e){
      // ignore duplicate / error
    }
  }
  return res.json({ ok:true, seeded_count:seeded.length, seeded, note:'6 demo users ready (is_demo=1, is_available=1). They are isolated to explicit demo flows and excluded from normal weekly pairing.' });
}

async function handleDemoShuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-shuffle' });
  const ctx = await requireAdmin(req,res);
  if (!ctx) return;
  const {db, callerEmail, callerIsAdminFlag} = ctx;
  // ensure demo users exist if less than 2
  let demoCount=0;
  try{
    const cnt = await db.execute(`SELECT COUNT(*) as c FROM auth_accounts WHERE is_demo=1 AND COALESCE(is_available,1)=1`);
    demoCount=cnt.rows[0].c||0;
  }catch{ demoCount=0; }
  if(demoCount<2){
    // inline seed minimal
    const names=["Mia Chen","Alex Rivera","Priya Shah","Jordan Kim","Samir Desai","Lena Wu"];
    const ts=Date.now();
    for(let i=0;i<names.length;i++){
      const email = `demo+${ts}+${i+1}@randori.demo`.toLowerCase();
      const color = deterministicColor(email);
      try{ await db.execute({ sql:`INSERT OR IGNORE INTO auth_accounts (email,password_hash,display_name,color,is_available,is_admin,is_demo) VALUES (?,?,?,?,?,?,?)`, args:[email,'demo',names[i],color,1,0,1]});}catch{}
    }
  }
  // now shuffle using all available (demo+real)
  let authRs;
  try{ authRs=await db.execute(`SELECT id, display_name as name, email, color, is_available, is_demo FROM auth_accounts WHERE COALESCE(is_available,1)=1 ORDER BY id`);}catch{ authRs=await db.execute(`SELECT id, display_name as name, email, color FROM auth_accounts ORDER BY id`); }
  if (authRs.rows.length<2){
    return res.status(400).json({ ok:false, error:'need at least 2 available users (demo or real) to shuffle', available_count:authRs.rows.length });
  }
  const participants = authRs.rows.map(r=>({ id:r.id, name:r.name, email:r.email, color:r.color, source:'auth', is_demo: !!r.is_demo }));
  const now=new Date();
  const weekLabel = isoWeekLabel(now) + `-demo-${String(Date.now()).slice(-4)}`;
  const isDemoWeek = participants.some(p=>p.is_demo) ? 1:0;
  const history=await loadPairingHistory(db,weekLabel,{includeDemo:true});
  const pairing=buildFairPairing(participants,history,{seed:`${weekLabel}:demo`});
  const persisted=await persistPairingWeek(db,{weekLabel,weekStart:now.toISOString(),participants,pairing,isDemoWeek});
  if(!persisted.created) return res.status(409).json({ok:false,error:'demo shuffle label collision; retry',week_label:weekLabel});
  pairing.generation=persisted.generation;
  return res.json({ ok:true, demo:true, week_label:weekLabel, week_id:persisted.weekId, reshuffled_by:callerEmail, is_admin_via:callerIsAdminFlag?'db':'env', pairs:persisted.pairs.map(p=>({ a:p.a.name, b: p.b ? p.b.name : 'AI partner', a_id:p.a.id, b_id:p.b? p.b.id:null, isAI:p.isAI, is_demo_a: !!p.a.is_demo, is_demo_b: p.b ? !!p.b.is_demo : false, pg_id:p.groupId, room:canonicalRoomId(persisted.weekId,p.groupId) })), repeat_avoided:pairing.repeatCount, algorithm:pairingMetadata(pairing), count:participants.length, note:'Demo shuffle — all available users (demo+real) paired, week marked is_demo=1 if any demo participant' });
}

async function handleDemoReset(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-reset' });
  const ctx = await requireAdmin(req,res);
  if (!ctx) return;
  const {db} = ctx;
  let deletedGroups=0, deletedWeeks=0, deletedUsers=0;
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`); deletedGroups=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_weeks WHERE is_demo=1`); deletedWeeks=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM auth_accounts WHERE is_demo=1`); deletedUsers=cnt.rows[0]?.c||0; }catch{}
  await db.batch([
    `DELETE FROM pairing_participants WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_week_runs WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_weeks WHERE is_demo=1`,
    `DELETE FROM auth_accounts WHERE is_demo=1`,
  ],'write');
  return res.json({ ok:true, deleted:{ groups:deletedGroups, weeks:deletedWeeks, demo_users:deletedUsers }, note:'Demo reset complete — demo users + demo weeks + their groups deleted. Real users untouched.' });
}

export default async function handler(req,res){
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  const ep = getEndpoint(req);
  const pathLower = (req.url||'').toLowerCase();
  if (ep==='notifications-prefs' || ep==='notifications' || ep==='prefs' || ep.includes('notification') || pathLower.includes('notifications') || pathLower.includes('notif') ) return handleNotificationPrefs(req,res);
  if (ep==='availability' || pathLower.includes('availability')) return handleAvailability(req,res);
  if (ep==='demo-seed' || ep==='demo_seed' || pathLower.includes('demo-seed')) return handleDemoSeed(req,res);
  if (ep==='demo-shuffle' || ep==='demo_shuffle' || ep==='dem0-shuffle' || pathLower.includes('demo-shuffle')) return handleDemoShuffle(req,res);
  if (ep==='demo-reset' || ep==='demo_reset' || pathLower.includes('demo-reset')) return handleDemoReset(req,res);
  if (ep==='pairing-run' || pathLower.includes('/pairing/run')) return handlePairingRun(req,res);
  if (ep==='reshuffle' || ep==='promote' || pathLower.includes('reshuffle') || pathLower.includes('promote')) return handleReshuffle(req,res);
  if (ep==='weekly' || pathLower.includes('weekly') || pathLower.includes('/cron/')) return handleWeekly(req,res);
  if (pathLower.includes('availability')) return handleAvailability(req,res);
  if (pathLower.includes('reshuffle')) return handleReshuffle(req,res);
  if (pathLower.includes('weekly')) return handleWeekly(req,res);
  return res.status(404).json({ error:`unknown ops endpoint '${ep}'`, available:['availability','pairing-run','weekly','promote via reshuffle?action=promote','demo-seed','demo-shuffle','demo-reset'] });
}
