'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateTaskEvent, createTaskLifecycleState } = require('../codex-task-state');
const { createCodexFloatService } = require('../codex-float');
const { projectHookEvent, readToken, sendEvent, forwardOriginalNotify } = require('../scripts/fudao-codex-hook');
const ID = '0198aaaa-0000-7000-8000-111111111111';
const OTHER = '0198aaaa-0000-7000-8000-222222222222';
const event = (kind, at = 100000, turnId = 'turn-1') => ({ version: 1, kind, threadId: ID, turnId, at, source: 'local', parentThreadId: null, agentId: null });

test('HTTP event schema rejects extra content, missing turn identities, nonlocal and stale data', () => {
  assert.deepEqual(validateTaskEvent(event('running'), 100000), event('running'));
  for (const extra of [{ title: 'secret' }, { fullbody: 'secret' }, { turnId: null }, { at: 1 }, { at: 106000 },
    { threadId: '../bad' }, { source: 'cloud' }, { agentId: 'child' }, { parentThreadId: OTHER }]) {
    assert.equal(validateTaskEvent({ ...event('running'), ...extra }, 100000), null);
  }
  const attention = { ...event('attention'), attentionKind: 'permission' };
  assert.deepEqual(validateTaskEvent(attention, 100000), attention);
  assert.equal(validateTaskEvent(event('attention'), 100000), null);
  assert.equal(validateTaskEvent({ ...event('attention'), attentionKind: 'unknown' }, 100000), null);
  assert.equal(validateTaskEvent({ ...event('running'), attentionKind: 'input' }, 100000), null);
});

