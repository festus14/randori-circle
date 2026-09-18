function numericValue(row,name){
  const value=Number(row?.[name]);
  return Number.isSafeInteger(value)&&value>=0?value:0;
}

// This evaluator is intentionally DDL-free and returns only bounded aggregate
// evidence. It is safe to call from request paths and from write transactions
// that need to re-check the rollout invariant immediately before a mutation.
export async function inspectMembershipAdoptionReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('a database client with execute() is required');
  const rolloutResult=await db.execute(`SELECT id,registrations_closed
    FROM circle_membership_rollout ORDER BY id LIMIT 2`);
  const rolloutRows=rolloutResult.rows||[];
  const blockers=[];
  if(rolloutRows.length!==1||Number(rolloutRows[0]?.id)!==1){
    blockers.push('rollout_singleton_invalid');
    return {ok:false,registrationState:'invalid',blockers,counts:{rolloutRows:rolloutRows.length}};
  }
  const closed=Number(rolloutRows[0].registrations_closed);
  if(![0,1].includes(closed)) blockers.push('rollout_value_invalid');
  const primaryResult=await db.execute(`SELECT id FROM circles
    WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  const primaryRows=primaryResult.rows||[];
  const primaryId=Number(primaryRows[0]?.id);
  const validPrimaryId=Number.isSafeInteger(primaryId)&&primaryId>0;
  const counts={rolloutRows:rolloutRows.length,activePrimaryCircles:primaryRows.length};
  const aggregateResult=await db.execute(`SELECT
    (SELECT COUNT(*) FROM circles) AS circles,
    (SELECT COUNT(*) FROM circle_memberships) AS memberships,
    (SELECT COUNT(*) FROM circle_invitations) AS invitations,
    (SELECT COUNT(*) FROM circle_audit_events) AS auditEvents,
    (SELECT COUNT(*) FROM circle_audit_events WHERE event_type='membership.backfill.completed') AS completedBackfills`);
  counts.circles=numericValue(aggregateResult.rows?.[0],'circles');
  counts.memberships=numericValue(aggregateResult.rows?.[0],'memberships');
  counts.invitations=numericValue(aggregateResult.rows?.[0],'invitations');
  counts.auditEvents=numericValue(aggregateResult.rows?.[0],'auditEvents');
  counts.completedBackfills=numericValue(aggregateResult.rows?.[0],'completedBackfills');

  if(closed===0){
    if(counts.circles||counts.memberships||counts.invitations||counts.auditEvents){
      blockers.push('open_rollout_has_membership_state');
    }
  }else if(closed===1){
    if(primaryRows.length!==1||!validPrimaryId) blockers.push('closed_rollout_primary_circle_invalid');
    if(primaryRows.length===1&&validPrimaryId){
      const stateResult=await db.execute({
        sql:`SELECT
          (SELECT COUNT(*) FROM circle_memberships owner_membership
            JOIN auth_accounts owner_account ON owner_account.id=owner_membership.user_id
              AND COALESCE(owner_account.is_demo,0)=0
            WHERE owner_membership.circle_id=?
              AND owner_membership.role='owner' AND owner_membership.status='active') AS activeOwners,
          (SELECT COUNT(*) FROM circle_audit_events event
            JOIN circle_memberships actor_membership
              ON actor_membership.circle_id=event.circle_id
              AND actor_membership.user_id=event.actor_user_id
              AND actor_membership.role='owner' AND actor_membership.status='active'
            JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
              AND COALESCE(actor_account.is_demo,0)=0
            WHERE event.circle_id=? AND event.event_type='membership.backfill.completed'
              AND event.subject_user_id IS NULL AND event.invitation_id IS NULL
              AND event.dedupe_key=?) AS matchingBackfills,
          (SELECT COUNT(*) FROM auth_accounts account
            WHERE COALESCE(account.is_demo,0)=0
              AND NOT EXISTS (
                SELECT 1 FROM circle_audit_events event
                JOIN circle_memberships actor_membership
                  ON actor_membership.circle_id=event.circle_id
                  AND actor_membership.user_id=event.actor_user_id
                  AND actor_membership.role='owner' AND actor_membership.status='active'
                JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
                  AND COALESCE(actor_account.is_demo,0)=0
                WHERE event.circle_id=? AND event.event_type='membership.backfilled'
                  AND event.subject_user_id=account.id
                  AND event.invitation_id IS NULL
                  AND event.dedupe_key=printf('membership-backfilled:%d:%d',?,account.id)
              )
              AND NOT EXISTS (
                SELECT 1 FROM circle_invitations invitation
                JOIN circle_audit_events event ON event.invitation_id=invitation.id
                WHERE invitation.circle_id=? AND invitation.used_by=account.id
                  AND invitation.used_at IS NOT NULL AND invitation.revoked_at IS NULL
                  AND event.circle_id=invitation.circle_id
                  AND event.event_type='invitation.accepted'
                  AND event.actor_user_id=account.id
                  AND event.subject_user_id=account.id
                  AND event.dedupe_key=('invite-accepted:'||invitation.id)
              )) AS invalidAccountProvenance,
          (SELECT COUNT(*) FROM circle_audit_events event
            LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
            LEFT JOIN circle_memberships actor_membership
              ON actor_membership.circle_id=event.circle_id
              AND actor_membership.user_id=event.actor_user_id
              AND actor_membership.role='owner' AND actor_membership.status='active'
            LEFT JOIN auth_accounts actor_account ON actor_account.id=event.actor_user_id
              AND COALESCE(actor_account.is_demo,0)=0
            WHERE event.event_type='membership.backfilled' AND (
              event.circle_id<>? OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
              OR event.invitation_id IS NOT NULL OR actor_membership.user_id IS NULL
              OR actor_account.id IS NULL
              OR event.dedupe_key IS NOT printf('membership-backfilled:%d:%d',?,account.id)
            )) AS malformedBackfillAudits,
          (SELECT COUNT(*) FROM circle_audit_events event
            LEFT JOIN circle_invitations invitation ON invitation.id=event.invitation_id
            LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
            WHERE event.event_type='invitation.accepted' AND (
              event.circle_id<>? OR invitation.id IS NULL OR invitation.circle_id<>?
              OR invitation.used_at IS NULL OR invitation.revoked_at IS NOT NULL
              OR invitation.used_by IS NOT account.id
              OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
              OR event.actor_user_id IS NOT account.id
              OR event.dedupe_key IS NOT ('invite-accepted:'||invitation.id)
            )) AS malformedInvitationAudits,
          (SELECT COUNT(*) FROM auth_accounts account
            WHERE COALESCE(account.is_demo,0)=0 AND NOT EXISTS (
              SELECT 1 FROM circle_memberships membership
              WHERE membership.circle_id=? AND membership.user_id=account.id
                AND membership.status='active'
            )) AS uncoveredAccounts,
          (SELECT COUNT(*) FROM circle_memberships membership
            LEFT JOIN auth_accounts account ON account.id=membership.user_id
            WHERE membership.status='active' AND account.id IS NULL) AS orphanMemberships`,
        args:[
          primaryId,
          primaryId,`primary-membership-backfill:${primaryId}:v1`,
          primaryId,primaryId,
          primaryId,
          primaryId,primaryId,
          primaryId,primaryId,
          primaryId,
        ],
      });
      const row=stateResult.rows?.[0];
      counts.activeOwners=numericValue(row,'activeOwners');
      counts.matchingBackfills=numericValue(row,'matchingBackfills');
      counts.invalidAccountProvenance=numericValue(row,'invalidAccountProvenance');
      counts.malformedBackfillAudits=numericValue(row,'malformedBackfillAudits');
      counts.malformedInvitationAudits=numericValue(row,'malformedInvitationAudits');
      counts.uncoveredAccounts=numericValue(row,'uncoveredAccounts');
      counts.orphanMemberships=numericValue(row,'orphanMemberships');
      if(counts.activeOwners<1) blockers.push('closed_rollout_has_no_owner');
      if(counts.completedBackfills!==1||counts.matchingBackfills!==1){
        blockers.push('closed_rollout_backfill_audit_invalid');
      }
      if(counts.invalidAccountProvenance||counts.malformedBackfillAudits
        ||counts.malformedInvitationAudits){
        blockers.push('closed_rollout_account_audit_invalid');
      }
      if(counts.uncoveredAccounts) blockers.push('closed_rollout_has_uncovered_accounts');
      if(counts.orphanMemberships) blockers.push('closed_rollout_has_orphan_memberships');
    }
  }
  return {
    ok:blockers.length===0,
    registrationState:closed===1?'closed':closed===0?'open':'invalid',
    blockers,
    counts,
  };
}

// Steady-state readiness deliberately differs from one-time adoption. A
// removed or inactive member may retain an account and historical audit trail;
// that must not take the running product offline. Current active ownership,
// orphan safety, and canonical audit provenance remain mandatory.
export async function inspectCompletedMembershipRollout(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('a database client with execute() is required');
  const rolloutResult=await db.execute(`SELECT id,registrations_closed
    FROM circle_membership_rollout ORDER BY id LIMIT 2`);
  const rolloutRows=rolloutResult.rows||[];
  const blockers=[];
  if(rolloutRows.length!==1||Number(rolloutRows[0]?.id)!==1){
    return {ok:false,registrationState:'invalid',blockers:['rollout_singleton_invalid']};
  }
  if(Number(rolloutRows[0].registrations_closed)!==1){
    return {ok:false,registrationState:'open',blockers:['rollout_not_completed']};
  }
  const primaryResult=await db.execute(`SELECT id,created_by FROM circles
    WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  const primaryRows=primaryResult.rows||[];
  const primaryId=Number(primaryRows[0]?.id);
  const rolloutActorId=Number(primaryRows[0]?.created_by);
  if(primaryRows.length!==1||!Number.isSafeInteger(primaryId)||primaryId<1
    ||!Number.isSafeInteger(rolloutActorId)||rolloutActorId<1){
    return {ok:false,registrationState:'closed',blockers:['closed_rollout_primary_circle_invalid']};
  }
  const stateResult=await db.execute({
    sql:`SELECT
      (SELECT COUNT(*) FROM circle_memberships membership
        JOIN auth_accounts account ON account.id=membership.user_id
          AND COALESCE(account.is_demo,0)=0
        WHERE membership.circle_id=?
          AND membership.role='owner' AND membership.status='active') AS activeOwners,
      (SELECT COUNT(*) FROM auth_accounts account
        WHERE account.id=? AND COALESCE(account.is_demo,0)=0) AS rolloutActors,
      (SELECT COUNT(*) FROM circle_audit_events event
        WHERE event.event_type='membership.backfill.completed') AS completedBackfills,
      (SELECT COUNT(*) FROM circle_audit_events event
        WHERE event.circle_id=? AND event.event_type='membership.backfill.completed'
          AND event.actor_user_id=?
          AND event.subject_user_id IS NULL AND event.invitation_id IS NULL
          AND event.dedupe_key=?) AS matchingBackfills,
      (SELECT COUNT(*) FROM circle_audit_events event
        WHERE event.event_type='membership.backfill.completed' AND (
          event.circle_id<>? OR event.actor_user_id IS NOT ?
          OR event.subject_user_id IS NOT NULL OR event.invitation_id IS NOT NULL
          OR event.dedupe_key IS NOT ?
        )) AS malformedCompletionAudits,
      (SELECT COUNT(*) FROM auth_accounts account
        WHERE COALESCE(account.is_demo,0)=0
          AND NOT EXISTS (
            SELECT 1 FROM circle_audit_events event
            WHERE event.circle_id=? AND event.event_type='membership.backfilled'
              AND event.actor_user_id=?
              AND event.subject_user_id=account.id
              AND event.invitation_id IS NULL
              AND event.dedupe_key=printf('membership-backfilled:%d:%d',?,account.id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM circle_invitations invitation
            JOIN circle_audit_events event ON event.invitation_id=invitation.id
            WHERE invitation.circle_id=? AND invitation.used_by=account.id
              AND invitation.used_at IS NOT NULL AND invitation.revoked_at IS NULL
              AND event.circle_id=invitation.circle_id
              AND event.event_type='invitation.accepted'
              AND event.actor_user_id=account.id
              AND event.subject_user_id=account.id
              AND event.dedupe_key=('invite-accepted:'||invitation.id)
          )) AS invalidAccountProvenance,
      (SELECT COUNT(*) FROM circle_audit_events event
        LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
        WHERE event.event_type='membership.backfilled' AND (
          event.circle_id<>? OR event.actor_user_id IS NOT ?
          OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
          OR event.invitation_id IS NOT NULL
          OR event.dedupe_key IS NOT printf('membership-backfilled:%d:%d',?,account.id)
        )) AS malformedBackfillAudits,
      (SELECT COUNT(*) FROM circle_audit_events event
        LEFT JOIN circle_invitations invitation ON invitation.id=event.invitation_id
        LEFT JOIN auth_accounts account ON account.id=event.subject_user_id
        WHERE event.event_type='invitation.accepted' AND (
          event.circle_id<>? OR invitation.id IS NULL OR invitation.circle_id<>?
          OR invitation.used_at IS NULL OR invitation.revoked_at IS NOT NULL
          OR invitation.used_by IS NOT account.id
          OR account.id IS NULL OR COALESCE(account.is_demo,0)<>0
          OR event.actor_user_id IS NOT account.id
          OR event.dedupe_key IS NOT ('invite-accepted:'||invitation.id)
        )) AS malformedInvitationAudits,
      (SELECT COUNT(*) FROM circle_memberships membership
        LEFT JOIN auth_accounts account ON account.id=membership.user_id
        WHERE membership.status='active' AND account.id IS NULL) AS orphanMemberships`,
    args:[
      primaryId,
      rolloutActorId,
      primaryId,rolloutActorId,`primary-membership-backfill:${primaryId}:v1`,
      primaryId,rolloutActorId,`primary-membership-backfill:${primaryId}:v1`,
      primaryId,rolloutActorId,primaryId,primaryId,
      primaryId,rolloutActorId,primaryId,
      primaryId,primaryId,
    ],
  });
  const row=stateResult.rows?.[0];
  const counts={
    activeOwners:numericValue(row,'activeOwners'),
    rolloutActors:numericValue(row,'rolloutActors'),
    completedBackfills:numericValue(row,'completedBackfills'),
    matchingBackfills:numericValue(row,'matchingBackfills'),
    malformedCompletionAudits:numericValue(row,'malformedCompletionAudits'),
    invalidAccountProvenance:numericValue(row,'invalidAccountProvenance'),
    malformedBackfillAudits:numericValue(row,'malformedBackfillAudits'),
    malformedInvitationAudits:numericValue(row,'malformedInvitationAudits'),
    orphanMemberships:numericValue(row,'orphanMemberships'),
  };
  if(counts.activeOwners<1) blockers.push('closed_rollout_has_no_owner');
  if(counts.rolloutActors!==1||counts.completedBackfills!==1||counts.matchingBackfills!==1
    ||counts.malformedCompletionAudits){
    blockers.push('closed_rollout_backfill_audit_invalid');
  }
  if(counts.invalidAccountProvenance||counts.malformedBackfillAudits
    ||counts.malformedInvitationAudits){
    blockers.push('closed_rollout_account_audit_invalid');
  }
  if(counts.orphanMemberships) blockers.push('closed_rollout_has_orphan_memberships');
  return {ok:blockers.length===0,registrationState:'closed',blockers,counts};
}

// Health accepts only a pristine pre-cutover state or a valid completed
// steady state. Mixed open-rollout data and all invalid singleton states fail.
export async function inspectMembershipRolloutReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('a database client with execute() is required');
  const rolloutResult=await db.execute(`SELECT id,registrations_closed
    FROM circle_membership_rollout ORDER BY id LIMIT 2`);
  const rows=rolloutResult.rows||[];
  if(rows.length===1&&Number(rows[0]?.id)===1&&Number(rows[0]?.registrations_closed)===1){
    return inspectCompletedMembershipRollout(db);
  }
  return inspectMembershipAdoptionReadiness(db);
}
