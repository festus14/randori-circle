import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { test } from 'node:test';
import '../../assets/execution-stdin.js';
const { createController, MAX_STDIN_BYTES, RETENTION_MS } = globalThis.RandoriExecutionStdin;

function fixture() {
  function node() {
    return {
      value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '', style: {}, children: [], listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      appendChild(child) { this.children.push(child); },
      replaceChildren() { this.children = []; if (Object.hasOwn(this, 'innerHTML')) this.innerHTML = ''; },
      fire(name) { this.listeners[name]?.(); },
    };
  }
  const nodes = Object.fromEntries(['customStdinPanel', 'customStdinEnabled', 'customStdin', 'customStdinStatus', 'customRunOut', 'customStdinClear', 'runOut', 'langSelect'].map(id => [id, node()]));
  nodes.runOut.innerHTML = ''; nodes.langSelect.value = 'javascript';
  const doc = { getElementById: id => nodes[id], createElement: node };
  let identity = 'actor:1:room:A', flag = true, time = 0, serial = 0;
  const timers = new Map();
  const controller = createController({
    doc,
    context: () => identity, enabled: () => flag, now: () => time,
    schedule: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: time + ms }); return id; },
    cancel: id => timers.delete(id),
  });
  return {
    controller, nodes, timers, doc, getIdentity: () => identity,
    setIdentity(value) { identity = value; }, setFlag(value) { flag = value; },
    tick(ms, deliver = true) { time += ms; if (deliver) for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); } },
    input(value) { nodes.customStdinEnabled.checked = true; nodes.customStdinEnabled.fire('change'); nodes.customStdin.value = value; nodes.customStdin.fire('input'); },
  };
}

const good = { ok: true, stdout: '<img src=x onerror=evil()>\nPRIVATE_OUTPUT', stderr: 'PRIVATE_ERROR', exit_code: 0 };

test('private stdin controls fail closed and permit empty stdin only when explicitly selected', () => {
  const f = fixture();
  assert.equal(f.controller.capture(), null);
  f.setFlag(false); f.controller.refresh(); assert.equal(f.nodes.customStdinPanel.hidden, true);
  f.setFlag(true); f.setIdentity(null); f.controller.refresh(); assert.equal(f.nodes.customStdinPanel.hidden, true);
  f.setIdentity('actor:1'); f.controller.refresh(); assert.equal(f.nodes.customStdinPanel.hidden, false);
  f.input(''); const operation = f.controller.capture(); assert.equal(operation.stdin, '');
  assert.equal(f.nodes.customStdin.disabled, false);
});

test('input byte cap includes multibyte text and does not send lossy or oversized strings', () => {
  const f = fixture();
  f.input('é'.repeat(MAX_STDIN_BYTES / 2)); assert.ok(f.controller.capture());
  for (const text of ['é'.repeat(MAX_STDIN_BYTES / 2) + 'x', '\ud800']) {
    f.input(text); assert.throws(() => f.controller.capture(), /size limit/);
    assert.match(f.nodes.customStdinStatus.textContent, /20,000 UTF-8 bytes/);
  }
});

test('private output is rendered as text only and expires within the original run window', () => {
  const f = fixture(); f.input('PRIVATE_INPUT'); const operation = f.controller.capture();
  f.tick(RETENTION_MS - 10); f.controller.render(operation, good);
  assert.equal(f.nodes.customStdin.value, '');
  assert.equal(f.nodes.customRunOut.children[2].textContent, good.stdout);
  assert.equal(f.nodes.customRunOut.children[4].textContent, good.stderr);
  assert.equal(f.nodes.customRunOut.children.every(node => !Object.hasOwn(node, 'innerHTML')), true);
  f.tick(10);
  assert.equal(f.controller.matches(operation), false);
  assert.equal(f.nodes.customRunOut.children.length, 0);
  assert.equal(f.nodes.customStdin.value, ''); assert.equal(f.nodes.customStdinEnabled.checked, false);
  assert.equal(f.timers.size, 0);
});

test('draft input, explicit clear, and deselection clear private data and cancel delayed responses', () => {
  const f = fixture(); f.input('private draft'); f.tick(RETENTION_MS);
  assert.equal(f.nodes.customStdin.value, '');
  for (const clear of [
    () => f.nodes.customStdinClear.fire('click'),
    () => { f.nodes.customStdinEnabled.checked = false; f.nodes.customStdinEnabled.fire('change'); },
    () => f.controller.clear(),
  ]) {
    f.input('private'); const operation = f.controller.capture(); clear();
    f.controller.render(operation, good);
    assert.equal(f.controller.matches(operation), false);
    assert.equal(f.nodes.customStdin.value, ''); assert.equal(f.nodes.customRunOut.children.length, 0);
  }
});

test('actor, circle, room, language, exercise, disabled flag and suspended timers invalidate private results', () => {
  for (const change of [
    f => f.setIdentity('actor:2'), f => f.setIdentity('room:B'), f => f.setIdentity('circle:other'),
    f => f.setIdentity('language:python'), f => f.setIdentity('exercise:other'), f => f.setFlag(false),
    f => f.tick(RETENTION_MS, false),
  ]) {
    const f = fixture(); f.input('PRIVATE'); const operation = f.controller.capture();
    change(f); f.controller.render(operation, good);
    assert.equal(f.controller.matches(operation), false); assert.equal(f.nodes.customRunOut.children.length, 0);
    assert.equal(f.nodes.customStdin.value, '');
  }
});

