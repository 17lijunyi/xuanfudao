const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createSystemStatusService, normalizeSnapshot } = require('../island-system');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const legacySnapshot = () => ({
  volume: { ok: true, volume: 100, muted: false },
  brightness: { ok: true, brightness: 0, displayId: 1 },
  battery: { ok: true, percent: 78, charging: true, onAC: true },
  output: { ok: true, id: 'speaker', name: 'Test Speakers', kind: 'speaker' },
});
const state = (enabled, permission = 'granted', overrides = {}) => ({
  enabled, active: enabled && permission === 'granted', permission, error: null, ...overrides,
});
const snapshot = (hudReplacement = state(false), overrides = {}) => ({
  ...legacySnapshot(), hudReplacement, ...overrides,
});

async function waitFor(condition, message) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

// All subprocess traffic stays in memory; no real helper, key event, or permission UI is used.
function harness(t, { serviceOptions = {}, initialSnapshot = snapshot(), onRequest } = {}) {
  const children = [];
  const requests = [];
  const feedback = [];
  const statuses = [];
  const changes = [];
  const service = createSystemStatusService({
    platform: 'darwin',
    helperPath: '/mock/system-status-helper',
    accessFile: async () => {},
    startupTimeoutMs: 500,
    requestTimeoutMs: 500,
    restartBaseDelayMs: 5,
    restartMaximumDelayMs: 5,
    ...serviceOptions,
    onFeedback: (value, kind) => feedback.push({ snapshot: value, kind }),
    onHudReplacementStatus: (value) => statuses.push(value),
    onChange: (value, keys) => changes.push({ snapshot: value, keys }),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.index = children.length;
      child.snapshot = structuredClone(initialSnapshot);
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.killed = false;
      child.send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
      child.reply = (request, next = child.snapshot, ok = true) => {
        child.snapshot = structuredClone(next);
        child.send({ type: 'response', id: request.id, ok, snapshot: next });
      };
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          for (const line of chunk.toString('utf8').trim().split('\n').filter(Boolean)) {
            const request = JSON.parse(line);
            requests.push({ child: child.index, ...request });
            if (request.command === 'shutdown') {
              queueMicrotask(() => child.emit('exit', 0, null));
            } else if (onRequest?.(request, child) !== false) {
              if (request.command === 'setHudReplacement' && child.snapshot.hudReplacement) {
                child.snapshot.hudReplacement = state(request.value, child.snapshot.hudReplacement.permission);
              }
              child.reply(request);
            }
          }
          done();
        },
      });
      child.kill = () => {
        if (child.killed) return false;
        child.killed = true;
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
        return true;
      };
      children.push(child);
      queueMicrotask(() => child.send({ type: 'ready', protocolVersion: 1, snapshot: child.snapshot }));
      return child;
    },
  });
  t.after(() => service.stop());
  return {
    service, children, requests, feedback, statuses, changes,
    commands: (index) => requests.filter((request) => request.command === 'setHudReplacement'
      && (index === undefined || request.child === index)),
  };
}

test('HUD capability normalization preserves legacy snapshots and never invents active permission', () => {
  assert.deepEqual(normalizeSnapshot(legacySnapshot()), legacySnapshot());
  assert.equal(Object.hasOwn(normalizeSnapshot(legacySnapshot()), 'hudReplacement'), false);
  for (const confirmed of [state(true), state(false), state(true, 'required'), state(true, 'unknown', { error: 'event_tap_unavailable' })]) {
    assert.deepEqual(normalizeSnapshot(snapshot(confirmed)).hudReplacement, confirmed);
  }
  for (const invalid of [
    null, [], 'active',
    state(true, 'required', { active: true }),
    state(true, 'unknown', { active: true }),
    state(false, 'granted', { active: true }),
    state(true, 'granted', { enabled: 'true' }),
    state(true, 'granted', { active: 'true' }),
    state(true, 'invalid', { active: true }),
  ]) {
    assert.notEqual(normalizeSnapshot(snapshot(invalid)).hudReplacement?.active, true,
      `invalid capability cannot claim interception is active: ${JSON.stringify(invalid)}`);
  }
});

test('omitting the replacement option keeps legacy helper startup read-only', async (t) => {
  const h = harness(t, { initialSnapshot: legacySnapshot() });
  assert.deepEqual(await h.service.start(), { ok: true, snapshot: legacySnapshot() });
  assert.deepEqual(await h.service.getSnapshot(), legacySnapshot());
  await tick();
  assert.deepEqual(h.commands(), [], 'existing callers must not acquire a new setting command');
  assert.deepEqual(h.feedback, []);
});

