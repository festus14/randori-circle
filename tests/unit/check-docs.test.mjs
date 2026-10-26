import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVED_DOC_ALLOWLIST,
  DOCUMENTED_BUT_UNREAD_ALLOWLIST,
  extractLinks,
  githubSlug,
  inspectDocsContract,
  parseCodeEnvVars,
  parseDecisionLog,
  parseDocumentedEnvVars,
  parseFlagTable,
  validateDecisions,
  validateDocsContract,
  validateDocsIndex,
  validateEnvVars,
  validateFlags,
  validateLinks,
} from '../../scripts/check-docs.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-docs.mjs', import.meta.url));

const ENVIRONMENT = [
  '# Environment',
  '',
  '| Variable | Purpose |',
  '| --- | --- |',
  '| `APP_VAR` | An app var |',
  '',
  '## Feature flags',
  '',
  '| Flag | What it gates |',
  '| --- | --- |',
  '| `FEATURE_ENABLED` | A feature |',
  '',
].join('\n');

const ENV_EXAMPLE = 'APP_VAR=\nFEATURE_ENABLED=false\n';

const DECISIONS = [
  '# Decisions',
  '',
  '## Index',
  '',
  '| ID | Title | Area | Status |',
  '| --- | --- | --- | --- |',
  '| [ID-01](#id-01-first-decision) | First decision | Area | Active |',
  '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |',
  '',
  '## How to add',
  '',
  '## ID-01: First decision',
  '',
  'Body.',
  '',
  '## ID-02: Second decision',
  '',
  'Body.',
  '',
].join('\n');

const GUIDE = '# Guide\n\nNo links.\n';
const CODE = "export const app = process.env.APP_VAR;\nexport const on = process.env.FEATURE_ENABLED === 'true';\n";

function contract(overrides = {}) {
  const docsIndex = overrides.docsIndex ?? [
    '# Docs index',
    '',
    '[ENVIRONMENT.md](ENVIRONMENT.md)',
    '[IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md)',
    '[GUIDE.md](GUIDE.md)',
    '',
  ].join('\n');
  const linkSources = overrides.linkSources ?? [
    {
      path: 'README.md',
      content: '# Title\n\n[Guide](docs/GUIDE.md)\n[Env](docs/ENVIRONMENT.md)\n[Decisions](docs/IMPLEMENTED_DECISIONS.md)\n[Index](docs/README.md)\n',
    },
    { path: 'docs/README.md', content: docsIndex },
    { path: 'docs/ENVIRONMENT.md', content: ENVIRONMENT },
    { path: 'docs/IMPLEMENTED_DECISIONS.md', content: DECISIONS },
    { path: 'docs/GUIDE.md', content: GUIDE },
  ];
  const anchorSources = overrides.anchorSources ?? linkSources;
  return {
    environmentMd: overrides.environmentMd ?? ENVIRONMENT,
    envExample: overrides.envExample ?? ENV_EXAMPLE,
    docsIndex,
    decisions: overrides.decisions ?? DECISIONS,
    linkSources,
    anchorSources,
    code: overrides.code ?? [{ path: 'api/a.js', content: CODE }],
    paths: overrides.paths ?? new Set([
      'README.md', 'docs/README.md', 'docs/ENVIRONMENT.md',
      'docs/IMPLEMENTED_DECISIONS.md', 'docs/GUIDE.md', '.env.example',
    ]),
    directories: overrides.directories ?? new Set(['docs', 'api']),
    docsFiles: overrides.docsFiles ?? [
      'docs/README.md', 'docs/ENVIRONMENT.md', 'docs/IMPLEMENTED_DECISIONS.md', 'docs/GUIDE.md',
    ],
    ...(overrides.archivedAllowlist ? { archivedAllowlist: overrides.archivedAllowlist } : {}),
    ...(overrides.documentedButUnreadAllowlist
      ? { documentedButUnreadAllowlist: overrides.documentedButUnreadAllowlist } : {}),
  };
}

function envContract(code, environmentMd = ENVIRONMENT, envExample = ENV_EXAMPLE) {
  const { environment, example } = parseDocumentedEnvVars(environmentMd, envExample);
  return { code: parseCodeEnvVars(code), environment, example };
}

test('the current repository satisfies the documentation drift contract', () => {
  assert.deepEqual(validateDocsContract(inspectDocsContract()), []);
});

test('a minimal valid fixture contract passes', () => {
  assert.deepEqual(validateDocsContract(contract()), []);
});

test('a code var missing from ENVIRONMENT.md fails naming the read site', () => {
  const errors = validateDocsContract(contract({
    code: [{ path: 'api/a.js', content: "export const x = process.env.UNDOCUMENTED_VAR;\n" }],
    envExample: 'APP_VAR=\nFEATURE_ENABLED=false\nUNDOCUMENTED_VAR=\n',
  }));
  assert.ok(errors.some((error) => error.includes(
    'env var UNDOCUMENTED_VAR is read in api/a.js:1 but is not documented in docs/ENVIRONMENT.md',
  )));
});

test('a code var missing from .env.example fails', () => {
  const environment = ENVIRONMENT.replace(
    '| `APP_VAR` | An app var |',
    '| `APP_VAR` | An app var |\n| `EXAMPLE_MISSING` | Only in the doc |',
  );
  const errors = validateDocsContract(contract({
    code: [{ path: 'api/a.js', content: "export const x = process.env.EXAMPLE_MISSING;\n" }],
    environmentMd: environment,
  }));
  assert.ok(errors.some((error) => error.includes(
    'env var EXAMPLE_MISSING is read in api/a.js:1 but is not listed in .env.example',
  )));
});

