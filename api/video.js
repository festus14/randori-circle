import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { authPairAccessArgs, authPairAccessSql } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';

const WORKSPACE_SCHEMA_VERSION = 3;
const MAX_WORKSPACE_CODE_BYTES = 20 * 1024;
const MAX_LEGACY_WORKSPACE_PAYLOAD_BYTES = 24 * 1024;
const MAX_WORKSPACE_PAYLOAD_BYTES = 256 * 1024;
const MAX_BOARD_BYTES = 192 * 1024;
const MAX_BOARD_SHAPES = 500;
const MAX_BOARD_POINTS = 10_000;
const MAX_PEN_POINTS = 2_000;
const MAX_BOARD_COORDINATE = 100_000;
const MAX_BOARD_TEXT_BYTES = 200;
const MAX_STICKY_TEXT_BYTES = 300;
const WORKSPACE_FIELDS_V1 = [
  'base_revision',
  'client_id',
  'client_seq',
  'code',
  'language',
  'question_id',
  'schema_version',
];
const WORKSPACE_FIELDS_V2 = [
  'base_revision',
  'client_id',
  'client_seq',
  'code',
  'language',
  'question_id',
  'question_version',
  'schema_version',
];
const WORKSPACE_FIELDS_V3 = [
  'base_revision',
  'board',
  'client_id',
  'client_seq',
  'code',
  'language',
  'question_id',
  'question_version',
  'schema_version',
];
const BOARD_FIELDS = ['shapes'];
const BOARD_SHAPE_FIELDS = {
  pen:['color','id','points','type','width'],
  rect:['color','h','id','type','w','x','y'],
  ellipse:['color','h','id','type','w','x','y'],
  arrow:['color','id','type','x1','x2','y1','y2'],
  text:['color','id','size','text','type','x','y'],
  sticky:['bg','h','id','text','type','w','x','y'],
};
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

function byteLength(value){
  return Buffer.byteLength(value, 'utf8');
}

function parseCanonicalRoomId(value){
  if(typeof value!=='string') return null;
  const roomId=value;
  const parsed=parseCanonicalRoomPath(`/join/${roomId}`);
  return parsed?.roomId===roomId ? parsed : null;
}

function authenticatedUserId(payload){
  const userId=Number(payload?.id||payload?.uid);
  return Number.isSafeInteger(userId) && userId>0 ? userId : null;
}

function pairAccessArgs(userId,room){
  return authPairAccessArgs({userId,weekId:room.weekId,pairGroupId:room.pairGroupId});
}

function parseSignalRoom(value){
  if(typeof value!=='string') return null;
  const normalized=value.trim();
  const canonical=normalized.match(/^week_([1-9]\d*)_pair_([1-9]\d*)$/i);
  if(canonical){
    const weekId=Number(canonical[1]);
    const pairGroupId=Number(canonical[2]);
    if(!Number.isSafeInteger(weekId) || !Number.isSafeInteger(pairGroupId)) return null;
    return {kind:'canonical',weekId,pairGroupId,roomId:`week_${weekId}_pair_${pairGroupId}`};
  }
  const legacy=normalized.match(/^w([1-9]\d*)-p([1-9]\d*)(?:-([1-9]\d*|ai))?$/i);
  if(!legacy) return null;
  const weekId=Number(legacy[1]);
  const firstId=Number(legacy[2]);
  const secondRaw=legacy[3]?.toLowerCase()||null;
  const secondId=secondRaw && secondRaw!=='ai' ? Number(secondRaw) : null;
  if(![weekId,firstId,...(secondId===null?[]:[secondId])].every(Number.isSafeInteger)) return null;
  return {kind:'legacy',weekId,firstId,secondId,isAi:secondRaw==='ai'};
}

