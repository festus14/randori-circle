import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

// buildBundle/readBundle are injectable so the stale-bundle refusal can be
// tested without rewriting the checked-in asset.
export async function verifyCrdtBundle({buildBundle=build,readBundle=readFile}={}){
  const outfile=resolve(root,'assets/crdt-editor.js');
  const result=await buildBundle({
    absWorkingDir:root,
    entryPoints:['assets/crdt-editor-source.js'],
    bundle:true,
    format:'iife',
    platform:'browser',
    target:'es2020',
    alias:{'monaco-editor/esm/vs/editor/editor.api.js':'./assets/monaco-api-shim.js'},
    outfile,
    write:false,
  });
  const checkedIn=await readBundle(outfile);
  if(result.outputFiles.length!==1||!Buffer.from(result.outputFiles[0].contents).equals(checkedIn)){
    throw new Error('assets/crdt-editor.js is stale; run npm run build:crdt');
  }
  return true;
}

export async function main({stdout=process.stdout,stderr=process.stderr,verify=verifyCrdtBundle}={}){
  try{
    await verify();
    stdout.write('CRDT bundle is current\n');
    return 0;
  }catch(error){
    stderr.write(`${error?.message||error}\n`);
    return 1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) process.exitCode=await main();
