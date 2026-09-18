import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  chmodSync,
  existsSync,
  linkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import { LATEST_MIGRATION_VERSION } from '../../db/executable-migrations.js';
import {
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import {
  createLocalDevelopmentServer,
  prepareLocalDatabase,
  resetLocalDatabase,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const REPOSITORY_ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SILENT_LOGGER=Object.freeze({log(){},error(){}});
const cleanup=[];

function temporaryDirectory(prefix='randori-local-server-'){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),prefix)));
  mkdirSync(join(directory,'.local'),{mode:0o700});
  writeFileSync(join(directory,'index.html'),readFileSync(join(REPOSITORY_ROOT,'index.html')));
  cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  return directory;
}

function localEnvironment(databaseUrl,overrides={}){
  return {
    NODE_ENV:'development',
    RANDORI_LOCAL_HOST:'127.0.0.1',
    RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
    ...overrides,
  };
}

function localConfig(directory,overrides={}){
  const databasePath=join(directory,'.local','randori.sqlite');
  const databaseUrl=pathToFileURL(databasePath).href;
  return {
    databasePath,
    databaseUrl,
    config:resolveLocalServerConfig({
      rootDir:directory,
      argv:[],
      env:localEnvironment(databaseUrl,overrides),
    }),
  };
}

async function closeRuntime(runtime){
  if(!runtime) return;
  await runtime.close();
}

function registerRuntime(runtime){
  cleanup.push(()=>closeRuntime(runtime));
  return runtime;
}

async function jsonResponse(response){
  const text=await response.text();
  return {text,body:text?JSON.parse(text):null};
}

function cookiePair(response){
  const setCookie=response.headers.get('set-cookie');
  assert.ok(setCookie,'response must set the session cookie');
  return setCookie.split(';',1)[0];
}

function requestRaw(baseUrl,{path='/',method='GET',headers={},body=''}={}){
  const target=new URL(baseUrl);
  return new Promise((resolve,reject)=>{
    const request=httpRequest({
      hostname:target.hostname,
      port:target.port,
      method,
      path,
      headers,
    },response=>{
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({
        status:response.statusCode,
        headers:response.headers,
        body:Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error',reject);
    if(body) request.write(body);
    request.end();
  });
}

function assertConfigError(options,code){
  const {rootDir=REPOSITORY_ROOT,...rest}=options;
  assert.throws(
    ()=>resolveLocalServerConfig({rootDir,argv:[],...rest}),
    error=>error?.code===code,
  );
}

afterEach(async()=>{
  while(cleanup.length){
    const dispose=cleanup.pop();
    try{ await dispose(); }catch{}
  }
});

test('configuration accepts only an explicit loopback, non-production, local-file profile',()=>{
  const directory=temporaryDirectory();
  const databaseUrl=pathToFileURL(join(directory,'.local','local.sqlite')).href;
  const base=localEnvironment(databaseUrl);

  for(const host of ['0.0.0.0','localhost','192.168.1.5','example.test']){
    assertConfigError({rootDir:directory,env:{...base,RANDORI_LOCAL_HOST:host}},'LOCAL_HOST_REFUSED');
  }
  for(const env of [
    {...base,NODE_ENV:'production'},
    {...base,VERCEL:'1'},
    {...base,VERCEL_ENV:'preview'},
    {...base,VERCEL_URL:'randori-preview.example.test'},
  ]){
    assertConfigError({rootDir:directory,env},'LOCAL_PRODUCTION_REFUSED');
  }
  for(const remote of ['libsql://private.example.test','https://private.example.test']){
    assertConfigError({rootDir:directory,env:{...base,TURSO_DATABASE_URL:remote}},'LOCAL_DATABASE_REFUSED');
  }
  assertConfigError({rootDir:directory,env:{...base,TURSO_AUTH_TOKEN:'must-not-be-used'}},'LOCAL_TOKEN_REFUSED');
  for(const invalidPort of ['-1','65536','3.14','not-a-port']){
    assertConfigError({rootDir:directory,env:{...base,RANDORI_LOCAL_PORT:invalidPort}},'LOCAL_PORT_INVALID');
  }
  for(const invalidDatabase of [
    'file::memory:',
    'file:relative.sqlite',
    'libsql://private.example.test',
    `${databaseUrl}?mode=rw`,
  ]){
    assertConfigError({rootDir:directory,env:{...base,RANDORI_LOCAL_DATABASE_URL:invalidDatabase}},'LOCAL_DATABASE_REFUSED');
  }
  assertConfigError({
    rootDir:directory,
    env:{...base,RANDORI_LOCAL_DATABASE_URL:pathToFileURL(join(directory,'.local','jwt-secret')).href},
  },'LOCAL_DATABASE_REFUSED');

  const ipv4=resolveLocalServerConfig({rootDir:directory,argv:[],env:base});
  const ipv6=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:{...base,RANDORI_LOCAL_HOST:'::1'},
  });
  assert.equal(ipv4.host,'127.0.0.1');
  assert.equal(ipv4.port,0);
  assert.equal(ipv6.host,'::1');
  const cleanCheckout=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:{NODE_ENV:'development',RANDORI_LOCAL_PORT:'0'},
  });
  assert.equal(cleanCheckout.databasePath,join(directory,'.local','randori.db'));
  const ambientProviderProfile=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:{
      ...base,
      GOOGLE_CLIENT_SECRET:'ambient-google-secret',
      OPENAI_API_KEY:'ambient-openai-key',
      RUN_ATTESTATION_SECRET:'ambient-attestation-secret',
    },
  });
  assert.equal(ambientProviderProfile.databasePath,join(directory,'.local','local.sqlite'));
});

