import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { parseCanonicalRoomPath } from './_pairing.js';

const WORKSPACE_SCHEMA_VERSION = 1;
const MAX_WORKSPACE_CODE_BYTES = 20 * 1024;
const MAX_WORKSPACE_PAYLOAD_BYTES = 24 * 1024;
const WORKSPACE_FIELDS = [
  'base_revision',
  'client_id',
  'client_seq',
  'code',
  'language',
  'question_id',
  'schema_version',
];
let lastCleanupTimestamp=0;
const CLEANUP_INTERVAL_MS=5*60*1000;

function getEndpoint(req){
  const q=req.query?.endpoint;
  if(q) return String(q).toLowerCase();
  try{ const u=new URL(req.url,'http://localhost'); const ep=u.searchParams.get('endpoint'); if(ep) return ep.toLowerCase(); const parts=u.pathname.split('/').filter(Boolean); return parts.pop()?.toLowerCase()||''; }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

async function cleanupOld(db){
  const now=Date.now();
  if(now-lastCleanupTimestamp<CLEANUP_INTERVAL_MS) return;
  lastCleanupTimestamp=now;
  try{ await db.execute(`DELETE FROM video_signals WHERE created_at < datetime('now','-1 hour')`);}catch{}
  try{ await db.execute(`DELETE FROM pair_room_snapshots
    WHERE updated_at < datetime('now','-90 days')
       OR NOT EXISTS (SELECT 1 FROM pairing_groups pg WHERE pg.id=pair_room_snapshots.pair_group_id AND pg.week_id=pair_room_snapshots.week_id)`);}catch{}
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

function byteLength(value){
  return Buffer.byteLength(value, 'utf8');
}

function parseCanonicalRoomId(value){
  if(typeof value!=='string') return null;
  const roomId=value;
  const parsed=parseCanonicalRoomPath(`/join/${roomId}`);
  return parsed?.roomId===roomId ? parsed : null;
}

async function canAccessCanonicalRoom(db,payload,room){
  const userId=Number(payload?.id||payload?.uid);
  if(!Number.isSafeInteger(userId) || userId<=0 || !room) return false;
  const rs=await db.execute({
    sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE id=? AND week_id=? LIMIT 1`,
    args:[room.pairGroupId,room.weekId],
  }).catch(()=>({rows:[]}));
  const row=rs.rows?.[0];
  return !!row && [row.user_a_id,row.user_b_id].some(id=>Number(id)===userId);
}

function scalarString(value){
  return typeof value==='string' || typeof value==='number' ? String(value) : '';
}

function parseWorkspacePayload(value){
  let payload=value;
  let serialized;
  if(typeof payload==='string'){
    serialized=payload;
    if(byteLength(serialized)>MAX_WORKSPACE_PAYLOAD_BYTES) return {status:413,error:'workspace payload too large'};
    try{ payload=JSON.parse(serialized); }catch{ return {status:400,error:'workspace payload must be valid JSON'}; }
  }
  if(!payload || typeof payload!=='object' || Array.isArray(payload)){
    return {status:400,error:'workspace payload must be an object'};
  }
  try{ serialized=JSON.stringify(payload); }
  catch{ return {status:400,error:'workspace payload must be JSON serializable'}; }
  if(typeof serialized!=='string') return {status:400,error:'workspace payload must be an object'};
  if(byteLength(serialized)>MAX_WORKSPACE_PAYLOAD_BYTES) return {status:413,error:'workspace payload too large'};

  const fields=Object.keys(payload).sort();
  if(fields.length!==WORKSPACE_FIELDS.length || fields.some((field,index)=>field!==WORKSPACE_FIELDS[index])){
    return {status:400,error:'workspace payload fields are invalid'};
  }
  if(payload.schema_version!==WORKSPACE_SCHEMA_VERSION){
    return {status:400,error:`schema_version must be ${WORKSPACE_SCHEMA_VERSION}`};
  }
  if(!Number.isSafeInteger(payload.base_revision) || payload.base_revision<0){
    return {status:400,error:'base_revision must be a safe non-negative integer'};
  }
  if(typeof payload.client_id!=='string' || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.client_id)){
    return {status:400,error:'client_id must be 8-64 URL-safe characters'};
  }
  if(!Number.isSafeInteger(payload.client_seq) || payload.client_seq<0){
    return {status:400,error:'client_seq must be a safe non-negative integer'};
  }
  if(payload.language!=='javascript' && payload.language!=='python'){
    return {status:400,error:'language must be javascript or python'};
  }
  if(typeof payload.question_id!=='string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.question_id) || payload.question_id.length>120){
    return {status:400,error:'question_id must be a safe lowercase slug of at most 120 characters'};
  }
  if(typeof payload.code!=='string') return {status:400,error:'code must be a string'};
  if(byteLength(payload.code)>MAX_WORKSPACE_CODE_BYTES) return {status:413,error:'workspace code too large'};
  return {payload};
}

function snapshotFromRow(row){
  if(!row) return null;
  return {
    room_id:String(row.room_id),
    revision:Number(row.revision),
    schema_version:Number(row.schema_version),
    client_id:String(row.client_id),
    client_seq:Number(row.client_seq),
    language:String(row.language),
    question_id:String(row.question_id),
    code:String(row.code),
    updated_by:Number(row.updated_by),
    updated_at:String(row.updated_at),
  };
}

async function readWorkspaceSnapshot(db,roomId){
  const rs=await db.execute({
    sql:`SELECT room_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by,updated_at FROM pair_room_snapshots WHERE room_id=? LIMIT 1`,
    args:[roomId],
  });
  return snapshotFromRow(rs.rows?.[0]);
}

function workspaceConflict(res,current){
  return res.status(409).json({ok:false,error:'revision conflict',current});
}

async function handleWorkspacePost(req,res,db,auth,room){
  const parsedPayload=parseWorkspacePayload(req.body?.payload);
  if(parsedPayload.error) return res.status(parsedPayload.status).json({ok:false,error:parsedPayload.error});
  const workspace=parsedPayload.payload;
  const current=await readWorkspaceSnapshot(db,room.roomId);
  if(current?.client_id===workspace.client_id && current.client_seq===workspace.client_seq){
    return res.json({ok:true,idempotent:true,snapshot:current});
  }
  if((current?.revision||0)!==workspace.base_revision){
    return workspaceConflict(res,current);
  }

  let writeResult;
  if(current){
    writeResult=await db.execute({
      sql:`UPDATE pair_room_snapshots
        SET revision=revision+1,schema_version=?,client_id=?,client_seq=?,language=?,question_id=?,code=?,updated_by=?,updated_at=datetime('now')
        WHERE room_id=? AND revision=?
        RETURNING room_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by,updated_at`,
      args:[
        workspace.schema_version,workspace.client_id,workspace.client_seq,workspace.language,
        workspace.question_id,workspace.code,Number(auth.id||auth.uid),room.roomId,workspace.base_revision,
      ],
    });
  }else{
    writeResult=await db.execute({
      sql:`INSERT INTO pair_room_snapshots
        (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
        VALUES (?,?,?,1,?,?,?,?,?,?,?)
        ON CONFLICT DO NOTHING
        RETURNING room_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by,updated_at`,
      args:[
        room.roomId,room.weekId,room.pairGroupId,workspace.schema_version,workspace.client_id,
        workspace.client_seq,workspace.language,workspace.question_id,workspace.code,
        Number(auth.id||auth.uid),
      ],
    });
  }

  const written=snapshotFromRow(writeResult.rows?.[0]);
  if(written) return res.json({ok:true,idempotent:false,snapshot:written});

  // A competing request won the compare-and-swap after our initial read.
  const raced=await readWorkspaceSnapshot(db,room.roomId);
  if(raced?.client_id===workspace.client_id && raced.client_seq===workspace.client_seq){
    return res.json({ok:true,idempotent:true,snapshot:raced});
  }
  return workspaceConflict(res,raced);
}

function parseAfterRevision(value){
  if(value===undefined || value===null || value==='') return 0;
  if(typeof value==='number') return Number.isSafeInteger(value) && value>=0 ? value : null;
  if(typeof value!=='string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function handleWorkspaceGet(req,res,db,room){
  let rawAfter=req.query?.after_revision;
  if(rawAfter===undefined){
    try{ rawAfter=new URL(req.url,'http://localhost').searchParams.get('after_revision')??undefined; }catch{}
  }
  const afterRevision=parseAfterRevision(rawAfter);
  if(afterRevision===null) return res.status(400).json({ok:false,error:'after_revision must be a safe non-negative integer'});
  const current=await readWorkspaceSnapshot(db,room.roomId);
  return res.json({
    ok:true,
    snapshot:current && current.revision>afterRevision ? current : null,
    revision:current?.revision||0,
  });
}

async function handleSignal(req,res){
  const payload=verifyRequestAuth(req);
  if(!payload) return res.status(401).json({ok:false,error:'authentication required'});
  const db=getClient();
  await cleanupOld(db);

  if(req.method==='POST'){
    const body=req.body||{};
    const suppliedRoomId=scalarString(body.room_id||body.roomId);
    const rawRoomId=suppliedRoomId.trim();
    const room_id=rawRoomId.slice(0,128);
    const from_id=scalarString(body.from_id||body.fromId||body.peer_id).trim().slice(0,128);
    const to_id=scalarString(body.to_id||body.toId).trim().slice(0,128)||null;
    const type=scalarString(body.type).trim().toLowerCase().slice(0,32);
    let signalPayload=body.payload;
    if(type==='code-sync'){
      const room=parseCanonicalRoomId(suppliedRoomId);
      if(!room) return res.status(400).json({ok:false,error:'canonical room_id required for workspace sync'});
      if(!await canAccessCanonicalRoom(db,payload,room)) return res.status(403).json({ok:false,error:'not a member of this room'});
      try{ return await handleWorkspacePost(req,res,db,payload,room); }
      catch{ return res.status(500).json({ok:false,error:'workspace update failed'}); }
    }
    if(!room_id||!from_id||!type||signalPayload===undefined) return res.status(400).json({ok:false,error:'room_id, from_id, type, payload required'});
    if(!['offer','answer','ice','candidate','join','leave'].includes(type)) return res.status(400).json({ok:false,error:'invalid signal type'});
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
    let suppliedRoomId=scalarString(q.room_id||q.roomId);
    let rawRoomId=suppliedRoomId.trim();
    let room_id=rawRoomId.slice(0,128);
    let peer_id=scalarString(q.peer_id||q.peerId||q.from_id).trim().slice(0,128);
    let after=parseInt(scalarString(q.after||q.since||'0'),10);
    if(!room_id){
      try{ const u=new URL(req.url,'http://localhost'); suppliedRoomId=u.searchParams.get('room_id')||''; rawRoomId=suppliedRoomId.trim(); room_id=rawRoomId.slice(0,128); peer_id=(u.searchParams.get('peer_id')||'').slice(0,128); after=parseInt(u.searchParams.get('after')||'0',10)||0; }catch{}
    }
    if(!room_id) return res.status(400).json({ok:false,error:'room_id required'});
    const channel=scalarString(q.channel).trim().toLowerCase() || (()=>{ try{ return new URL(req.url,'http://localhost').searchParams.get('channel')?.toLowerCase()||''; }catch{ return ''; } })();
    if(channel==='workspace'){
      const room=parseCanonicalRoomId(suppliedRoomId);
      if(!room) return res.status(400).json({ok:false,error:'canonical room_id required for workspace sync'});
      if(!await canAccessCanonicalRoom(db,payload,room)) return res.status(403).json({ok:false,error:'not a member of this room'});
      try{ return await handleWorkspaceGet(req,res,db,room); }
      catch{ return res.status(500).json({ok:false,error:'workspace query failed'}); }
    }
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
    const room_id=scalarString(req.body?.room_id||req.query?.room_id).trim().slice(0,128);
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
