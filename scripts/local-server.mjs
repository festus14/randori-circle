#!/usr/bin/env node

import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
  publicMigrationError,
} from '../db/migration-runner.js';

const REPOSITORY_ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const DEFAULT_LOCAL_DIRECTORY='.local';
const DEFAULT_DATABASE_NAME='randori.db';
const DEFAULT_SECRET_NAME='jwt-secret';
const MAX_BODY_BYTES=1024*1024;
const LOOPBACK_HOSTS=new Set(['127.0.0.1','::1']);
let activeLocalRuntimeLock=null;
const LOCAL_CONTENT_SECURITY_POLICY=[
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
].join('; ');
const LOCAL_RUNTIME_MARKER='<meta name="randori-runtime" content="local"><script>window.__RANDORI_LOCAL_RUNTIME__=true;</script>';
const LOCAL_EXTERNAL_ASSET_TAGS=Object.freeze([
  '<link rel="preconnect" href="https://fonts.googleapis.com">',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
  '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">',
  '<script src="https://js-de.sentry-cdn.com/b4aa012a94edbcd36c8c92ef1aaeddfa.min.js" crossorigin="anonymous"></script>',
  '<link rel="preconnect" href="https://cdnjs.cloudflare.com">',
  '<link rel="preconnect" href="https://cdn.jsdelivr.net">',
  '<script src="https://unpkg.com/prettier@3.3.3/standalone.js" onerror="console.warn(\'prettier standalone failed\')"></script>',
  '<script src="https://unpkg.com/prettier@3.3.3/plugins/babel.js" onerror="console.warn(\'prettier babel failed\')"></script>',
  '<script src="https://unpkg.com/prettier@3.3.3/plugins/estree.js" onerror="console.warn(\'prettier estree failed\')"></script>',
  '<script src="https://unpkg.com/prettier@3.3.3/plugins/typescript.js" onerror="console.warn(\'prettier ts failed\')"></script>',
  '<script id="monacoLoader" src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js" onerror="window.__monacoLoaderFailed=1"></script>',
]);
const MIME_TYPES=Object.freeze({
  '.css':'text/css; charset=utf-8',
  '.gif':'image/gif',
  '.ico':'image/x-icon',
  '.jpeg':'image/jpeg',
  '.jpg':'image/jpeg',
  '.js':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.map':'application/json; charset=utf-8',
  '.png':'image/png',
  '.svg':'image/svg+xml',
  '.webmanifest':'application/manifest+json',
  '.webp':'image/webp',
  '.woff':'font/woff',
  '.woff2':'font/woff2',
});
const BROWSER_ASSET_DIRECTORIES=Object.freeze(['assets','public']);
export const LOCAL_OWNER_EMAIL='owner@randori.test';
export const LOCAL_OWNER_PASSWORD='randori-local-owner';
export const LOCAL_OWNER_NAME='Local Circle Owner';
const LOCAL_OWNER_COLOR='#c8f6a0';

export class LocalServerError extends Error {
  constructor(code,message,{cause}={}){
    super(message,{cause});
    this.name='LocalServerError';
    this.code=code;
  }
}

function refuse(code,message,cause){
  throw new LocalServerError(code,message,{cause});
}

function present(value){
  return value!==undefined&&value!==null&&String(value).trim()!=='';
}

function resolveRoot(rootDir){
  const root=resolve(String(rootDir||REPOSITORY_ROOT));
  try{
    if(!statSync(root).isDirectory()) refuse('LOCAL_DATABASE_REFUSED','Local server root must be a directory.');
    return realpathSync(root);
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    refuse('LOCAL_DATABASE_REFUSED','Local server root is not accessible.',error);
  }
}

function localDirectory(rootDir){
  return resolve(rootDir,DEFAULT_LOCAL_DIRECTORY);
}

function isWithin(parent,child){
  const pathFromParent=relative(parent,child);
  return pathFromParent===''||(!pathFromParent.startsWith(`..${sep}`)&&pathFromParent!=='..'&&!isAbsolute(pathFromParent));
}

function parseLocalDatabaseUrl(raw,rootDir){
  let databaseUrl;
  try{ databaseUrl=new URL(String(raw)); }
  catch(error){ refuse('LOCAL_DATABASE_REFUSED','Local database must be an absolute file URL.',error); }
  if(databaseUrl.protocol!=='file:'||databaseUrl.host||databaseUrl.username||databaseUrl.password
    ||databaseUrl.search||databaseUrl.hash){
    refuse('LOCAL_DATABASE_REFUSED','Local database must be a persistent loopback-only file target.');
  }
  let databasePath;
  try{ databasePath=resolve(fileURLToPath(databaseUrl)); }
  catch(error){ refuse('LOCAL_DATABASE_REFUSED','Local database file URL is invalid.',error); }
  const allowedDirectory=localDirectory(rootDir);
  if(dirname(databasePath)!==allowedDirectory){
    refuse('LOCAL_DATABASE_REFUSED',`Local database must be directly inside ${DEFAULT_LOCAL_DIRECTORY}/.`);
  }
  if(databasePath===resolve(allowedDirectory,DEFAULT_SECRET_NAME)
    ||databasePath===resolve(allowedDirectory,'runtime.lock')
    ||databasePath.endsWith('.jwt-secret')||databasePath.endsWith('.runtime-lock')){
    refuse('LOCAL_DATABASE_REFUSED','The local database target uses a reserved runtime filename.');
  }
  if(databasePath.endsWith(`${sep}:memory:`)||databasePath.includes('\0')){
    refuse('LOCAL_DATABASE_REFUSED','In-memory and invalid database targets are not allowed.');
  }
  return Object.freeze({databaseUrl:pathToFileURL(databasePath).href,databasePath,localDirectory:allowedDirectory});
}

function parsePort(value){
  const raw=String(value??'3000').trim();
  if(!/^\d+$/.test(raw)) refuse('LOCAL_PORT_INVALID','Local port must be an integer from 0 through 65535.');
  const port=Number(raw);
  if(!Number.isSafeInteger(port)||port<0||port>65535){
    refuse('LOCAL_PORT_INVALID','Local port must be an integer from 0 through 65535.');
  }
  return port;
}

