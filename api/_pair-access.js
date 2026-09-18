function positiveSafeId(value,field){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1){
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

// This statement is deliberately reusable as a CTE. Callers that read or
// mutate pair-owned data can therefore repeat authorization in the storage
// statement instead of trusting an earlier, racy preflight check.
export const AUTH_PAIR_ACCESS_SQL=`SELECT pg.id AS pair_group_id,pg.week_id,
    pg.user_a_id,pg.user_b_id,pg.user_c_id
  FROM pairing_groups AS pg
  JOIN pairing_participants AS viewer
    ON viewer.week_id=pg.week_id
   AND viewer.user_id=?
   AND viewer.source='auth'
  WHERE pg.id=? AND pg.week_id=?
    AND (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)
  LIMIT 1`;

export function authPairAccessArgs({userId,weekId,pairGroupId}){
  const authenticatedUserId=positiveSafeId(userId,'userId');
  const authorizedWeekId=positiveSafeId(weekId,'weekId');
  const authorizedPairGroupId=positiveSafeId(pairGroupId,'pairGroupId');
  return [
    authenticatedUserId,
    authorizedPairGroupId,
    authorizedWeekId,
    authenticatedUserId,
    authenticatedUserId,
    authenticatedUserId,
  ];
}

export async function getAuthenticatedPairAccess(db,input){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const result=await db.execute({sql:AUTH_PAIR_ACCESS_SQL,args:authPairAccessArgs(input)});
  return result?.rows?.[0]||null;
}
