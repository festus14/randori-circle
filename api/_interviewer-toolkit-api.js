import { getClient, getJwtSecret } from './_db.js';
import { evaluationInsights, evaluationRoom, EvaluationConflictError, EvaluationInputError, interviewerToolkitAvailable,
  parseEvaluationMutation, readEvaluationReport, readOwnedEvaluations, saveEvaluation } from './_interviewer-toolkit.js';

// Caller supplies its existing authenticated identity and primary selection gate.
// Catch all failures here: notes or SQL values must never reach generic logging.
export async function handleInterviewerToolkit(req,res,{authenticate,selectPrimary,verifyAttestation}){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Vary','Cookie, Authorization');
  const absent=()=>res.status(404).json({error:'pair not found'});
  try{
    const db=getClient();
    if(!await interviewerToolkitAvailable(db)) return absent();
    const payload=await authenticate(req),viewerId=Number(payload?.id??payload?.uid);
    if(!Number.isSafeInteger(viewerId)||viewerId<1) return res.status(401).json({error:'authentication required'});
    if(req.method!=='GET'&&req.method!=='POST'){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'GET or POST only'});}
    if(!await selectPrimary(req,db,payload,viewerId)) return absent();
    const search=new URL(req.url||'/','http://localhost').searchParams;
    const query={...Object.fromEntries(search),...req.query};
    const allowed=req.method==='POST'?['endpoint']:['endpoint','room_id'];
    if(Object.keys(query).some(key=>!allowed.includes(key)||Array.isArray(query[key])||search.getAll(key).length>1)
      ||query.endpoint!==undefined&&query.endpoint!=='interviewer-toolkit') throw new EvaluationInputError('unsupported query parameter');
    if(req.method==='POST'){
      const mutation=parseEvaluationMutation(req.body);
      const evaluation=await saveEvaluation(db,{viewerId,mutation,versionKey:getJwtSecret()});
      return evaluation?res.json({ok:true,room_id:mutation.roomId,evaluation}):absent();
    }
    if(query.room_id!==undefined){
      const report=await readEvaluationReport(db,{viewerId,room:evaluationRoom(query.room_id),versionKey:getJwtSecret(),verifyAttestation});
      return report?res.json({ok:true,report}):absent();
    }
    const mine=await readOwnedEvaluations(db,viewerId);
    return res.json({ok:true,...mine,insights:evaluationInsights(mine.evaluations,mine.truncated)});
  }catch(error){
    if(error instanceof EvaluationInputError) return res.status(400).json({error:error.message});
    if(error instanceof EvaluationConflictError) return res.status(409).json({error:error.message,code:'evaluation_changed'});
    return res.status(503).json({error:'interviewer toolkit unavailable'});
  }
}