test('executable startup emits one redacted JSON failure for forbidden ambient credentials',()=>{
  const env={...process.env};
  for(const key of ['VERCEL','VERCEL_ENV']) delete env[key];
  Object.assign(env,{
    NODE_ENV:'development',
    TURSO_DATABASE_URL:'libsql://private-database.example.test',
    TURSO_AUTH_TOKEN:'super-secret-production-token',
  });
  const result=spawnSync(process.execPath,['scripts/local-server.mjs'],{
    cwd:REPOSITORY_ROOT,
    env,
    encoding:'utf8',
    timeout:5000,
  });
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.signal,null);
  assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{
    ok:false,
    event:'local-server-startup',
    error:'LOCAL_TOKEN_REFUSED',
  });
  assert.equal(result.stderr.trim().split('\n').length,1);
  assert.doesNotMatch(result.stderr,/super-secret|private-database|libsql/i);
});

test('database preparation migrates before serving and rejects unmanaged state',async()=>{
  const directory=temporaryDirectory();
  const {config,databaseUrl,databasePath}=localConfig(directory);
  await prepareLocalDatabase(config);

  const db=createClient({url:databaseUrl});
  cleanup.push(()=>db.close());
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  assert.equal(state.classification,'managed');
  assert.equal(state.currentVersion,LATEST_MIGRATION_VERSION);
  assert.equal(state.ready,true);
  const ledger=await db.execute('SELECT version,disposition FROM schema_migrations ORDER BY version');
  assert.deepEqual(
    ledger.rows.map(row=>[Number(row.version),String(row.disposition)]),
    [[1,'applied'],[2,'applied']],
  );
  await db.close();
  cleanup.pop();

  const unmanagedPath=join(directory,'.local','unmanaged.sqlite');
  const unmanagedUrl=pathToFileURL(unmanagedPath).href;
  const unmanaged=createClient({url:unmanagedUrl});
  await unmanaged.execute('CREATE TABLE private_rogue_state (secret TEXT)');
  await unmanaged.close();
  chmodSync(unmanagedPath,0o600);
  const unmanagedConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(unmanagedUrl),
  });
  await assert.rejects(
    prepareLocalDatabase(unmanagedConfig),
    error=>{
      assert.equal(error?.code,'LOCAL_DATABASE_NOT_READY');
      assert.doesNotMatch(String(error?.message),new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
      assert.doesNotMatch(String(error?.message),/private_rogue_state|secret/i);
      return true;
    },
  );

  const existingPath=join(directory,'.local','existing.sqlite');
  const linkPath=join(directory,'.local','linked.sqlite');
  writeFileSync(existingPath,'');
  symlinkSync(existingPath,linkPath);
  const linkedConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(pathToFileURL(linkPath).href),
  });
  await assert.rejects(
    prepareLocalDatabase(linkedConfig),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );

  writeFileSync(config.secretPath,'x'.repeat(64),{mode:0o644});
  chmodSync(config.secretPath,0o644);
  await assert.rejects(
    startLocalDevelopmentServer({config,logger:SILENT_LOGGER}),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
});

