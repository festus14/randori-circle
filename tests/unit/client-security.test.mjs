import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('the browser bundle contains no dynamic new Function execution path', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\bnew\s+Function\s*\(/);
});

test('the prepared-invite gate loads before token consumption and third-party scripts',()=>{
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const gate=html.indexOf('<script src="/assets/invite-gate.js"></script>');
  const tokenConsumer=html.indexOf('/* Consume invitation capabilities');
  const thirdParty=html.indexOf('https://js-de.sentry-cdn.com/');
  assert.ok(gate>=0&&gate<tokenConsumer&&tokenConsumer<thirdParty);
  assert.doesNotMatch(html,/localStorage\.setItem\(['"]randori-invite/);
});
