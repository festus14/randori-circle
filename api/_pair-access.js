function positiveSafeId(value,field){
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1){
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value;
}

const PAIR_ACCESS_HEAD=`SELECT pg.id AS pair_group_id,pg.week_id,
    pg.user_a_id,pg.user_b_id,pg.user_c_id
  FROM pairing_groups AS pg
  JOIN pairing_participants AS viewer
    ON viewer.week_id=pg.week_id
   AND viewer.user_id=?
   AND viewer.source='auth'`;
const ACTIVE_MEMBERSHIP_JOINS=`
  JOIN circle_memberships AS viewer_membership
    ON viewer_membership.user_id=viewer.user_id
   AND viewer_membership.status='active'
  JOIN circles AS viewer_circle
    ON viewer_circle.id=viewer_membership.circle_id
   AND viewer_circle.is_primary=1
   AND viewer_circle.archived_at IS NULL`;
const PAIR_ACCESS_TAIL=`
  WHERE pg.id=? AND pg.week_id=?
    AND (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)
  LIMIT 1`;

// This statement is deliberately reusable as a CTE. Callers that read or
// mutate pair-owned data can therefore repeat authorization in the storage
// statement instead of trusting an earlier, racy preflight check.
export const AUTH_PAIR_ACCESS_SQL=`${PAIR_ACCESS_HEAD}${PAIR_ACCESS_TAIL}`;

export function authPairAccessSql({
  requireActiveMembership=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true',
}={}){
  return `${PAIR_ACCESS_HEAD}${requireActiveMembership?ACTIVE_MEMBERSHIP_JOINS:''}${PAIR_ACCESS_TAIL}`;
}

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
  const result=await db.execute({sql:authPairAccessSql(),args:authPairAccessArgs(input)});
  return result?.rows?.[0]||null;
}
