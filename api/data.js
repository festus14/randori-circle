import { getClient, getJwtSecret } from './_db.js';
import jwt from 'jsonwebtoken';

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

function getAuthPayload(req){
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return null;
  try { return jwt.verify(m[1], getJwtSecret()); } catch { return null; }
}

async function ensureBaseTables(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0)`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`);
  } catch {}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
}

async function ensureProfileMigrations(db){
  const alters=[
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN bio TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN tz TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN interview_focus TEXT DEFAULT 'both'`,
    `ALTER TABLE auth_accounts ADD COLUMN leetcode_handle TEXT`,
    `ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`,
  ];
  for(const sql of alters){ try{ await db.execute(sql); }catch{} }
  // new tables
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pair_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, proposed_times TEXT, agreed_time TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_messages_pair ON pair_messages(pair_group_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)`);}catch{}
}

async function handleCircle(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const includeDemo = (req.query?.include_demo === '1' || req.query?.includeDemo === '1' || req.query?.demo === '1');
  try{
    let sql = includeDemo
      ? `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts ORDER BY id`
      : `SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin, is_demo, bio, tz, interview_focus, leetcode_handle FROM auth_accounts WHERE COALESCE(is_demo,0)=0 ORDER BY id`;
    const rs = await db.execute(sql);
    if (rs.rows.length){
      const circle = rs.rows.map(r=>({ id:r.id, display_name:r.display_name, name:r.display_name, email:r.email, color:r.color, created_at:r.created_at, is_available:r.is_available===null||r.is_available===undefined?true:!!r.is_available, isAvailable:r.is_available===null||r.is_available===undefined?true:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, is_demo:!!r.is_demo, bio:r.bio||null, tz:r.tz||null, interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||null, source:'auth' }));
      return res.json({ ok:true, circle, count:circle.length, source:'auth_accounts', filtered_demo: !includeDemo });
    }
  }catch{}
  try{
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r=>({ id:r.id, display_name:r.name, name:r.name, color:r.color, created_at:r.created_at, is_available:true, isAvailable:true, is_admin:false, is_demo:false, source:'users' }));
    return res.json({ ok:true, circle, count:circle.length, source:'users' });
  }catch(e){ return res.status(500).json({ error:'db error', detail:String(e.message||e).slice(0,200)}); }
}

async function handleWeeks(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const includeDemo = (req.query?.include_demo === '1' || req.query?.includeDemo === '1' || req.query?.demo === '1' || req.query?.include_demo === 'true');
  try{
    let sql = includeDemo
      ? `SELECT id, week_label, week_start, focus, created_at, is_demo FROM pairing_weeks ORDER BY id DESC LIMIT 20`
      : `SELECT id, week_label, week_start, focus, created_at, is_demo FROM pairing_weeks WHERE COALESCE(is_demo,0)=0 ORDER BY id DESC LIMIT 20`;
    const weeksRs = await db.execute(sql);
    if (!weeksRs.rows.length) return res.json({ ok:true, weeks:[], filtered_demo: !includeDemo });
    const weekIds = weeksRs.rows.map(w=>w.id);
    const placeholders = weekIds.map(()=>'?').join(',');
    const groupsRs = await db.execute({ sql:`SELECT id as pg_id, week_id, user_a_id, user_b_id, is_ai_pair, topic, topic_kind, created_at FROM pairing_groups WHERE week_id IN (${placeholders}) ORDER BY week_id DESC, id ASC`, args:weekIds });
    const allIds = new Set(); groupsRs.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
    let idTo={};
    if (allIds.size){
      const ids=[...allIds]; const ph=ids.map(()=>'?').join(',');
      try{
        const authRows = await db.execute({ sql:`SELECT id, display_name as name, color, tz, interview_focus FROM auth_accounts WHERE id IN (${ph})`, args:ids });
        authRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,tz:r.tz,focus:r.interview_focus,source:'auth'}; });
        const missing = ids.filter(i=>!idTo[i]);
        if (missing.length){
          const ph2 = missing.map(()=>'?').join(',');
          const uRows = await db.execute({ sql:`SELECT id, name, color FROM users WHERE id IN (${ph2})`, args:missing });
          uRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'users'}; });
        }
      }catch{}
    }
    const weeks = weeksRs.rows.map(w=>{
      const pairs = groupsRs.rows.filter(g=>g.week_id===w.id).map(g=>{
        const a = idTo[g.user_a_id]||{name:`User ${g.user_a_id}`, color:'#999'};
        const b = g.is_ai_pair ? {name:'AI partner', color:'var(--accent)'} : (idTo[g.user_b_id]||{name:`User ${g.user_b_id}`, color:'#999'});
        return { pg_id:g.pg_id, a_id:g.user_a_id, b_id:g.user_b_id, a_name:a.name, b_name:b.name, a_color:a.color, b_color:b.color, is_ai:!!g.is_ai_pair, is_demo_week: !!w.is_demo, topic:g.topic, topic_kind:g.topic_kind, created_at:g.created_at };
      });
      return { id:w.id, week_label:w.week_label, week_start:w.week_start, focus:w.focus, created_at:w.created_at, is_demo:!!w.is_demo, pairs };
    });
    return res.json({ ok:true, weeks, filtered_demo: !includeDemo });
  }catch(e){ return res.status(500).json({ ok:false, error:'weeks query failed', detail:String(e.message||e).slice(0,300)}); }
}

