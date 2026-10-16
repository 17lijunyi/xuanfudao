'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createReadonlyAppServerClient, createCodexFloatService, normalizeQuota,
  normalizeThreads, createTaskStateReader, mergeTaskStates, locateCodexExecutable } = require('../codex-float');

const ID = '0198aaaa-0000-7000-8000-111111111111';
const ID2 = '0198aaaa-0000-7000-8000-222222222222';
const THREADS = { data: [{ id: ID, name: 'Fixture task', source: 'appServer', preview: 'PRIVATE MESSAGE', status: { type: 'notLoaded' }, updatedAt: 100 }] };
const QUOTA = { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 200 } }, rateLimitResetCredits: { availableCount: 2 } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixtureServer(handle) {
  const frames = [];
  const spawned = [];
  const spawnProcess = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    child.kill = signal => {
      child.kills.push(signal);
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    };
    child.respond = (id, result) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const frame = JSON.parse(chunk.toString());
      frames.push(frame);
      queueMicrotask(() => {
        if (frame.method === 'initialize') child.respond(frame.id, {});
        else handle?.(frame, child);
      });
      done();
    } });
    spawned.push({ child, executable, args, options });
    return child;
  };
  return { frames, spawned, options: { spawnProcess, locate: () => ({ executable: '/fixture/codex' }), home: '/fixture/home', timeoutMs: 100 } };
}

test('quota preserves unknowns, uses multi-bucket data and exports no account or reset IDs', () => {
  const quota = normalizeQuota({ accountId: 'private', rateLimits: QUOTA.rateLimits,
    rateLimitsByLimitId: { codex: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 200 },
      secondary: { usedPercent: null, windowDurationMins: 10080 }, credits: { balance: '3.1', hasCredits: true, unlimited: false } },
    spark: { primary: { usedPercent: 140 } } },
    rateLimitResetCredits: { availableCount: 2, credits: [
      { id: 'secret', status: 'available', title: 'Extra', description: 'Read only', expiresAt: 300 },
      { id: 'used', status: 'redeemed', title: 'Used' },
    ] } });
  assert.equal(quota.windows.length, 3);
  assert.deepEqual(quota.windows.map(window => window.remainingPercent), [75, null, 0]);
  assert.equal(quota.windows[0].resetsAt, 200000);
  assert.equal(quota.windows[1].label, '每周');
  assert.deepEqual(quota.resets, { available: 2, items: [{ title: 'Extra', description: 'Read only', expiresAt: 300000 }] });
  assert.equal(JSON.stringify(quota).includes('secret'), false);
  assert.equal(JSON.stringify(quota).includes('private'), false);
  assert.deepEqual(normalizeQuota(QUOTA).credits, { balance: null, hasCredits: null, unlimited: null });
  assert.equal(normalizeQuota({ rateLimits: { primary: { usedPercent: null } } }).resets.available, null);
  assert.throws(() => normalizeQuota({}), /invalid_response/);
  assert.throws(() => normalizeQuota({ rateLimits: {} }), /invalid_response/);
  assert.throws(() => normalizeQuota({ rateLimits: { primary: { usedPercent: '20' } } }), /invalid_response/);
  assert.throws(() => normalizeQuota({ rateLimitsByLimitId: { codex: [] } }), /invalid_response/);
});

test('thread projection ignores preview/body, filters invalid IDs and keeps a bounded multi-task set', () => {
  const rows = [...THREADS.data, { id: ID, name: 'Duplicate' }, { id: 'bad\';DROP TABLE thread_turns', name: 'Bad' },
    { id: ID2, preview: 'SECRET FIRST MESSAGE', status: { type: 'active' }, recencyAt: 102 }];
  const result = normalizeThreads({ data: rows });
  assert.deepEqual(result, [{ id: ID, title: 'Fixture task', projectKey: null, status: 'unknown', statusSource: null,
    attentionKind: null, statusReason: null, notificationEligible: true, updatedAt: 100000 },
  { id: ID2, title: '未命名任务', projectKey: null, status: 'running', statusSource: 'app-server',
    attentionKind: null, statusReason: null, notificationEligible: false, updatedAt: 102000 }]);
  assert.equal(JSON.stringify(result).includes('MESSAGE'), false);
  assert.equal(normalizeThreads({ data: Array.from({ length: 40 }, (_, n) => ({ id: `0198aaaa-0000-7000-8000-${String(n).padStart(12, '0')}` })) }).length, 32);
});