test('database path guards reject dangling links, nested link escapes, and permissive local directories',async()=>{
  const directory=temporaryDirectory();
  const localPath=join(directory,'.local');

  const danglingPath=join(localPath,'dangling.sqlite');
  const danglingTarget=join(localPath,'missing.sqlite');
  symlinkSync(danglingTarget,danglingPath);
  const danglingConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(pathToFileURL(danglingPath).href),
  });
  await assert.rejects(
    prepareLocalDatabase(danglingConfig),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(danglingTarget),false);

  const outside=join(directory,'outside');
  mkdirSync(outside,{mode:0o700});
  const nestedLink=join(localPath,'nested-link');
  symlinkSync(outside,nestedLink);
  assertConfigError({
    rootDir:directory,
    env:localEnvironment(pathToFileURL(join(nestedLink,'escaped.sqlite')).href),
  },'LOCAL_DATABASE_REFUSED');
  assert.equal(existsSync(join(outside,'escaped.sqlite')),false);

  const hardSource=join(localPath,'hard-source.sqlite');
  const hardDatabase=join(localPath,'hard-database.sqlite');
  writeFileSync(hardSource,'',{mode:0o600});
  chmodSync(hardSource,0o600);
  linkSync(hardSource,hardDatabase);
  const hardConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(pathToFileURL(hardDatabase).href),
  });
  await assert.rejects(
    prepareLocalDatabase(hardConfig),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(hardSource),true);

  const {config,databasePath}=localConfig(directory);
  chmodSync(localPath,0o755);
  await assert.rejects(
    prepareLocalDatabase(config),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(databasePath),false);
  chmodSync(localPath,0o700);

  const secretDirectory=temporaryDirectory();
  const {config:secretConfig}=localConfig(secretDirectory);
  await prepareLocalDatabase(secretConfig);
  const hardSecretSource=join(secretDirectory,'.local','shared-secret-source');
  writeFileSync(hardSecretSource,'h'.repeat(64),{mode:0o600});
  chmodSync(hardSecretSource,0o600);
  linkSync(hardSecretSource,secretConfig.secretPath);
  await assert.rejects(
    startLocalDevelopmentServer({config:secretConfig,logger:SILENT_LOGGER}),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(hardSecretSource),true);
});

test('reset requires confirmation, removes only verified local state, and refuses unsafe targets',async()=>{
  const directory=temporaryDirectory();
  const {config,databasePath,databaseUrl}=localConfig(directory);
  const sentinel=join(directory,'.local','keep-me.txt');
  writeFileSync(sentinel,'not part of Randori local state');

  await assert.rejects(
    resetLocalDatabase(config),
    error=>error?.code==='LOCAL_RESET_CONFIRMATION_REQUIRED',
  );
  assert.equal(existsSync(databasePath),false);

  const runtime=await startLocalDevelopmentServer({config,logger:SILENT_LOGGER});
  await assert.rejects(
    resetLocalDatabase(config,{confirmed:true}),
    error=>error?.code==='LOCAL_DATABASE_IN_USE',
  );
  assert.equal(existsSync(databasePath),true);
  await runtime.close();
  assert.equal(existsSync(databasePath),true);
  assert.equal(existsSync(config.secretPath),true);
  const reset=await resetLocalDatabase(config,{confirmed:true});
  assert.deepEqual(reset,{ok:true,removed:true});
  assert.equal(existsSync(databasePath),false);
  assert.equal(existsSync(config.secretPath),false);
  assert.equal(existsSync(sentinel),true);
  assert.deepEqual(await resetLocalDatabase(config,{confirmed:true}),{ok:true,removed:false});

  const unmanaged=createClient({url:databaseUrl});
  await unmanaged.execute('CREATE TABLE rogue_local_state (id INTEGER PRIMARY KEY)');
  await unmanaged.close();
  chmodSync(databasePath,0o600);
  await assert.rejects(
    resetLocalDatabase(config,{confirmed:true}),
    error=>error?.code==='LOCAL_DATABASE_NOT_READY',
  );
  assert.equal(existsSync(databasePath),true);

  const linkPath=join(directory,'.local','reset-link.sqlite');
  symlinkSync(databasePath,linkPath);
  const linkedConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(pathToFileURL(linkPath).href),
  });
  await assert.rejects(
    resetLocalDatabase(linkedConfig,{confirmed:true}),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(databasePath),true);
});