async function resolveSignalRoom(db,userId,value){
  const parsed=parseSignalRoom(value);
  if(!parsed) return null;
  if(parsed.kind==='canonical') return parsed;

  let descriptorSql;
  const descriptorArgs=[];
  if(parsed.secondId!==null){
    descriptorSql=`((pg.user_a_id=? AND pg.user_b_id=?) OR (pg.user_a_id=? AND pg.user_b_id=?))`;
    descriptorArgs.push(parsed.firstId,parsed.secondId,parsed.secondId,parsed.firstId);
  }else if(parsed.isAi){
    descriptorSql=`pg.user_a_id=? AND COALESCE(pg.is_ai_pair,0)=1`;
    descriptorArgs.push(parsed.firstId);
  }else{
    descriptorSql=`(pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)`;
    descriptorArgs.push(parsed.firstId,parsed.firstId,parsed.firstId);
  }
  const result=await db.execute({
    sql:`SELECT pg.id AS pair_group_id,pg.week_id
      FROM pairing_groups pg
      JOIN pairing_participants viewer
        ON viewer.week_id=pg.week_id
       AND viewer.user_id=?
       AND viewer.source='auth'
      WHERE pg.week_id=?
        AND (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)
        AND ${descriptorSql}
      ORDER BY pg.id ASC
      LIMIT 2`,
    args:[userId,parsed.weekId,userId,userId,userId,...descriptorArgs],
  });
  if(result.rows?.length!==1) return null;
  const pairGroupId=Number(result.rows[0].pair_group_id);
  const weekId=Number(result.rows[0].week_id);
  if(!Number.isSafeInteger(pairGroupId) || pairGroupId<=0 || weekId!==parsed.weekId) return null;
  return {kind:'canonical',weekId,pairGroupId,roomId:`week_${weekId}_pair_${pairGroupId}`};
}

function scalarString(value){
  return typeof value==='string' || typeof value==='number' ? String(value) : '';
}

function isPlainObject(value){
  if(!value || typeof value!=='object' || Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype || prototype===null;
}

function hasExactFields(value,expectedFields){
  if(!isPlainObject(value)) return false;
  const fields=Object.keys(value).sort();
  return fields.length===expectedFields.length
    && fields.every((field,index)=>field===expectedFields[index]);
}

function validBoardCoordinate(value){
  return typeof value==='number'
    && Number.isFinite(value)
    && Math.abs(value)<=MAX_BOARD_COORDINATE;
}

function validBoardColor(value){
  return typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value);
}