export function resolveLocalServerConfig({env=process.env,rootDir=REPOSITORY_ROOT,argv=[]}={}){
  if(Array.isArray(argv)&&argv.length){
    refuse('LOCAL_DATABASE_REFUSED','The local server accepts configuration through the local environment profile only.');
  }
  const root=resolveRoot(rootDir);
  if(String(env.NODE_ENV||'').toLowerCase()==='production'||present(env.VERCEL)
    ||present(env.VERCEL_ENV)||present(env.VERCEL_URL)){
    refuse('LOCAL_PRODUCTION_REFUSED','The local development server cannot run in production or Vercel environments.');
  }
  if(present(env.TURSO_AUTH_TOKEN)){
    refuse('LOCAL_TOKEN_REFUSED','Remote database credentials are not accepted by the local development server.');
  }
  const host=String(env.RANDORI_LOCAL_HOST||'127.0.0.1').trim();
  if(!LOOPBACK_HOSTS.has(host)){
    refuse('LOCAL_HOST_REFUSED','The local development server may bind only to an explicit loopback address.');
  }
  const port=parsePort(env.RANDORI_LOCAL_PORT);
  const defaultUrl=pathToFileURL(resolve(localDirectory(root),DEFAULT_DATABASE_NAME)).href;
  const requestedUrl=env.RANDORI_LOCAL_DATABASE_URL||env.TURSO_DATABASE_URL||defaultUrl;
  const database=parseLocalDatabaseUrl(requestedUrl,root);
  if(present(env.TURSO_DATABASE_URL)){
    const supplied=parseLocalDatabaseUrl(env.TURSO_DATABASE_URL,root);
    if(supplied.databaseUrl!==database.databaseUrl){
      refuse('LOCAL_DATABASE_REFUSED','Conflicting local database targets are not allowed.');
    }
  }
  return Object.freeze({
    rootDir:root,
    host,
    port,
    databaseUrl:database.databaseUrl,
    databasePath:database.databasePath,
    localDirectory:database.localDirectory,
    secretPath:`${database.databasePath}.${DEFAULT_SECRET_NAME}`,
    lockPath:resolve(database.localDirectory,'runtime.lock'),
    bodyLimitBytes:MAX_BODY_BYTES,
  });
}

function ensurePrivateLocalDirectory(config){
  try{
    if(existsSync(config.localDirectory)){
      const metadata=lstatSync(config.localDirectory);
      if(metadata.isSymbolicLink()||!metadata.isDirectory()||(metadata.mode&0o077)!==0){
        refuse('LOCAL_DATABASE_REFUSED','The local data directory must be a real directory.');
      }
    }else{
      mkdirSync(config.localDirectory,{mode:0o700});
    }
    const canonical=realpathSync(config.localDirectory);
    if(canonical!==config.localDirectory){
      refuse('LOCAL_DATABASE_REFUSED','The local data directory cannot traverse links.');
    }
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    refuse('LOCAL_DATABASE_REFUSED','The local data directory is not safe or accessible.',error);
  }
}

function openGuardedDatabaseFile(config){
  ensurePrivateLocalDirectory(config);
  let descriptor;
  try{
    const noFollow=constants.O_NOFOLLOW||0;
    let created=false;
    try{
      descriptor=openSync(config.databasePath,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|noFollow,0o600);
      created=true;
    }catch(error){
      if(error?.code!=='EEXIST') throw error;
      const metadata=lstatSync(config.databasePath);
      if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.nlink!==1||(metadata.mode&0o077)!==0){
        refuse('LOCAL_DATABASE_REFUSED','The local database must be a regular file, not a link or special file.');
      }
      descriptor=openSync(config.databasePath,constants.O_RDWR|noFollow);
    }
    const guardMetadata=fstatSync(descriptor,{bigint:true});
    if(!guardMetadata.isFile()||guardMetadata.nlink!==1n||(guardMetadata.mode&0o77n)!==0n){
      refuse('LOCAL_DATABASE_REFUSED','The local database permissions are unsafe.');
    }
    const assertIdentity=()=>{
      const current=lstatSync(config.databasePath,{bigint:true});
      if(current.isSymbolicLink()||!current.isFile()
        ||current.dev!==guardMetadata.dev||current.ino!==guardMetadata.ino){
        refuse('LOCAL_DATABASE_REFUSED','The local database target changed while it was open.');
      }
    };
    assertIdentity();
    return Object.freeze({
      created,
      assertIdentity,
      close(){
        if(descriptor===undefined) return;
        const current=descriptor;
        descriptor=undefined;
        closeSync(current);
      },
    });
  }catch(error){
    if(descriptor!==undefined) closeSync(descriptor);
    if(error instanceof LocalServerError) throw error;
    refuse('LOCAL_DATABASE_REFUSED','The local database could not be opened safely.',error);
  }
}

function readLockOwner(path){
  let descriptor;
  try{
    descriptor=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const metadata=fstatSync(descriptor,{bigint:true});
    if(!metadata.isFile()||metadata.nlink!==1n||(metadata.mode&0o77n)!==0n||metadata.size>32n){
      refuse('LOCAL_DATABASE_REFUSED','The local runtime lock is unsafe.');
    }
    const raw=readFileSync(descriptor,'utf8').trim();
    if(!/^[1-9]\d*$/.test(raw)) refuse('LOCAL_DATABASE_REFUSED','The local runtime lock is invalid.');
    return {pid:Number(raw),metadata};
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    refuse('LOCAL_DATABASE_REFUSED','The local runtime lock could not be inspected.',error);
  }finally{
    if(descriptor!==undefined) closeSync(descriptor);
  }
}

function processIsRunning(pid){
  if(!Number.isSafeInteger(pid)||pid<1) return true;
  try{ process.kill(pid,0); return true; }
  catch(error){ return error?.code!=='ESRCH'; }
}

