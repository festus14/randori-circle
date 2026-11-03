import { canonicalCompletionPair, projectSessionCompletion } from './_session-completion.js';
import { projectSecondaryCompletion } from './_secondary-workspace.js';
import { secondaryRoomId, workspaceEnvelope, workspaceSessionPredicate } from './_workspace-access.js';

export async function readWorkspaceHistory(db,context,key,{progressEnabled=false}={}){
  const secondary=!context.membership.is_primary,viewer=Number(context.payload.id??context.payload.uid);
  const groupsTable=secondary?'circle_pairing_groups':'pairing_groups',receiptsTable=secondary?'circle_session_completion_receipts':'session_completion_receipts';
  const groupKey=secondary?'publication_id':'week_id',receiptKey=secondary?'group_id':'pair_group_id';
  const accessSql=secondary?`SELECT pg.* FROM circle_pairing_groups pg
    JOIN circle_pairing_eligibility viewer ON viewer.publication_id=pg.publication_id AND viewer.user_id=?
      AND viewer.circle_id=pg.circle_id AND viewer.scope_key=pg.scope_key AND viewer.cycle_key=pg.cycle_key
      AND viewer.is_available=1 AND viewer.group_position=pg.position AND viewer.group_size=pg.member_count
    JOIN circle_memberships membership ON membership.circle_id=pg.circle_id AND membership.user_id=viewer.user_id AND membership.status='active'
    JOIN circles circle ON circle.id=membership.circle_id AND circle.is_primary=0 AND circle.archived_at IS NULL
    WHERE viewer.user_id IN (pg.user_a_id,pg.user_b_id) AND ${workspaceSessionPredicate(context,'pg.circle_id')}`
    :`SELECT pg.*,pa.source AS user_a_source,pb.source AS user_b_source,pc.source AS user_c_source FROM pairing_groups pg
    JOIN pairing_participants viewer ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
    JOIN circle_memberships membership ON membership.user_id=viewer.user_id AND membership.status='active'
    JOIN circles circle ON circle.id=membership.circle_id AND circle.is_primary=1 AND circle.archived_at IS NULL
    LEFT JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id
    LEFT JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id
    LEFT JOIN pairing_participants pc ON pc.week_id=pg.week_id AND pc.user_id=pg.user_c_id
    WHERE viewer.user_id IN (pg.user_a_id,pg.user_b_id,pg.user_c_id) AND ${workspaceSessionPredicate(context,'circle.id')}`;
  const tx=await db.transaction('read');
  try{
    const rows=await tx.execute({sql:`WITH access AS (${accessSql}) SELECT access.*,
      ${secondary?'publication.cycle_id':'publication.week_label'} AS week_label,${secondary?'publication.starts_at':'publication.week_start'} AS week_start
      FROM access JOIN ${secondary?'circle_pairing_publications':'pairing_weeks'} publication ON publication.id=access.${groupKey}
      ORDER BY week_start DESC,access.id DESC`,args:[viewer]});
    const receipts=await tx.execute({sql:`WITH access AS (${accessSql}) SELECT receipt.* FROM ${receiptsTable} receipt
      JOIN access ON receipt.${groupKey}=access.${groupKey} AND receipt.${receiptKey}=access.id
      ${secondary?'AND receipt.circle_id=access.circle_id AND receipt.scope_key=access.scope_key AND receipt.cycle_key=access.cycle_key':''}
      ORDER BY receipt.${groupKey},receipt.${receiptKey},receipt.user_id`,args:[viewer]});
    const names=await tx.execute({sql:`WITH access AS (${accessSql}) SELECT account.id,account.display_name
      FROM auth_accounts account JOIN circle_memberships member ON member.user_id=account.id AND member.status='active'
      WHERE member.circle_id=? AND EXISTS(SELECT 1 FROM access WHERE account.id IN (user_a_id,user_b_id${secondary?'':',user_c_id'}))`,args:[viewer,context.membership.id]});
    const byName=new Map(names.rows.map(row=>[Number(row.id),String(row.display_name)]));
    const byPair=new Map();for(const receipt of receipts.rows){const id=`${receipt[groupKey]}:${receipt[receiptKey]}`;const list=byPair.get(id)||[];list.push(receipt);byPair.set(id,list);}
    const circle=workspaceEnvelope(context).circle;
    const history=rows.rows.map(row=>{
      const solo=secondary?Number(row.is_solo)===1:Number(row.is_ai_pair)===1;
      const members=secondary?[[row.user_a_id,'auth'],[row.user_b_id,'auth']]:[[row.user_a_id,row.user_a_source],[row.user_b_id,row.user_b_source],[row.user_c_id,row.user_c_source]];
      const partners=solo?[]:members.filter(([id])=>id!=null&&Number(id)!==viewer);
      const partnerNames=solo?['Solo practice']:partners.map(([id,source])=>source==='auth'?(byName.get(Number(id))||'Member unavailable'):'Member unavailable');
      const evidence=byPair.get(`${row[groupKey]}:${row.id}`)||[];
      const completion=secondary?projectSecondaryCompletion({...row,group_id:row.id},evidence,viewer,key)
        :projectSessionCompletion(canonicalCompletionPair({...row,pair_group_id:row.id},viewer),evidence,key);
      return {circle,week_label:row.week_label,week_start:row.week_start,topic:row.topic??'Pick together',topic_kind:row.topic_kind??'both',
        is_ai:secondary?false:solo,...(secondary?{solo,publication_id:row.publication_id,group_id:row.id,room_id:secondaryRoomId({circleId:context.membership.id,publicationId:row.publication_id,groupId:row.id})}:{pg_id:row.id,week_id:row.week_id}),
        partner_id:partners[0]?.[0]??null,partner_name:partnerNames.join(' & '),partner_ids:partners.map(([id])=>id),partner_names:partnerNames,
        partner_unavailable:partners.some(([id,source])=>source!=='auth'||!byName.has(Number(id))),you_are_a:Number(row.user_a_id)===viewer,completion};
    });
    const partnerCounts={};for(const row of history){if(!row.is_ai&&!row.solo)for(const name of row.partner_names)partnerCounts[name]=(partnerCounts[name]||0)+1;}
    await tx.commit();
    return {ok:true,...workspaceEnvelope(context),user:{id:context.payload.id??context.payload.uid,name:context.payload.name},history,partner_counts:partnerCounts,total:history.length,
      ...(progressEnabled&&!secondary&&context.circles.length===1?{progress:{enabled:true}}:{})};
  }catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}