test('hook projections discard text, require turn id, distinguish Stop from actual completion and exclude child tools', () => {
  const input = { hook_event_name: 'UserPromptSubmit', session_id: ID, turn_id: 'turn-1', prompt: 'SECRET PROMPT' };
  assert.deepEqual(projectHookEvent(input, { now: 100000, env: {} }), event('running'));
  assert.deepEqual(projectHookEvent({ ...input, hook_event_name: 'Stop', stop_hook_active: true, last_assistant_message: 'SECRET' }, { now: 100000, env: {} }), event('stopping'));
  assert.equal(projectHookEvent({ ...input, turn_id: null }, { now: 100000, env: {} }), null);
  assert.equal(projectHookEvent({ ...input, hook_event_name: 'SubagentStop' }, { now: 100000, env: {} }), null);
  assert.equal(projectHookEvent({ ...input, hook_event_name: 'PreToolUse' }, { now: 100000, env: { CODEX_THREAD_ID: OTHER } }), null);
  assert.equal(projectHookEvent({ ...input, hook_event_name: 'PreToolUse' }, { now: 100000, env: {} }), null);
  assert.deepEqual(projectHookEvent({ ...input, hook_event_name: 'PreToolUse' }, { now: 100000, env: { CODEX_THREAD_ID: ID } }), event('running'));
  assert.deepEqual(projectHookEvent({ ...input, hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    { now: 100000, env: { CODEX_THREAD_ID: ID } }), { ...event('attention'), attentionKind: 'permission' });
  assert.deepEqual(projectHookEvent({ ...input, hook_event_name: 'PreToolUse', tool_name: 'request_user_input' },
    { now: 100000, env: { CODEX_THREAD_ID: ID } }), { ...event('attention'), attentionKind: 'input' });
  assert.deepEqual(projectHookEvent({ ...input, hook_event_name: 'PostToolUse', tool_name: 'request_user_input' },
    { now: 100000, env: { CODEX_THREAD_ID: ID } }), event('running'));
  assert.equal(projectHookEvent({ ...input, hook_event_name: 'PostToolUse', tool_name: 'Bash' },
    { now: 100000, env: { CODEX_THREAD_ID: ID } }), null);
  assert.equal(projectHookEvent({ ...input, hook_event_name: 'PermissionRequest', tool_name: 'Bash' },
    { now: 100000, env: {} }), null);
  assert.deepEqual(projectHookEvent({ type: 'agent-turn-complete', 'thread-id': ID, 'turn-id': 'turn-1', 'last-assistant-message': 'SECRET' }, { mode: 'notify', now: 100000 }), event('completed'));
});

test('desktop tool hooks without a thread environment require the matching transcript filename identity', () => {
  const input = { hook_event_name: 'PreToolUse', session_id: ID, turn_id: 'turn-1', tool_name: 'Bash',
    transcript_path: `/fixture/sessions/rollout-2026-09-15T16-15-02-${ID}_${OTHER}.jsonl` };
  assert.deepEqual(projectHookEvent(input, { now: 100000, env: {} }), event('running'));
  assert.deepEqual(projectHookEvent({ ...input, transcript_path: `/fixture/rollout-2026-09-15T16-15-02-${ID}.jsonl` },
    { now: 100000, env: {} }), event('running'));
  for (const extra of [{ transcript_path: `/fixture/rollout-2026-09-15T16-15-02-${OTHER}_${ID}.jsonl` },
    { transcript_path: '/fixture/unknown.jsonl' }, { transcript_path: `rollout-2026-09-15T16-15-02-${ID}.jsonl` },
    { agent_id: OTHER }, { parent_thread_id: OTHER }, { is_subagent: true }, { source: 'cloud' }]) {
    assert.equal(projectHookEvent({ ...input, ...extra }, { now: 100000, env: {} }), null);
  }
  assert.equal(projectHookEvent(input, { now: 100000, env: { CODEX_THREAD_ID: OTHER } }), null);
  assert.equal(projectHookEvent({ ...input, transcript_path: `/fixture/rollout-2026-09-15T16-15-02-${OTHER}.jsonl` },
    { now: 100000, env: { CODEX_THREAD_ID: ID } }), null);
});

test('token read requires an owned regular 0600 file and refuses symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-hook-token-'));
  const file = path.join(dir, 'token');
  try {
    fs.writeFileSync(file, 'a'.repeat(64), { mode: 0o600 });
    assert.equal(readToken(file), 'a'.repeat(64));
    fs.chmodSync(file, 0o644);
    assert.equal(readToken(file), null);
    fs.chmodSync(file, 0o600);
    fs.symlinkSync(file, path.join(dir, 'link'));
    assert.equal(readToken(path.join(dir, 'link')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bridge sends metadata only to the fixed local endpoint and preserves original Sky payload separately', async () => {
  let options, sent, args;
  const request = (provided, callback) => {
    options = provided;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = body => { sent = JSON.parse(body); callback({ statusCode: 200, resume() {} }); };
    return req;
  };
  assert.equal(await sendEvent(event('running'), { token: 'a'.repeat(64), request }), true);
  assert.equal(options.hostname, '127.0.0.1');
  assert.equal(options.path, '/codex-lifecycle');
  assert.deepEqual(sent, event('running'));
  forwardOriginalNotify('ORIGINAL', { env: { CODEX_HOME: '/fixture' }, spawnProcess(file, parameters) {
    args = parameters; const child = new EventEmitter(); child.unref = () => {}; return child;
  } });
  assert.deepEqual(args, ['turn-ended', 'ORIGINAL']);
});

test('lifecycle ignores late previous-turn completion, preserves quiet activity and never overlays ineligible metadata', () => {
  let now = 100000;
  const lifecycle = createTaskLifecycleState({ now: () => now });
  const task = { id: ID, title: 'Fixture', notificationEligible: true, status: 'unknown', updatedAt: 90000 };
  lifecycle.ingest(event('running'));
  now += 1000;
  lifecycle.ingest(event('running', now, 'turn-2'));
  assert.equal(lifecycle.ingest(event('completed', now + 1)).ignored, true);
  assert.equal(lifecycle.overlay([task])[0].turnId, 'turn-2');
  now += 301000;
  assert.equal(lifecycle.overlay([task])[0].status, 'running');
  assert.equal(lifecycle.overlay([task])[0].statusReason, null);
  assert.equal(lifecycle.overlay([{ ...task, notificationEligible: false }])[0].statusSource, undefined);
  lifecycle.clear();
  assert.equal(lifecycle.overlay([task])[0].turnId, undefined);
});

test('owner identity is optional but paired and strict; silence and uncertain checks never imply source death', () => {
  let now = 100000;
  const owner = { ownerPid: 1234, ownerStartedAt: 'Fri Sep 4 13:34:50 2026' };
  const owned = { ...event('running'), ...owner };
  assert.deepEqual(validateTaskEvent(owned, now), owned);
  for (const invalid of [{ ownerPid: 1234 }, { ownerStartedAt: owner.ownerStartedAt }, { ...owner, ownerPid: -1 }, { ...owner, ownerPid: 1 },
    { ...owner, ownerPid: 1.5 }, { ...owner, ownerStartedAt: 'not a process start' },
    { ...owner, ownerStartedAt: 'Fri Sep 4 99:34:50 2026' }]) {
    assert.equal(validateTaskEvent({ ...event('running'), ...invalid }, now), null);
  }
  const lifecycle = createTaskLifecycleState({ now: () => now });
  const task = { id: ID, title: 'Fixture', notificationEligible: true, status: 'unknown', updatedAt: now };
  lifecycle.ingest(owned);
  lifecycle.overlay([task]);
  now += 26 * 3600000;
  assert.equal(lifecycle.overlay([])[0].status, 'running', 'a long quiet task retains its confirmed metadata');
  assert.deepEqual(lifecycle.ownerIdentities(), [{ pid: 1234, startedAt: owner.ownerStartedAt }]);
  assert.equal(lifecycle.reconcileOwners([{ pid: 1234, startedAt: owner.ownerStartedAt, alive: null }]), false);
  assert.equal(lifecycle.reconcileOwners([{ pid: 1234, startedAt: 'Fri Sep 4 14:00:00 2026', alive: false }]), false, 'a reused PID is a different owner');
  assert.equal(lifecycle.overlay([])[0].status, 'running');
  assert.equal(lifecycle.reconcileOwners([{ pid: 1234, startedAt: owner.ownerStartedAt, alive: false }]), true);
  const lost = lifecycle.overlay([])[0];
  assert.equal(lost.status, 'unknown');
  assert.equal(lost.statusReason, 'source_process_exited');
  assert.equal(lost.turnStartedAt, null, 'source death breaks completion eligibility');
  assert.deepEqual(lifecycle.ownerIdentities(), []);
  lifecycle.ingest(event('running', now + 1, 'turn-2'));
  assert.equal(lifecycle.overlay([task])[0].status, 'running', 'a new confirmed turn can become active again');
});

test('owner identity survives same-turn events without owner fields and is replaced for a new turn', () => {
  let now = 100000;
  const lifecycle = createTaskLifecycleState({ now: () => now });
  lifecycle.ingest({ ...event('running'), ownerPid: 1234, ownerStartedAt: 'Fri Sep 4 13:34:50 2026' });
  now += 1000;
  lifecycle.ingest(event('stopping', now));
  assert.equal(lifecycle.ownerIdentities()[0].pid, 1234);
  lifecycle.ingest(event('running', ++now, 'new-turn'));
  assert.deepEqual(lifecycle.ownerIdentities(), []);
  lifecycle.ingest({ ...event('attention', ++now, 'attention-first-turn'), attentionKind: 'input' });
  const attention = lifecycle.overlay([{ id: ID, title: 'Fixture', notificationEligible: true, updatedAt: now }])[0];
  assert.equal(attention.status, 'attention', 'an authenticated attention event can be the first observed signal for a new turn');
  assert.equal(attention.turnStartedAt, now);
});

test('confirmed completion stays in the recent window and expires without reviving stale state', () => {
  let now = 100000;
  const lifecycle = createTaskLifecycleState({ now: () => now });
  const task = { id: ID, title: 'Fixture', notificationEligible: true, status: 'unknown', updatedAt: 90000 };
  lifecycle.ingest(event('running', now));
  now += 1000;
  lifecycle.ingest(event('completed', now));
  now += 299000;
  assert.equal(lifecycle.overlay([task])[0].status, 'completed');
  now += 2000;
  assert.equal(lifecycle.overlay([task])[0].status, 'unknown');
  lifecycle.ingest(event('running', now, 'turn-2'));
  assert.equal(lifecycle.overlay([task])[0].status, 'running');
  now += 1000;
  lifecycle.ingest(event('completed', now, 'turn-2'));
  assert.equal(lifecycle.overlay([{ ...task, updatedAt: now + 31000 }])[0].status, 'unknown');
});

test('authenticated lifecycle drives actual start/Stop/notify transitions once, independent of stale history', async () => {
  let now = 100000;
  const events = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 10000, onTaskComplete: event => events.push(event),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list' ? { data: [{ id: ID, name: 'Fixture', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: 100 }] }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [{ id: ID, turnId: 'old', status: 'interrupted', startedAt: 1000, completedAt: 2000 }],
  });
  try {
    await service.start();
    assert.equal(service.getSnapshot().threads[0].status, 'unknown');
    assert.equal(service.ingestTaskEvent(event('running')).ok, true);
    assert.equal(service.getSnapshot().runningTasks.length, 1);
    now += 1000;
    service.ingestTaskEvent(event('stopping', now));
    assert.equal(service.getSnapshot().threads[0].statusReason, 'awaiting_completion');
    assert.equal(events.length, 0);
    now += 1000;
    service.ingestTaskEvent(event('completed', now));
    assert.equal(events.length, 1);
    service.ingestTaskEvent(event('completed', now));
    await service.refresh();
    assert.equal(events.length, 1);
    service.stop();
    await service.start();
    assert.equal(service.getSnapshot().threads[0].status, 'unknown', 'restart must not restore old active state');
    service.ingestTaskEvent(event('completed', now));
    assert.equal(events.length, 1, 'completion without an observed start after restart is not replayed');
  } finally { service.stop(); }
});

