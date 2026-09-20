import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('weekly availability is an explicit two-action decision, not a checkbox', () => {
  assert.match(html, /id="availAvailable"[^>]+type="button"[^>]+aria-pressed="false"/);
  assert.match(html, /id="availSkip"[^>]+type="button"[^>]+aria-pressed="false"/);
  assert.match(html, /id="availActions"[^>]+role="group"[^>]+aria-labelledby="availTitle"/);
  assert.doesNotMatch(html, /id="availToggle"/);
});

test('availability is initially hidden with one renderer-owned display declaration', () => {
  const tag = html.match(/<div id="availabilityWrap"[^>]*>/)?.[0];
  assert.ok(tag, 'availability region exists');
  assert.match(tag, /style="display:none;/);
  assert.equal(tag.match(/\bdisplay\s*:/g)?.length, 1);
});