async function handleHistory(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id || payload.uid;
  const groups = await db.execute({ sql:`
    SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.is_ai_pair, pg.topic, pg.topic_kind,
           pw.week_label, pw.week_start
    FROM pairing_groups pg
    JOIN pairing_weeks pw ON pw.id = pg.week_id
    WHERE pg.user_a_id = ? OR pg.user_b_id = ?
    ORDER BY pw.week_start DESC, pg.id DESC
  `, args:[userId,userId] });
  const allIds = new Set(); groups.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
  let idToName={};
  if (allIds.size){
    const ids=[...allIds]; const placeholders=ids.map(()=>'?').join(',');
    try{ const authRows=await db.execute({ sql:`SELECT id, display_name as name FROM auth_accounts WHERE id IN (${placeholders})`, args:ids }); authRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); const missing=ids.filter(i=>!idToName[i]); if(missing.length){ const ph2=missing.map(()=>'?').join(','); const uRows=await db.execute({ sql:`SELECT id, name FROM users WHERE id IN (${ph2})`, args:missing }); uRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); } }catch{}
  }
  const enriched = groups.rows.map(r=>{
    const isA = r.user_a_id===userId;
    const partnerId = isA ? r.user_b_id : r.user_a_id;
    const partnerName = r.is_ai_pair ? 'AI partner' : (idToName[partnerId]||`User ${partnerId}`);
    return { pg_id:r.pg_id, week_id:r.week_id, week_label:r.week_label, week_start:r.week_start, is_ai:!!r.is_ai_pair, topic:r.topic, topic_kind:r.topic_kind, partner_id:partnerId, partner_name:partnerName, you_are_a:isA };
  });
  const partnerCounts={}; enriched.forEach(e=>{ if(!e.is_ai) partnerCounts[e.partner_name]=(partnerCounts[e.partner_name]||0)+1; });
  return res.json({ ok:true, user:{ id:payload.id, name:payload.name }, history:enriched, partner_counts:partnerCounts, total:enriched.length });
}

async function handleInit(req,res){
  if (req.method!=='POST' && req.method!=='GET') return res.status(405).json({ error:'POST or GET' });
  const db = getClient();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0, bio TEXT, tz TEXT, interview_focus TEXT DEFAULT 'both', leetcode_handle TEXT)`,
    `CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, difficulty TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS video_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, pair_label TEXT, transcript TEXT, code_snapshots TEXT, interviewer_questions TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, duration_sec INTEGER, cost_cents INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), created_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE, role TEXT DEFAULT 'both', feedback_json TEXT NOT NULL, evidence TEXT, model_used TEXT, reason_for_pick TEXT, estimated_cost_cents INTEGER, confidence REAL DEFAULT 0.85, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_usage (date TEXT PRIMARY KEY, calls INTEGER DEFAULT 0, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pair_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, proposed_times TEXT, agreed_time TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`
  ],"write");
  const migrations=[`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,`ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,`ALTER TABLE auth_accounts ADD COLUMN bio TEXT`,`ALTER TABLE auth_accounts ADD COLUMN tz TEXT`,`ALTER TABLE auth_accounts ADD COLUMN interview_focus TEXT DEFAULT 'both'`,`ALTER TABLE auth_accounts ADD COLUMN leetcode_handle TEXT`,`ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`];
  for(const sql of migrations){ try{ await db.execute(sql);}catch(_){} }
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_messages_pair ON pair_messages(pair_group_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)`);}catch{}
  return res.json({ ok:true, message:"Tables ready (incl profile fields bio/tz/focus + pair_messages + pair_schedules)" });
}