test('authenticated running, permission, input and terminal transitions stay distinct and deduplicated', async () => {
  let now = 100000;
  const completions = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 10000,
    onTaskComplete: item => completions.push(item),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list'
        ? { data: [{ id: ID, name: 'Fixture', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: 100 }] }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [],
  });
  try {
    await service.start();
    service.ingestTaskEvent(event('running', now));
    service.ingestTaskEvent({ ...event('attention', ++now), attentionKind: 'permission' });
    let snapshot = service.getSnapshot();
    assert.equal(snapshot.runningTasks.length, 0);
    assert.deepEqual(snapshot.attentionTasks[0], {
      id: ID, title: 'Fixture', turnId: 'turn-1', status: 'attention', attentionKind: 'permission',
    });
    assert.equal(snapshot.threads[0].statusReason, 'awaiting_permission');
    service.ingestTaskEvent(event('running', ++now));
    service.ingestTaskEvent({ ...event('attention', ++now), attentionKind: 'input' });
    snapshot = service.getSnapshot();
    assert.equal(snapshot.threads[0].attentionKind, 'input');
    assert.equal(snapshot.threads[0].statusReason, 'awaiting_user_input');
    service.ingestTaskEvent(event('running', ++now));
    assert.equal(service.getSnapshot().runningTasks.length, 1);
    service.ingestTaskEvent(event('completed', ++now));
    service.ingestTaskEvent(event('completed', now));
    snapshot = service.getSnapshot();
    assert.equal(completions.length, 1);
    assert.equal(snapshot.attentionTasks.length, 0);
    assert.equal(snapshot.recentCompletedTasks.length, 1);
    service.ingestTaskEvent(event('running', ++now, 'turn-2'));
    service.ingestTaskEvent(event('interrupted', ++now, 'turn-2'));
    snapshot = service.getSnapshot();
    assert.equal(snapshot.runningTasks.length, 0);
    assert.deepEqual(snapshot.recentIssueTasks, [{
      id: ID, title: 'Fixture', turnId: 'turn-2', status: 'interrupted', recordedAt: now,
    }], 'interrupted terminal state must remain projected long enough for the island and workbench to surface it');
  } finally { service.stop(); }
});