function acquireLocalRuntimeLock(config){
  if(activeLocalRuntimeLock){
    refuse('LOCAL_DATABASE_IN_USE','A local runtime is already active in this process.');
  }
  ensurePrivateLocalDirectory(config);
  for(let attempt=0;attempt<2;attempt+=1){
    let descriptor;
    let createdMetadata;
    try{
      descriptor=openSync(
        config.lockPath,
        constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),
        0o600,
      );
      createdMetadata=fstatSync(descriptor,{bigint:true});
      if(!createdMetadata.isFile()||createdMetadata.nlink!==1n||(createdMetadata.mode&0o77n)!==0n){
        refuse('LOCAL_DATABASE_REFUSED','The local runtime lock is unsafe.');
      }
      writeFileSync(descriptor,`${process.pid}\n`,{encoding:'utf8'});
      let released=false;
      const identity=Object.freeze({path:config.lockPath,dev:createdMetadata.dev,ino:createdMetadata.ino});
      activeLocalRuntimeLock=identity;
      return Object.freeze({
        release(){
          if(released) return;
          released=true;
          try{
            const current=lstatSync(config.lockPath,{bigint:true});
            if(!current.isSymbolicLink()&&current.isFile()
              &&current.dev===createdMetadata.dev&&current.ino===createdMetadata.ino) unlinkSync(config.lockPath);
          }catch(error){
            if(error?.code!=='ENOENT') throw error;
          }finally{
            closeSync(descriptor);
            if(activeLocalRuntimeLock===identity) activeLocalRuntimeLock=null;
          }
        },
      });
    }catch(error){
      if(descriptor!==undefined){
        try{
          const current=lstatSync(config.lockPath,{bigint:true});
          if(createdMetadata&&!current.isSymbolicLink()&&current.isFile()
            &&current.dev===createdMetadata.dev&&current.ino===createdMetadata.ino) unlinkSync(config.lockPath);
        }catch(cleanupError){
          if(cleanupError?.code!=='ENOENT'&&error?.code!=='EEXIST'){
            try{ closeSync(descriptor); }catch{}
            refuse('LOCAL_DATABASE_REFUSED','The local runtime lock could not be cleaned up safely.',cleanupError);
          }
        }
        try{ closeSync(descriptor); }catch{}
      }
      if(error instanceof LocalServerError) throw error;
      if(error?.code!=='EEXIST'){
        refuse('LOCAL_DATABASE_REFUSED','The local runtime lock could not be created.',error);
      }
      const owner=readLockOwner(config.lockPath);
      if(processIsRunning(owner.pid)){
        refuse('LOCAL_DATABASE_IN_USE','The local database is already in use.');
      }
      let current;
      try{ current=lstatSync(config.lockPath,{bigint:true}); }
      catch(lockError){
        if(lockError?.code==='ENOENT') continue;
        refuse('LOCAL_DATABASE_REFUSED','The local runtime lock changed unexpectedly.',lockError);
      }
      if(current.isSymbolicLink()||!current.isFile()
        ||current.dev!==owner.metadata.dev||current.ino!==owner.metadata.ino){
        refuse('LOCAL_DATABASE_REFUSED','The local runtime lock changed unexpectedly.');
      }
      unlinkSync(config.lockPath);
    }
  }
  refuse('LOCAL_DATABASE_IN_USE','The local database is already in use.');
}

export async function prepareLocalDatabase(config,{
  createDatabaseClient=createClient,
  prepare=prepareMigrationConnection,
  inspect=inspectMigrationState,
  apply=applyMigrations,
}={}){
  if(!config?.databaseUrl||!config?.databasePath){
    refuse('LOCAL_DATABASE_REFUSED','A resolved local server configuration is required.');
  }
  const guard=openGuardedDatabaseFile(config);
  let client;
  try{
    client=createDatabaseClient({url:config.databaseUrl});
    guard.assertIdentity();
    await prepare(client);
    const before=await inspect(client);
    guard.assertIdentity();
    if(before.classification==='unmanaged'){
      refuse('LOCAL_DATABASE_NOT_READY','The local database is unmanaged and will not be adopted automatically.');
    }
    const result=await apply(client,{expectedStateFingerprint:before.stateFingerprint});
    guard.assertIdentity();
    const state=await inspect(client);
    if(state.classification!=='managed'||!state.ready||state.currentVersion!==state.latestVersion){
      refuse('LOCAL_DATABASE_NOT_READY','The local database did not reach a schema-ready state.');
    }
    return Object.freeze({
      created:guard.created,
      currentVersion:state.currentVersion,
      latestVersion:state.latestVersion,
      stateFingerprint:state.stateFingerprint,
      appliedVersions:Object.freeze((result.applied||[]).map(item=>item.version)),
    });
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    const migration=publicMigrationError(error);
    throw new LocalServerError('LOCAL_DATABASE_NOT_READY',migration.message,{cause:error});
  }finally{
    let closeError;
    try{ await client?.close?.(); }catch(error){ closeError=error; }
    guard.close();
    if(closeError){
      throw new LocalServerError('LOCAL_DATABASE_NOT_READY','The local database connection did not close safely.',{cause:closeError});
    }
  }
}