test('HUD replacement rejects nonboolean values and unsupported platforms without launching a helper', async () => {
  let spawns = 0;
  const options = { spawnProcess: () => { spawns++; throw new Error('must not spawn'); } };
  const service = createSystemStatusService({ ...options, platform: 'darwin' });
  for (const value of [undefined, null, 0, 1, 'true', 'false', NaN, {}, []]) {
    const result = await service.setHudReplacement(value);
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
  }
  const unsupported = createSystemStatusService({ ...options, platform: 'linux' });
  assert.deepEqual(await unsupported.setHudReplacement(true), { ok: false, error: 'unsupported' });
  assert.equal(spawns, 0);
  await service.stop();
  await unsupported.stop();
});

test('a successful setting acknowledgement reports required AX permission as inactive', async (t) => {
  const h = harness(t, { initialSnapshot: snapshot(state(false, 'required')) });
  const result = await h.service.setHudReplacement(true);
  assert.equal(result.ok, true, 'the setting may be saved before accessibility permission is granted');
  assert.deepEqual(result.hudReplacement, state(true, 'required'));
  assert.deepEqual(result.snapshot.hudReplacement, state(true, 'required'));
  assert.ok(h.statuses.some((value) => value.enabled && value.permission === 'required' && value.active === false));
  assert.equal(h.statuses.some((value) => value.active), false, 'an acknowledgement is not proof that native HUD interception is active');
  for (const command of h.commands()) {
    assert.equal(typeof command.id, 'string');
    assert.deepEqual(Object.keys(command).sort(), ['child', 'command', 'id', 'value']);
    assert.equal(command.value, true);
  }
});

for (const withSnapshot of [true, false]) {
  test(`a legacy helper acknowledgement ${withSnapshot ? 'with a legacy snapshot' : 'without any snapshot'} cannot report replacement success`, async (t) => {
    const h = harness(t, {
      initialSnapshot: legacySnapshot(),
      onRequest(request, child) {
        if (!withSnapshot && request.command === 'setHudReplacement') {
          child.send({ type: 'response', id: request.id, ok: true });
          return false;
        }
      },
    });
    const result = await h.service.setHudReplacement(true);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'hud_replacement_unavailable');
    assert.notEqual(result.hudReplacement?.active, true);
    assert.equal(h.statuses.some((value) => value.active), false);
  });
}

test('confirmed interception emits feedback for repeated boundary presses even without changed values', async (t) => {
  const h = harness(t);
  const enabled = await h.service.setHudReplacement(true);
  assert.equal(enabled.hudReplacement.active, true);
  const current = snapshot(state(true));
  for (const kind of ['volume', 'volume', 'brightness', 'brightness']) {
    h.children[0].send({ type: 'feedback', kind, snapshot: current });
  }
  await tick();
  assert.deepEqual(h.feedback, ['volume', 'volume', 'brightness', 'brightness'].map((kind) => ({ snapshot: current, kind })));
  assert.equal(h.changes.some((change) => change.keys.includes('volume') || change.keys.includes('brightness')), false,
    'feedback must not depend on volume or brightness changing at a boundary');
});

test('ungranted, undeclared, malformed and non-HUD feedback never reaches the UI', async (t) => {
  const h = harness(t);
  await h.service.setHudReplacement(true);
  const rejected = [
    { kind: 'output', snapshot: snapshot(state(true)) },
    { kind: 'battery', snapshot: snapshot(state(true)) },
    { kind: 'volume', snapshot: legacySnapshot() },
    { kind: 'volume', snapshot: null },
    { kind: 'volume', snapshot: snapshot(state(false)) },
    { kind: 'volume', snapshot: snapshot(state(true, 'required', { active: true })) },
    { kind: 'brightness', snapshot: snapshot(state(true, 'unknown', { active: true })) },
    { kind: 'volume', snapshot: snapshot(state(true, 'granted', { active: 'true' })) },
    { kind: 'volume', snapshot: snapshot(state(true), { volume: { ok: true, volume: 101, muted: false } }) },
    { kind: 'volume', snapshot: snapshot(state(true), { volume: { ok: true, volume: 50, muted: 'false' } }) },
    { kind: 'brightness', snapshot: snapshot(state(true), { brightness: { ok: true, brightness: -1, displayId: 1 } }) },
    { kind: 'brightness', snapshot: snapshot(state(true), { brightness: { ok: true, brightness: 50, displayId: null } }) },
  ];
  for (const message of rejected) h.children[0].send({ type: 'feedback', ...message });
  await tick();
  assert.deepEqual(h.feedback, []);
  h.children[0].send({ type: 'feedback', kind: 'volume', snapshot: snapshot(state(true)) });
  await tick();
  assert.equal(h.feedback.length, 1, 'invalid events must not prevent a later valid feedback event');
  await h.service.setHudReplacement(false);
  h.children[0].send({ type: 'feedback', kind: 'volume', snapshot: snapshot(state(true)) });
  await tick();
  assert.equal(h.feedback.length, 1, 'a delayed active event must not bypass the user disabling replacement');
});

