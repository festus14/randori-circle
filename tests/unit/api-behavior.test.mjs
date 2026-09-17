import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

const realFetch = globalThis.fetch;
let executeHandler = () => ({ rows: [], rowsAffected: 0 });
let databaseDelegate = null;
const executed = [];
let lastPairingRun = null;
let persistedPairGroups = [];

function sqlText(statement) {
  return typeof statement === 'string' ? statement : String(statement?.sql || '');
}

const db = {
  async execute(statement) {
    const sql = sqlText(statement);
    executed.push({ sql, args: statement?.args || [] });
    if (databaseDelegate) return databaseDelegate.execute(statement);
    const result = await executeHandler(sql, statement?.args || []);
    return result || { rows: [], rowsAffected: 0 };
  },
  async batch(statements, mode) {
    if (databaseDelegate) {
      for (const statement of statements) {
        executed.push({ sql: sqlText(statement), args: statement?.args || [] });
      }
      return databaseDelegate.batch(statements, mode);
    }
    const nextGroups = [];
    for (const statement of statements) {
      if (sqlText(statement).includes('INSERT INTO pairing_week_runs')) {
        lastPairingRun = {
          weekLabel: statement.args[0],
          generationToken: statement.args[1],
          generation: Number(statement.args[2]),
          weekId: 10,
        };
      }
      if (sqlText(statement).includes('INSERT INTO pairing_groups')) {
        nextGroups.push({
          id: 90 + nextGroups.length,
          user_a_id: Number(statement.args[0]),
          user_b_id: Number(statement.args[1]),
          is_ai_pair: Number(statement.args[2]),
        });
      }
      await this.execute(statement);
    }
    if (nextGroups.length) persistedPairGroups = nextGroups;
    return statements.map(() => ({ rows: [], rowsAffected: 0 }));
  },
};

function authPayload(req) {
  const identity = req?.headers?.['x-test-auth'];
  if (identity === 'admin') return { id: 1, email: 'admin@example.test', name: 'Admin', is_admin: true };
  if (identity === 'demo') return { id: 3, email: 'demo@randori.demo', name: 'Demo', is_demo: true };
  if (identity === 'user') return { id: 2, email: 'user@example.test', name: 'User' };
  return null;
}

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => db,
    getJwtSecret: () => 'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret: () => {
      if (!process.env.CRON_SECRET) throw new Error('Missing CRON_SECRET');
      return process.env.CRON_SECRET;
    },
    getAdminEmails: () => new Set(['admin@example.test']),
    deterministicColor: () => '#123456',
    isoWeekLabel: () => '2026-W38',
    shuffleArray: values => [...values],
    verifyRequestAuth: authPayload,
    verifyMutationOrigin: () => true,
    initSentry: () => {},
    getSentry: () => ({ Sentry: null, ready: false }),
  },
});

const [
  { default: aiHandler },
  { default: authHandler },
  { default: dataHandler },
  { default: opsHandler },
  { default: videoHandler },
] = await Promise.all([
  import('../../api/ai.js'),
  import('../../api/auth.js'),
  import('../../api/data.js'),
  import('../../api/ops.js'),
  import('../../api/video.js'),
]);

function rows(values = [], extra = {}) {
  return { rows: values, rowsAffected: 0, ...extra };
}

const sameOriginHeaders = {
  origin: 'https://randori.example.test',
  host: 'randori.example.test',
};

function invoke(handler, { method = 'GET', url = '/', query = {}, headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const responseHeaders = {};
    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve({ status: statusCode, headers: responseHeaders, body: payload });
    };
    const response = {
      status(code) { statusCode = code; return this; },
      json(payload) { finish(payload); return this; },
      setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = value; },
      getHeader(name) { return responseHeaders[String(name).toLowerCase()]; },
      writeHead(code, values = {}) {
        statusCode = code;
        for (const [name, value] of Object.entries(values)) responseHeaders[name.toLowerCase()] = value;
        return this;
      },
      end(payload) { finish(payload); },
    };
    const request = { method, url, query, headers, body, socket: { remoteAddress: '127.0.0.1' } };
    Promise.resolve(handler(request, response)).then(() => finish(undefined)).catch(reject);
  });
}

beforeEach(() => {
  executed.length = 0;
  databaseDelegate = null;
  lastPairingRun = null;
  persistedPairGroups = [];
  executeHandler = () => rows();
  globalThis.fetch = realFetch;
  for (const key of [
    'ADMIN_EMAILS', 'AI_ENABLED', 'APP_URL', 'CRON_SECRET', 'GOOGLE_CLIENT_ID', 'NODE_ENV',
    'GOOGLE_CLIENT_SECRET', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'RESEND_API_KEY',
    'ALLOW_OPEN_SIGNUP', 'SIGNUP_ALLOWLIST', 'LEETCODE_INGESTION_AUTHORIZED',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
  ]) delete process.env[key];
});

after(() => {
  globalThis.fetch = realFetch;
});

test('password signup, login, and authenticated profile lookup return cookie sessions', async () => {
  const passwordHash = await bcrypt.hash('correct horse battery', 4);
  executeHandler = sql => {
    if (sql.includes('RETURNING attempts')) return rows([{ attempts: 1 }]);
    if (sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return rows([{ id: 7 }]);
    if (sql.includes('SELECT id,email,password_hash')) return rows([{
      id: 7,
      email: 'person@example.test',
      password_hash: passwordHash,
      display_name: 'Person',
      color: '#123456',
      is_admin: 0,
    }]);
    if (sql.includes('SELECT id,email,display_name,color,created_at')) return rows([{
      id: 2,
      email: 'user@example.test',
      display_name: 'User',
      color: '#123456',
      is_available: 1,
      is_admin: 0,
    }]);
    return rows();
  };

  const signup = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/signup',
    query: { endpoint: 'signup' },
    headers: { ...sameOriginHeaders, 'x-forwarded-proto': 'https' },
    body: { email: 'PERSON@example.test', password: 'correct horse battery', name: 'Person' },
  });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.user.id, 7);
  assert.equal('token' in signup.body, false);
  assert.match(String(signup.headers['set-cookie']), /randori_session=.*HttpOnly.*Secure/);

  const login = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/login',
    query: { endpoint: 'login' },
    headers: sameOriginHeaders,
    body: { email: 'person@example.test', password: 'correct horse battery' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.name, 'Person');
  assert.match(String(login.headers['set-cookie']), /randori_session=/);

  const me = await invoke(authHandler, {
    url: '/api/auth/me',
    query: { endpoint: 'me' },
    headers: { 'x-test-auth': 'user' },
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'user@example.test');
});

