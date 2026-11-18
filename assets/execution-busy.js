// Loaded only after an execution_busy response. Holds no submission/input.
export function showExecutionBusy({ doc = document, out, error, run, current, automatic = true,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, privateInput = false }) {
  const seconds = Math.max(1, Math.min(86400, Math.ceil(Number(error.retry_after) || 2)));
  const retryable = automatic && error.reason === 'queued' && seconds <= 20;
  const deadline = now() + seconds * 1000;
  let timer = null, stopped = false;
  out.replaceChildren();
  const box = doc.createElement('div'); box.className = 'test run-summary'; box.dataset.executionBusy = '';
  box.setAttribute('role', 'status');
  const label = doc.createElement('div'); label.className = 'small';
  const detail = doc.createElement('div'); detail.className = 'small muted';
  detail.textContent = !privateInput ? 'Your code was not run. Your editor contents are kept.' : 'Your code was not run. Re-enter private stdin before retrying; it was not retained.';
  const button = doc.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = 'Retry execution';
  const stop = () => { stopped = true; if (timer !== null) cancel(timer); timer = null; button.disabled = true; };
  const retry = () => {
    if (stopped || !current() || now() < deadline) return;
    stop(); run(); // fresh authority/code capture; never replay an old POST
  };
  button.addEventListener('click', retry);
  box.appendChild(label); box.appendChild(detail); box.appendChild(button); out.appendChild(box);
  const tick = () => {
    if (stopped) return;
    if (!current() || doc.visibilityState === 'hidden' || box.isConnected === false) { stop(); return; }
    const remaining = Math.max(0, Math.ceil((deadline - now()) / 1000));
    button.disabled = remaining > 0;
    label.textContent = error.reason === 'quota'
      ? `Execution quota reached — retry in ${remaining}s`
      : remaining ? `Execution is busy — ${retryable ? 'retrying' : 'retry'} in ${remaining}s` : 'Execution is busy — ready to retry';
    if (!remaining) { if (retryable) retry(); return; }
    timer = schedule(tick, Math.min(1000, deadline - now()));
  };
  tick();
  return stop;
}