test('a documented var the code no longer reads fails', () => {
  const errors = validateDocsContract(contract({
    code: [{ path: 'api/a.js', content: 'export const x = 1;\n' }],
  }));
  assert.ok(errors.some((error) => error.includes(
    'env var APP_VAR is documented in docs/ENVIRONMENT.md:5 but is not read',
  )));
});

test('a var documented in ENVIRONMENT.md but not in .env.example fails', () => {
  const environment = ENVIRONMENT.replace(
    '| `APP_VAR` | An app var |',
    '| `APP_VAR` | An app var |\n| `SYNC_MISSING` | Only in the doc |',
  );
  const errors = validateDocsContract(contract({ environmentMd: environment }));
  assert.ok(errors.some((error) => error.includes(
    'env var SYNC_MISSING is documented in docs/ENVIRONMENT.md:6 but is not listed in .env.example',
  )));
});

test('a var listed in .env.example but not in ENVIRONMENT.md fails', () => {
  const errors = validateDocsContract(contract({
    envExample: 'APP_VAR=\nFEATURE_ENABLED=false\nEXAMPLE_ONLY=\n',
  }));
  assert.ok(errors.some((error) => error.includes(
    'env var EXAMPLE_ONLY is listed in .env.example:3 but is not documented in docs/ENVIRONMENT.md',
  )));
});

test('the documented-but-unread allowlist excuses only the unread direction', () => {
  const allowlist = new Map(DOCUMENTED_BUT_UNREAD_ALLOWLIST);
  const base = envContract([{ path: 'api/a.js', content: 'export const x = 1;\n' }]);
  const errors = validateEnvVars({ ...base, allowlist: new Map([
    ...allowlist,
    ['APP_VAR', 'fixture reason'],
    ['FEATURE_ENABLED', 'fixture reason'],
  ]) });
  assert.deepEqual(errors, []);
  // The same allowlist does not excuse a read-but-undocumented var.
  const readErrors = validateEnvVars({
    ...envContract([{ path: 'api/a.js', content: "export const x = process.env.SECRET_READ;\n" }]),
    allowlist: new Map([['SECRET_READ', 'fixture reason']]),
  });
  assert.ok(readErrors.some((error) => error.includes('SECRET_READ is read in api/a.js:1')));
});

test('mentions in comments and strings are not env reads', () => {
  const code = parseCodeEnvVars([{
    path: 'api/a.js',
    content: [
      '// process.env.NOT_A_READ is only a comment',
      'const text = "process.env.ALSO_NOT_A_READ";',
      'const pattern = /process\\.env\\.REGEX_NOT_A_READ/;',
      'export const x = process.env.APP_VAR;',
      'export const y = process.env.FEATURE_ENABLED;',
    ].join('\n'),
  }]);
  assert.deepEqual([...code.keys()].sort(), ['APP_VAR', 'FEATURE_ENABLED']);
});

test('bracket, optional-chain, destructured and aliased reads count', () => {
  const code = parseCodeEnvVars([{
    path: 'api/a.js',
    content: [
      'const env = process.env;',
      "export const a = process.env['BRACKET_VAR'];",
      'export const b = env?.OPTIONAL_VAR;',
      'const { DESTRUCTURED_VAR } = process.env;',
      "export const FLAG = 'ALIAS_VAR';",
      'export const c = env[FLAG];',
      'export const d = process.env?.CHAINED_VAR;',
    ].join('\n'),
  }]);
  assert.deepEqual([...code.keys()].sort(), [
    'ALIAS_VAR', 'BRACKET_VAR', 'CHAINED_VAR', 'DESTRUCTURED_VAR', 'OPTIONAL_VAR',
  ]);
});

test('key-ring *Env properties resolve through dynamic access', () => {
  const code = parseCodeEnvVars([{
    path: 'api/_key-rotation.js',
    content: [
      'const RINGS = [{ keyEnv: "RING_KEY", versionEnv: "RING_KEY_VERSION" }];',
      'export function read(env = process.env) { return env[RINGS[0].keyEnv]; }',
    ].join('\n'),
  }]);
  assert.ok(code.has('RING_KEY'));
  assert.ok(code.has('RING_KEY_VERSION'));
  // Without any dynamic env access, a *Env property alone is not a read.
  const noAccess = parseCodeEnvVars([{
    path: 'api/other.js',
    content: 'const RINGS = [{ keyEnv: "NOT_A_READ" }];\n',
  }]);
  assert.deepEqual([...noAccess.keys()], []);
});

test('workflow vars, secrets, env contexts and shell references count as reads', () => {
  const workflow = [
    'name: test',
    'on: [push]',
    'jobs:',
    '  job:',
    '    steps:',
    '      - run: |',
    '          FOO: ${{ vars.WORKFLOW_VAR }}',
    '          BAR: ${{ secrets.WORKFLOW_SECRET }}',
    "          echo ${SHELL_VAR} >> ${GITHUB_OUTPUT}",
    '          echo "${INPUT_COPIED}"',
    '          LOCAL_ASSIGNED=not-an-env-var',
    '          echo "${LOCAL_ASSIGNED}"',
  ].join('\n');
  const code = parseCodeEnvVars([
    { path: '.github/workflows/test.yml', content: workflow },
  ]);
  for (const name of ['WORKFLOW_VAR', 'WORKFLOW_SECRET', 'SHELL_VAR', 'GITHUB_OUTPUT']) {
    assert.ok(code.has(name), `expected ${name} to be read`);
  }
  assert.ok(!code.has('LOCAL_ASSIGNED'), 'a shell-local assignment must not count as a read');
  assert.ok(!code.has('FOO'), 'a workflow env key being set is not a read');
});

