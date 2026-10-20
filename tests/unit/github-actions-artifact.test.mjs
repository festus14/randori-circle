import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';

import {
  GitHubActionsError,
  createGitHubActionsClient,
  extractSingleJsonArtifact,
  publicGitHubActionsError,
} from '../../db/github-actions-artifact.js';

const REPOSITORY='festus14/randori-circle';
const REPOSITORY_ID=123456;
const RUN_ID=987654321;
const ATTEMPT=2;
const COMMIT='0123456789abcdef0123456789abcdef01234567';
const WORKFLOW='.github/workflows/turso-backup-restore-rehearsal.yml';
const ARTIFACT=`turso-backup-restore-rehearsal-${RUN_ID}-${ATTEMPT}`;
const TOKEN='github-actions-token-that-must-not-leak';

function crc32(bytes){
  let crc=0xffffffff;
  for(const byte of bytes){
    crc^=byte;
    for(let bit=0;bit<8;bit+=1) crc=(crc>>>1)^(0xedb88320&-(crc&1));
  }
  return (crc^0xffffffff)>>>0;
}

function zip(filename,value,{deflate=true,flags=0x0800,crcOffset=0,extraEntry=false}={}){
  const name=Buffer.from(filename,'utf8');
  const content=Buffer.from(typeof value==='string'?value:JSON.stringify(value),'utf8');
  const compressed=deflate?deflateRawSync(content):content;
  const method=deflate?8:0;
  const crc=(crc32(content)+crcOffset)>>>0;
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);
  local.writeUInt16LE(20,4);
  local.writeUInt16LE(flags,6);
  local.writeUInt16LE(method,8);
  local.writeUInt32LE(crc,14);
  local.writeUInt32LE(compressed.length,18);
  local.writeUInt32LE(content.length,22);
  local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE(20,4);
  central.writeUInt16LE(20,6);
  central.writeUInt16LE(flags,8);
  central.writeUInt16LE(method,10);
  central.writeUInt32LE(crc,16);
  central.writeUInt32LE(compressed.length,20);
  central.writeUInt32LE(content.length,24);
  central.writeUInt16LE(name.length,28);
  central.writeUInt32LE(0,42);
  const centralEntry=Buffer.concat([central,name]);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(extraEntry?2:1,8);
  eocd.writeUInt16LE(extraEntry?2:1,10);
  eocd.writeUInt32LE(centralEntry.length,12);
  eocd.writeUInt32LE(local.length+name.length+compressed.length,16);
  return new Uint8Array(Buffer.concat([local,name,compressed,centralEntry,eocd]));
}

function json(value,status=200,headers={}){
  return new Response(JSON.stringify(value),{
    status,headers:{'content-type':'application/json',...headers},
  });
}

function binary(bytes,status=200,headers={}){
  return new Response(bytes,{status,headers:{'content-type':'application/zip',...headers}});
}

function run(overrides={}){
  return {
    id:RUN_ID,run_attempt:ATTEMPT,event:'workflow_dispatch',status:'completed',
    conclusion:'success',head_branch:'main',head_sha:COMMIT,path:WORKFLOW,
    repository:{id:REPOSITORY_ID,full_name:REPOSITORY},
    ...overrides,
  };
}

function artifact(overrides={}){
  return {
    id:456,name:ARTIFACT,expired:false,size_in_bytes:1024,
    archive_download_url:`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/456/zip`,
    workflow_run:{id:RUN_ID,head_sha:COMMIT},
    ...overrides,
  };
}

function expected(){
  return {
    repositoryId:REPOSITORY_ID,runId:RUN_ID,runAttempt:ATTEMPT,
    defaultBranch:'main',workflowPath:WORKFLOW,headSha:COMMIT,artifactName:ARTIFACT,
  };
}

function recorder(responses){
  const calls=[];
  return {
    calls,
    async fetch(url,options){
      calls.push({url,options});
      const response=responses.shift();
      if(response instanceof Error) throw response;
      if(typeof response==='function') return response(url,options);
      return response;
    },
  };
}

