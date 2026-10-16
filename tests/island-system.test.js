const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const {
  createSystemVolumeService,
  createSystemStatusService,
  normalizeSnapshot,
} = require('../island-system');

function statusSnapshot(overrides = {}) {
  return {
    volume: { ok: true, volume: 42, muted: false },
    brightness: { ok: true, brightness: 61, displayId: 1 },
    battery: { ok: true, percent: 78, charging: true, onAC: true },
    output: { ok: true, id: 'BuiltInSpeakerDevice', name: 'MacBook Air Speakers', kind: 'speaker' },
    ...overrides,
  };
}

function fakeHelper(onRequest = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      const lines = chunk.toString('utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) onRequest(JSON.parse(line), child);
      done();
    },
  });
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  child.sendLine = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.ready = (snapshot = statusSnapshot()) => child.sendLine({
    type: 'ready', protocolVersion: 1, snapshot,
  });
  return child;
}

test('system volume rejects invalid values and unsupported platforms without running commands', async () => {
  let calls = 0;
  const runFile = async () => { calls += 1; return { stdout: '50|false' }; };
  const service = createSystemVolumeService({ platform: 'darwin', runFile });
  for (const value of [-1, 101, 1.5, '50', NaN, Infinity, null, undefined]) {
    assert.deepEqual(await service.setSystemVolume(value), { ok: false, error: 'invalid_volume' });
  }
  const unsupported = createSystemVolumeService({ platform: 'linux', runFile });
  assert.deepEqual(await unsupported.getSystemVolume(), { ok: false, error: 'unsupported' });
  assert.deepEqual(await unsupported.setSystemVolume(50), { ok: false, error: 'unsupported' });
  assert.equal(calls, 0);
});

test('system volume passes validated boundaries as argv and returns actual output state', async () => {
  const calls = [];
  const service = createSystemVolumeService({ platform: 'darwin', runFile: async (...args) => {
    calls.push(args);
    return { stdout: calls.length === 1 ? '0|true\n' : '99|false\n' };
  } });
  assert.deepEqual(await service.setSystemVolume(0), { ok: true, volume: 0, muted: true });
  assert.deepEqual(await service.setSystemVolume(100), { ok: true, volume: 99, muted: false });
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.deepEqual(calls[0][1].slice(-2), ['--', '0']);
  assert.deepEqual(calls[1][1].slice(-2), ['--', '100']);
  assert.equal(calls[0][1][0], '-e');
  assert.equal(calls[0][1][1], calls[1][1][1], 'the command text stays constant for different values');
  assert.match(calls[0][1][1], /if requestedVolume > 0 then set volume without output muted/);
  assert.equal(calls[0][2].timeout, 3000);
});

test('reading output volume is read-only and preserves a muted state', async () => {
  const calls = [];
  const service = createSystemVolumeService({ platform: 'darwin', runFile: async (file, args) => {
    calls.push({ file, args });
    return { stdout: '42|true\n' };
  } });
  assert.deepEqual(await service.getSystemVolume(), { ok: true, volume: 42, muted: true });
  assert.equal(calls[0].args.at(-1), '--');
  assert.match(calls[0].args[1], /get volume settings/);
  assert.doesNotMatch(calls[0].args[1], /set volume|output muted\s+(true|false)|without output muted/);
});

test('output reads and writes stay ordered while a previous command is pending', async () => {
  const calls = [];
  let releaseFirst;
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const service = createSystemVolumeService({ platform: 'darwin', runFile: async (file, args) => {
    calls.push(args.at(-1));
    if (calls.length === 1) await blocked;
    return { stdout: '40|false' };
  } });
  const first = service.setSystemVolume(20);
  const second = service.setSystemVolume(40);
  const third = service.getSystemVolume();
  await Promise.resolve();
  assert.deepEqual(calls, ['20']);
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, ['20', '40', '--']);
});

