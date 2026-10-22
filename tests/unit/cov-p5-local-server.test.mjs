import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import {
  adoptLocalCredentialKeyControls,
  createLocalDevelopmentServer,
  prepareLocalDatabase,
  resetLocalDatabase,
  resolveLocalServerConfig,
  seedLocalOnboarding,
  startLocalDevelopmentServer,
} from '../../scripts/local-server.mjs';

const REPOSITORY_ROOT=fileURLToPath(new URL('../..',import.meta.url));
const SILENT_LOGGER=Object.freeze({log(){},error(){}});
const DEAD_PID=2147483646;
const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){
    const dispose=cleanup.pop();
    try{ await dispose(); }catch{}
  }
});

function workspace({createLocal=true}={}){
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-cov-local-')));
  if(createLocal) mkdirSync(join(rootDir,'.local'),{mode:0o700});
  chmodSync(rootDir,0o700);
  cleanup.push(()=>{
    try{ chmodSync(join(rootDir,'.local'),0o700); }catch{}
    rmSync(rootDir,{recursive:true,force:true});
  });
  return rootDir;
}

function env(rootDir,overrides={}){
  return {
    NODE_ENV:'development',
    RANDORI_LOCAL_HOST:'127.0.0.1',
    RANDORI_LOCAL_PORT:'0',
    RANDORI_LOCAL_DATABASE_URL:pathToFileURL(join(rootDir,'.local','randori.sqlite')).href,
    ...overrides,
  };
}

function configFor(rootDir,overrides={}){
  return resolveLocalServerConfig({rootDir,argv:[],env:env(rootDir,overrides)});
}

function code(expected){
  return error=>{
    assert.equal(error?.code,expected,error?.stack);
    return true;
  };
}

function fakeMigrations({before={classification:'empty',stateFingerprint:'f'},after,applyResult={},applyError}={}){
  const calls=[];
  let inspections=0;
  return {
    calls,
    createDatabaseClient(options){
      calls.push(['create',options.url]);
      return {close(){ calls.push(['close']); }};
    },
    async prepare(){ calls.push(['prepare']); },
    async inspect(){
      inspections+=1;
      return inspections===1?before:(after||{classification:'managed',ready:true,currentVersion:3,latestVersion:3,stateFingerprint:'g'});
    },
    async apply(_client,options){
      calls.push(['apply',options.expectedStateFingerprint]);
      if(applyError) throw applyError;
      return applyResult;
    },
  };
}

function rawRequest(baseUrl,{path='/',method='GET',headers={},body,chunks}={}){
  const target=new URL(baseUrl);
  return new Promise((resolve,reject)=>{
    const request=httpRequest({hostname:target.hostname,port:target.port,method,path,headers},response=>{
      const parts=[];
      response.on('data',chunk=>parts.push(chunk));
      response.on('end',()=>resolve({
        status:response.statusCode,headers:response.headers,body:Buffer.concat(parts).toString('utf8'),
      }));
    });
    request.on('error',reject);
    if(body!==undefined) request.write(body);
    for(const chunk of chunks||[]) request.write(chunk);
    request.end();
  });
}

// ---------------------------------------------------------------- config ---

