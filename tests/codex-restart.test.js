'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { createCodexActivityCache } = require(path.join(root, 'codex-activity-cache'));
const { createCodexFloatService } = require(path.join(root, 'codex-float'));
const { createAICodeRuntime } = require(path.join(root, 'ai-code-runtime'));
const ID = '0198aaaa-0000-7000-8000-111111111111';
const OWNER = { ownerPid: 1234, ownerStartedAt: 'Tue Sep 15 09:00:00 2026' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-restart-'));
  let stamp = 100000, enabled = true;
  const now = () => stamp;
  const cache = createCodexActivityCache({ directory, now, isEnabled: () => enabled });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const event = (kind = 'running', extra = {}) => ({ version: 1, kind, at: stamp, threadId: ID, turnId: 'one', source: 'local', parentThreadId: null, agentId: null, ...OWNER, ...extra });
  function service({ rows = [{ id: ID, name: 'Project', cwd: '/Fixture/project', source: 'appServer', updatedAt: 100 }], alive = true } = {}) {
    const completions = [];
    const instance = createCodexFloatService({ now, activityCache: cache, tickMs: 600000,
      onTaskComplete: value => completions.push(value), readTaskStates: async () => null,
      readOwnerStates: async owners => owners.map(owner => ({ ...owner, alive })),
      clientFactory: () => ({ request: async method => method === 'thread/list' ? { data: rows } : { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080 } } }, stop() {} }),
    });
    t.after(() => instance.stop()); return { instance, completions };
  }
  return { directory, cache, event, service, advance: ms => { stamp += ms; }, disable: () => { enabled = false; } };
}

test('a quiet task survives island restart using its exact owner and original start, even outside the recent list', async t => {
  const f = fixture(t), first = f.service(); await first.instance.start();
  await f.cache.record(f.event()); first.instance.ingestTaskEvent(f.event()); await f.cache.drain();
  assert.equal(first.instance.getSnapshot().runningTasks.length, 1);
  first.instance.stop(); f.advance(26 * 3600000);
  const restarted = f.service({ rows: [] }); await restarted.instance.start();
  const snapshot = restarted.instance.getSnapshot();
  assert.equal(snapshot.runningTasks.length, 1);
  assert.equal(snapshot.threads[0].title, 'Project');
  assert.equal(snapshot.threads[0].turnStartedAt, 100000);
  assert.equal(snapshot.taskActivityKnown, true); assert.equal(restarted.completions.length, 0);
  f.advance(1000); await f.cache.record(f.event('completed')); restarted.instance.ingestTaskEvent(f.event('completed'));
  assert.equal(restarted.completions.length, 1); assert.equal(restarted.instance.getSnapshot().runningTasks.length, 0);
  restarted.instance.ingestTaskEvent(f.event('completed')); assert.equal(restarted.completions.length, 1);
  await f.cache.drain();
});

test('completion while the island is closed prevents a ghost task and does not replay a completion popup', async t => {
  const f = fixture(t); await f.cache.record(f.event(), { id: ID, title: 'Project', notificationEligible: true });
  f.advance(5000); await f.cache.record(f.event('completed'));
  const restarted = f.service(); await restarted.instance.start();
  assert.equal(restarted.instance.getSnapshot().runningTasks.length, 0);
  assert.equal(restarted.instance.getSnapshot().taskActivityKnown, true);
  assert.deepEqual(restarted.completions, []);
  await f.cache.drain();
});

test('dead or unverified source processes never resurrect cached running tasks', async t => {
  for (const alive of [false, null]) {
    const f = fixture(t); await f.cache.record(f.event(), { id: ID, title: 'Project', notificationEligible: true });
    const restarted = f.service({ alive }); await restarted.instance.start();
    assert.equal(restarted.instance.getSnapshot().runningTasks.length, 0);
    assert.equal(restarted.instance.getSnapshot().taskActivityKnown, alive === false);
    assert.deepEqual(restarted.completions, []); await f.cache.drain();
  }
});

test('cache rejects private payload fields, symlinks and permissive files, and ignores late start events after completion', async t => {
  const f = fixture(t);
  assert.equal(await f.cache.record(f.event('running', { prompt: 'PRIVATE' })), false);
  await f.cache.record(f.event(), { id: ID, title: 'Project', notificationEligible: true, cwd: '/secret/path', response: 'PRIVATE' });
  const older = f.event(); f.advance(1000); await f.cache.record(f.event('completed'));
  await f.cache.record(older); assert.equal(f.cache.read()[0].event.kind, 'completed');
  const file = path.join(f.directory, ID + '.json'); assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE|secret/);
  fs.chmodSync(file, 0o644); assert.deepEqual(f.cache.read(), []);
  fs.unlinkSync(file); fs.symlinkSync('/etc/hosts', file); assert.deepEqual(f.cache.read(), []);
});

test('switching tools clears saved activity, while stopping for an app restart preserves it', async t => {
  const f = fixture(t), codex = f.service().instance;
  const runtime = createAICodeRuntime({ codex, connectors: { inspect: async () => ({ connection: 'unsupported', threads: [] }) } });
  t.after(() => runtime.stop());
  await runtime.select({ state: { selected: 'codex', confirmed: true } });
  await f.cache.record(f.event()); runtime.stop(); assert.equal(f.cache.read().length, 1);
  await runtime.select({ state: { selected: 'mimo-code', confirmed: true } }); assert.deepEqual(f.cache.read(), []);
  f.disable(); assert.equal(await f.cache.record(f.event()), false);
});

test('cache pruning retains old live activity while bounding completed history', async t => {
  const f = fixture(t); await f.cache.record(f.event());
  for (let index = 0; index < 80; index++) {
    f.advance(10); await f.cache.record(f.event('completed', { threadId: `0198aaaa-0000-7000-8000-${String(index).padStart(12, '0')}` }));
  }
  assert.equal(f.cache.read().some(item => item.event.threadId === ID && item.event.kind === 'running'), true);
  assert.equal(fs.readdirSync(f.directory).filter(name => name.endsWith('.json')).length, 64);
});