test('reset preflights every sidecar and secret before deleting any local state',async()=>{
  const directory=temporaryDirectory();
  const {config,databasePath}=localConfig(directory);
  await prepareLocalDatabase(config);
  writeFileSync(config.secretPath,'s'.repeat(64),{mode:0o600});
  chmodSync(config.secretPath,0o600);
  const external=join(directory,'external-sentinel');
  writeFileSync(external,'must survive');
  const managedState=async()=>({classification:'managed',ready:true,ledgerPresent:true});
  const clientFactory=()=>({close(){}});
  const resetOptions={
    confirmed:true,
    createDatabaseClient:clientFactory,
    prepare:async()=>{},
    inspect:managedState,
  };

  await assert.rejects(
    resetLocalDatabase(config,{
      ...resetOptions,
      createDatabaseClient:()=>({close(){ throw new Error('forced close failure with secret detail'); }}),
    }),
    error=>error?.code==='LOCAL_DATABASE_NOT_READY',
  );
  assert.equal(existsSync(databasePath),true);
  assert.equal(existsSync(config.secretPath),true);

  const walPath=`${databasePath}-wal`;
  const shmPath=`${databasePath}-shm`;
  writeFileSync(walPath,'keep this sidecar',{mode:0o600});
  symlinkSync(external,shmPath);
  await assert.rejects(
    resetLocalDatabase(config,resetOptions),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(databasePath),true);
  assert.equal(existsSync(walPath),true,'an earlier sidecar must not be deleted before full preflight');
  assert.equal(existsSync(shmPath),true);
  assert.equal(existsSync(config.secretPath),true);

  rmSync(walPath,{force:true});
  rmSync(shmPath,{force:true});
  rmSync(config.secretPath,{force:true});
  symlinkSync(external,config.secretPath);
  await assert.rejects(
    resetLocalDatabase(config,resetOptions),
    error=>error?.code==='LOCAL_DATABASE_REFUSED',
  );
  assert.equal(existsSync(databasePath),true,'database must survive an unsafe later reset target');
  assert.equal(existsSync(config.secretPath),true);
  assert.equal(existsSync(external),true);
});

