import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const sourceFiles = [
  ...readdirSync('api')
    .filter(file => file.endsWith('.js'))
    .sort()
    .map(file => `api/${file}`),
  ...readdirSync('db')
    .filter(file => file.endsWith('.js'))
    .sort()
    .map(file => `db/${file}`),
  'playwright.config.js',
  ...readdirSync('scripts')
    .filter(file => file.endsWith('.mjs'))
    .sort()
    .map(file => `scripts/${file}`),
  ...readdirSync('tests/support')
    .filter(file => file.endsWith('.mjs'))
    .sort()
    .map(file => `tests/support/${file}`),
  ...readdirSync('tests/unit')
    .filter(file => file.endsWith('.mjs'))
    .sort()
    .map(file => `tests/unit/${file}`),
];

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${file} has invalid JavaScript:\n${result.stderr || result.stdout}`,
  );
}

const html = readFileSync('index.html', 'utf8');
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(([, attributes]) => !/\bsrc\s*=/.test(attributes));

assert.ok(inlineScripts.length > 0, 'index.html should contain inline scripts');

for (const [index, match] of inlineScripts.entries()) {
  const offset = match.index + match[0].indexOf(match[2]);
  const line = html.slice(0, offset).split('\n').length;
  try {
    new vm.Script(match[2], { filename: `index.html:inline-script-${index + 1}:line-${line}` });
  } catch (error) {
    throw new Error(`Invalid inline JavaScript beginning at index.html:${line}\n${error.stack}`);
  }
}

console.log(`Syntax OK: ${sourceFiles.length} modules and ${inlineScripts.length} inline scripts`);
