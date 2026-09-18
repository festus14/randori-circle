#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DDL_OBJECT=String.raw`(?:TABLE|INDEX|VIEW|TRIGGER)`;
const DDL_PATTERN=new RegExp(String.raw`\b(?:CREATE\s+(?:(?:UNIQUE|TEMP(?:ORARY)?|VIRTUAL|OR\s+REPLACE)\s+)*${DDL_OBJECT}|ALTER\s+TABLE|DROP\s+${DDL_OBJECT})\b`,'i');
const ASSEMBLED_DDL_PATTERN=new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s*['"\x60]\s*\+\s*['"\x60]\s*(?:UNIQUE\s+)?${DDL_OBJECT}\b`,'i');
const SOURCE_EXTENSION=/\.[cm]?js$/i;

// This allowlist records the request-time schema debt that existed when the
// migration foundation was introduced. New DDL must be added to a versioned
// migration in a later slice, not silently introduced on an API request path.
export const RUNTIME_DDL_ALLOWLIST=Object.freeze([
  Object.freeze({file:'api/_circle-membership.js',statementCount:6,digest:'5177c04805431cf5514ea3f9f6083e843e68f7220851ed58efcde85e6abc1dad'}),
  Object.freeze({file:'api/ai.js',statementCount:8,digest:'0433ffdc8aadad44f242d739a544df62f0d6584538c37eee323942085b3d0082'}),
  Object.freeze({file:'api/auth.js',statementCount:19,digest:'6b31d3a9987b386aec11a6891e377378375dc67ef4fde06bcfb92ef782d78034'}),
  Object.freeze({file:'api/data.js',statementCount:76,digest:'08123561556e15040080addeb06aa17e5e8d0fadb514d4a8dad2d9b380c325b5'}),
  Object.freeze({file:'api/ops.js',statementCount:18,digest:'87dcb5747500899355e4ea786370d9a054253a367341346af4e438f0337d2094'}),
]);

function sourceFiles(directory){
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=resolve(directory,entry.name);
    if(entry.isDirectory()) return sourceFiles(path);
    return entry.isFile()&&SOURCE_EXTENSION.test(entry.name)?[path]:[];
  }).sort();
}

function importedFiles(file,source,root){
  const specifiers=[
    ...source.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ...source.matchAll(/\bimport\s*['"](\.[^'"]+)['"]/g),
  ].map(match=>match[1]);
  return specifiers.flatMap(specifier=>{
    const unresolved=resolve(dirname(file),specifier);
    const candidates=extname(unresolved)?[unresolved]:[`${unresolved}.js`,`${unresolved}.mjs`,resolve(unresolved,'index.js')];
    const candidate=candidates.find(path=>existsSync(path)&&statSync(path).isFile());
    return candidate&&SOURCE_EXTENSION.test(candidate)&&!relative(root,candidate).startsWith('..')?[candidate]:[];
  });
}

function reachableSourceFiles(directory){
  const root=resolve(directory,'..');
  const queue=sourceFiles(directory);
  const seen=new Set();
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file)) continue;
    seen.add(file);
    const source=readFileSync(file,'utf8');
    importedFiles(file,source,root).forEach(imported=>{ if(!seen.has(imported)) queue.push(imported); });
  }
  return [...seen].sort();
}

export function stringLiterals(source){
  const literals=[];
  for(let start=0;start<source.length;start+=1){
    const quote=source[start];
    if(quote==='/'&&source[start+1]==='/'){
      const end=source.indexOf('\n',start+2);
      if(end<0) break;
      start=end;
      continue;
    }
    if(quote==='/'&&source[start+1]==='*'){
      const end=source.indexOf('*/',start+2);
      if(end<0) break;
      start=end+1;
      continue;
    }
    if(!['"',"'",'`'].includes(quote)) continue;
    let value='';
    let index=start+1;
    for(;index<source.length;index+=1){
      const character=source[index];
      if(character==='\\'){
        value+=character;
        if(index+1<source.length) value+=source[++index];
        continue;
      }
      if(character===quote) break;
      value+=character;
    }
    if(index>=source.length) continue;
    literals.push({value,quote,start,end:index,line:source.slice(0,start).split('\n').length});
    start=index;
  }
  return literals;
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
  const assemblyViolations=[];
  for(const path of reachableSourceFiles(root)){
    const file=relative(process.cwd(),path).replaceAll('\\','/');
    const source=readFileSync(path,'utf8');
    if(ASSEMBLED_DDL_PATTERN.test(source)) assemblyViolations.push({file,code:'assembled_ddl'});
    for(const literal of stringLiterals(source)){
      const hasDynamicSchemaTemplate=literal.quote==='`'&&literal.value.includes('${')&&/^\s*(?:CREATE|ALTER|DROP)\b/i.test(literal.value);
      const joinsAnotherExpression=/^\s*\+/.test(source.slice(literal.end+1,literal.end+20))
        ||/\+\s*$/.test(source.slice(Math.max(0,literal.start-20),literal.start));
      const joinedArrayWindow=source.slice(Math.max(0,literal.start-200),Math.min(source.length,literal.end+200));
      const joinsStringArray=/\]\s*\.join\s*\(/.test(joinedArrayWindow)&&/\[/.test(joinedArrayWindow);
      const hasSplitDdlVerb=(joinsAnotherExpression||joinsStringArray)&&!DDL_PATTERN.test(literal.value)
        &&/\b(?:CREATE|ALTER|DROP|TABLE|INDEX|VIEW|TRIGGER)\b/i.test(literal.value);
      const hasFullyDynamicDdl=/^\s*\$\{[^}]+\}\s+(?:\$\{[^}]+\}\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*\(|(?:TABLE|INDEX|VIEW|TRIGGER)\b)/i.test(literal.value);
      if(hasDynamicSchemaTemplate||hasSplitDdlVerb||hasFullyDynamicDdl) assemblyViolations.push({file,line:literal.line,code:'dynamic_ddl'});
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
