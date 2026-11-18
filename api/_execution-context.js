import { ExecutionBusyError, executionQueueEnabled, recordExecutionRefusal } from './_execution-queue.js';
import { readInterviewGate, resolveInterviewMode } from './_interview-session.js';

// Call only after ordinary execute authorization. No caller-supplied circle or
// priority field is accepted: selected workspace or the one primary circle.
export async function primaryExecutionContext(db, { userId, workspace, weekId, pairId, operation }, env = process.env) {
  if (!executionQueueEnabled(env)) return undefined;
  let circleId = workspace?.context?.membership?.id;
  if (!circleId) {
    let rows;
    try{rows=(await db.execute('SELECT id FROM circles WHERE is_primary=1 AND archived_at IS NULL LIMIT 2')).rows;}
    catch{await recordExecutionRefusal(db,'store');throw new ExecutionBusyError('store');}
    if(rows.length!==1){await recordExecutionRefusal(db,'primary_circle');throw new ExecutionBusyError('primary_circle');}
    circleId = Number(rows[0].id);
  }
  let interview = false;
  if (weekId && pairId && env.INTERVIEW_SESSION_ENABLED === 'true') {
    const mode = await resolveInterviewMode(db);
    const gate = await readInterviewGate(db, mode, { weekId, pairGroupId: pairId });
    interview = gate?.live === true && gate.ended === false;
  }
  return { userId, circleId, interview, operation };
}
