import { getClient, getJwtSecret, getCronSecret, getAdminEmails, isoWeekLabel, shuffleArray, deterministicColor } from './_db.js';
import jwt from 'jsonwebtoken';

async function logServerOps(level, event, message, meta, req){
  try{
    const db = getClient();
    try{ await db.execute("CREATE TABLE IF NOT EXISTS app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT, source TEXT, event TEXT, message TEXT, meta_json TEXT, user_id INTEGER, route TEXT, ua TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')))"); }catch{}
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

function seededShuffle(arr, seedStr){
  let h=0; for(let i=0;i<seedStr.length;i++) h=(h*31+seedStr.charCodeAt(i))>>>0;
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    h=(h*1664525+1013904223)>>>0;
    const j= h % (i+1);
    const tmp=a[i]; a[i]=a[j]; a[j]=tmp;
  }
  return a;
}

async function ensureNotifPrefs(db){
  try{ await db.execute("CREATE TABLE IF NOT EXISTS user_notification_prefs (user_id INTEGER PRIMARY KEY, email_enabled INTEGER DEFAULT 1, sms_enabled INTEGER DEFAULT 0, phone TEXT, email TEXT, updated_at TEXT DEFAULT (datetime('now')))"); }catch{}
}

async function handleNotificationPrefs(req,res){
  const db=getClient();
  try{ await ensureNotifPrefs(db); }catch{}
  if(req.method==="GET"){
    const auth=req.headers.authorization||"";
    const m=auth.match(/^Bearer\s+(.+)$/);
    if(!m) return res.status(401).json({error:"missing Bearer"});
    let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ return res.status(401).json({error:"invalid token"}); }
    const uid=payload.id||payload.uid;
    try{
      const rs=await db.execute({sql:"SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs WHERE user_id=?", args:[uid]});
      if(rs.rows.length) return res.json({ok:true, prefs:rs.rows[0]});
      return res.json({ok:true, prefs:{user_id:uid,email_enabled:1,sms_enabled:0,phone:null}});
    }catch(e){ return res.status(500).json({error:"fetch failed"}); }
  }
  if(req.method==="POST" || req.method==="PUT"){
    const auth=req.headers.authorization||"";
    const m=auth.match(/^Bearer\s+(.+)$/);
    if(!m) return res.status(401).json({error:"missing Bearer"});
    let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ return res.status(401).json({error:"invalid token"}); }
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
    try{ await logServerOps("info","notif_prefs_updated","prefs uid "+uid+" email="+email_enabled+" sms="+sms_enabled, {uid,email_enabled,sms_enabled,phone}, req); }catch{}
    return res.json({ok:true, prefs:{user_id:uid,email_enabled:!!email_enabled,sms_enabled:!!sms_enabled,phone,email}});
  }
  return res.status(405).json({error:"GET or POST/PUT"});
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
  const hdr = req.headers['x-cron-secret'] || req.headers['authorization'] || '';
  const secret = getCronSecret();
  if (typeof hdr==='string' && hdr.startsWith('Bearer ')){
    try{ jwt.verify(hdr.slice(7), getJwtSecret()); return true; }catch{}
  }
  if (hdr && hdr===secret) return true;
  if (req.headers['x-vercel-cron']!==undefined) return true;
  if (req.query && req.query.secret && req.query.secret===secret) return true;
  if (!process.env.CRON_SECRET && !process.env.JWT_SECRET) return true;
  return false;
}