function validateBoard(board){
  if(!hasExactFields(board,BOARD_FIELDS) || !Array.isArray(board.shapes)){
    return {status:400,error:'board must contain exactly a shapes array'};
  }
  let serialized;
  try{ serialized=JSON.stringify(board); }
  catch{ return {status:400,error:'board must be JSON serializable'}; }
  if(typeof serialized!=='string' || byteLength(serialized)>MAX_BOARD_BYTES){
    return {status:413,error:'workspace board too large'};
  }
  if(board.shapes.length>MAX_BOARD_SHAPES){
    return {status:413,error:`board cannot contain more than ${MAX_BOARD_SHAPES} shapes`};
  }

  const ids=new Set();
  let pointCount=0;
  for(const shape of board.shapes){
    if(!isPlainObject(shape) || typeof shape.type!=='string' || !BOARD_SHAPE_FIELDS[shape.type]){
      return {status:400,error:'board contains an invalid shape type'};
    }
    if(!hasExactFields(shape,BOARD_SHAPE_FIELDS[shape.type])){
      return {status:400,error:`board ${shape.type} shape has invalid fields`};
    }
    if(typeof shape.id!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(shape.id) || ids.has(shape.id)){
      return {status:400,error:'board shape ids must be unique URL-safe strings of at most 64 characters'};
    }
    ids.add(shape.id);

    if(shape.type==='pen'){
      if(!validBoardColor(shape.color)) return {status:400,error:'board shape color must be a six-digit hex color'};
      if(typeof shape.width!=='number' || !Number.isFinite(shape.width) || shape.width<0.5 || shape.width>32){
        return {status:400,error:'board pen width must be between 0.5 and 32'};
      }
      if(!Array.isArray(shape.points) || shape.points.length<2){
        return {status:400,error:'board pen shapes require at least two points'};
      }
      if(shape.points.length>MAX_PEN_POINTS){
        return {status:413,error:`board pen shapes cannot contain more than ${MAX_PEN_POINTS} points`};
      }
      pointCount+=shape.points.length;
      if(pointCount>MAX_BOARD_POINTS){
        return {status:413,error:`board cannot contain more than ${MAX_BOARD_POINTS} points`};
      }
      for(const point of shape.points){
        if(!hasExactFields(point,['x','y']) || !validBoardCoordinate(point.x) || !validBoardCoordinate(point.y)){
          return {status:400,error:'board pen points require bounded finite x and y coordinates'};
        }
      }
      continue;
    }

    if(shape.type==='rect' || shape.type==='ellipse'){
      if(!validBoardColor(shape.color)) return {status:400,error:'board shape color must be a six-digit hex color'};
      if(![shape.x,shape.y,shape.w,shape.h].every(validBoardCoordinate)){
        return {status:400,error:'board shape coordinates must be finite and bounded'};
      }
      continue;
    }

    if(shape.type==='arrow'){
      if(!validBoardColor(shape.color)) return {status:400,error:'board shape color must be a six-digit hex color'};
      if(![shape.x1,shape.y1,shape.x2,shape.y2].every(validBoardCoordinate)){
        return {status:400,error:'board shape coordinates must be finite and bounded'};
      }
      continue;
    }

    if(shape.type==='text'){
      if(!validBoardColor(shape.color)) return {status:400,error:'board shape color must be a six-digit hex color'};
      if(!validBoardCoordinate(shape.x) || !validBoardCoordinate(shape.y)){
        return {status:400,error:'board shape coordinates must be finite and bounded'};
      }
      if(!Number.isSafeInteger(shape.size) || shape.size<8 || shape.size>96){
        return {status:400,error:'board text size must be an integer between 8 and 96'};
      }
      if(typeof shape.text!=='string') return {status:400,error:'board text must be a string'};
      if(byteLength(shape.text)>MAX_BOARD_TEXT_BYTES){
        return {status:413,error:`board text cannot exceed ${MAX_BOARD_TEXT_BYTES} bytes`};
      }
      continue;
    }

    if(!validBoardColor(shape.bg)) return {status:400,error:'board sticky color must be a six-digit hex color'};
    if(![shape.x,shape.y,shape.w,shape.h].every(validBoardCoordinate)){
      return {status:400,error:'board shape coordinates must be finite and bounded'};
    }
    if(typeof shape.text!=='string') return {status:400,error:'board sticky text must be a string'};
    if(byteLength(shape.text)>MAX_STICKY_TEXT_BYTES){
      return {status:413,error:`board sticky text cannot exceed ${MAX_STICKY_TEXT_BYTES} bytes`};
    }
  }
  return {board};
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
  const schemaVersion=payload.schema_version;
  if(schemaVersion!==1 && schemaVersion!==2 && schemaVersion!==WORKSPACE_SCHEMA_VERSION){
    return {status:400,error:`workspace payload must use schema_version 1, 2, or ${WORKSPACE_SCHEMA_VERSION} with exact fields`};
  }
  const maxPayloadBytes=schemaVersion===WORKSPACE_SCHEMA_VERSION
    ? MAX_WORKSPACE_PAYLOAD_BYTES
    : MAX_LEGACY_WORKSPACE_PAYLOAD_BYTES;
  if(byteLength(serialized)>maxPayloadBytes) return {status:413,error:'workspace payload too large'};

  const expectedFields=schemaVersion===1
    ? WORKSPACE_FIELDS_V1
    : schemaVersion===2 ? WORKSPACE_FIELDS_V2 : WORKSPACE_FIELDS_V3;
  const fields=Object.keys(payload).sort();
  if(
    fields.length!==expectedFields.length
    || fields.some((field,index)=>field!==expectedFields[index])
  ){
    return {status:400,error:`workspace payload must use schema_version 1, 2, or ${WORKSPACE_SCHEMA_VERSION} with exact fields`};
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
  if(schemaVersion>=2 && (!Number.isSafeInteger(payload.question_version) || payload.question_version<1)){
    return {status:400,error:'question_version must be a positive safe integer'};
  }
  if(typeof payload.code!=='string') return {status:400,error:'code must be a string'};
  if(byteLength(payload.code)>MAX_WORKSPACE_CODE_BYTES) return {status:413,error:'workspace code too large'};
  if(schemaVersion===WORKSPACE_SCHEMA_VERSION){
    const validatedBoard=validateBoard(payload.board);
    if(validatedBoard.error) return validatedBoard;
  }
  return {
    payload:{
      ...payload,
      question_version:schemaVersion===1 ? null : payload.question_version,
      board:schemaVersion===WORKSPACE_SCHEMA_VERSION ? payload.board : {shapes:[]},
    },
  };
}

function storedWorkspaceContent(row){
  if(Number(row.schema_version)<3){
    return {code:String(row.code),board:{shapes:[]}};
  }
  let envelope;
  try{ envelope=JSON.parse(String(row.code)); }
  catch{ throw new Error('stored workspace envelope is invalid'); }
  if(!hasExactFields(envelope,['board','code']) || typeof envelope.code!=='string'){
    throw new Error('stored workspace envelope is invalid');
  }
  if(byteLength(envelope.code)>MAX_WORKSPACE_CODE_BYTES){
    throw new Error('stored workspace code is too large');
  }
  const validatedBoard=validateBoard(envelope.board);
  if(validatedBoard.error) throw new Error(validatedBoard.error);
  return envelope;
}

function storedWorkspaceCode(workspace){
  return workspace.schema_version===WORKSPACE_SCHEMA_VERSION
    ? JSON.stringify({code:workspace.code,board:workspace.board})
    : workspace.code;
}

function snapshotFromRow(row){
  if(!row) return null;
  const storedQuestionId=String(row.question_id);
  const versionedQuestion=storedQuestionId.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9]\d*)$/);
  const content=storedWorkspaceContent(row);
  return {
    room_id:String(row.room_id),
    revision:Number(row.revision),
    schema_version:Number(row.schema_version),
    client_id:String(row.client_id),
    client_seq:Number(row.client_seq),
    language:String(row.language),
    question_id:versionedQuestion?.[1]||storedQuestionId,
    question_version:versionedQuestion ? Number(versionedQuestion[2]) : null,
    code:content.code,
    board:content.board,
    updated_by:Number(row.updated_by),
    updated_at:String(row.updated_at),
  };
}