test('workflow lowercase inputs do not invent env vars', () => {
  const code = parseCodeEnvVars([{
    path: '.github/workflows/test.yml',
    content: 'run: echo ${{ inputs.confirmation }}\n',
  }]);
  assert.deepEqual([...code.keys()], []);
});

test('a code flag missing from the flag table fails', () => {
  const errors = validateFlags({
    ...envContract([{ path: 'api/a.js', content: "export const x = process.env.NEW_FLAG_ENABLED;\n" }]),
    flagTable: parseFlagTable(ENVIRONMENT),
  });
  assert.ok(errors.some((error) => error.includes(
    'flag NEW_FLAG_ENABLED is read in api/a.js:1 but is not in the feature flag table',
  )));
});

test('a flag-table flag the code no longer reads fails', () => {
  const errors = validateFlags({
    ...envContract([{ path: 'api/a.js', content: 'export const x = 1;\n' }]),
    flagTable: parseFlagTable(ENVIRONMENT),
  });
  assert.ok(errors.some((error) => error.includes(
    'flag FEATURE_ENABLED is in the feature flag table (docs/ENVIRONMENT.md:11)',
  )));
  // A plain var ending in _ENABLED that is in neither table nor code is
  // not the flag check's business; env checks cover documented vars.
  assert.ok(!errors.some((error) => error.includes('APP_VAR')));
});

test('githubSlug follows GitHub heading-slug rules', () => {
  assert.equal(githubSlug('ID-91: Product feedback — shared platform (data model + API)'), 'id-91-product-feedback--shared-platform-data-model--api');
  assert.equal(githubSlug('Keep SQLite/Turso now, with migration discipline'), 'keep-sqliteturso-now-with-migration-discipline');
  assert.equal(githubSlug('Force zod to `^4.6.6` via npm overrides'), 'force-zod-to-466-via-npm-overrides');
  assert.equal(githubSlug('  Spaced   out  '), 'spaced---out');
});

test('a relative link to a missing file fails with file and line', () => {
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Missing](NOPE.md)\n' }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(errors, ['docs/GUIDE.md:3: relative link NOPE.md points to missing file docs/NOPE.md']);
});

test('a relative link to a missing anchor fails with file and line', () => {
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Section](OTHER.md#no-such-heading)\n' }],
    anchorSources: [
      { path: 'docs/GUIDE.md', content: '# Guide\n' },
      { path: 'docs/OTHER.md', content: '# Other\n' },
    ],
    paths: new Set(['docs/GUIDE.md', 'docs/OTHER.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(errors, ['docs/GUIDE.md:3: relative link OTHER.md#no-such-heading points to missing anchor #no-such-heading in docs/OTHER.md']);
});

test('duplicate headings get GitHub -1 / -2 anchor suffixes', () => {
  const target = '# Same\n\n# Same\n';
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Second](OTHER.md#same-1)\n[Missing](OTHER.md#same-2)\n' }],
    anchorSources: [
      { path: 'docs/GUIDE.md', content: '# Guide\n' },
      { path: 'docs/OTHER.md', content: target },
    ],
    paths: new Set(['docs/GUIDE.md', 'docs/OTHER.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(errors, ['docs/GUIDE.md:4: relative link OTHER.md#same-2 points to missing anchor #same-2 in docs/OTHER.md']);
});

test('links in fenced blocks, inline code and HTML comments are not links', () => {
  const content = [
    '# Guide',
    '',
    '```md',
    '[Missing](NOPE.md)',
    '```',
    '',
    '`[Also missing](NOPE.md)`',
    '',
    '<!-- [Commented out](NOPE.md) -->',
    '',
    '[Absolute](https://example.test/nope.md#nope)',
    '[Mail](mailto:someone@example.test)',
    '',
  ].join('\n');
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content }],
    anchorSources: [{ path: 'docs/GUIDE.md', content }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(errors, []);
});

test('HTML anchors, directory targets and leading-slash links resolve', () => {
  const errors = validateLinks({
    linkSources: [{
      path: 'docs/GUIDE.md',
      content: '# Guide\n\n[Policy](../privacy.html#policy)\n[Dir](subdir/)\n[Root](/privacy.html#policy)\n',
    }],
    anchorSources: [
      { path: 'docs/GUIDE.md', content: '# Guide\n' },
      { path: 'privacy.html', content: '<section id="policy"></section>\n' },
    ],
    paths: new Set(['docs/GUIDE.md', 'privacy.html']),
    directories: new Set(['docs', 'docs/subdir']),
  });
  assert.deepEqual(errors, []);
});

test('an anchor on a non-Markdown non-HTML target fails', () => {
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Diagram](diagram.png#part)\n' }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md', 'docs/diagram.png']),
    directories: new Set(['docs']),
  });
  assert.ok(errors[0].includes('anchor #part on docs/diagram.png, which is not a Markdown or HTML file'));
});

test('an invalid percent-encoding in a link fails', () => {
  const errors = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Bad](OTHER%.md)\n' }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.ok(errors[0].includes('invalid percent-encoding'));
});

