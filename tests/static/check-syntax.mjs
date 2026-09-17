import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

function sourceFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? sourceFilesUnder(`${directory}/${entry.name}`)
      : (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))
        ? [`${directory}/${entry.name}`]
        : [])
    .sort();
}

const sourceFiles = [
  ...sourceFilesUnder('api'),
  ...sourceFilesUnder('db'),
  ...sourceFilesUnder('scripts'),
  'playwright.config.js',
  ...sourceFilesUnder('tests/support'),
  ...sourceFilesUnder('tests/unit'),
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
