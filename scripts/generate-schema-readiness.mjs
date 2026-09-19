import { writeFile } from 'node:fs/promises';

import { compileSchemaReadinessManifest } from '../db/schema-inspector.js';
import { SCHEMA_MANIFEST } from '../db/schema-manifest.js';

const destination=new URL('../db/schema-readiness-manifest.js',import.meta.url);
const compiled=compileSchemaReadinessManifest(SCHEMA_MANIFEST);
await writeFile(destination,`// Generated from the pinned schema manifest. This request-safe projection\n// contains structural contracts only and deliberately carries no executable SQL.\nexport const READINESS_SCHEMA_MANIFEST=Object.freeze(${JSON.stringify(compiled)});\n`);
