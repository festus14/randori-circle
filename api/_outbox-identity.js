// Identity (event type + idempotency key) of outbox insert statements, kept
// out-of-band so statement objects keep their exact {sql,args} shape. Callers
// use it after commit to request immediate delivery of exactly the rows they
// wrote (issue #250).
const STATEMENT_IDENTITIES=new WeakMap();

export function rememberOutboxStatement(statement,{eventType,idempotencyKey}){
  STATEMENT_IDENTITIES.set(statement,Object.freeze({eventType,idempotencyKey}));
  return statement;
}

export function outboxStatementIdentity(statement){
  return (statement&&typeof statement==='object'&&STATEMENT_IDENTITIES.get(statement))||null;
}