test('Actions client binds the exact successful run, artifact, repository, and commit',async()=>{
  const archive=zip('rehearsal-summary.json',{ok:true,signature:'a'.repeat(64)});
  const record=recorder([
    json(run()),
    json({total_count:1,artifacts:[artifact()]}),
    binary(archive),
  ]);
  const client=createGitHubActionsClient({
    repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch,
  });
  const result=await client.downloadSuccessfulWorkflowArtifact(expected());
  assert.equal(result.run.conclusion,'success');
  assert.equal(result.run.workflowPath,WORKFLOW);
  assert.equal(result.artifact.name,ARTIFACT);
  assert.deepEqual(extractSingleJsonArtifact(result.archive,{
    filename:'rehearsal-summary.json',
  }),{ok:true,signature:'a'.repeat(64)});
  assert.deepEqual(record.calls.map(call=>new URL(call.url).pathname),[
    `/repos/${REPOSITORY}/actions/runs/${RUN_ID}`,
    `/repos/${REPOSITORY}/actions/runs/${RUN_ID}/artifacts`,
    `/repos/${REPOSITORY}/actions/artifacts/456/zip`,
  ]);
  assert.ok(record.calls.every(call=>call.options.redirect==='manual'));
  assert.ok(record.calls.every(call=>call.options.headers.authorization===`Bearer ${TOKEN}`));
});

test('artifact redirects are restricted and the database-neutral download drops authorization',async()=>{
  const archive=zip('rehearsal-summary.json',{ok:true});
  const record=recorder([
    json(run()),
    json({total_count:1,artifacts:[artifact()]}),
    new Response(null,{
      status:302,
      headers:{location:'https://results-receiver.actions.githubusercontent.com/signed/archive.zip?sig=x'},
    }),
    (url,options)=>{
      assert.equal(new URL(url).hostname,'results-receiver.actions.githubusercontent.com');
      assert.equal(options.headers.authorization,undefined);
      assert.equal(options.redirect,'error');
      return binary(archive);
    },
  ]);
  const client=createGitHubActionsClient({
    repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch,
  });
  const result=await client.downloadSuccessfulWorkflowArtifact(expected());
  assert.equal(extractSingleJsonArtifact(result.archive,{
    filename:'rehearsal-summary.json',
  }).ok,true);

  const rejected=recorder([
    json(run()),json({total_count:1,artifacts:[artifact()]}),
    new Response(null,{status:302,headers:{location:'https://attacker.example/archive.zip'}}),
  ]);
  await assert.rejects(
    createGitHubActionsClient({repository:REPOSITORY,token:TOKEN,fetchImpl:rejected.fetch})
      .downloadSuccessfulWorkflowArtifact(expected()),
    error=>error instanceof GitHubActionsError
      &&error.code==='GITHUB_ACTIONS_RESPONSE_INVALID',
  );
});

test('workflow metadata mismatches and ambiguous artifact listings are refused',async()=>{
  for(const invalid of [
    {run_attempt:3},
    {conclusion:'failure'},
    {status:'in_progress'},
    {event:'push'},
    {head_branch:'feature'},
    {head_sha:'f'.repeat(40)},
    {path:'.github/workflows/other.yml'},
    {repository:{id:999,full_name:REPOSITORY}},
    {repository:{id:REPOSITORY_ID,full_name:'other/repository'}},
  ]){
    const record=recorder([json(run(invalid))]);
    const client=createGitHubActionsClient({
      repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch,
    });
    await assert.rejects(
      client.downloadSuccessfulWorkflowArtifact(expected()),
      error=>error.code==='GITHUB_ACTIONS_ARTIFACT_INVALID',
    );
    assert.equal(record.calls.length,1);
  }

  for(const listing of [
    {total_count:0,artifacts:[]},
    {total_count:2,artifacts:[artifact(),artifact({id:457})]},
    {total_count:2,artifacts:[artifact()]},
  ]){
    const record=recorder([json(run()),json(listing)]);
    const client=createGitHubActionsClient({
      repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch,
    });
    await assert.rejects(client.downloadSuccessfulWorkflowArtifact(expected()));
    assert.equal(record.calls.length,2);
  }
});

test('artifact metadata is exact and bounded before download',async()=>{
  for(const invalid of [
    {expired:true},
    {size_in_bytes:600_000},
    {workflow_run:{id:RUN_ID+1,head_sha:COMMIT}},
    {workflow_run:{id:RUN_ID,head_sha:'f'.repeat(40)}},
    {archive_download_url:'https://api.github.com/repos/other/repo/actions/artifacts/456/zip'},
  ]){
    const record=recorder([
      json(run()),json({total_count:1,artifacts:[artifact(invalid)]}),
    ]);
    await assert.rejects(
      createGitHubActionsClient({repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch})
        .downloadSuccessfulWorkflowArtifact(expected()),
      error=>error.code==='GITHUB_ACTIONS_ARTIFACT_INVALID'
        ||error.code==='GITHUB_ACTIONS_RESPONSE_INVALID',
    );
    assert.equal(record.calls.length,2);
  }
});