test('configuration refuses CLI arguments, unusable roots, and conflicting database targets',()=>{
  const rootDir=workspace();
  assert.throws(()=>resolveLocalServerConfig({rootDir,argv:['--port','1'],env:env(rootDir)}),
    code('LOCAL_DATABASE_REFUSED'));

  const file=join(rootDir,'not-a-directory');
  writeFileSync(file,'x');
  assert.throws(()=>resolveLocalServerConfig({rootDir:file,argv:[],env:env(rootDir)}),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/must be a directory/.test(error.message));
  assert.throws(()=>resolveLocalServerConfig({rootDir:join(rootDir,'missing'),argv:[],env:env(rootDir)}),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/not accessible/.test(error.message)&&Boolean(error.cause));

  const other=pathToFileURL(join(rootDir,'.local','other.sqlite')).href;
  assert.throws(()=>configFor(rootDir,{TURSO_DATABASE_URL:other}),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/Conflicting/.test(error.message));
  const same=configFor(rootDir,{TURSO_DATABASE_URL:env(rootDir).RANDORI_LOCAL_DATABASE_URL});
  assert.equal(same.databasePath,join(rootDir,'.local','randori.sqlite'));
  const tursoOnly=resolveLocalServerConfig({rootDir,argv:[],env:{NODE_ENV:'development',TURSO_DATABASE_URL:other}});
  assert.equal(tursoOnly.databasePath,join(rootDir,'.local','other.sqlite'));
  assert.equal(tursoOnly.port,3000,'the default port is 3000');
  assert.equal(tursoOnly.secretPath,`${join(rootDir,'.local','other.sqlite')}.jwt-secret`);
  assert.equal(tursoOnly.lockPath,join(rootDir,'.local','runtime.lock'));
});

test('configuration refuses database files outside .local, remote hosts, and reserved runtime names',()=>{
  const rootDir=workspace();
  const refused=[
    pathToFileURL(join(rootDir,'randori.sqlite')).href,
    pathToFileURL(join(rootDir,'.local','nested','randori.sqlite')).href,
    `file://remote-host${join(rootDir,'.local','randori.sqlite')}`,
    `${pathToFileURL(join(rootDir,'.local','randori.sqlite')).href}#fragment`,
    pathToFileURL(join(rootDir,'.local','runtime.lock')).href,
    pathToFileURL(join(rootDir,'.local','x.runtime-lock')).href,
    pathToFileURL(join(rootDir,'.local','x.jwt-secret')).href,
    'not a url at all',
  ];
  for(const url of refused){
    assert.throws(()=>configFor(rootDir,{RANDORI_LOCAL_DATABASE_URL:url}),code('LOCAL_DATABASE_REFUSED'),url);
  }
});

test('ports must be plain decimal integers within range',()=>{
  const rootDir=workspace();
  for(const port of ['','  ','0x10','1e3','99999999999999999999']){
    assert.throws(()=>configFor(rootDir,{RANDORI_LOCAL_PORT:port}),code('LOCAL_PORT_INVALID'),JSON.stringify(port));
  }
  assert.equal(configFor(rootDir,{RANDORI_LOCAL_PORT:' 8080 '}).port,8080);
  assert.equal(configFor(rootDir,{RANDORI_LOCAL_PORT:'65535'}).port,65535);
});

// ------------------------------------------------------- database guard ---

test('database preparation requires a resolved configuration',async()=>{
  await assert.rejects(prepareLocalDatabase(undefined),code('LOCAL_DATABASE_REFUSED'));
  await assert.rejects(prepareLocalDatabase({databaseUrl:'file:///x'}),code('LOCAL_DATABASE_REFUSED'));
});

test('database preparation creates a private .local directory and reports applied versions',async()=>{
  const rootDir=workspace({createLocal:false});
  const config=configFor(rootDir);
  const fake=fakeMigrations({applyResult:{applied:[{version:1},{version:2}]}});
  const result=await prepareLocalDatabase(config,fake);
  assert.equal(result.created,true);
  assert.deepEqual(result.appliedVersions,[1,2]);
  assert.equal(result.currentVersion,3);
  assert.deepEqual(fake.calls.map(call=>call[0]),['create','prepare','apply','close']);
  assert.equal(fake.calls[2][1],'f','apply receives the fingerprint observed before migration');

  const again=await prepareLocalDatabase(config,fakeMigrations());
  assert.equal(again.created,false,'an existing guarded database is reused');
  assert.deepEqual(again.appliedVersions,[],'a missing applied list is reported as empty');
});

