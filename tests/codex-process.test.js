'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findCodexOwner, readOwnerStates } = require('../codex-process');
const { projectHookEvent } = require('../scripts/fudao-codex-hook');
const START = 'Fri Sep 4 13:34:24 2026';
const line = (pid, parent, comm = '/Applications/ChatGPT.app/Contents/Resources/codex', start = START) => `${pid} ${parent} ${start} ${comm}\n`;

test('hook uses official session identity instead of an inherited parent environment', () => {
  const id = '0198aaaa-0000-7000-8000-111111111111';
  const event = projectHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: id, turn_id: 'long-task' },
    { now: 100000, env: { CODEX_THREAD_ID: '0198aaaa-0000-7000-8000-222222222222' } });
  assert.equal(event.threadId, id);
});

test('owner lookup walks only its parent chain and ignores similarly named helpers', () => {
  const requested = [];
  const rows = { 102: line(102, 101, '/bin/sh'), 101: line(101, 100, '/tmp/codex-code-mode-host'), 100: line(100, 99) };
  assert.deepEqual(findCodexOwner({ parentPid: 102, platform: 'darwin', execute(file, args) {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args.slice(2), ['-o', 'pid=,ppid=,lstart=,comm=']);
    requested.push(Number(args[1])); return rows[args[1]];
  } }), { ownerPid: 100, ownerStartedAt: START });
  assert.deepEqual(requested, [102, 101, 100]);
  assert.equal(findCodexOwner({ parentPid: 102, platform: 'darwin', execute() { throw Error('denied'); } }), null);
});

test('owner liveness distinguishes same process, PID reuse, exit and uncertain reads', async () => {
  const identities = [100, 101, 102].map(pid => ({ pid, startedAt: START }));
  const result = await readOwnerStates(identities, { platform: 'darwin', execute: async () => ({
    stdout: line(100, 99) + line(101, 99, '/usr/local/bin/codex', 'Fri Sep 4 14:00:00 2026'),
  }) });
  assert.deepEqual(result.map(row => row.alive), [true, false, false]);
  for (const error of [Object.assign(Error('denied'), { code: 1, stderr: 'Operation not permitted' }), Error('timeout')]) {
    assert.equal((await readOwnerStates([identities[0]], { platform: 'darwin', execute: async () => { throw error; } }))[0].alive, null);
  }
  assert.equal((await readOwnerStates([identities[0]], { platform: 'darwin', execute: async () => {
    throw Object.assign(Error('missing'), { code: 1, stdout: '', stderr: '' });
  } }))[0].alive, false);
  assert.equal((await readOwnerStates([identities[0]], { platform: 'darwin', execute: async () => ({ stdout: 'malformed' }) }))[0].alive, null);
});

test('invalid process identities never reach ps and aborted reads cannot clear running state', async () => {
  let called = false;
  assert.deepEqual(await readOwnerStates([{ pid: '100;bad', startedAt: START }], { execute: async () => { called = true; } }), []);
  const abort = new AbortController(); abort.abort();
  const result = await readOwnerStates([{ pid: 100, startedAt: START }], { signal: abort.signal, platform: 'darwin', execute: async () => { called = true; } });
  assert.equal(result[0].alive, null); assert.equal(called, false);
});