test('extractLinks finds inline links and <a href> links', () => {
  assert.deepEqual(extractLinks('docs/GUIDE.md', '# G\n\n[A](B.md) and <a href="C.md">c</a>\n'), [
    { target: 'B.md', line: 3 },
    { target: 'C.md', line: 3 },
  ]);
});

test('a duplicate decision ID in the Index fails', () => {
  const decisions = DECISIONS.replace(
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |',
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |\n| [ID-02](#id-02-second-decision) | Second decision | Area | Active |',
  );
  const errors = validateDecisions(decisions);
  assert.ok(errors.some((error) => error.includes('duplicate decision ID ID-02 in the Index')));
});

test('a duplicate decision entry fails', () => {
  const decisions = `${DECISIONS}\n## ID-02: Second decision\n\nAgain.\n`;
  const errors = validateDecisions(decisions);
  assert.ok(errors.some((error) => error.includes('duplicate decision entry ID-02')));
});

test('out-of-order Index rows and entries fail', () => {
  const indexSwapped = DECISIONS.replace(
    '| [ID-01](#id-01-first-decision) | First decision | Area | Active |\n| [ID-02](#id-02-second-decision) | Second decision | Area | Active |',
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |\n| [ID-01](#id-01-first-decision) | First decision | Area | Active |',
  );
  assert.ok(validateDecisions(indexSwapped).some((error) => error.includes('Index row ID-01 is out of numeric order')));
  const entrySwapped = DECISIONS.replace(
    '## ID-01: First decision\n\nBody.\n\n## ID-02: Second decision',
    '## ID-02: Second decision\n\nBody.\n\n## ID-01: First decision',
  );
  assert.ok(validateDecisions(entrySwapped).some((error) => error.includes('decision entry ID-01 is out of numeric order')));
});

test('an Index row without an entry and an entry without an Index row fail', () => {
  const rowWithoutEntry = DECISIONS.replace(
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |',
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |\n| [ID-03](#id-03-third-decision) | Third decision | Area | Active |',
  );
  const rowErrors = validateDecisions(rowWithoutEntry);
  assert.ok(rowErrors.some((error) => error.includes('Index row ID-03 has no matching entry')));
  const entryWithoutRow = DECISIONS.replace(
    '| [ID-02](#id-02-second-decision) | Second decision | Area | Active |\n',
    '',
  );
  const entryErrors = validateDecisions(entryWithoutRow);
  assert.ok(entryErrors.some((error) => error.includes('decision entry ID-02 is missing from the Index')));
});

test('an Index title or anchor that does not match its entry fails', () => {
  const wrongTitle = DECISIONS.replace(' | First decision |', ' | First decision, retitled |');
  assert.ok(validateDecisions(wrongTitle).some((error) => error.includes(
    'Index row ID-01 title "First decision, retitled" does not match entry title "First decision"',
  )));
  const wrongAnchor = DECISIONS.replace('#id-01-first-decision', '#id-01-wrong-anchor');
  assert.ok(validateDecisions(wrongAnchor).some((error) => error.includes(
    'Index row ID-01 links to #id-01-wrong-anchor but the entry heading anchors to #id-01-first-decision',
  )));
});

test('a decision log without an Index table fails', () => {
  const errors = validateDecisions('# Decisions\n\n## ID-01: First decision\n');
  assert.ok(errors.some((error) => error.includes('no Index table')));
  assert.deepEqual(validateDecisions(''), ['docs/IMPLEMENTED_DECISIONS.md: decision log is missing or empty']);
  const { indexRows, entries } = parseDecisionLog(null);
  assert.deepEqual([indexRows, entries], [[], []]);
});

test('a docs file missing from the docs index fails', () => {
  const errors = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/ORPHAN.md'],
  });
  assert.deepEqual(errors, [
    'docs/README.md: docs/ORPHAN.md is not indexed in docs/README.md (link it there, or move it under docs/archive/ with a reason)',
  ]);
});

test('archived docs files are exempt from the docs index check, with a reason', () => {
  const withHeader = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/archive/OLD.md'],
    docsContents: [
      { path: 'docs/archive/OLD.md', content: '# Old\n\n<!-- Archived: superseded by GUIDE.md -->\n' },
    ],
  });
  assert.deepEqual(withHeader, []);
  const withReadmeEntry = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/archive/OLD.md'],
    docsContents: [
      { path: 'docs/archive/README.md', content: '# Archive\n\n- [OLD.md](OLD.md) — superseded by GUIDE.md\n' },
    ],
  });
  assert.deepEqual(withReadmeEntry, []);
  const allowlisted = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/ORPHAN.md'],
    archivedAllowlist: new Map([['docs/ORPHAN.md', 'fixture reason']]),
  });
  assert.deepEqual(allowlisted, []);
  assert.ok(ARCHIVED_DOC_ALLOWLIST instanceof Map);
  const missing = validateDocsIndex({ docsIndex: null, docsFiles: [] });
  assert.deepEqual(missing, ['docs/README.md: docs index is missing or empty']);
});