export async function seedLocalOnboarding(config,{
  createDatabaseClient=createClient,
  hashPassword=(value,cost)=>bcrypt.hash(value,cost),
  comparePassword=(value,hash)=>bcrypt.compare(value,hash),
}={}){
  if(!config?.databaseUrl||!config?.databasePath||!config?.localDirectory
    ||dirname(config.databasePath)!==config.localDirectory
    ||!isWithin(config.localDirectory,config.databasePath)){
    refuse('LOCAL_DATABASE_REFUSED','A resolved isolated local database is required for development seeding.');
  }
  let parsed;
  try{ parsed=new URL(config.databaseUrl); }
  catch(error){ refuse('LOCAL_DATABASE_REFUSED','The local seed database URL is invalid.',error); }
  if(parsed.protocol!=='file:'||parsed.host||parsed.username||parsed.password||parsed.search||parsed.hash
    ||resolve(fileURLToPath(parsed))!==config.databasePath){
    refuse('LOCAL_DATABASE_REFUSED','Development seed data may be written only to the configured local file database.');
  }

  const client=createDatabaseClient({url:config.databaseUrl});
  try{
    await prepareMigrationConnection(client);
    const state=await inspectMigrationState(client);
    if(state.classification!=='managed'||!state.ready||state.currentVersion!==state.latestVersion){
      refuse('LOCAL_DATABASE_NOT_READY','The local database must be fully migrated before development seeding.');
    }
    const existing=await client.execute({
      sql:`SELECT id,password_hash FROM auth_accounts WHERE email=? LIMIT 1`,
      args:[LOCAL_OWNER_EMAIL],
    });
    let ownerId;
    let created=false;
    if(existing.rows?.length){
      ownerId=Number(existing.rows[0].id);
      const expectedPassword=await comparePassword(LOCAL_OWNER_PASSWORD,String(existing.rows[0].password_hash||''));
      if(!Number.isSafeInteger(ownerId)||ownerId<1||!expectedPassword){
        refuse('LOCAL_SEED_CONFLICT','The reserved local owner identity conflicts with existing data; use the scoped reset command.');
      }
      await client.execute({
        sql:`UPDATE auth_accounts SET is_admin=1,is_demo=0 WHERE id=?`,
        args:[ownerId],
      });
    }else{
      const passwordHash=await hashPassword(LOCAL_OWNER_PASSWORD,10);
      const inserted=await client.execute({
        sql:`INSERT INTO auth_accounts
          (email,password_hash,display_name,color,is_available,is_admin,is_demo,bio,tz,interview_focus)
          VALUES (?,?,?,?,1,1,0,'Local development owner','Europe/London','both')
          RETURNING id`,
        args:[LOCAL_OWNER_EMAIL,passwordHash,LOCAL_OWNER_NAME,LOCAL_OWNER_COLOR],
      });
      ownerId=Number(inserted.rows?.[0]?.id);
      created=true;
    }
    if(!Number.isSafeInteger(ownerId)||ownerId<1){
      refuse('LOCAL_DATABASE_NOT_READY','The deterministic local owner could not be prepared.');
    }
    const {initializePrimaryCircle}=await import('../api/_circle-membership.js');
    const {circleId}=await initializePrimaryCircle(client,{ownerUserId:ownerId,ownerEmails:[LOCAL_OWNER_EMAIL]});
    const verified=await client.execute({
      sql:`SELECT account.id,membership.role,membership.status,rollout.registrations_closed
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.user_id=account.id
        JOIN circles circle ON circle.id=membership.circle_id
        JOIN circle_membership_rollout rollout ON rollout.id=1
        WHERE account.id=? AND account.email=? AND account.is_admin=1 AND account.is_demo=0
          AND membership.circle_id=? AND membership.role='owner' AND membership.status='active'
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        LIMIT 1`,
      args:[ownerId,LOCAL_OWNER_EMAIL,circleId],
    });
    if(verified.rows?.length!==1||Number(verified.rows[0].registrations_closed)!==1){
      refuse('LOCAL_DATABASE_NOT_READY','The local owner and private circle seed could not be verified.');
    }
    return Object.freeze({created,ownerId,circleId,email:LOCAL_OWNER_EMAIL});
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    throw new LocalServerError('LOCAL_DATABASE_NOT_READY','The local onboarding seed could not be prepared.',{cause:error});
  }finally{
    try{ await client.close(); }
    catch(error){
      throw new LocalServerError('LOCAL_DATABASE_NOT_READY','The local seed database did not close safely.',{cause:error});
    }
  }
}

function localResetFile(path,localDirectory){
  if(!isWithin(localDirectory,path)){
    refuse('LOCAL_DATABASE_REFUSED','Local reset escaped the configured project data directory.');
  }
  let metadata;
  try{ metadata=lstatSync(path); }
  catch(error){
    if(error?.code==='ENOENT') return null;
    refuse('LOCAL_DATABASE_REFUSED','Local reset could not inspect a database file.',error);
  }
  if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.nlink!==1){
    refuse('LOCAL_DATABASE_REFUSED','Local reset encountered an unsafe database file.');
  }
  return Object.freeze({path,metadata});
}

export async function resetLocalDatabase(config,{
  confirmed=false,
  createDatabaseClient=createClient,
  prepare=prepareMigrationConnection,
  inspect=inspectMigrationState,
}={}){
  if(confirmed!==true){
    refuse('LOCAL_RESET_CONFIRMATION_REQUIRED','Local database reset requires explicit confirmation.');
  }
  if(!config?.databasePath||!config?.localDirectory||!isWithin(config.localDirectory,config.databasePath)){
    refuse('LOCAL_DATABASE_REFUSED','Local reset is limited to the configured project data directory.');
  }
  ensurePrivateLocalDirectory(config);
  try{
    const runtimeLock=acquireLocalRuntimeLock(config);
    try{
      const databaseFile=localResetFile(config.databasePath,config.localDirectory);
      if(!databaseFile){
        const staleFiles=[
          `${config.databasePath}-wal`,
          `${config.databasePath}-shm`,
          config.secretPath,
        ].map(path=>localResetFile(path,config.localDirectory)).filter(Boolean);
        for(const file of staleFiles) unlinkSync(file.path);
        return Object.freeze({ok:true,removed:staleFiles.length>0});
      }
      const guard=openGuardedDatabaseFile(config);
      let client;
      try{
        client=createDatabaseClient({url:config.databaseUrl});
        await prepare(client);
        const state=await inspect(client);
        guard.assertIdentity();
        if(state.classification!=='managed'||!state.ready||!state.ledgerPresent){
          refuse('LOCAL_DATABASE_NOT_READY','Only a managed local Randori database can be reset.');
        }
      }catch(error){
        guard.close();
        if(error instanceof LocalServerError) throw error;
        throw new LocalServerError('LOCAL_DATABASE_NOT_READY','The local database could not be verified for reset.',{cause:error});
      }finally{
        try{ await client?.close?.(); }
        catch(error){
          guard.close();
          throw new LocalServerError('LOCAL_DATABASE_NOT_READY','The local database connection did not close safely.',{cause:error});
        }
      }
      try{
        guard.assertIdentity();
        const resetFiles=[
          `${config.databasePath}-wal`,
          `${config.databasePath}-shm`,
          config.databasePath,
          config.secretPath,
        ].map(path=>localResetFile(path,config.localDirectory)).filter(Boolean);
        for(const file of resetFiles) unlinkSync(file.path);
        return Object.freeze({ok:true,removed:true});
      }finally{
        guard.close();
      }
    }finally{
      runtimeLock.release();
    }
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    throw new LocalServerError('LOCAL_DATABASE_REFUSED','The local reset lock could not be released safely.',{cause:error});
  }
}

