(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PomodoroCycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BREAK_SECONDS = 300;
  const validDuration = (value) => Number.isInteger(value) && value > 0 && value <= 3660;

  function create({ focusSeconds = 1500, saved = null, now = Date.now, onTransition = () => {} } = {}) {
    let focus = validDuration(focusSeconds) ? focusSeconds : 1500;
    let phase = 'focus';
    let active = false;
    let running = false;
    let remaining = focus;
    let endAt = null;
    if (saved && validDuration(saved.focusSeconds) && ['focus', 'break'].includes(saved.phase)
      && typeof saved.active === 'boolean' && typeof saved.running === 'boolean'
      && Number.isFinite(saved.remainingSeconds) && saved.remainingSeconds >= 0
      && saved.remainingSeconds <= (saved.phase === 'break' ? BREAK_SECONDS : saved.focusSeconds)
      && (!saved.running || (saved.active && Number.isFinite(saved.endAt) && saved.endAt > 0))) {
      focus = saved.focusSeconds;
      phase = saved.active ? saved.phase : 'focus';
      active = saved.active;
      running = saved.running;
      remaining = active ? saved.remainingSeconds : focus;
      endAt = running ? saved.endAt : null;
    }

    function snapshot() {
      return { kind: 'timer', phase, active, running, focusSeconds: focus,
        durationSeconds: phase === 'break' ? BREAK_SECONDS : focus,
        remainingSeconds: remaining, endAt };
    }
    function tick() {
      if (running) {
        remaining = Math.max(0, Math.ceil((endAt - now()) / 1000));
        if (remaining === 0) {
          const completedPhase = phase;
          phase = phase === 'focus' ? 'break' : 'focus';
          remaining = phase === 'break' ? BREAK_SECONDS : focus;
          // After sleep, give the user the entire next phase; never replay missed cycles.
          endAt = now() + remaining * 1000;
          onTransition({ completedPhase, ...snapshot() });
        }
      }
      return snapshot();
    }
    function reset() {
      phase = 'focus'; active = false; running = false; remaining = focus; endAt = null;
      return snapshot();
    }
    function toggle() {
      tick();
      active = true;
      running = !running;
      endAt = running ? now() + remaining * 1000 : null;
      return snapshot();
    }
    function setDuration(seconds) {
      if (!validDuration(seconds) || active) return false;
      focus = seconds;
      reset();
      return true;
    }
    return { snapshot, tick, toggle, reset, setDuration };
  }
  return { create };
});
