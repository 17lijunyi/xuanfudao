'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTaskCompletionTracker, runningTaskActivities, attentionTaskActivities,
  recentCompletedActivities, recentIssueActivities } = require('../codex-task-state');
const { createCodexFloatService, createTaskStateReader } = require('../codex-float');
const ID = '0198aaaa-0000-7000-8000-111111111111';
const running = (extra = {}) => ({ id: ID, title: 'Fixture', turnId: 'turn-1', status: 'running', statusSource: 'history',
  notificationEligible: true, turnStartedAt: 99000, turnCompletedAt: null, ...extra });

test('only observed same-turn running to completed emits; old history and duplicate samples remain quiet', () => {
  let stamp = 100000;
  const tracker = createTaskCompletionTracker({ now: () => stamp });
  const old = running({ status: 'completed', turnCompletedAt: 99000 });
  assert.deepEqual(tracker.observe([old]), []);
  assert.deepEqual(tracker.observe([running()]), []);
  stamp += 2000;
  const done = running({ status: 'completed', turnCompletedAt: stamp });
  assert.equal(tracker.observe([done]).length, 1);
  assert.deepEqual(tracker.observe([done]), []);
  tracker.observe([running()]);
  assert.deepEqual(tracker.observe([done]), [], 'replayed running state does not re-arm a delivered turn');
  const next = running({ turnId: 'turn-2', turnStartedAt: stamp });
  tracker.observe([next]);
  stamp += 2000;
  assert.equal(tracker.observe([{ ...next, status: 'completed', turnCompletedAt: stamp }]).length, 1);
});

test('disconnect, unknown state, missing tasks, failures and interruptions break completion evidence', () => {
  for (const interruption of ['disconnect', 'reset', 'absent', 'unknown', 'failed', 'interrupted', 'idle']) {
    let stamp = 100000;
    const tracker = createTaskCompletionTracker({ now: () => stamp });
    tracker.observe([running()]);
    if (interruption === 'disconnect') tracker.observe([], { connected: false });
    else if (interruption === 'reset') tracker.reset();
    else if (interruption === 'absent') tracker.observe([]);
    else tracker.observe([running({ status: interruption })]);
    stamp += 2000;
    assert.deepEqual(tracker.observe([running({ status: 'completed', turnCompletedAt: stamp })]), [], interruption);
  }
});

test('attention keeps the same live turn armed while duplicate recent projections stay bounded', () => {
  let stamp = 100000;
  const tracker = createTaskCompletionTracker({ now: () => stamp });
  tracker.observe([running()]);
  stamp += 1000;
  const attention = running({ status: 'attention', statusSource: 'hook', attentionKind: 'permission',
    statusReason: 'awaiting_permission', statusRecordedAt: stamp });
  assert.deepEqual(tracker.observe([attention]), []);
  assert.deepEqual(attentionTaskActivities([attention], { connected: false }), [{
    id: ID, title: 'Fixture', turnId: 'turn-1', status: 'attention', attentionKind: 'permission',
  }]);
  stamp += 1000;
  tracker.observe([running({ statusSource: 'hook' })]);
  stamp += 1000;
  const complete = running({ status: 'completed', statusSource: 'hook', turnCompletedAt: stamp });
  assert.equal(tracker.observe([complete]).length, 1);
  assert.deepEqual(recentCompletedActivities([complete, complete], { now: stamp }), [{
    id: ID, title: 'Fixture', turnId: 'turn-1', status: 'completed', completedAt: stamp,
  }]);
  assert.deepEqual(recentCompletedActivities([complete], { now: stamp + 300001 }), []);
});