// ----- NEW ENDPOINTS: profile, my-pair, schedule, messages -----

async function handleProfile(req,res){
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
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
    const allowed = ['display_name','name','color','bio','tz','interview_focus','leetcode_handle','is_available'];
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
    if (body.is_available!==undefined){
      updates.is_available = body.is_available ? 1 : 0;
      updates.availability_updated_at = new Date().toISOString();
    }
    if (Object.keys(updates).length===0) return res.status(400).json({ error:'no fields to update', allowed });
    // build set clause
    const cols = Object.keys(updates);
    const setSql = cols.map(c=>`${c}=?`).join(', ');
    const args = cols.map(c=>updates[c]).concat([userId]);
    try{
      await db.execute({ sql:`UPDATE auth_accounts SET ${setSql} WHERE id=?`, args });
    }catch(e){ return res.status(500).json({ error:'update failed', detail:String(e.message||e).slice(0,200)}); }
    // return fresh
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,is_available,availability_updated_at,is_admin,bio,tz,interview_focus,leetcode_handle FROM auth_accounts WHERE id=?`, args:[userId] });
    const r = rs.rows[0];
    return res.json({ ok:true, user:{ id:r.id, email:r.email, name:r.display_name, display_name:r.display_name, color:r.color, is_available:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'' }});
  }
  return res.status(405).json({ error:'GET or POST only' });
}

async function handleMyPair(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureBaseTables(db);
  await ensureProfileMigrations(db);
  const userId = payload.id || payload.uid;
  // latest non-demo week
  let weekId=null, weekRow=null;
  try{
    const w = await db.execute(`SELECT id, week_label, week_start, focus FROM pairing_weeks WHERE COALESCE(is_demo,0)=0 ORDER BY id DESC LIMIT 1`);
    if (w.rows.length){ weekRow=w.rows[0]; weekId=w.rows[0].id; }
  }catch{}
  // Allow explicit week_id param override
  if (req.query?.week_id){
    const wid = parseInt(String(req.query.week_id),10);
    if (!isNaN(wid)) weekId=wid;
  }
  if (!weekId) return res.json({ ok:true, paired:false, reason:'no_week_yet', message:'No pairs yet — shuffles Sunday 08:00 BST' });
  // find pair group for user in that week
  let grp=null;
  try{
    const g = await db.execute({ sql:`SELECT id as pg_id, week_id, user_a_id, user_b_id, is_ai_pair, topic, topic_kind FROM pairing_groups WHERE week_id=? AND (user_a_id=? OR user_b_id=?) LIMIT 1`, args:[weekId, userId, userId] });
    if (g.rows.length) grp=g.rows[0];
  }catch{}
  if (!grp){
    // fallback any week
    try{
      const g2 = await db.execute({ sql:`SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.is_ai_pair, pg.topic, pg.topic_kind, pw.week_label, pw.week_start FROM pairing_groups pg JOIN pairing_weeks pw ON pw.id=pg.week_id WHERE (pg.user_a_id=? OR pg.user_b_id=?) AND COALESCE(pw.is_demo,0)=0 ORDER BY pg.week_id DESC LIMIT 1`, args:[userId, userId] });
      if (g2.rows.length){
        grp=g2.rows[0];
        weekId=grp.week_id;
        weekRow={ id:grp.week_id, week_label:grp.week_label, week_start:grp.week_start };
      }
    }catch{}
  }
  if (!grp) return res.json({ ok:true, paired:false, week_id:weekId, week:weekRow||null, reason:'not_paired_this_week', message:'You were not paired in the latest shuffle — you may have been marked unavailable.' });
  const isAI = !!grp.is_ai_pair;
  let partner=null;
  if (isAI){
    partner={ id:null, name:'AI partner', display_name:'AI partner', color:'#c8f6a0', is_ai:true, is_ai_partner:true };
  }else{
    const partnerId = grp.user_a_id===userId ? grp.user_b_id : grp.user_a_id;
    try{
      const pr = await db.execute({ sql:`SELECT id, display_name, color, email, bio, tz, interview_focus, leetcode_handle FROM auth_accounts WHERE id=?`, args:[partnerId] });
      if (pr.rows.length){
        const r=pr.rows[0];
        partner={ id:r.id, name:r.display_name, display_name:r.display_name, color:r.color, email:r.email, bio:r.bio||'', tz:r.tz||'', interview_focus:r.interview_focus||'both', leetcode_handle:r.leetcode_handle||'', is_ai:false };
      } else {
        partner={ id:partnerId, name:`User ${partnerId}`, display_name:`User ${partnerId}`, color:'#9aa0a6', is_ai:false };
      }
    }catch{
      partner={ id:partnerId, name:`User ${partnerId}`, is_ai:false };
    }
  }
  // schedule
  let schedule=null;
  try{
    const s = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, grp.pg_id] });
    if (s.rows.length){
      schedule={ id:s.rows[0].id, week_id:s.rows[0].week_id, pair_group_id:s.rows[0].pair_group_id, proposed_times: s.rows[0].proposed_times ? JSON.parse(s.rows[0].proposed_times) : [], agreed_time: s.rows[0].agreed_time||null, updated_at:s.rows[0].updated_at };
    }
  }catch{
    // maybe proposed_times not JSON? fallback
    try{
      const s = await db.execute({ sql:`SELECT id, proposed_times, agreed_time FROM pair_schedules WHERE pair_group_id=? LIMIT 1`, args:[grp.pg_id] });
      if (s.rows.length) schedule={ proposed_times: s.rows[0].proposed_times ? JSON.parse(s.rows[0].proposed_times) : [], agreed_time: s.rows[0].agreed_time||null };
    }catch{}
  }
  // last few messages preview
  let messagesPreview=[];
  try{
    const m = await db.execute({ sql:`SELECT id, sender_id, message, created_at FROM pair_messages WHERE week_id=? AND pair_group_id=? ORDER BY id DESC LIMIT 3`, args:[weekId, grp.pg_id] });
    messagesPreview = m.rows.reverse().map(r=>({ id:r.id, sender_id:r.sender_id, message:r.message, created_at:r.created_at }));
  }catch{}
  const meRow = await db.execute({ sql:`SELECT id, display_name, color, tz, interview_focus FROM auth_accounts WHERE id=?`, args:[userId] }).catch(()=>({rows:[]}));
  const me = meRow.rows && meRow.rows[0] ? { id:meRow.rows[0].id, name:meRow.rows[0].display_name, color:meRow.rows[0].color, tz:meRow.rows[0].tz, interview_focus:meRow.rows[0].interview_focus } : { id:userId };
  return res.json({ ok:true, paired:true, week_id:weekId, week: weekRow ? { id:weekRow.id||weekId, week_label:weekRow.week_label, week_start:weekRow.week_start, focus:weekRow.focus } : { id:weekId }, pair: { pg_id:grp.pg_id, week_id:weekId, user_a_id:grp.user_a_id, user_b_id:grp.user_b_id, is_ai_pair:isAI, is_ai:isAI, topic:grp.topic, topic_kind:grp.topic_kind }, partner, me, schedule, messagesPreview });
}

async function handleSchedule(req,res){
  if (req.method === 'GET'){
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error:'missing Bearer' });
    const db = getClient();
    await ensureProfileMigrations(db);
    const weekId = req.query?.week_id ? parseInt(String(req.query.week_id),10) : null;
    const pairId = req.query?.pair_id ? parseInt(String(req.query.pair_id),10) : (req.query?.pg_id ? parseInt(String(req.query.pg_id),10) : null);
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    const s = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, created_at, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, pairId] }).catch(()=>({rows:[]}));
    if (!s.rows || !s.rows.length) return res.json({ ok:true, schedule:null });
    const row=s.rows[0];
    return res.json({ ok:true, schedule:{ id:row.id, week_id:row.week_id, pair_group_id:row.pair_group_id, proposed_times: row.proposed_times? JSON.parse(row.proposed_times):[], agreed_time:row.agreed_time||null, created_at:row.created_at, updated_at:row.updated_at }});
  }
  if (req.method !== 'POST'){
    return res.status(405).json({ error:'GET or POST only' });
  }
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id||payload.uid;
  const body = req.body||{};
  const weekId = body.week_id ? parseInt(String(body.week_id),10) : (req.query?.week_id? parseInt(String(req.query.week_id),10): null);
  const pairId = body.pair_id ? parseInt(String(body.pair_id),10) : (body.pg_id ? parseInt(String(body.pg_id),10) : (req.query?.pair_id? parseInt(String(req.query.pair_id),10): null));
  if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
  // verify membership
  try{
    const g = await db.execute({ sql:`SELECT user_a_id, user_b_id FROM pairing_groups WHERE id=? AND week_id=?`, args:[pairId, weekId] });
    if (!g.rows.length) return res.status(404).json({ error:'pair not found' });
    const a=g.rows[0].user_a_id, b=g.rows[0].user_b_id;
    if (a!==userId && b!==userId){
      // allow admin to set? check admin
      const isAdminRows = await db.execute({ sql:`SELECT is_admin FROM auth_accounts WHERE id=?`, args:[userId] }).catch(()=>({rows:[]}));
      const isAdmin = isAdminRows.rows && isAdminRows.rows[0] && isAdminRows.rows[0].is_admin;
      if (!isAdmin) return res.status(403).json({ error:'not member of this pair' });
    }
  }catch(e){ return res.status(500).json({ error:'db check failed', detail:String(e.message||e).slice(0,200)}); }
  let proposed = null, agreed = null;
  if (body.proposed_times!==undefined){
    if (Array.isArray(body.proposed_times)){
      proposed = JSON.stringify(body.proposed_times.map(s=>String(s).slice(0,200)).slice(0,20));
    } else if (typeof body.proposed_times==='string'){
      try{ const arr=JSON.parse(body.proposed_times); if(Array.isArray(arr)) proposed=JSON.stringify(arr.slice(0,20)); else proposed=JSON.stringify([body.proposed_times]); }catch{ proposed=JSON.stringify([String(body.proposed_times).slice(0,200)]); }
    }
  }
  if (body.agreed_time!==undefined){
    agreed = body.agreed_time ? String(body.agreed_time).trim().slice(0,200) : null;
  }
  // upsert
  try{
    const existing = await db.execute({ sql:`SELECT id, proposed_times, agreed_time FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, pairId] });
    if (!existing.rows.length){
      const toInsertProposed = proposed || JSON.stringify([]);
      await db.execute({ sql:`INSERT INTO pair_schedules (week_id, pair_group_id, proposed_times, agreed_time, created_at, updated_at) VALUES (?,?,?,?, datetime('now'), datetime('now'))`, args:[weekId, pairId, toInsertProposed, agreed] });
    }else{
      const cur = existing.rows[0];
      const newProposed = proposed !== null ? proposed : cur.proposed_times;
      const newAgreed = agreed !== null ? agreed : cur.agreed_time;
      // if proposed null undefined keep existing; if agreed explicitly set to empty string means clear
      await db.execute({ sql:`UPDATE pair_schedules SET proposed_times=?, agreed_time=?, updated_at=datetime('now') WHERE id=?`, args:[newProposed, newAgreed, cur.id] });
    }
    const fresh = await db.execute({ sql:`SELECT id, week_id, pair_group_id, proposed_times, agreed_time, updated_at FROM pair_schedules WHERE week_id=? AND pair_group_id=? LIMIT 1`, args:[weekId, pairId] });
    const f=fresh.rows[0];
    return res.json({ ok:true, schedule:{ id:f.id, week_id:f.week_id, pair_group_id:f.pair_group_id, proposed_times: f.proposed_times? JSON.parse(f.proposed_times):[], agreed_time:f.agreed_time||null, updated_at:f.updated_at }});
  }catch(e){ return res.status(500).json({ error:'schedule upsert failed', detail:String(e.message||e).slice(0,250)}); }
}

