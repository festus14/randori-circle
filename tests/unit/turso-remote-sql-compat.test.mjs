import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHECK_CONSTRAINT_ENFORCE_SQL,
  CHECK_CONSTRAINT_READ_SQL,
} from '../../db/check-constraint-state.js';
import {
  SCANNED_DIRECTORIES,
  TURSO_REMOTE_PRAGMA_ALLOWLIST,
  scanSource,
  scanTursoRemoteSql,
} from '../../scripts/check-turso-remote-sql.mjs';

const root = new URL('../../', import.meta.url).pathname;

function codes(source, file = 'api/example.js') {
  return scanSource(source, file).map(({ code }) => code);
}

test('every PRAGMA issued from api/, db/ and scripts/ is on the Turso remote allowlist', () => {
  const { findings, violations } = scanTursoRemoteSql({ root });
  assert.deepEqual(SCANNED_DIRECTORIES, ['api', 'db', 'scripts']);
  assert.deepEqual(violations, [], violations.map(item => `${item.file}:${item.line} ${item.code} ${item.statement}`).join('\n'));
  // The scan must actually see the known call sites, or it proves nothing.
  const seen = new Set(findings.map(item => `${item.file} ${item.statement}`));
  for (const expected of [
    'api/_pairing-readiness.js PRAGMA foreign_keys',
    'api/_pairing-readiness.js PRAGMA table_xinfo(${dynamic})',
    'db/backup-evidence.js PRAGMA integrity_check(1)',
    'db/schema-inspector.js PRAGMA index_xinfo(${dynamic})',
    'db/migration-runner.js PRAGMA foreign_keys=ON',
    'db/check-constraint-state.js PRAGMA ignore_check_constraints',
    'db/check-constraint-state.js PRAGMA ignore_check_constraints=OFF',
    'api/_ops-readiness.js pragma_table_info',
  ]) assert.ok(seen.has(expected), `missing ${expected}`);
});

test('ignore_check_constraints is tolerated only through the check-constraint helper', () => {
  assert.deepEqual(TURSO_REMOTE_PRAGMA_ALLOWLIST.ignore_check_constraints.files, ['db/check-constraint-state.js']);
  assert.equal(CHECK_CONSTRAINT_READ_SQL, 'PRAGMA ignore_check_constraints');
  assert.equal(CHECK_CONSTRAINT_ENFORCE_SQL, 'PRAGMA ignore_check_constraints=OFF');
  assert.deepEqual(codes("await db.execute('PRAGMA ignore_check_constraints');", 'db/migration-runner.js'), ['helper_only_pragma']);
  assert.deepEqual(codes("await db.execute('PRAGMA ignore_check_constraints=OFF');", 'scripts/chat-retention.mjs'), ['helper_only_pragma']);
  assert.deepEqual(codes("db.execute('SELECT * FROM pragma_ignore_check_constraints')"), ['not_allowlisted_pragma_function']);
  assert.deepEqual(codes("export const X='PRAGMA ignore_check_constraints=ON';", 'db/check-constraint-state.js'), ['unsupported_pragma_argument']);
});

test('PRAGMAs outside the allowlist fail, including lowercase and statement batches', () => {
  assert.deepEqual(codes("db.execute('PRAGMA journal_mode=WAL')"), ['not_allowlisted_pragma']);
  assert.deepEqual(codes("db.execute('pragma user_version')"), ['not_allowlisted_pragma']);
  assert.deepEqual(codes("db.batch(['SELECT 1', 'PRAGMA foreign_keys=ON', 'PRAGMA cache_size=-2000'])"),
    ['allowed', 'not_allowlisted_pragma']);
  assert.deepEqual(codes("db.execute('PRAGMA main.table_info(\"users\")')"), ['schema_qualified_pragma']);
});

test('assembled PRAGMA strings are folded before classification', () => {
  assert.deepEqual(codes("db.execute('PRAG'+'MA synchronous=OFF')"), ['not_allowlisted_pragma']);
  assert.deepEqual(codes("db.execute(['PRAGMA', 'wal_checkpoint'].join(' '))"), ['not_allowlisted_pragma']);
  assert.deepEqual(codes("db.execute('PRAGMA '.concat('optimize'))"), ['not_allowlisted_pragma']);
  assert.deepEqual(codes("const KEYWORD='PRAGMA '; const NAME='temp_store'; db.execute(KEYWORD+NAME)"),
    ['dangling_pragma', 'not_allowlisted_pragma']);
  assert.deepEqual(codes('db.execute(`PRAGMA ${name}`)'), ['dynamic_pragma_name']);
  assert.deepEqual(codes("db.execute('PRAGMA '+name)"), ['dynamic_pragma_name']);
  assert.deepEqual(codes("const prefix='PRAGMA'; run(prefix)"), ['dangling_pragma']);
  assert.deepEqual(codes("db.execute(['PRAGMA', 'foreign_keys'].join(' '))"), ['allowed']);
});

test('PRAGMA arguments must match the reviewed shape', () => {
  assert.deepEqual(codes('db.execute(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)'), ['allowed']);
  assert.deepEqual(codes("db.execute(`PRAGMA index_info(\"${quoted}\")`)"), ['allowed']);
  assert.deepEqual(codes("db.execute(\"PRAGMA table_info('users')\")"), ['allowed']);
  assert.deepEqual(codes("db.execute('PRAGMA integrity_check')"), ['unsupported_pragma_argument']);
  assert.deepEqual(codes("db.execute('PRAGMA integrity_check(100)')"), ['unsupported_pragma_argument']);
  assert.deepEqual(codes("db.execute('PRAGMA table_info')"), ['unsupported_pragma_argument']);
  assert.deepEqual(codes("db.execute('PRAGMA foreign_keys=MAYBE')"), ['unsupported_pragma_argument']);
});

test('table-valued pragma functions are limited to reviewed introspection functions', () => {
  assert.deepEqual(codes("db.execute(\"SELECT name FROM pragma_table_info('users') JOIN pragma_index_list('users')\")"),
    ['allowed_function', 'allowed_function']);
  assert.deepEqual(codes("db.execute('SELECT * FROM pragma_compile_options')"), ['not_allowlisted_pragma_function']);
});

test('HTTP Pragma headers, comments and regex literals are not SQL', () => {
  assert.deepEqual(codes("res.setHeader('Pragma','no-cache'); // PRAGMA journal_mode\nconst re=/^PRAGMA\\s+cache_size$/i;"), []);
  assert.deepEqual(codes("headers.set('pragma','no-cache')"), []);
});

test('unverified restricted statement classes fail until they are reviewed', () => {
  assert.deepEqual(codes("db.execute(\"ATTACH DATABASE 'other.db' AS other\")"), ['restricted_attach']);
  assert.deepEqual(codes("db.execute('DETACH DATABASE other')"), ['restricted_detach']);
  assert.deepEqual(codes("db.execute('VACUUM')"), ['restricted_vacuum']);
  assert.deepEqual(codes("db.execute(\"SELECT load_extension('x')\")"), ['restricted_load_extension']);
});
