#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const DDL_OBJECT=String.raw`(?:TABLE|INDEX|VIEW|TRIGGER)`;
const SQL_GAP=String.raw`(?:\s|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r?\n|$))+`;
const DDL_PATTERN=new RegExp(
  String.raw`\b(?:CREATE${SQL_GAP}(?:(?:UNIQUE|TEMP(?:ORARY)?|VIRTUAL|OR${SQL_GAP}REPLACE)${SQL_GAP})*${DDL_OBJECT}|ALTER${SQL_GAP}TABLE|DROP${SQL_GAP}${DDL_OBJECT})\b`,
  'i',
);
const SOURCE_EXTENSION=/\.[cm]?js$/i;

// This allowlist records the request-time schema debt that existed when the
// migration foundation was introduced. New DDL must be added to a versioned
// migration in a later slice, not silently introduced on an API request path.
export const RUNTIME_DDL_ALLOWLIST=Object.freeze([
  Object.freeze({file:'api/ai.js',statementCount:8,digest:'0433ffdc8aadad44f242d739a544df62f0d6584538c37eee323942085b3d0082'}),
  Object.freeze({file:'api/ops.js',statementCount:17,digest:'24595f9bbbdafc29cbe41d8fa874eb1680a5ce877eb143933cbde75a87a4c159'}),
]);

function sourceFiles(directory){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(directory,entry.name);
    if(entry.isDirectory()) return sourceFiles(path);
    return entry.isFile()&&SOURCE_EXTENSION.test(entry.name)?[path]:[];
  }).sort();
}

function resolveImportedFile(file,specifier,root){
  if(!specifier.startsWith('.')) return {file:null,resolved:true};
  const unresolved=resolve(dirname(file),specifier);
  const candidates=extname(unresolved)?[unresolved]:[`${unresolved}.js`,`${unresolved}.mjs`,resolve(unresolved,'index.js')];
  const candidate=candidates.find(path=>existsSync(path)&&statSync(path).isFile());
  if(!candidate) return {file:null,resolved:false};
  if(!SOURCE_EXTENSION.test(candidate)) return {file:null,resolved:true};
  return !relative(root,candidate).startsWith('..')
    ?{file:candidate,resolved:true}
    :{file:null,resolved:false};
}

function importedFiles(file,source,root){
  const ast=parseSource(source);
  const bindings=identifierBindings(ast);
  const specifiers=[];
  const violations=[];
  walkAst(ast,node=>{
    if(['ImportDeclaration','ExportAllDeclaration','ExportNamedDeclaration'].includes(node.type)&&node.source){
      if(typeof node.source.value==='string') specifiers.push({value:node.source.value,dynamic:false,node});
      return;
    }
    if(node.type!=='ImportExpression') return;
    const value=staticString(node.source,bindings);
    if(value===null){
      violations.push({
        file:relative(process.cwd(),file).replaceAll('\\','/'),
        line:node.loc.start.line,
        code:'unresolved_dynamic_import',
      });
      return;
    }
    specifiers.push({value,dynamic:true,node});
  });
  const files=[];
  for(const specifier of specifiers){
    if(!specifier.value.startsWith('.')) continue;
    const imported=resolveImportedFile(file,specifier.value,root);
    if(imported.file) files.push(imported.file);
    else if(!imported.resolved) violations.push({
      file:relative(process.cwd(),file).replaceAll('\\','/'),
      line:specifier.node.loc.start.line,
      code:specifier.dynamic?'unresolved_dynamic_import':'unresolved_relative_import',
    });
  }
  return {files,violations};
}

function reachableSourceFiles(directory){
  const root=resolve(directory,'..');
  const queue=sourceFiles(directory);
  const seen=new Set();
  const violations=[];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file)) continue;
    seen.add(file);
    const source=readFileSync(file,'utf8');
    const imported=importedFiles(file,source,root);
    violations.push(...imported.violations);
    imported.files.forEach(path=>{ if(!seen.has(path)) queue.push(path); });
  }
  return {files:[...seen].sort(),violations};
}