test('private-beta signup is invite-only and production password signup stays disabled', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_OPEN_SIGNUP = 'true';
  const production = await invoke(authHandler, {
    method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' },
    headers: sameOriginHeaders,
    body: { email: 'outsider@example.test', password: 'correct horse battery', name: 'Outsider' },
  });
  assert.equal(production.status, 503);
  assert.equal(executed.length, 0, 'production password signup must be rejected before database access');

  delete process.env.NODE_ENV;
  delete process.env.ALLOW_OPEN_SIGNUP;
  process.env.SIGNUP_ALLOWLIST = 'invited@example.test';
  const denied = await invoke(authHandler, {
    method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' },
    headers: sameOriginHeaders,
    body: { email: 'outsider@example.test', password: 'correct horse battery', name: 'Outsider' },
  });
  assert.equal(denied.status, 403);
  assert.equal(executed.length, 0, 'an uninvited signup must be rejected before database access');

  executeHandler = sql => {
    if (sql.includes('RETURNING attempts')) return rows([{ attempts: 1 }]);
    if (sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return rows([{ id: 9 }]);
    return rows();
  };
  const invited = await invoke(authHandler, {
    method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' },
    headers: sameOriginHeaders,
    body: { email: 'invited@example.test', password: 'correct horse battery', name: 'Invited' },
  });
  assert.equal(invited.status, 200);
});

test('Google callback validates state and establishes a cookie session without leaking a token', async () => {
  process.env.APP_URL = 'https://preview.example.test';
  process.env.GOOGLE_CLIENT_ID = 'client';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  globalThis.fetch = async url => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      email: 'oauth@example.test', name: 'OAuth User', sub: 'google-123', email_verified: true,
    }), { status: 200 });
  };
  executeHandler = sql => {
    if (sql.includes('SELECT id, is_admin, password_hash, google_sub')) return rows([]);
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return rows([{ id: 8 }]);
    if (sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };
  const state = 'state-value';
  const result = await invoke(authHandler, {
    url: `/api/auth/google/callback?code=ok&state=${state}`,
    query: { endpoint: 'callback', code: 'ok', state },
    headers: { cookie: `randori_oauth_state=${state}; randori_oauth_verifier=verifier` },
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://preview.example.test/?google=success');
  assert.doesNotMatch(result.headers.location, /token=/);
  assert.match(String(result.headers['set-cookie']), /randori_session=/);
});

test('auth validation and OAuth failure paths fail closed', async () => {
  process.env.ALLOW_OPEN_SIGNUP = 'true';
  const cases = [
    [{ method: 'GET', url: '/api/auth/signup', query: { endpoint: 'signup' } }, 405],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'bad', password: 'long-enough-password', name: 'Name' } }, 400],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'a@b.test', password: 'short', name: 'Name' } }, 400],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'a@b.test', password: 'long-enough-password', name: 'X' } }, 400],
    [{ method: 'GET', url: '/api/auth/login', query: { endpoint: 'login' } }, 405],
    [{ method: 'POST', url: '/api/auth/login', query: { endpoint: 'login' }, body: {} }, 400],
    [{ method: 'POST', url: '/api/auth/logout', query: { endpoint: 'logout' } }, 200],
    [{ method: 'GET', url: '/api/auth/logout', query: { endpoint: 'logout' } }, 405],
    [{ method: 'GET', url: '/api/auth/google/start', query: { endpoint: 'google-start' } }, 500],
    [{ url: '/api/auth/unknown', query: { endpoint: 'unknown' } }, 404],
  ];
  for (const [request, status] of cases) {
    const result = await invoke(authHandler, {
      ...request,
      headers: request.method === 'POST' ? sameOriginHeaders : request.headers,
    });
    assert.equal(result.status, status, request.url);
  }

  process.env.APP_URL = 'https://preview.example.test';
  for (const query of [
    { endpoint: 'callback', error: 'denied' },
    { endpoint: 'callback' },
    { endpoint: 'callback', code: 'code', state: 'wrong' },
  ]) {
    const result = await invoke(authHandler, { url: '/api/auth/google/callback', query });
    assert.equal(result.status, 302);
    assert.match(result.headers.location, /google_error=/);
  }
});

test('login rejects missing or cross-origin requests before credential or database work', async () => {
  for (const headers of [
    {},
    { origin: 'https://attacker.example', host: 'randori.example.test' },
  ]) {
    executed.length = 0;
    const result = await invoke(authHandler, {
      method: 'POST', url: '/api/auth/login', query: { endpoint: 'login' }, headers,
      body: { email: 'person@example.test', password: 'correct horse battery' },
    });
    assert.equal(result.status, 403);
    assert.equal(executed.length, 0);
  }
});

