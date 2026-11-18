// Private request-only stdin controls (#467). Classic script, like catalogue-view.
// No storage, broadcasts, editor/CRDT state, telemetry, or HTML rendering.
(function installExecutionStdin(root) {
  const MAX_STDIN_BYTES = 20_000;
  const RETENTION_MS = 60_000;

  function createController({ doc, context, enabled, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout }) {
    const panel = doc.getElementById('customStdinPanel');
    const checkbox = doc.getElementById('customStdinEnabled');
    const input = doc.getElementById('customStdin');
    const status = doc.getElementById('customStdinStatus');
    const output = doc.getElementById('customRunOut');
    const clearButton = doc.getElementById('customStdinClear');
    let identity = context(), epoch = 0, timer = null, expiresAt = 0;

    function clear() {
      epoch += 1;
      cancel(timer); timer = null; expiresAt = 0;
      input.value = ''; checkbox.checked = false; input.disabled = true;
      status.textContent = ''; output.replaceChildren();
    }
    function refresh() {
      const next = context();
      if (next !== identity || !enabled() || (expiresAt && now() >= expiresAt)) clear();
      identity = next;
      panel.hidden = !identity || !enabled();
      return !panel.hidden;
    }
    function expireAfterWindow() {
      cancel(timer);
      expiresAt = now() + RETENTION_MS;
      timer = schedule(clear, RETENTION_MS);
    }
    function matches(operation) {
      return operation && refresh() && operation.epoch === epoch
        && operation.context === identity && now() < expiresAt;
    }
    function selected() { return refresh() && checkbox.checked; }
    function capture() {
      if (!selected()) return null;
      const stdin = input.value;
      if (!stdin.isWellFormed() || new TextEncoder().encode(stdin).byteLength > MAX_STDIN_BYTES) {
        status.textContent = 'Use well-formed text of at most 20,000 UTF-8 bytes.';
        throw new Error('Custom input exceeds its text or size limit.');
      }
      epoch += 1;
      input.value = ''; // Consume the DOM copy at dispatch, not on response.
      output.replaceChildren();
      expireAfterWindow();
      status.textContent = 'Running privately…';
      return { stdin, epoch, context: identity };
    }
    function render(operation, result) {
      if (!matches(operation)) return;
      // Input was consumed at dispatch; output has only the remainder of the
      // original 60-second window, never a fresh response-retention window.
      input.value = '';
      output.replaceChildren();
      const heading = doc.createElement('p');
      heading.className = 'small';
      heading.textContent = result?.ok === true
        ? result.timed_out === true ? 'Custom run timed out and was killed.' : `Custom run · exit ${Number.isInteger(result.exit_code) ? result.exit_code : 'unknown'}`
        : 'Custom run failed. Verified results are shown above.';
      output.appendChild(heading);
      if (result?.ok === true) {
        for (const [name, label] of [['stdout', 'Output'], ['stderr', 'Errors']]) {
          const title = doc.createElement('p'); title.className = 'small muted'; title.textContent = label;
          const text = doc.createElement('pre'); text.className = 'small';
          text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
          text.textContent = typeof result[name] === 'string' ? result[name] : '';
          output.appendChild(title); output.appendChild(text);
        }
      }
      status.textContent = 'Private output expires 60 seconds after Run. It is not saved.';
    }
    checkbox.addEventListener('change', () => {
      if (!checkbox.checked) clear();
      else { input.disabled = false; expireAfterWindow(); }
    });
    input.addEventListener('input', () => {
      // Editing invalidates delayed results from the prior input.
      epoch += 1; output.replaceChildren();
      const bytes = new TextEncoder().encode(input.value).byteLength;
      status.textContent = `${bytes.toLocaleString()} / 20,000 UTF-8 bytes`;
      expireAfterWindow();
    });
    clearButton.addEventListener('click', clear);
    refresh();
    return Object.freeze({ selected, capture, render, clear, refresh, matches });
  }

  root.RandoriExecutionStdin = Object.freeze({ MAX_STDIN_BYTES, RETENTION_MS, createController });
})(typeof window === 'undefined' ? globalThis : window);