function parseSource(source){
  return parse(source,{
    allowHashBang:true,
    ecmaVersion:'latest',
    locations:true,
    sourceType:'module',
  });
}

function walkAst(node,visit,parent=null){
  if(!node||typeof node!=='object'||typeof node.type!=='string') return;
  visit(node,parent);
  for(const [key,value] of Object.entries(node)){
    if(['end','loc','range','start','type'].includes(key)) continue;
    if(Array.isArray(value)) value.forEach(child=>walkAst(child,visit,node));
    else walkAst(value,visit,node);
  }
}

function templateValue(node,{raw=false}={}){
  if(node.type!=='TemplateLiteral'||node.expressions.length) return null;
  return node.quasis.map(quasi=>raw?quasi.value.raw:(quasi.value.cooked??quasi.value.raw)).join('');
}

// Acorn supplies decoded string values and distinguishes regex literals from
// strings. A hand-written quote scanner cannot safely do either in JavaScript.
export function stringLiterals(source,ast=parseSource(source)){
  const literals=[];
  walkAst(ast,(node,parent)=>{
    let value=null;
    if(node.type==='Literal'&&typeof node.value==='string') value=node.value;
    else if(node.type==='TemplateLiteral'&&!node.expressions.length){
      const isStringRaw=parent?.type==='TaggedTemplateExpression'
        &&parent.tag?.type==='MemberExpression'
        &&parent.tag.object?.name==='String'
        &&parent.tag.property?.name==='raw';
      value=templateValue(node,{raw:isStringRaw});
    }
    if(value===null) return;
    literals.push({
      value,
      quote:source[node.start],
      start:node.start,
      end:node.end-1,
      line:node.loc.start.line,
    });
  });
  return literals.sort((left,right)=>left.start-right.start);
}

function identifierBindings(ast){
  const bindings=new Map();
  walkAst(ast,(node,parent)=>{
    if(node.type==='VariableDeclarator'
      &&parent?.type==='VariableDeclaration'
      &&parent.kind==='const'
      &&node.id?.type==='Identifier'
      &&node.init){
      const candidates=bindings.get(node.id.name)||[];
      candidates.push(node.init);
      bindings.set(node.id.name,candidates);
    }
  });
  return bindings;
}

function boundExpression(node,bindings){
  if(node?.type!=='Identifier') return null;
  const candidates=bindings.get(node.name)||[];
  return candidates.length===1?candidates[0]:null;
}

function staticMemberName(node){
  if(node?.type!=='MemberExpression') return null;
  if(!node.computed&&node.property?.type==='Identifier') return node.property.name;
  if(node.computed&&node.property?.type==='Literal'&&typeof node.property.value==='string') return node.property.value;
  if(node.computed&&node.property?.type==='TemplateLiteral'&&!node.property.expressions.length){
    return templateValue(node.property);
  }
  return null;
}

function staticPropertyName(node){
  if(node?.type!=='Property') return null;
  if(!node.computed&&node.key?.type==='Identifier') return node.key.name;
  if(node.key?.type==='Literal'&&typeof node.key.value==='string') return node.key.value;
  if(node.computed&&node.key?.type==='TemplateLiteral'&&!node.key.expressions.length) return templateValue(node.key);
  return null;
}

