#!/usr/bin/env node
// Static guard for SQL that local libSQL accepts but Turso's remote server
// rejects (#251). CI only runs against local file databases, so a PRAGMA that
// works in tests can still fail in production with
// `SQL_PARSE_ERROR: SQL not allowed statement` (see #246). Every PRAGMA issued
// from api/, db/ and scripts/ must appear in the reviewed allowlist below.
// How to extend it is documented in docs/DATABASE_SCHEMA_OPERATIONS.md.
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const SOURCE_EXTENSION=/\.[cm]?js$/i;
export const SCANNED_DIRECTORIES=Object.freeze(['api','db','scripts']);
const DYNAMIC='${dynamic}';
const IDENTIFIER_ARGUMENT=/^\((?:'[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*"|"\$\{dynamic\}"|\$\{dynamic\})\)$/;

// Reviewed Turso-remote allowlist for `PRAGMA name[argument]` statements.
// `arguments` lists the accepted argument shapes after whitespace removal;
// '' is the bare read form. `${dynamic}` stands for an interpolated value
// (always an identifier quoted by quoteIdentifier/identifier helpers).
// `files` restricts a tolerated pragma to the helper that handles Turso's
// rejection; omit it for pragmas the remote server accepts everywhere.
export const TURSO_REMOTE_PRAGMA_ALLOWLIST=Object.freeze({
  foreign_keys:Object.freeze({arguments:[/^$/,/^=(?:ON|OFF)$/i],verified:'read and set accepted by Turso remote'}),
  integrity_check:Object.freeze({arguments:[/^\(1\)$/],verified:'integrity_check(1) accepted by Turso remote'}),
  table_info:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  table_xinfo:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  foreign_key_list:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  index_list:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  index_info:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  index_xinfo:Object.freeze({arguments:[IDENTIFIER_ARGUMENT],verified:'accepted by Turso remote'}),
  // REJECTED by Turso remote (read and set). Tolerated only inside the helper
  // that recognises the exact rejection and treats it as "cannot be disabled".
  ignore_check_constraints:Object.freeze({
    arguments:[/^$/,/^=OFF$/i],
    files:Object.freeze(['db/check-constraint-state.js']),
    verified:'rejected by Turso remote; helper-only (#246)',
  }),
});

// Table-valued pragma functions run inside a SELECT, which Turso classifies
// as a read statement. Only the reviewed read-only introspection functions
// are allowed.
export const TURSO_REMOTE_PRAGMA_FUNCTION_ALLOWLIST=Object.freeze([
  'foreign_key_check',
  'foreign_key_list',
  'index_info',
  'index_list',
  'index_xinfo',
  'table_info',
  'table_xinfo',
]);

// Statement classes that are not verified against Turso remote. None are used
// today; adding one needs a verified allowlist entry first.
export const RESTRICTED_STATEMENTS=Object.freeze([
  {code:'restricted_attach',pattern:/\bATTACH\s+(?:DATABASE\s+)?(?:'|"|\$\{dynamic\}|[A-Za-z_]+\s+AS\b)/i},
  {code:'restricted_detach',pattern:/\bDETACH\s+DATABASE\b/i},
  {code:'restricted_vacuum',pattern:/^\s*VACUUM\b/i},
  {code:'restricted_load_extension',pattern:/\bload_extension\s*\(/i},
]);

const HEADER_METHODS=new Set(['append','delete','get','getHeader','has','header','removeHeader','set','setHeader']);

function sourceFiles(directory){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(directory,entry.name);
    if(entry.isDirectory()) return entry.name==='node_modules'?[]:sourceFiles(path);
    return entry.isFile()&&SOURCE_EXTENSION.test(entry.name)?[path]:[];
  }).sort();
}

function parseSource(source){
  return parse(source,{allowHashBang:true,ecmaVersion:'latest',locations:true,sourceType:'module'});
}

function walkAst(node,visit,parent=null,grandparent=null){
  if(!node||typeof node!=='object'||typeof node.type!=='string') return;
  visit(node,parent,grandparent);
  for(const [key,value] of Object.entries(node)){
    if(['end','loc','range','start','type'].includes(key)) continue;
    if(Array.isArray(value)) value.forEach(child=>walkAst(child,visit,node,parent));
    else walkAst(value,visit,node,parent);
  }
}

function constBindings(ast){
  const bindings=new Map();
  walkAst(ast,(node,parent)=>{
    if(node.type==='VariableDeclarator'&&parent?.type==='VariableDeclaration'&&parent.kind==='const'
      &&node.id?.type==='Identifier'&&node.init){
      const candidates=bindings.get(node.id.name)||[];
      candidates.push(node.init);
      bindings.set(node.id.name,candidates);
    }
  });
  return bindings;
}

function memberName(node){
  if(node?.type!=='MemberExpression') return null;
  if(!node.computed&&node.property?.type==='Identifier') return node.property.name;
  if(node.computed&&node.property?.type==='Literal'&&typeof node.property.value==='string') return node.property.value;
  return null;
}

// Fold an expression into SQL text, keeping `${dynamic}` for values that are
// not statically known. Handles literals, templates, String.raw, `+`, and
// array join/concat so assembled statements are seen whole.
function shape(node,bindings,seen=new Set()){
  if(!node) return DYNAMIC;
  if(node.type==='Literal') return typeof node.value==='string'?node.value:DYNAMIC;
  if(node.type==='TemplateLiteral'||(node.type==='TaggedTemplateExpression'
    &&node.tag?.type==='MemberExpression'&&node.tag.object?.name==='String'&&node.tag.property?.name==='raw')){
    const template=node.type==='TemplateLiteral'?node:node.quasi;
    const raw=node.type!=='TemplateLiteral';
    let value='';
    template.quasis.forEach((quasi,index)=>{
      value+=raw?quasi.value.raw:(quasi.value.cooked??quasi.value.raw);
      if(index<template.expressions.length) value+=shape(template.expressions[index],bindings,seen);
    });
    return value;
  }
  if(node.type==='BinaryExpression'&&node.operator==='+'){
    return shape(node.left,bindings,seen)+shape(node.right,bindings,seen);
  }
  if(node.type==='Identifier'){
    const candidates=bindings.get(node.name)||[];
    if(seen.has(node.name)||candidates.length!==1) return DYNAMIC;
    return shape(candidates[0],bindings,new Set([...seen,node.name]));
  }
  if(node.type==='CallExpression'&&node.callee?.type==='MemberExpression'){
    const method=memberName(node.callee);
    if(method==='join'&&node.callee.object?.type==='ArrayExpression'){
      const separator=node.arguments.length?shape(node.arguments[0],bindings,seen):',';
      return node.callee.object.elements.map(item=>shape(item,bindings,seen)).join(separator);
    }
    if(method==='concat'){
      return shape(node.callee.object,bindings,seen)+node.arguments.map(item=>shape(item,bindings,seen)).join('');
    }
  }
  return DYNAMIC;
}

function isAssemblyCall(node){
  return node?.type==='CallExpression'&&['join','concat'].includes(memberName(node.callee));
}

function isStringRoot(node,parent,grandparent){
  const stringish=(node.type==='Literal'&&typeof node.value==='string')
    ||node.type==='TemplateLiteral'
    ||(node.type==='BinaryExpression'&&node.operator==='+')
    ||(node.type==='CallExpression'&&['join','concat'].includes(memberName(node.callee)));
  if(!stringish) return false;
  // Only the outermost assembly is analysed; its pieces are folded into it.
  if(parent?.type==='BinaryExpression'&&parent.operator==='+') return false;
  if(parent?.type==='TemplateLiteral') return false;
  if(parent?.type==='TaggedTemplateExpression') return false;
  const assemblyMember=candidate=>candidate?.type==='MemberExpression'&&['join','concat'].includes(memberName(candidate));
  if(assemblyMember(parent)&&parent.object===node) return false;
  if(parent?.type==='ArrayExpression'&&assemblyMember(grandparent)&&grandparent.object===parent) return false;
  if(isAssemblyCall(parent)) return false;
  return true;
}

function isHttpHeaderName(node,parent,text){
  return /^pragma$/i.test(text)&&parent?.type==='CallExpression'&&parent.arguments[0]===node
    &&HEADER_METHODS.has(memberName(parent.callee));
}

/** Classify every PRAGMA usage in one SQL text against the allowlist. */
export function classifySqlText(text,file){
  const findings=[];
  const keyword=/\bPRAGMA\b/gi;
  let match;
  while((match=keyword.exec(text))){
    const rest=text.slice(match.index+match[0].length);
    if(/^_/.test(rest)) continue;
    const named=rest.match(/^\s+(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)/);
    if(!named){
      findings.push({code:rest.trimStart().startsWith(DYNAMIC)?'dynamic_pragma_name':'dangling_pragma',pragma:null,statement:text.slice(match.index).trim()});
      continue;
    }
    const name=named[2].toLowerCase();
    const after=rest.slice(named[0].length);
    const argument=(after.match(/^\s*(\([^()]*(?:\([^()]*\)[^()]*)*\)|=\s*[^\s;]+)?/)[1]||'').replace(/\s+/g,'');
    const statement=`${match[0].toUpperCase()} ${named[1]?`${named[1]}.`:''}${named[2]}${argument}`;
    const entry=Object.hasOwn(TURSO_REMOTE_PRAGMA_ALLOWLIST,name)?TURSO_REMOTE_PRAGMA_ALLOWLIST[name]:null;
    if(named[1]) findings.push({code:'schema_qualified_pragma',pragma:name,statement});
    else if(!entry) findings.push({code:'not_allowlisted_pragma',pragma:name,statement});
    else if(entry.files&&!entry.files.includes(file)) findings.push({code:'helper_only_pragma',pragma:name,statement});
    else if(!entry.arguments.some(pattern=>pattern.test(argument))) findings.push({code:'unsupported_pragma_argument',pragma:name,statement});
    else findings.push({code:'allowed',pragma:name,statement});
  }
  const functions=/\bpragma_([A-Za-z_][A-Za-z0-9_]*)/gi;
  while((match=functions.exec(text))){
    const name=match[1].toLowerCase();
    findings.push({
      code:TURSO_REMOTE_PRAGMA_FUNCTION_ALLOWLIST.includes(name)?'allowed_function':'not_allowlisted_pragma_function',
      pragma:`pragma_${name}`,
      statement:match[0],
    });
  }
  for(const restricted of RESTRICTED_STATEMENTS){
    if(restricted.pattern.test(text)) findings.push({code:restricted.code,pragma:null,statement:text.trim().slice(0,120)});
  }
  return findings;
}

/** Scan one JavaScript source and return every PRAGMA finding with its line. */
export function scanSource(source,file){
  const ast=parseSource(source);
  const bindings=constBindings(ast);
  const findings=[];
  walkAst(ast,(node,parent,grandparent)=>{
    if(!isStringRoot(node,parent,grandparent)) return;
    const text=shape(node,bindings);
    if(!/pragma/i.test(text)&&!RESTRICTED_STATEMENTS.some(item=>item.pattern.test(text))) return;
    if(isHttpHeaderName(node,parent,text)) return;
    for(const finding of classifySqlText(text,file)) findings.push({file,line:node.loc.start.line,...finding});
  });
  return findings;
}

export function scanTursoRemoteSql({root=process.cwd(),directories=SCANNED_DIRECTORIES}={}){
  const findings=[];
  for(const directory of directories){
    for(const path of sourceFiles(resolve(root,directory))){
      const file=relative(root,path).replaceAll('\\','/');
      findings.push(...scanSource(readFileSync(path,'utf8'),file));
    }
  }
  const violations=findings.filter(item=>!item.code.startsWith('allowed'));
  return {findings,violations};
}

const isEntryPoint=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isEntryPoint){
  const {findings,violations}=scanTursoRemoteSql();
  for(const item of violations){
    console.error(`${item.file}:${item.line} ${item.code} ${item.statement}`);
  }
  console.log(JSON.stringify({ok:violations.length===0,pragmaUsages:findings.length,violations:violations.length}));
  process.exitCode=violations.length?1:0;
}