function readOrCreateLocalSecret(config){
  ensurePrivateLocalDirectory(config);
  try{
    if(existsSync(config.secretPath)){
      const metadata=lstatSync(config.secretPath);
      if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.nlink!==1
        ||metadata.size>1024||(metadata.mode&0o077)!==0){
        refuse('LOCAL_DATABASE_REFUSED','The local session secret file is unsafe.');
      }
      const descriptor=openSync(config.secretPath,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      try{
        const opened=fstatSync(descriptor,{bigint:true});
        if(!opened.isFile()||opened.nlink!==1n||opened.dev!==BigInt(metadata.dev)||opened.ino!==BigInt(metadata.ino)
          ||(opened.mode&0o77n)!==0n||opened.size>1024n){
          refuse('LOCAL_DATABASE_REFUSED','The local session secret file changed or is unsafe.');
        }
        const secret=readFileSync(descriptor,'utf8').trim();
        if(secret.length<43) refuse('LOCAL_DATABASE_REFUSED','The local session secret is invalid.');
        return secret;
      }finally{
        closeSync(descriptor);
      }
    }
    const secret=randomBytes(48).toString('base64url');
    const descriptor=openSync(config.secretPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);
    try{ writeFileSync(descriptor,`${secret}\n`,{encoding:'utf8'}); }
    finally{ closeSync(descriptor); }
    return secret;
  }catch(error){
    if(error instanceof LocalServerError) throw error;
    refuse('LOCAL_DATABASE_REFUSED','The local session secret could not be prepared.',error);
  }
}

function queryObject(searchParams){
  const query={};
  for(const [key,value] of searchParams){
    const hasKey=Object.prototype.hasOwnProperty.call(query,key);
    const current=hasKey?query[key]:undefined;
    const next=!hasKey?value:Array.isArray(current)?[...current,value]:[current,value];
    Object.defineProperty(query,key,{value:next,writable:true,enumerable:true,configurable:true});
  }
  return query;
}

function apiRoute(pathname,query){
  const direct={
    '/api/auth':['auth',null],
    '/api/data':['data',null],
    '/api/invitations':['invitations','invitations'],
    '/api/members':['members',null],
    '/api/ops':['ops',null],
    '/api/ai':['ai',null],
    '/api/video':['video',null],
  };
  if(direct[pathname]){
    const [handler,endpoint]=direct[pathname];
    if(endpoint&&query.endpoint===undefined) query.endpoint=endpoint;
    return handler;
  }
  const authEndpoints=new Map([
    ['/api/auth/capabilities','capabilities'],['/api/auth/signup','signup'],['/api/auth/login','login'],
    ['/api/auth/activation/resend','activation-resend'],['/api/auth/activation/verify','activation-verify'],
    ['/api/auth/password-reset/request','password-reset-request'],
    ['/api/auth/password-reset/consume','password-reset-consume'],['/api/auth/recent-auth','recent-auth'],
    ['/api/auth/me','me'],['/api/auth/logout-all','logout-all'],['/api/auth/logout','logout'],
    ['/api/auth/google/start','google-start'],['/api/auth/google/reauth/start','google-reauth-start'],
    ['/api/auth/google/callback','google-callback'],
  ]);
  if(authEndpoints.has(pathname)){
    query.endpoint=authEndpoints.get(pathname);
    return 'auth';
  }
  if(pathname==='/api/invitations/prepare'){
    query.endpoint='prepare';
    return 'invitations';
  }
  const invitationMatch=pathname.match(/^\/api\/invitations\/([^/]+)$/);
  if(invitationMatch){
    query.endpoint='invitations';
    query.id=decodeURIComponent(invitationMatch[1]);
    return 'invitations';
  }
  const dataEndpoints=new Map([
    ['/api/circle','circle'],['/api/weeks','weeks'],['/api/history','history'],['/api/init','init'],
    ['/api/profile','profile'],['/api/my-pair','my-pair'],['/api/pair-recap','pair-recap'],
    ['/api/stats','stats'],['/api/schedule','schedule'],['/api/messages','messages'],
    ['/api/questions','questions'],['/api/runs','runs'],['/api/leetcode','leetcode'],
    ['/api/leetcode/sync','leetcode-sync'],['/api/execute','execute'],['/api/logs','logs'],
    ['/api/health','health'],['/api/health/live','health'],['/api/health/ready','health'],
    ['/api/healthz','health'],['/api/readyz','health'],
  ]);
  if(dataEndpoints.has(pathname)){
    query.endpoint=dataEndpoints.get(pathname);
    if(pathname==='/api/health/live'||pathname==='/api/healthz') query.probe='live';
    if(pathname==='/api/health/ready'||pathname==='/api/readyz') query.probe='ready';
    return 'data';
  }
  const opsEndpoints=new Map([
    ['/api/settings/availability','availability'],['/api/admin/reshuffle','reshuffle'],
    ['/api/pairing/run','pairing-run'],
    ['/api/cron/weekly','weekly'],['/api/admin/demo-seed','demo-seed'],
    ['/api/admin/demo-shuffle','demo-shuffle'],['/api/admin/demo-reset','demo-reset'],
    ['/api/notifications/prefs','notifications-prefs'],
  ]);
  if(opsEndpoints.has(pathname)){
    query.endpoint=opsEndpoints.get(pathname);
    return 'ops';
  }
  const aiMatch=pathname.match(/^\/api\/ai\/(analyze|history|feedback)(?:\/([^/]+))?$/);
  if(aiMatch){
    query.endpoint=aiMatch[1];
    if(aiMatch[2]!==undefined) query.id=decodeURIComponent(aiMatch[2]);
    return 'ai';
  }
  const videoMatch=pathname.match(/^\/api\/video\/(signal|ice|join|leave)$/);
  if(videoMatch){
    query.endpoint=videoMatch[1];
    return 'video';
  }
  return null;
}

