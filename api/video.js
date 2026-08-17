import { getClient } from './_db.js';

function getEndpoint(req){
  const q=req.query?.endpoint;
  if(q) return String(q).toLowerCase();
  try{ const u=new URL(req.url,'http://localhost'); const ep=u.searchParams.get('endpoint'); if(ep) return ep.toLowerCase(); const parts=u.pathname.split('/').filter(Boolean); return parts.pop()?.toLowerCase()||''; }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}
async function ensureTable(db){
  // Fixed: added missing ) for CREATE TABLE closure (was missing causing SQLITE syntax error)
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
async function cleanupOld(db){ try{ await db.execute(`DELETE FROM video_signals WHERE created_at < datetime('now','-1 hour')`);}catch{} }

async function handleSignal(req,res){
  const db=getClient();
  try{ await ensureTable(db); await cleanupOld(db); }catch(e){ return res.status(500).json({ ok:false, error:'ensureTable failed', detail:String(e.message||e).slice(0,400)}); }
  if(req.method==='POST'){
    const body=req.body||{}; const room_id=(body.room_id||body.roomId||'').toString().trim().slice(0,128); const from_id=(body.from_id||body.fromId||body.peer_id||'').toString().trim().slice(0,128); const to_id=(body.to_id||body.toId||'').toString().trim().slice(0,128)||null; const type=(body.type||'').toString().trim().slice(0,32); let payload=body.payload;
    if(!room_id||!from_id||!type) return res.status(400).json({ ok:false, error:'room_id, from_id, type required' });
    if(typeof payload!=='string'){ try{ payload=JSON.stringify(payload);}catch{ payload=String(payload);} }
    if(payload.length>20000) payload=payload.slice(0,20000);
    try{ const ins=await db.execute({ sql:`INSERT INTO video_signals (room_id, from_id, to_id, type, payload) VALUES (?,?,?,?,?) RETURNING id`, args:[room_id, from_id, to_id, type, payload]}); return res.json({ ok:true, id:ins.rows?.[0]?.id??null, room_id, from_id, type }); }catch(e){ return res.status(500).json({ ok:false, error:'insert failed', detail:String(e.message||e).slice(0,300)}); }
  }
  if(req.method==='GET'){
    const q=req.query||{}; let room_id=(q.room_id||q.roomId||'').toString(); let peer_id=(q.peer_id||q.peerId||q.from_id||'').toString(); let after=parseInt((q.after||q.since||'0').toString(),10);
    if(!room_id){ try{ const u=new URL(req.url,'http://localhost'); room_id=u.searchParams.get('room_id')||''; peer_id=u.searchParams.get('peer_id')||''; after=parseInt(u.searchParams.get('after')||'0',10)||0; }catch{} }
    if(!room_id) return res.status(400).json({ ok:false, error:'room_id required'});
    after=isNaN(after)?0:after;
    try{ let sql=`SELECT id, room_id, from_id, to_id, type, payload, created_at FROM video_signals WHERE room_id=? AND id>? AND created_at > datetime('now','-1 hour')`; const args=[room_id, after]; if(peer_id){ sql+=` AND from_id != ?`; args.push(peer_id); } sql+=` ORDER BY id ASC LIMIT 100`; const rs=await db.execute({ sql, args }); let rows=rs.rows; if(peer_id) rows=rows.filter(r=>!r.to_id || r.to_id===peer_id || r.to_id===''); return res.json({ ok:true, signals:rows, after: rows.length? rows[rows.length-1].id : after, count:rows.length }); }catch(e){ return res.status(500).json({ ok:false, error:'query failed', detail:String(e.message||e).slice(0,300)}); }
  }
  if(req.method==='DELETE'){ const room_id=(req.body?.room_id||req.query?.room_id||'').toString(); try{ if(room_id) await db.execute({ sql:`DELETE FROM video_signals WHERE room_id=?`, args:[room_id]}); else await cleanupOld(db); return res.json({ ok:true, purged:true}); }catch(e){ return res.status(500).json({ ok:false, error:String(e.message||e).slice(0,200)}) } }
  return res.status(405).json({ ok:false, error:'GET or POST only'});
}
export default async function handler(req,res){
  const ep=getEndpoint(req); const low=(req.url||'').toLowerCase();
  if(!ep || ep==='signal' || ep==='poll' || ep==='signals' || low.includes('/signal') || low.includes('/video') || ep==='ice' || ep==='join' || ep==='leave') return handleSignal(req,res);
  return res.status(404).json({ ok:false, error:`unknown video route ${ep}`, available:['signal','ice','join','leave'] });
}