test('data read models map database rows into circle, weeks, history, stats, and health responses', async () => {
  executeHandler = sql => {
    if (sql.includes("GROUP BY level")) return rows([{ level: 'error', c: 7 }, { level: 'warn', c: 2 }, { level: 'success', c: 3 }]);
    if (sql.includes("event IN")) return rows([{ event: 'monaco_load_fail', c: 1 }, { event: 'execute_fail', c: 2 }]);
    if (sql.includes('FROM auth_accounts WHERE COALESCE(is_demo,0)=0 ORDER BY id')) return rows([
      { id: 2, display_name: 'User', color: '#123456', is_available: 1, bio: '', tz: 'UTC', interview_focus: 'dsa' },
      { id: 4, display_name: 'Partner', color: '#abcdef', is_available: 0, bio: 'bio', tz: 'UTC', interview_focus: 'both' },
    ]);
    if (sql.includes('FROM pairing_weeks WHERE COALESCE(is_demo,0)=0 ORDER BY id DESC LIMIT 20')) return rows([
      { id: 10, week_label: '2026-W38', week_start: '2026-09-20', focus: 'both', is_demo: 0 },
    ]);
    if (sql.includes('FROM pairing_groups WHERE week_id IN')) return rows([
      { pg_id: 20, week_id: 10, user_a_id: 2, user_b_id: 4, is_ai_pair: 0, topic: 'Arrays', topic_kind: 'dsa' },
    ]);
    if (sql.includes('display_name as name, color, tz')) return rows([
      { id: 2, name: 'User', color: '#123456', tz: 'UTC' },
      { id: 4, name: 'Partner', color: '#abcdef', tz: 'UTC' },
    ]);
    if (sql.includes('FROM pairing_groups pg') && sql.includes('ORDER BY pw.week_start')) return rows([
      { pg_id: 20, week_id: 10, user_a_id: 2, user_b_id: 4, is_ai_pair: 0, week_label: '2026-W38', week_start: '2026-09-20' },
    ]);
    if (sql.includes('display_name as name FROM auth_accounts')) return rows([{ id: 2, name: 'User' }, { id: 4, name: 'Partner' }]);
    if (sql.includes('COUNT(*) as c FROM auth_accounts')) return rows([{ c: 4 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_weeks')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_groups pg JOIN')) return rows([{ c: 3 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_groups WHERE user_a_id')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(DISTINCT week_id)')) return rows([{ c: 2 }]);
    if (sql.includes('ORDER BY pw.id DESC LIMIT 1')) return rows([{ pg_id: 20, week_id: 10 }]);
    return rows();
  };
  const auth = { 'x-test-auth': 'user' };
  const health = await invoke(dataHandler, { url: '/api/health', query: { endpoint: 'health' } });
  assert.equal(health.body.spike, true);
  assert.equal(health.body.piston_fails_6h, 2);

  const circle = await invoke(dataHandler, { url: '/api/circle', query: { endpoint: 'circle' }, headers: auth });
  assert.equal(circle.body.circle.length, 2);
  assert.equal(circle.body.circle[1].is_available, false);

  const weeks = await invoke(dataHandler, { url: '/api/weeks', query: { endpoint: 'weeks' }, headers: auth });
  assert.equal(weeks.body.weeks[0].pairs[0].b_name, 'Partner');

  const history = await invoke(dataHandler, { url: '/api/history', query: { endpoint: 'history' }, headers: auth });
  assert.equal(history.body.history[0].partner_name, 'Partner');

  const stats = await invoke(dataHandler, { url: '/api/stats', query: { endpoint: 'stats' }, headers: auth });
  assert.equal(stats.body.total_users, 4);
  assert.equal(stats.body.your_sessions, 2);
});

test('profile, pair schedule, messages, questions, and runs enforce ownership and persist valid writes', async () => {
  let scheduleState = {
    id: 30,
    week_id: 10,
    pair_group_id: 20,
    proposed_times: '[]',
    agreed_time: null,
    updated_at: 'now',
  };
  let scheduleUpserts = 0;
  const profileRow = {
    id: 2, email: 'user@example.test', display_name: 'Updated User', color: '#123456',
    is_available: 1, is_admin: 0, bio: 'Ready', tz: 'UTC', interview_focus: 'system', leetcode_handle: 'coder',
  };
  executeHandler = (sql, args) => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT id,user_a_id,user_b_id FROM pairing_groups')) return rows([{ id: 20, user_a_id: 2, user_b_id: 4, is_ai_pair: 0 }]);
    if (sql.includes('SELECT id,email,display_name,color') || sql.includes('SELECT id,email,display_name,color,is_available')) return rows([profileRow]);
    if (sql.includes('INSERT INTO pair_schedules') && sql.includes('ON CONFLICT')) {
      scheduleUpserts += 1;
      const [weekId, pairId, proposed, agreed, hasProposed, hasAgreed] = args;
      scheduleState = {
        ...scheduleState,
        week_id: weekId,
        pair_group_id: pairId,
        proposed_times: hasProposed ? proposed : scheduleState.proposed_times,
        agreed_time: hasAgreed ? agreed : scheduleState.agreed_time,
      };
      return rows();
    }
    if (sql.includes('SELECT id, week_id, pair_group_id, proposed_times')) return rows([{
      ...scheduleState,
    }]);
    if (sql.includes('INSERT INTO pair_messages') && sql.includes('RETURNING id')) return rows([{ id: 40 }]);
    if (sql.includes('FROM pair_messages pm') && sql.includes('WHERE pm.id=')) return rows([{
      id: 40, sender_id: 2, sender_name: 'Updated User', sender_color: '#123456', message: 'Sunday works', created_at: 'now',
    }]);
    if (sql.includes('FROM pair_messages pm')) return rows([{
      id: 40, sender_id: 2, sender_name: 'Updated User', sender_color: '#123456', message: 'Sunday works', created_at: 'now',
    }]);
    if (sql.includes('SELECT id FROM custom_questions WHERE slug=')) return rows([]);
    if (sql.includes('INSERT INTO custom_questions') && sql.includes('RETURNING id')) return rows([{ id: 50 }]);
    if (sql.includes('FROM custom_questions WHERE id=')) return rows([{
      id: 50, slug: 'binary-search', title: 'Binary Search', type: 'dsa', difficulty: 'Easy', category: 'array',
      description: 'Find a value.', examples: '[]', test_cases: '[{"input":[1],"expect":0}]', starter_per_lang: '{}', author_id: 2, source: 'custom',
    }]);
    if (sql.includes('INSERT INTO session_runs') && sql.includes('RETURNING id')) return rows([{ id: 60 }]);
    if (sql.includes('FROM session_runs WHERE id=')) return rows([{ id: 60, user_id: 2, question_slug: 'binary-search', language: 'javascript', passed_count: 1, total_count: 1 }]);
    if (sql.includes('FROM session_runs WHERE user_id=')) return rows([{ id: 60, question_slug: 'binary-search' }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const profile = await invoke(dataHandler, {
    method: 'POST', url: '/api/profile', query: { endpoint: 'profile' }, headers,
    body: { name: 'Updated User', bio: 'Ready', tz: 'UTC', interview_focus: 'system_design', is_available: true },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.interview_focus, 'system');

  const schedule = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { week_id: 10, pair_id: 20, proposed_times: ['2026-09-20T08:00:00Z'], agreed_time: '2026-09-20T08:00:00Z' },
  });
  assert.equal(schedule.status, 200);
  assert.deepEqual(schedule.body.schedule.proposed_times, ['2026-09-20T08:00:00Z']);
  assert.equal(schedule.body.schedule.agreed_time, '2026-09-20T08:00:00Z');

  const clearedAgreement = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { week_id: 10, pair_id: 20, agreed_time: '' },
  });
  assert.deepEqual(clearedAgreement.body.schedule.proposed_times, ['2026-09-20T08:00:00Z']);
  assert.equal(clearedAgreement.body.schedule.agreed_time, null);

  const clearedProposals = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { week_id: 10, pair_id: 20, proposed_times: [] },
  });
  assert.deepEqual(clearedProposals.body.schedule.proposed_times, []);
  assert.equal(scheduleUpserts, 3);

  const message = await invoke(dataHandler, {
    method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers,
    body: { week_id: 10, pair_id: 20, message: 'Sunday works' },
  });
  assert.equal(message.body.message.message, 'Sunday works');

  const question = await invoke(dataHandler, {
    method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers: { 'x-test-auth': 'admin' },
    body: { title: 'Binary Search', description: 'Find a value.', test_cases: [{ input: [1], expect: 0 }] },
  });
  assert.equal(question.status, 200);
  assert.equal(question.body.question.id, 50);

  const run = await invoke(dataHandler, {
    method: 'POST', url: '/api/runs', query: { endpoint: 'runs' }, headers,
    body: { code: 'return 0', question_slug: 'binary-search', passed_count: 1, total_count: 1 },
  });
  assert.equal(run.body.run.id, 60);
});

