import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the browser bundle contains no dynamic new Function execution path', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\bnew\s+Function\s*\(/);
});
