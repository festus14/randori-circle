const READ_ONLY_SELECT=/^SELECT\b/i;
const READ_ONLY_PRAGMA=/^PRAGMA\s+(?:foreign_keys|ignore_check_constraints|(?:table_info|table_xinfo|foreign_key_list|index_list|index_info|index_xinfo)\s*\(\s*"[A-Za-z_][A-Za-z0-9_]*"\s*\))$/i;

function statementSql(statement){
  return typeof statement==='string'?statement:statement?.sql;
}

export function assertReadOnlyStatement(statement){
  const sql=String(statementSql(statement)||'').trim().replace(/^(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)+/,'').trim();
  const withoutTrailingSemicolon=sql.replace(/;\s*$/,'').trim();
  if(withoutTrailingSemicolon.includes(';')
    ||(!READ_ONLY_SELECT.test(withoutTrailingSemicolon)&&!READ_ONLY_PRAGMA.test(withoutTrailingSemicolon))){
    throw new Error('schema inspection attempted a non-read-only statement');
  }
  return withoutTrailingSemicolon;
}

export function readOnlyDatabase(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('a database client with execute() is required');
  return Object.freeze({
    execute(statement){
      const sql=assertReadOnlyStatement(statement);
      if(typeof statement==='string') return db.execute(sql);
      return db.execute({sql,args:statement?.args??[]});
    },
  });
}

function splitSqlList(value){
  const parts=[];
  let start=0;
  let depth=0;
  let quote=null;
  for(let index=0;index<value.length;index+=1){
    const character=value[index];
    if(quote){
      if(character===quote){
        if(value[index+1]===quote) index+=1;
        else quote=null;
      }
      continue;
    }
    if(character==="'"||character==='"'||character==='`') quote=character;
    else if(character==='[') quote=']';
    else if(character==='(') depth+=1;
    else if(character===')') depth-=1;
    else if(character===','&&depth===0){
      parts.push(value.slice(start,index).trim());
      start=index+1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function createBody(sql){
  const open=sql.indexOf('(');
  if(open<0) return '';
  let depth=0;
  let quote=null;
  for(let index=open;index<sql.length;index+=1){
    const character=sql[index];
    if(quote){
      if(character===quote){
        if(sql[index+1]===quote) index+=1;
        else quote=null;
      }
      continue;
    }
    if(character==="'"||character==='"'||character==='`') quote=character;
    else if(character==='[') quote=']';
    else if(character==='(') depth+=1;
    else if(character===')'){
      depth-=1;
      if(depth===0) return sql.slice(open+1,index);
    }
  }
  return '';
}

function stripSqlComments(sql){
  let result='';
  let quote=null;
  for(let index=0;index<sql.length;index+=1){
    const character=sql[index];
    if(quote){
      result+=character;
      if(character===quote){
        if(sql[index+1]===quote) result+=sql[++index];
        else quote=null;
      }
      continue;
    }
    if(character==="'"||character==='"'||character==='`'){
      quote=character;
      result+=character;
      continue;
    }
    if(character==='-'&&sql[index+1]==='-'){
      index+=2;
      while(index<sql.length&&sql[index]!=='\n') index+=1;
      result+='\n';
      continue;
    }
    if(character==='/'&&sql[index+1]==='*'){
      const end=sql.indexOf('*/',index+2);
      index=end<0?sql.length:end+1;
      result+=' ';
      continue;
    }
    result+=character;
  }
  return result;
}

function unquote(value){
  return String(value||'').trim().replace(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\])$/,'$1$2$3');
}

function unnamedTableConstraint(value){
  return String(value||'').replace(
    /^CONSTRAINT\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+/i,
    '',
  );
}

function indexedColumnName(value){
  const match=/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)/.exec(String(value||'').trim());
  return match?unquote(match[1]):null;
}

function normalizeDefault(value){
  if(value===null||value===undefined) return null;
  let result=String(value).trim();
  while(result.startsWith('(')&&result.endsWith(')')){
    const body=createBody(`x${result}`);
    if(body!==result.slice(1,-1)) break;
    result=result.slice(1,-1).trim();
  }
  return normalizeSqlFragment(result);
}

function defaultExpression(definition){
  const match=/\bDEFAULT\s+(\((?:[^()]|\([^()]*\))*\)|'(?:''|[^'])*'|"(?:""|[^"])*"|[^\s,]+)/i.exec(definition);
  return normalizeDefault(match?.[1]??null);
}

