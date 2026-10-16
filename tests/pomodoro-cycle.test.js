const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../renderer/pomodoro');

test('25 minute focus alternates with 5 minute rest continuously', () => {
  let clock = 1000;
  const transitions = [];
  const timer = create({ now: () => clock, onTransition: (state) => transitions.push(state.phase) });
  assert.equal(timer.snapshot().remainingSeconds, 1500);
  timer.toggle();
  for (let cycle = 0; cycle < 3; cycle++) {
    clock += 1500000;
    assert.deepEqual([timer.tick().phase, timer.snapshot().remainingSeconds, timer.snapshot().running], ['break', 300, true]);
    timer.tick();
    clock += 300000;
    assert.deepEqual([timer.tick().phase, timer.snapshot().remainingSeconds, timer.snapshot().running], ['focus', 1500, true]);
  }
  assert.deepEqual(transitions, ['break', 'focus', 'break', 'focus', 'break', 'focus']);
});
test('pause resumes same phase and preserves the configured focus duration', () => {
  let clock = 1000;
  const timer = create({ now: () => clock });
  timer.toggle(); clock += 1500000; timer.tick(); clock += 75000; timer.toggle();
  assert.equal(timer.snapshot().remainingSeconds, 225);
  assert.equal(timer.setDuration(900), false);
  clock += 400000; timer.tick();
  assert.equal(timer.snapshot().remainingSeconds, 225);
  timer.toggle(); clock += 225000;
  assert.equal(timer.tick().phase, 'focus');
  assert.equal(timer.snapshot().remainingSeconds, 1500);
  timer.reset();
  assert.deepEqual([timer.snapshot().phase, timer.snapshot().active, timer.snapshot().endAt], ['focus', false, null]);
});
test('sleep/restart does not skip rest or replay a storm of missed completions', () => {
  let clock = 1000;
  const events = [];
  const timer = create({ now: () => clock });
  timer.toggle();
  const saved = timer.snapshot();
  clock += 86400000;
  const restored = create({ now: () => clock, saved, onTransition: (state) => events.push(state) });
  assert.equal(restored.tick().remainingSeconds, 300);
  assert.equal(restored.snapshot().phase, 'break');
  restored.tick();
  assert.equal(events.length, 1);
  const paused = restored.toggle();
  const restarted = create({ saved: paused, now: () => clock });
  assert.equal(restarted.snapshot().running, false);
  assert.equal(restarted.snapshot().remainingSeconds, 300);
});
test('invalid/zero duration and damaged saved data fall back safely', () => {
  const timer = create({ focusSeconds: 0, saved: {active: true, running: true, phase: 'break', endAt: null} });
  for (const value of [0, -1, NaN, Infinity, '300', 3661, 1.5]) assert.equal(timer.setDuration(value), false);
  assert.equal(timer.snapshot().focusSeconds, 1500);
  assert.equal(timer.setDuration(59), true);
  assert.equal(timer.snapshot().remainingSeconds, 59);
});