async function readAuthorizedWorkspaceSnapshot(db,userId,room){
  const rs=await db.execute({
    sql:`WITH access AS (${authPairAccessSql()})
      SELECT snapshot.room_id,snapshot.revision,snapshot.schema_version,snapshot.client_id,
        snapshot.client_seq,snapshot.language,snapshot.question_id,snapshot.code,
        snapshot.updated_by,snapshot.updated_at,
        CASE WHEN snapshot.room_id IS NULL THEN 0 ELSE 1 END AS snapshot_present
      FROM access
      LEFT JOIN pair_room_snapshots snapshot
        ON snapshot.room_id=?
       AND snapshot.week_id=?
       AND snapshot.pair_group_id=?
      LIMIT 1`,
    args:[...pairAccessArgs(userId,room),room.roomId,room.weekId,room.pairGroupId],
  });
  const row=rs.rows?.[0];
  if(!row) return {authorized:false,snapshot:null};
  return {
    authorized:true,
    snapshot:Number(row.snapshot_present)===1 ? snapshotFromRow(row) : null,
  };
}

function workspaceConflict(res,current){
  return res.status(409).json({ok:false,error:'revision conflict',current});
}

async function handleWorkspacePost(req,res,db,auth,room){
  const parsedPayload=parseWorkspacePayload(req.body?.payload);
  if(parsedPayload.error) return res.status(parsedPayload.status).json({ok:false,error:parsedPayload.error});
  const workspace=parsedPayload.payload;
  const storedQuestionId=workspace.question_version
    ? `${workspace.question_id}@${workspace.question_version}`
    : workspace.question_id;
  const codeEnvelope=storedWorkspaceCode(workspace);
  const userId=authenticatedUserId(auth);
  if(!userId) return res.status(403).json({ok:false,error:'not a member of this room'});
  const initial=await readAuthorizedWorkspaceSnapshot(db,userId,room);
  if(!initial.authorized) return res.status(403).json({ok:false,error:'not a member of this room'});
  const current=initial.snapshot;
  if(current && workspace.schema_version<current.schema_version){
    return res.status(409).json({
      ok:false,
      error:`schema version ${workspace.schema_version} cannot overwrite workspace schema version ${current.schema_version}`,
      current,
    });
  }
  if(current?.client_id===workspace.client_id && current.client_seq===workspace.client_seq){
    return res.json({ok:true,idempotent:true,snapshot:current});
  }
  if((current?.revision||0)!==workspace.base_revision){
    return workspaceConflict(res,current);
  }

  let writeResult;
  if(current){
    writeResult=await db.execute({
      sql:`WITH access AS (${authPairAccessSql()})
        UPDATE pair_room_snapshots
        SET revision=revision+1,schema_version=?,client_id=?,client_seq=?,language=?,question_id=?,code=?,updated_by=?,updated_at=datetime('now')
        WHERE room_id=? AND week_id=? AND pair_group_id=? AND revision=?
          AND EXISTS (SELECT 1 FROM access)
        RETURNING room_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by,updated_at`,
      args:[
        ...pairAccessArgs(userId,room),
        workspace.schema_version,workspace.client_id,workspace.client_seq,workspace.language,
        storedQuestionId,codeEnvelope,userId,room.roomId,room.weekId,room.pairGroupId,workspace.base_revision,
      ],
    });
  }else{
    writeResult=await db.execute({
      sql:`WITH access AS (${authPairAccessSql()})
        INSERT INTO pair_room_snapshots
        (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
        SELECT ?,?,?,1,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM access)
        ON CONFLICT DO NOTHING
        RETURNING room_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by,updated_at`,
      args:[
        ...pairAccessArgs(userId,room),
        room.roomId,room.weekId,room.pairGroupId,workspace.schema_version,workspace.client_id,
        workspace.client_seq,workspace.language,storedQuestionId,codeEnvelope,
        userId,
      ],
    });
  }

  const written=snapshotFromRow(writeResult.rows?.[0]);
  if(written) return res.json({ok:true,idempotent:false,snapshot:written});

  // A competing request may have won the compare-and-swap, or membership may
  // have changed since the initial read. Re-authorize before returning data.
  const latest=await readAuthorizedWorkspaceSnapshot(db,userId,room);
  if(!latest.authorized) return res.status(403).json({ok:false,error:'not a member of this room'});
  const raced=latest.snapshot;
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

async function handleWorkspaceGet(req,res,db,userId,room){
  let rawAfter=req.query?.after_revision;
  if(rawAfter===undefined){
    try{ rawAfter=new URL(req.url,'http://localhost').searchParams.get('after_revision')??undefined; }catch{}
  }
  const afterRevision=parseAfterRevision(rawAfter);
  if(afterRevision===null) return res.status(400).json({ok:false,error:'after_revision must be a safe non-negative integer'});
  const result=await readAuthorizedWorkspaceSnapshot(db,userId,room);
  if(!result.authorized) return res.status(403).json({ok:false,error:'not a member of this room'});
  const current=result.snapshot;
  return res.json({
    ok:true,
    snapshot:current && current.revision>afterRevision ? current : null,
    revision:current?.revision||0,
  });
}

async function insertAuthorizedSignal(db,userId,room,{fromId,toId,type,payload}){
  return db.execute({
    sql:`WITH access AS (${authPairAccessSql()})
      INSERT INTO video_signals (room_id,from_id,to_id,type,payload)
      SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM access)
      RETURNING id`,
    args:[...pairAccessArgs(userId,room),room.roomId,fromId,toId,type,payload],
  });
}

async function trimAuthorizedSignals(db,userId,room){
  return db.execute({
    sql:`WITH access AS (${authPairAccessSql()})
      DELETE FROM video_signals
      WHERE room_id=?
        AND EXISTS (SELECT 1 FROM access)
        AND id NOT IN (
          SELECT id FROM video_signals WHERE room_id=? ORDER BY id DESC LIMIT 500
        )`,
    args:[...pairAccessArgs(userId,room),room.roomId,room.roomId],
  });
}

async function readAuthorizedSignals(db,userId,room,after,peerId){
  const result=await db.execute({
    sql:`WITH access AS (${authPairAccessSql()})
      SELECT signal.id,signal.room_id,signal.from_id,signal.to_id,signal.type,
        signal.payload,signal.created_at,
        CASE WHEN signal.id IS NULL THEN 0 ELSE 1 END AS signal_present
      FROM access
      LEFT JOIN video_signals signal
        ON signal.room_id=?
       AND signal.id>?
       AND signal.created_at>datetime('now','-1 hour')
       AND (?='' OR signal.from_id!=?)
      ORDER BY signal.id ASC
      LIMIT 100`,
    args:[...pairAccessArgs(userId,room),room.roomId,after,peerId,peerId],
  });
  if(!result.rows?.length) return {authorized:false,signals:[]};
  return {
    authorized:true,
    signals:result.rows
      .filter(row=>Number(row.signal_present)===1)
      .map(row=>({
        id:row.id,
        room_id:row.room_id,
        from_id:row.from_id,
        to_id:row.to_id,
        type:row.type,
        payload:row.payload,
        created_at:row.created_at,
      })),
  };
}

async function purgeAuthorizedSignals(db,userId,room){
  await db.execute({
    sql:`WITH access AS (${authPairAccessSql()})
      DELETE FROM video_signals
      WHERE room_id=? AND EXISTS (SELECT 1 FROM access)`,
    args:[...pairAccessArgs(userId,room),room.roomId],
  });
  const access=await db.execute({sql:authPairAccessSql(),args:pairAccessArgs(userId,room)});
  return !!access.rows?.length;
}

async function handleSignal(req,res){
  const payload=await verifyRequestAuth(req);
  if(!payload) return res.status(401).json({ok:false,error:'authentication required'});
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({ok:false,error:'authentication required'});
  const db=getClient();
  try{ await cleanupOld(db); }catch{ return res.status(503).json({ok:false,error:'video signaling unavailable'}); }

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
      try{ return await handleWorkspacePost(req,res,db,payload,room); }
      catch{ return res.status(500).json({ok:false,error:'workspace update failed'}); }
    }
    if(!room_id||!from_id||!type||signalPayload===undefined) return res.status(400).json({ok:false,error:'room_id, from_id, type, payload required'});
    if(!['offer','answer','ice','candidate','join','leave'].includes(type)) return res.status(400).json({ok:false,error:'invalid signal type'});
    if(typeof signalPayload!=='string'){
      try{ signalPayload=JSON.stringify(signalPayload); }catch{ return res.status(400).json({ok:false,error:'signal payload must be JSON serializable'}); }
      if(typeof signalPayload!=='string') return res.status(400).json({ok:false,error:'signal payload required'});
    }
    if(signalPayload.length>20000) return res.status(413).json({ok:false,error:'signal payload too large'});
    try{
      const room=await resolveSignalRoom(db,userId,rawRoomId);
      if(!room) return res.status(403).json({ok:false,error:'not a member of this room'});
      const ins=await insertAuthorizedSignal(db,userId,room,{fromId:from_id,toId:to_id,type,payload:signalPayload});
      if(!ins.rows?.length) return res.status(403).json({ok:false,error:'not a member of this room'});
      try{ await trimAuthorizedSignals(db,userId,room); }catch{}
      return res.json({ok:true,id:ins.rows[0].id??null,room_id:room.roomId,from_id,type});
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
      try{ return await handleWorkspaceGet(req,res,db,userId,room); }
      catch{ return res.status(500).json({ok:false,error:'workspace query failed'}); }
    }
    after=Number.isSafeInteger(after) && after>=0 ? after : 0;
    try{
      const room=await resolveSignalRoom(db,userId,rawRoomId);
      if(!room) return res.status(403).json({ok:false,error:'not a member of this room'});
      const result=await readAuthorizedSignals(db,userId,room,after,peer_id);
      if(!result.authorized) return res.status(403).json({ok:false,error:'not a member of this room'});
      let rows=result.signals;
      if(peer_id) rows=rows.filter(r=>!r.to_id || r.to_id===peer_id || r.to_id==='');
      return res.json({ok:true,room_id:room.roomId,signals:rows,after:rows.length?rows[rows.length-1].id:after,count:rows.length});
    }catch{ return res.status(500).json({ok:false,error:'signal query failed'}); }
  }

  if(req.method==='DELETE'){
    const suppliedRoomId=scalarString(req.body?.room_id||req.query?.room_id).trim();
    if(!suppliedRoomId) return res.status(400).json({ok:false,error:'room_id required'});
    try{
      const room=await resolveSignalRoom(db,userId,suppliedRoomId);
      if(!room) return res.status(403).json({ok:false,error:'not a member of this room'});
      if(!await purgeAuthorizedSignals(db,userId,room)) return res.status(403).json({ok:false,error:'not a member of this room'});
      return res.json({ok:true,purged:true,room_id:room.roomId});
    }
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