async function loadDefaultRuntime(){
  const [auth,data,invitations,members,ops,ai,video,database]=await Promise.all([
    import('../api/auth.js'),import('../api/data.js'),import('../api/invitations.js'),import('../api/members.js'),
    import('../api/ops.js'),import('../api/ai.js'),import('../api/video.js'),import('../api/_db.js'),
  ]);
  return Object.freeze({
    handlers:Object.freeze({
      auth:auth.default,data:data.default,invitations:invitations.default,members:members.default,
      ops:ops.default,ai:ai.default,video:video.default,
    }),
    closeDatabase:database.closeLocalDevelopmentClient,
    installSqlObserver:database.installLocalDevelopmentSqlObserver,
  });
}

function sendJson(response,status,body){
  if(response.headersSent){
    if(!response.writableEnded) response.end();
    return;
  }
  response.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store',
    'x-content-type-options':'nosniff',
  });
  response.end(JSON.stringify(body));
}

function adaptResponse(response){
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  response.status=function status(code){
    const value=Number(code);
    this.statusCode=Number.isInteger(value)&&value>=100&&value<=599?value:500;
    return this;
  };
  response.json=function json(body){
    if(this.writableEnded) return this;
    this.setHeader('Content-Type','application/json; charset=utf-8');
    this.end(JSON.stringify(body));
    return this;
  };
  return response;
}