test('the real auth handler signs up locally and persists the account and session across restart',async()=>{
  const directory=temporaryDirectory();
  const {config,databaseUrl}=localConfig(directory);
  const first=registerRuntime(await startLocalDevelopmentServer({config,logger:SILENT_LOGGER}));

  const index=await fetch(first.url);
  assert.equal(index.status,200);
  assert.match(index.headers.get('content-type')||'',/^text\/html/);
  assert.match(await index.text(),/<title>Randori Circle<\/title>/);

  const capabilities=await fetch(new URL('/api/auth/capabilities',first.url));
  assert.equal(capabilities.status,200);
  assert.equal(capabilities.headers.get('cache-control'),'no-store');
  assert.deepEqual(await capabilities.json(),{
    ok:true,
    capabilities:{passwordLogin:true,passwordSignup:true,googleOAuth:false},
    registrationMode:'local_open',
  });

  const health=await fetch(new URL('/api/health',first.url));
  assert.equal(health.status,200);
  assert.equal((await health.json()).ok,true);
  const {getClient}=await import('../../api/_db.js');
  const firstSharedClient=getClient();
  assert.equal(getClient(),firstSharedClient,'local requests must reuse one database client');

  const signup=await fetch(new URL('/api/auth/signup',first.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:first.url},
    body:JSON.stringify({
      email:'LOCAL.User@example.test',
      password:'correct horse battery',
      name:'Local User',
    }),
  });
  const signupPayload=await jsonResponse(signup);
  assert.equal(signup.status,200,signupPayload.text);
  assert.equal(signupPayload.body.ok,true);
  assert.equal(signupPayload.body.user.email,'local.user@example.test');
  assert.equal(signupPayload.body.user.is_admin,true);
  assert.equal('token' in signupPayload.body,false);
  const sessionCookie=cookiePair(signup);

  const secondSignup=await fetch(new URL('/api/auth/signup',first.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:first.url},
    body:JSON.stringify({
      email:'second.local@example.test',
      password:'another correct horse battery',
      name:'Second Local',
    }),
  });
  const secondPayload=await jsonResponse(secondSignup);
  assert.equal(secondSignup.status,200,secondPayload.text);
  assert.equal(secondPayload.body.user.is_admin,false);

  const reshuffle=await fetch(new URL('/api/admin/reshuffle',first.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:first.url,cookie:sessionCookie},
    body:'{}',
  });
  const reshufflePayload=await jsonResponse(reshuffle);
  assert.equal(reshuffle.status,200,reshufflePayload.text);
  assert.equal(reshufflePayload.body.ok,true);
  assert.equal(reshufflePayload.body.count,2);
  assert.equal(reshufflePayload.body.pairs.length,1);

  const me=await fetch(new URL('/api/auth/me',first.url),{
    headers:{cookie:sessionCookie},
  });
  assert.equal(me.status,200);
  assert.equal((await me.json()).user.email,'local.user@example.test');

  await first.close();
  cleanup.pop();

  const persisted=createClient({url:databaseUrl});
  const accountRows=await persisted.execute({
    sql:'SELECT email,display_name,password_hash FROM auth_accounts WHERE email=?',
    args:['local.user@example.test'],
  });
  assert.equal(accountRows.rows.length,1);
  assert.equal(accountRows.rows[0].display_name,'Local User');
  assert.match(String(accountRows.rows[0].password_hash),/^\$2/);
  const pairingRows=await persisted.execute({
    sql:`SELECT COUNT(*) AS count FROM pairing_groups pg
      JOIN pairing_week_runs pwr ON pwr.week_id=pg.week_id
      WHERE pwr.week_label=?`,
    args:[reshufflePayload.body.week_label],
  });
  assert.equal(Number(pairingRows.rows[0]?.count),1);
  await persisted.close();

  const second=registerRuntime(await startLocalDevelopmentServer({config,logger:SILENT_LOGGER}));
  assert.notEqual(getClient(),firstSharedClient,'shutdown must close and release the shared database client');
  const existingSession=await fetch(new URL('/api/auth/me',second.url),{
    headers:{cookie:sessionCookie},
  });
  assert.equal(existingSession.status,200);
  assert.equal((await existingSession.json()).user.email,'local.user@example.test');

  const login=await fetch(new URL('/api/auth/login',second.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:second.url},
    body:JSON.stringify({email:'local.user@example.test',password:'correct horse battery'}),
  });
  assert.equal(login.status,200);
  assert.equal((await login.json()).user.name,'Local User');
  assert.match(cookiePair(login),/^randori_session=/);
});

test('different local databases use different session keys',async()=>{
  const directory=temporaryDirectory();
  const firstConfig=localConfig(directory).config;
  const secondDatabaseUrl=pathToFileURL(join(directory,'.local','second.sqlite')).href;
  const secondConfig=resolveLocalServerConfig({
    rootDir:directory,
    argv:[],
    env:localEnvironment(secondDatabaseUrl),
  });
  assert.notEqual(firstConfig.secretPath,secondConfig.secretPath);

  const first=await startLocalDevelopmentServer({config:firstConfig,logger:SILENT_LOGGER});
  const firstSignup=await fetch(new URL('/api/auth/signup',first.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:first.url},
    body:JSON.stringify({email:'first-db@example.test',password:'correct horse battery',name:'First DB'}),
  });
  assert.equal(firstSignup.status,200);
  const firstCookie=cookiePair(firstSignup);
  await first.close();

  const second=registerRuntime(await startLocalDevelopmentServer({config:secondConfig,logger:SILENT_LOGGER}));
  const secondSignup=await fetch(new URL('/api/auth/signup',second.url),{
    method:'POST',
    headers:{'content-type':'application/json',origin:second.url},
    body:JSON.stringify({email:'second-db@example.test',password:'another correct horse',name:'Second DB'}),
  });
  assert.equal(secondSignup.status,200);
  const crossedSession=await fetch(new URL('/api/auth/me',second.url),{headers:{cookie:firstCookie}});
  assert.equal(crossedSession.status,401);
  assert.deepEqual(await crossedSession.json(),{error:'authentication required'});
});