test('output command failures and malformed results report errors without blocking later commands', async () => {
  let attempt = 0;
  const service = createSystemVolumeService({ platform: 'darwin', runFile: async () => {
    attempt += 1;
    if (attempt <= 2) throw new Error('device unavailable');
    return { stdout: attempt === 3 ? 'invalid|false' : '55|false' };
  } });
  assert.deepEqual(await service.getSystemVolume(), { ok: false, error: 'volume_unavailable' });
  assert.deepEqual(await service.setSystemVolume(50), { ok: false, error: 'volume_change_failed' });
  assert.deepEqual(await service.getSystemVolume(), { ok: false, error: 'volume_unavailable' });
  assert.deepEqual(await service.getSystemVolume(), { ok: true, volume: 55, muted: false });
});

test('system status normalizes supported values and keeps unavailable capabilities explicit', () => {
  assert.deepEqual(normalizeSnapshot(statusSnapshot()), statusSnapshot());
  assert.deepEqual(normalizeSnapshot({
    volume: { ok: true, volume: 101, muted: false },
    brightness: { ok: false, error: 'brightness_unavailable' },
    battery: null,
    output: { ok: true, id: '', name: 'Unknown', kind: 'speaker' },
  }), {
    volume: { ok: false, error: 'volume_unavailable' },
    brightness: { ok: false, error: 'brightness_unavailable' },
    battery: { ok: false, error: 'battery_unavailable' },
    output: { ok: false, error: 'output_unavailable' },
  });
  assert.equal(normalizeSnapshot(null), null);
});

test('initial helper snapshot is a silent baseline and later real changes are delivered', async () => {
  const changes = [];
  let child;
  const service = createSystemStatusService({
    platform: 'darwin',
    helperPath: '/mock/system-status-helper',
    accessFile: async () => {},
    spawnProcess: () => {
      child = fakeHelper((request, target) => {
        if (request.command === 'getSnapshot') {
          target.sendLine({ type: 'response', id: request.id, ok: true, snapshot: statusSnapshot() });
        }
        if (request.command === 'shutdown') queueMicrotask(() => target.emit('exit', 0, null));
      });
      queueMicrotask(() => child.ready());
      return child;
    },
    onChange: (snapshot, changedKeys) => changes.push({ snapshot, changedKeys }),
  });

  assert.deepEqual(await service.start(), { ok: true, snapshot: statusSnapshot() });
  assert.deepEqual(changes, [], 'the initial baseline must not display a HUD');
  assert.deepEqual(await service.getSnapshot(), statusSnapshot());

  const next = statusSnapshot({ brightness: { ok: true, brightness: 62, displayId: 1 } });
  child.sendLine({ type: 'change', changedKeys: ['volume'], snapshot: next });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [{ snapshot: next, changedKeys: ['brightness'] }], 'changed keys come from validated values, not helper claims');
  await service.stop();
});

test('system status writes validated values as JSON commands and returns confirmed state', async () => {
  const requests = [];
  const changes = [];
  let child;
  const service = createSystemStatusService({
    platform: 'darwin',
    helperPath: '/mock/system-status-helper',
    accessFile: async () => {},
    spawnProcess: () => {
      child = fakeHelper((request, target) => {
        requests.push(request);
        if (request.command === 'setVolume') {
          const snapshot = statusSnapshot({ volume: { ok: true, volume: 37, muted: false } });
          target.sendLine({ type: 'response', id: request.id, ok: true, snapshot });
        } else if (request.command === 'setBrightness') {
          const snapshot = statusSnapshot({
            volume: { ok: true, volume: 37, muted: false },
            brightness: { ok: true, brightness: 73, displayId: 1 },
          });
          target.sendLine({ type: 'response', id: request.id, ok: true, snapshot });
        } else if (request.command === 'shutdown') {
          queueMicrotask(() => target.emit('exit', 0, null));
        }
      });
      queueMicrotask(() => child.ready());
      return child;
    },
    onChange: (snapshot, changedKeys) => changes.push({ snapshot, changedKeys }),
  });

  assert.deepEqual(await service.setVolume(37), {
    ok: true,
    volume: 37,
    muted: false,
    snapshot: statusSnapshot({ volume: { ok: true, volume: 37, muted: false } }),
  });
  assert.deepEqual(await service.setBrightness(73), {
    ok: true,
    brightness: 73,
    displayId: 1,
    snapshot: statusSnapshot({
      volume: { ok: true, volume: 37, muted: false },
      brightness: { ok: true, brightness: 73, displayId: 1 },
    }),
  });
  assert.deepEqual(requests.slice(0, 2).map(({ command, value }) => ({ command, value })), [
    { command: 'setVolume', value: 37 },
    { command: 'setBrightness', value: 73 },
  ]);
  assert.deepEqual(changes.map((change) => change.changedKeys), [['volume'], ['brightness']],
    'confirmed command responses cannot consume a change before the helper event reaches the service');
  await service.stop();
});