test('live thread active flags distinguish approval and user-input attention without guessing unknown flags', () => {
  const row = { ...THREADS.data[0], status: { type: 'active', activeFlags: ['waitingOnApproval'] } };
  assert.deepEqual(normalizeThreads({ data: [row] })[0], {
    id: ID, title: 'Fixture task', projectKey: null, status: 'attention', statusSource: 'app-server',
    attentionKind: 'permission', statusReason: 'awaiting_permission', notificationEligible: true, updatedAt: 100000,
  });
  const input = normalizeThreads({ data: [{ ...row, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } }] })[0];
  assert.equal(input.status, 'attention');
  assert.equal(input.attentionKind, 'input');
  assert.equal(input.statusReason, 'awaiting_user_input');
  const unknown = normalizeThreads({ data: [{ ...row, status: { type: 'active', activeFlags: ['futureFlag'] } }] })[0];
  assert.equal(unknown.status, 'running');
  assert.equal(unknown.attentionKind, null);
  assert.equal(unknown.statusReason, null);
});

test('CLI locator tests executable files in fixed app locations before PATH without executing a shell', () => {
  const visited = [];
  const result = locateCodexExecutable({ home: '/fixture', env: { PATH: '.:/untrusted-bin' },
    access(file) { visited.push(file); if (!file.startsWith('/Applications/Codex.app/')) throw Error(); }, stat: () => ({ isFile: () => true }) });
  assert.equal(result.appPath, '/Applications/Codex.app');
  assert.equal(visited.length, 2);
});

test('RPC initializes once, uses safe cwd, bounds concurrency and rejects every mutating method', async () => {
  const fixture = fixtureServer((frame, child) => { if (frame.id) child.respond(frame.id, frame.method === 'thread/list' ? THREADS : QUOTA); });
  const client = createReadonlyAppServerClient(fixture.options);
  try {
    await Promise.all([client.request('account/rateLimits/read'), client.request('thread/list', { useStateDbOnly: true })]);
    assert.equal(fixture.spawned.length, 1);
    assert.deepEqual(fixture.frames.map(frame => frame.method), ['initialize', 'initialized', 'account/rateLimits/read', 'thread/list']);
    assert.deepEqual(fixture.spawned[0].args, ['app-server', '--listen', 'stdio://']);
    assert.equal(fixture.spawned[0].options.cwd, '/fixture/home');
    await assert.rejects(client.request('account/rateLimits/reset'), /request_failed/);
    await assert.rejects(client.request('thread/read'), /request_failed/);
    assert.equal(fixture.frames.length, 4);
  } finally { client.stop(); }
});

test('RPC fragmented UTF-8 and sparse quota notifications are handled without leaking RPC errors', async () => {
  let notifications = 0;
  const fixture = fixtureServer((frame, child) => {
    if (!frame.id) return;
    const bytes = Buffer.from(JSON.stringify({ id: frame.id, result: { name: '浮岛' } }) + '\n');
    for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    child.stdout.write(JSON.stringify({ method: 'account/rateLimits/updated', params: { accountId: 'private' } }) + '\n');
  });
  const client = createReadonlyAppServerClient({ ...fixture.options, onQuotaUpdate: () => notifications++ });
  try {
    assert.deepEqual(await client.request('account/rateLimits/read'), { name: '浮岛' });
    assert.equal(notifications, 1);
    const request = client.request('thread/list');
    await request;
    const child = fixture.spawned[0].child;
    child.stdout.write(JSON.stringify({ method: 'item/tool/requestUserInput', id: 99 }) + '\n');
    assert.deepEqual(child.kills, ['SIGTERM']);
  } finally { client.stop(); }
});

