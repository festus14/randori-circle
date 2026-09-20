(function installInviteGate(root) {
  const MAX_PREPARED_INVITE_SECONDS = 10 * 60;
  const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  function validLifetimeSeconds(value) {
    return Number.isSafeInteger(value)
      && value >= 1
      && value <= MAX_PREPARED_INVITE_SECONDS
      ? value
      : null;
  }

  function shouldRetainRateLimitedBinding({ status, requestedBinding, storedBinding } = {}) {
    return status === 429
      && typeof requestedBinding === 'string'
      && BINDING_PATTERN.test(requestedBinding)
      && storedBinding === requestedBinding;
  }

  function createInviteGate({ now } = {}) {
    const readClock = typeof now === 'function'
      ? now
      : () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now());
    let lastNow = 0;
    let generation = 0;
    let phase = 'idle';
    let preparationStartedAt = null;
    let deadline = null;
    let binding = null;

    function monotonicNow() {
      const value = Number(readClock());
      if (!Number.isFinite(value) || value < 0) return null;
      lastNow = Math.max(lastNow, value);
      return lastNow;
    }

    function beginPreparation() {
      generation += 1;
      preparationStartedAt = monotonicNow();
      phase = preparationStartedAt === null ? 'unavailable' : 'preparing';
      deadline = null;
      binding = null;
      return generation;
    }

    function completePreparation(preparationGeneration, { ok, expiresInSeconds, inviteBinding } = {}) {
      if (preparationGeneration !== generation || phase !== 'preparing') return false;
      const lifetime = validLifetimeSeconds(expiresInSeconds);
      const nextBinding = typeof inviteBinding === 'string' && BINDING_PATTERN.test(inviteBinding)
        ? inviteBinding
        : null;
      const current = monotonicNow();
      if (ok !== true || lifetime === null || nextBinding === null || current === null
        || preparationStartedAt === null) {
        phase = 'unavailable';
        preparationStartedAt = null;
        deadline = null;
        binding = null;
        return false;
      }
      const nextDeadline = preparationStartedAt + lifetime * 1000;
      preparationStartedAt = null;
      if (!Number.isFinite(nextDeadline) || current >= nextDeadline) {
        phase = Number.isFinite(nextDeadline) ? 'expired' : 'unavailable';
        deadline = null;
        binding = null;
        return false;
      }
      phase = 'ready';
      deadline = nextDeadline;
      binding = nextBinding;
      return true;
    }

    function liveSnapshot() {
      const current = monotonicNow();
      if (phase !== 'ready' || deadline === null || current === null || current >= deadline) return null;
      return Object.freeze({ generation, deadline, binding });
    }

    function matches(snapshot) {
      if (!snapshot || snapshot.generation !== generation || snapshot.deadline !== deadline
        || snapshot.binding !== binding) return false;
      return liveSnapshot() !== null;
    }

    function remainingMilliseconds(snapshot) {
      if (snapshot && (snapshot.generation !== generation || snapshot.deadline !== deadline
        || snapshot.binding !== binding)) return 0;
      const current = monotonicNow();
      if (phase !== 'ready' || deadline === null || current === null) return 0;
      return Math.max(0, deadline - current);
    }

    function expire(snapshot) {
      if (!snapshot || snapshot.generation !== generation || snapshot.deadline !== deadline
        || snapshot.binding !== binding) return false;
      const current = monotonicNow();
      if (phase !== 'ready' || deadline === null || (current !== null && current < deadline)) return false;
      generation += 1;
      phase = 'expired';
      preparationStartedAt = null;
      deadline = null;
      binding = null;
      return true;
    }

    function invalidate(nextPhase = 'invalidated') {
      generation += 1;
      phase = typeof nextPhase === 'string' && /^[a-z_]{1,32}$/.test(nextPhase)
        ? nextPhase
        : 'invalidated';
      preparationStartedAt = null;
      deadline = null;
      binding = null;
      return generation;
    }

    return Object.freeze({
      beginPreparation,
      completePreparation,
      liveSnapshot,
      matches,
      remainingMilliseconds,
      expire,
      invalidate,
      get generation() { return generation; },
      get phase() { return phase; },
    });
  }

  root._randori_invite_gate = Object.freeze({
    MAX_PREPARED_INVITE_SECONDS,
    create: createInviteGate,
    shouldRetainRateLimitedBinding,
    validLifetimeSeconds,
  });
})(typeof window !== 'undefined' ? window : globalThis);
