#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {createClient} from '@libsql/client';

import {
  credentialKeyControlStatus,
  transitionCredentialKeyControl,
} from '../api/_credential-key-control.js';
import {
  EMAIL_ACTIVATION_EVENT_TYPE,
  activationKeyRing,
} from '../api/_email-activation.js';
import {
  PASSWORD_RESET_EVENT_TYPE,
  passwordResetKeyRing,
} from '../api/_password-reset.js';
import {
  invitationEmailEnvelopeRotationMetrics,
  invitationKeyRing,
} from '../api/_invitation-email.js';
import {
  identityEmailHashConfiguration,
  identityEmailKeyMaterialStatus,
} from '../api/_identity-linking.js';
import {readCredentialRotationMetrics} from '../api/_key-rotation.js';

const ENVIRONMENT='credential-key-control';
const WORKFLOW='.github/workflows/credential-key-control.yml';
const PURPOSES=new Set([
  'email-activation','password-reset','invitation-email','identity-email-observation',
]);
const OPERATIONS=new Set(['status','adopt','advance']);
const PUBLIC_ERROR_CODES=new Set([
  'KEY_CONTROL_INPUT_INVALID','KEY_CONTROL_DISABLED','KEY_CONTROL_CONFIGURATION_INVALID',
  'KEY_CONTROL_MATERIAL_NOT_READY','KEY_CONTROL_RUNTIME_INVALID','KEY_CONTROL_STATE_INVALID',
  'KEY_CONTROL_UNINITIALIZED','KEY_CONTROL_ALREADY_ADOPTED','KEY_CONTROL_STATE_CHANGED',
  'KEY_CONTROL_SUBSTITUTION','KEY_CONTROL_DOWNGRADE','KEY_CONTROL_CONTINUITY_MISSING',
  'KEY_CONTROL_COMMIT_UNKNOWN','KEY_CONTROL_TRANSITION_FAILED',
]);

export class CredentialKeyControlCommandError extends Error{
  constructor(code,message,{cause}={}={}){
    super(message,cause?{cause}:undefined);
    this.name='CredentialKeyControlCommandError';
    this.code=code;
  }
}

function fail(code,message,cause){ throw new CredentialKeyControlCommandError(code,message,{cause}); }

function positiveInteger(value,label,{allowZero=false}={}){
  const text=String(value??'');
  if(!/^(?:0|[1-9][0-9]*)$/.test(text)) fail('KEY_CONTROL_INPUT_INVALID',`${label} is invalid`);
  const number=Number(text);
  if(!Number.isSafeInteger(number)||number<(allowZero?0:1)||number>2147483647){
    fail('KEY_CONTROL_INPUT_INVALID',`${label} is invalid`);
  }
  return number;
}

function options(value={}){
  const operation=String(value.operation||'');
  const purpose=String(value.purpose||'');
  if(!OPERATIONS.has(operation)||!PURPOSES.has(purpose)){
    fail('KEY_CONTROL_INPUT_INVALID','operation or purpose is invalid');
  }
  const confirmation=String(value.confirmation||'');
  if(confirmation!==(operation==='status'
    ?'INSPECT_CREDENTIAL_KEY_CONTROL':'CHANGE_CREDENTIAL_KEY_CONTROL')){
    fail('KEY_CONTROL_INPUT_INVALID','manual confirmation is invalid');
  }
  if(operation!=='status'&&value.mutationsEnabled!=='true'&&value.mutationsEnabled!==true){
    fail('KEY_CONTROL_DISABLED','credential key control mutation is disabled');
  }
  if(operation!=='advance'&&(String(value.expectedVersion||'').trim()
    ||String(value.expectedGeneration||'').trim())){
    fail('KEY_CONTROL_INPUT_INVALID','unexpected compare-and-swap input');
  }
  const expectedVersion=operation==='advance'
    ?positiveInteger(value.expectedVersion,'expected version'):null;
  const expectedGeneration=operation==='advance'
    ?positiveInteger(value.expectedGeneration,'expected generation'):null;
  return Object.freeze({operation,purpose,expectedVersion,expectedGeneration});
}

export function configuredPurposeRing(purpose,{localRuntime=false}={}){
  if(purpose==='email-activation') return activationKeyRing();
  if(purpose==='password-reset') return passwordResetKeyRing();
  if(purpose==='invitation-email') return invitationKeyRing({localRuntime});
  if(purpose==='identity-email-observation'){
    const configuration=identityEmailHashConfiguration();
    if(configuration) return configuration;
  }
  fail('KEY_CONTROL_CONFIGURATION_INVALID','credential key configuration is invalid');
}

async function materialStatus(db,purpose,ring){
  if(purpose==='email-activation'){
    return readCredentialRotationMetrics(db,{eventType:EMAIL_ACTIVATION_EVENT_TYPE,
      envelopeField:'token_envelope',ring});
  }
  if(purpose==='password-reset'){
    return readCredentialRotationMetrics(db,{eventType:PASSWORD_RESET_EVENT_TYPE,
      envelopeField:'token_envelope',ring});
  }
  if(purpose==='invitation-email'){
    return invitationEmailEnvelopeRotationMetrics(db,{ring});
  }
  return identityEmailKeyMaterialStatus(db,{configuration:ring});
}