function staticString(node,bindings,seen=new Set()){
  if(!node) return null;
  if(node.type==='Literal') return typeof node.value==='string'?node.value:null;
  if(node.type==='TemplateLiteral'){
    let value='';
    for(let index=0;index<node.quasis.length;index+=1){
      value+=node.quasis[index].value.cooked??node.quasis[index].value.raw;
      if(index<node.expressions.length){
        const expression=staticString(node.expressions[index],bindings,seen);
        if(expression===null) return null;
        value+=expression;
      }
    }
    return value;
  }
  if(node.type==='TaggedTemplateExpression'
    &&node.tag?.type==='MemberExpression'
    &&node.tag.object?.name==='String'
    &&node.tag.property?.name==='raw'){
    let value='';
    for(let index=0;index<node.quasi.quasis.length;index+=1){
      value+=node.quasi.quasis[index].value.raw;
      if(index<node.quasi.expressions.length){
        const expression=staticString(node.quasi.expressions[index],bindings,seen);
        if(expression===null) return null;
        value+=expression;
      }
    }
    return value;
  }
  if(node.type==='BinaryExpression'&&node.operator==='+'){
    const left=staticString(node.left,bindings,seen);
    const right=staticString(node.right,bindings,seen);
    return left===null||right===null?null:left+right;
  }
  if(node.type==='Identifier'){
    if(seen.has(node.name)) return null;
    const binding=boundExpression(node,bindings);
    if(!binding) return null;
    return staticString(binding,bindings,new Set([...seen,node.name]));
  }
  if(node.type==='CallExpression'
    &&node.callee?.type==='MemberExpression'
    &&staticMemberName(node.callee)==='join'
    &&node.callee.object?.type==='ArrayExpression'){
    const separator=node.arguments.length?staticString(node.arguments[0],bindings,seen):',';
    if(separator===null) return null;
    const values=node.callee.object.elements.map(item=>staticString(item,bindings,seen));
    return values.some(value=>value===null)?null:values.join(separator);
  }
  if(node.type==='CallExpression'
    &&node.callee?.type==='MemberExpression'
    &&staticMemberName(node.callee)==='concat'){
    const base=staticString(node.callee.object,bindings,seen);
    const values=node.arguments.map(item=>staticString(item,bindings,seen));
    return base===null||values.some(value=>value===null)?null:base+values.join('');
  }
  return null;
}

function expressionShape(node,bindings,seen=new Set()){
  if(!node) return '${dynamic}';
  const resolved=staticString(node,bindings,seen);
  if(resolved!==null) return resolved;
  if(node.type==='TemplateLiteral'){
    let value='';
    for(let index=0;index<node.quasis.length;index+=1){
      value+=node.quasis[index].value.cooked??node.quasis[index].value.raw;
      if(index<node.expressions.length) value+=expressionShape(node.expressions[index],bindings,seen);
    }
    return value;
  }
  if(node.type==='BinaryExpression'&&node.operator==='+'){
    return expressionShape(node.left,bindings,seen)+expressionShape(node.right,bindings,seen);
  }
  if(node.type==='Identifier'){
    if(seen.has(node.name)) return '${dynamic}';
    const binding=boundExpression(node,bindings);
    return binding
      ?expressionShape(binding,bindings,new Set([...seen,node.name]))
      :'${dynamic}';
  }
  if(node.type==='CallExpression'
    &&node.callee?.type==='MemberExpression'
    &&staticMemberName(node.callee)==='join'
    &&node.callee.object?.type==='ArrayExpression'){
    const separator=node.arguments.length?staticString(node.arguments[0],bindings,seen):',';
    return node.callee.object.elements
      .map(item=>expressionShape(item,bindings,seen))
      .join(separator??'${dynamic}');
  }
  if(node.type==='CallExpression'
    &&node.callee?.type==='MemberExpression'
    &&staticMemberName(node.callee)==='concat'){
    return expressionShape(node.callee.object,bindings,seen)
      +node.arguments.map(item=>expressionShape(item,bindings,seen)).join('');
  }
  return '${dynamic}';
}