test('the process admits only one local runtime at a time',async()=>{
  const firstDirectory=temporaryDirectory();
  const secondDirectory=temporaryDirectory();
  const first=await startLocalDevelopmentServer({
    config:localConfig(firstDirectory).config,
    logger:SILENT_LOGGER,
  });
  await assert.rejects(
    startLocalDevelopmentServer({
      config:localConfig(secondDirectory).config,
      logger:SILENT_LOGGER,
    }),
    error=>error?.code==='LOCAL_DATABASE_IN_USE',
  );
  await first.close();
  const second=registerRuntime(await startLocalDevelopmentServer({
    config:localConfig(secondDirectory).config,
    logger:SILENT_LOGGER,
  }));
  assert.match(second.url,/^http:\/\/127\.0\.0\.1:/);
});

test('a failed start is terminal and releases its runtime lock',async()=>{
  const directory=temporaryDirectory();
  const blocker=createHttpServer();
  await new Promise(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise(resolve=>blocker.close(resolve)));
  const port=blocker.address().port;
  const config=localConfig(directory,{RANDORI_LOCAL_PORT:String(port)}).config;
  const runtime=await createLocalDevelopmentServer({config,logger:SILENT_LOGGER});
  await assert.rejects(runtime.start(),error=>error?.code==='EADDRINUSE');
  await assert.rejects(runtime.start(),error=>error?.code==='LOCAL_INTERNAL_ERROR');
  await runtime.close();
  const reset=await resetLocalDatabase(config,{confirmed:true});
  assert.equal(reset.removed,true,'failed start must release the runtime lock');
});

test('the adapter preserves route query, dynamic ids, redirects, cookies, status, and JSON semantics',async()=>{
  const directory=temporaryDirectory();
  const {config}=localConfig(directory);
  const seen=[];
  const handlers={
    auth(req,res){
      seen.push({kind:'auth',method:req.method,url:req.url,query:req.query,body:req.body});
      res.setHeader('Set-Cookie',['first=one; Path=/','second=two; Path=/']);
      return res.status(201).json({ok:true,query:req.query,body:req.body});
    },
    invitations(req,res){
      seen.push({kind:'invitations',query:req.query});
      res.writeHead(302,{Location:'/invite/accepted'});
      return res.end();
    },
  };
  const runtime=registerRuntime(await startLocalDevelopmentServer({config,handlers,logger:SILENT_LOGGER}));

  const auth=await fetch(new URL('/api/auth/signup?tag=one&tag=two&plain=value',runtime.url),{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({email:'adapter@example.test'}),
  });
  assert.equal(auth.status,201);
  const authPayload=await auth.json();
  assert.equal(authPayload.query.endpoint,'signup');
  assert.deepEqual(authPayload.query.tag,['one','two']);
  assert.equal(authPayload.query.plain,'value');
  assert.deepEqual(authPayload.body,{email:'adapter@example.test'});
  assert.match(auth.headers.get('set-cookie')||'',/first=one/);
  assert.match(auth.headers.get('set-cookie')||'',/second=two/);

  const capabilities=await fetch(new URL('/api/auth/capabilities',runtime.url));
  assert.equal(capabilities.status,201);
  assert.equal((await capabilities.json()).query.endpoint,'capabilities');

  const invitation=await fetch(new URL('/api/invitations/invite-123?view=compact',runtime.url),{
    redirect:'manual',
  });
  assert.equal(invitation.status,302);
  assert.equal(invitation.headers.get('location'),'/invite/accepted');
  assert.deepEqual(seen,[
    {
      kind:'auth',method:'POST',url:'/api/auth/signup?tag=one&tag=two&plain=value',
      query:{tag:['one','two'],plain:'value',endpoint:'signup'},
      body:{email:'adapter@example.test'},
    },
    {kind:'auth',method:'GET',url:'/api/auth/capabilities',query:{endpoint:'capabilities'},body:{}},
    {kind:'invitations',query:{view:'compact',endpoint:'invitations',id:'invite-123'}},
  ]);
});