function knownContradiction(metrics){
  return Number(metrics.malformed||0)>0||Number(metrics.missing_key||0)>0
    ||Number(metrics.fingerprint_mismatch||0)>0
    ||Number(metrics.key_version_ahead||metrics.future_version||0)>0
    ||Number(metrics.future||0)>0;
}

export async function runCredentialKeyControl(db,rawOptions,{localRuntime=false}={}){
  const input=options(rawOptions);
  const ring=configuredPurposeRing(input.purpose,{localRuntime});
  if(input.operation==='status'){
    return Object.freeze({ok:true,operation:'status',purpose:input.purpose,
      control:await credentialKeyControlStatus(db,ring),
      material:await materialStatus(db,input.purpose,ring)});
  }
  const validateCandidate=async(transaction,candidateRing,{operation})=>{
    const metrics=await materialStatus(transaction,input.purpose,candidateRing);
    if(knownContradiction(metrics)||(operation==='advance'&&metrics.ready!==true)){
      fail('KEY_CONTROL_MATERIAL_NOT_READY','credential material is not safe for this transition');
    }
  };
  const result=await transitionCredentialKeyControl(db,{operation:input.operation,ring,
    expectedVersion:input.expectedVersion,expectedGeneration:input.expectedGeneration,
    validateCandidate});
  return Object.freeze({...result,operation:input.operation});
}

function parseArgv(argv){
  const allowed=new Set(['operation','purpose','expected-version','expected-generation']);
  const values={};
  for(let index=0;index<argv.length;index+=2){
    const key=argv[index];
    const value=argv[index+1];
    const name=key?.startsWith('--')?key.slice(2):'';
    if(!allowed.has(name)||Object.prototype.hasOwnProperty.call(values,name)||value===undefined){
      fail('KEY_CONTROL_INPUT_INVALID','usage is invalid');
    }
    values[name]=value;
  }
  return values;
}

export function validateCredentialKeyControlRuntime(env){
  if(env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_REF!=='refs/heads/main'
    ||env.KEY_CONTROL_GITHUB_ENVIRONMENT!==ENVIRONMENT
    ||env.GITHUB_WORKFLOW_REF?.split('@')[0]!==`${env.GITHUB_REPOSITORY}/${WORKFLOW}`
    ||!env.GITHUB_SHA||env.KEY_CONTROL_REPO_COMMIT!==env.GITHUB_SHA){
    fail('KEY_CONTROL_RUNTIME_INVALID','protected workflow identity is invalid');
  }
  const rawUrl=String(env.TURSO_DATABASE_URL||'').trim();
  const authToken=String(env.TURSO_AUTH_TOKEN||'').trim();
  const expectedHost=String(env.TURSO_PRODUCTION_DATABASE_HOST||'').trim().toLowerCase();
  let url;
  try{ url=new URL(rawUrl); }catch{ fail('KEY_CONTROL_RUNTIME_INVALID','database URL is invalid'); }
  if(!['libsql:','https:'].includes(url.protocol)||!url.hostname||url.port||!['','/'].includes(url.pathname)
    ||url.username||url.password||url.search||url.hash
    ||!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(expectedHost)
    ||url.hostname.toLowerCase()!==expectedHost||!authToken||authToken.length>32768){
    fail('KEY_CONTROL_RUNTIME_INVALID','database configuration is invalid');
  }
  return Object.freeze({url:rawUrl,authToken});
}

export function publicCredentialKeyControlResult(result){
  if(result.operation==='status'){
    const control=result.control;
    const material=result.material;
    return Object.freeze({ok:true,operation:'status',purpose:result.purpose,
      control:{ready:control.ready,state:control.state,reason:control.reason,
        configured_version:control.configured_version,accepted_version:control.accepted_version,
        generation:control.generation},
      material:{ready:material.ready,active_version:material.active_version,
        write_envelope_version:material.write_envelope_version??null,
        previous_versions:material.previous_versions,
        actionable:material.actionable??null,
        retained:material.retained??null,observations:material.observations??null,
        legacy_v1:material.legacy_v1??null,versions:material.versions,
        malformed:material.malformed??null,future:material.future??null,
        missing_key:material.missing_key??null,
        fingerprint_mismatch:material.fingerprint_mismatch??null,
        key_version_ahead:material.key_version_ahead??null,
        future_version:material.future_version??null},
    });
  }
  return result;
}

export async function main({argv=process.argv.slice(2),env=process.env,stdout=process.stdout}={}){
  const args=parseArgv(argv);
  const connection=validateCredentialKeyControlRuntime(env);
  const db=createClient(connection);
  try{
    const result=await runCredentialKeyControl(db,{
      operation:args.operation,purpose:args.purpose,
      expectedVersion:args['expected-version'],expectedGeneration:args['expected-generation'],
      confirmation:env.KEY_CONTROL_CONFIRM,
      mutationsEnabled:env.CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED,
    });
    stdout.write(`${JSON.stringify(publicCredentialKeyControlResult(result))}\n`);
    return result;
  }finally{ await db.close(); }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{ await main(); }
  catch(error){
    const code=PUBLIC_ERROR_CODES.has(error?.code)?error.code:'KEY_CONTROL_FAILED';
    process.stderr.write(`${JSON.stringify({ok:false,error:code})}\n`);
    process.exitCode=1;
  }
}