export function expectedColumns(tableDefinition){
  const columns=[];
  const primaryKey=[];
  for(const rawPart of splitSqlList(createBody(stripSqlComments(tableDefinition.sql)))){
    const part=unnamedTableConstraint(rawPart);
    const tablePrimary=/^PRIMARY\s+KEY\s*\((.*?)\)(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?$/i.exec(part);
    if(tablePrimary){
      primaryKey.push(...splitSqlList(tablePrimary[1]).map(indexedColumnName).filter(Boolean));
      continue;
    }
    if(/^(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\b/i.test(part)) continue;
    const match=/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+([^\s]+)/.exec(part);
    if(!match) continue;
    const name=unquote(match[1]);
    columns.push({
      name,
      type:String(match[2]).toUpperCase(),
      notNull:/\bNOT\s+NULL\b/i.test(part),
      primaryKeyPosition:/\bPRIMARY\s+KEY\b/i.test(part)?1:0,
      defaultValue:defaultExpression(part),
      hidden:0,
    });
  }
  primaryKey.forEach((name,index)=>{
    const column=columns.find(candidate=>candidate.name===name);
    if(column) column.primaryKeyPosition=index+1;
  });
  return columns;
}

function normalizeSqlFragment(value,{unquoteIdentifiers=false}={}){
  const literals=[];
  let result=String(value||'').replace(/'(?:''|[^'])*'/g,literal=>{
    const marker=`\u00a7${literals.length}\u00a7`;
    literals.push(literal);
    return marker;
  });
  if(unquoteIdentifiers) result=result.replace(/`([^`]+)`|"([^"]+)"|\[([^\]]+)\]/g,(_match,backtick,double,bracket)=>backtick||double||bracket);
  result=result
    .trim()
    .toLowerCase()
    .replace(/\s+/g,' ')
    .replace(/\s*([(),=<>+*/-])\s*/g,'$1');
  return result.replace(/\u00a7(\d+)\u00a7/g,(_match,index)=>literals[Number(index)]);
}

function normalizeExpression(value){
  return normalizeSqlFragment(value,{unquoteIdentifiers:true});
}

function normalizeIndexKeyPart(value){
  return normalizeExpression(value).replace(/\s+asc$/i,'');
}

function parenthesizedExpressions(sql,keyword){
  const expressions=[];
  const pattern=new RegExp(`\\b${keyword}\\s*\\(`,'ig');
  let match;
  while((match=pattern.exec(sql))){
    const open=sql.indexOf('(',match.index);
    let depth=0;
    let quote=null;
    for(let index=open;index<sql.length;index+=1){
      const character=sql[index];
      if(quote){
        if(character===quote){
          if(sql[index+1]===quote) index+=1;
          else quote=null;
        }
        continue;
      }
      if(character==="'"||character==='"'||character==='`') quote=character;
      else if(character==='[') quote=']';
      else if(character==='(') depth+=1;
      else if(character===')'){
        depth-=1;
        if(depth===0){
          expressions.push(normalizeExpression(sql.slice(open+1,index)));
          pattern.lastIndex=index+1;
          break;
        }
      }
    }
  }
  return expressions.sort();
}

function action(fragment,kind){
  return new RegExp(`\\bON\\s+${kind}\\s+(NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT)\\b`,'i')
    .exec(fragment)?.[1]?.toUpperCase().replace(/\s+/g,' ')||'NO ACTION';
}

function indexedTerm(value,defaultCollation='BINARY'){
  const normalized=normalizeExpression(value);
  const collation=/\bcollate\s+([a-z0-9_]+)/i.exec(normalized)?.[1]?.toUpperCase()||defaultCollation;
  return {
    expression:normalized.replace(/\s+collate\s+[a-z0-9_]+/i,'').replace(/\s+(?:asc|desc)$/i,''),
    collation,
    descending:/desc$/i.test(normalized),
  };
}

function indexedTerms(value,columnCollations){
  return splitSqlList(value).map(item=>{
    const expression=indexedTerm(item).expression;
    return indexedTerm(item,columnCollations.get(expression)||'BINARY');
  });
}

function foreignKeyTiming(fragment){
  if(/\bNOT\s+DEFERRABLE\b/i.test(fragment)) return 'NOT DEFERRABLE';
  if(/\bDEFERRABLE\s+INITIALLY\s+DEFERRED\b/i.test(fragment)) return 'DEFERRABLE INITIALLY DEFERRED';
  if(/\bDEFERRABLE\b/i.test(fragment)) return 'DEFERRABLE INITIALLY IMMEDIATE';
  return 'NOT DEFERRABLE';
}

