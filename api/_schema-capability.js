// Cached schema-capability check for code that uses an additive migration's
// new tables (ID-87, #371).
//
// Readiness accepts a database one additive migration behind the code, so the
// code merges before the protected cutover runs. Until then the new tables do
// not exist. Every code path that touches them must ask this module first.
// Paths that serve the feature use schemaFeatureAvailable (flag and schema)
// and behave exactly as if the feature were off (404, no capability
// advertised) while it answers false. Data-lifecycle paths such as account
// deletion and retention use schemaCapabilityAvailable alone, so rows already
// stored keep being deleted after the flag is turned off.
//
// The check is read-only: one SELECT on the ledger row for the version, which
// must match the contract's exact name and checksum. Answers are cached per
// database so a request path costs at most one ledger read per TTL: a short
// TTL while the migration is pending, so the feature appears soon after the
// cutover, and a longer one once it is present. Errors are never cached and
// read as "not available".
import { MIGRATION_CONTRACTS } from '../db/migration-contract.js';
import { readOnlyDatabase } from '../db/schema-inspector.js';

export const SCHEMA_CAPABILITY_AVAILABLE_TTL_MS=5*60*1000;
export const SCHEMA_CAPABILITY_PENDING_TTL_MS=30*1000;

const cacheByDatabaseUrl=new Map();
const cacheByClient=new WeakMap();

function cacheFor(db,env){
  const databaseUrl=String(env?.TURSO_DATABASE_URL||'').trim();
  if(databaseUrl){
    if(!cacheByDatabaseUrl.has(databaseUrl)) cacheByDatabaseUrl.set(databaseUrl,new Map());
    return cacheByDatabaseUrl.get(databaseUrl);
  }
  if(!cacheByClient.has(db)) cacheByClient.set(db,new Map());
  return cacheByClient.get(db);
}

function contractFor(version,contracts){
  if(!Array.isArray(contracts)||!Number.isSafeInteger(version)||version<1||version>contracts.length){
    throw new TypeError('schema capability needs a known migration version');
  }
  const contract=contracts[version-1];
  if(contract?.version!==version) throw new TypeError('schema capability needs a known migration version');
  return contract;
}

async function probe(db,contract){
  const result=await readOnlyDatabase(db).execute({
    sql:'SELECT version,name,checksum FROM schema_migrations WHERE version=? LIMIT 2',
    args:[contract.version],
  });
  const rows=result?.rows||[];
  return rows.length===1&&Number(rows[0].version)===contract.version
    &&String(rows[0].name)===contract.name&&String(rows[0].checksum)===contract.checksum;
}

/**
 * True once migration `version` is recorded in the ledger with its exact
 * contract. Never creates schema and never throws for database failures.
 */
export async function schemaCapabilityAvailable(db,{
  version,
  contracts=MIGRATION_CONTRACTS,
  env=process.env,
  now=Date.now,
}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const contract=contractFor(version,contracts);
  const cache=cacheFor(db,env);
  const key=`${contract.version}:${contract.checksum}`;
  const cached=cache.get(key);
  if(cached?.pending) return cached.pending;
  if(cached&&cached.expiresAt>now()) return cached.available;
  const pending=probe(db,contract).then(available=>{
    cache.set(key,{
      available,
      expiresAt:now()+(available?SCHEMA_CAPABILITY_AVAILABLE_TTL_MS:SCHEMA_CAPABILITY_PENDING_TTL_MS),
    });
    return available;
  },()=>{
    if(cache.get(key)?.pending===pending) cache.delete(key);
    return false;
  });
  cache.set(key,{pending});
  return pending;
}

/**
 * A feature backed by an additive migration is on only when its flag is on
 * and its schema is present. With the flag off the database is not touched.
 */
export async function schemaFeatureAvailable(db,{enabled,...options}={}){
  if(enabled!==true) return false;
  return schemaCapabilityAvailable(db,options);
}