function readRequestBody(request,limitBytes){
  if(request.method==='GET'||request.method==='HEAD') return Promise.resolve({});
  const declared=Number(request.headers['content-length']);
  if(Number.isFinite(declared)&&declared>limitBytes){
    request.resume();
    return Promise.reject(new LocalServerError('LOCAL_BODY_TOO_LARGE','Request body exceeds the local server limit.'));
  }
  return new Promise((resolveBody,rejectBody)=>{
    const chunks=[];
    let length=0;
    let settled=false;
    request.on('data',chunk=>{
      if(settled) return;
      length+=chunk.length;
      if(length>limitBytes){
        settled=true;
        request.resume();
        rejectBody(new LocalServerError('LOCAL_BODY_TOO_LARGE','Request body exceeds the local server limit.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end',()=>{
      if(settled) return;
      settled=true;
      if(!chunks.length){ resolveBody({}); return; }
      const contentType=String(request.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(contentType!=='application/json'){
        rejectBody(new LocalServerError('LOCAL_BODY_INVALID','Local API request bodies must be JSON.'));
        return;
      }
      try{
        const body=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
        if(body===null||typeof body!=='object'||Array.isArray(body)){
          rejectBody(new LocalServerError('LOCAL_BODY_INVALID','Local API JSON must be an object.'));
          return;
        }
        resolveBody(body);
      }catch(error){
        rejectBody(new LocalServerError('LOCAL_BODY_INVALID','Local API request body is invalid JSON.',{cause:error}));
      }
    });
    request.on('error',error=>{
      if(settled) return;
      settled=true;
      rejectBody(new LocalServerError('LOCAL_BODY_INVALID','Local API request body could not be read.',{cause:error}));
    });
  });
}

function normalizeHostname(hostHeader){
  try{ return new URL(`http://${String(hostHeader||'')}`).hostname.replace(/^\[|\]$/g,''); }
  catch{ return ''; }
}

function isLoopbackAddress(value){
  const address=String(value||'').toLowerCase();
  return address==='::1'||address==='127.0.0.1'||address==='::ffff:127.0.0.1';
}

function requestIsLoopback(request){
  const hostname=normalizeHostname(request.headers.host);
  return (hostname==='localhost'||LOOPBACK_HOSTS.has(hostname))&&isLoopbackAddress(request.socket?.remoteAddress);
}

function requestUsesAdvertisedHost(request,advertisedUrl){
  try{
    const requestHost=String(request.headers.host||'').trim().toLowerCase();
    const advertisedHost=new URL(advertisedUrl).host.toLowerCase();
    return requestHost!==''&&requestHost===advertisedHost;
  }catch{
    return false;
  }
}

function unsafeEncodedPath(pathname){
  const raw=String(pathname||'');
  if(/%25|%00|%2f|%5c/i.test(raw)) return true;
  let decoded;
  try{ decoded=decodeURIComponent(raw); }catch{ return true; }
  return decoded.includes('\0')||decoded.includes('\\')
    ||decoded.split('/').some(part=>part==='.'||part==='..'||part.startsWith('.'));
}

function navigationPath(pathname){
  return pathname==='/'||pathname==='/invite'||pathname==='/verify'||pathname==='/reset-password'
    ||/^\/join\/[^/]+$/.test(pathname);
}

function assetPath(pathname,rootDir){
  if(unsafeEncodedPath(pathname)) return null;
  let decoded;
  try{ decoded=decodeURIComponent(pathname); }catch{ return null; }
  const relativePath=decoded.replace(/^\/+/, '');
  const first=relativePath.split('/')[0];
  const basename=relativePath.split('/').at(-1)||'';
  const extension=extname(relativePath).toLowerCase();
  if(!BROWSER_ASSET_DIRECTORIES.includes(first)||!MIME_TYPES[extension]
    ||/^package(?:-lock)?\.json$/i.test(basename)) return null;
  const resolved=resolve(rootDir,relativePath);
  if(!isWithin(rootDir,resolved)) return null;
  try{
    const assetRoot=resolve(rootDir,first);
    const metadata=lstatSync(resolved);
    if(metadata.isSymbolicLink()||!metadata.isFile()||realpathSync(resolved)!==resolved
      ||!isWithin(assetRoot,resolved)) return null;
    return resolved;
  }catch{
    return null;
  }
}

function serveFile(response,file,contentType,allowedRoot){
  try{
    const metadata=lstatSync(file);
    if(metadata.isSymbolicLink()||!metadata.isFile()||realpathSync(file)!==file
      ||!isWithin(allowedRoot,file)) throw new Error('unsafe file');
    response.writeHead(200,{
      'content-type':contentType,
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      'x-frame-options':'DENY',
      'referrer-policy':'no-referrer',
      'content-security-policy':LOCAL_CONTENT_SECURITY_POLICY,
      'permissions-policy':'camera=(self), microphone=(self), geolocation=()',
    });
    if(response.req?.method==='HEAD'){ response.end(); return; }
    const stream=createReadStream(file);
    stream.on('error',()=>{ if(!response.writableEnded) response.end(); });
    stream.pipe(response);
  }catch{
    response.writeHead(404,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'});
    response.end('Not found');
  }
}

function serveLocalIndex(response,file,allowedRoot){
  try{
    const metadata=lstatSync(file);
    if(metadata.isSymbolicLink()||!metadata.isFile()||realpathSync(file)!==file
      ||!isWithin(allowedRoot,file)) throw new Error('unsafe file');
    let document=readFileSync(file,'utf8');
    for(const tag of LOCAL_EXTERNAL_ASSET_TAGS) document=document.replaceAll(tag,'');
    document=document.replace('<head>',`<head>\n${LOCAL_RUNTIME_MARKER}`);
    response.writeHead(200,{
      'content-type':'text/html; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      'x-frame-options':'DENY',
      'referrer-policy':'no-referrer',
      'content-security-policy':LOCAL_CONTENT_SECURITY_POLICY,
      'permissions-policy':'camera=(self), microphone=(self), geolocation=()',
    });
    response.end(response.req?.method==='HEAD'?'':document);
  }catch{
    response.writeHead(404,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'});
    response.end('Not found');
  }
}

function safeLogger(logger){
  if(typeof logger==='function') return {log:logger,error:logger};
  return {
    log:typeof logger?.log==='function'?logger.log.bind(logger):()=>{},
    error:typeof logger?.error==='function'?logger.error.bind(logger):()=>{},
  };
}

function installRuntimeEnvironment(config,url,secret,envTarget=process.env){
  const values={
    NODE_ENV:'development',
    TURSO_DATABASE_URL:config.databaseUrl,
    RANDORI_LOCAL_DATABASE_PATH:config.databasePath,
    TURSO_AUTH_TOKEN:'',
    JWT_SECRET:secret,
    RUN_ATTESTATION_SECRET:'',
    RUN_ATTESTATION_PREVIOUS_SECRETS:'',
    APP_URL:url,
    ALLOW_OPEN_SIGNUP:'false',
    CIRCLE_MEMBERSHIP_ENABLED:'true',
    AUTH_SCHEMA_BOOTSTRAP_ENABLED:'false',
    PASSWORD_RESET_ENABLED:'true',
    RANDORI_LOCAL_RUNTIME:'true',
    RANDORI_LOCAL_IDENTITY:'true',
    RANDORI_LOCAL_FIRST_USER_ADMIN:'false',
    LEETCODE_INGESTION_AUTHORIZED:'false',
    GOOGLE_CLIENT_ID:'',
    GOOGLE_CLIENT_SECRET:'',
    RESEND_API_KEY:'',
    RESEND_FROM:'',
    AI_ENABLED:'false',
    GROQ_API_KEY:'',
    OPENAI_API_KEY:'',
    SENTRY_DSN:'',
    NEXT_PUBLIC_SENTRY_DSN:'',
    TWILIO_AUTH_TOKEN:'',
    ADMIN_EMAILS:'',
    SIGNUP_ALLOWLIST:'',
    CRON_SECRET:'',
  };
  const targets=[...new Set([process.env,envTarget])];
  const prior=targets.map(target=>({
    target,
    values:new Map(Object.keys(values).map(key=>[
      key,
      Object.prototype.hasOwnProperty.call(target,key)?target[key]:undefined,
    ])),
  }));
  for(const target of targets){
    for(const [key,value] of Object.entries(values)) target[key]=value;
  }
  return ()=>{
    for(const entry of prior){
      for(const [key,value] of entry.values){
        if(value===undefined) delete entry.target[key];
        else entry.target[key]=value;
      }
    }
  };
}

export async function createLocalDevelopmentServer({
  config,
  handlers,
  sqlObserver,
  logger=console,
  envTarget=process.env,
}={}){
  if(!config) config=resolveLocalServerConfig();
  const log=safeLogger(logger);
  const runtimeLock=acquireLocalRuntimeLock(config);
  let database;
  let onboarding;
  let secret;
  try{
    database=await prepareLocalDatabase(config);
    secret=readOrCreateLocalSecret(config);
  }catch(error){
    runtimeLock.release();
    throw error;
  }
  let runtimeHandlers=null;
  let closeRequestDatabase=async()=>{};
  let restoreSqlObserver=()=>{};
  let restoreEnvironment=()=>{};
  let started=false;
  let closed=false;
  let url=null;
  const sockets=new Set();

  const handleRequest=async(request,response)=>{
    if(!requestIsLoopback(request)||!requestUsesAdvertisedHost(request,url)){
      sendJson(response,403,{ok:false,error:'LOCAL_HOST_REFUSED'});
      return;
    }
    let parsedUrl;
    try{ parsedUrl=new URL(request.url||'/','http://localhost'); }
    catch{ sendJson(response,400,{ok:false,error:'LOCAL_API_NOT_FOUND'}); return; }
    if(parsedUrl.pathname.startsWith('/api/')){
      const query=queryObject(parsedUrl.searchParams);
      let handlerName;
      try{ handlerName=apiRoute(parsedUrl.pathname,query); }
      catch{ sendJson(response,400,{ok:false,error:'LOCAL_API_NOT_FOUND'}); return; }
      if(!handlerName){
        sendJson(response,404,{ok:false,error:'LOCAL_API_NOT_FOUND'});
        return;
      }
      try{
        request.query=query;
        request.body=await readRequestBody(request,config.bodyLimitBytes);
        request.url=parsedUrl.pathname+parsedUrl.search;
        await runtimeHandlers[handlerName](request,adaptResponse(response));
        if(!response.writableEnded&&!response.headersSent){
          sendJson(response,500,{ok:false,error:'LOCAL_INTERNAL_ERROR'});
        }
      }catch(error){
        if(error instanceof LocalServerError){
          const status=error.code==='LOCAL_BODY_TOO_LARGE'?413:400;
          sendJson(response,status,{ok:false,error:error.code});
        }else{
          log.error(JSON.stringify({ok:false,event:'local-api-error',error:'LOCAL_INTERNAL_ERROR'}));
          sendJson(response,500,{ok:false,error:'LOCAL_INTERNAL_ERROR'});
        }
      }
      return;
    }
    if(request.method!=='GET'&&request.method!=='HEAD'){
      response.writeHead(405,{'content-type':'text/plain; charset=utf-8','allow':'GET, HEAD'}).end('Method not allowed');
      return;
    }
    if(unsafeEncodedPath(parsedUrl.pathname)){
      response.writeHead(403,{'content-type':'text/plain; charset=utf-8'}).end('Forbidden');
      return;
    }
    if(navigationPath(parsedUrl.pathname)){
      serveLocalIndex(response,resolve(config.rootDir,'index.html'),config.rootDir);
      return;
    }
    const file=assetPath(parsedUrl.pathname,config.rootDir);
    if(!file){
      response.writeHead(404,{'content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'}).end('Not found');
      return;
    }
    serveFile(response,file,MIME_TYPES[extname(file).toLowerCase()],config.rootDir);
  };
  const notReadyHandler=(_request,response)=>{
    sendJson(response,503,{ok:false,error:'LOCAL_DATABASE_NOT_READY'});
  };
  const server=createServer(notReadyHandler);
  server.on('connection',socket=>{
    sockets.add(socket);
    socket.once('close',()=>sockets.delete(socket));
  });

  const start=async()=>{
    if(closed) throw new LocalServerError('LOCAL_INTERNAL_ERROR','A closed local server cannot be restarted.');
    if(started) return lifecycle;
    try{
      await new Promise((resolveListen,rejectListen)=>{
        const onError=error=>{ server.off('listening',onListening); rejectListen(error); };
        const onListening=()=>{ server.off('error',onError); resolveListen(); };
        server.once('error',onError);
        server.once('listening',onListening);
        server.listen(config.port,config.host);
      });
      const address=server.address();
      const displayHost=config.host==='::1'?'[::1]':config.host;
      url=`http://${displayHost}:${address.port}`;
      restoreEnvironment=installRuntimeEnvironment(config,url,secret,envTarget);
      onboarding=await seedLocalOnboarding(config);
      const defaultRuntime=await loadDefaultRuntime();
      closeRequestDatabase=defaultRuntime.closeDatabase;
      restoreSqlObserver=defaultRuntime.installSqlObserver(sqlObserver);
      runtimeHandlers={...defaultRuntime.handlers,...(handlers||{})};
      for(const name of ['auth','data','invitations','ops','ai','video']){
        if(typeof runtimeHandlers[name]!=='function'){
          throw new LocalServerError('LOCAL_INTERNAL_ERROR',`Missing local API handler: ${name}`);
        }
      }
      server.off('request',notReadyHandler);
      server.on('request',handleRequest);
    }catch(error){
      if(server.listening) await new Promise(resolveClose=>server.close(()=>resolveClose()));
      let failure=error;
      try{ await closeRequestDatabase(); }
      catch(closeError){
        failure=new LocalServerError('LOCAL_INTERNAL_ERROR','The local API database did not close safely.',{cause:closeError});
      }finally{
        restoreSqlObserver();
        restoreSqlObserver=()=>{};
        restoreEnvironment();
        restoreEnvironment=()=>{};
        runtimeLock.release();
      }
      closed=true;
      throw failure;
    }
    started=true;
    log.log(JSON.stringify({
      ok:true,
      event:'local-server-ready',
      url,
      database:{kind:'local-file',created:database.created,currentVersion:database.currentVersion},
      onboarding:{mode:'invite-bound-local-identity',ownerEmail:onboarding.email,ownerPassword:LOCAL_OWNER_PASSWORD},
    }));
    return lifecycle;
  };

  const close=async()=>{
    if(closed) return;
    closed=true;
    try{
      if(server.listening){
        await new Promise(resolveClose=>{
          let timer;
          server.close(()=>{
            if(timer) clearTimeout(timer);
            resolveClose();
          });
          server.closeIdleConnections?.();
          timer=setTimeout(()=>{
            for(const socket of sockets) socket.destroy();
          },5000);
          timer.unref?.();
        });
      }
    }finally{
      try{ await closeRequestDatabase(); }
      finally{
        restoreSqlObserver();
        restoreEnvironment();
        runtimeLock.release();
      }
    }
  };

  const lifecycle={server,config,database,start,close,get url(){ return url; }};
  return lifecycle;
}

export async function startLocalDevelopmentServer({
  config,
  env=process.env,
  rootDir=REPOSITORY_ROOT,
  argv=process.argv.slice(2),
  logger=console,
  handlers,
  sqlObserver,
  envTarget=process.env,
}={}){
  const resolvedConfig=config||resolveLocalServerConfig({env,rootDir,argv});
  const lifecycle=await createLocalDevelopmentServer({config:resolvedConfig,logger,handlers,sqlObserver,envTarget});
  await lifecycle.start();
  return lifecycle;
}

function publicStartupError(error){
  const known=error instanceof LocalServerError&&/^LOCAL_[A-Z_]+$/.test(error.code);
  return {ok:false,event:'local-server-startup',error:known?error.code:'LOCAL_INTERNAL_ERROR'};
}

async function run(){
  let lifecycle;
  let stopping=false;
  const stop=async()=>{
    if(stopping) return;
    stopping=true;
    try{ await lifecycle?.close?.(); }
    finally{ process.exitCode=0; }
  };
  try{
    lifecycle=await startLocalDevelopmentServer();
    process.once('SIGINT',stop);
    process.once('SIGTERM',stop);
  }catch(error){
    process.stderr.write(`${JSON.stringify(publicStartupError(error))}\n`);
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) await run();
