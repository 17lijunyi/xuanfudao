'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { createAICodeRuntime } = require(path.join(root, 'ai-code-runtime'));
const { CATALOG } = require(path.join(root, 'ai-tools'));
const { createCodeConnectors } = require(path.join(root, 'ai-code-connectors'));
const { normalizeThreads } = require(path.join(root, 'codex-float'));
const { normalizeEvent } = require(path.join(root, 'scripts/ai-code-hook'));
const chosen = id => ({ revision: 1, state: { confirmed: true, selected: id } });
const task = (id, status = 'running', extra = {}) => ({ id, title: 'Fixture project', projectKey: 'a'.repeat(64),
  status, statusSource: 'hook', turnId: 'turn-1', turnStartedAt: 90000, turnCompletedAt: status === 'completed' ? 100000 : null, ...extra });

function fixture(t) {
  let records = [], fail = false;
  const emitted = [], published = [];
  const runtime = createAICodeRuntime({ now: () => 100000, intervalMs: 3600000,
    codex: { stop() {}, start() { throw Error('Unexpected Codex read'); } },
    connectors: { inspect() { if (fail) throw Error('Read failed'); return { connection: 'connected', monitoringReady: true, threads: records }; } },
    onStatus: value => published.push(value),
    onTaskComplete(id, event) { emitted.push({ id, event }); runtime.holdCompletion(id, event); },
  });
  t.after(() => runtime.stop());
  return { runtime, emitted, published, set(value) { records = value; }, fail() { fail = true; }, recover() { fail = false; } };
}

test('every supported hook provider reserves each completion before publishing and releases only its own popup', async t => {
  for (const id of CATALOG.filter(tool => tool.monitoring === 'hooks').map(tool => tool.id)) {
    const f = fixture(t);
    f.set([task('history', 'completed')]); await f.runtime.select(chosen(id));
    assert.equal(f.emitted.length, 0, 'initial history must stay quiet');
    f.set([task('one'), task('two', 'running', { projectKey: 'b'.repeat(64) })]); await f.runtime.refresh(id);
    f.set([task('one', 'completed'), task('two', 'completed', { projectKey: 'b'.repeat(64) })]); await f.runtime.refresh(id);
    assert.equal(f.emitted.length, 2, id);
    assert.equal(f.published.at(-1).pendingCompletionTasks.length, 2, 'terminal publication includes both reserved counts');
    assert.deepEqual(f.runtime.getStatus().windows, [], 'task events cannot invent quota');
    assert.equal(f.runtime.finishCompletion('old-popup'), false);
    f.runtime.finishCompletion(f.emitted[0].event.id);
    assert.deepEqual(f.runtime.getStatus().pendingCompletionTasks.map(item => item.id), ['two']);
    await f.runtime.refresh(id);
    assert.equal(f.emitted.length, 2, 'repeated terminal reads stay deduplicated');
    f.runtime.finishCompletion(f.emitted[1].event.id);
    assert.equal(f.runtime.getStatus().pendingCompletionTasks.length, 0);
    assert.equal(f.runtime.holdCompletion('codex', f.emitted[0].event), false, 'foreign provider cannot hold a project');
    await f.runtime.select(chosen('mimo-code'));
    assert.equal(f.runtime.getStatus().pendingCompletionTasks.length, 0);
    assert.equal(f.runtime.finishCompletion(f.emitted[0].event.id), false, 'late popup cannot change a new provider');
  }
});

test('missing, failed, interrupted and unreadable hook state break completion evidence', async t => {
  for (const breakState of ['absent', 'failed', 'interrupted', 'unknown', 'read-error']) {
    const f = fixture(t); f.set([task('one')]); await f.runtime.select(chosen('kimi-code'));
    if (breakState === 'read-error') f.fail();
    else f.set(breakState === 'absent' ? [] : [task('one', breakState)]);
    await f.runtime.refresh('kimi-code'); f.recover();
    f.set([task('one', 'completed')]); await f.runtime.refresh('kimi-code');
    assert.equal(f.emitted.length, 0, breakState);
  }
});

test('project keys group equal normalized directories without exposing their full paths', () => {
  const paths = ['/Users/fixture/secret/project', '/Users/fixture/secret/./project', '/Users/fixture/another/project'];
  const threads = normalizeThreads({ data: paths.map((cwd, n) => ({ id: `0198aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`, cwd })) });
  assert.equal(threads[0].projectKey, threads[1].projectKey);
  assert.notEqual(threads[0].projectKey, threads[2].projectKey, 'same basename is not the same project');
  const event = normalizeEvent({ session_id: 'one', cwd: paths[0] }, { providerId: 'kimi-code', event: 'TurnStarted', now: 100000 });
  assert.equal(event.projectKey, threads[0].projectKey);
  assert.doesNotMatch(JSON.stringify([...threads, event]), /Users|secret/);
});

