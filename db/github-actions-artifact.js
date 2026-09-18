import { inflateRawSync } from 'node:zlib';

const DEFAULT_API_URL='https://api.github.com';
const DEFAULT_TIMEOUT_MS=15_000;
const DEFAULT_MAX_JSON_BYTES=256*1024;
const DEFAULT_MAX_ARCHIVE_BYTES=512*1024;
const DEFAULT_MAX_ARTIFACT_BYTES=64*1024;
const REPOSITORY=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const WORKFLOW_PATH=/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const ARTIFACT_NAME=/^[A-Za-z0-9_.-]{1,128}$/;

const PUBLIC_MESSAGES=Object.freeze({
  GITHUB_ACTIONS_INVALID:'GitHub Actions evidence configuration is invalid.',
  GITHUB_ACTIONS_TIMEOUT:'The GitHub Actions evidence request timed out.',
  GITHUB_ACTIONS_NOT_FOUND:'The requested GitHub Actions evidence was not found.',
  GITHUB_ACTIONS_REJECTED:'GitHub rejected the Actions evidence request.',
  GITHUB_ACTIONS_RESPONSE_INVALID:'GitHub returned invalid Actions evidence.',
  GITHUB_ACTIONS_ARTIFACT_INVALID:'The GitHub Actions evidence artifact is invalid.',
  GITHUB_ACTIONS_FAILED:'The GitHub Actions evidence request failed.',
});

export class GitHubActionsError extends Error{
  constructor(code,message,{cause,status}={}){
    super(message,cause?{cause}:undefined);
    this.name='GitHubActionsError';
    this.code=code;
    if(Number.isSafeInteger(status)) this.status=status;
  }
}

function fail(code,message,details){ throw new GitHubActionsError(code,message,details); }

function positiveInteger(value,label,{maximum=Number.MAX_SAFE_INTEGER}={}){
  const number=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(number)||number<1||number>maximum){
    fail('GITHUB_ACTIONS_INVALID',`${label} is invalid`);
  }
  return number;
}

function exactString(value,label,pattern,{maximum=512}={}){
  if(typeof value!=='string'||value.length===0||value!==value.trim()
    ||Buffer.byteLength(value,'utf8')>maximum||!pattern.test(value)
    ||/[\u0000-\u001f\u007f]/u.test(value)){
    fail('GITHUB_ACTIONS_INVALID',`${label} is invalid`);
  }
  return value;
}

function apiOrigin(value){
  let parsed;
  try{ parsed=new URL(value); }catch{ fail('GITHUB_ACTIONS_INVALID','GitHub API URL is invalid'); }
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash
    ||parsed.pathname!=='/'||parsed.origin==='null'){
    fail('GITHUB_ACTIONS_INVALID','GitHub API URL is invalid');
  }
  return parsed.origin;
}

function freeze(value){
  if(ArrayBuffer.isView(value)) return value;
  if(Array.isArray(value)) return Object.freeze(value.map(freeze));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key,item])=>[key,freeze(item)]),
    ));
  }
  return value;
}

function publicCode(status){
  if(status===404) return 'GITHUB_ACTIONS_NOT_FOUND';
  return 'GITHUB_ACTIONS_REJECTED';
}

function isAbort(error,signal){
  return signal.aborted||error?.name==='AbortError'||error?.code==='ABORT_ERR';
}

async function boundedBytes(response,maximum){
  const declared=response.headers?.get?.('content-length');
  if(declared!==null&&declared!==undefined){
    const size=Number(declared);
    if(!Number.isSafeInteger(size)||size<0||size>maximum){
      fail('GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response size is invalid');
    }
  }
  const reader=response.body?.getReader?.();
  if(!reader){
    fail('GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response body is invalid');
  }
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      if(!(value instanceof Uint8Array)){
        fail('GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response chunk is invalid');
      }
      total+=value.byteLength;
      if(total>maximum){
        try{ await reader.cancel(); }catch{}
        fail('GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response is too large');
      }
      chunks.push(value);
    }
  }catch(error){
    if(error instanceof GitHubActionsError) throw error;
    throw new GitHubActionsError(
      'GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response could not be read',{cause:error},
    );
  }
  const bytes=new Uint8Array(total);
  let offset=0;
  for(const chunk of chunks){
    bytes.set(chunk,offset);
    offset+=chunk.byteLength;
  }
  return bytes;
}

