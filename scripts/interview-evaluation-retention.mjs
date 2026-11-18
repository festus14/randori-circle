#!/usr/bin/env node
// Offline, local-file rehearsal only. Never reads provider credentials.
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { localDatabaseTarget, guardDatabaseTarget } from './db-migrate.mjs';
import { evaluationSchemaInstalled, purgeExpiredEvaluations } from '../api/_interviewer-toolkit.js';
export async function runEvaluationRetention(argv=process.argv.slice(2)){
  if(argv.some((arg,index)=>!['--database','--purge','--confirm'].includes(arg)&&argv[index-1]!=='--database'&&argv[index-1]!=='--confirm'))throw new Error('unsupported retention option');
  const database=argv[argv.indexOf('--database')+1];
  if(!argv.includes('--database'))throw new Error('explicit local database required');
  const target=localDatabaseTarget(database);
  if(!target.exists)throw new Error('existing local database required');
  const purge=argv.includes('--purge');
  if(purge&&argv[argv.indexOf('--confirm')+1]!=='DELETE_EXPIRED_INTERVIEW_EVALUATIONS')throw new Error('purge confirmation required');
  const guard=guardDatabaseTarget(target),db=createClient({url:target.url});
  try{
    if(!await evaluationSchemaInstalled(db))return {ok:true,not_installed:true,eligible:0,deleted:0};
    guard.assertIdentity();
    const result=await db.execute("SELECT COUNT(*) AS n FROM (SELECT 1 FROM interview_evaluations WHERE expires_at<CAST(strftime('%s','now') AS INTEGER) ORDER BY expires_at,pair_group_id LIMIT 100)");
    const eligible=Number(result.rows[0].n);
    if(!purge)return {ok:true,mode:'dry_run',eligible,deleted:0};
    guard.assertIdentity();
    return {ok:true,mode:'purge',eligible,...await purgeExpiredEvaluations(db,{enabled:true})};
  }finally{db.close();guard.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{console.log(JSON.stringify(await runEvaluationRetention()));}
  catch{console.error(JSON.stringify({ok:false,error:'evaluation retention refused'}));process.exitCode=1;}
}
