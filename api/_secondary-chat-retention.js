// The v11 engine's leases, evidence bindings, legal holds, checkpoints and
// limits are reused verbatim. Only its fixed storage vocabulary is mapped to
// the parallel secondary registry. This adapter is for the operator worker,
// never for workspace request authorization. The legacy worker is unchanged.
export function secondaryChatRetentionClient(db){
  const names=['chat_retention_control','chat_retention_scopes','chat_retention_runs','chat_retention_legal_holds','chat_retention_audit_events','pair_messages'];
  function statement(input){
    const sql=typeof input==='string'?input:input.sql,args=typeof input==='string'?[]:input.args||[];
    if(/INSERT INTO chat_retention_scopes\s*\([\s\S]*\)\s*VALUES/i.test(sql)){
      return {sql:`INSERT INTO circle_chat_retention_scopes
        (publication_id,group_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo,registered_at)
        SELECT pg.publication_id,pg.id,pg.scope_key,pg.circle_id,pg.cycle_key,pg.member_count,pg.user_a_id,pg.user_b_id,pg.is_solo,
          strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM circle_pairing_groups pg
        JOIN circles circle ON circle.id=pg.circle_id AND circle.is_primary=0 AND circle.archived_at IS NULL
        WHERE pg.publication_id=? AND pg.id=? AND pg.scope_key=? AND pg.circle_id=?`,args};
    }
    let translated=sql;
    for(const name of names)translated=translated.replaceAll(new RegExp(`\\b${name}\\b`,'g'),'circle_'+name);
    translated=translated.replace(/\bweek_id\b/g,'publication_id').replace(/\bpair_group_id\b/g,'group_id');
    translated=translated.replace(/\bFROM pairing_groups\b/g,`FROM (SELECT id,publication_id,user_a_id,user_b_id,NULL AS user_c_id FROM circle_pairing_groups)`);
    translated=translated.replace(/circle\.is_primary=1/g,'circle.is_primary=0');
    translated=translated.replace(/UNION SELECT user_b_id FROM ([\s\S]*?) WHERE id=\? AND publication_id=\?\n/g,
      'UNION SELECT user_b_id FROM $1 WHERE id=? AND publication_id=? AND user_b_id IS NOT NULL\n');
    return {sql:translated,args};
  }
  function result(value){
    return {...value,rows:value.rows.map(row=>({...row,
      ...(row.publication_id===undefined?{}:{week_id:row.publication_id}),
      ...(row.group_id===undefined?{}:{pair_group_id:row.group_id}),
    }))};
  }
  function wrap(client){
    return {async execute(input){return result(await client.execute(statement(input)));},
      async batch(inputs,mode){return (await client.batch(inputs.map(statement),mode)).map(result);},
      async transaction(mode){return wrap(await client.transaction(mode));},
      commit:()=>client.commit(),rollback:()=>client.rollback(),close:()=>client.close?.(),
    };
  }
  return wrap(db);
}