function jsonBytes(bytes){
  try{ return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch(error){
    throw new GitHubActionsError(
      'GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response JSON is invalid',{cause:error},
    );
  }
}

function trustedArtifactRedirect(value){
  let parsed;
  try{ parsed=new URL(value); }catch{
    fail('GITHUB_ACTIONS_RESPONSE_INVALID','artifact redirect is invalid');
  }
  const hostname=parsed.hostname.toLowerCase();
  const trusted=parsed.protocol==='https:'&&!parsed.username&&!parsed.password
    &&(hostname.endsWith('.blob.core.windows.net')
      ||hostname.endsWith('.actions.githubusercontent.com')
      ||hostname.endsWith('.githubusercontent.com'));
  if(!trusted) fail('GITHUB_ACTIONS_RESPONSE_INVALID','artifact redirect is invalid');
  return parsed.href;
}

function exactApiArtifactUrl(value,origin,repository,artifactId){
  let parsed;
  try{ parsed=new URL(value); }catch{
    fail('GITHUB_ACTIONS_RESPONSE_INVALID','artifact URL is invalid');
  }
  const expected=`/repos/${repository}/actions/artifacts/${artifactId}/zip`;
  if(parsed.origin!==origin||parsed.pathname!==expected||parsed.search||parsed.hash
    ||parsed.username||parsed.password){
    fail('GITHUB_ACTIONS_RESPONSE_INVALID','artifact URL is invalid');
  }
  return parsed.href;
}

function runMetadata(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('GITHUB_ACTIONS_RESPONSE_INVALID','workflow run response is invalid');
  }
  const repository=value.repository;
  if(value.id!==expected.runId||value.run_attempt!==expected.runAttempt
    ||value.event!=='workflow_dispatch'||value.status!=='completed'||value.conclusion!=='success'
    ||value.head_branch!==expected.defaultBranch||value.head_sha!==expected.headSha
    ||value.path!==expected.workflowPath||repository?.id!==expected.repositoryId
    ||repository?.full_name!==expected.repository){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','workflow run identity is invalid');
  }
  return freeze({
    id:value.id,
    runAttempt:value.run_attempt,
    event:value.event,
    status:value.status,
    conclusion:value.conclusion,
    headBranch:value.head_branch,
    headSha:value.head_sha,
    workflowPath:value.path,
    repository:{id:repository.id,fullName:repository.full_name},
  });
}

function artifactMetadata(value,expected,origin){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||!Number.isSafeInteger(value.id)||value.id<1||value.name!==expected.artifactName
    ||value.expired!==false||!Number.isSafeInteger(value.size_in_bytes)
    ||value.size_in_bytes<1||value.size_in_bytes>expected.maxArchiveBytes
    ||value.workflow_run?.id!==expected.runId
    ||value.workflow_run?.head_sha!==expected.headSha){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact metadata is invalid');
  }
  const archiveUrl=exactApiArtifactUrl(
    value.archive_download_url,origin,expected.repository,value.id,
  );
  return freeze({id:value.id,name:value.name,size:value.size_in_bytes,archiveUrl});
}

function crc32(bytes){
  let crc=0xffffffff;
  for(const byte of bytes){
    crc^=byte;
    for(let bit=0;bit<8;bit+=1) crc=(crc>>>1)^(0xedb88320&-(crc&1));
  }
  return (crc^0xffffffff)>>>0;
}

function decodeFilename(bytes){
  try{ return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch(error){
    throw new GitHubActionsError(
      'GITHUB_ACTIONS_ARTIFACT_INVALID','artifact filename is invalid',{cause:error},
    );
  }
}

function assertRange(bytes,offset,length){
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<0
    ||offset+length>bytes.byteLength){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact archive is truncated');
  }
}