test('RPC timeout, oversized output and process exit settle pending reads and stop child', async () => {
  for (const mode of ['timeout', 'oversize', 'exit', 'invalid']) {
    const fixture = fixtureServer((frame, child) => {
      if (!frame.id) return;
      if (mode === 'oversize') child.stdout.write('x'.repeat(200));
      if (mode === 'exit') child.emit('exit', 1);
      if (mode === 'invalid') child.stdout.write('not-json\n');
    });
    const client = createReadonlyAppServerClient({ ...fixture.options, timeoutMs: 15, maxLineBytes: 128 });
    try {
      await assert.rejects(client.request('account/rateLimits/read'), mode === 'timeout' ? /request_timeout/ : mode === 'exit' ? /connection_failed/ : /invalid_response/);
      assert.equal(fixture.spawned[0].child.kills[0], 'SIGTERM');
    } finally { client.stop(); }
  }
});

test('RPC enforces pending limit and stop cancels requests without reconnecting', async () => {
  const fixture = fixtureServer();
  const client = createReadonlyAppServerClient({ ...fixture.options, maxPending: 1 });
  const first = client.request('account/rateLimits/read');
  const firstRejected = assert.rejects(first, /stopped/);
  await tick();
  await assert.rejects(client.request('thread/list'), /request_failed/);
  client.stop();
  await firstRejected;
  await tick();
  assert.equal(fixture.spawned.length, 1);
});

test('a late error from a stopped process cannot disconnect the replacement process', async () => {
  const fixture = fixtureServer((frame, child) => { if (frame.id) child.respond(frame.id, QUOTA); });
  const client = createReadonlyAppServerClient(fixture.options);
  try {
    await client.request('account/rateLimits/read');
    const old = fixture.spawned[0].child;
    client.stop();
    await client.request('account/rateLimits/read');
    old.stdin.emit('error', Error('old stream'));
    old.emit('error', Error('old process'));
    assert.deepEqual(fixture.spawned[1].child.kills, []);
    await client.request('account/rateLimits/read');
    assert.equal(fixture.spawned.length, 2);
  } finally { client.stop(); }
});

test('SQLite reader uses only read-only state fields, newest schema and bounded validated UUIDs', async () => {
  const calls = [];
  const reader = createTaskStateReader({ codexHome: '/fixture/.codex',
    readDirectory: async () => ['auth.json', 'thread_history_1.sqlite', 'thread_history_12.sqlite', 'thread_history_99.sqlite-journal'],
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify([{ thread_id: ID, turn_id: 'turn-1', status: 'completed', started_at: 12, completed_at: 14 }]) };
    } });
  assert.deepEqual(await reader([ID, "bad');DROP TABLE thread_turns;--"]), [{ id: ID, turnId: 'turn-1', status: 'completed', startedAt: 12000, completedAt: 14000 }]);
  assert.equal(calls[0].command, '/usr/bin/sqlite3');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-readonly', '-json', '/fixture/.codex/thread_history_12.sqlite']);
  assert.doesNotMatch(calls[0].args[3], /DROP|error_json|thread_items|SELECT \*/);
  assert.equal(calls[0].options.maxBuffer, 65536);
  assert.equal(calls[0].options.timeout, 2000);
});

test('runtime state is authoritative and missing or implausibly old running state stays unknown', () => {
  const threads = normalizeThreads(THREADS);
  assert.equal(mergeTaskStates(threads, [{ id: ID, status: 'inProgress', startedAt: 99000 }], 100000)[0].status, 'running');
  assert.equal(mergeTaskStates(threads, [{ id: ID, status: 'completed', completedAt: 102000 }], 103000)[0].status, 'completed');
  assert.equal(mergeTaskStates(threads, [{ id: ID, status: 'inProgress', startedAt: 0 }], 100000000)[0].status, 'unknown');
  assert.equal(mergeTaskStates(threads, null, 100000)[0].status, 'unknown');
});