test('database preparation refuses unmanaged or incomplete schemas and always closes',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const unmanaged=fakeMigrations({before:{classification:'unmanaged'}});
  await assert.rejects(prepareLocalDatabase(config,unmanaged),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/unmanaged/.test(error.message));
  assert.equal(unmanaged.calls.at(-1)[0],'close');
  assert.equal(unmanaged.calls.some(call=>call[0]==='apply'),false,'unmanaged state is never migrated');

  for(const after of [
    {classification:'legacy',ready:true,currentVersion:3,latestVersion:3},
    {classification:'managed',ready:false,currentVersion:3,latestVersion:3},
    {classification:'managed',ready:true,currentVersion:2,latestVersion:3},
  ]){
    const fake=fakeMigrations({after});
    await assert.rejects(prepareLocalDatabase(config,fake),
      error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/schema-ready/.test(error.message));
    assert.equal(fake.calls.at(-1)[0],'close');
  }
});

test('migration failures are mapped to a public message without leaking details',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const fake=fakeMigrations({applyError:new Error('libsql://secret-host token=ultra-secret failed')});
  await assert.rejects(prepareLocalDatabase(config,fake),error=>{
    assert.equal(error.code,'LOCAL_DATABASE_NOT_READY');
    assert.doesNotMatch(error.message,/secret|libsql/);
    assert.match(error.cause.message,/ultra-secret/,'the original error stays available as the cause');
    return true;
  });
});

test('a database connection that fails to close is reported as not ready',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const fake=fakeMigrations();
  fake.createDatabaseClient=()=>({close(){ throw new Error('close failed'); }});
  await assert.rejects(prepareLocalDatabase(config,fake),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/did not close safely/.test(error.message));
});

test('the database guard refuses unsafe directories and database files',async()=>{
  const permissive=workspace();
  chmodSync(join(permissive,'.local'),0o755);
  await assert.rejects(prepareLocalDatabase(configFor(permissive),fakeMigrations()),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/real directory/.test(error.message));

  const fileInsteadOfDirectory=workspace({createLocal:false});
  writeFileSync(join(fileInsteadOfDirectory,'.local'),'x',{mode:0o600});
  await assert.rejects(prepareLocalDatabase(configFor(fileInsteadOfDirectory),fakeMigrations()),
    code('LOCAL_DATABASE_REFUSED'));

  const linkedDirectory=workspace({createLocal:false});
  const target=join(linkedDirectory,'elsewhere');
  mkdirSync(target,{mode:0o700});
  symlinkSync(target,join(linkedDirectory,'.local'));
  await assert.rejects(prepareLocalDatabase(configFor(linkedDirectory),fakeMigrations()),
    code('LOCAL_DATABASE_REFUSED'));

  const readable=workspace();
  writeFileSync(join(readable,'.local','randori.sqlite'),'',{mode:0o644});
  chmodSync(join(readable,'.local','randori.sqlite'),0o644);
  await assert.rejects(prepareLocalDatabase(configFor(readable),fakeMigrations()),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/regular file/.test(error.message));

  const hardLinked=workspace();
  writeFileSync(join(hardLinked,'.local','randori.sqlite'),'',{mode:0o600});
  linkSync(join(hardLinked,'.local','randori.sqlite'),join(hardLinked,'.local','copy.sqlite'));
  await assert.rejects(prepareLocalDatabase(configFor(hardLinked),fakeMigrations()),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/regular file/.test(error.message));

  const directoryTarget=workspace();
  mkdirSync(join(directoryTarget,'.local','randori.sqlite'),{mode:0o700});
  await assert.rejects(prepareLocalDatabase(configFor(directoryTarget),fakeMigrations()),
    code('LOCAL_DATABASE_REFUSED'));
});

test('a database that cannot be created is refused with a wrapped cause',{
  skip:process.getuid?.()===0?'root bypasses directory permissions':false,
},async()=>{
  const rootDir=workspace();
  chmodSync(join(rootDir,'.local'),0o500);
  await assert.rejects(prepareLocalDatabase(configFor(rootDir),fakeMigrations()),error=>{
    assert.equal(error.code,'LOCAL_DATABASE_REFUSED');
    assert.match(error.message,/could not be opened safely/);
    assert.equal(error.cause?.code,'EACCES');
    return true;
  });
});