function findEndOfCentralDirectory(bytes){
  const minimum=Math.max(0,bytes.byteLength-(0xffff+22));
  for(let offset=bytes.byteLength-22;offset>=minimum;offset-=1){
    if(bytes[offset]===0x50&&bytes[offset+1]===0x4b
      &&bytes[offset+2]===0x05&&bytes[offset+3]===0x06) return offset;
  }
  fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP footer is missing');
}

export function extractSingleJsonArtifact(archive,options={}){
  const bytes=archive instanceof Uint8Array?archive:null;
  if(!bytes||bytes.byteLength<22||bytes.byteLength>(options.maxArchiveBytes??DEFAULT_MAX_ARCHIVE_BYTES)){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact archive size is invalid');
  }
  const filename=exactString(
    options.filename,'artifact filename',/^[A-Za-z0-9_.-]+\.json$/,{maximum:128},
  );
  const maximum=positiveInteger(
    options.maxArtifactBytes??DEFAULT_MAX_ARTIFACT_BYTES,
    'maximum artifact size',{maximum:1024*1024},
  );
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const eocd=findEndOfCentralDirectory(bytes);
  assertRange(bytes,eocd,22);
  const commentLength=view.getUint16(eocd+20,true);
  if(eocd+22+commentLength!==bytes.byteLength||view.getUint16(eocd+4,true)!==0
    ||view.getUint16(eocd+6,true)!==0||view.getUint16(eocd+8,true)!==1
    ||view.getUint16(eocd+10,true)!==1){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP layout is invalid');
  }
  const centralSize=view.getUint32(eocd+12,true);
  const centralOffset=view.getUint32(eocd+16,true);
  if(centralOffset===0xffffffff||centralSize===0xffffffff
    ||centralOffset+centralSize!==eocd){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP directory is invalid');
  }
  assertRange(bytes,centralOffset,46);
  if(view.getUint32(centralOffset,true)!==0x02014b50){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP entry is invalid');
  }
  const flags=view.getUint16(centralOffset+8,true);
  const method=view.getUint16(centralOffset+10,true);
  const expectedCrc=view.getUint32(centralOffset+16,true);
  const compressedSize=view.getUint32(centralOffset+20,true);
  const uncompressedSize=view.getUint32(centralOffset+24,true);
  const centralNameLength=view.getUint16(centralOffset+28,true);
  const centralExtraLength=view.getUint16(centralOffset+30,true);
  const centralCommentLength=view.getUint16(centralOffset+32,true);
  const localOffset=view.getUint32(centralOffset+42,true);
  const centralEntrySize=46+centralNameLength+centralExtraLength+centralCommentLength;
  if(localOffset!==0||compressedSize===0xffffffff||uncompressedSize===0xffffffff
    ||uncompressedSize<1||uncompressedSize>maximum||![0,8].includes(method)
    ||(flags&~((1<<3)|(1<<11)))!==0||centralEntrySize!==centralSize){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP entry is unsupported');
  }
  assertRange(bytes,centralOffset+46,centralNameLength);
  const centralName=decodeFilename(bytes.subarray(
    centralOffset+46,centralOffset+46+centralNameLength,
  ));
  if(centralName!==filename){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP filename is invalid');
  }
  assertRange(bytes,localOffset,30);
  if(view.getUint32(localOffset,true)!==0x04034b50){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP local entry is invalid');
  }
  const localFlags=view.getUint16(localOffset+6,true);
  const localMethod=view.getUint16(localOffset+8,true);
  const localNameLength=view.getUint16(localOffset+26,true);
  const localExtraLength=view.getUint16(localOffset+28,true);
  const dataOffset=localOffset+30+localNameLength+localExtraLength;
  const dataEnd=dataOffset+compressedSize;
  assertRange(bytes,localOffset+30,localNameLength+localExtraLength+compressedSize);
  const localName=decodeFilename(bytes.subarray(localOffset+30,localOffset+30+localNameLength));
  if(localName!==filename||localFlags!==flags||localMethod!==method||dataEnd>centralOffset){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP local entry does not match');
  }
  if((flags&(1<<3))===0){
    if(view.getUint32(localOffset+14,true)!==expectedCrc
      ||view.getUint32(localOffset+18,true)!==compressedSize
      ||view.getUint32(localOffset+22,true)!==uncompressedSize
      ||dataEnd!==centralOffset){
      fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP sizes do not match');
    }
  }else{
    const descriptorSize=centralOffset-dataEnd;
    if(![12,16].includes(descriptorSize)){
      fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP descriptor is invalid');
    }
    const descriptorOffset=dataEnd+(descriptorSize===16?4:0);
    if(descriptorSize===16&&view.getUint32(dataEnd,true)!==0x08074b50
      ||view.getUint32(descriptorOffset,true)!==expectedCrc
      ||view.getUint32(descriptorOffset+4,true)!==compressedSize
      ||view.getUint32(descriptorOffset+8,true)!==uncompressedSize){
      fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP descriptor does not match');
    }
  }
  const compressed=bytes.subarray(dataOffset,dataEnd);
  let content;
  try{
    content=method===0?new Uint8Array(compressed):new Uint8Array(inflateRawSync(compressed,{
      maxOutputLength:maximum,
    }));
  }catch(error){
    throw new GitHubActionsError(
      'GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP content is invalid',{cause:error},
    );
  }
  if(content.byteLength!==uncompressedSize||crc32(content)!==expectedCrc){
    fail('GITHUB_ACTIONS_ARTIFACT_INVALID','artifact ZIP checksum does not match');
  }
  let value;
  try{ value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content)); }
  catch(error){
    throw new GitHubActionsError(
      'GITHUB_ACTIONS_ARTIFACT_INVALID','artifact JSON is invalid',{cause:error},
    );
  }
  return freeze(value);
}

