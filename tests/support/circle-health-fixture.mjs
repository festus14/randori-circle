// Hand-built pairing history for the circle health tests (issue #292).
//
// The helpers write rows exactly as the production publication, schedule and
// completion paths leave them (including every composite foreign key and
// trigger on the completion and secondary-circle tables), so the read model is
// exercised against real storage shapes. They are shared by the unit tests and
// the real-runtime golden path.
import { createHash, randomUUID } from 'node:crypto';

/** `datetime('now')` format (UTC, no zone) for an instant. */
export function sqliteDateTime(value) {
  return new Date(value).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Insert one primary-circle week.
 *
 * groups: [{members:[a,b] | [a,b,c] | [a], ai?:true, agreed?:string,
 *   receipts?:Array<number | {userId:number, at:string}>}]
 * A one-member group is stored as the legacy AI/solo pair (user_a = user_b).
 * Receipts are confirmed one hour after the week starts unless `at` is given.
 * Omit `publishedAt` to store a legacy week without a publication run.
 */
export async function insertPrimaryWeek(db, {
  label, weekStart, publishedAt = null, isDemo = 0, participants = [], groups = [],
}) {
  const week = await db.execute({
    sql: `INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo,created_at)
      VALUES (?,?,'both',?,?) RETURNING id`,
    args: [label, weekStart, isDemo, publishedAt ? sqliteDateTime(publishedAt) : sqliteDateTime(weekStart)],
  });
  const weekId = Number(week.rows[0].id);
  if (publishedAt) {
    await db.execute({
      sql: `INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,algorithm_version,
          algorithm_seed,participant_count,participants_json,created_at)
        VALUES (?,?,?,1,'fixture-v1','fixture',?,?,?)`,
      args: [label, weekId, randomUUID(), participants.length,
        JSON.stringify(participants.map(id => ({ user_id: id, source: 'auth' }))), sqliteDateTime(publishedAt)],
    });
  }
  for (const [position, userId] of participants.entries()) {
    await db.execute({
      sql: `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (?,?,?,'auth')`,
      args: [weekId, userId, position],
    });
  }
  const groupIds = [];
  for (const group of groups) {
    const [a, b = a, c = null] = group.members;
    const ai = group.ai === true || group.members.length === 1;
    const inserted = await db.execute({
      sql: `INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (?,?,?,?,?) RETURNING id`,
      args: [weekId, a, b, c, ai ? 1 : 0],
    });
    const groupId = Number(inserted.rows[0].id);
    groupIds.push(groupId);
    if (group.agreed !== undefined) {
      await db.execute({
        sql: `INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time) VALUES (?,?,'[]',?)`,
        args: [weekId, groupId, group.agreed],
      });
    }
    for (const receipt of group.receipts || []) {
      const userId = typeof receipt === 'number' ? receipt : receipt.userId;
      const at = typeof receipt === 'number' ? new Date(Date.parse(weekStart) + 3600000).toISOString() : receipt.at;
      await db.execute({
        sql: `INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,participant_source,
            pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,'auth',?,?,?,?)`,
        args: [weekId, groupId, userId, a, b, c, at],
      });
    }
  }
  return { weekId, groupIds };
}

function hex64(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Insert one secondary-circle publication with its eligibility snapshot,
 * groups (a one-member group is solo) and agreed schedules.
 *
 * groups: [{members:[a,b] | [a], agreed?:string}]
 */
export async function insertSecondaryPublication(db, {
  circleId, cycleId, startsAt, publishedAt, groups = [], unavailable = [],
}) {
  const scopeKey = `circle:${circleId}`;
  const cycleKey = hex64(`${scopeKey}:${cycleId}`);
  const endsAt = new Date(Date.parse(startsAt) + 7 * 86400000).toISOString();
  const timeZone = 'Europe/London';
  await db.execute({
    sql: `INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,?,?,?,?,?,'cycle_default')`,
    args: [scopeKey, circleId, cycleKey, cycleId, startsAt, endsAt, startsAt, timeZone],
  });
  const available = groups.flatMap(group => group.members);
  const publication = await db.execute({
    sql: `INSERT INTO circle_pairing_publications (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,
        time_zone,generation_token,algorithm_version,algorithm_seed,participant_count,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'fixture-v1',?,?,?) RETURNING id`,
    args: [scopeKey, circleId, cycleKey, cycleId, startsAt, endsAt, startsAt, timeZone, randomUUID(),
      `${scopeKey}:${cycleKey}:weekly`, available.length + unavailable.length, new Date(publishedAt).toISOString()],
  });
  const publicationId = Number(publication.rows[0].id);
  let position = 0;
  for (const [groupPosition, group] of groups.entries()) {
    for (const [memberPosition, userId] of group.members.entries()) {
      await db.execute({
        sql: `INSERT INTO circle_pairing_eligibility (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,
            availability_version,availability_source,position,group_position,group_size,member_position)
          VALUES (?,?,?,?,?,1,0,'cycle_default',?,?,?,?)`,
        args: [publicationId, scopeKey, circleId, cycleKey, userId, position, groupPosition, group.members.length, memberPosition],
      });
      position += 1;
    }
  }
  for (const userId of unavailable) {
    await db.execute({
      sql: `INSERT INTO circle_pairing_eligibility (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,
          availability_version,availability_source,position) VALUES (?,?,?,?,?,0,1,'user',?)`,
      args: [publicationId, scopeKey, circleId, cycleKey, userId, position],
    });
    position += 1;
  }
  for (const [groupPosition, group] of groups.entries()) {
    const [a, b = null] = group.members;
    const solo = b === null;
    const inserted = await db.execute({
      sql: `INSERT INTO circle_pairing_groups (publication_id,scope_key,circle_id,cycle_key,position,member_count,
          user_a_id,user_b_id,user_b_available,user_b_member_position,is_solo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      args: [publicationId, scopeKey, circleId, cycleKey, groupPosition, solo ? 1 : 2, a, b,
        solo ? null : 1, solo ? null : 1, solo ? 1 : 0],
    });
    const groupId = Number(inserted.rows[0].id);
    if (!solo && group.agreed !== undefined) {
      const stamp = new Date(publishedAt).toISOString();
      await db.execute({
        sql: `INSERT INTO circle_pair_schedules (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
            member_count,user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
          VALUES (?,?,?,?,?,?,2,?,?,0,2,?,?,?)`,
        args: [hex64(`schedule:${publicationId}:${groupId}`), publicationId, scopeKey, circleId, cycleKey, groupId,
          a, b, group.agreed, stamp, stamp],
      });
    }
  }
  return { publicationId };
}