test('app-server attention survives restart while stale in-memory hook attention does not', async () => {
  let now = 100000;
  let status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  const service = createCodexFloatService({ now: () => now, tickMs: 10000,
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list'
        ? { data: [{ id: ID, name: 'Fixture', source: 'vscode', status, updatedAt: 100 }] }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [],
  });
  try {
    await service.start();
    assert.equal(service.getSnapshot().attentionTasks[0].attentionKind, 'input');
    service.ingestTaskEvent({ ...event('attention', ++now), attentionKind: 'permission' });
    assert.equal(service.getSnapshot().attentionTasks[0].attentionKind, 'permission');
    service.stop();
    await service.start();
    assert.equal(service.getSnapshot().attentionTasks[0].attentionKind, 'input',
      'restart rebuilds attention only from the current authoritative app-server flag');
    status = { type: 'idle' };
    await service.refresh();
    assert.equal(service.getSnapshot().attentionTasks.length, 0);
    assert.equal(service.getSnapshot().threads[0].status, 'unknown');
  } finally { service.stop(); }
});

test('quota offline cannot erase authenticated task activity or prevent its one completion notification', async () => {
  let now = 100000;
  let offline = false;
  const events = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 10000, onTaskComplete: event => events.push(event),
    clientFactory: () => ({ async request(method) {
      if (method !== 'thread/list' && offline) throw Error('offline');
      return method === 'thread/list' ? { data: [ID, OTHER].map(id => ({ id, name: 'Fixture', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: 100 })) }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [{ id: OTHER, turnId: 'history-turn', status: 'inProgress', startedAt: 99000, completedAt: null }],
  });
  try {
    await service.start();
    service.ingestTaskEvent(event('running', now));
    service.ingestTaskEvent({ ...event('attention', ++now), attentionKind: 'permission' });
    offline = true;
    now += 1000;
    await service.refresh();
    assert.equal(service.getSnapshot().connection, 'stale');
    assert.equal(service.getSnapshot().runningTasks.length, 0, 'waiting work must not be presented as actively running');
    assert.deepEqual(service.getSnapshot().attentionTasks.map(task => task.id), [ID],
      'authenticated Hook attention survives an app-server disconnect');
    assert.equal(service.getSnapshot().attentionTasks[0].attentionKind, 'permission');
    now += 1000;
    service.ingestTaskEvent(event('running', now));
    await service.refresh();
    assert.equal(service.getSnapshot().runningTasks[0].id, ID);
    now += 1000;
    service.ingestTaskEvent(event('completed', now));
    assert.equal(events.length, 1);
    assert.equal(events[0].threadId, ID);
    await service.refresh();
    service.ingestTaskEvent(event('completed', now));
    assert.equal(events.length, 1);
    assert.equal(service.getSnapshot().threads.find(task => task.id === ID).status, 'completed');
    assert.equal(service.getSnapshot().threads.find(task => task.id === OTHER).status, 'unknown');
  } finally { service.stop(); }
});

test('quiet authenticated turns complete exactly once after thirty minutes or more than a day, including Stop', async () => {
  for (const quietMs of [30 * 60000, 26 * 3600000]) {
    let now = 100000;
    const events = [];
    const service = createCodexFloatService({ now: () => now, tickMs: 60000, onTaskComplete: item => events.push(item),
      clientFactory: () => ({ async request(method) {
        return method === 'thread/list' ? { data: [{ id: ID, name: 'Fixture long task', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: 100 }] }
          : { rateLimits: { primary: { usedPercent: 10 } } };
      }, stop() {} }), readTaskStates: async () => [{ id: ID, turnId: 'old', status: 'completed', startedAt: 1000, completedAt: 2000 }],
    });
    try {
      await service.start();
      assert.equal(events.length, 0, 'old terminal history is only a baseline');
      service.ingestTaskEvent(event('running', now));
      now += quietMs;
      await service.refresh();
      assert.equal(service.getSnapshot().runningTasks.length, 1, `${quietMs}ms of silence must not lose a confirmed turn`);
      service.ingestTaskEvent(event('stopping', now));
      now += 120000;
      await service.refresh();
      assert.equal(service.getSnapshot().threads[0].statusReason, 'awaiting_completion');
      assert.equal(events.length, 0, 'Stop does not announce completion');
      service.ingestTaskEvent(event('completed', now));
      assert.equal(events.length, 1, 'completion retains the start observed before the quiet interval');
      service.ingestTaskEvent(event('completed', now));
      await service.refresh();
      assert.equal(events.length, 1);
      service.ingestTaskEvent(event('running', ++now, 'next-turn'));
      service.ingestTaskEvent(event('interrupted', ++now, 'next-turn'));
      service.ingestTaskEvent(event('completed', ++now, 'next-turn'));
      assert.equal(events.length, 1, 'interruption cannot later become a success notification');
      service.ingestTaskEvent(event('running', ++now, 'third-turn'));
      service.stop();
      await service.start();
      service.ingestTaskEvent(event('completed', ++now, 'third-turn'));
      assert.equal(events.length, 1, 'stopping the service must discard old completion eligibility');
    } finally { service.stop(); }
  }
});

test('all 32 confirmed turns survive being pushed behind 32 newer rows until each terminal event', async () => {
  let now = 100000;
  const id = index => `0198bbbb-0000-7000-8000-${String(index).padStart(12, '0')}`;
  let recent = Array.from({ length: 32 }, (_, index) => id(index));
  const completed = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 60000, onTaskComplete: item => completed.push(item),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list' ? { data: recent.map(value => ({ id: value, name: 'Fixture task', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: now / 1000 })) }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [],
  });
  try {
    await service.start();
    for (let index = 0; index < 32; index++) service.ingestTaskEvent({ ...event('running', now), threadId: id(index) });
    recent = Array.from({ length: 32 }, (_, index) => id(index + 32));
    await service.refresh();
    now += 26 * 3600000;
    await service.refresh();
    assert.equal(service.getSnapshot().threads.length, 64, 'current rows and retained authenticated activities stay bounded');
    assert.equal(service.getSnapshot().threads.filter(task => task.status === 'running').length, 32);
    assert.equal(service.getSnapshot().runningTasks.length, 32,
      'the single-ring UI must retain the true concurrent count while the detail view applies its own eight-row cap');
    assert.equal(service.hasThread(id(0)), true, 'verified active metadata remains available for linking');
    for (let index = 0; index < 32; index++) {
      service.ingestTaskEvent({ ...event('completed', ++now), threadId: id(index) });
    }
    assert.equal(completed.length, 32, 'no retained task beyond the first forty overlay rows may lose its notification');
    assert.equal(new Set(completed.map(item => item.threadId)).size, 32);
    await service.refresh();
    assert.equal(service.getSnapshot().threads.length, 64, 'recent terminal metadata remains available beside the latest list');
    assert.equal(service.getSnapshot().recentCompletedTasks.length, 8, 'recent-completion projection is capped and deduplicated');
    assert.equal(service.getSnapshot().runningTasks.length, 0);
  } finally { service.stop(); }
});