async function handleMessages(req,res){
  const payload = getAuthPayload(req);
  if (!payload) return res.status(401).json({ error:'missing Bearer token' });
  const db = getClient();
  await ensureProfileMigrations(db);
  const userId = payload.id||payload.uid;
  if (req.method === 'GET'){
    const weekId = req.query?.week_id ? parseInt(String(req.query.week_id),10) : null;
    const pairId = req.query?.pair_id ? parseInt(String(req.query.pair_id),10) : (req.query?.pg_id ? parseInt(String(req.query.pg_id),10) : null);
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    // optional after param
    const after = req.query?.after ? parseInt(String(req.query.after),10) : 0;
    try{
      let sql = `SELECT pm.id, pm.sender_id, pm.message, pm.created_at, aa.display_name as sender_name, aa.color as sender_color FROM pair_messages pm LEFT JOIN auth_accounts aa ON aa.id=pm.sender_id WHERE pm.week_id=? AND pm.pair_group_id=?`;
      const args=[weekId, pairId];
      if (after){ sql+=` AND pm.id>?`; args.push(after); }
      sql+=` ORDER BY pm.id ASC LIMIT 100`;
      const rs = await db.execute({ sql, args });
      return res.json({ ok:true, messages: rs.rows.map(r=>({ id:r.id, sender_id:r.sender_id, sender_name:r.sender_name||`User ${r.sender_id}`, sender_color:r.sender_color||'#9aa0a6', message:r.message, created_at:r.created_at })), after: rs.rows.length? rs.rows[rs.rows.length-1].id : after });
    }catch(e){ return res.status(500).json({ error:'messages fetch failed', detail:String(e.message||e).slice(0,200)}); }
  }
  if (req.method === 'POST'){
    const body = req.body||{};
    const weekId = body.week_id ? parseInt(String(body.week_id),10) : null;
    const pairId = body.pair_id ? parseInt(String(body.pair_id),10) : (body.pg_id ? parseInt(String(body.pg_id),10) : null);
    const text = body.message ? String(body.message).trim().slice(0,2000) : '';
    if (!weekId || !pairId) return res.status(400).json({ error:'week_id and pair_id required' });
    if (!text) return res.status(400).json({ error:'message required' });
    // verify membership
    try{
      const g = await db.execute({ sql:`SELECT user_a_id, user_b_id FROM pairing_groups WHERE id=? AND week_id=?`, args:[pairId, weekId] });
      if (!g.rows.length) return res.status(404).json({ error:'pair not found' });
      const a=g.rows[0].user_a_id, b=g.rows[0].user_b_id;
      if (a!==userId && b!==userId){
        const adminCheck = await db.execute({ sql:`SELECT is_admin FROM auth_accounts WHERE id=?`, args:[userId] }).catch(()=>({rows:[]}));
        if (!adminCheck.rows[0]?.is_admin) return res.status(403).json({ error:'not member of this pair' });
      }
    }catch(e){ return res.status(500).json({ error:'db check failed', detail:e.message?.slice(0,200)}); }
    try{
      const ins = await db.execute({ sql:`INSERT INTO pair_messages (week_id, pair_group_id, sender_id, message, created_at) VALUES (?,?,?, ?, datetime('now')) RETURNING id`, args:[weekId, pairId, userId, text] });
      const id = ins.rows[0].id;
      const rs = await db.execute({ sql:`SELECT pm.id, pm.sender_id, pm.message, pm.created_at, aa.display_name as sender_name, aa.color as sender_color FROM pair_messages pm LEFT JOIN auth_accounts aa ON aa.id=pm.sender_id WHERE pm.id=?`, args:[id] });
      const r=rs.rows[0];
      return res.json({ ok:true, message:{ id:r.id, sender_id:r.sender_id, sender_name:r.sender_name||`User`, sender_color:r.sender_color, message:r.message, created_at:r.created_at }});
    }catch(e){ return res.status(500).json({ error:'insert failed', detail:String(e.message||e).slice(0,200)}); }
  }
  return res.status(405).json({ error:'GET or POST only' });
}

export default async function handler(req,res){
  const ep = getEndpoint(req);
  const path = (req.url||'').toLowerCase();
  if (ep==='circle' || path.includes('/circle')) return handleCircle(req,res);
  if (ep==='weeks' || path.includes('/weeks')) return handleWeeks(req,res);
  if (ep==='history' || path.includes('/history')) return handleHistory(req,res);
  if (ep==='init' || path.includes('/init')) return handleInit(req,res);
  if (ep==='profile' || path.includes('/profile')) return handleProfile(req,res);
  if (ep==='my-pair' || path.includes('my-pair') || ep==='mypair' || path.includes('my_pair') || ep==='my_pair') return handleMyPair(req,res);
  if (ep==='schedule' || path.includes('/schedule')) return handleSchedule(req,res);
  if (ep.includes('message')) return handleMessages(req,res);
  return res.status(404).json({ error:`unknown data endpoint '${ep}'`, available:['circle','weeks','history','init','profile','my-pair','schedule','messages'] });
}