function maskQuotedSql(value){
  const characters=[...String(value||'')];
  let quote=null;
  for(let index=0;index<characters.length;index+=1){
    const character=characters[index];
    if(quote){
      characters[index]=' ';
      if(character===quote){
        if(characters[index+1]===quote) characters[++index]=' ';
        else quote=null;
      }
      continue;
    }
    if(character==="'"||character==='"'||character==='`'){
      quote=character;
      characters[index]=' ';
    }else if(character==='['){
      quote=']';
      characters[index]=' ';
    }
  }
  return characters.join('');
}

const CONFLICT_ACTION='(ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)';

function conflictPolicy(value){
  return String(value||'ABORT').toUpperCase();
}

function inlineConflictPolicies(part,columnName,collation){
  const source=maskQuotedSql(part);
  const defaultCollation=collation?normalizeExpression(collation).toUpperCase():'BINARY';
  const primaryKeyDirection=/\bPRIMARY\s+KEY\s+(ASC|DESC)\b/i.exec(source)?.[1]||'';
  const definitions=[
    ['NOT NULL',new RegExp(`\\bNOT\\s+NULL(?:\\s+ON\\s+CONFLICT\\s+${CONFLICT_ACTION})?`,'i')],
    ['PRIMARY KEY',new RegExp(`\\bPRIMARY\\s+KEY(?:\\s+(?:ASC|DESC))?(?:\\s+ON\\s+CONFLICT\\s+${CONFLICT_ACTION})?`,'i')],
    ['UNIQUE',new RegExp(`\\bUNIQUE(?:\\s+ON\\s+CONFLICT\\s+${CONFLICT_ACTION})?`,'i')],
  ];
  return definitions.flatMap(([constraint,pattern])=>{
    const match=pattern.exec(source);
    if(!match) return [];
    const target=constraint==='UNIQUE'
      ?[indexedTerm(columnName,defaultCollation)]
      :constraint==='PRIMARY KEY'
        ?[indexedTerm(`${columnName} ${primaryKeyDirection}`.trim(),defaultCollation)]
        :[normalizeExpression(columnName)];
    return [{constraint,target,policy:conflictPolicy(match[1])}];
  });
}