test('retained lifecycle metadata is bounded without evicting confirmed active turns for new unverified events', () => {
  const now = 100000;
  const lifecycle = createTaskLifecycleState({ now: () => now });
  const tasks = Array.from({ length: 32 }, (_, index) => ({
    id: `0198cccc-0000-7000-8000-${String(index).padStart(12, '0')}`, title: 'Fixture', notificationEligible: true, updatedAt: now,
  }));
  for (const task of tasks) {
    lifecycle.ingest({ ...event('running', now), threadId: task.id });
    lifecycle.overlay([task]);
  }
  assert.equal(lifecycle.overlay([]).length, 32);
  assert.deepEqual(lifecycle.ingest(event('running', now)), { ok: false, error: 'activity_capacity_reached' });
  assert.equal(lifecycle.overlay([]).filter(task => task.status === 'running').length, 32);
  lifecycle.ingest({ ...event('completed', now), threadId: tasks[0].id });
  lifecycle.overlay([]);
  assert.equal(lifecycle.ingest(event('running', now)).ok, true, 'terminal records can make room for new activities');
});

test('explicit newer-turn metadata replaces an old activity while stale history and unscoped idle do not', () => {
  let now = 100123;
  const lifecycle = createTaskLifecycleState({ now: () => now });
  const task = { id: ID, title: 'Fixture', notificationEligible: true, status: 'unknown', updatedAt: now };
  lifecycle.ingest(event('running', now));
  lifecycle.overlay([task]);
  now += 1800000;
  assert.equal(lifecycle.overlay([{ ...task, status: 'completed', statusSource: 'history', turnId: 'old-history',
    turnStartedAt: 1000, turnCompletedAt: 2000 }])[0].status, 'running');
  for (const status of ['idle', 'failed']) {
    assert.equal(lifecycle.overlay([{ ...task, status, statusSource: 'app-server', turnId: null }])[0].status, 'running',
      'a state without a turn identity cannot terminate the confirmed old turn');
  }
  const next = { ...task, status: 'completed', statusSource: 'history', turnId: 'newer-turn',
    turnStartedAt: now - 1000, turnCompletedAt: now };
  assert.deepEqual(lifecycle.overlay([next])[0], next);
  assert.deepEqual(lifecycle.overlay([]), [], 'the superseded activity no longer retains metadata');
  lifecycle.ingest(event('running', now, 'terminal-before-new'));
  lifecycle.ingest(event('completed', ++now, 'terminal-before-new'));
  const immediatelyNext = { ...task, status: 'running', statusSource: 'history', turnId: 'immediate-next',
    turnStartedAt: ++now, turnCompletedAt: null };
  assert.deepEqual(lifecycle.overlay([immediatelyNext])[0], immediatelyNext, 'a confirmed new turn supersedes even a just-completed prior turn');
});