test('metadata uses its newest timestamp and stale terminal history never implies a current idle or completed task', () => {
  const metadata = normalizeThreads({ data: [{ ...THREADS.data[0], updatedAt: 1788464075, recencyAt: 1788462978 }] });
  assert.equal(metadata[0].updatedAt, 1788464075000);
  for (const status of ['interrupted', 'completed', 'failed']) {
    const result = mergeTaskStates(metadata, [{ id: ID, status, startedAt: 1788449532000, completedAt: 1788449535000 }], 1788465000000)[0];
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusReason, 'history_older_than_task');
    assert.equal(result.statusRecordedAt, 1788449535000);
    assert.equal(result.updatedAt, 1788464075000);
  }
  const fresh = mergeTaskStates(metadata, [{ id: ID, status: 'completed', startedAt: 1788464000000, completedAt: 1788464070000 }], 1788465000000)[0];
  assert.equal(fresh.status, 'completed', 'small indexing delays preserve confirmed terminal state');
  assert.equal(fresh.updatedAt, 1788464075000, 'history never moves the latest activity timestamp backwards');
});

test('live RPC state takes priority over delayed or missing history', () => {
  for (const [type, expected] of [['active', 'running'], ['systemError', 'failed']]) {
    const metadata = normalizeThreads({ data: [{ ...THREADS.data[0], status: { type }, updatedAt: 200 }] });
    for (const states of [null, [], [{ id: ID, status: 'interrupted', startedAt: 1000, completedAt: 2000 }]]) {
      const result = mergeTaskStates(metadata, states, 201000)[0];
      assert.equal(result.status, expected);
      assert.equal(result.statusSource, 'app-server');
      assert.equal(result.updatedAt, 200000);
    }
  }
});

test('idle alone is not completion; interrupted retains its actual state; nonlocal and child tasks cannot notify', () => {
  const idle = normalizeThreads({ data: [{ ...THREADS.data[0], status: { type: 'idle' } }] });
  assert.equal(mergeTaskStates(idle, [], 101000)[0].status, 'unknown');
  assert.equal(mergeTaskStates(idle, [{ id: ID, status: 'interrupted', startedAt: 95000, completedAt: 100000 }], 101000)[0].status, 'interrupted');
  for (const extra of [{ source: { subAgent: 'review' } }, { parentThreadId: ID2 }, { source: 'unknown' }, { threadSource: 'cloud' }, { threadSource: 'remote' }]) {
    assert.equal(normalizeThreads({ data: [{ ...THREADS.data[0], ...extra }] })[0].notificationEligible, false);
  }
});

test('service coalesces refreshes, projects safe values, whitelists thread links and preserves stale quota', async () => {
  const calls = [];
  let offline = false;
  let stamp = 200000;
  let stops = 0;
  const service = createCodexFloatService({ now: () => stamp, tickMs: 10000,
    clientFactory: () => ({ async request(method, params) {
      calls.push({ method, params });
      await tick();
      if (offline) throw Error('PRIVATE NETWORK RESPONSE');
      return method === 'thread/list' ? THREADS : QUOTA;
    }, stop() { stops++; } }),
    readTaskStates: async () => [{ id: ID, status: 'completed', completedAt: 120000 }],
  });
  try {
    const [first, second] = await Promise.all([service.start(), service.refresh()]);
    assert.equal(calls.length, 2);
    assert.equal(first.connection, 'connected');
    assert.equal(second.threads[0].status, 'completed');
    const diagnostics = service.getDiagnostics();
    assert.deepEqual(diagnostics, { connection: 'connected', error: null,
      taskCounts: { running: 0, attention: 0, completed: 1, interrupted: 0, failed: 0, idle: 0, unknown: 0 },
      taskSources: { hook: 0, history: 1, 'app-server': 0, unknown: 0 } });
    diagnostics.taskCounts.completed = 99;
    assert.equal(service.getDiagnostics().taskCounts.completed, 1);
    assert.equal(JSON.stringify(diagnostics).includes('Fixture task'), false);
    assert.equal(JSON.stringify(diagnostics).includes(ID), false);
    assert.equal(calls[1].params.useStateDbOnly, true);
    assert.equal(service.hasThread(ID), true);
    assert.equal(service.hasThread(ID2), false);
    assert.equal(service.hasThread('../settings'), false);
    first.windows[0].remainingPercent = 99;
    assert.equal(service.getSnapshot().windows[0].remainingPercent, 80);
    stamp += 5000;
    offline = true;
    const stale = await service.refresh();
    assert.equal(stale.connection, 'stale');
    assert.equal(stale.updatedAt, 200000);
    assert.equal(stale.windows[0].remainingPercent, 80);
    assert.equal(stale.threads[0].status, 'unknown');
    assert.equal(stale.error, 'connection_failed');
    assert.equal(service.getDiagnostics().taskCounts.unknown, 1);
    assert.equal(service.getDiagnostics().taskCounts.completed, 0);
    assert.equal(JSON.stringify(stale).includes('PRIVATE'), false);
    assert.equal(stops, 1);
  } finally { service.stop(); }
});

