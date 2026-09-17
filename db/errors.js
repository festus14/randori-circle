export class MigrationError extends Error {
  constructor(message, {code='MIGRATION_FAILED', cause, details}={}) {
    super(message, cause ? {cause} : undefined);
    this.name='MigrationError';
    this.code=code;
    if(details!==undefined) this.details=details;
  }
}

export class MigrationLedgerError extends MigrationError {
  constructor(message, details) {
    super(message, {code:'MIGRATION_LEDGER_INVALID', details});
    this.name='MigrationLedgerError';
  }
}

export class MigrationPreflightError extends MigrationError {
  constructor(message, details) {
    super(message, {code:'MIGRATION_PREFLIGHT_FAILED', details});
    this.name='MigrationPreflightError';
  }
}
