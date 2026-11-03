#!/usr/bin/env node
// Daily workflow driver: fixed policy, existing CLI purge, counts-only evidence.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { DELETION_LEDGER_DB_SCHEMA, main as ledgerCli } from './deletion-ledger.mjs';
import { RetentionError, RETENTION_MAX_ENTRIES, RETENTION_WINDOW_MS } from './deletion-ledger-retention-policy.mjs';

const ERRORS=new Set(['RETENTION_CONFIG_REFUSED','RETENTION_CONTEXT_REFUSED',
  'RETENTION_TARGET_REFUSED','RETENTION_DATA_REFUSED','RETENTION_CAP_EXCEEDED',
  'RETENTION_COUNT_MISMATCH']);
const numericMetadata=value=>/^\d{1,20}$/.test(String(value||''))?String(value):null;
const fail=code=>{ throw new RetentionError(code); };

export async function main({env=process.env,dryRun=true,now=new Date(),allowLocal=false,
  createDatabaseClient=createClient,stdout=process.stdout}={}){
  const evidence={version:1,ok:false,category:'RETENTION_FAILED',dry_run:dryRun===true,
    run_id:numericMetadata(env.GITHUB_RUN_ID),run_attempt:numericMetadata(env.GITHUB_RUN_ATTEMPT),
    timestamp:now.toISOString(),cutoff:new Date(now.getTime()-RETENTION_WINDOW_MS).toISOString(),
    window_hours:24,cap:RETENTION_MAX_ENTRIES,target_verified:false,
    eligible:null,purged:null,retained:null};
  try{
    if(typeof dryRun!=='boolean') fail('RETENTION_CONFIG_REFUSED');
    if(!allowLocal&&(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!=='festus14/randori-circle'
      ||env.GITHUB_REF!=='refs/heads/main'||!evidence.run_id||!evidence.run_attempt
      ||!['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
      ||env.GITHUB_WORKFLOW_REF!=='festus14/randori-circle/.github/workflows/deletion-ledger-retention.yml@refs/heads/main')){
      fail('RETENTION_CONTEXT_REFUSED');
    }
    const url=String(env.DELETION_LEDGER_DATABASE_URL||'').trim();
    const token=String(env.DELETION_LEDGER_AUTH_TOKEN||'').trim();
    // No app credential fallback. Local runs are injected tests or the self-contained
    // disposable rehearsal; the secret-bearing workflow accepts remote libSQL only.
    if(allowLocal?!url.startsWith('file:'):(!url.startsWith('libsql://')||!token)){
      fail('RETENTION_CONFIG_REFUSED');
    }
    const {result}=await ledgerCli({
      argv:['purge','--before',evidence.cutoff,'--retention',...(dryRun?['--dry-run']:[])],
      env:{DELETION_LEDGER_DATABASE_URL:url,DELETION_LEDGER_AUTH_TOKEN:token},
      createDatabaseClient,stdout:{write(){}},
    });
    Object.assign(evidence,{ok:true,category:'RETENTION_OK',target_verified:result.target_verified,
      eligible:result.eligible,purged:result.purged,retained:result.retained});
  }catch(error){
    // Never serialize provider errors, arbitrary error codes/messages or row values.
    evidence.category=error instanceof RetentionError&&ERRORS.has(error.code)?error.code:'RETENTION_FAILED';
    if(evidence.category==='RETENTION_CAP_EXCEEDED'){
      Object.assign(evidence,{eligible:error.counts.eligible,purged:0,
        retained:error.counts.retained,target_verified:true});
    }
  }
  const json=JSON.stringify(evidence,null,2);
  try{
    if(env.RUNNER_TEMP) writeFileSync(join(env.RUNNER_TEMP,'deletion-ledger-retention-summary.json'),`${json}\n`,{mode:0o600});
    if(env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT,Object.entries(evidence).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
    if(env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,`## Deletion ledger retention\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  }catch{
    stdout.write('{"ok":false,"category":"RETENTION_EVIDENCE_FAILED"}\n');
    return {evidence,exitCode:1};
  }
  stdout.write(`${JSON.stringify(evidence)}\n`);
  return {evidence,exitCode:evidence.ok?0:1};
}

export async function rehearse({env=process.env,stdout=process.stdout}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-ledger-retention-rehearsal-'));
  const url=`file:${join(directory,'ledger.db')}`;
  const client=createClient({url});
  const now=new Date();
  const cutoff=new Date(now.getTime()-RETENTION_WINDOW_MS).toISOString();
  const created=new Date(now.getTime()-2*RETENTION_WINDOW_MS).toISOString();
  try{
    await client.execute(DELETION_LEDGER_DB_SCHEMA);
    await client.execute({sql:`INSERT INTO deletion_ledger VALUES
      (1,?,?),(2,?,?),(3,?,?),(4,NULL,?)`,args:[
      new Date(now.getTime()-RETENTION_WINDOW_MS-1).toISOString(),created,
      cutoff,created,new Date(now.getTime()-RETENTION_WINDOW_MS+1).toISOString(),created,created,
    ]});
    const result=await main({env:{DELETION_LEDGER_DATABASE_URL:url,
      RUNNER_TEMP:env.RUNNER_TEMP,GITHUB_OUTPUT:env.GITHUB_OUTPUT,
      GITHUB_STEP_SUMMARY:env.GITHUB_STEP_SUMMARY,GITHUB_RUN_ID:env.GITHUB_RUN_ID,
      GITHUB_RUN_ATTEMPT:env.GITHUB_RUN_ATTEMPT},dryRun:true,now,allowLocal:true,stdout});
    const {rows}=await client.execute('SELECT COUNT(*) AS n FROM deletion_ledger');
    if(!result.evidence.ok||result.evidence.eligible!==1||result.evidence.purged!==0
      ||result.evidence.retained!==4||Number(rows[0].n)!==4) fail('RETENTION_REHEARSAL_FAILED');
    return result;
  }finally{
    client.close();
    rmSync(directory,{recursive:true,force:true});
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const operation=args.length===1&&args[0]==='--rehearse'?()=>rehearse():
    args.length===2&&args[0]==='--dry-run'&&['true','false'].includes(args[1])
      ?()=>main({dryRun:args[1]==='true'}):null;
  if(!operation){
    process.stderr.write('{"ok":false,"category":"RETENTION_CONFIG_REFUSED"}\n');
    process.exitCode=1;
  }else operation().then(({exitCode})=>{process.exitCode=exitCode;}).catch(()=>{
    process.stderr.write('{"ok":false,"category":"RETENTION_FAILED"}\n');
    process.exitCode=1;
  });
}
