#!/usr/bin/env node
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
  publicMigrationError,
} from '../db/migration-runner.js';

const MODES=new Set(['status','apply','adopt']);
const EXPECTED_STATE=/^[a-f0-9]{64}$/;
const CONTROLLED_MIGRATION_ERRORS=new Set([
  'MIGRATION_STATE_CHANGED',
  'MIGRATION_UNMANAGED',
  'MIGRATION_ADOPTION_BLOCKED',
  'MIGRATION_LEDGER_INVALID',
  'MIGRATION_SCHEMA_INVALID',
]);
const USAGE='Usage: node scripts/db-migrate.mjs <status|apply|adopt> --database <absolute-file-url> [--expected-state <sha256>]';

function cliError(code,message){
  return Object.assign(new Error(message),{code});
}

export function parseArguments(argv){
  if(!Array.isArray(argv)||!MODES.has(argv[0])||(argv.length-1)%2!==0){
    throw cliError('DB_MIGRATE_USAGE',USAGE);
  }
  const mode=argv[0];
  const flags=new Map();
  for(let index=1;index<argv.length;index+=2){
    const flag=argv[index];
    const value=argv[index+1];
    if(!['--database','--expected-state'].includes(flag)||flags.has(flag)||typeof value!=='string'||!value){
      throw cliError('DB_MIGRATE_USAGE',USAGE);
    }
    flags.set(flag,value);
  }
  if(!flags.has('--database')) throw cliError('DB_MIGRATE_USAGE',USAGE);
  const expectedStateFingerprint=flags.get('--expected-state')||null;
  if(mode==='status'&&expectedStateFingerprint!==null){
    throw cliError('DB_MIGRATE_USAGE',USAGE);
  }
  if(mode!=='status'&&!EXPECTED_STATE.test(expectedStateFingerprint||'')){
    throw cliError('DB_MIGRATE_EXPECTED_STATE','A lowercase 64-character --expected-state is required for apply and adopt.');
  }
  return {mode,database:flags.get('--database'),expectedStateFingerprint};
}

export function localDatabaseTarget(value){
  const raw=String(value||'').trim();
  let url;
  try{ url=new URL(raw); }catch{
    throw cliError('DB_MIGRATE_TARGET','Database target must be an absolute persistent local file URL.');
  }
  if(!raw.startsWith('file:/')||url.protocol!=='file:'||url.host||url.username||url.password
    ||url.search||url.hash){
    throw cliError('DB_MIGRATE_TARGET','Database target must be an absolute persistent local file URL.');
  }
  let path;
  try{ path=fileURLToPath(url); }catch{
    throw cliError('DB_MIGRATE_TARGET','Database target must be an absolute persistent local file URL.');
  }
  path=resolve(path);
  if(!isAbsolute(path)||basename(path)===':memory:'){
    throw cliError('DB_MIGRATE_TARGET','Database target must be an absolute persistent local file URL.');
  }
  let exists=false;
  try{
    const parent=realpathSync(dirname(path));
    if(!statSync(parent).isDirectory()){
      throw cliError('DB_MIGRATE_TARGET','Database target parent must be an existing local directory.');
    }
    path=resolve(parent,basename(path));
    let metadata=null;
    try{ metadata=lstatSync(path); }
    catch(error){
      if(error?.code!=='ENOENT') throw error;
    }
    exists=metadata!==null;
    if(metadata&&(metadata.isSymbolicLink()||!metadata.isFile())){
      throw cliError('DB_MIGRATE_TARGET','Database target must be a regular local file, not a link or special file.');
    }
  }catch(error){
    if(error?.code?.startsWith?.('DB_MIGRATE_')) throw error;
    throw cliError('DB_MIGRATE_TARGET','Database target is not accessible as a local file.');
  }
  return Object.freeze({url:pathToFileURL(path).href,path,exists});
}

function sameFile(left,right){
  return left.isFile()&&right.isFile()&&left.dev===right.dev&&left.ino===right.ino;
}

export function guardDatabaseTarget(target,{create=false}={}){
  const noFollow=constants.O_NOFOLLOW||0;
  const flags=create
    ?constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|noFollow
    :constants.O_RDONLY|noFollow;
  let descriptor;
  try{
    descriptor=openSync(target.path,flags,0o600);
    const opened=fstatSync(descriptor,{bigint:true});
    const assertIdentity=()=>{
      let current;
      try{ current=lstatSync(target.path,{bigint:true}); }catch{
        throw cliError('DB_MIGRATE_TARGET','Database target changed while it was open.');
      }
      if(current.isSymbolicLink()||!sameFile(opened,current)){
        throw cliError('DB_MIGRATE_TARGET','Database target changed while it was open.');
      }
    };
    assertIdentity();
    return Object.freeze({
      assertIdentity,
      close:()=>{
        if(descriptor===undefined) return;
        const current=descriptor;
        descriptor=undefined;
        closeSync(current);
      },
    });
  }catch(error){
    if(descriptor!==undefined) closeSync(descriptor);
    if(error?.code?.startsWith?.('DB_MIGRATE_')) throw error;
    throw cliError('DB_MIGRATE_TARGET','Database target could not be opened safely.');
  }
}

function guardedDatabaseClient(client,targetGuard){
  const assertIdentity=()=>targetGuard.assertIdentity();
  return {
    async execute(statement){
      assertIdentity();
      const result=await client.execute(statement);
      assertIdentity();
      return result;
    },
    async transaction(mode){
      assertIdentity();
      const transaction=await client.transaction(mode);
      try{ assertIdentity(); }
      catch(error){
        try{ await transaction.rollback(); }catch{}
        try{ await transaction.close?.(); }catch{}
        throw error;
      }
      return transaction;
    },
    close(){ return client.close?.(); },
  };
}