test('enabled preference is resent after helper restart; disabling persists across the next restart', async (t) => {
  const h = harness(t, { serviceOptions: { hudReplacementEnabled: true } });
  await h.service.start();
  await waitFor(() => h.commands(0).length > 0 && h.statuses.at(-1)?.active, 'startup should apply the enabled preference');
  assert.ok(h.commands(0).every((command) => command.value === true));
  h.children[0].emit('exit', 9, null);
  assert.equal(h.statuses.at(-1)?.active, false, 'a crashed helper must immediately revoke the active status');
  await waitFor(() => h.children.length === 2 && h.commands(1).length > 0 && h.statuses.at(-1)?.active,
    'a replacement helper should reapply the enabled preference');
  assert.ok(h.commands(1).every((command) => command.value === true));
  const disabled = await h.service.setHudReplacement(false);
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.hudReplacement, state(false));
  h.children[1].emit('exit', 9, null);
  await waitFor(() => h.children.length === 3 && h.commands(2).length > 0,
    'a disabled preference should also be synchronized to the new helper');
  await tick();
  assert.ok(h.commands(2).every((command) => command.value === false), 'an old enabled preference must never return after restart');
  assert.equal(h.statuses.at(-1)?.active, false);
});

test('explicitly disabled startup sends only a false setting', async (t) => {
  const h = harness(t, { serviceOptions: { hudReplacementEnabled: false } });
  await h.service.start();
  await waitFor(() => h.commands(0).length > 0, 'an explicit disabled preference must reach the helper');
  assert.ok(h.commands().every((command) => command.value === false));
  assert.equal(h.statuses.some((value) => value.active), false);
});

test('a pending enable command cannot complete after and overwrite a newer disable', async (t) => {
  let held;
  const h = harness(t, {
    onRequest(request, child) {
      if (request.command === 'setHudReplacement' && request.value === true) {
        held = { request, child };
        return false;
      }
    },
  });
  const enabling = h.service.setHudReplacement(true);
  await waitFor(() => held, 'the first setting command should reach the helper');
  const disabling = h.service.setHudReplacement(false);
  await tick();
  assert.equal(h.commands().some((command) => command.value === false), false,
    'setting commands must stay ordered until the first reply is confirmed');
  held.child.reply(held.request, snapshot(state(true)));
  await Promise.all([enabling, disabling]);
  assert.equal(h.commands().at(-1).value, false);
  assert.equal(h.statuses.at(-1)?.enabled, false);
  assert.equal(h.statuses.at(-1)?.active, false);
  const confirmed = await h.service.getSnapshot();
  assert.deepEqual(confirmed.hudReplacement, state(false));
});

test('stopping with a pending enable prevents queued preference work from restarting the helper', async (t) => {
  let held;
  const h = harness(t, {
    onRequest(request, child) {
      if (request.command === 'setHudReplacement') {
        held = { request, child };
        return false;
      }
    },
  });
  const enabling = h.service.setHudReplacement(true);
  await waitFor(() => held, 'the setting must still be awaiting its helper acknowledgement');
  const commandCount = h.commands().length;
  await h.service.stop();
  const enabled = await enabling;
  assert.equal(enabled.ok, false, 'stopping must reject an unconfirmed setting');
  held.child.reply(held.request, snapshot(state(true)));
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(h.children.length, 1, 'stale startup synchronization must not spawn another helper after stop');
  assert.equal(h.commands().length, commandCount, 'queued setting work must be cancelled by stop');
  assert.equal(h.statuses.at(-1)?.active, false, 'a late helper reply must not restore active status after stop');
});