test('stopping during refresh prevents late publication, timers and respawn', async () => {
  let release;
  let updates = 0;
  let requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const service = createCodexFloatService({ tickMs: 5, onUpdate: () => updates++,
    clientFactory: () => ({ async request(method) { requests++; await gate; return method === 'thread/list' ? THREADS : QUOTA; }, stop() {} }),
    readTaskStates: async () => [],
  });
  const pending = service.start();
  service.stop();
  release();
  await pending;
  await sleep(20);
  assert.equal(updates, 0);
  assert.equal(requests, 2);
  assert.equal(service.getSnapshot().updatedAt, null);
});

test('disconnect marks cached tasks unknown and recovery clears transient task errors', async () => {
  let callbacks;
  let failTasks = false;
  let stamp = 100000;
  const service = createCodexFloatService({ now: () => stamp, tickMs: 10000,
    clientFactory: options => {
      callbacks = options;
      return { async request(method) {
        if (method === 'thread/list' && failTasks) throw Error('temporary');
        return method === 'thread/list' ? THREADS : QUOTA;
      }, stop() {} };
    }, readTaskStates: async () => [{ id: ID, status: 'inProgress', startedAt: 99000 }],
  });
  try {
    await service.start();
    assert.equal(service.getSnapshot().threads[0].status, 'running');
    callbacks.onDisconnect('connection_failed');
    assert.equal(service.getSnapshot().connection, 'stale');
    assert.equal(service.getSnapshot().threads[0].status, 'unknown');
    failTasks = true;
    stamp += 1000;
    await service.refresh();
    assert.equal(service.getSnapshot().error, 'tasks_unavailable');
    failTasks = false;
    await service.refresh();
    assert.equal(service.getSnapshot().error, null);
  } finally { service.stop(); }
});

test('old scheduled task refresh cannot overwrite a newer manual refresh', async () => {
  let stamp = 100000;
  let calls = 0;
  let releaseOld;
  const oldRead = new Promise(resolve => { releaseOld = resolve; });
  const service = createCodexFloatService({ now: () => stamp, tickMs: 5, quotaIntervalMs: 100000,
    clientFactory: () => ({ async request(method) {
      if (method !== 'thread/list') return QUOTA;
      calls++;
      if (calls === 2) return oldRead;
      return calls === 3 ? { data: [{ ...THREADS.data[0], id: ID2, name: 'New task' }] } : THREADS;
    }, stop() {} }), readTaskStates: async () => [],
  });
  try {
    await service.start();
    stamp += 16000;
    await sleep(12);
    assert.equal(calls, 2);
    await service.refresh();
    assert.equal(service.getSnapshot().threads[0].id, ID2);
    releaseOld(THREADS);
    await tick();
    assert.equal(service.getSnapshot().threads[0].id, ID2);
  } finally { releaseOld(THREADS); service.stop(); }
});

