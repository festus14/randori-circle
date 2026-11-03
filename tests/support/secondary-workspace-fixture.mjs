import { publishCirclePairing } from '../../api/_circle-pairing.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import { availabilityCycleKey } from '../../api/_availability.js';

export const WORKSPACE_FLAGS=['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_WORKSPACE_ENABLED'];
export function enableWorkspace(){
  const previous=new Map(WORKSPACE_FLAGS.map(key=>[key,process.env[key]]));
  for(const key of WORKSPACE_FLAGS)process.env[key]='true';
  return ()=>{for(const [key,value] of previous){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
}
export async function seedSecondaryCircle(db,{circleId=20,name='Secondary Dojo',publicId='6f6cde2a-4a55-4d37-9b35-976519b61abc',users=[1,2],unavailable=[],now=new Date()}={}){
  await db.execute({sql:`INSERT INTO circles(id,public_id,slug,name,is_primary,created_by) VALUES(?,?,?,?,0,?)`,
    args:[circleId,publicId,`dojo-${circleId}`,name,users[0]]});
  for(const userId of users)await db.execute({sql:`INSERT INTO circle_memberships(circle_id,user_id,role,status) VALUES(?,?,?,'active')`,args:[circleId,userId,userId===users[0]?'owner':'member']});
  if(unavailable.length){
    const scope={kind:'circle',scopeKey:`circle:${circleId}`,circleId},cycle=resolvePairingCycle({now,state:'current'}),cycleKey=availabilityCycleKey(scope,cycle);
    await db.execute({sql:`INSERT INTO pairing_cycles(scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES(?,?,?,?,?,?,?,?,'cycle_default')`,args:[scope.scopeKey,circleId,cycleKey,cycle.cycleId,cycle.startsAt,cycle.endsAt,cycle.cutoffAt,cycle.timeZone]});
    for(const userId of unavailable)await db.execute({sql:`INSERT INTO pairing_cycle_availability(scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES(?,?,?,0,1,'user')`,args:[scope.scopeKey,cycleKey,userId]});
  }
  await publishCirclePairing(db,{authority:{kind:'system',circleId},now});
  const result=await db.execute({sql:`SELECT * FROM circle_pairing_groups WHERE circle_id=? ORDER BY id`,args:[circleId]});
  const group=result.rows[0];
  return {circleId,publicId,name,group,room:`circle_${circleId}_publication_${group.publication_id}_group_${group.id}`};
}