test('system status rejects invalid writes and reports unsupported snapshots without a helper', async () => {
  let spawns = 0;
  const service = createSystemStatusService({ platform: 'darwin', spawnProcess: () => { spawns += 1; } });
  for (const value of [-1, 101, 1.5, '50', NaN, Infinity, null, undefined]) {
    assert.deepEqual(await service.setVolume(value), { ok: false, error: 'invalid_volume' });
    assert.deepEqual(await service.setBrightness(value), { ok: false, error: 'invalid_brightness' });
  }
  const unsupported = createSystemStatusService({ platform: 'linux', spawnProcess: () => { spawns += 1; } });
  assert.deepEqual(await unsupported.getSnapshot(), {
    volume: { ok: false, error: 'unsupported' },
    brightness: { ok: false, error: 'unsupported' },
    battery: { ok: false, error: 'unsupported' },
    output: { ok: false, error: 'unsupported' },
  });
  assert.deepEqual(await unsupported.setVolume(50), { ok: false, error: 'unsupported' });
  assert.deepEqual(await unsupported.setBrightness(50), { ok: false, error: 'unsupported' });
  assert.equal(spawns, 0);
});

test('an unexpected helper exit restarts with backoff and compares the resumed baseline', async () => {
  const children = [];
  const changes = [];
  const service = createSystemStatusService({
    platform: 'darwin',
    helperPath: '/mock/system-status-helper',
    accessFile: async () => {},
    restartBaseDelayMs: 2,
    restartMaximumDelayMs: 2,
    spawnProcess: () => {
      const index = children.length;
      const child = fakeHelper((request, target) => {
        if (request.command === 'shutdown') queueMicrotask(() => target.emit('exit', 0, null));
      });
      children.push(child);
      queueMicrotask(() => child.ready(statusSnapshot({
        volume: { ok: true, volume: index === 0 ? 42 : 43, muted: false },
      })));
      return child;
    },
    onChange: (snapshot, changedKeys) => changes.push({ snapshot, changedKeys }),
  });
  await service.start();
  children[0].emit('exit', 9, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(children.length, 2);
  assert.deepEqual(changes.map((change) => change.changedKeys), [['volume']]);
  assert.equal(changes[0].snapshot.volume.volume, 43);
  await service.stop();
});

test('a restarting helper never reports the previous process snapshot as ready', async () => {
  const children = [];
  const service = createSystemStatusService({
    platform: 'darwin',
    helperPath: '/mock/system-status-helper',
    accessFile: async () => {},
    restartBaseDelayMs: 1000,
    spawnProcess: () => {
      const child = fakeHelper((request, target) => {
        if (request.command === 'shutdown') queueMicrotask(() => target.emit('exit', 0, null));
      });
      children.push(child);
      if (children.length === 1) queueMicrotask(() => child.ready());
      return child;
    },
  });
  await service.start();
  children[0].emit('exit', 9, null);

  let settled = false;
  const restarted = service.start().then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.equal(settled, false, 'the old baseline must not satisfy a new process startup');
  const resumed = statusSnapshot({ volume: { ok: true, volume: 44, muted: false } });
  children[1].ready(resumed);
  assert.deepEqual(await restarted, { ok: true, snapshot: resumed });
  await service.stop();
});
