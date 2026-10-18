import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export async function verifyCrdtBundle(){
  const outfile=resolve(root,'assets/crdt-editor.js');
  const result=await build({
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
  const checkedIn=await readFile(outfile);
  if(result.outputFiles.length!==1||!Buffer.from(result.outputFiles[0].contents).equals(checkedIn)){
    throw new Error('assets/crdt-editor.js is stale; run npm run build:crdt');
  }
  return true;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  await verifyCrdtBundle();
  process.stdout.write('CRDT bundle is current\n');
}