test('an archived doc without a reason fails, as does an allowlist entry without a reason', () => {
  const noReason = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/archive/OLD.md'],
    docsContents: [{ path: 'docs/archive/OLD.md', content: '# Old\n\nNo reason recorded.\n' }],
  });
  assert.ok(noReason.some((error) => error.includes('docs/archive/OLD.md is archived but has no reason')));
  // A bare listing in docs/archive/README.md (no reason text) does not count.
  const bareListing = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/archive/OLD.md'],
    docsContents: [
      { path: 'docs/archive/OLD.md', content: '# Old\n' },
      { path: 'docs/archive/README.md', content: '# Archive\n\n[OLD.md](OLD.md)\n' },
    ],
  });
  assert.ok(bareListing.some((error) => error.includes('is archived but has no reason')));
  const emptyAllowlist = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/ORPHAN.md'],
    archivedAllowlist: new Map([['docs/ORPHAN.md', '   ']]),
  });
  assert.deepEqual(emptyAllowlist, [
    'docs/README.md: docs/ORPHAN.md is in ARCHIVED_DOC_ALLOWLIST without a non-empty reason',
  ]);
  // Distinct files with empty-reason entries are each reported once.
  const twoEmpty = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/ORPHAN.md', 'docs/OTHER.md'],
    archivedAllowlist: new Map([['docs/ORPHAN.md', '   '], ['docs/OTHER.md', '']]),
  });
  assert.deepEqual(twoEmpty, [
    'docs/README.md: docs/ORPHAN.md is in ARCHIVED_DOC_ALLOWLIST without a non-empty reason',
    'docs/README.md: docs/OTHER.md is in ARCHIVED_DOC_ALLOWLIST without a non-empty reason',
  ]);
});

test('missing required files and empty sections are reported, not crashed on', () => {
  const errors = validateDocsContract({
    environmentMd: null,
    envExample: null,
    docsIndex: null,
    decisions: null,
    linkSources: [],
    anchorSources: [],
    code: [],
    paths: new Set(),
    directories: new Set(),
    docsFiles: [],
  });
  for (const required of ['README.md', 'docs/README.md', 'docs/ENVIRONMENT.md', 'docs/IMPLEMENTED_DECISIONS.md', '.env.example']) {
    assert.ok(errors.some((error) => error.includes(`${required}: required documentation file is missing`)), required);
  }
  assert.ok(errors.some((error) => error.includes('env and flag checks skipped')));
  assert.ok(errors.some((error) => error.includes('decision checks skipped')));
  assert.ok(errors.some((error) => error.includes('docs-index check skipped')));
  assert.deepEqual(validateDocsContract(null), ['docs contract must be an object']);
  // A code file with no content is skipped, not crashed on: the
  // documented vars then simply look unread.
  const nullCode = validateDocsContract({ ...contract(), code: [{ path: 'api/a.js', content: null }] });
  assert.ok(nullCode.some((error) => error.includes('env var APP_VAR is documented')));
});

test('the CLI passes on a minimal fixture tree and fails with file:line on drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    const write = (rel, content) => {
      const target = join(dir, rel);
      mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(target, content);
    };
    write('README.md', '# Fixture\n\n[Guide](docs/GUIDE.md)\n');
    write('docs/README.md', '# Index\n\n[GUIDE.md](GUIDE.md)\n[ENVIRONMENT.md](ENVIRONMENT.md)\n[IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md)\n');
    write('docs/ENVIRONMENT.md', ENVIRONMENT);
    write('docs/IMPLEMENTED_DECISIONS.md', DECISIONS);
    write('docs/GUIDE.md', GUIDE);
    write('.env.example', ENV_EXAMPLE);
    write('api/a.js', CODE);
    const pass = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);
    assert.deepEqual(JSON.parse(pass.stdout), {
      ok: true, gate: 'documentation-drift', providerNetworkRequired: false, externalMutation: false,
    });
    write('api/a.js', "export const x = process.env.DRIFTED_VAR;\n");
    const fail = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(fail.status, 1);
    const payload = JSON.parse(fail.stderr);
    assert.equal(payload.ok, false);
    assert.ok(payload.errors.some((error) => error.includes('DRIFTED_VAR is read in api/a.js:1')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI runs through a symlinked script path (realpath main guard)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-symlink-'));
  try {
    const write = (rel, content) => {
      const target = join(dir, rel);
      mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(target, content);
    };
    write('README.md', '# Fixture\n\n[Guide](docs/GUIDE.md)\n');
    write('docs/README.md', '# Index\n\n[GUIDE.md](GUIDE.md)\n[ENVIRONMENT.md](ENVIRONMENT.md)\n[IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md)\n');
    write('docs/ENVIRONMENT.md', ENVIRONMENT);
    write('docs/IMPLEMENTED_DECISIONS.md', DECISIONS);
    write('docs/GUIDE.md', GUIDE);
    write('.env.example', ENV_EXAMPLE);
    write('api/a.js', CODE);
    const link = join(dir, 'check-docs-link.mjs');
    symlinkSync(SCRIPT, link);
    const pass = spawnSync(process.execPath, [link], { cwd: dir, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);
    assert.equal(JSON.parse(pass.stdout).ok, true);
    write('api/a.js', "export const x = process.env.DRIFTED_VAR;\n");
    const fail = spawnSync(process.execPath, [link], { cwd: dir, encoding: 'utf8' });
    assert.equal(fail.status, 1);
    assert.ok(JSON.parse(fail.stderr).errors.some((error) => error.includes('DRIFTED_VAR')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reference-style links are checked in both directions', () => {
  const missing = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Missing][ref1]\n\n[ref1]: NOPE.md\n' }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(missing, ['docs/GUIDE.md:3: relative link NOPE.md points to missing file docs/NOPE.md']);
  for (const [name, content] of [
    ['full', '# G\n\n[Text][label]\n\n[label]: NOPE.md\n'],
    ['collapsed', '# G\n\n[NOPE.md][]\n\n[NOPE.md]: NOPE.md\n'],
    ['shortcut', '# G\n\n[NOPE.md]\n\n[NOPE.md]: NOPE.md\n'],
  ]) {
    const errors = validateLinks({
      linkSources: [{ path: 'docs/GUIDE.md', content }],
      anchorSources: [{ path: 'docs/GUIDE.md', content: '# G\n' }],
      paths: new Set(['docs/GUIDE.md']),
      directories: new Set(['docs']),
    });
    assert.equal(errors.length, 1, `${name} reference must be checked exactly once`);
  }
  // A shortcut reference with no definition is literal text, not a link.
  assert.deepEqual(extractLinks('docs/GUIDE.md', '# G\n\n[Not a link]\n'), []);
  // A doc linked from docs/README.md ONLY via reference style is indexed.
  const indexed = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md][guide]\n\n[guide]: GUIDE.md\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md'],
  });
  assert.deepEqual(indexed, []);
  // Reference definitions accept angle destinations and titles.
  assert.deepEqual(
    extractLinks('docs/GUIDE.md', '# G\n\n[Text][a]\n\n[a]: <B.md> "title"\n'),
    [{ target: 'B.md', line: 3 }, { target: 'B.md', line: 5 }],
  );
});

