import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';

function getEndpoint(req){
  const q=req.query?.endpoint;
  if(q) return String(q).toLowerCase();
  try{ const u=new URL(req.url,'http://localhost'); const ep=u.searchParams.get('endpoint'); if(ep) return ep.toLowerCase(); const parts=u.pathname.split('/').filter(Boolean); return parts.pop()?.toLowerCase()||''; }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

async function ensureTable(db){
  await db.execute(`CREATE TABLE IF NOT EXISTS video_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)`);}catch{}
}

async function cleanupOld(db){
  try{ await db.execute(`DELETE FROM video_signals WHERE created_at < datetime('now','-1 hour')`);}catch{}
}

async function canAccessRoom(db,payload,roomId){
  const userId=Number(payload?.id||payload?.uid);
  if(!Number.isInteger(userId) || !roomId) return false;

  const canonical=String(roomId).match(/^week_(\d+)_pair_(\d+)$/i);
  if(canonical){
    const weekId=Number(canonical[1]);
    const pairId=Number(canonical[2]);
    const rs=await db.execute({sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE id=? AND week_id=? LIMIT 1`,args:[pairId,weekId]}).catch(()=>({rows:[]}));
    const row=rs.rows[0];
    return !!row && (Number(row.user_a_id)===userId || Number(row.user_b_id)===userId);
  }

  // Compatibility with room links emitted by existing weekly email/SMS code.
  const legacy=String(roomId).match(/^w(\d+)-p(\d+)(?:-(\d+|ai))?$/i);
  if(legacy){
    const weekId=Number(legacy[1]);
    const firstId=Number(legacy[2]);
    const secondRaw=legacy[3];
    let sql=`SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=? AND (user_a_id=? OR user_b_id=?)`;
    const args=[weekId,userId,userId];
    if(secondRaw && secondRaw.toLowerCase()!=='ai'){
      const secondId=Number(secondRaw);
      sql+=` AND ((user_a_id=? AND user_b_id=?) OR (user_a_id=? AND user_b_id=?))`;
      args.push(firstId,secondId,secondId,firstId);
    }else if(secondRaw?.toLowerCase()==='ai'){
      sql+=` AND user_a_id=? AND COALESCE(is_ai_pair,0)=1`;
      args.push(firstId);
    }else{
      sql+=` AND (user_a_id=? OR user_b_id=?)`;
      args.push(firstId,firstId);
    }
    sql+=` LIMIT 1`;
    const rs=await db.execute({sql,args}).catch(()=>({rows:[]}));
    return !!rs.rows.length;
  }

  // Unknown/ad-hoc names have no server-verifiable room capability.
  return false;
}

async function handleSignal(req,res){
  const payload=verifyRequestAuth(req);
  if(!payload) return res.status(401).json({ok:false,error:'authentication required'});
  const db=getClient();
  try{ await ensureTable(db); await cleanupOld(db); }catch{ return res.status(503).json({ok:false,error:'video signaling unavailable'}); }

  if(req.method==='POST'){
    const body=req.body||{};
    const room_id=(body.room_id||body.roomId||'').toString().trim().slice(0,128);
    const from_id=(body.from_id||body.fromId||body.peer_id||'').toString().trim().slice(0,128);
    const to_id=(body.to_id||body.toId||'').toString().trim().slice(0,128)||null;
    const type=(body.type||'').toString().trim().toLowerCase().slice(0,32);
    let signalPayload=body.payload;
    if(!room_id||!from_id||!type||signalPayload===undefined) return res.status(400).json({ok:false,error:'room_id, from_id, type, payload required'});
    if(!['offer','answer','ice','candidate','join','leave','code-sync'].includes(type)) return res.status(400).json({ok:false,error:'invalid signal type'});
    if(!await canAccessRoom(db,payload,room_id)) return res.status(403).json({ok:false,error:'not a member of this room'});
    if(typeof signalPayload!=='string'){
      try{ signalPayload=JSON.stringify(signalPayload); }catch{ return res.status(400).json({ok:false,error:'signal payload must be JSON serializable'}); }
      if(typeof signalPayload!=='string') return res.status(400).json({ok:false,error:'signal payload required'});
    }
    if(signalPayload.length>20000) return res.status(413).json({ok:false,error:'signal payload too large'});
    try{
      const ins=await db.execute({sql:`INSERT INTO video_signals (room_id, from_id, to_id, type, payload) VALUES (?,?,?,?,?) RETURNING id`,args:[room_id,from_id,to_id,type,signalPayload]});
      try{ await db.execute({sql:`DELETE FROM video_signals WHERE room_id=? AND id NOT IN (SELECT id FROM video_signals WHERE room_id=? ORDER BY id DESC LIMIT 500)`,args:[room_id,room_id]}); }catch{}
      return res.json({ok:true,id:ins.rows?.[0]?.id??null,room_id,from_id,type});
    }catch{ return res.status(500).json({ok:false,error:'signal insert failed'}); }
  }

  if(req.method==='GET'){
    const q=req.query||{};
    let room_id=(q.room_id||q.roomId||'').toString().trim().slice(0,128);
    let peer_id=(q.peer_id||q.peerId||q.from_id||'').toString().trim().slice(0,128);
    let after=parseInt((q.after||q.since||'0').toString(),10);
    if(!room_id){
      try{ const u=new URL(req.url,'http://localhost'); room_id=(u.searchParams.get('room_id')||'').slice(0,128); peer_id=(u.searchParams.get('peer_id')||'').slice(0,128); after=parseInt(u.searchParams.get('after')||'0',10)||0; }catch{}
    }
    if(!room_id) return res.status(400).json({ok:false,error:'room_id required'});
    if(!await canAccessRoom(db,payload,room_id)) return res.status(403).json({ok:false,error:'not a member of this room'});
    after=Number.isSafeInteger(after) && after>=0 ? after : 0;
    try{
      let sql=`SELECT id, room_id, from_id, to_id, type, payload, created_at FROM video_signals WHERE room_id=? AND id>? AND created_at > datetime('now','-1 hour')`;
      const args=[room_id,after];
      if(peer_id){ sql+=` AND from_id != ?`; args.push(peer_id); }
      sql+=` ORDER BY id ASC LIMIT 100`;
      const rs=await db.execute({sql,args});
      let rows=rs.rows;
      if(peer_id) rows=rows.filter(r=>!r.to_id || r.to_id===peer_id || r.to_id==='');
      return res.json({ok:true,signals:rows,after:rows.length?rows[rows.length-1].id:after,count:rows.length});
    }catch{ return res.status(500).json({ok:false,error:'signal query failed'}); }
  }

  if(req.method==='DELETE'){
    const room_id=(req.body?.room_id||req.query?.room_id||'').toString().trim().slice(0,128);
    if(!room_id) return res.status(400).json({ok:false,error:'room_id required'});
    if(!await canAccessRoom(db,payload,room_id)) return res.status(403).json({ok:false,error:'not a member of this room'});
    try{ await db.execute({sql:`DELETE FROM video_signals WHERE room_id=?`,args:[room_id]}); return res.json({ok:true,purged:true}); }
    catch{ return res.status(500).json({ok:false,error:'signal purge failed'}); }
  }
  return res.status(405).json({ok:false,error:'GET, POST or DELETE only'});
}

export default async function handler(req,res){
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  const ep=getEndpoint(req); const low=(req.url||'').toLowerCase();
  if(!ep || ep==='signal' || ep==='poll' || ep==='signals' || low.includes('/signal') || low.includes('/video') || ep==='ice' || ep==='join' || ep==='leave') return handleSignal(req,res);
  return res.status(404).json({ok:false,error:`unknown video route ${ep}`,available:['signal','ice','join','leave']});
}