// ---------------------------------------------------------------- seeding ---

test('development seeding refuses anything but the configured local file database',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const never=()=>{ throw new Error('client must not be created'); };
  const bad=[
    undefined,
    {...config,localDirectory:undefined},
    {...config,localDirectory:rootDir},
    {...config,databaseUrl:'not a url'},
    {...config,databaseUrl:`${config.databaseUrl}?mode=rw`},
    {...config,databaseUrl:pathToFileURL(join(rootDir,'.local','other.sqlite')).href},
    {...config,databaseUrl:'libsql://remote.example.test'},
  ];
  for(const candidate of bad){
    await assert.rejects(seedLocalOnboarding(candidate,{createDatabaseClient:never}),code('LOCAL_DATABASE_REFUSED'));
  }
});

test('development seeding requires a fully migrated database',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  await assert.rejects(seedLocalOnboarding(config),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/fully migrated/.test(error.message));
});

test('seeding is idempotent for the reserved owner and refuses a conflicting identity',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  await prepareLocalDatabase(config);
  const hashes=[];
  const first=await seedLocalOnboarding(config,{
    hashPassword:async(value,cost)=>{ hashes.push([value,cost]); return 'stub-hash'; },
    comparePassword:async()=>{ throw new Error('no existing owner yet'); },
  });
  assert.equal(first.created,true);
  assert.equal(first.email,'owner@randori.test');
  assert.equal(hashes.length,1);
  assert.equal(hashes[0][1],10);

  const compared=[];
  const second=await seedLocalOnboarding(config,{
    hashPassword:async()=>{ throw new Error('must not rehash'); },
    comparePassword:async(value,hash)=>{ compared.push(hash); return true; },
  });
  assert.equal(second.created,false);
  assert.equal(second.ownerId,first.ownerId);
  assert.equal(second.circleId,first.circleId);
  assert.deepEqual(compared,['stub-hash']);

  await assert.rejects(seedLocalOnboarding(config,{comparePassword:async()=>false}),
    code('LOCAL_SEED_CONFLICT'));
});

test('unexpected seeding failures and unsafe closes are wrapped as not ready',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  let closed=0;
  await assert.rejects(seedLocalOnboarding(config,{createDatabaseClient:()=>({
    async execute(){ throw new Error('SQLITE_IOERR /private/path'); },
    async batch(){ throw new Error('SQLITE_IOERR /private/path'); },
    close(){ closed+=1; },
  })}),error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/onboarding seed/.test(error.message)
    &&!/private/.test(error.message));
  assert.equal(closed,1);

  await assert.rejects(seedLocalOnboarding(config,{createDatabaseClient:()=>({
    async execute(){ throw new Error('first'); },
    async batch(){ throw new Error('first'); },
    close(){ throw new Error('close failed'); },
  })}),error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/did not close safely/.test(error.message));
});

// ------------------------------------------------------- key adoption ---

test('credential key adoption is limited to the resolved local database',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const never=()=>{ throw new Error('client must not be created'); };
  await assert.rejects(adoptLocalCredentialKeyControls(undefined,{createDatabaseClient:never}),
    code('LOCAL_DATABASE_REFUSED'));
  await assert.rejects(adoptLocalCredentialKeyControls({...config,rootDir:undefined},{createDatabaseClient:never}),
    code('LOCAL_DATABASE_REFUSED'));
  await assert.rejects(adoptLocalCredentialKeyControls({...config,localDirectory:rootDir},{createDatabaseClient:never}),
    code('LOCAL_DATABASE_REFUSED'));
  await assert.rejects(adoptLocalCredentialKeyControls(
    {...config,databaseUrl:'libsql://remote.example.test'},{createDatabaseClient:never}),
  code('LOCAL_DATABASE_REFUSED'));
});