test('source liveness checks preserve quiet tasks on uncertainty and clear only a confirmed exited owner', async () => {
  let stamp = 100000;
  let alive = null;
  let checks = 0;
  const events = [];
  const owner = { ownerPid: 1234, ownerStartedAt: 'Fri Sep 4 13:34:50 2026' };
  const activity = (kind, turnId = 'owner-turn') => ({ version: 1, kind, threadId: ID, turnId, at: stamp,
    source: 'local', parentThreadId: null, agentId: null, ...owner });
  const service = createCodexFloatService({ now: () => stamp, tickMs: 5, ownerIntervalMs: 10000,
    onTaskComplete: item => events.push(item), readTaskStates: async () => [],
    clientFactory: () => ({ async request(method) { return method === 'thread/list' ? THREADS : QUOTA; }, stop() {} }),
    readOwnerStates: async (identities, { signal }) => {
      assert.equal(signal.aborted, false);
      assert.deepEqual(identities, [{ pid: owner.ownerPid, startedAt: owner.ownerStartedAt }]);
      checks++;
      return identities.map(identity => ({ ...identity, alive }));
    },
  });
  const waitForCheck = async count => {
    for (let attempt = 0; attempt < 100 && checks < count; attempt++) await sleep(5);
    assert.ok(checks >= count);
    await tick();
  };
  try {
    await service.start();
    service.ingestTaskEvent(activity('running'));
    await waitForCheck(1);
    assert.equal(service.getSnapshot().runningTasks.length, 1, 'an inconclusive process read preserves existing activity');
    stamp += 26 * 3600000;
    alive = true;
    await waitForCheck(2);
    assert.equal(service.getSnapshot().runningTasks.length, 1, 'source remains alive without new chat/tool events');
    stamp += 10001;
    alive = false;
    await waitForCheck(3);
    assert.equal(service.getSnapshot().runningTasks.length, 0);
    assert.equal(service.getSnapshot().threads[0].statusReason, 'source_process_exited');
    service.ingestTaskEvent(activity('completed'));
    assert.equal(events.length, 0, 'an exited source cannot later complete a disarmed turn');
    assert.equal(service.getSnapshot().threads[0].status, 'completed', 'a terminal event is still displayed without replaying a notification');
  } finally { service.stop(); }
});

test('stop aborts owner reads and a late result cannot clear the next service generation', async () => {
  let release;
  let firstSignal;
  let reads = 0;
  let stamp = 100000;
  const owner = { ownerPid: 1234, ownerStartedAt: 'Fri Sep 4 13:34:50 2026' };
  const activity = turnId => ({ version: 1, kind: 'running', threadId: ID, turnId, at: stamp,
    source: 'local', parentThreadId: null, agentId: null, ...owner });
  const service = createCodexFloatService({ now: () => stamp, tickMs: 5, ownerIntervalMs: 10000, readTaskStates: async () => [],
    clientFactory: () => ({ async request(method) { return method === 'thread/list' ? THREADS : QUOTA; }, stop() {} }),
    readOwnerStates: (identities, { signal }) => {
      reads++;
      if (reads === 1) {
        firstSignal = signal;
        return new Promise(resolve => { release = () => resolve(identities.map(identity => ({ ...identity, alive: false }))); });
      }
      return Promise.resolve(identities.map(identity => ({ ...identity, alive: true })));
    },
  });
  try {
    await service.start();
    service.ingestTaskEvent(activity('old-turn'));
    for (let attempt = 0; attempt < 100 && !release; attempt++) await sleep(5);
    assert.equal(typeof release, 'function');
    service.stop();
    assert.equal(firstSignal.aborted, true);
    stamp += 1000;
    await service.start();
    service.ingestTaskEvent(activity('new-turn'));
    release();
    await sleep(20);
    assert.equal(service.getSnapshot().runningTasks[0].turnId, 'new-turn');
  } finally { release?.(); service.stop(); }
});
