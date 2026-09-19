import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';

import {
  adoptChatRetentionScope,
  chatRetentionRuntimeConfig,
  ChatRetentionError,
  enqueueNextChatRetentionRun,
  ensureChatRetentionReadiness,
  placeChatRetentionHold,
  readChatRetentionMetrics,
  releaseChatRetentionHold,
  replayChatRetentionRun,
  runChatRetentionWorker,
  setChatRetentionControl,
} from '../api/_chat-retention.js';
import { LATEST_MIGRATION_VERSION } from '../db/migration-contract.js';
import { inspectMigrationState, prepareMigrationConnection } from '../db/migration-runner.js';

const ACTIONS=new Set([
  'status','run','enable','disable','adopt_scope','hold_tenant','hold_room','release_tenant','release_room','replay',
]);

function positiveInteger(value,label,{allowZero=false}={}){
  const number=Number(value);
  const minimum=allowZero?0:1;
  if(!Number.isSafeInteger(number)||number<minimum) throw new TypeError(`invalid ${label}`);
  return number;
}

function required(value,label){
  const normalized=String(value||'').trim();
  if(!normalized) throw new TypeError(`missing ${label}`);
  return normalized;
}

function scopeFromEnvironment(env,{tenant=false}={}){
  const scopeKey=required(env.CHAT_RETENTION_SCOPE_KEY,'retention scope');
  const circleId=scopeKey==='local'?null:positiveInteger(env.CHAT_RETENTION_CIRCLE_ID,'retention circle');
  return {
    scopeKey,circleId,
    ...(tenant?{}:{
      weekId:positiveInteger(env.CHAT_RETENTION_WEEK_ID,'retention week'),
      pairGroupId:positiveInteger(env.CHAT_RETENTION_PAIR_GROUP_ID,'retention pair group'),
    }),
  };
}

function gateFromEnvironment(env){
  return {
    backup:{
      digest:required(env.CHAT_RETENTION_BACKUP_EVIDENCE_DIGEST,'backup evidence digest'),
      scopeBindingDigest:required(env.CHAT_RETENTION_BACKUP_SCOPE_BINDING_DIGEST,
        'backup scope binding digest'),
      sourceMaxMessageId:positiveInteger(env.CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID,
        'backup source maximum message'),
      throughAt:required(env.CHAT_RETENTION_BACKUP_THROUGH_AT,'backup through time'),
      completedAt:required(env.CHAT_RETENTION_BACKUP_COMPLETED_AT,'backup completion time'),
    },
    exported:{
      digest:required(env.CHAT_RETENTION_EXPORT_EVIDENCE_DIGEST,'export evidence digest'),
      scopeBindingDigest:required(env.CHAT_RETENTION_EXPORT_SCOPE_BINDING_DIGEST,
        'export scope binding digest'),
      sourceMaxMessageId:positiveInteger(env.CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID,
        'export source maximum message'),
      throughAt:required(env.CHAT_RETENTION_EXPORT_THROUGH_AT,'export through time'),
      completedAt:required(env.CHAT_RETENTION_EXPORT_COMPLETED_AT,'export completion time'),
    },
  };
}

function publicError(error){
  const code=String(error?.code||'');
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:'RETENTION_COMMAND_FAILED';
}

export async function runChatRetentionCli({env=process.env,createDatabase=createClient}={}){
  const action=String(env.CHAT_RETENTION_ACTION||'status').trim().toLowerCase().replaceAll('-','_');
  if(!ACTIONS.has(action)) throw new TypeError('invalid retention action');
  const url=required(env.TURSO_DATABASE_URL,'database URL');
  const authToken=String(env.TURSO_AUTH_TOKEN||'').trim()||undefined;
  const db=createDatabase({url,authToken});
  try{
    await prepareMigrationConnection(db);
    const migration=await inspectMigrationState(db);
    if(!migration.ready||migration.currentVersion!==LATEST_MIGRATION_VERSION){
      throw new ChatRetentionError('RETENTION_SCHEMA_UNAVAILABLE');
    }
    await ensureChatRetentionReadiness(db);
    if(action==='status') return Object.freeze({ok:true,action,metrics:await readChatRetentionMetrics(db)});
    if(action==='enable'||action==='disable'){
      const result=await setChatRetentionControl(db,{
        enabled:action==='enable',
        expectedGeneration:positiveInteger(env.CHAT_RETENTION_EXPECTED_GENERATION,
          'retention control generation',{allowZero:true}),
      });
      return Object.freeze({ok:true,action,enabled:result.enabled,generation:result.generation});
    }
    if(action==='adopt_scope'){
      const result=await adoptChatRetentionScope(db,{
        scope:scopeFromEnvironment(env),localRuntime:env.CHAT_RETENTION_LOCAL_ADOPTION==='true',
      });
      return Object.freeze({ok:true,action,created:result.created});
    }
    if(['hold_tenant','hold_room'].includes(action)){
      const tenant=action==='hold_tenant';
      const result=await placeChatRetentionHold(db,{
        hold:{...scopeFromEnvironment(env,{tenant}),holdLevel:tenant?'tenant':'room'},
        reason:required(env.CHAT_RETENTION_REASON_CODE,'retention reason'),
      });
      return Object.freeze({ok:true,action,active:result.active});
    }
    if(['release_tenant','release_room'].includes(action)){
      const tenant=action==='release_tenant';
      const result=await releaseChatRetentionHold(db,{
        hold:{...scopeFromEnvironment(env,{tenant}),holdLevel:tenant?'tenant':'room'},
      });
      return Object.freeze({ok:true,action,released:result.released});
    }
    if(action==='replay'){
      const replayed=await replayChatRetentionRun(db,{
        runId:positiveInteger(env.CHAT_RETENTION_RUN_ID,'retention run'),
        reason:required(env.CHAT_RETENTION_REASON_CODE,'retention replay reason'),
      });
      return Object.freeze({ok:true,action,replayed});
    }
    const config=chatRetentionRuntimeConfig(env);
    if(!config.enabled){
      return Object.freeze({
        ok:true,action,mode:config.mode,enqueued:false,
        worker:await runChatRetentionWorker({
          db,workerId:'retention-worker',enabled:false,mode:config.mode,
        }),
        metrics:await readChatRetentionMetrics(db),
      });
    }
    const gate=gateFromEnvironment(env);
    const enqueued=await enqueueNextChatRetentionRun(db,{
      mode:config.mode,scope:scopeFromEnvironment(env),...gate,
    });
    const worker=await runChatRetentionWorker({
      db,workerId:'retention-worker',enabled:config.enabled,mode:config.mode,
    });
    return Object.freeze({
      ok:true,action,mode:config.mode,enqueued:enqueued.created,
      worker,metrics:await readChatRetentionMetrics(db),
    });
  }finally{
    try{ db.close(); }catch{}
  }
}

async function main(){
  try{
    const result=await runChatRetentionCli();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }catch(error){
    process.stderr.write(`${JSON.stringify({ok:false,error_code:publicError(error)})}\n`);
    process.exitCode=2;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) await main();