test('ZIP parser rejects traversal, extra entries, corruption, and non-JSON payloads',()=>{
  for(const archive of [
    zip('../rehearsal-summary.json',{ok:true}),
    zip('rehearsal-summary.json',{ok:true},{extraEntry:true}),
    zip('rehearsal-summary.json',{ok:true},{crcOffset:1}),
    zip('rehearsal-summary.json','not-json'),
    new Uint8Array([1,2,3]),
  ]){
    assert.throws(
      ()=>extractSingleJsonArtifact(archive,{filename:'rehearsal-summary.json'}),
      error=>error.code==='GITHUB_ACTIONS_ARTIFACT_INVALID',
    );
  }
});

test('network, HTTP, malformed, oversized, and invalid configuration errors are sanitized',async()=>{
  for(const [response,code] of [
    [json({message:'secret provider detail'},404),'GITHUB_ACTIONS_NOT_FOUND'],
    [json({message:'secret provider detail'},403),'GITHUB_ACTIONS_REJECTED'],
    [new Response('not-json',{status:200}),'GITHUB_ACTIONS_RESPONSE_INVALID'],
    [json(run(),200,{'content-length':'999999'}),'GITHUB_ACTIONS_RESPONSE_INVALID'],
  ]){
    const client=createGitHubActionsClient({
      repository:REPOSITORY,token:TOKEN,fetchImpl:recorder([response]).fetch,
    });
    let observed;
    await assert.rejects(client.downloadSuccessfulWorkflowArtifact(expected()),error=>{
      observed=error;
      return error.code===code;
    });
    const serialized=JSON.stringify(publicGitHubActionsError(observed));
    assert.equal(serialized.includes(TOKEN),false);
    assert.equal(serialized.includes('secret provider detail'),false);
  }
  assert.throws(
    ()=>createGitHubActionsClient({repository:'bad repository',token:TOKEN}),
    error=>error.code==='GITHUB_ACTIONS_INVALID',
  );
  assert.throws(
    ()=>createGitHubActionsClient({repository:REPOSITORY,token:'short'}),
    error=>error.code==='GITHUB_ACTIONS_INVALID',
  );

  const streamed=createGitHubActionsClient({
    repository:REPOSITORY,token:TOKEN,maxJsonBytes:32,
    fetchImpl:recorder([new Response(JSON.stringify(run()))]).fetch,
  });
  await assert.rejects(
    streamed.downloadSuccessfulWorkflowArtifact(expected()),
    error=>error.code==='GITHUB_ACTIONS_RESPONSE_INVALID',
  );
});

// ZIP whose local header defers CRC and sizes to a trailing data descriptor (flag bit 3),
// as produced by streaming archivers. `signature` selects the 16-byte vs 12-byte form.
function descriptorZip(filename,value,{signature=true,descriptorCrcOffset=0,padding=0}={}){
  const name=Buffer.from(filename,'utf8');
  const content=Buffer.from(JSON.stringify(value),'utf8');
  const compressed=deflateRawSync(content);
  const flags=0x0808;
  const crc=crc32(content);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);
  local.writeUInt16LE(20,4);
  local.writeUInt16LE(flags,6);
  local.writeUInt16LE(8,8);
  local.writeUInt16LE(name.length,26);
  const descriptor=Buffer.alloc((signature?16:12)+padding);
  let offset=0;
  if(signature){ descriptor.writeUInt32LE(0x08074b50,0); offset=4; }
  descriptor.writeUInt32LE((crc+descriptorCrcOffset)>>>0,offset);
  descriptor.writeUInt32LE(compressed.length,offset+4);
  descriptor.writeUInt32LE(content.length,offset+8);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);
  central.writeUInt16LE(20,4);
  central.writeUInt16LE(20,6);
  central.writeUInt16LE(flags,8);
  central.writeUInt16LE(8,10);
  central.writeUInt32LE(crc,16);
  central.writeUInt32LE(compressed.length,20);
  central.writeUInt32LE(content.length,24);
  central.writeUInt16LE(name.length,28);
  const centralEntry=Buffer.concat([central,name]);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(1,8);
  eocd.writeUInt16LE(1,10);
  eocd.writeUInt32LE(centralEntry.length,12);
  eocd.writeUInt32LE(local.length+name.length+compressed.length+descriptor.length,16);
  return new Uint8Array(Buffer.concat([local,name,compressed,descriptor,centralEntry,eocd]));
}