test('runtime environment disables ambient providers and restores the caller environment on close',async()=>{
  const directory=temporaryDirectory();
  const databaseUrl=pathToFileURL(join(directory,'.local','randori.sqlite')).href;
  const envTarget={
    NODE_ENV:'test',
    RANDORI_LOCAL_HOST:'127.0.0.1',
    RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:databaseUrl,
    JWT_SECRET:'ambient-jwt-secret',
    GOOGLE_CLIENT_ID:'ambient-google-client',
    GOOGLE_CLIENT_SECRET:'ambient-google-secret',
    OPENAI_API_KEY:'ambient-openai-key',
    GROQ_API_KEY:'ambient-groq-key',
    RESEND_API_KEY:'ambient-resend-key',
    SENTRY_DSN:'https://ambient@sentry.example.test/1',
    AI_ENABLED:'true',
    LEETCODE_INGESTION_AUTHORIZED:'true',
    RUN_ATTESTATION_SECRET:'ambient-run-attestation-secret',
    RUN_ATTESTATION_PREVIOUS_SECRETS:'ambient-previous-attestation-secrets',
  };
  const config=resolveLocalServerConfig({rootDir:directory,argv:[],env:envTarget});
  const original={...envTarget};
  const runtime=registerRuntime(await startLocalDevelopmentServer({
    config,
    envTarget,
    logger:SILENT_LOGGER,
    handlers:{
      data(_req,res){
        return res.json({
          databaseUrl:envTarget.TURSO_DATABASE_URL,
          tursoToken:envTarget.TURSO_AUTH_TOKEN,
          googleClient:envTarget.GOOGLE_CLIENT_ID,
          googleSecret:envTarget.GOOGLE_CLIENT_SECRET,
          openaiKey:envTarget.OPENAI_API_KEY,
          groqKey:envTarget.GROQ_API_KEY,
          resendKey:envTarget.RESEND_API_KEY,
          sentryDsn:envTarget.SENTRY_DSN,
          aiEnabled:envTarget.AI_ENABLED,
          ingestionAuthorized:envTarget.LEETCODE_INGESTION_AUTHORIZED,
          runAttestationSecret:envTarget.RUN_ATTESTATION_SECRET,
          previousAttestationSecrets:envTarget.RUN_ATTESTATION_PREVIOUS_SECRETS,
        });
      },
    },
  }));
  const response=await fetch(new URL('/api/health',runtime.url));
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{
    databaseUrl,
    tursoToken:'',
    googleClient:'',
    googleSecret:'',
    openaiKey:'',
    groqKey:'',
    resendKey:'',
    sentryDsn:'',
    aiEnabled:'false',
    ingestionAuthorized:'false',
    runAttestationSecret:'',
    previousAttestationSecrets:'',
  });
  await runtime.close();
  cleanup.pop();
  assert.deepEqual(envTarget,original);
});

test('request parsing rejects wrong methods, malformed JSON, oversized bodies, and unknown APIs',async()=>{
  const directory=temporaryDirectory();
  const {config}=localConfig(directory);
  let authCalls=0;
  const runtime=registerRuntime(await startLocalDevelopmentServer({
    config,
    logger:SILENT_LOGGER,
    handlers:{auth(_req,res){ authCalls+=1; return res.json({ok:true}); }},
  }));

  const malformed=await requestRaw(runtime.url,{
    path:'/api/auth/signup',
    method:'POST',
    headers:{'content-type':'application/json'},
    body:'{"email":',
  });
  assert.equal(malformed.status,400);
  assert.deepEqual(JSON.parse(malformed.body),{ok:false,error:'LOCAL_BODY_INVALID'});

  const wrongType=await requestRaw(runtime.url,{
    path:'/api/auth/signup',
    method:'POST',
    headers:{'content-type':'text/plain'},
    body:'not json',
  });
  assert.equal(wrongType.status,400);
  assert.deepEqual(JSON.parse(wrongType.body),{ok:false,error:'LOCAL_BODY_INVALID'});

  const arrayBody=await requestRaw(runtime.url,{
    path:'/api/auth/signup',
    method:'POST',
    headers:{'content-type':'application/json'},
    body:'[]',
  });
  assert.equal(arrayBody.status,400);
  assert.deepEqual(JSON.parse(arrayBody.body),{ok:false,error:'LOCAL_BODY_INVALID'});

  const oversizedBody=JSON.stringify({payload:'x'.repeat(1_100_000)});
  const oversized=await requestRaw(runtime.url,{
    path:'/api/auth/signup',
    method:'POST',
    headers:{
      'content-type':'application/json',
      'content-length':Buffer.byteLength(oversizedBody),
    },
    body:oversizedBody,
  });
  assert.equal(oversized.status,413);
  assert.deepEqual(JSON.parse(oversized.body),{ok:false,error:'LOCAL_BODY_TOO_LARGE'});
  assert.equal(authCalls,0);

  const unknown=await fetch(new URL('/api/definitely-not-a-route',runtime.url));
  assert.equal(unknown.status,404);
  assert.deepEqual(await unknown.json(),{ok:false,error:'LOCAL_API_NOT_FOUND'});

  const forgedHost=await requestRaw(runtime.url,{
    path:'/api/health',
    headers:{host:'attacker.example.test'},
  });
  assert.equal(forgedHost.status,403);
  assert.deepEqual(JSON.parse(forgedHost.body),{ok:false,error:'LOCAL_HOST_REFUSED'});

  const malformedId=await requestRaw(runtime.url,{path:'/api/invitations/%E0%A4%A'});
  assert.equal(malformedId.status,400);
  assert.deepEqual(JSON.parse(malformedId.body),{ok:false,error:'LOCAL_API_NOT_FOUND'});
  assert.equal(authCalls,0);

  await runtime.close();
  cleanup.pop();
  const real=registerRuntime(await startLocalDevelopmentServer({config,logger:SILENT_LOGGER}));
  const wrongMethod=await fetch(new URL('/api/auth/signup',real.url));
  assert.equal(wrongMethod.status,405);
  assert.deepEqual(await wrongMethod.json(),{error:'POST only'});
});

