#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { buildReadOnlyPlan, inspectSchema } from '../db/schema-inspector.js';

export function parseMode(argv){
  if(argv.length!==1||!['status','plan'].includes(argv[0])){
    throw Object.assign(new Error('Usage: node scripts/db-inspect.mjs <status|plan>'),{code:'DB_INSPECT_USAGE'});
  }
  return argv[0];
}

export function databaseConfig(env){
  const url=String(env.TURSO_DATABASE_URL||'').trim();
  if(!url) throw Object.assign(new Error('TURSO_DATABASE_URL is required'),{code:'DB_INSPECT_CONFIG'});
  return {url,authToken:String(env.TURSO_AUTH_TOKEN||'').trim()||undefined};
}

export function publicCliError(error){
  const code=String(error?.code||'');
  if(['DB_INSPECT_USAGE','DB_INSPECT_CONFIG'].includes(code)){
    return {ok:false,error:code,message:String(error.message||'invalid database inspection request')};
  }
  return {ok:false,error:'DB_INSPECT_FAILED',message:'database inspection failed'};
}

export async function main({
  argv=process.argv.slice(2),
  env=process.env,
  stdout=process.stdout,
  createDatabaseClient=createClient,
}={}){
  const mode=parseMode(argv);
  const client=createDatabaseClient(databaseConfig(env));
  try{
    const status=await inspectSchema(client);
    const result=mode==='status'?{command:'db:status',...status}:{command:'db:plan',...buildReadOnlyPlan(status)};
    stdout.write(`${JSON.stringify(result)}\n`);
    return {result,exitCode:mode==='status'&&!status.ok?2:0};
  }finally{
    client.close?.();
  }
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  main().then(({exitCode})=>{ process.exitCode=exitCode; }).catch(error=>{
    process.stderr.write(`${JSON.stringify(publicCliError(error))}\n`);
    process.exitCode=1;
  });
}