async function ensureMigrations(db){
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  const alters=[
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`,
  ];
  for(const sql of alters){ try{ await db.execute(sql); }catch{} }
}

async function getCallerAdmin(db, payload){
  const callerEmail = (payload.email||payload.e||'').toString().toLowerCase().trim();
  const callerId = payload.id||payload.uid;
  let callerIsAdminFlag=false, callerDbRow=null;
  if (callerId){ try{ const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]}); if(cr.rows.length){ callerDbRow=cr.rows[0]; callerIsAdminFlag=!!cr.rows[0].is_admin; }}catch{} }
  if (!callerDbRow && callerEmail){ try{ const cr2=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)=?`, args:[callerEmail]}); if(cr2.rows.length){ callerDbRow=cr2.rows[0]; callerIsAdminFlag=!!cr2.rows[0].is_admin; }}catch{} }
  if (getAdminEmails().has(callerEmail) && callerDbRow && !callerIsAdminFlag){ try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[callerDbRow.id]}); callerIsAdminFlag=true; }catch{} }
  const callerIsAdmin = isAdminCheck(callerEmail, callerIsAdminFlag) || (payload.is_admin===true);
  return {callerEmail, callerId, callerIsAdminFlag, callerDbRow, callerIsAdmin};
}

async function requireAdmin(req,res){
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) { res.status(401).json({ error:'missing Bearer - sign in as admin' }); return null; }
  let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ res.status(401).json({ error:'invalid token', detail:String(e.message||e).slice(0,120)}); return null; }
  const db = getClient();
  await ensureMigrations(db);
  const ctx = await getCallerAdmin(db, payload);
  if (!ctx.callerIsAdmin){ const envAdmins=Array.from(getAdminEmails()); res.status(403).json({ error:'forbidden: admin only', required_admins:envAdmins, you_are:ctx.callerEmail||payload.email||'unknown' }); return null; }
  return {db, payload, ...ctx};
}