function tableConstraints(sql){
  sql=stripSqlComments(sql);
  const parts=splitSqlList(createBody(sql));
  const columnCollations=new Map();
  for(const rawPart of parts){
    const part=unnamedTableConstraint(rawPart);
    if(/^(?:CONSTRAINT|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK)\b/i.test(part)) continue;
    const column=/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)/.exec(part);
    const collation=/\bCOLLATE\s+([^\s,]+)/i.exec(part)?.[1];
    if(column&&collation) columnCollations.set(normalizeExpression(unquote(column[1])),normalizeExpression(collation).toUpperCase());
  }
  const foreignKeys=[];
  const unique=[];
  const autoincrementColumns=[];
  const collations=[];
  const primaryKeyTerms=[];
  const foreignKeyTimings=[];
  const conflictPolicies=[];
  for(const rawPart of parts){
    const part=unnamedTableConstraint(rawPart);
    const tableForeign=/^FOREIGN\s+KEY\s*\((.*?)\)\s+REFERENCES\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s*\((.*?)\)([\s\S]*)$/i.exec(part);
    if(tableForeign){
      foreignKeys.push({
        from:splitSqlList(tableForeign[1]).map(item=>unquote(item.trim())),
        table:unquote(tableForeign[2]),
        to:splitSqlList(tableForeign[3]).map(item=>unquote(item.trim())),
        onUpdate:action(tableForeign[4],'UPDATE'),
        onDelete:action(tableForeign[4],'DELETE'),
      });
      foreignKeyTimings.push({
        from:splitSqlList(tableForeign[1]).map(item=>unquote(item.trim())),
        table:unquote(tableForeign[2]),
        to:splitSqlList(tableForeign[3]).map(item=>unquote(item.trim())),
        timing:foreignKeyTiming(tableForeign[4]),
      });
      continue;
    }
    const tableUnique=new RegExp(`^UNIQUE\\s*\\((.*?)\\)(?:\\s+ON\\s+CONFLICT\\s+${CONFLICT_ACTION})?$`,'i').exec(part);
    if(tableUnique){
      const terms=indexedTerms(tableUnique[1],columnCollations);
      unique.push(terms);
      conflictPolicies.push({
        constraint:'UNIQUE',
        target:terms,
        policy:conflictPolicy(tableUnique[2]),
      });
      continue;
    }
    const tablePrimary=new RegExp(`^PRIMARY\\s+KEY\\s*\\((.*?)\\)(?:\\s+ON\\s+CONFLICT\\s+${CONFLICT_ACTION})?`,'i').exec(part);
    if(tablePrimary){
      const terms=indexedTerms(tablePrimary[1],columnCollations);
      primaryKeyTerms.push(...terms);
      conflictPolicies.push({constraint:'PRIMARY KEY',target:terms,policy:conflictPolicy(tablePrimary[2])});
      continue;
    }
    if(/^(?:CONSTRAINT|CHECK)\b/i.test(part)) continue;
    const column=/^("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)/.exec(part);
    if(!column) continue;
    const columnName=unquote(column[1]);
    const collation=/\bCOLLATE\s+([^\s,]+)/i.exec(part)?.[1];
    if(/\bUNIQUE\b/i.test(part)) unique.push([indexedTerm(columnName,collation?normalizeExpression(collation).toUpperCase():'BINARY')]);
    if(/\bAUTOINCREMENT\b/i.test(part)) autoincrementColumns.push(columnName);
    if(collation) collations.push({column:columnName,collation:normalizeExpression(collation)});
    const primaryKeyDirection=/\bPRIMARY\s+KEY\s+(ASC|DESC)\b/i.exec(maskQuotedSql(part))?.[1]||'';
    if(/\bPRIMARY\s+KEY\b/i.test(part)){
      primaryKeyTerms.push(indexedTerm(
        `${columnName} ${primaryKeyDirection}`.trim(),
        collation?normalizeExpression(collation).toUpperCase():'BINARY',
      ));
    }
    conflictPolicies.push(...inlineConflictPolicies(part,columnName,collation));
    const inlineForeign=/\bREFERENCES\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s*\((.*?)\)([\s\S]*)$/i.exec(part);
    if(inlineForeign){
      foreignKeys.push({
        from:[columnName],
        table:unquote(inlineForeign[1]),
        to:splitSqlList(inlineForeign[2]).map(item=>unquote(item.trim())),
        onUpdate:action(inlineForeign[3],'UPDATE'),
        onDelete:action(inlineForeign[3],'DELETE'),
      });
      foreignKeyTimings.push({
        from:[columnName],
        table:unquote(inlineForeign[1]),
        to:splitSqlList(inlineForeign[2]).map(item=>unquote(item.trim())),
        timing:foreignKeyTiming(inlineForeign[3]),
      });
    }
  }
  const stable=value=>JSON.stringify(value);
  return {
    checks:parenthesizedExpressions(sql,'CHECK'),
    autoincrementColumns:autoincrementColumns.sort(),
    collations:collations.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right))),
    conflictPolicies:conflictPolicies.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right))),
    primaryKeyTerms,
    tableOptions:[
      ...(/\)\s*(?:STRICT\b|[^;]*,\s*STRICT\b)/i.test(sql)?['STRICT']:[]),
      ...(/\)\s*(?:WITHOUT\s+ROWID\b|[^;]*,\s*WITHOUT\s+ROWID\b)/i.test(sql)?['WITHOUT ROWID']:[]),
    ],
    foreignKeys:foreignKeys.sort((left,right)=>stable(left).localeCompare(stable(right))),
    foreignKeyTimings:foreignKeyTimings.sort((left,right)=>stable(left).localeCompare(stable(right))),
    unique:unique.sort((left,right)=>stable(left).localeCompare(stable(right))),
  };
}

export function parseIndexSql(sql){
  const source=String(sql||'').trim();
  const prefix=/^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s]+)\s+ON\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s*/i.exec(source);
  if(!prefix) return null;
  const remainder=source.slice(prefix[0].length);
  const body=createBody(`index${remainder}`);
  if(!body) return null;
  const closingOffset=remainder.indexOf('(')+body.length+2;
  const suffix=remainder.slice(closingOffset).trim();
  const where=/^WHERE\s+([\s\S]+)$/i.exec(suffix)?.[1]||null;
  return {
    unique:!!prefix[1],
    table:unquote(prefix[2]),
    keyParts:splitSqlList(body).map(normalizeIndexKeyPart),
    where:where?normalizeExpression(where):null,
  };
}