test('credential key adoption failures are wrapped and the client is still closed',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  let closed=0;
  await assert.rejects(adoptLocalCredentialKeyControls(config,{createDatabaseClient:()=>({
    async execute(){ throw new Error('key table locked /private/path'); },
    async batch(){ throw new Error('key table locked /private/path'); },
    async transaction(){ throw new Error('key table locked /private/path'); },
    close(){ closed+=1; throw new Error('close also failed'); },
  })}),error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/could not be adopted/.test(error.message));
  assert.equal(closed,1,'a close failure after an adoption failure is swallowed');
});

// ------------------------------------------------------------------ reset ---

test('reset requires confirmation and a database inside the configured directory',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  await assert.rejects(resetLocalDatabase(config),code('LOCAL_RESET_CONFIRMATION_REQUIRED'));
  await assert.rejects(resetLocalDatabase(config,{confirmed:'yes'}),code('LOCAL_RESET_CONFIRMATION_REQUIRED'));
  await assert.rejects(resetLocalDatabase({...config,databasePath:join(rootDir,'outside.sqlite')},{confirmed:true}),
    code('LOCAL_DATABASE_REFUSED'));
  await assert.rejects(resetLocalDatabase({...config,localDirectory:undefined},{confirmed:true}),
    code('LOCAL_DATABASE_REFUSED'));
});

test('reset without a database removes only stale sidecars and the session secret',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const unrelated=join(rootDir,'.local','keep.txt');
  for(const path of [`${config.databasePath}-wal`,config.secretPath,unrelated]) writeFileSync(path,'x',{mode:0o600});
  const result=await resetLocalDatabase(config,{confirmed:true});
  assert.equal(result.removed,true);
  assert.equal(existsSync(`${config.databasePath}-wal`),false);
  assert.equal(existsSync(config.secretPath),false);
  assert.equal(existsSync(unrelated),true,'files outside the reset set are kept');
  assert.equal(existsSync(config.lockPath),false);
});

test('reset refuses unmanaged databases and wraps verification failures',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  writeFileSync(config.databasePath,'',{mode:0o600});

  const unmanaged={createDatabaseClient:()=>({close(){}}),prepare:async()=>{},
    inspect:async()=>({classification:'managed',ready:true,ledgerPresent:false})};
  await assert.rejects(resetLocalDatabase(config,{confirmed:true,...unmanaged}),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/Only a managed/.test(error.message));

  const exploding={createDatabaseClient:()=>({close(){}}),prepare:async()=>{},
    inspect:async()=>{ throw new Error('SQLITE_CORRUPT /private/path'); }};
  await assert.rejects(resetLocalDatabase(config,{confirmed:true,...exploding}),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/verified for reset/.test(error.message));

  const badClose={createDatabaseClient:()=>({close(){ throw new Error('close failed'); }}),prepare:async()=>{},
    inspect:async()=>({classification:'managed',ready:true,ledgerPresent:true})};
  await assert.rejects(resetLocalDatabase(config,{confirmed:true,...badClose}),
    error=>error.code==='LOCAL_DATABASE_NOT_READY'&&/did not close safely/.test(error.message));

  assert.equal(existsSync(config.databasePath),true,'refused resets never delete the database');
  assert.equal(existsSync(config.lockPath),false,'every refused reset releases the runtime lock');

  const managed={createDatabaseClient:()=>({close(){}}),prepare:async()=>{},
    inspect:async()=>({classification:'managed',ready:true,ledgerPresent:true})};
  assert.deepEqual(await resetLocalDatabase(config,{confirmed:true,...managed}),{ok:true,removed:true});
  assert.equal(existsSync(config.databasePath),false);
});

// ---------------------------------------------------------- runtime lock ---