function dynamicExpressionMayBeDdl(node,bindings){
  if(staticString(node,bindings)!==null) return false;
  if(node.type==='ConditionalExpression'){
    return expressionMayBeDdl(node.consequent,bindings)||expressionMayBeDdl(node.alternate,bindings);
  }
  const shape=expressionShape(node,bindings)
    .replace(/\/\*[\s\S]*?\*\//g,' ')
    .replace(/--[^\r\n]*(?:\r?\n|$)/g,' ')
    .trim();
  if(/^(?:CREATE|ALTER|DROP)\b/i.test(shape)) return true;
  return /^\$\{dynamic\}\s*(?:\$\{dynamic\}\s*)?(?:(?:TABLE|INDEX|VIEW|TRIGGER)\b|[A-Za-z_][A-Za-z0-9_]*\s*\()/i.test(shape);
}

function expressionMayBeDdl(node,bindings){
  if(node?.type==='ConditionalExpression'){
    return expressionMayBeDdl(node.consequent,bindings)||expressionMayBeDdl(node.alternate,bindings);
  }
  const resolved=staticString(node,bindings);
  return resolved!==null?DDL_PATTERN.test(resolved):dynamicExpressionMayBeDdl(node,bindings);
}

function dynamicTemplateMayBeDdl(node,bindings){
  if(node.type!=='TemplateLiteral'||!node.expressions.length) return false;
  const resolved=staticString(node,bindings);
  if(resolved!==null) return DDL_PATTERN.test(resolved);
  return dynamicExpressionMayBeDdl(node,bindings);
}

function databaseSqlExpressions(call,bindings){
  if(call.type!=='CallExpression'||call.callee?.type!=='MemberExpression') return [];
  const method=staticMemberName(call.callee);
  if(!['execute','batch'].includes(method)||!call.arguments[0]) return [];
  const expressions=[];
  const collect=(node,seen=new Set())=>{
    if(!node) return;
    if(node.type==='Identifier'){
      if(seen.has(node.name)) return;
      const binding=boundExpression(node,bindings);
      if(binding) collect(binding,new Set([...seen,node.name]));
      return;
    }
    if(node.type==='ObjectExpression'){
      const property=node.properties.find(item=>staticPropertyName(item)==='sql');
      if(property) collect(property.value,seen);
      return;
    }
    if(node.type==='ArrayExpression'){
      node.elements.forEach(item=>collect(item,seen));
      return;
    }
    expressions.push(node);
  };
  collect(call.arguments[0]);
  return expressions;
}

function isDirectStaticLiteral(node){
  return (node.type==='Literal'&&typeof node.value==='string')
    ||(node.type==='TemplateLiteral'&&!node.expressions.length);
}

function collectAssemblyViolations(ast,file){
  const bindings=identifierBindings(ast);
  const violations=[];
  const add=(node,code)=>violations.push({file,line:node.loc.start.line,code});
  walkAst(ast,node=>{
    if(node.type==='TemplateLiteral'&&dynamicTemplateMayBeDdl(node,bindings)) add(node,'dynamic_ddl');
    if(node.type==='BinaryExpression'&&node.operator==='+'&&expressionMayBeDdl(node,bindings)){
      add(node,'assembled_ddl');
      add(node,'dynamic_ddl');
    }
    if(node.type==='CallExpression'
      &&node.callee?.type==='MemberExpression'
      &&['concat','join'].includes(staticMemberName(node.callee))
      &&expressionMayBeDdl(node,bindings)) add(node,'dynamic_ddl');
    if(node.type==='ConditionalExpression'&&expressionMayBeDdl(node,bindings)) add(node,'dynamic_ddl');
    for(const expression of databaseSqlExpressions(node,bindings)){
      if(isDirectStaticLiteral(expression)) continue;
      if(expressionMayBeDdl(expression,bindings)) add(expression,'dynamic_ddl');
    }
  });
  return violations;
}

export function normalizeDdl(sql){
  const literals=[];
  const protectedSql=String(sql).replace(/'(?:''|[^'])*'/g,literal=>{
    const marker=`\u00a7${literals.length}\u00a7`;
    literals.push(literal);
    return marker;
  });
  return protectedSql
    .trim()
    .toLowerCase()
    .replace(/\s+/g,' ')
    .replace(/\s*([(),=])\s*/g,'$1')
    .replace(/\u00a7(\d+)\u00a7/g,(_match,index)=>literals[Number(index)]);
}