test('streamed ZIP data descriptors are accepted only when they match the central directory',()=>{
  const options={filename:'rehearsal-summary.json'};
  assert.deepEqual(extractSingleJsonArtifact(descriptorZip('rehearsal-summary.json',{ok:1}),options),{ok:1});
  assert.deepEqual(
    extractSingleJsonArtifact(descriptorZip('rehearsal-summary.json',{ok:2},{signature:false}),options),
    {ok:2},
  );
  for(const archive of [
    descriptorZip('rehearsal-summary.json',{ok:true},{descriptorCrcOffset:1}),
    descriptorZip('rehearsal-summary.json',{ok:true},{padding:4}),
  ]){
    assert.throws(()=>extractSingleJsonArtifact(archive,options),error=>error.code==='GITHUB_ACTIONS_ARTIFACT_INVALID');
  }
  // A 16-byte gap without the descriptor signature is not a valid descriptor.
  const unsigned=descriptorZip('rehearsal-summary.json',{ok:true});
  const descriptorStart=30+'rehearsal-summary.json'.length+deflateRawSync(Buffer.from(JSON.stringify({ok:true}))).length;
  unsigned[descriptorStart]=0;
  assert.throws(()=>extractSingleJsonArtifact(unsigned,options),/descriptor does not match/);
});

test('ZIP parser rejects non-byte input, stored-entry corruption, and undecodable deflate data',()=>{
  const options={filename:'rehearsal-summary.json'};
  for(const archive of [Buffer.from('x').buffer,'PK',null,new Array(64).fill(0)]){
    assert.throws(()=>extractSingleJsonArtifact(archive,options),/archive size is invalid/);
  }
  const stored=zip('rehearsal-summary.json',{ok:true},{deflate:false});
  assert.deepEqual(extractSingleJsonArtifact(stored,options),{ok:true});
  assert.throws(()=>extractSingleJsonArtifact(stored,{...options,maxArchiveBytes:stored.byteLength-1}),/archive size/);
  assert.throws(()=>extractSingleJsonArtifact(stored,{...options,maxArtifactBytes:0}),/maximum artifact size is invalid/);
  assert.throws(()=>extractSingleJsonArtifact(stored,{...options,maxArtifactBytes:4}),/entry is unsupported/);
  assert.throws(()=>extractSingleJsonArtifact(stored,{filename:'other.json'}),/ZIP filename is invalid/);
  assert.throws(()=>extractSingleJsonArtifact(stored,{filename:'notes.txt'}),/artifact filename is invalid/);

  // Valid structure, but the deflate stream itself is garbage.
  const garbage=zip('rehearsal-summary.json','{"ok":true}');
  const dataStart=30+'rehearsal-summary.json'.length;
  garbage.fill(0xff,dataStart,dataStart+4);
  assert.throws(()=>extractSingleJsonArtifact(garbage,options),/ZIP content is invalid/);

  const noFooter=new Uint8Array(64);
  assert.throws(()=>extractSingleJsonArtifact(noFooter,options),/footer is missing/);
});

function streamResponse(chunks,{status=200,cancel}={}){
  let index=0;
  return {
    status,ok:status>=200&&status<300,
    headers:new Headers(),
    body:{getReader(){
      return {
        async read(){
          if(index>=chunks.length) return {done:true};
          const chunk=chunks[index++];
          if(chunk instanceof Error) throw chunk;
          return {done:false,value:chunk};
        },
        cancel,
      };
    }},
  };
}

async function rejection(response,options={}){
  const client=createGitHubActionsClient({
    repository:REPOSITORY,token:TOKEN,fetchImpl:recorder([response]).fetch,...options,
  });
  let observed;
  await assert.rejects(client.downloadSuccessfulWorkflowArtifact(expected()),error=>{ observed=error; return true; });
  return observed;
}

test('response bodies must be bounded byte streams and read failures are sanitized',async()=>{
  assert.equal((await rejection(new Response(null,{status:200}))).message,'GitHub response body is invalid');
  assert.equal((await rejection(streamResponse(['text chunk']))).message,'GitHub response chunk is invalid');
  const readFailure=await rejection(streamResponse([new Error('socket reset')]));
  assert.equal(readFailure.code,'GITHUB_ACTIONS_RESPONSE_INVALID');
  assert.equal(readFailure.message,'GitHub response could not be read');
  assert.equal(readFailure.cause.message,'socket reset');

  let cancelled=0;
  const oversized=await rejection(
    streamResponse([new Uint8Array(20),new Uint8Array(20)],{cancel(){ cancelled+=1; throw new Error('cancel failed'); }}),
    {maxJsonBytes:32},
  );
  assert.equal(oversized.message,'GitHub response is too large');
  assert.equal(cancelled,1);

  assert.equal((await rejection(null)).message,'GitHub response metadata is invalid');
  assert.equal((await rejection({status:'200',ok:true})).message,'GitHub response metadata is invalid');
  const network=await rejection(new TypeError('getaddrinfo ENOTFOUND'));
  assert.equal(network.code,'GITHUB_ACTIONS_FAILED');
  const aborted=await rejection(Object.assign(new Error('aborted'),{name:'AbortError'}));
  assert.equal(aborted.code,'GITHUB_ACTIONS_TIMEOUT');
  const abortCode=await rejection(Object.assign(new Error('aborted'),{code:'ABORT_ERR'}));
  assert.equal(abortCode.code,'GITHUB_ACTIONS_TIMEOUT');
});