test('a stale runtime lock from a dead process is recovered',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  writeFileSync(config.lockPath,`${DEAD_PID}\n`,{mode:0o600});
  const result=await resetLocalDatabase(config,{confirmed:true});
  assert.equal(result.removed,false);
  assert.equal(existsSync(config.lockPath),false);
});

test('a runtime lock held by a live process blocks access',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  writeFileSync(config.lockPath,`${process.pid}\n`,{mode:0o600});
  await assert.rejects(resetLocalDatabase(config,{confirmed:true}),code('LOCAL_DATABASE_IN_USE'));
  assert.equal(readFileSync(config.lockPath,'utf8'),`${process.pid}\n`,'a live lock is left untouched');
});

test('invalid, unsafe, or linked runtime locks are refused',async()=>{
  const cases=[
    ['not-a-pid',config=>writeFileSync(config.lockPath,'abc\n',{mode:0o600}),/invalid/],
    ['zero pid',config=>writeFileSync(config.lockPath,'0\n',{mode:0o600}),/invalid/],
    ['oversized',config=>writeFileSync(config.lockPath,`${'1'.repeat(40)}\n`,{mode:0o600}),/unsafe/],
    ['readable',config=>{ writeFileSync(config.lockPath,'1\n'); chmodSync(config.lockPath,0o644); },/unsafe/],
    ['directory',config=>mkdirSync(config.lockPath,{mode:0o700}),/unsafe/],
    ['symlink',config=>{
      writeFileSync(join(config.localDirectory,'real-lock'),`${DEAD_PID}\n`,{mode:0o600});
      symlinkSync(join(config.localDirectory,'real-lock'),config.lockPath);
    },/could not be inspected/],
  ];
  for(const [label,arrange,message] of cases){
    const rootDir=workspace();
    const config=configFor(rootDir);
    arrange(config);
    await assert.rejects(resetLocalDatabase(config,{confirmed:true}),error=>{
      assert.equal(error.code,'LOCAL_DATABASE_REFUSED',label);
      assert.match(error.message,message,label);
      return true;
    });
  }
});

// ---------------------------------------------------------------- server ---

test('the runtime refuses unsafe or invalid session secrets and releases its lock',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  writeFileSync(config.secretPath,'short\n',{mode:0o600});
  await assert.rejects(createLocalDevelopmentServer({config,logger:SILENT_LOGGER}),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/secret is invalid/.test(error.message));
  chmodSync(config.secretPath,0o644);
  writeFileSync(config.secretPath,`${'s'.repeat(64)}\n`);
  await assert.rejects(createLocalDevelopmentServer({config,logger:SILENT_LOGGER}),
    error=>error.code==='LOCAL_DATABASE_REFUSED'&&/secret file is unsafe/.test(error.message));
  rmSync(config.secretPath);
  mkdirSync(config.secretPath,{mode:0o700});
  await assert.rejects(createLocalDevelopmentServer({config,logger:SILENT_LOGGER}),code('LOCAL_DATABASE_REFUSED'));
  assert.equal(existsSync(config.lockPath),false,'each failure releases the runtime lock');
});

test('a runtime missing a required handler fails to start and restores the environment',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const envTarget={KEEP:'1'};
  const lines=[];
  const runtime=await createLocalDevelopmentServer({
    config,envTarget,logger:line=>lines.push(line),handlers:{video:'not-a-function'},
  });
  await assert.rejects(runtime.start(),
    error=>error.code==='LOCAL_INTERNAL_ERROR'&&/Missing local API handler: video/.test(error.message));
  assert.deepEqual(envTarget,{KEEP:'1'},'the installed runtime environment is rolled back');
  assert.equal(runtime.server.listening,false);
  assert.equal(lines.length,0,'no ready line is logged for a failed start');
  assert.equal(existsSync(config.lockPath),false);
  await runtime.close();
});