test('same-turn terminal index can finish a quiet hook turn exactly once without relying on another notify', async () => {
  let now = 100123;
  let history = [];
  const events = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 60000, onTaskComplete: item => events.push(item),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list' ? { data: [{ id: ID, name: 'Fixture', source: 'vscode', status: { type: 'notLoaded' }, updatedAt: 100 }] }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => history,
  });
  try {
    await service.start();
    service.ingestTaskEvent(event('running', now));
    now += 26 * 3600000;
    history = [{ id: ID, turnId: 'turn-1', status: 'completed', startedAt: 100000, completedAt: now - 123 }];
    await service.refresh();
    assert.equal(service.getSnapshot().threads[0].turnStartedAt, 100123, 'hook start must retain its original precision');
    assert.equal(service.getSnapshot().runningTasks.length, 0);
    assert.equal(events.length, 1);
    service.ingestTaskEvent(event('completed', ++now));
    await service.refresh();
    assert.equal(events.length, 1, 'a subsequent notify cannot duplicate the indexed completion');
  } finally { service.stop(); }
});

test('a new task finishing before metadata arrives still notifies once from its authenticated start', async () => {
  let now = 100000, visible = false;
  const completed = [];
  const service = createCodexFloatService({ now: () => now, tickMs: 60000, onTaskComplete: e => completed.push(e),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list' ? { data: visible ? [{ id: ID, name: '新项目', source: 'cli', status: { type: 'notLoaded' }, updatedAt: 100 }] : [] }
        : { rateLimits: { primary: { usedPercent: 10 } } };
    }, stop() {} }), readTaskStates: async () => [], readOwnerStates: async () => [],
  });
  try {
    await service.start();
    assert.equal(service.ingestTaskEvent(event('running', now)).pendingMetadata, true);
    service.ingestTaskEvent(event('stopping', ++now));
    assert.equal(service.ingestTaskEvent(event('completed', ++now)).pendingMetadata, true);
    assert.equal(completed.length, 0, 'wait for verified local parent-task metadata');
    visible = true;
    await service.refresh();
    assert.equal(completed.length, 1);
    assert.equal(completed[0].title, '新项目');
    assert.equal(service.getSnapshot().runningTasks.length, 0, 'do not flash a fabricated running state after completion');
    await service.refresh();
    service.ingestTaskEvent(event('completed', ++now));
    assert.equal(completed.length, 1);
    service.ingestTaskEvent(event('running', ++now, 'next-turn'));
    service.ingestTaskEvent(event('completed', ++now, 'next-turn'));
    assert.equal(completed.length, 2);
  } finally { service.stop(); }
});