test('artifact downloads sanitize network, timeout, and status-less failures',async()=>{
  async function downloadFailure(download){
    const record=recorder([json(run()),json({total_count:1,artifacts:[artifact()]}),download]);
    const client=createGitHubActionsClient({repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch});
    let observed;
    await assert.rejects(client.downloadSuccessfulWorkflowArtifact(expected()),error=>{ observed=error; return true; });
    return observed;
  }
  const network=await downloadFailure(new TypeError('connection refused'));
  assert.equal(network.code,'GITHUB_ACTIONS_FAILED');
  assert.equal(network.message,'artifact download failed');
  const timeout=await downloadFailure(Object.assign(new Error('aborted'),{name:'AbortError'}));
  assert.equal(timeout.code,'GITHUB_ACTIONS_TIMEOUT');
  const missing=await downloadFailure(null);
  assert.equal(missing.code,'GITHUB_ACTIONS_REJECTED');
  assert.equal(missing.status,undefined);
  const gone=await downloadFailure(binary(new Uint8Array([1]),410));
  assert.equal(gone.status,410);
  const badRedirect=await downloadFailure(new Response(null,{status:302,headers:{location:'::not a url'}}));
  assert.equal(badRedirect.message,'artifact redirect is invalid');
});

test('client configuration accepts decimal string IDs and rejects unsafe endpoints and limits',async()=>{
  const record=recorder([
    json(run()),
    json({total_count:1,artifacts:[artifact()]}),
    binary(zip('rehearsal-summary.json',{ok:true})),
  ]);
  const client=createGitHubActionsClient({repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch});
  const result=await client.downloadSuccessfulWorkflowArtifact({
    ...expected(),repositoryId:String(REPOSITORY_ID),runId:String(RUN_ID),runAttempt:String(ATTEMPT),
  });
  assert.equal(result.run.id,RUN_ID);
  for(const runId of ['0','01','1e3',' 5',-1,0,1.5]){
    await assert.rejects(
      client.downloadSuccessfulWorkflowArtifact({...expected(),runId}),
      error=>error.code==='GITHUB_ACTIONS_INVALID'&&/workflow run ID/.test(error.message),
    );
  }
  const invalid=error=>error.code==='GITHUB_ACTIONS_INVALID';
  const base={repository:REPOSITORY,token:TOKEN,fetchImpl:record.fetch};
  for(const baseUrl of ['not a url','http://api.github.com','https://api.github.com/v3','https://u:p@api.github.com','https://api.github.com/?q=1']){
    assert.throws(()=>createGitHubActionsClient({...base,baseUrl}),invalid);
  }
  assert.throws(()=>createGitHubActionsClient({...base,fetchImpl:'fetch'}),invalid);
  assert.throws(()=>createGitHubActionsClient({...base,timeoutMs:60_001}),invalid);
  assert.throws(()=>createGitHubActionsClient({...base,maxArchiveBytes:4*1024*1024+1}),invalid);
  assert.throws(()=>createGitHubActionsClient({...base,token:` ${TOKEN}`}),invalid);
  assert.throws(()=>createGitHubActionsClient({...base,token:`${TOKEN}\n`}),invalid);
  // Default fetch is the global implementation when none is injected.
  assert.equal(typeof createGitHubActionsClient({repository:REPOSITORY,token:TOKEN}).downloadSuccessfulWorkflowArtifact,'function');

  assert.deepEqual(publicGitHubActionsError(new Error('raw detail')),{
    ok:false,error:'GITHUB_ACTIONS_FAILED',message:'The GitHub Actions evidence request failed.',
  });
  assert.equal(publicGitHubActionsError(new GitHubActionsError('UNKNOWN_CODE','x')).error,'GITHUB_ACTIONS_FAILED');
});