test('the adapter routes every API family and redacts handler failures',async()=>{
  const rootDir=workspace();
  mkdirSync(join(rootDir,'assets'));
  writeFileSync(join(rootDir,'assets','app.css'),'body{color:red}');
  writeFileSync(join(rootDir,'index.html'),readFileSync(join(REPOSITORY_ROOT,'index.html')));
  const config=configFor(rootDir);
  const seen=[];
  const echo=kind=>(req,res)=>{ seen.push({kind,query:{...req.query}}); return res.json({kind,query:req.query,body:req.body}); };
  const handlers={
    data:echo('data'),ops:echo('ops'),ai:echo('ai'),video:echo('video'),codeDocument:echo('codeDocument'),
    invitations:echo('invitations'),circles:echo('circles'),
    auth(req,res){
      if(req.query.mode==='silent') return undefined;
      if(req.query.mode==='status') return res.status(42).json({ok:true});
      if(req.query.mode==='partial'){
        res.writeHead(202,{'content-type':'text/plain'});
        res.write('partial');
        throw new Error('failure after headers /private/secret');
      }
      if(req.query.mode==='twice'){ res.json({first:true}); return res.json({second:true}); }
      return res.json({body:req.body});
    },
  };
  // A logger without methods must still be safe to call.
  const runtime=await startLocalDevelopmentServer({config,handlers,logger:{}});
  cleanup.push(()=>runtime.close());

  const get=async path=>{
    const response=await fetch(new URL(path,runtime.url));
    return {status:response.status,body:await response.json()};
  };
  assert.deepEqual((await get('/api/health/live')).body.query,{endpoint:'health',probe:'live'});
  assert.deepEqual((await get('/api/readyz')).body.query,{endpoint:'health',probe:'ready'});
  assert.deepEqual((await get('/api/healthz')).body.query,{endpoint:'health',probe:'live'});
  assert.deepEqual((await get('/api/health/ready')).body.query,{endpoint:'health',probe:'ready'});
  assert.deepEqual((await get('/api/weeks')).body,{kind:'data',query:{endpoint:'weeks'},body:{}});
  assert.deepEqual((await get('/api/cron/outbox')).body.query,{endpoint:'outbox'});
  assert.deepEqual((await get('/api/cron/execution-smoke')).body.query,{endpoint:'execution-smoke'});
  assert.deepEqual((await get('/api/ai/feedback/a%20b')).body.query,{endpoint:'feedback',id:'a b'});
  assert.deepEqual((await get('/api/ai/history')).body.query,{endpoint:'history'});
  assert.deepEqual((await get('/api/video/join')).body.query,{endpoint:'join'});
  assert.deepEqual((await get('/api/invitations/prepare')).body.query,{endpoint:'prepare'});
  assert.deepEqual((await get('/api/invitations')).body.query,{endpoint:'invitations'});
  assert.deepEqual((await get('/api/invitations?endpoint=custom')).body.query,{endpoint:'custom'});
  assert.equal((await get('/api/code-document')).body.kind,'codeDocument');
  assert.equal((await get('/api/circles')).body.kind,'circles');
  assert.equal((await get('/api/video/unknown')).status,404);
  assert.equal((await get('/api/ai/analyze/a/b')).status,404);

  const silent=await get('/api/auth?mode=silent');
  assert.deepEqual(silent,{status:500,body:{ok:false,error:'LOCAL_INTERNAL_ERROR'}});
  assert.equal((await fetch(new URL('/api/auth?mode=status',runtime.url))).status,500,
    'out-of-range status codes become 500');
  assert.deepEqual((await get('/api/auth?mode=twice')).body,{first:true});

  const partial=await rawRequest(runtime.url,{path:'/api/auth?mode=partial'});
  assert.equal(partial.status,202,'a failure after headers keeps the sent status');
  assert.equal(partial.body,'partial');
  assert.doesNotMatch(partial.body,/private|secret/);

  const empty=await rawRequest(runtime.url,{path:'/api/auth',method:'POST',headers:{'content-type':'application/json'}});
  assert.deepEqual(JSON.parse(empty.body),{body:{}});
  const nullBody=await rawRequest(runtime.url,{path:'/api/auth',method:'POST',
    headers:{'content-type':'application/json; charset=utf-8'},body:'null'});
  assert.deepEqual(JSON.parse(nullBody.body),{ok:false,error:'LOCAL_BODY_INVALID'});
  const chunk=Buffer.alloc(256*1024,'a');
  const streamed=await rawRequest(runtime.url,{path:'/api/auth',method:'POST',
    headers:{'content-type':'application/json'},chunks:[chunk,chunk,chunk,chunk,chunk]});
  assert.equal(streamed.status,413,'chunked bodies are limited even without content-length');
  assert.deepEqual(JSON.parse(streamed.body),{ok:false,error:'LOCAL_BODY_TOO_LARGE'});

  const port=new URL(runtime.url).port;
  const localhostAlias=await rawRequest(runtime.url,{path:'/api/weeks',headers:{host:`localhost:${port}`}});
  assert.equal(localhostAlias.status,403,'only the advertised host is accepted');
});

