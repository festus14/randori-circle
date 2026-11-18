import assert from 'node:assert/strict';
import { interviewTimerOpenSql } from '../../api/_session-controls.js';

// Real SQLite time, not a mocked application clock. Seed immediately before
// the operation and pause at its actual storage statement across the boundary.
export async function seedExpiringInterview(db,{userAId=1,userBId=2}={}){
  await db.execute({sql:`INSERT INTO pair_session_controls
    (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
      pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,
      revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,?,'auth',?,'auth',NULL,?,'auth','running',500,
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,?,'auth',
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  args:[userAId,userBId,userAId,userBId]});
}

export function delayInterviewWrite(db,pattern){
  const observations=[];
  const client={execute:db.execute.bind(db),async transaction(mode){
    const tx=await db.transaction(mode);
    const execute=tx.execute.bind(tx);
    tx.execute=async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      let observation=null;
      if(observations.length===0&&pattern.test(sql)){
        const probe=()=>execute({sql:`SELECT ${interviewTimerOpenSql()} AS timer_open`,args:[10,20]});
        const before=Number((await probe()).rows[0].timer_open);
        assert.equal(before,1,'the operation reaches the write while the real timer is still open');
        await new Promise(resolve=>setTimeout(resolve,700));
        const after=Number((await probe()).rows[0].timer_open);
        assert.equal(after,0,'SQLite time crossed expiry before the real write');
        observation={before,after,sql}; observations.push(observation);
      }
      const result=await execute(statement);
      if(observation) observation.rowsAffected=Number(result.rowsAffected);
      return result;
    };
    return tx;
  }};
  return {client,observations};
}