export function publicGitHubActionsError(error){
  const code=error instanceof GitHubActionsError&&PUBLIC_MESSAGES[error.code]
    ?error.code:'GITHUB_ACTIONS_FAILED';
  return Object.freeze({ok:false,error:code,message:PUBLIC_MESSAGES[code]});
}

export function createGitHubActionsClient(options={}){
  const repository=exactString(options.repository,'repository',REPOSITORY,{maximum:200});
  if(typeof options.token!=='string'||options.token.length<16||options.token.length>16*1024
    ||options.token!==options.token.trim()||/[\u0000-\u001f\u007f]/u.test(options.token)){
    fail('GITHUB_ACTIONS_INVALID','GitHub token is invalid');
  }
  const token=options.token;
  const fetchImpl=options.fetchImpl??globalThis.fetch;
  if(typeof fetchImpl!=='function') fail('GITHUB_ACTIONS_INVALID','fetch implementation is invalid');
  const origin=apiOrigin(options.baseUrl??DEFAULT_API_URL);
  const timeoutMs=positiveInteger(
    options.timeoutMs??DEFAULT_TIMEOUT_MS,'GitHub request timeout',{maximum:60_000},
  );
  const maxJsonBytes=positiveInteger(
    options.maxJsonBytes??DEFAULT_MAX_JSON_BYTES,'maximum GitHub JSON size',{maximum:1024*1024},
  );
  const maxArchiveBytes=positiveInteger(
    options.maxArchiveBytes??DEFAULT_MAX_ARCHIVE_BYTES,
    'maximum artifact archive size',{maximum:4*1024*1024},
  );
  const repositoryPath=`/repos/${repository}`;

  async function fetchResponse(url,{authorize=true,maximum=maxJsonBytes}={}){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      let response;
      try{
        response=await fetchImpl(url,{
          method:'GET',
          headers:{
            accept:'application/vnd.github+json',
            ...(authorize?{authorization:`Bearer ${token}`}:{ }),
            'x-github-api-version':'2022-11-28',
          },
          redirect:'manual',
          signal:controller.signal,
        });
      }catch(error){
        if(isAbort(error,controller.signal)){
          throw new GitHubActionsError(
            'GITHUB_ACTIONS_TIMEOUT','GitHub request timed out',{cause:error},
          );
        }
        throw new GitHubActionsError('GITHUB_ACTIONS_FAILED','GitHub request failed',{cause:error});
      }
      if(!response||typeof response.status!=='number'){
        fail('GITHUB_ACTIONS_RESPONSE_INVALID','GitHub response metadata is invalid');
      }
      if(!response.ok){
        throw new GitHubActionsError(publicCode(response.status),'GitHub request was rejected',{
          status:response.status,
        });
      }
      return boundedBytes(response,maximum);
    }finally{ clearTimeout(timer); }
  }

  async function json(path){
    return jsonBytes(await fetchResponse(`${origin}${path}`));
  }

  async function downloadArchive(url){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      let response;
      try{
        response=await fetchImpl(url,{
          method:'GET',
          headers:{
            accept:'application/vnd.github+json',authorization:`Bearer ${token}`,
            'x-github-api-version':'2022-11-28',
          },
          redirect:'manual',signal:controller.signal,
        });
        if([301,302,303,307,308].includes(response?.status)){
          const redirect=trustedArtifactRedirect(response.headers?.get?.('location'));
          response=await fetchImpl(redirect,{
            method:'GET',headers:{accept:'application/zip'},redirect:'error',signal:controller.signal,
          });
        }
      }catch(error){
        if(isAbort(error,controller.signal)){
          throw new GitHubActionsError(
            'GITHUB_ACTIONS_TIMEOUT','artifact download timed out',{cause:error},
          );
        }
        if(error instanceof GitHubActionsError) throw error;
        throw new GitHubActionsError('GITHUB_ACTIONS_FAILED','artifact download failed',{cause:error});
      }
      if(!response?.ok){
        throw new GitHubActionsError(publicCode(response?.status),'artifact download was rejected',{
          status:Number.isSafeInteger(response?.status)?response.status:undefined,
        });
      }
      return boundedBytes(response,maxArchiveBytes);
    }finally{ clearTimeout(timer); }
  }

  return freeze({
    async downloadSuccessfulWorkflowArtifact(raw={}){
      const expected={
        repository,
        repositoryId:positiveInteger(raw.repositoryId,'repository ID'),
        runId:positiveInteger(raw.runId,'workflow run ID'),
        runAttempt:positiveInteger(raw.runAttempt,'workflow run attempt',{maximum:1_000_000}),
        defaultBranch:exactString(
          raw.defaultBranch,'default branch',/^[A-Za-z0-9._/-]+$/,{maximum:128},
        ),
        workflowPath:exactString(raw.workflowPath,'workflow path',WORKFLOW_PATH,{maximum:256}),
        headSha:exactString(raw.headSha,'workflow commit',COMMIT,{maximum:64}),
        artifactName:exactString(raw.artifactName,'artifact name',ARTIFACT_NAME,{maximum:128}),
        maxArchiveBytes,
      };
      const run=runMetadata(
        await json(`${repositoryPath}/actions/runs/${expected.runId}`),expected,
      );
      const listing=await json(
        `${repositoryPath}/actions/runs/${expected.runId}/artifacts?per_page=100`,
      );
      if(!listing||typeof listing!=='object'||Array.isArray(listing)
        ||!Number.isSafeInteger(listing.total_count)||listing.total_count<0
        ||!Array.isArray(listing.artifacts)||listing.total_count!==listing.artifacts.length
        ||listing.total_count>100){
        fail('GITHUB_ACTIONS_RESPONSE_INVALID','artifact listing is invalid');
      }
      const matches=listing.artifacts.filter(item=>item?.name===expected.artifactName);
      if(matches.length!==1){
        fail('GITHUB_ACTIONS_ARTIFACT_INVALID','expected artifact is missing or duplicated');
      }
      const artifact=artifactMetadata(matches[0],expected,origin);
      const archive=await downloadArchive(artifact.archiveUrl);
      return freeze({run,artifact,archive});
    },
  });
}