test('static serving honours HEAD, refuses writes, and blocks dot paths',async()=>{
  const rootDir=workspace();
  mkdirSync(join(rootDir,'assets'));
  writeFileSync(join(rootDir,'assets','app.css'),'body{color:red}');
  writeFileSync(join(rootDir,'assets','linked.css'),'x');
  symlinkSync(join(rootDir,'assets','app.css'),join(rootDir,'assets','alias.css'));
  writeFileSync(join(rootDir,'index.html'),readFileSync(join(REPOSITORY_ROOT,'index.html')));
  const config=configFor(rootDir);
  const runtime=await startLocalDevelopmentServer({config,logger:SILENT_LOGGER});
  cleanup.push(()=>runtime.close());

  const headIndex=await rawRequest(runtime.url,{path:'/reset-password',method:'HEAD'});
  assert.equal(headIndex.status,200);
  assert.equal(headIndex.body,'');
  assert.match(headIndex.headers['content-security-policy'],/default-src 'self'/);

  const index=await fetch(new URL('/verify',runtime.url));
  const html=await index.text();
  assert.match(html,/window\.__RANDORI_LOCAL_RUNTIME__=true/);
  assert.doesNotMatch(html,/fonts\.googleapis\.com\/css2|sentry-cdn\.com/,'external assets are stripped locally');

  const headAsset=await rawRequest(runtime.url,{path:'/assets/app.css',method:'HEAD'});
  assert.equal(headAsset.status,200);
  assert.equal(headAsset.headers['content-type'],'text/css; charset=utf-8');
  assert.equal(headAsset.body,'');
  const asset=await fetch(new URL('/assets/app.css',runtime.url));
  assert.equal(await asset.text(),'body{color:red}');

  assert.equal((await fetch(new URL('/assets/alias.css',runtime.url))).status,404,'symlinked assets are not served');
  assert.equal((await fetch(new URL('/assets/missing.css',runtime.url))).status,404);
  assert.equal((await fetch(new URL('/assets/app.exe',runtime.url))).status,404,'unknown extensions are not served');

  const post=await rawRequest(runtime.url,{path:'/assets/app.css',method:'POST',body:'x'});
  assert.equal(post.status,405);
  assert.equal(post.headers.allow,'GET, HEAD');
  for(const path of ['/.env','/assets/.hidden.css','/a%5cb','/a%00b','/%E0%A4%A']){
    const response=await rawRequest(runtime.url,{path});
    assert.equal(response.status,403,path);
    assert.equal(response.body,'Forbidden');
  }
});

test('a missing index document is a plain 404',async()=>{
  const rootDir=workspace();
  const config=configFor(rootDir);
  const runtime=await startLocalDevelopmentServer({config,logger:SILENT_LOGGER});
  cleanup.push(()=>runtime.close());
  const response=await fetch(new URL('/',runtime.url));
  assert.equal(response.status,404);
  assert.equal(await response.text(),'Not found');
});