test('static serving supports SPA navigation without exposing repository files or traversal targets',async()=>{
  const directory=temporaryDirectory();
  const {config}=localConfig(directory);
  const runtime=registerRuntime(await startLocalDevelopmentServer({config,logger:SILENT_LOGGER}));

  for(const route of ['/','/invite','/join/example-invitation']){
    const response=await fetch(new URL(route,runtime.url));
    assert.equal(response.status,200,route);
    assert.match(response.headers.get('content-security-policy')||'',/default-src 'self'/);
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.match(await response.text(),/<title>Randori Circle<\/title>/);
  }

  for(const route of [
    '/package.json',
    '/.env',
    '/api/_db.js',
    '/db/schema-manifest.js',
    '/scripts/local-server.mjs',
    '/missing.js',
  ]){
    const response=await fetch(new URL(route,runtime.url));
    const body=await response.text();
    assert.notEqual(response.status,200,route);
    assert.doesNotMatch(body,/TURSO_AUTH_TOKEN|JWT_SECRET|createClient|schema_migrations/);
  }

  for(const path of [
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
    '/%252e%252e/%252e%252e/etc/passwd',
  ]){
    const response=await requestRaw(runtime.url,{path});
    assert.ok([400,403,404].includes(response.status),`${path} returned ${response.status}`);
    assert.doesNotMatch(response.body,/root:.*:0:0|Randori Circle/);
  }
});

test('unexpected handler failures are redacted and graceful close drains work then becomes idempotent',async()=>{
  const directory=temporaryDirectory();
  const {config,databasePath}=localConfig(directory);
  let release;
  let started;
  const startedPromise=new Promise(resolve=>{ started=resolve; });
  const gate=new Promise(resolve=>{ release=resolve; });
  let invocation=0;
  const runtime=registerRuntime(await startLocalDevelopmentServer({
    config,
    logger:SILENT_LOGGER,
    handlers:{
      data:async(_req,res)=>{
        invocation+=1;
        if(invocation===1){
          throw new Error(`database ${databasePath} failed with token ultra-secret-token`);
        }
        started();
        await gate;
        return res.status(200).json({ok:true});
      },
    },
  }));

  const failed=await fetch(new URL('/api/health',runtime.url));
  assert.equal(failed.status,500);
  const failureText=await failed.text();
  assert.deepEqual(JSON.parse(failureText),{ok:false,error:'LOCAL_INTERNAL_ERROR'});
  assert.doesNotMatch(failureText,/ultra-secret-token|randori\.sqlite|database/i);

  const pending=fetch(new URL('/api/health',runtime.url),{headers:{connection:'close'}});
  await startedPromise;
  let closed=false;
  const closing=runtime.close().then(()=>{ closed=true; });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'close must wait for an in-flight handler');
  release();
  const completed=await pending;
  assert.equal(completed.status,200);
  assert.deepEqual(await completed.json(),{ok:true});
  await closing;
  assert.equal(closed,true);
  await runtime.close();
  cleanup.pop();

  await assert.rejects(
    fetch(new URL('/api/health',runtime.url),{signal:AbortSignal.timeout(1000)}),
  );
});