test('a second run or an input edit cannot be overwritten by the prior response', () => {
  const f = fixture(); f.input('first'); const first = f.controller.capture();
  const second = f.controller.capture(); f.controller.render(first, good);
  assert.equal(f.controller.matches(first), false); assert.equal(f.nodes.customRunOut.children.length, 0);
  f.controller.render(second, { ok: true, timed_out: true, stdout: '', stderr: null, exit_code: null });
  assert.match(f.nodes.customRunOut.children[0].textContent, /timed out and was killed/);
  assert.equal(f.nodes.customRunOut.children[4].textContent, '');
  f.input('edited'); f.controller.render(second, good);
  assert.equal(f.controller.matches(second), false); assert.equal(f.nodes.customRunOut.children.length, 0);
  const third = f.controller.capture(); f.controller.render(third, { ok: false, error: 'PRIVATE_PROVIDER_ERROR' });
  assert.match(f.nodes.customRunOut.children[0].textContent, /Verified results/);
  assert.equal(f.nodes.customRunOut.children.length, 1);
});

// Exercise the shipped inline runner, not a reimplementation of its promise
// handlers. The provider/API and DOM are local fakes; no network or code runs.
function runnerFixture() {
  const f = fixture();
  const source = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const start = source.indexOf('  let verifiedRunEpoch=0;');
  const end = source.indexOf('  const privateStdin=', start);
  const runner = source.match(/(async function upgradedRun\(\)\{[\s\S]*?)\n\n  if\(runBtn\)\{/);
  assert.ok(start >= 0 && end > start && runner, 'inline execution boundaries must remain present');
  const requests = [];
  let loader = false;
  const window = {
    _randori_auth: { me: { id: 7 } },
    _randori_ui: { showLoader() { loader = true; }, hideLoader() { loader = false; } },
    api(_url, options) {
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ options, resolve, reject });
      return pending;
    },
  };
  const context = createContext({
    window, document: f.doc, runOut: f.nodes.runOut, privateStdin: f.controller,
    selectedIdentity: () => ({ slug: 'focus-block-rollup', version: 1 }),
    selectedCatalogueQuestion: () => ({ slug: 'focus-block-rollup', version: 1 }),
    getEditorCode: () => 'function rollUpFocusBlocks(){return [];}',
    activeRoom: f.getIdentity, authorizedPairExecutionRoom: () => null,
    escapeHtml: value => String(value), refreshExerciseSuggestions: () => {},
    catalogueView: {
      languageLabel: () => 'javascript',
      runSummaryView: ({ passed, total }) => ({ status: 'pass', headline: `Result: ${passed}/${total} passed`, mark: 'verified', detail: 'Checked on the server' }),
    },
  });
  runInContext(source.slice(start, end) + '\n' + runner[1], context);
  return { ...f, requests, get loader() { return loader; }, start: () => runInContext('upgradedRun()', context) };
}

for (const [action, invalidate] of [
  ['clear', f => f.nodes.customStdinClear.fire('click')],
  ['edit', f => { f.nodes.customStdin.value = 'new input'; f.nodes.customStdin.fire('input'); }],
  ['uncheck', f => { f.nodes.customStdinEnabled.checked = false; f.nodes.customStdinEnabled.fire('change'); }],
  ['expiry', f => f.tick(RETENTION_MS)],
]) {
  for (const outcome of ['success', 'failure', 'unavailable']) {
    test(`Run then private ${action}: verified ${outcome} settles without showing stale custom output`, async () => {
      const f = runnerFixture(); f.input('PRIVATE_INPUT'); await f.start();
      assert.match(f.nodes.runOut.innerHTML, /Checking your javascript/);
      assert.equal(f.loader, true); assert.equal(f.requests.length, 1);
      assert.equal(Object.hasOwn(f.requests[0].options, 'signal'), false, 'private controls cannot abort the combined verified request');
      invalidate(f);
      if (outcome === 'success') f.requests[0].resolve({
        results: [{ idx: 0, pass: true }], passed_count: 1, total_count: 1,
        custom_run: { ok: true, stdout: 'STALE_PRIVATE_OUTPUT', stderr: '', exit_code: 0 },
      });
      else f.requests[0].reject({ error: 'provider failed', code: outcome === 'unavailable' ? 'execution_unavailable' : 'execution_failed' });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.loader, false);
      assert.doesNotMatch(f.nodes.runOut.innerHTML, /Checking your|PRIVATE_/);
      assert.match(f.nodes.runOut.innerHTML, outcome === 'success' ? /Result: 1\/1 passed/ : outcome === 'unavailable' ? /temporarily unavailable/ : /Execution failed: provider failed/);
      assert.equal(f.nodes.customRunOut.children.length, 0);
      assert.equal(Object.hasOwn(f.requests[0].options.body, 'stdin'), false, 'request bytes are dropped after settlement');
    });
  }
}

test('an actual execution-context change clears obsolete loading state instead of rendering either response', async () => {
  const f = runnerFixture(); f.input('PRIVATE_INPUT'); await f.start();
  f.setIdentity('room:other'); f.controller.refresh();
  f.requests[0].resolve({ passed_count: 1, total_count: 1, results: [], custom_run: good });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.nodes.runOut.innerHTML, ''); assert.equal(f.loader, false);
  assert.equal(f.nodes.customRunOut.children.length, 0);
});