function expectedIndexSignature(definition){
  return {
    unique:definition.unique,
    table:definition.table,
    keyParts:definition.keyParts.map(normalizeIndexKeyPart),
    where:definition.where?normalizeExpression(definition.where):null,
  };
}

export function compileSchemaReadinessManifest(manifest){
  if(!manifest||!Array.isArray(manifest.tables)||!Array.isArray(manifest.indexes)){
    throw new TypeError('a schema manifest is required');
  }
  return {
    version:manifest.version,
    checksum:manifest.checksum,
    tables:manifest.tables.map(definition=>({
      name:definition.name,
      columns:expectedColumns(definition),
      constraints:tableConstraints(definition.sql),
    })),
    indexes:manifest.indexes.map(definition=>({
      name:definition.name,
      ...expectedIndexSignature(definition),
    })),
    toleratedLegacyTables:[...manifest.toleratedLegacyTables],
  };
}

function quoteIdentifier(value){
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

function asNumber(value){
  const number=Number(value);
  return Number.isFinite(number)?number:0;
}

function columnContract(row){
  return {
    type:String(row.type||'').trim().toUpperCase(),
    notNull:asNumber(row.notnull)===1,
    primaryKeyPosition:asNumber(row.pk),
    defaultValue:normalizeDefault(row.dflt_value),
    hidden:asNumber(row.hidden),
  };
}

function sameArray(left,right){
  return left.length===right.length&&left.every((value,index)=>value===right[index]);
}

export async function inspectSchema(database,{manifest,maxSchemaObjects}={}){
  if(!manifest||!Array.isArray(manifest.tables)||!Array.isArray(manifest.indexes)){
    throw new TypeError('a schema manifest is required');
  }
  if(maxSchemaObjects!==undefined
    &&(!Number.isSafeInteger(maxSchemaObjects)||maxSchemaObjects<1||maxSchemaObjects>10_000)){
    throw new TypeError('maxSchemaObjects must be a positive safe integer no greater than 10000');
  }
  const db=readOnlyDatabase(database);
  const schemaSql=`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE type IN ('table','index','view','trigger') ORDER BY type,name`;
  const schemaResult=maxSchemaObjects===undefined
    ?await db.execute(schemaSql)
    :await db.execute({sql:`${schemaSql} LIMIT ?`,args:[maxSchemaObjects+1]});
  const allRows=schemaResult.rows||[];
  const schemaObjectLimitExceeded=maxSchemaObjects!==undefined&&allRows.length>maxSchemaObjects;
  const rows=schemaObjectLimitExceeded?allRows.slice(0,maxSchemaObjects):allRows;
  const tableRows=new Map(rows.filter(row=>row.type==='table').map(row=>[String(row.name),row]));
  const indexRows=new Map(rows.filter(row=>row.type==='index'&&!String(row.name).startsWith('sqlite_')).map(row=>[String(row.name),row]));
  const unexpectedViews=rows.filter(row=>row.type==='view').map(row=>String(row.name)).sort();
  const unexpectedTriggers=rows.filter(row=>row.type==='trigger').map(row=>String(row.name)).sort();
  const expectedTableNames=new Set(manifest.tables.map(item=>item.name));
  const expectedIndexNames=new Set(manifest.indexes.map(item=>item.name));
  const toleratedLegacyTables=manifest.toleratedLegacyTables.filter(name=>tableRows.has(name));
  const missingTables=[];
  const missingColumns=[];
  const unexpectedColumns=[];
  const columnDrift=[];
  const constraintDrift=[];
  const indexLists=new Map();
  async function readIndexList(tableName){
    if(!indexLists.has(tableName)){
      const result=await db.execute(`PRAGMA index_list(${quoteIdentifier(tableName)})`);
      indexLists.set(tableName,new Map((result.rows||[]).map(row=>[String(row.name),row])));
    }
    return indexLists.get(tableName);
  }

  for(const definition of manifest.tables){
    if(!tableRows.has(definition.name)){
      missingTables.push(definition.name);
      continue;
    }
    const result=await db.execute(`PRAGMA table_xinfo(${quoteIdentifier(definition.name)})`);
    const actualColumns=new Map((result.rows||[]).map(row=>[String(row.name),row]));
    const expectedColumnList=definition.columns||expectedColumns(definition);
    const expectedColumnNames=new Set(expectedColumnList.map(column=>column.name));
    for(const columnName of actualColumns.keys()){
      if(!expectedColumnNames.has(columnName)) unexpectedColumns.push({table:definition.name,column:columnName});
    }
    for(const expected of expectedColumnList){
      const actual=actualColumns.get(expected.name);
      if(!actual){
        missingColumns.push({table:definition.name,column:expected.name});
        continue;
      }
      const actualContract=columnContract(actual);
      const expectedContract={
        type:expected.type,
        notNull:expected.notNull,
        primaryKeyPosition:expected.primaryKeyPosition,
        defaultValue:expected.defaultValue,
        hidden:expected.hidden,
      };
      const differences=Object.keys(expectedContract)
        .filter(key=>expectedContract[key]!==actualContract[key])
        .map(key=>({property:key,expected:expectedContract[key],actual:actualContract[key]}));
      if(differences.length) columnDrift.push({table:definition.name,column:expected.name,differences});
    }
    const expectedConstraints=definition.constraints||tableConstraints(definition.sql);
    const actualConstraints=tableConstraints(String(tableRows.get(definition.name).sql||''));
    const foreignKeyResult=await db.execute(`PRAGMA foreign_key_list(${quoteIdentifier(definition.name)})`);
    const foreignKeyGroups=new Map();
    for(const row of foreignKeyResult.rows||[]){
      const id=asNumber(row.id);
      const group=foreignKeyGroups.get(id)||[];
      group.push(row);
      foreignKeyGroups.set(id,group);
    }
    actualConstraints.foreignKeys=[...foreignKeyGroups.values()].map(group=>{
      const ordered=[...group].sort((left,right)=>asNumber(left.seq)-asNumber(right.seq));
      return {
        from:ordered.map(row=>String(row.from)),
        table:String(ordered[0]?.table||''),
        to:ordered.map(row=>String(row.to)),
        onUpdate:String(ordered[0]?.on_update||'NO ACTION').toUpperCase(),
        onDelete:String(ordered[0]?.on_delete||'NO ACTION').toUpperCase(),
      };
    }).sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const tableIndexList=await readIndexList(definition.name);
    actualConstraints.unique=[];
    for(const row of tableIndexList.values()){
      if(String(row.origin)!=='u') continue;
      const uniqueResult=await db.execute(`PRAGMA index_xinfo(${quoteIdentifier(String(row.name))})`);
      actualConstraints.unique.push((uniqueResult.rows||[])
        .filter(item=>asNumber(item.key)===1)
        .sort((left,right)=>asNumber(left.seqno)-asNumber(right.seqno))
        .map(item=>({
          expression:normalizeExpression(item.name),
          collation:String(item.coll||'BINARY').toUpperCase(),
          descending:asNumber(item.desc)===1,
        })));
    }
    actualConstraints.unique.sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
    for(const kind of ['checks','foreignKeys','foreignKeyTimings','unique','autoincrementColumns','collations','conflictPolicies','primaryKeyTerms','tableOptions']){
      if(JSON.stringify(expectedConstraints[kind])!==JSON.stringify(actualConstraints[kind])){
        constraintDrift.push({table:definition.name,kind,expected:expectedConstraints[kind],actual:actualConstraints[kind]});
      }
    }
  }

  const missingIndexes=[];
  const indexDrift=[];
  for(const definition of manifest.indexes){
    const schemaRow=indexRows.get(definition.name);
    if(!schemaRow){
      missingIndexes.push(definition.name);
      continue;
    }
    const listRow=(await readIndexList(definition.table)).get(definition.name);
    const parsed=parseIndexSql(schemaRow.sql);
    const expected=expectedIndexSignature(definition);
    const result=await db.execute(`PRAGMA index_xinfo(${quoteIdentifier(definition.name)})`);
    const keyRows=(result.rows||[]).filter(row=>asNumber(row.key)===1);
    const actual=parsed?{
      ...parsed,
      unique:listRow?asNumber(listRow.unique)===1:parsed.unique,
      partial:listRow?asNumber(listRow.partial)===1:!!parsed.where,
      expressionKeys:keyRows.filter(row=>asNumber(row.cid)===-2).length,
      descending:keyRows.map(row=>asNumber(row.desc)===1),
    }:null;
    const expectedDetail={
      ...expected,
      partial:!!expected.where,
      expressionKeys:expected.keyParts.filter(part=>!/^[_a-z][_a-z0-9]*$/i.test(indexedTerm(part).expression)).length,
      descending:expected.keyParts.map(part=>/desc$/i.test(part)),
    };
    const differences=[];
    if(!actual) differences.push({property:'sql',expected:definition.sql,actual:schemaRow.sql??null});
    else{
      for(const property of ['unique','table','where','partial','expressionKeys']){
        if(actual[property]!==expectedDetail[property]) differences.push({property,expected:expectedDetail[property],actual:actual[property]});
      }
      for(const property of ['keyParts','descending']){
        if(!sameArray(actual[property],expectedDetail[property])) differences.push({property,expected:expectedDetail[property],actual:actual[property]});
      }
    }
    if(differences.length) indexDrift.push({index:definition.name,differences});
  }

  const unexpectedTables=[...tableRows.keys()]
    .filter(name=>!name.startsWith('sqlite_')&&!expectedTableNames.has(name)&&!manifest.toleratedLegacyTables.includes(name))
    .sort();
  const unexpectedIndexes=[...indexRows.keys()].filter(name=>!expectedIndexNames.has(name)).sort();
  const unexpectedUniqueIndexes=unexpectedIndexes.filter(name=>parseIndexSql(indexRows.get(name)?.sql)?.unique);
  const foreignKeyResult=await db.execute('PRAGMA foreign_keys');
  const foreignKeysEnabled=asNumber(foreignKeyResult.rows?.[0]?.foreign_keys)===1;
  const checkConstraintResult=await db.execute('PRAGMA ignore_check_constraints');
  const checkConstraintsEnabled=checkConstraintResult.rows?.length===1
    &&asNumber(checkConstraintResult.rows[0].ignore_check_constraints)===0;
  const blockers=[
    ...(schemaObjectLimitExceeded?[{code:'schema_object_limit_exceeded',artifact:{type:'schema',name:'object_limit'}}]:[]),
    ...missingTables.map(tableName=>({code:'missing_table',artifact:{type:'table',name:tableName}})),
    ...missingColumns.map(item=>({code:'missing_column',artifact:{type:'column',name:`${item.table}.${item.column}`}})),
    ...unexpectedColumns.map(item=>({code:'unexpected_column',artifact:{type:'column',name:`${item.table}.${item.column}`}})),
    ...columnDrift.map(item=>({code:'column_drift',artifact:{type:'column',name:`${item.table}.${item.column}`},differences:item.differences})),
    ...constraintDrift.map(item=>({code:'constraint_drift',artifact:{type:'table',name:item.table},constraint:item.kind,expected:item.expected,actual:item.actual})),
    ...missingIndexes.map(indexName=>({code:'missing_index',artifact:{type:'index',name:indexName}})),
    ...indexDrift.map(item=>({code:'index_drift',artifact:{type:'index',name:item.index},differences:item.differences})),
    ...unexpectedUniqueIndexes.map(name=>({code:'unexpected_unique_index',artifact:{type:'index',name}})),
    ...unexpectedViews.map(name=>({code:'unexpected_view',artifact:{type:'view',name}})),
    ...unexpectedTriggers.map(name=>({code:'unexpected_trigger',artifact:{type:'trigger',name}})),
    ...(!foreignKeysEnabled?[{code:'foreign_keys_disabled',artifact:{type:'connection',name:'foreign_keys'}}]:[]),
    ...(!checkConstraintsEnabled?[{code:'check_constraints_disabled',artifact:{type:'connection',name:'check_constraints'}}]:[]),
  ];
  const warnings=[
    ...unexpectedTables.map(name=>({code:'unexpected_table',artifact:{type:'table',name}})),
    ...unexpectedIndexes.filter(name=>!unexpectedUniqueIndexes.includes(name)).map(name=>({code:'unexpected_index',artifact:{type:'index',name}})),
  ];
  return {
    ok:blockers.length===0,
    ready:blockers.length===0,
    readOnly:true,
    manifest:{version:manifest.version,checksum:manifest.checksum},
    summary:{
      expectedTables:manifest.tables.length,
      presentTables:manifest.tables.length-missingTables.length,
      expectedIndexes:manifest.indexes.length,
      presentIndexes:manifest.indexes.length-missingIndexes.length,
      blockers:blockers.length,
      warnings:warnings.length,
    },
    drift:{missingTables,missingColumns,unexpectedColumns,columnDrift,constraintDrift,missingIndexes,indexDrift,unexpectedTables,unexpectedIndexes,unexpectedUniqueIndexes,unexpectedViews,unexpectedTriggers},
    foreignKeysEnabled,
    checkConstraintsEnabled,
    tolerated:{legacyTables:toleratedLegacyTables},
    blockers,
    warnings,
  };
}

export function planVersionFor(type,name,plans){
  if(!Array.isArray(plans)) throw new TypeError('migration plans are required');
  const field=type==='table'?'tables':'indexes';
  return [...plans].reverse().find(plan=>plan[field].includes(name))?.version??null;
}

export function buildReadOnlyPlan(status,{manifest,plans}={}){
  if(!manifest||!Array.isArray(plans)||plans.length===0){
    throw new TypeError('a schema manifest and migration plans are required');
  }
  const tables=new Map(manifest.tables.map(item=>[item.name,item]));
  const indexes=new Map(manifest.indexes.map(item=>[item.name,item]));
  const versionFor=(type,name)=>planVersionFor(type,name,plans);
  const actions=[];
  status.drift.missingTables.forEach(name=>actions.push({
    kind:'create_table',artifact:{type:'table',name},planVersion:versionFor('table',name),sql:tables.get(name)?.sql||null,
  }));
  status.drift.missingColumns.forEach(({table,column})=>actions.push({
    kind:'manual_column_migration',artifact:{type:'column',name:`${table}.${column}`},planVersion:versionFor('table',table),sql:null,blocked:true,
  }));
  status.drift.unexpectedColumns.forEach(({table,column})=>actions.push({
    kind:'review_unexpected_column',artifact:{type:'column',name:`${table}.${column}`},planVersion:versionFor('table',table),sql:null,blocked:true,
  }));
  status.drift.columnDrift.forEach(({table,column,differences})=>actions.push({
    kind:'resolve_column_drift',artifact:{type:'column',name:`${table}.${column}`},planVersion:versionFor('table',table),sql:null,blocked:true,differences,
  }));
  status.drift.constraintDrift.forEach(({table,kind,expected,actual})=>actions.push({
    kind:'resolve_constraint_drift',artifact:{type:'table',name:table},constraint:kind,planVersion:versionFor('table',table),sql:null,blocked:true,expected,actual,
  }));
  status.drift.missingIndexes.forEach(name=>actions.push({
    kind:'create_index',artifact:{type:'index',name},planVersion:versionFor('index',name),sql:indexes.get(name)?.sql||null,
  }));
  status.drift.indexDrift.forEach(({index:indexName,differences})=>actions.push({
    kind:'replace_incompatible_index',artifact:{type:'index',name:indexName},planVersion:versionFor('index',indexName),sql:null,blocked:true,differences,
  }));
  status.drift.unexpectedUniqueIndexes.forEach(name=>actions.push({
    kind:'review_unexpected_unique_index',artifact:{type:'index',name},planVersion:null,sql:null,blocked:true,
  }));
  status.drift.unexpectedViews.forEach(name=>actions.push({kind:'review_unexpected_view',artifact:{type:'view',name},planVersion:null,sql:null,blocked:true}));
  status.drift.unexpectedTriggers.forEach(name=>actions.push({kind:'review_unexpected_trigger',artifact:{type:'trigger',name},planVersion:null,sql:null,blocked:true}));
  if(status.foreignKeysEnabled===false){
    actions.push({kind:'enable_foreign_keys',artifact:{type:'connection',name:'foreign_keys'},planVersion:null,sql:null,blocked:true});
  }
  if(status.checkConstraintsEnabled===false){
    actions.push({kind:'enable_check_constraints',artifact:{type:'connection',name:'check_constraints'},planVersion:null,sql:null,blocked:true});
  }
  return {
    ok:status.ok,
    readOnly:true,
    executable:false,
    latestPlanVersion:plans.at(-1)?.version||0,
    manifest:{version:manifest.version,checksum:manifest.checksum},
    plans:plans.map(({version,name,description,checksum,operationsChecksum,operations})=>({
      version,name,description,checksum,operationsChecksum,operationCount:operations.length,
    })),
    summary:{actions:actions.length,blockedActions:actions.filter(action=>action.blocked).length},
    actions,
    blockers:status.blockers,
    warnings:status.warnings,
    tolerated:status.tolerated,
  };
}
