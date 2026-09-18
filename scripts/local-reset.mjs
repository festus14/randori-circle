#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import {
  LocalServerError,
  resetLocalDatabase,
  resolveLocalServerConfig,
} from './local-server.mjs';

export async function main({argv=process.argv.slice(2),env=process.env,stdout=process.stdout}={}){
  if(argv.length!==1||argv[0]!=='--confirm'){
    throw new LocalServerError('LOCAL_RESET_CONFIRMATION_REQUIRED','Pass --confirm to reset the isolated local database.');
  }
  const config=resolveLocalServerConfig({env,argv:[]});
  const result=await resetLocalDatabase(config,{confirmed:true});
  stdout.write(`${JSON.stringify({ok:true,event:'local-database-reset',removed:result.removed})}\n`);
  return result;
}

async function run(){
  try{ await main(); }
  catch(error){
    const code=error instanceof LocalServerError&&/^LOCAL_[A-Z_]+$/.test(error.code)
      ?error.code
      :'LOCAL_INTERNAL_ERROR';
    process.stderr.write(`${JSON.stringify({ok:false,event:'local-database-reset',error:code})}\n`);
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) await run();