test('execution supports only JavaScript and Python and normalizes Piston results without executing locally', async () => {
  const submitted = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /piston\/execute/);
    submitted.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ run: { code: 0, stdout: '{"pass":true}\n', stderr: '' } }), { status: 200 });
  };
  const headers = { 'x-test-auth': 'user' };
  for (const [language, expectedFile] of [['javascript', 'main.js'], ['python', 'main.py']]) {
    const result = await invoke(dataHandler, {
      method: 'POST', url: '/api/execute', query: { endpoint: 'execute' }, headers,
      body: { language, code: 'function solve(x){ return x; }', test_cases: [{ input: 1, expect: 1 }] },
    });
    assert.equal(result.status, 200, language);
    assert.equal(result.body.passed_count, 1, language);
    assert.equal(submitted.at(-1).files[0].name, expectedFile);
  }

  for (const language of ['typescript', 'java', 'go', 'c++', 'c', 'ruby']) {
    const rejected = await invoke(dataHandler, {
      method: 'POST', url: '/api/execute', query: { endpoint: 'execute' }, headers,
      body: { language, code: 'print(1)', test_cases: [{ input: 1, expect: 1 }] },
    });
    assert.equal(rejected.status, 400, language);
    assert.match(rejected.body.error, /javascript and python/i);
  }
});

test('questions require authentication and bundled seed ingestion runs only through admin init', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('FROM custom_questions ORDER BY id DESC')) return rows([{
      id: 51, slug: 'two-sum', title: 'Two Sum', description: 'Find indexes.',
      examples: '[]', test_cases: '[]', starter_per_lang: '{}', source: 'leetcode',
    }]);
    return rows();
  };
  const anonymous = await invoke(dataHandler, { url: '/api/questions', query: { endpoint: 'questions' } });
  assert.equal(anonymous.status, 401);

  executed.length = 0;
  const questions = await invoke(dataHandler, {
    url: '/api/questions', query: { endpoint: 'questions' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(questions.status, 200);
  assert.equal(questions.body.questions[0].slug, 'two-sum');
  assert.equal(executed.some(call => call.sql.includes('INSERT INTO custom_questions')), false);
  assert.equal(executed.some(call => call.sql.includes('DELETE FROM pair_schedules WHERE id NOT IN')), false,
    'ordinary requests must not run the destructive legacy schedule migration');
  assert.equal(executed.some(call => call.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair')), false,
    'ordinary requests must not create the legacy schedule uniqueness index');

  executed.length = 0;
  const initialized = await invoke(dataHandler, {
    method: 'POST', url: '/api/init', query: { endpoint: 'init' }, headers: { 'x-test-auth': 'admin' },
  });
  assert.equal(initialized.status, 200);
  assert.equal(executed.some(call => call.sql.includes('INSERT INTO custom_questions')), true);
  const dedupe = executed.findIndex(call => call.sql.includes('DELETE FROM pair_schedules WHERE id NOT IN'));
  const uniqueIndex = executed.findIndex(call => call.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair'));
  assert.ok(dedupe >= 0 && uniqueIndex > dedupe, 'legacy schedules must be deterministically deduped before the unique index');
});

test('admin init reports a visible error when the legacy schedule migration fails', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('DELETE FROM pair_schedules WHERE id NOT IN')) throw new Error('database is read only');
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'POST', url: '/api/init', query: { endpoint: 'init' }, headers: { 'x-test-auth': 'admin' },
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /schedule uniqueness migration failed/i);
  assert.match(result.body.detail, /read only/i);
});

test('data validation and access-control branches reject malformed or cross-pair requests', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT id,user_a_id,user_b_id FROM pairing_groups')) return rows([{ id: 20, user_a_id: 7, user_b_id: 8 }]);
    if (sql.includes('SELECT author_id FROM custom_questions')) return rows([{ author_id: 7 }]);
    if (sql.includes('SELECT is_admin FROM auth_accounts')) return rows([{ is_admin: 0 }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const cases = [
    [{ method: 'POST', url: '/api/circle', query: { endpoint: 'circle' }, headers }, 405],
    [{ method: 'POST', url: '/api/weeks', query: { endpoint: 'weeks' }, headers }, 405],
    [{ method: 'POST', url: '/api/history', query: { endpoint: 'history' }, headers }, 405],
    [{ method: 'GET', url: '/api/init', query: { endpoint: 'init' }, headers }, 405],
    [{ method: 'PUT', url: '/api/profile', query: { endpoint: 'profile' }, headers }, 405],
    [{ method: 'POST', url: '/api/profile', query: { endpoint: 'profile' }, headers, body: {} }, 400],
    [{ url: '/api/schedule', query: { endpoint: 'schedule' }, headers }, 400],
    [{ url: '/api/schedule', query: { endpoint: 'schedule', week_id: 10, pair_id: 20 }, headers }, 403],
    [{ method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers, body: {} }, 400],
    [{ method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers, body: { week_id: 10, pair_id: 20, message: 'no access' } }, 403],
    [{ method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: {} }, 403],
    [{ method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: { title: 'Title' } }, 403],
    [{ method: 'DELETE', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: {} }, 400],
    [{ method: 'DELETE', url: '/api/questions', query: { endpoint: 'questions', id: 50 }, headers }, 403],
    [{ method: 'PUT', url: '/api/runs', query: { endpoint: 'runs' }, headers }, 405],
    [{ method: 'POST', url: '/api/runs', query: { endpoint: 'runs' }, headers, body: {} }, 400],
    [{ method: 'POST', url: '/api/execute', query: { endpoint: 'execute' }, headers, body: {} }, 400],
    [{ method: 'POST', url: '/api/leetcode', query: { endpoint: 'leetcode' }, headers }, 405],
    [{ url: '/api/leetcode', query: { endpoint: 'leetcode' }, headers }, 400],
    [{ method: 'PUT', url: '/api/logs', query: { endpoint: 'logs' }, headers }, 405],
    [{ url: '/api/not-real', query: { endpoint: 'not-real' }, headers }, 404],
  ];
  for (const [request, status] of cases) {
    const result = await invoke(dataHandler, request);
    assert.equal(result.status, status, `${request.method || 'GET'} ${request.url}`);
  }
});

test('authorized LeetCode ingestion parses approved remote metadata through mocked HTTP only', async () => {
  process.env.LEETCODE_INGESTION_AUTHORIZED = 'true';
  globalThis.fetch = async url => {
    if (String(url).includes('leetcode.com/graphql')) {
      return new Response(JSON.stringify({ data: { question: {
        title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy',
        content: '<p>Example 1:</p><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre><p>Constraints: 2 <= nums.length <= 100</p>',
        exampleTestcases: '[2,7,11,15]\n9', topicTags: [{ slug: 'array' }],
      } } }), { status: 200 });
    }
    if (String(url).includes('alfa-leetcode-api')) {
      return new Response(JSON.stringify({ exampleTestcases: '[3,2,4]\n6', content: '' }), { status: 200 });
    }
    throw new Error(`unexpected network target: ${url}`);
  };
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'POST', url: '/api/leetcode/sync', query: { endpoint: 'leetcode-sync', slug: 'two-sum' },
    headers: { 'x-test-auth': 'admin' }, body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.synced_count, 1);
  assert.equal(result.body.synced[0].slug, 'two-sum');
  assert.ok(result.body.synced[0].test_cases_count >= 2);
});