test('delayed metadata never authorizes completion without a start, after interruption or for a child or cloud task', async () => {
  for (const scenario of ['no-start', 'interrupted', 'child', 'cloud', 'expired', 'restart']) {
    let now = 100000, visible = false;
    const completed = [];
    const service = createCodexFloatService({ now: () => now, tickMs: 60000, onTaskComplete: e => completed.push(e),
      clientFactory: () => ({ async request(method) {
        return method === 'thread/list' ? { data: visible ? [{ id: ID, name: '不可提醒的测试任务', source: 'cli', status: { type: 'notLoaded' }, updatedAt: 100,
          ...(scenario === 'child' ? { parentThreadId: OTHER } : {}), ...(scenario === 'cloud' ? { threadSource: 'cloud' } : {}) }] : [] }
          : { rateLimits: { primary: { usedPercent: 10 } } };
      }, stop() {} }), readTaskStates: async () => [], readOwnerStates: async () => [],
    });
    try {
      await service.start();
      if (scenario !== 'no-start') service.ingestTaskEvent(event('running', now));
      if (scenario === 'restart') { service.stop(); await service.start(); }
      if (scenario === 'interrupted') service.ingestTaskEvent(event('interrupted', ++now));
      service.ingestTaskEvent(event('completed', ++now));
      if (scenario === 'expired') now += 61000;
      visible = true;
      await service.refresh();
      assert.equal(completed.length, 0, scenario);
    } finally { service.stop(); }
  }
});