test('MiMo detects its official executable; installation alone is not a verified connection', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-status-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const connectors = createCodeConnectors({ home: base, userData: path.join(base, 'data'), searchPaths: [base], applicationDirs: [] });
  assert.equal(CATALOG.find(tool => tool.id === 'mimo-code').name, 'MiMo Code');
  assert.equal(connectors.inspect('mimo-code').connection, 'not_installed');
  fs.writeFileSync(path.join(base, 'mimo'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const result = connectors.inspect('mimo-code');
  assert.equal(result.installed, true);
  assert.equal(result.connection, 'not_connected');
  assert.equal(result.monitoringReady, false);
  assert.deepEqual(result.windows, []); assert.deepEqual(result.threads, []);
  assert.equal(fs.existsSync(path.join(base, 'data')), false, 'detection must not write configuration');
  assert.equal(connectors.connect('mimo-code').ok, true);
  assert.equal(connectors.inspect('mimo-code').connection, 'waiting');
});

test('older Codex readers cannot project stale issues, imported completions or child tasks as current activity', async t => {
  const runtime = createAICodeRuntime({ now: () => 1000000, codex: { stop() {}, start: async () => ({ connection: 'connected', threads: [] }) } });
  t.after(() => runtime.stop()); await runtime.select(chosen('codex'));
  runtime.acceptCodex({ connection: 'connected', threads: [
    { id: 'old-failure', status: 'failed', turnCompletedAt: 100000 },
    { id: 'old-complete', status: 'completed', turnCompletedAt: 100000 },
    { id: 'child-running', status: 'running', notificationEligible: false },
    { id: 'fresh', status: 'completed', turnCompletedAt: 999000 },
    { id: 'unresolved', status: 'unknown' },
  ] });
  const value = runtime.getStatus();
  assert.deepEqual(value.runningTasks, []); assert.deepEqual(value.recentIssueTasks, []);
  assert.deepEqual(value.recentCompletedTasks.map(item => item.id), ['fresh']);
  assert.equal(value.threads.at(-1).status, 'unknown', 'unresolved state must be retained for the idle/unknown distinction');
});

test('a real short task completing between polls notifies once; imported or old-selection starts do not', async t => {
  const f = fixture(t);
  await f.runtime.select(chosen('workbuddy'));
  f.set([task('short', 'completed', { turnStartedAt: 100000, observedStart: true }),
    task('history', 'completed', { observedStart: true }),
    task('old-selection', 'completed', { turnStartedAt: 100000, observedStart: false })]);
  await f.runtime.refresh('workbuddy');
  assert.deepEqual(f.emitted.map(item => item.event.threadId), ['short']);
  await f.runtime.refresh('workbuddy'); assert.equal(f.emitted.length, 1);
});

test('missing configuration and transient read failures retry without requiring a tool switch', async t => {
  let count = 0;
  const runtime = createAICodeRuntime({ intervalMs: 15, retryMs: 20,
    codex: { stop() {} }, connectors: { inspect() {
      count++;
      if (count === 1) return { connection: 'not_connected', monitoringReady: false };
      if (count === 2) throw Error('transient');
      return { connection: 'waiting', monitoringReady: true };
    } },
  });
  t.after(() => runtime.stop()); await runtime.select(chosen('workbuddy'));
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.ok(count >= 3); assert.equal(runtime.getStatus().connection, 'waiting');
  runtime.stop(); const stoppedCount = count;
  await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(count, stoppedCount);
});

test('wake resumes the unchanged Codex selection and discards pre-sleep running counts', async t => {
  let starts = 0;
  let resolveOld;
  const published = [];
  const active = { connection: 'connected', threads: [task('one'), task('two')] };
  const ended = { connection: 'connected', threads: [task('one', 'completed'), task('two', 'completed')] };
  const runtime = createAICodeRuntime({ now: () => 100000,
    codex: { stop() {}, start: async () => { starts++; return starts === 1 ? active : ended; },
      refresh: () => new Promise(resolve => { resolveOld = resolve; }) },
    onStatus: value => published.push(value),
  });
  t.after(() => runtime.stop());
  await runtime.select(chosen('codex'));
  assert.equal(runtime.getStatus().runningTasks.length, 2);
  await runtime.select(chosen('codex'));
  assert.equal(starts, 1, 'an already running selection remains idempotent');
  const oldRead = runtime.refresh('codex');
  runtime.stop();
  assert.equal(published.at(-1).runningTasks.length, 0, 'suspend clears the displayed spinner and count');
  runtime.acceptCodex(active);
  assert.equal(runtime.getStatus().runningTasks.length, 0, 'late push while paused cannot revive tasks');
  await runtime.select(chosen('codex'));
  assert.equal(starts, 2, 'unchanged saved selection must restart monitoring after wake');
  assert.equal(runtime.getStatus().connection, 'connected');
  assert.equal(runtime.getStatus().runningTasks.length, 0);
  resolveOld(active); await oldRead;
  assert.equal(runtime.getStatus().runningTasks.length, 0, 'pre-sleep response cannot overwrite restored completion');
  assert.equal(runtime.getStatus().pendingCompletionTasks.length, 0, 'completed sleep-time history does not reserve a popup count');
  runtime.stop(); await runtime.select(chosen('codex'));
  assert.equal(starts, 3, 'repeated sleep and wake cycles restart each time');
});

test('wake restarts the unchanged hook provider and observes new turns again', async t => {
  const f = fixture(t);
  f.set([task('one')]); await f.runtime.select(chosen('kimi-code'));
  f.runtime.stop();
  f.set([task('one', 'completed')]); await f.runtime.select(chosen('kimi-code'));
  assert.equal(f.runtime.getStatus().connection, 'connected');
  assert.equal(f.runtime.getStatus().runningTasks.length, 0);
  assert.equal(f.emitted.length, 0, 'completion during sleep is history');
  f.set([task('two')]); await f.runtime.refresh('kimi-code');
  f.set([task('two', 'completed')]); await f.runtime.refresh('kimi-code');
  assert.equal(f.emitted.length, 1, 'new work after wake still notifies');
});