function fingerprint(sql){
  return createHash('sha256').update(normalizeDdl(sql)).digest('hex');
}

export function discoverRuntimeDdl(directory='api'){
  const root=resolve(directory);
  const byKey=new Map();
  const reachable=reachableSourceFiles(root);
  const assemblyViolations=[...reachable.violations];
  for(const path of reachable.files){
    const file=relative(process.cwd(),path).replaceAll('\\','/');
    const source=readFileSync(path,'utf8');
    const ast=parseSource(source);
    assemblyViolations.push(...collectAssemblyViolations(ast,file));
    for(const literal of stringLiterals(source,ast)){
      if(!DDL_PATTERN.test(literal.value)) continue;
      const hash=fingerprint(literal.value);
      const key=`${file}\0${hash}`;
      const existing=byKey.get(key)||{file,hash,count:0,lines:[],preview:normalizeDdl(literal.value).slice(0,120)};
      existing.count+=1;
      existing.lines.push(literal.line);
      byKey.set(key,existing);
    }
  }
  const uniqueAssemblyViolations=[...new Map(assemblyViolations.map(item=>[`${item.file}:${item.line||0}:${item.code}`,item])).values()];
  return {entries:[...byKey.values()].sort((a,b)=>a.file.localeCompare(b.file)||a.hash.localeCompare(b.hash)),assemblyViolations:uniqueAssemblyViolations};
}

export function checkRuntimeDdl(directory='api',allowlist=RUNTIME_DDL_ALLOWLIST){
  const discovered=discoverRuntimeDdl(directory);
  const grouped=new Map();
  for(const entry of discovered.entries){
    const entries=grouped.get(entry.file)||[];
    entries.push(entry);
    grouped.set(entry.file,entries);
  }
  const snapshots=[...grouped].map(([file,entries])=>{
    const payload=entries.map(({hash,count})=>`${hash}:${count}`).sort().join('\n');
    return {
      file,
      statementCount:entries.reduce((total,entry)=>total+entry.count,0),
      digest:createHash('sha256').update(payload).digest('hex'),
    };
  }).sort((a,b)=>a.file.localeCompare(b.file));
  const actual=new Map(snapshots.map(entry=>[entry.file,entry]));
  const allowed=new Map(allowlist.map(entry=>[entry.file,entry]));
  const unexpected=snapshots.filter(entry=>{
    const match=allowed.get(entry.file);
    return !match||match.digest!==entry.digest||match.statementCount!==entry.statementCount;
  });
  const missing=allowlist.filter(entry=>{
    const match=actual.get(entry.file);
    return !match||match.digest!==entry.digest||match.statementCount!==entry.statementCount;
  });
  return {ok:unexpected.length===0&&missing.length===0&&discovered.assemblyViolations.length===0,unexpected,missing,assemblyViolations:discovered.assemblyViolations,entries:discovered.entries,snapshots};
}

export function main(argv=process.argv.slice(2)){
  if(argv.length>1||argv.some(argument=>argument!=='--snapshot')) throw new Error('Usage: node scripts/check-runtime-ddl.mjs [--snapshot]');
  const result=checkRuntimeDdl();
  if(argv.includes('--snapshot')){
    process.stdout.write(`${JSON.stringify(result.snapshots,null,2)}\n`);
    return result;
  }
  if(!result.ok){
    process.stderr.write(`${JSON.stringify({ok:false,unexpected:result.unexpected,missing:result.missing,assemblyViolations:result.assemblyViolations},null,2)}\n`);
    process.exitCode=1;
    return result;
  }
  process.stdout.write(`Runtime DDL boundary OK: ${result.entries.length} allowlisted statement signatures\n`);
  return result;
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain) main();