test('AI consent path stores a template analysis and exposes owned feedback history', async () => {
  process.env.AI_ENABLED = 'true';
  executeHandler = sql => {
    if (sql.includes('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 20, week_id: 10, user_a_id: 2, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }, { user_id: 3 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('COUNT(*) as c FROM ai_sessions')) return rows([{ c: 2 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 3 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 3, tokens_in: 100 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 70 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 71 }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('af.session_id=')) return rows([{
      id: 71, session_id: 70, feedback_json: '{"overall_score":7}', evidence: '{"validation":true}',
      model_used: 'mock', created_by: 2, room_id: 'room', pair_label: 'Pair', confidence: 0.8,
    }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('ase.created_by=')) return rows([{ id: 71, session_id: 70 }]);
    if (sql.includes('SELECT * FROM ai_usage')) return rows([{ calls: 3 }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const denied = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_20', transcript: 'I explained the approach clearly.', ai_consent: false },
  });
  assert.equal(denied.status, 403);

  const analyzed = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_20', pair_label: 'untrusted label', transcript: 'I explained the approach clearly and discussed complexity.', code: 'return answer;', ai_consent: true, duration_sec: 600 },
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.mocked, true);
  assert.equal(analyzed.body.session_id, 70);
  const sessionInsert = executed.find(entry => entry.sql.includes('INSERT INTO ai_sessions'));
  assert.equal(sessionInsert.args[0], 'week_10_pair_20');
  assert.equal(sessionInsert.args[1], '2026-W38 · Pair 20');

  const feedback = await invoke(aiHandler, {
    url: '/api/ai/feedback?id=70', query: { endpoint: 'feedback', id: 70 }, headers,
  });
  assert.equal(feedback.body.feedback.overall_score, 7);

  const history = await invoke(aiHandler, {
    url: '/api/ai/history', query: { endpoint: 'history' }, headers,
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.feedbacks.length, 1);
});

test('AI analysis requires trusted room membership and every human participant consent', async () => {
  process.env.AI_ENABLED = 'true';
  let consentedIds = [2];
  executeHandler = (sql, args) => {
    if (sql.includes('SELECT pg.id AS pair_group_id')) {
      if (Number(args[0]) === 20) return rows([{ pair_group_id: 20, week_id: 10, user_a_id: 2, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
      if (Number(args[0]) === 21) return rows([{ pair_group_id: 21, week_id: 10, user_a_id: 1, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
      return rows([]);
    }
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows(consentedIds.map(user_id => ({ user_id })));
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.includes('COUNT(*) as c FROM ai_sessions')) return rows([{ c: 0 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 80 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 81 }]);
    return rows();
  };
  const request = room_id => invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id, transcript: 'Candidate and interviewer discussed a solution.', ai_consent: true },
  });

  assert.equal((await request('untrusted-room')).status, 403);
  assert.equal((await request('week_10_pair_21')).status, 403);

  const missingPartnerConsent = await request('week_10_pair_20');
  assert.equal(missingPartnerConsent.status, 403);
  assert.equal(missingPartnerConsent.body.pending_participant_count, 1);
  assert.equal(executed.some(entry => entry.sql.includes('INSERT INTO ai_sessions')), false);

  consentedIds = [2, 3];
  const approved = await request('week_10_pair_20');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.session_id, 80);
});

test('AI provider network failures preserve Groq retries and OpenAI fallback', async () => {
  process.env.AI_ENABLED = 'true';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  executeHandler = sql => {
    if (sql.includes('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 22, week_id: 10, user_a_id: 2, user_b_id: 2, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.includes('COUNT(*) as c FROM ai_sessions')) return rows([{ c: 0 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 82 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 83 }]);
    return rows();
  };
  const providerCalls = [];
  globalThis.fetch = async url => {
    providerCalls.push(String(url));
    if (String(url).includes('api.groq.com')) throw new TypeError('simulated network failure');
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        candidate: { strengths: [], improvements: [] }, interviewer: { strengths: [], improvements: [] },
        overall_score: 8, next_time_checklist: ['practice'],
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
  };

  const result = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id: 'week_10_pair_22', transcript: 'detailed analysis '.repeat(2_000), ai_consent: true },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.openaiFallback, true);
  assert.equal(result.body.estimated_cost.tokens_in, 20);
  assert.equal(result.body.estimated_cost.tokens_out, 10);
  assert.equal(result.body.estimated_cost.cents, 1);
  assert.deepEqual(providerCalls.map(url => url.includes('api.groq.com') ? 'groq' : 'openai'), ['groq', 'groq', 'openai']);

  delete process.env.GROQ_API_KEY;
  globalThis.fetch = async () => { throw Object.assign(new Error('simulated timeout'), { name: 'AbortError' }); };
  const openAiTimeout = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id: 'week_10_pair_22', transcript: 'A short solo analysis.', ai_consent: true },
  });
  assert.equal(openAiTimeout.status, 200);
  assert.equal(openAiTimeout.body.mocked, true);
  assert.match(openAiTimeout.body.reason_for_pick, /openai failed openai request timed out/);
});