async function handleAvailability(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only' });
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error:'missing Bearer <redacted>' });
  let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ return res.status(401).json({ error:'invalid token'}); }
  const { is_available, isAvailable } = req.body||{};
  const raw = (is_available!==undefined ? is_available : isAvailable);
  if (raw===undefined||raw===null) return res.status(400).json({ error:'is_available boolean required' });
  const val = raw?1:0;
  const db = getClient();
  await ensureMigrations(db);
  try{
    await db.execute({ sql:`UPDATE auth_accounts SET is_available=?, availability_updated_at=datetime('now') WHERE id=?`, args:[val, payload.id]});
    const rs = await db.execute({ sql:`SELECT id,email,display_name,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args:[payload.id]});
    const u = rs.rows[0];
    return res.json({ ok:true, user:{ id:u.id, email:u.email, name:u.display_name, is_available: !!u.is_available, isAvailable: !!u.is_available, availability_updated_at:u.availability_updated_at }, message: val ? 'You are marked AVAILABLE — you will be included Sun 08:00 BST' : 'You are marked UNAVAILABLE — you will be SKIPPED Sun 08:00 BST until you re-enable' });
  }catch(e){ return res.status(500).json({ ok:false, error:'update failed', detail:String(e.message||e).slice(0,200)}); }
}

async function handleReshuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for reshuffle or promote' });
  const adminCtx = await requireAdmin(req,res);
  if (!adminCtx) return;
  const {db, callerEmail, callerIsAdminFlag} = adminCtx;
  const body = req.body||{}; const queryAction=req.query?.action; const action=(body.action||queryAction||'').toString().toLowerCase();
  if (action==='promote'){
    const targetEmailRaw = body.email||body.target||req.query?.email;
    if (!targetEmailRaw) return res.status(400).json({ error:'email required for promotion', example:{ action:'promote', email:'newadmin@example.com'}});
    const targetEmail = String(targetEmailRaw).trim().toLowerCase();
    if (!targetEmail.includes('@')) return res.status(400).json({ error:'invalid email'});
    try{
      const existing = await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)=?`, args:[targetEmail]});
      if (!existing.rows.length){ return res.status(404).json({ ok:false, error:'user not found in auth_accounts — ask them to sign up first, then promote, or add them to ADMIN_EMAILS env var to auto-admin on signup', target:targetEmail, note:'Adding to ADMIN_EMAILS env var will auto-promote on next signup/login/Google'}); }
      await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE lower(email)=?`, args:[targetEmail]});
      return res.json({ ok:true, promoted:targetEmail, id:existing.rows[0].id, by:callerEmail, note:'User is now admin (is_admin=1). They will get admin flag on next login/token refresh.' });
    }catch(e){ return res.status(500).json({ error:'db error promoting', detail:String(e.message||e).slice(0,200)}); }
  }
  let authRs; try{ authRs=await db.execute(`SELECT id, display_name as name, email, color, is_available, is_demo FROM auth_accounts WHERE COALESCE(is_available,1)=1 ORDER BY id`);}catch{ authRs=await db.execute(`SELECT id, display_name as name, email, color FROM auth_accounts ORDER BY id`); }
  if (authRs.rows.length<1){ const allCount=(await db.execute(`SELECT COUNT(*) as c FROM auth_accounts`).catch(()=>({rows:[{c:0}]}))).rows[0].c; return res.status(400).json({ ok:false, error:'need at least 1 available user to shuffle (solo → AI partner)', available_count:authRs.rows.length, total_accounts:allCount, hint:'Mark yourself Available ON, then reshuffle — solo users get AI partner' }); }
  const participants = authRs.rows.map(r=>({ id:r.id, name:r.name, email:r.email, color:r.color, source:'auth', is_demo: !!r.is_demo }));
  const now = new Date(); const weekLabel = isoWeekLabel(now);
  let weekId; const existing = await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE week_label=?`, args:[weekLabel]});
  if (existing.rows.length){ weekId=existing.rows[0].id; await db.execute({ sql:`DELETE FROM pairing_groups WHERE week_id=?`, args:[weekId]}); await db.execute({ sql:`UPDATE pairing_weeks SET week_start=? WHERE id=?`, args:[now.toISOString(), weekId]}); } else {
    const isDemoWeek = participants.some(p=>p.is_demo) ? 1:0;
    try{
      const ins=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus, is_demo) VALUES (?,?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both', isDemoWeek]});
      weekId=ins.rows[0].id;
    }catch{
      const ins=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus) VALUES (?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both']});
      weekId=ins.rows[0].id;
      if(isDemoWeek){ try{ await db.execute({ sql:`UPDATE pairing_weeks SET is_demo=1 WHERE id=?`, args:[weekId]}); }catch{} }
    }
  }
  let prevPairsSet=new Set(); try{ const lw=await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId]}); const lwRow=lw && lw.rows && lw.rows[0]; if(lwRow){ const pg=await db.execute({ sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=?`, args:[lwRow.id]}); pg.rows.forEach(r=>{ const key=[Math.min(r.user_a_id,r.user_b_id), Math.max(r.user_a_id,r.user_b_id)].join('-'); prevPairsSet.add(key); }); } }catch{}
  let bestPairs=null; for(let attempt=0; attempt<8; attempt++){ const shuffled=shuffleArray(participants); const pairs=[]; for(let i=0;i<shuffled.length;i+=2){ const a=shuffled[i]; const b=shuffled[i+1]||null; if(!b) pairs.push({a,b:null,isAI:true}); else pairs.push({a,b,isAI:false}); } let repeats=0; for(const p of pairs){ if(p.isAI) continue; const key=[Math.min(p.a.id,p.b.id), Math.max(p.a.id,p.b.id)].join('-'); if(prevPairsSet.has(key)) repeats++; } if(!bestPairs||repeats<bestPairs.repeats){ bestPairs={pairs,repeats}; if(repeats===0) break; } }
  for(const pr of bestPairs.pairs){ const aId=pr.a.id; const bId= pr.b ? pr.b.id : pr.a.id; const isAi=pr.isAI?1:0; await db.execute({ sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args:[weekId,aId,bId,isAi,'Pick together','both'] }); }
  const envAdmins=Array.from(getAdminEmails());
  return res.json({ ok:true, week_label:weekLabel, week_id:weekId, reshuffled_by:callerEmail, is_admin_via:callerIsAdminFlag?'db':(getAdminEmails().has(callerEmail)?'env':'unknown'), admin_list:envAdmins, pairs:bestPairs.pairs.map(p=>({ a:p.a.name, b: p.b ? p.b.name : 'AI partner', a_id:p.a.id, b_id:p.b? p.b.id:null, isAI:p.isAI })), repeat_avoided:bestPairs.repeats, count:participants.length, note:'Admin reshuffle respected Availability — only is_available=1 users included' });
}


async function handleWeekly(req,res){
  if (req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET or POST'});
  if (!verifyCronAuth(req)){
    try{ await logServerOps('warn','cron_auth_fail','weekly unauthorized', {headers:Object.keys(req.headers||{})}, req); }catch{}
    return res.status(401).json({ error:'unauthorized cron', hint:'send x-cron-secret header or ?secret= or x-vercel-cron'});
  }
  const db = getClient();
  await ensureMigrations(db);
  try{ await ensureNotifPrefs(db); }catch{}
  const now=new Date(); const weekLabel=isoWeekLabel(now);
  const existingWeek=await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE week_label=?`, args:[weekLabel]});
  if (existingWeek.rows.length){
    try{ await logServerOps('info','weekly_skipped','week already exists '+weekLabel, {week_label:weekLabel}, req);}catch{}
    return res.json({ ok:true, skipped:true, week_label:weekLabel, message:'Week already shuffled - see /api/weeks for pairs' });
  }
  let allAccounts=[], available=[], unavailable=[];
  const authRs=await db.execute(`SELECT id, display_name as name, color, email, is_available, is_demo, phone FROM auth_accounts ORDER BY id`);
  if (authRs.rows.length){
    allAccounts=authRs.rows.map(r=>({ id:r.id, name:r.name, color:r.color, email:r.email, phone:r.phone||null, is_available:r.is_available===null||r.is_available===undefined?1:(r.is_available?1:0), is_demo: !!r.is_demo, source:'auth'}));
    available=allAccounts.filter(a=>a.is_available);
    unavailable=allAccounts.filter(a=>!a.is_available);
  }
  let participants=[];
  participants=available;
  if (!participants.length && allAccounts.length===0){
    const usersRs=await db.execute(`SELECT id, name, color FROM users ORDER BY id`);
    participants=usersRs.rows.map(r=>({ id:r.id, name:r.name, color:r.color, source:'users'}));
  }
  if (participants.length<1){
    try{ await logServerOps('warn','weekly_no_participants','no available participants '+weekLabel, {week_label:weekLabel, total:allAccounts.length}, req);}catch{}
    return res.status(400).json({ ok:false, error:'need at least 1 available participant (solo → AI partner)', available_count:participants.length, total_accounts:allAccounts.length, unavailable_count:unavailable.length, unavailable:unavailable.map(u=>({ id:u.id, name:u.name, email:u.email })), hint:'Users marked unavailable are excluded — ask them to set Available toggle on, or wait for next week' });
  }
  let prevPairsSet=new Set(); try{ const lastWeek=await db.execute(`SELECT id FROM pairing_weeks ORDER BY id DESC LIMIT 1`); if(lastWeek.rows.length){ const pg=await db.execute({ sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=?`, args:[lastWeek.rows[0].id]}); pg.rows.forEach(r=>{ const key=[Math.min(r.user_a_id,r.user_b_id), Math.max(r.user_a_id,r.user_b_id)].join('-'); prevPairsSet.add(key); }); } }catch{}
  let bestPairs=null; 
  for(let attempt=0; attempt<8; attempt++){
    const seedStr = weekLabel + ':' + attempt;
    const shuffled=seededShuffle(participants, seedStr);
    const pairs=[]; 
    for(let i=0;i<shuffled.length;i+=2){ const a=shuffled[i]; const b=shuffled[i+1]||null; if(!b) pairs.push({a,b:null,isAI:true}); else pairs.push({a,b,isAI:false}); }
    let repeatCount=0; for(const p of pairs){ if(p.isAI) continue; const key=[Math.min(p.a.id,p.b.id), Math.max(p.a.id,p.b.id)].join('-'); if(prevPairsSet.has(key)) repeatCount++; }
    if(!bestPairs||repeatCount<bestPairs.repeatCount){ bestPairs={pairs, repeatCount}; if(repeatCount===0) break; }
  }
  const isDemoWeek = participants.some(p=>p.is_demo) ? 1:0;
  let weekId;
  try{
    const weekIns=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus, is_demo) VALUES (?,?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both', isDemoWeek]});
    weekId=weekIns.rows[0].id;
  }catch{
    const weekIns=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus) VALUES (?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both']});
    weekId=weekIns.rows[0].id;
    if(isDemoWeek){ try{ await db.execute({ sql:`UPDATE pairing_weeks SET is_demo=1 WHERE id=?`, args:[weekId]});}catch{} }
  }
  for(const pr of bestPairs.pairs){ const aId=pr.a.id; const bId=pr.b?pr.b.id:pr.a.id; const isAi=pr.isAI?1:0; await db.execute({ sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args:[weekId,aId,bId,isAi,'Pick together','both']}); }

  try{ await logServerOps('success','weekly_paired', `weekly ${weekLabel} paired ${participants.length} users`, {week_label:weekLabel, week_id:weekId, pairs:bestPairs.pairs.length, available:participants.length, repeat_avoided:bestPairs.repeatCount}, req);}catch{}

  let prefsMap = new Map();
  try{
    const prs=await db.execute(`SELECT user_id, email_enabled, sms_enabled, phone FROM user_notification_prefs`);
    for(const r of prs.rows) prefsMap.set(r.user_id, r);
  }catch{}

  let emailStatus='skipped (no RESEND_API_KEY) — pairs visible in-app via /api/weeks; set RESEND_API_KEY + RESEND_FROM to email everyone';
  let smsStatus='skipped (no TWILIO_* env or no phone)';
  let unavailableEmailStatus='skipped (no RESEND_API_KEY or no unavailable users)';
  const baseUrl=process.env.APP_URL || (process.env.VERCEL_URL? `https://${process.env.VERCEL_URL}`:'https://randori-circle-self.vercel.app');
  function roomLink(pair){
    const id = `w${weekId}-p${pair.a.id}-${pair.b?pair.b.id:'ai'}`;
    return `${baseUrl}/join/${id}`;
  }

  if (process.env.RESEND_API_KEY){
    try{
      const resendMod = await import('resend').catch(()=>null);
      if (resendMod && resendMod.Resend){
        const resend=new resendMod.Resend(process.env.RESEND_API_KEY);
        const from=process.env.RESEND_FROM||'Randori <onboarding@randori.circle>';
        const toList=[];
        for(const p of participants){
          const pref=prefsMap.get(p.id);
          if(pref && pref.email_enabled===0) continue;
          if(p.email) toList.push(p);
        }
        if (toList.length){
          const html=`<h2>Randori Circle — ${weekLabel}</h2><p>You're paired! This week's auto-shuffle includes ${participants.length} of ${allAccounts.length} signed-up users ( ${unavailable.length} unavailable skipped ).</p><p>Pairs: ${bestPairs.pairs.map(pr=> pr.isAI ? `${pr.a.name} × AI partner` : `${pr.a.name} × ${pr.b.name} — <a href="${roomLink(pr)}">Join room</a>`).join(', ')}</p><p><a href="${baseUrl}">Open Randori Circle</a> to see your partner and pick DSA / System Design / Both.</p><p>Easy join: click your room link above or dashboard → Join Session.</p><p style="color:#888;font-size:12px">Auto-shuffled Sun 08:00 BST. Turn off availability toggle in settings if you want to skip next week. Set reminder toggle in dashboard to get email/SMS.</p>`;
          let sent=0;
          for(const u of toList.slice(0,100)){
            try{ await resend.emails.send({ from, to:u.email, subject:`Randori ${weekLabel} — your pairing is ready`, html }); sent++; }catch{}
          }
          emailStatus=`sent to ${sent}/${toList.length} available participants (email_enabled)`;
          try{ await logServerOps('success','email_sent',`weekly emails sent ${sent}`, {week_label:weekLabel, sent, total:toList.length}, req);}catch{}
        } else { emailStatus='no emails for participants (no email field or opt-out)'; try{ await logServerOps('info','email_skipped_no_key','no eligible emails', {week_label:weekLabel}, req);}catch{} }
        if (unavailable.length){
          const uEmails=unavailable.map(u=>u.email).filter(Boolean);
          if (uEmails.length){
            const htmlU=`<h2>Randori Circle — you missed ${weekLabel}</h2><p>You were excluded from this week's shuffle because you marked <b>Unavailable</b>.</p><p>No worries — you'll be back next Sunday 08:00 BST automatically unless you stay unavailable.</p><p><a href="${baseUrl}">Open app → Settings → set Available this week = ON</a> to re-join now. Admin can also reshuffle manually this week if you're back early.</p><p style="color:#888;font-size:12px">${participants.length} people were paired this week.</p>`;
            let sentU=0;
            for(const to of uEmails.slice(0,100)){ try{ await resend.emails.send({ from, to, subject:`You missed Randori ${weekLabel} — toggle back to available`, html:htmlU }); sentU++; }catch{} }
            unavailableEmailStatus=`sent to ${sentU} unavailable users`;
          } else unavailableEmailStatus='unavailable users have no email field';
        } else unavailableEmailStatus='no unavailable users this week';
      } else { emailStatus='resend package not installed — run npm i resend'; unavailableEmailStatus=emailStatus; try{ await logServerOps('warn','email_skipped_no_key','resend not installed', {}, req);}catch{} }
    }catch(e){ emailStatus='error: '+String(e.message||e).slice(0,180); unavailableEmailStatus=emailStatus; try{ await logServerOps('error','email_fail','weekly email error '+String(e.message||e).slice(0,120), {err:String(e.message||e).slice(0,300)}, req);}catch{} }
  } else {
    try{ await logServerOps('info','email_skipped_no_key','weekly skip email no RESEND_API_KEY', {week_label:weekLabel}, req);}catch{}
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM){
    try{
      const sid=process.env.TWILIO_ACCOUNT_SID;
      const token=process.env.TWILIO_AUTH_TOKEN;
      const from=process.env.TWILIO_FROM;
      const auth = Buffer.from(sid+':'+token).toString('base64');
      let sentSms=0;
      for(const p of participants.slice(0,30)){
        const pref=prefsMap.get(p.id);
        if(pref && pref.sms_enabled===0) continue;
        const phone = pref && pref.phone ? pref.phone : (p.phone||null);
        if(!phone) continue;
        const body=`Randori ${weekLabel}: paired! ${bestPairs.pairs.find(pr=>pr.a.id===p.id|| (pr.b&&pr.b.id===p.id)) ? 'You + '+(bestPairs.pairs.find(pr=>pr.a.id===p.id|| (pr.b&&pr.b.id===p.id)).b? bestPairs.pairs.find(pr=>pr.a.id===p.id|| (pr.b&&pr.b.id===p.id)).b.name : 'AI') : 'check app'} — Join ${baseUrl}/join/w${weekId}-p${p.id} `;
        try{
          const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','Authorization':'Basic '+auth}, body:new URLSearchParams({From:from, To:phone, Body:body}).toString()});
          if(r.ok) sentSms++;
        }catch{}
      }
      smsStatus=`sent ${sentSms} sms via Twilio`;
      try{ await logServerOps('success','sms_sent', `weekly sms ${sentSms}`, {week_label:weekLabel, sentSms}, req);}catch{}
    }catch(e){
      smsStatus='sms error '+String(e.message||e).slice(0,100);
      try{ await logServerOps('error','sms_fail', smsStatus, {err:String(e.message||e).slice(0,200)}, req);}catch{}
    }
  } else {
    try{ await logServerOps('info','sms_skipped_no_creds','skip sms no TWILIO_* env', {week_label:weekLabel}, req);}catch{}
  }

  return res.json({ ok:true, week_label:weekLabel, week_id:weekId, pairs:bestPairs.pairs.map(p=>({ a:p.a.name, b:p.b?p.b.name:'AI partner', isAI:p.isAI, a_id:p.a.id, b_id:p.b?p.b.id:null, room:`w${weekId}-p${p.a.id}-${p.b?p.b.id:'ai'}`, join:`${baseUrl}/join/w${weekId}-p${p.a.id}-${p.b?p.b.id:'ai'}` })), available_count:participants.length, total_accounts:allAccounts.length, unavailable_count:unavailable.length, unavailable:unavailable.map(u=>({ id:u.id, name:u.name, email:u.email })), repeat_avoided:bestPairs.repeatCount, email:emailStatus, sms:smsStatus, unavailable_emails:unavailableEmailStatus, unavailable_reminders:unavailable.map(u=>({ id:u.id, name:u.name, email:u.email, reason:'marked unavailable', action:'Set Available this week = ON in app settings' })), note:'Weekly auto-shuffle: only is_available=1 participants. Set RESEND_API_KEY+RESEND_FROM and TWILIO_* in Vercel to email/sms. Reminder toggle on dashboard sets localStorage + /api/notifications/prefs.', app_url:baseUrl });
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
  return res.json({ ok:true, seeded_count:seeded.length, seeded, note:'6 demo users ready (is_demo=1, is_available=1). They surface in /api/circle and weekly shuffles.' });
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
  const participants = authRs.rows.map(r=>({ id:r.id, name:r.name, email:r.email, color:r.color, is_demo: !!r.is_demo }));
  const now=new Date();
  const weekLabel = isoWeekLabel(now) + `-demo-${String(Date.now()).slice(-4)}`;
  const isDemoWeek = participants.some(p=>p.is_demo) ? 1:0;
  let weekId;
  try{
    const ins=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus, is_demo) VALUES (?,?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both', isDemoWeek]});
    weekId=ins.rows[0].id;
  }catch{
    const ins=await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus) VALUES (?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(),'both']});
    weekId=ins.rows[0].id;
    if(isDemoWeek){ try{ await db.execute({ sql:`UPDATE pairing_weeks SET is_demo=1 WHERE id=?`, args:[weekId]});}catch{} }
  }
  let prevPairsSet=new Set();
  try{ const lw=await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId]}); const lwRow=lw && lw.rows && lw.rows[0]; if(lwRow){ const pg=await db.execute({ sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=?`, args:[lwRow.id]}); pg.rows.forEach(r=>{ const key=[Math.min(r.user_a_id,r.user_b_id), Math.max(r.user_a_id,r.user_b_id)].join('-'); prevPairsSet.add(key); }); } }catch{}
  let bestPairs=null; for(let attempt=0; attempt<8; attempt++){ const shuffled=shuffleArray(participants); const pairs=[]; for(let i=0;i<shuffled.length;i+=2){ const a=shuffled[i]; const b=shuffled[i+1]||null; if(!b) pairs.push({a,b:null,isAI:true}); else pairs.push({a,b,isAI:false}); } let repeats=0; for(const p of pairs){ if(p.isAI) continue; const key=[Math.min(p.a.id,p.b.id), Math.max(p.a.id,p.b.id)].join('-'); if(prevPairsSet.has(key)) repeats++; } if(!bestPairs||repeats<bestPairs.repeats){ bestPairs={pairs,repeats}; if(repeats===0) break; } }
  for(const pr of bestPairs.pairs){ const aId=pr.a.id; const bId= pr.b ? pr.b.id : pr.a.id; const isAi=pr.isAI?1:0; await db.execute({ sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args:[weekId,aId,bId,isAi,'Pick together','both'] }); }
  const envAdmins=Array.from(getAdminEmails());
  return res.json({ ok:true, demo:true, week_label:weekLabel, week_id:weekId, reshuffled_by:callerEmail, is_admin_via:callerIsAdminFlag?'db':'env', admin_list:envAdmins, pairs:bestPairs.pairs.map(p=>({ a:p.a.name, b: p.b ? p.b.name : 'AI partner', a_id:p.a.id, b_id:p.b? p.b.id:null, isAI:p.isAI, is_demo_a: !!p.a.is_demo, is_demo_b: p.b ? !!p.b.is_demo : false })), repeat_avoided:bestPairs.repeats, count:participants.length, note:'Demo shuffle — all available users (demo+real) paired, week marked is_demo=1 if any demo participant' });
}

async function handleDemoReset(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-reset' });
  const ctx = await requireAdmin(req,res);
  if (!ctx) return;
  const {db} = ctx;
  let deletedGroups=0, deletedWeeks=0, deletedUsers=0;
  try{
    const groupsDel = await db.execute(`DELETE FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`);
    deletedGroups = groupsDel.rowsAffected || 0;
  }catch{}
  try{
    // fallback count via changes(); libsql driver may not expose; do count before
  }catch{}
  try{
    // count weeks before delete for response
    const cntW = await db.execute(`SELECT COUNT(*) as c FROM pairing_weeks WHERE is_demo=1`);
    deletedWeeks = cntW.rows[0]?.c || 0;
    await db.execute(`DELETE FROM pairing_weeks WHERE is_demo=1`);
  }catch{}
  try{
    const cntU = await db.execute(`SELECT COUNT(*) as c FROM auth_accounts WHERE is_demo=1`);
    deletedUsers = cntU.rows[0]?.c || 0;
    await db.execute(`DELETE FROM auth_accounts WHERE is_demo=1`);
  }catch{}
  // Also clean orphan groups where user no longer exists (defensive)
  try{ await db.execute(`DELETE FROM pairing_groups WHERE user_a_id NOT IN (SELECT id FROM auth_accounts) OR user_b_id NOT IN (SELECT id FROM auth_accounts)`); }catch{}
  return res.json({ ok:true, deleted:{ groups:deletedGroups, weeks:deletedWeeks, demo_users:deletedUsers }, note:'Demo reset complete — demo users + demo weeks + their groups deleted. Real users untouched.' });
}

export default async function handler(req,res){
  const ep = getEndpoint(req);
  const pathLower = (req.url||'').toLowerCase();
  if (ep==='notifications-prefs' || ep==='notifications' || ep==='prefs' || ep.includes('notification') || pathLower.includes('notifications') || pathLower.includes('notif') ) return handleNotificationPrefs(req,res);
  if (ep==='availability' || pathLower.includes('availability')) return handleAvailability(req,res);
  if (ep==='demo-seed' || ep==='demo_seed' || pathLower.includes('demo-seed')) return handleDemoSeed(req,res);
  if (ep==='demo-shuffle' || ep==='demo_shuffle' || ep==='dem0-shuffle' || pathLower.includes('demo-shuffle')) return handleDemoShuffle(req,res);
  if (ep==='demo-reset' || ep==='demo_reset' || pathLower.includes('demo-reset')) return handleDemoReset(req,res);
  if (ep==='reshuffle' || ep==='promote' || pathLower.includes('reshuffle') || pathLower.includes('promote')) return handleReshuffle(req,res);
  if (ep==='weekly' || pathLower.includes('weekly') || pathLower.includes('/cron/')) return handleWeekly(req,res);
  if (pathLower.includes('availability')) return handleAvailability(req,res);
  if (pathLower.includes('reshuffle')) return handleReshuffle(req,res);
  if (pathLower.includes('weekly')) return handleWeekly(req,res);
  return res.status(404).json({ error:`unknown ops endpoint '${ep}'`, available:['availability','reshuffle','weekly','promote via reshuffle?action=promote','demo-seed','demo-shuffle','demo-reset'] });
}
