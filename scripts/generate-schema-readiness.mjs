import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { compileSchemaReadinessManifest } from '../db/schema-inspector.js';
import { SCHEMA_MANIFEST } from '../db/schema-manifest.js';

export const SCHEMA_READINESS_DESTINATION=new URL('../db/schema-readiness-manifest.js',import.meta.url);

export function renderSchemaReadinessModule(manifest=SCHEMA_MANIFEST){
  const compiled=compileSchemaReadinessManifest(manifest);
  return `// Generated from the pinned schema manifest. This request-safe projection\n// contains structural contracts only and deliberately carries no executable SQL.\nexport const READINESS_SCHEMA_MANIFEST=Object.freeze(${JSON.stringify(compiled)});\n`;
}

// --check compares without writing and reports whether the checked-in module
// is stale (exit 1), so drift can be detected without touching the tree.
export async function main({argv=process.argv.slice(2),destination=SCHEMA_READINESS_DESTINATION}={}){
  const rendered=renderSchemaReadinessModule();
  if(argv.includes('--check')){
    const current=await readFile(destination,'utf8').catch(()=>null);
    return current===rendered?0:1;
  }
  await writeFile(destination,rendered);
  return 0;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) process.exitCode=await main();