test('AI rejects malformed provider feedback with the generic provider error', async () => {
  process.env.AI_ENABLED = 'true';
  process.env.GROQ_API_KEY = 'test-groq-key';
  const memoryDb = createClient({ url: 'file::memory:' });
  databaseDelegate = memoryDb;
  try {
    await memoryDb.batch([
      `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, is_demo INTEGER DEFAULT 0)`,
      `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY, week_label TEXT NOT NULL)`,
      `CREATE TABLE pairing_groups (
        id INTEGER PRIMARY KEY,
        week_id INTEGER NOT NULL,
        user_a_id INTEGER NOT NULL,
        user_b_id INTEGER NOT NULL,
        user_c_id INTEGER,
        is_ai_pair INTEGER DEFAULT 0
      )`,
      `INSERT INTO auth_accounts (id,email,is_demo) VALUES (2,'user@example.test',0)`,
      `INSERT INTO pairing_weeks (id,week_label) VALUES (10,'2026-W38')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (23,10,2,2,NULL,1)`,
    ], 'write');

    let providerContent=JSON.stringify({
      candidate: { strengths: {}, improvements: [] },
      interviewer: { strengths: [], improvements: [] },
      overall_score: 7,
      next_time_checklist: ['practice'],
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: providerContent } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
    const request = () => invoke(aiHandler, {
      method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
      body: { room_id: 'week_10_pair_23', transcript: 'A short solo analysis.', ai_consent: true },
    });

    const malformedShape = await request();
    assert.equal(malformedShape.status, 502);
    assert.deepEqual(malformedShape.body, { ok: false, error: 'AI provider temporarily unavailable', session_id: 1 });

    providerContent='{not valid json';
    const malformedJson = await request();
    assert.equal(malformedJson.status, 502);
    assert.equal(malformedJson.body.error, 'AI provider temporarily unavailable');

    globalThis.fetch = async () => new Response('null', { status: 200 });
    const nullEnvelope = await request();
    assert.equal(nullEnvelope.status, 502);
    assert.deepEqual(nullEnvelope.body, { ok: false, error: 'AI provider temporarily unavailable', session_id: 3 });

    const feedbackCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_feedback`);
    const sessionCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_sessions`);
    const consentCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_consents WHERE user_id=2 AND revoked_at IS NULL`);
    assert.equal(Number(feedbackCount.rows[0].count), 0);
    assert.equal(Number(sessionCount.rows[0].count), 3);
    assert.equal(Number(consentCount.rows[0].count), 1);
  } finally {
    databaseDelegate = null;
    memoryDb.close();
  }
});

test('AI provider selection, quota, and ownership branches remain fail-closed', async () => {
  process.env.AI_ENABLED = 'true';
  executeHandler = sql => {
    if (sql.includes('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 21, week_id: 10, user_a_id: 2, user_b_id: 2, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('COUNT(*) as c FROM ai_sessions')) return rows([{ c: 0 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 72 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 73 }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('af.session_id=')) return rows([{ id: 73, session_id: 72, feedback_json: '{}', created_by: 99 }]);
    return rows();
  };
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = async url => {
    assert.match(String(url), /api\.openai\.com/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        candidate: { strengths: [], improvements: [] }, interviewer: { strengths: [], improvements: [] },
        overall_score: 8, next_time_checklist: ['practice'],
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
  };
  const headers = { 'x-test-auth': 'user' };
  const analyzed = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_21', transcript: 'A sufficiently detailed interview transcript.', ai_consent: true, interviewer_questions: 'Why this approach?' },
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.openaiFallback, true);
  assert.equal(analyzed.body.feedback.overall_score, 8);

  const forbidden = await invoke(aiHandler, { url: '/api/ai/feedback?id=72', query: { endpoint: 'feedback', id: 72 }, headers });
  assert.equal(forbidden.status, 403);

  const wrongMethods = await Promise.all([
    invoke(aiHandler, { method: 'GET', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers }),
    invoke(aiHandler, { method: 'POST', url: '/api/ai/feedback', query: { endpoint: 'feedback' }, headers }),
    invoke(aiHandler, { method: 'POST', url: '/api/ai/history', query: { endpoint: 'history' }, headers }),
  ]);
  assert.deepEqual(wrongMethods.map(result => result.status), [405, 405, 405]);
});

test('AI rejects missing content and enforces demo quota before provider calls', async () => {
  process.env.AI_ENABLED = 'true';
  const headers = { 'x-test-auth': 'demo' };
  const empty = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { ai_consent: true },
  });
  assert.equal(empty.status, 400);

  executeHandler = sql => {
    if (sql.includes('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 22, week_id: 10, user_a_id: 3, user_b_id: 3, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 3 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 1 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 100 }]);
    return rows();
  };
  const limited = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_22', transcript: 'A detailed transcript.', ai_consent: true },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.demo, true);
});

test('operations cover preferences, availability, admin promotion, demo lifecycle, and cron auth', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  let insertedId = 100;
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT user_id,email_enabled')) return rows([{ user_id: 2, email_enabled: 1, sms_enabled: 0 }]);
    if (sql.includes('SELECT id,email,display_name,is_available')) return rows([{ id: 2, email: 'user@example.test', display_name: 'User', is_available: 1 }]);
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)')) return rows([{ id: 2, email: 'user@example.test', is_admin: 0 }]);
    if (sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([{ id: insertedId++ }]);
    if (sql.includes('COUNT(*) as c FROM auth_accounts WHERE is_demo=1')) return rows([{ c: 6 }]);
    if (sql.includes('COUNT(*) AS c FROM auth_accounts WHERE is_demo=1')) return rows([{ c: 6 }]);
    if (sql.includes('COUNT(*) AS c FROM pairing_groups WHERE week_id IN')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(*) AS c FROM pairing_weeks WHERE is_demo=1')) return rows([{ c: 1 }]);
    if (sql.includes('SELECT id, display_name as name, email, color, is_available, is_demo')) return rows([
      { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
      { id: 2, name: 'User', email: 'user@example.test', color: '#2', is_available: 1, is_demo: 1 },
    ]);
    if (sql.includes('SELECT id, display_name as name, color, email, is_available, is_demo')) return rows([
      { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
      { id: 2, name: 'User', email: 'user@example.test', color: '#2', is_available: 1, is_demo: 1 },
    ]);
    if (sql.includes('SELECT week_id,generation_token,generation FROM pairing_week_runs')) return rows([{
      week_id: lastPairingRun?.weekId,
      generation_token: lastPairingRun?.generationToken,
      generation: lastPairingRun?.generation,
    }]);
    if (sql.includes('INSERT INTO pairing_weeks') && sql.includes('RETURNING id')) return rows([{ id: 10 }]);
    if (sql.includes('DELETE FROM pairing_groups')) return rows([], { rowsAffected: 2 });
    if (sql.includes('COUNT(*) as c FROM pairing_weeks WHERE is_demo=1')) return rows([{ c: 1 }]);
    return rows();
  };
  const user = { 'x-test-auth': 'user' };
  const admin = { 'x-test-auth': 'admin' };

  const prefs = await invoke(opsHandler, { url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user });
  assert.equal(prefs.body.prefs.user_id, 2);
  const saved = await invoke(opsHandler, {
    method: 'POST', url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user,
    body: { email_enabled: false, sms_enabled: true, phone: '+440000000' },
  });
  assert.equal(saved.body.prefs.sms_enabled, true);

  const availability = await invoke(opsHandler, {
    method: 'POST', url: '/api/availability', query: { endpoint: 'availability' }, headers: user, body: { is_available: true },
  });
  assert.equal(availability.body.user.is_available, true);

  const promoted = await invoke(opsHandler, {
    method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: admin,
    body: { action: 'promote', email: 'user@example.test' },
  });
  assert.equal(promoted.body.promoted, 'user@example.test');

  const seeded = await invoke(opsHandler, { method: 'POST', url: '/api/demo-seed', query: { endpoint: 'demo-seed' }, headers: admin });
  assert.equal(seeded.body.seeded_count, 6);
  const shuffled = await invoke(opsHandler, { method: 'POST', url: '/api/demo-shuffle', query: { endpoint: 'demo-shuffle' }, headers: admin });
  assert.equal(shuffled.status, 200, JSON.stringify(shuffled.body));
  assert.equal(shuffled.body.pairs.length, 1);
  const reset = await invoke(opsHandler, { method: 'POST', url: '/api/demo-reset', query: { endpoint: 'demo-reset' }, headers: admin });
  assert.equal(reset.body.deleted.groups, 2);

  const cronDenied = await invoke(opsHandler, { method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' }, headers: { 'x-cron-secret': 'wrong' } });
  assert.equal(cronDenied.status, 401);
  assert.match(cronDenied.body.hint, /x-cron-secret.*Authorization: Bearer/);
  assert.doesNotMatch(cronDenied.body.hint, /\?secret=|x-vercel-cron/);

  const weekly = await invoke(opsHandler, { method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' }, headers: { 'x-cron-secret': 'cron-secret' } });
  assert.equal(weekly.status, 200);
  assert.equal(weekly.body.pairs.length, 1);
  assert.equal(executed.some(call => !call.sql.trim()), false, 'migration arrays must not execute undefined DDL entries');
});

test('weekly email delivery caps stale outbox retries and exhausts the fifth failed attempt', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'provider unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  executeHandler = sql => {
    if (sql.includes('SELECT id FROM pairing_weeks WHERE week_label=')) return rows([{ id: 10 }]);
    if (sql.startsWith("UPDATE pairing_email_outbox SET status='exhausted'")) return rows([], { rowsAffected: 0 });
    if (sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count')) return rows([{
      id: 70,
      week_id: 10,
      user_id: 2,
      kind: 'paired',
      recipient_email: 'user@example.test',
      status: 'sending',
      attempt_count: 4,
    }]);
    if (sql.includes('SELECT week_label FROM pairing_weeks')) return rows([{ week_label: '2026-W38' }]);
    if (sql.includes("SET status='sending',attempt_count=attempt_count+1")) return rows([{ id: 70, attempt_count: 5 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT email_enabled FROM user_notification_prefs')) return rows([{ email_enabled: 1 }]);
    if (sql.includes('SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups')) return rows([{
      id: 20, user_a_id: 2, user_b_id: 2, is_ai_pair: 1,
    }]);
    if (sql.includes("SET status=CASE WHEN attempt_count>=? THEN 'exhausted'")) return rows([{ status: 'exhausted' }]);
    if (sql.includes('SELECT COUNT(*) AS c FROM pairing_email_outbox')) return rows([{ c: 0 }]);
    return rows();
  };

  const result = await invoke(opsHandler, {
    method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' },
    headers: { 'x-cron-secret': 'cron-secret' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.skipped, true);
  assert.equal(result.body.email_delivery.failed, 1);
  assert.equal(result.body.email_delivery.exhausted, 1);
  assert.equal(result.body.email_delivery.pending, 0);

  const candidateQuery = executed.find(call => call.sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count'));
  assert.match(candidateQuery.sql, /attempt_count<\?/);
  assert.match(candidateQuery.sql, /status='sending'.*claimed_at<datetime/);
  assert.deepEqual(candidateQuery.args, [10, 5]);
  const claim = executed.find(call => call.sql.includes("SET status='sending',attempt_count=attempt_count+1"));
  assert.deepEqual(claim.args, [70, 5]);
  const transition = executed.find(call => call.sql.includes("SET status=CASE WHEN attempt_count>=? THEN 'exhausted'"));
  assert.match(transition.sql, /status='sending' AND attempt_count=\?/);
  assert.deepEqual(transition.args, [5, 'provider unavailable', 70, 5]);
});

test('stale email workers cannot overwrite a newer lease or inflate delivery counters', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'mail_123' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  executeHandler = (sql,args) => {
    if (sql.includes('SELECT id FROM pairing_weeks WHERE week_label=')) return rows([{ id: 10 }]);
    if (sql.startsWith("UPDATE pairing_email_outbox SET status='exhausted'")) return rows([], { rowsAffected: 0 });
    if (sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count')) return rows([
      { id: 70, week_id: 10, user_id: 2, kind: 'paired', recipient_email: 'demo@example.test', status: 'failed', attempt_count: 1 },
      { id: 71, week_id: 10, user_id: 3, kind: 'paired', recipient_email: 'disabled@example.test', status: 'failed', attempt_count: 1 },
      { id: 72, week_id: 10, user_id: 4, kind: 'paired', recipient_email: 'active@example.test', status: 'failed', attempt_count: 1 },
    ]);
    if (sql.includes('SELECT week_label FROM pairing_weeks')) return rows([{ week_label: '2026-W38' }]);
    if (sql.includes("SET status='sending',attempt_count=attempt_count+1")) return rows([{ id: args[0], attempt_count: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: Number(args[0])===2 ? 1 : 0 }]);
    if (sql.includes('SELECT email_enabled FROM user_notification_prefs')) return rows([{ email_enabled: Number(args[0])===3 ? 0 : 1 }]);
    if (sql.includes("SET status='suppressed'")) return Number(args[0])===71 ? rows([{ id: 71 }]) : rows([]);
    if (sql.includes('SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups')) return rows([{
      id: 20, user_a_id: 4, user_b_id: 4, is_ai_pair: 1,
    }]);
    if (sql.includes("SET status='sent'")) return rows([]);
    if (sql.includes('SELECT COUNT(*) AS c FROM pairing_email_outbox')) return rows([{ c: 0 }]);
    return rows();
  };

  const result = await invoke(opsHandler, {
    method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' },
    headers: { 'x-cron-secret': 'cron-secret' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.email_delivery.sent, 0, 'a stale successful sender must not count an uncommitted transition');
  assert.equal(result.body.email_delivery.suppressed, 1, 'only the worker that still owns its lease may count suppression');
  assert.equal(result.body.email_delivery.failed, 0);

  const terminalUpdates=executed.filter(call => call.sql.includes("SET status='sent'") || call.sql.includes("SET status='suppressed'"));
  assert.equal(terminalUpdates.length, 3);
  for(const update of terminalUpdates){
    assert.match(update.sql, /status='sending' AND attempt_count=\? RETURNING/);
    assert.equal(update.args.at(-1), 2);
  }
});

test('operation validation rejects unsupported methods and non-admin mutations', async () => {
  const user = { 'x-test-auth': 'user' };
  const admin = { 'x-test-auth': 'admin' };
  const simple = [
    [{ method: 'PATCH', url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user }, 405],
    [{ method: 'GET', url: '/api/availability', query: { endpoint: 'availability' }, headers: user }, 405],
    [{ method: 'POST', url: '/api/availability', query: { endpoint: 'availability' }, headers: user, body: {} }, 400],
    [{ method: 'PUT', url: '/api/cron/weekly', query: { endpoint: 'weekly' } }, 405],
    [{ method: 'GET', url: '/api/demo-seed', query: { endpoint: 'demo-seed' }, headers: admin }, 405],
    [{ method: 'GET', url: '/api/demo-shuffle', query: { endpoint: 'demo-shuffle' }, headers: admin }, 405],
    [{ method: 'GET', url: '/api/demo-reset', query: { endpoint: 'demo-reset' }, headers: admin }, 405],
    [{ url: '/api/unknown', query: { endpoint: 'unknown' } }, 404],
  ];
  for (const [request, status] of simple) {
    const result = await invoke(opsHandler, request);
    assert.equal(result.status, status, request.url);
  }

  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 2, email: 'user@example.test', is_admin: 0 }]);
    return rows();
  };
  const forbidden = await invoke(opsHandler, {
    method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: user,
  });
  assert.equal(forbidden.status, 403);

  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)')) return rows([]);
    return rows();
  };
  for (const [body, status] of [
    [{ action: 'promote' }, 400],
    [{ action: 'promote', email: 'not-an-email' }, 400],
    [{ action: 'promote', email: 'missing@example.test' }, 404],
  ]) {
    const result = await invoke(opsHandler, {
      method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: admin, body,
    });
    assert.equal(result.status, status);
  }
});

test('adjacent manual reshuffles advance the CAS generation and avoid current pairs', async () => {
  const participants = [
    { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
    { id: 2, name: 'Ada', email: 'ada@example.test', color: '#2', is_available: 1, is_demo: 0 },
    { id: 3, name: 'Grace', email: 'grace@example.test', color: '#3', is_available: 1, is_demo: 0 },
    { id: 4, name: 'Linus', email: 'linus@example.test', color: '#4', is_available: 1, is_demo: 0 },
  ];
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT id, display_name as name') && sql.includes('COALESCE(is_demo,0)=0')) return rows(participants);
    if (sql.includes('SELECT COALESCE(generation,0) AS generation')) {
      return rows(lastPairingRun ? [{ generation: lastPairingRun.generation }] : []);
    }
    if (sql.includes('SELECT pg.user_a_id,pg.user_b_id')) {
      return rows(persistedPairGroups.map(group => ({ ...group, week_id: 10, week_label: '2026-W38' })));
    }
    if (sql.includes('SELECT week_id,generation_token,generation FROM pairing_week_runs')) return rows([{
      week_id: lastPairingRun?.weekId,
      generation_token: lastPairingRun?.generationToken,
      generation: lastPairingRun?.generation,
    }]);
    if (sql.includes('SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups')) return rows(persistedPairGroups);
    return rows();
  };
  const request = {
    method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' },
    headers: { 'x-test-auth': 'admin' }, body: {},
  };
  const first = await invoke(opsHandler, request);
  const second = await invoke(opsHandler, request);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.generation, 1);
  assert.equal(second.body.generation, 2);

  const firstKeys = new Set(first.body.pairs.map(pair => [pair.a_id, pair.b_id].sort((a, b) => a - b).join('-')));
  const secondKeys = new Set(second.body.pairs.map(pair => [pair.a_id, pair.b_id].sort((a, b) => a - b).join('-')));
  assert.equal([...secondKeys].some(key => firstKeys.has(key)), false);

  const claims = executed.filter(call => call.sql.includes('INSERT INTO pairing_week_runs'));
  assert.deepEqual(claims.map(call => call.args[2]), [1, 2]);
  assert.deepEqual(claims.map(call => call.args.at(-1)), [0, 1]);
});

test('video signaling validates membership and supports post, filtered poll, and purge', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT user_a_id,user_b_id FROM pairing_groups')) return rows([{ user_a_id: 2, user_b_id: 4 }]);
    if (sql.includes('INSERT INTO video_signals')) return rows([{ id: 80 }]);
    if (sql.includes('SELECT id, room_id, from_id')) return rows([
      { id: 80, room_id: 'week_10_pair_20', from_id: 'other', to_id: 'peer', type: 'offer', payload: '{}', created_at: 'now' },
      { id: 81, room_id: 'week_10_pair_20', from_id: 'third', to_id: 'someone-else', type: 'ice', payload: '{}', created_at: 'now' },
    ]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const posted = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: { sdp: 'value' } },
  });
  assert.equal(posted.body.id, 80);

  const polled = await invoke(videoHandler, {
    url: '/api/video/signal?room_id=week_10_pair_20&peer_id=peer',
    query: { endpoint: 'signal', room_id: 'week_10_pair_20', peer_id: 'peer' }, headers,
  });
  assert.equal(polled.body.count, 1);

  const purged = await invoke(videoHandler, {
    method: 'DELETE', url: '/api/video/signal', query: { endpoint: 'signal', room_id: 'week_10_pair_20' }, headers,
  });
  assert.equal(purged.body.purged, true);

  const forbidden = await invoke(videoHandler, {
    url: '/api/video/signal', query: { endpoint: 'signal', room_id: 'ad-hoc-room' }, headers,
  });
  assert.equal(forbidden.status, 403);

  const invalidType = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'invalid' },
  });
  assert.equal(invalidType.status, 400);

  const tooLarge = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: 'x'.repeat(20_001) },
  });
  assert.equal(tooLarge.status, 413);

  const missingPayload = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer' },
  });
  assert.equal(missingPayload.status, 400);
  assert.match(missingPayload.body.error, /payload required/i);

  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  const invalidPayload = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: cyclicPayload },
  });
  assert.equal(invalidPayload.status, 400);
  assert.match(invalidPayload.body.error, /JSON serializable/i);

  const unsupported = await invoke(videoHandler, { method: 'PATCH', url: '/api/video/signal', query: { endpoint: 'signal' }, headers });
  assert.equal(unsupported.status, 405);

  const missingPostFields = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers, body: {},
  });
  assert.equal(missingPostFields.status, 400);
  const missingRoom = await invoke(videoHandler, { url: '/api/video/signal', query: { endpoint: 'signal' }, headers });
  assert.equal(missingRoom.status, 400);
  const unknown = await invoke(videoHandler, { url: '/api/video/config', query: { endpoint: 'config' }, headers });
  assert.equal(unknown.status, 400);
});