function uniqueStrings(values){
  return [...new Set(values.filter(Boolean).map(String))].sort();
}

export function migrationStatusResult(state,target){
  const schemaBlockers=(state.schemaStatus?.blockers||[]).map(blocker=>blocker.code);
  const membershipBlockers=state.adoption?.membership?.blockers||[];
  const blockers=state.classification==='fresh' ? []
    : state.classification==='managed' ? (state.ready?[]:[...schemaBlockers,...membershipBlockers])
      : state.adoption?.eligible ? [] : (state.adoption?.blockers||['schema_not_exact']);
  const ok=blockers.length===0;
  const pendingVersions=state.classification==='unmanaged'?[]:
    Array.from({length:Math.max(0,state.latestVersion-state.currentVersion)},(_value,index)=>state.currentVersion+index+1);
  return {
    ok,
    command:'db:migrate:status',
    readOnly:true,
    target:{kind:'local-file',exists:target.exists},
    state:state.classification,
    stateFingerprint:state.stateFingerprint,
    ledger:{
      present:state.ledgerPresent,
      currentVersion:state.currentVersion,
      latestVersion:state.latestVersion,
    },
    pendingVersions,
    capabilities:{
      apply:state.classification==='fresh'||(state.classification==='managed'&&state.ready),
      adopt:state.adoption?.eligible===true,
    },
    blockers:uniqueStrings(blockers),
  };
}

function mutationResult(mode,stateBefore,result,target){
  const changed=mode==='apply'?(result.applied||[]):(result.adopted||[]);
  return {
    ok:true,
    command:`db:migrate:${mode}`,
    readOnly:false,
    target:{kind:'local-file',existedBefore:target.exists},
    result:changed.length===0?'noop':mode==='apply'?'applied':'adopted',
    stateBefore:stateBefore.classification,
    state:'managed',
    fromVersion:result.fromVersion,
    toVersion:result.toVersion,
    latestVersion:result.latestVersion,
    ...(mode==='apply'
      ?{appliedVersions:changed.map(item=>item.version)}
      :{adoptedVersions:changed.map(item=>item.version)}),
    stateFingerprint:result.stateFingerprint,
  };
}

function controlledMigrationError(error){
  return error instanceof MigrationError&&CONTROLLED_MIGRATION_ERRORS.has(error.code);
}

export function publicCliError(error){
  if(error?.code==='DB_MIGRATE_USAGE'){
    return {ok:false,command:'db:migrate',error:error.code,message:USAGE};
  }
  if(error?.code==='DB_MIGRATE_EXPECTED_STATE'){
    return {ok:false,command:'db:migrate',error:error.code,message:'A valid expected state fingerprint is required.'};
  }
  if(error?.code==='DB_MIGRATE_TARGET'){
    return {ok:false,command:'db:migrate',error:error.code,message:'A valid persistent local database target is required.'};
  }
  return {command:'db:migrate',...publicMigrationError(error)};
}

export async function main({
  argv=process.argv.slice(2),
  stdout=process.stdout,
  createDatabaseClient=createClient,
  inspect=inspectMigrationState,
  prepare=prepareMigrationConnection,
  apply=applyMigrations,
  adopt=adoptMigrations,
}={}){
  const options=parseArguments(argv);
  const target=localDatabaseTarget(options.database);
  let client=null;
  let targetGuard=null;
  let result;
  let exitCode=0;
  const closeClient=async()=>{
    const current=client;
    client=null;
    await current?.close?.();
  };
  const closeTargetGuard=()=>{
    const current=targetGuard;
    targetGuard=null;
    current?.close();
  };
  const openTargetClient=create=>{
    targetGuard=guardDatabaseTarget(target,{create});
    targetGuard.assertIdentity();
    const rawClient=createDatabaseClient({url:target.url});
    targetGuard.assertIdentity();
    return guardedDatabaseClient(rawClient,targetGuard);
  };
  try{
    client=target.exists?openTargetClient(false):createDatabaseClient({url:'file::memory:'});
    await prepare(client);
    const stateBefore=await inspect(client);
    targetGuard?.assertIdentity();
    if(options.mode==='status'){
      result=migrationStatusResult(stateBefore,target);
      exitCode=result.ok?0:2;
    }else{
      if(options.mode==='apply'&&!target.exists){
        if(stateBefore.stateFingerprint!==options.expectedStateFingerprint){
          throw new MigrationError('MIGRATION_STATE_CHANGED','Migration state fingerprint mismatch');
        }
        await closeClient();
        client=openTargetClient(true);
        await prepare(client);
        targetGuard.assertIdentity();
      }
      targetGuard?.assertIdentity();
      const operation=options.mode==='apply'?apply:adopt;
      const operationResult=await operation(client,{expectedStateFingerprint:options.expectedStateFingerprint});
      targetGuard?.assertIdentity();
      result=mutationResult(options.mode,stateBefore,operationResult,target);
    }
  }catch(error){
    targetGuard?.assertIdentity();
    if(!controlledMigrationError(error)) throw error;
    result={command:`db:migrate:${options.mode}`,...publicMigrationError(error)};
    exitCode=2;
  }finally{
    try{ await closeClient(); }
    finally{ closeTargetGuard(); }
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return {result,exitCode};
}

export async function runCli(options={}){
  const stderr=options.stderr||process.stderr;
  try{ return await main(options); }
  catch(error){
    const result=publicCliError(error);
    stderr.write(`${JSON.stringify(result)}\n`);
    return {result,exitCode:1};
  }
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  runCli().then(({exitCode})=>{ process.exitCode=exitCode; });
}