test('dedup keeps distinct missing-file targets and repeated links to one target', () => {
  const distinct = validateLinks({
    linkSources: [{
      path: 'docs/GUIDE.md',
      content: '# Guide\n\n[One][r1]\n\n[Two][r2]\n\n[r1]: NOPE1.md\n\n[r2]: NOPE2.md\n',
    }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(distinct, [
    'docs/GUIDE.md:3: relative link NOPE1.md points to missing file docs/NOPE1.md',
    'docs/GUIDE.md:5: relative link NOPE2.md points to missing file docs/NOPE2.md',
  ]);
  // Two inline links to the same missing file are one diagnostic.
  const repeated = validateLinks({
    linkSources: [{
      path: 'docs/GUIDE.md',
      content: '# Guide\n\n[One](NOPE.md)\n\n[Two](NOPE.md)\n',
    }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(repeated, ['docs/GUIDE.md:3: relative link NOPE.md points to missing file docs/NOPE.md']);
  // Different missing anchors on the same existing file stay distinct.
  const anchors = validateLinks({
    linkSources: [{
      path: 'docs/GUIDE.md',
      content: '# Guide\n\n[One](OTHER.md#alpha)\n\n[Two](OTHER.md#beta)\n',
    }],
    anchorSources: [
      { path: 'docs/GUIDE.md', content: '# Guide\n' },
      { path: 'docs/OTHER.md', content: '# Other\n' },
    ],
    paths: new Set(['docs/GUIDE.md', 'docs/OTHER.md']),
    directories: new Set(['docs']),
  });
  assert.equal(anchors.length, 2);
  assert.ok(anchors.some((error) => error.includes('#alpha')));
  assert.ok(anchors.some((error) => error.includes('#beta')));
});

test('inline links accept single-quote / paren titles and multi-line destinations', () => {
  for (const content of [
    "# G\n\n[Missing](NOPE.md 'title')\n",
    '# G\n\n[Missing](NOPE.md (title))\n',
    '# G\n\n[Missing](\nNOPE.md)\n',
    '# G\n\n[Missing](NOPE.md\n"title")\n',
  ]) {
    const errors = validateLinks({
      linkSources: [{ path: 'docs/GUIDE.md', content }],
      anchorSources: [{ path: 'docs/GUIDE.md', content: '# G\n' }],
      paths: new Set(['docs/GUIDE.md']),
      directories: new Set(['docs']),
    });
    assert.ok(errors.some((error) => error.includes('NOPE.md points to missing file')), content);
  }
});

test('fenced examples do not count as documenting vars, flags or decision rows', () => {
  const { environment } = parseDocumentedEnvVars([
    '# Environment',
    '',
    '```md',
    '| `FENCED_VAR` | In an example |',
    '```',
    '',
    '| Variable | Purpose |',
    '| --- | --- |',
    '| `REAL_VAR` | Real |',
    '',
    '### Dispatch inputs and step values',
    '',
    '```md',
    '`FENCED_DISPATCH`',
    '```',
    '',
    '`REAL_DISPATCH`',
    '',
  ].join('\n'), 'REAL_VAR=\nREAL_DISPATCH=\n');
  assert.ok(!environment.has('FENCED_VAR'));
  assert.ok(!environment.has('FENCED_DISPATCH'));
  assert.ok(environment.has('REAL_VAR'));
  assert.ok(environment.has('REAL_DISPATCH'));
  const flags = parseFlagTable([
    '## Feature flags',
    '',
    '```md',
    '| `FENCED_FLAG` | Example |',
    '```',
    '',
    '| Flag | What |',
    '| --- | --- |',
    '| `REAL_FLAG` | Real |',
  ].join('\n'));
  assert.ok(!flags.has('FENCED_FLAG'));
  assert.ok(flags.has('REAL_FLAG'));
  const decisions = validateDecisions([
    '# Decisions',
    '',
    '## Index',
    '',
    '| ID | Title |',
    '| --- | --- |',
    '| [ID-01](#id-01-first-decision) | First decision |',
    '',
    '```md',
    '| [ID-99](#id-99-fake) | Fake row |',
    '```',
    '',
    '## ID-01: First decision',
    '',
    'Body.',
  ].join('\n'));
  assert.deepEqual(decisions, []);
});

test('an unrelated env object does not invent an env read', () => {
  const unrelated = parseCodeEnvVars([
    { path: 'api/a.js', content: 'export function read(env) { return env.UNRELATED_VAR; }\n' },
    { path: 'api/b.js', content: "const env = { UNRELATED_VAR: 'x' };\nexport const y = env.UNRELATED_VAR;\n" },
    { path: 'api/c.js', content: "export function read(env) { return env.UNRELATED_VAR; }\nread({ UNRELATED_VAR: 'x' });\n" },
  ]);
  assert.deepEqual([...unrelated.keys()], []);
  const proved = parseCodeEnvVars([
    { path: 'api/a.js', content: 'export function read(env = process.env) { return env.PROVED_VAR; }\n' },
    { path: 'api/b.js', content: 'const env = process.env;\nexport const y = env.PROVED_TWO;\n' },
    { path: 'api/c.js', content: 'const { env } = process;\nexport const z = env.PROVED_THREE;\n' },
    { path: 'api/d.js', content: "export function helper(env) { return env.TRANSITIVE_VAR; }\nexport function main(env = process.env) { return helper(env); }\n" },
    { path: 'api/e.js', content: 'const env = { ...process.env };\nexport const w = env.SPREAD_VAR;\n' },
    { path: 'api/f.js', content: 'export function read(env = process.env) { const copy = Object.assign({}, env); return copy.ASSIGN_VAR; }\n' },
  ]);
  for (const name of ['PROVED_VAR', 'PROVED_TWO', 'PROVED_THREE', 'TRANSITIVE_VAR', 'SPREAD_VAR', 'ASSIGN_VAR']) {
    assert.ok(proved.has(name), name);
  }
});

test('cross-file imported string consts and 1-char vars count', () => {
  const code = parseCodeEnvVars([
    { path: 'api/constants.js', content: "export const FLAG = 'CROSS_FILE_VAR';\n" },
    { path: 'api/b.js', content: "import { FLAG } from './constants.js';\nexport const x = process.env[FLAG];\n" },
    { path: 'api/c.js', content: 'export const y = process.env.A;\n' },
    { path: 'api/d.js', content: "import * as C from './constants.js';\nexport const z = process.env[C.FLAG];\n" },
  ]);
  assert.ok(code.has('CROSS_FILE_VAR'));
  assert.ok(code.has('A'));
  // A 1-char documented var is documented, not unread.
  const { environment, example } = parseDocumentedEnvVars(
    '# Environment\n\n| Variable | Purpose |\n| --- | --- |\n| `A` | One char |\n',
    'A=\n',
  );
  assert.ok(environment.has('A'));
  assert.ok(example.has('A'));
});

test('cross-file env parameters are proved by a cross-file call site', () => {
  const code = parseCodeEnvVars([
    { path: 'scripts/helper.js', content: 'export function helper(env) { return env.CROSS_PARAM; }\n' },
    { path: 'scripts/main.js', content: "import { helper } from './helper.js';\nhelper(process.env);\n" },
    { path: 'scripts/other.js', content: 'export function other(env) { return env.CROSS_BAD; }\n' },
    { path: 'scripts/caller.js', content: "import { other } from './other.js';\nother({ CROSS_BAD: 'x' });\n" },
  ]);
  assert.ok(code.has('CROSS_PARAM'));
  assert.ok(!code.has('CROSS_BAD'));
});

test('the scanner covers .js/.mjs/.cjs in code dirs and .yaml workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-ext-'));
  try {
    const write = (rel, content) => {
      const target = join(dir, rel);
      mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(target, content);
    };
    write('README.md', '# Fixture\n\n[Guide](docs/GUIDE.md)\n');
    write('docs/README.md', '# Index\n\n[GUIDE.md](GUIDE.md)\n[ENVIRONMENT.md](ENVIRONMENT.md)\n[IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md)\n');
    write('docs/ENVIRONMENT.md', ENVIRONMENT);
    write('docs/IMPLEMENTED_DECISIONS.md', DECISIONS);
    write('docs/GUIDE.md', GUIDE);
    write('.env.example', ENV_EXAMPLE);
    write('api/a.js', CODE);
    write('scripts/foo.js', "export const x = process.env.SCRIPTS_JS_VAR;\n");
    write('api/b.mjs', "export const x = process.env.API_MJS_VAR;\n");
    write('api/c.cjs', "module.exports = { x: process.env.API_CJS_VAR };\n");
    write('.github/workflows/extra.yaml', 'name: extra\non: [push]\njobs:\n  job:\n    steps:\n      - run: echo $WORKFLOW_YAML_VAR\n');
    const errors = validateDocsContract(inspectDocsContract(dir));
    for (const name of ['SCRIPTS_JS_VAR', 'API_MJS_VAR', 'API_CJS_VAR', 'WORKFLOW_YAML_VAR']) {
      assert.ok(errors.some((error) => error.includes(name)), `${name} must be scanned`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one-line run: VAR=… assignments are shell-local', () => {
  const code = parseCodeEnvVars([
    {
      path: '.github/workflows/test.yml',
      content: [
        'name: test',
        'on: [push]',
        'jobs:',
        '  job:',
        '    steps:',
        '      - run: MASKED_VAR=local',
        '      - run: echo $MASKED_VAR',
        '      - run: export EXPORTED_MASK=local',
        '      - run: echo $EXPORTED_MASK',
        '      - run: echo $REAL_VAR',
      ].join('\n'),
    },
  ]);
  assert.ok(!code.has('MASKED_VAR'), 'run: assignment must not invent a read');
  assert.ok(!code.has('EXPORTED_MASK'));
  assert.ok(code.has('REAL_VAR'));
});

test('a symlinked docs file is followed by the repo walk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-docs-symfile-'));
  try {
    const write = (rel, content) => {
      const target = join(dir, rel);
      mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(target, content);
    };
    write('README.md', '# Fixture\n\n[Guide](docs/GUIDE.md)\n');
    write('docs/README.md', '# Index\n\n[GUIDE.md](GUIDE.md)\n[ENVIRONMENT.md](ENVIRONMENT.md)\n[IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md)\n[LINKED.md](LINKED.md)\n');
    write('docs/ENVIRONMENT.md', ENVIRONMENT);
    write('docs/IMPLEMENTED_DECISIONS.md', DECISIONS);
    write('docs/GUIDE.md', GUIDE);
    write('.env.example', ENV_EXAMPLE);
    write('api/a.js', CODE);
    write('real-linked.md', '# Linked\n');
    symlinkSync(join(dir, 'real-linked.md'), join(dir, 'docs/LINKED.md'));
    const contract = inspectDocsContract(dir);
    assert.ok(contract.docsFiles.includes('docs/LINKED.md'));
    assert.deepEqual(validateDocsContract(contract), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('query strings, split destinations and escaped parentheses in links', () => {
  const query = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Other](OTHER.md?raw=true)\n[Anchored](OTHER.md?x=1#other)\n' }],
    anchorSources: [
      { path: 'docs/GUIDE.md', content: '# Guide\n' },
      { path: 'docs/OTHER.md', content: '# Other\n' },
    ],
    paths: new Set(['docs/GUIDE.md', 'docs/OTHER.md']),
    directories: new Set(['docs']),
  });
  assert.deepEqual(query, []);
  // A destination split across lines in the middle of the name still resolves.
  const split = validateLinks({
    linkSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n\n[Missing](NO\nPE.md)\n' }],
    anchorSources: [{ path: 'docs/GUIDE.md', content: '# Guide\n' }],
    paths: new Set(['docs/GUIDE.md']),
    directories: new Set(['docs']),
  });
  assert.ok(split.some((error) => error.includes('NOPE.md points to missing file docs/NOPE.md')));
  // Escaped parentheses are a filename with parentheses, not a terminator.
  assert.deepEqual(
    extractLinks('docs/GUIDE.md', '# G\n\n[File](file\\(1\\).md)\n'),
    [{ target: 'file(1).md', line: 3 }],
  );
});

test('function expressions, Object.assign copies and malformed code', () => {
  const code = parseCodeEnvVars([
    { path: 'api/a.js', content: 'export const read = function (env = process.env) { return env.FUNC_EXPR_VAR; };\n' },
    { path: 'api/b.js', content: 'export function read(env = process.env) { const copy = Object.assign({}, process.env); return copy.ASSIGN_ENV_VAR; }\n' },
    { path: 'api/c.js', content: 'export function broken(env = process.env { return env.BROKEN_VAR; }\n' },
  ]);
  assert.ok(code.has('FUNC_EXPR_VAR'));
  assert.ok(code.has('ASSIGN_ENV_VAR'));
  assert.ok(!code.has('BROKEN_VAR'), 'malformed code must not crash or invent a read');
});

test('default + named imports, re-exported helpers and Map docsContents', () => {
  const code = parseCodeEnvVars([
    { path: 'api/constants.js', content: "export default 'DEFAULT_VAR';\nexport const FLAG = 'NAMED_VAR';\n" },
    { path: 'api/b.js', content: "import Def, { FLAG } from './constants.js';\nexport const x = process.env[Def];\nexport const y = process.env[FLAG];\n" },
    { path: 'scripts/helper.js', content: 'export function helper(env) { return env.REEXPORT_PARAM; }\n' },
    { path: 'scripts/middle.js', content: "export { helper } from './helper.js';\n" },
    { path: 'scripts/main.js', content: "import { helper } from './middle.js';\nhelper(process.env);\n" },
  ]);
  assert.ok(code.has('DEFAULT_VAR'));
  assert.ok(code.has('NAMED_VAR'));
  assert.ok(code.has('REEXPORT_PARAM'));
  const indexed = validateDocsIndex({
    docsIndex: '# Index\n\n[GUIDE.md](GUIDE.md)\n',
    docsFiles: ['docs/README.md', 'docs/GUIDE.md', 'docs/archive/OLD.md'],
    docsContents: new Map([['docs/archive/OLD.md', '<!-- Archived: superseded -->\n']]),
  });
  assert.deepEqual(indexed, []);
  // A bare Index row (no link) is parsed, then fails its anchor check.
  const bare = validateDecisions(DECISIONS.replace(
    '| [ID-01](#id-01-first-decision) | First decision | Area | Active |',
    '| ID-01 | First decision | Area | Active |',
  ));
  assert.ok(bare.some((error) => error.includes('links to #(none)')));
});

test('inspectDocsContract on a missing directory reports missing files, not crashes', () => {
  const errors = validateDocsContract(inspectDocsContract('/tmp/does-not-exist-randori-check-docs'));
  assert.ok(errors.some((error) => error.includes('README.md: required documentation file is missing')));
});