test('recent issue projection keeps only eligible fresh failures and interruptions', () => {
  const now = 400000;
  const items = [
    running({ id: '0198aaaa-0000-7000-8000-000000000001', status: 'failed', turnCompletedAt: now - 1000 }),
    running({ id: '0198aaaa-0000-7000-8000-000000000002', status: 'interrupted', statusRecordedAt: now - 2000, turnCompletedAt: null }),
    running({ id: '0198aaaa-0000-7000-8000-000000000003', status: 'failed', turnCompletedAt: now - 300001 }),
    running({ id: '0198aaaa-0000-7000-8000-000000000004', status: 'failed', turnCompletedAt: now - 500, notificationEligible: false }),
  ];
  assert.deepEqual(recentIssueActivities([...items, items[0]], { now }), [
    { id: items[0].id, title: 'Fixture', turnId: 'turn-1', status: 'failed', recordedAt: now - 1000 },
    { id: items[1].id, title: 'Fixture', turnId: 'turn-1', status: 'interrupted', recordedAt: now - 2000 },
  ]);
});

test('wrong turn IDs, stale/future timestamps and nonlocal threads never produce completion', () => {
  for (const extra of [{ turnId: 'turn-other' }, { turnCompletedAt: 90000 }, { turnCompletedAt: 110000 },
    { notificationEligible: false }, { statusSource: null }, { turnId: null }]) {
    const tracker = createTaskCompletionTracker({ now: () => 102000 });
    tracker.observe([running()]);
    assert.deepEqual(tracker.observe([running({ status: 'completed', turnCompletedAt: 102000, ...extra })]), []);
  }
  const tracker = createTaskCompletionTracker({ now: () => 1000000 });
  tracker.observe([running()]);
  assert.deepEqual(tracker.observe([running({ status: 'completed', turnCompletedAt: 102000 })]), []);
});

test('parallel running tasks preserve the full bounded count without invented percentages', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => running({ id: `0198aaaa-0000-7000-8000-${String(i).padStart(12, '0')}` }));
  const output = runningTaskActivities(tasks);
  assert.equal(output.length, 8);
  assert.ok(output.every(item => item.progressMode === 'indeterminate' && !Object.hasOwn(item, 'percent')));
  assert.deepEqual(runningTaskActivities([running({ notificationEligible: false })]), []);
});

test('service observes actual isolated SQLite row transitions, never baseline history, and emits each new turn once', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-task-state-'));
  const database = path.join(directory, 'thread_history_1.sqlite');
  const sql = query => execFileSync('/usr/bin/sqlite3', [database, query], { encoding: 'utf8' });
  let stamp = 100000;
  const events = [];
  const service = createCodexFloatService({ now: () => stamp, tickMs: 10000, onTaskComplete: event => events.push(event),
    readTaskStates: createTaskStateReader({ codexHome: directory }),
    clientFactory: () => ({ async request(method) {
      return method === 'thread/list' ? { data: [{ id: ID, source: 'appServer', status: { type: 'notLoaded' }, name: 'Fixture', updatedAt: 100 }] }
        : { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } };
    }, stop() {} }),
  });
  try {
    sql(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER);
      INSERT INTO thread_turns VALUES('${ID}','old','completed',90,95,1);`);
    await service.start();
    assert.equal(events.length, 0);
    sql(`INSERT INTO thread_turns VALUES('${ID}','new','inProgress',100,NULL,2);`);
    await service.refresh();
    assert.equal(service.getSnapshot().runningTasks.length, 1);
    stamp = 103000;
    sql("UPDATE thread_turns SET status='completed',completed_at=103 WHERE turn_id='new';");
    await service.refresh();
    assert.equal(events.length, 1);
    assert.equal(events[0].turnId, 'new');
    await service.refresh();
    assert.equal(events.length, 1);
    sql(`INSERT INTO thread_turns VALUES('${ID}','next','inProgress',103,NULL,3);`);
    await service.refresh();
    stamp = 106000;
    sql("UPDATE thread_turns SET status='completed',completed_at=106 WHERE turn_id='next';");
    await service.refresh();
    assert.equal(events.length, 2);
    assert.equal(service.getSnapshot().runningTasks.length, 0);
  } finally { service.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
