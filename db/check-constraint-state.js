// Shared reader for SQLite CHECK-constraint enforcement.
//
// Local libSQL/SQLite connections answer `PRAGMA ignore_check_constraints`
// directly. Turso's remote server rejects that pragma (both the read and the
// `=ON`/`=OFF` forms) before it reaches SQLite, with
// `SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA ignore_check_constraints`.
// Because a remote client can therefore never disable CHECK constraints, that
// exact rejection means enforcement is on. Every other error, a missing row,
// or a non-zero value fails closed.

export const CHECK_CONSTRAINT_READ_SQL='PRAGMA ignore_check_constraints';
export const CHECK_CONSTRAINT_ENFORCE_SQL='PRAGMA ignore_check_constraints=OFF';

const TURSO_PARSE_ERROR_CODE='SQL_PARSE_ERROR';
const TURSO_DISALLOWED_MESSAGE=
  /^(?:SQL_PARSE_ERROR:\s*)?SQL not allowed statement:\s*PRAGMA\s+ignore_check_constraints(?:\s*=\s*(?:ON|OFF|0|1|TRUE|FALSE|YES|NO))?\s*;?\s*$/i;

function errorChain(error){
  const chain=[];
  let current=error;
  while(current&&typeof current==='object'&&chain.length<4&&!chain.includes(current)){
    chain.push(current);
    current=current.cause;
  }
  return chain;
}

/** True only for Turso's exact "not allowed statement" rejection of this pragma. */
export function isTursoDisallowedCheckConstraintPragma(error){
  const chain=errorChain(error);
  const coded=chain.some(item=>item.code===TURSO_PARSE_ERROR_CODE);
  if(!coded) return false;
  return chain.some(item=>typeof item.message==='string'
    &&TURSO_DISALLOWED_MESSAGE.test(item.message.trim()));
}

function numericValue(value){
  if(typeof value==='bigint') return Number(value);
  if(typeof value==='number') return value;
  if(typeof value==='string'&&/^-?\d+$/.test(value.trim())) return Number(value);
  return Number.NaN;
}

/**
 * Resolve whether CHECK constraints are enforced on this connection.
 * Returns true only for a single row with value 0, or Turso's exact
 * disallowed-pragma rejection. Any other error is rethrown (fail closed).
 */
export async function readCheckConstraintsEnforced(db){
  let result;
  try{
    result=await db.execute(CHECK_CONSTRAINT_READ_SQL);
  }catch(error){
    if(isTursoDisallowedCheckConstraintPragma(error)) return true;
    throw error;
  }
  return result?.rows?.length===1
    &&numericValue(result.rows[0]?.ignore_check_constraints)===0;
}

/**
 * Turn CHECK enforcement on where the connection allows it. Turso remote
 * connections reject the pragma outright, which means they cannot be disabled.
 */
export async function enforceCheckConstraints(db){
  try{
    await db.execute(CHECK_CONSTRAINT_ENFORCE_SQL);
  }catch(error){
    if(isTursoDisallowedCheckConstraintPragma(error)) return;
    throw error;
  }
}
