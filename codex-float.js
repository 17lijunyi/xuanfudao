'use strict';

// Protocol and task-state approach adapted from CodexFloat (MIT).
// Copyright (c) 2026 Codex Float contributors. See THIRD_PARTY_NOTICES.md.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const { createTaskCompletionTracker, runningTaskActivities, attentionTaskActivities,
  recentCompletedActivities, recentIssueActivities, createTaskLifecycleState } = require('./codex-task-state');
const { readOwnerStates: readProcessOwnerStates } = require('./codex-process');

const runFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['account/rateLimits/read', 'thread/list']);
const ERRORS = new Set(['cli_not_found', 'connection_failed', 'request_timeout', 'request_failed', 'invalid_response', 'tasks_unavailable', 'stopped']);
const TASK_HISTORY_TOLERANCE_MS = 30000;
const MAX_TASK_THREADS = 32;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const seconds = value => finite(value) !== null && value > 0 && value < 8640000000000 ? value * 1000 : null;
const latestTime = (...values) => {
  const known = values.filter(value => finite(value) !== null && value > 0);
  return known.length ? Math.max(...known) : null;
};
const clean = (value, limit = 160) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, limit) : null;
const failure = code => Object.assign(new Error(code), { code });
const errorCode = error => ERRORS.has(error?.code) ? error.code : 'connection_failed';

function locateCodexExecutable({ home = os.homedir(), env = process.env, access = fs.accessSync, stat = fs.statSync } = {}) {
  const apps = ['/Applications/ChatGPT.app', '/Applications/Codex.app', path.join(home, 'Applications/ChatGPT.app'), path.join(home, 'Applications/Codex.app')];
  const candidates = apps.map(appPath => ({ executable: path.join(appPath, 'Contents/Resources/codex'), appPath }));
  for (const directory of require('./code-tool-paths').binarySearchPaths(home, env)) {
    if (path.isAbsolute(directory)) candidates.push({ executable: path.join(directory, 'codex'), appPath: null });
  }
  for (const candidate of candidates) {
    try {
      access(candidate.executable, fs.constants.X_OK);
      if (stat(candidate.executable).isFile()) return candidate;
    } catch { /* Try the next known installation. */ }
  }
  return null;
}

function createReadonlyAppServerClient({
  locate = locateCodexExecutable, spawnProcess = spawn, home = os.homedir(), version = '1.0.0',
  timeoutMs = 10000, maxLineBytes = 1024 * 1024, maxPending = 4,
  onQuotaUpdate = () => {}, onDisconnect = () => {}, onTaskSignal = () => {},
} = {}) {
  let child = null;
  let connecting = null;
  let ready = false;
  let generation = 0;
  let nextId = 1;
  const pending = new Map();

  function disconnect(code = 'connection_failed', notify = true) {
    generation += 1;
    const old = child;
    child = null;
    ready = false;
    connecting = null;
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(failure(code));
    }
    pending.clear();
    if (old) {
      old.stdout?.removeAllListeners('data');
      old.stdin?.end();
      try { old.kill('SIGTERM'); } catch { /* Already exited. */ }
      const force = setTimeout(() => {
        if (old.exitCode == null && old.signalCode == null) {
          try { old.kill('SIGKILL'); } catch { /* Already exited. */ }
        }
      }, 750);
      force.unref?.();
      old.once('exit', () => clearTimeout(force));
    }
    if (notify) onDisconnect(code);
  }

  function write(message) {
    if (!child || child.stdin.destroyed) throw failure('connection_failed');
    const target = child;
    target.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (error && child === target) disconnect('connection_failed');
    });
  }

  function send(method, params) {
    if (!READ_METHODS.has(method) && method !== 'initialize') return Promise.reject(failure('request_failed'));
    if (pending.size >= maxPending) return Promise.reject(failure('request_failed'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => disconnect('request_timeout'), timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      try { write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch { disconnect('connection_failed'); }
    });
  }

  async function connect() {
    if (ready) return;
    if (connecting) return connecting;
    const attempt = ++generation;
    const job = (async () => {
      const located = await locate();
      if (attempt !== generation) throw failure('stopped');
      if (!located) throw failure('cli_not_found');
      try {
        child = spawnProcess(located.executable, ['app-server', '--listen', 'stdio://'], {
          cwd: home, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch { throw failure('connection_failed'); }
      const processForAttempt = child;
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      child.stdout.on('data', chunk => {
        if (attempt !== generation || child !== processForAttempt) return;
        buffer += decoder.write(chunk);
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line) > maxLineBytes) { disconnect('invalid_response'); return; }
          if (!line.trim()) continue;
          let object;
          try { object = JSON.parse(line); } catch { disconnect('invalid_response'); return; }
          if (!object || typeof object !== 'object' || Array.isArray(object)) { disconnect('invalid_response'); return; }
          // No server request is ever approved. Unexpected requests terminate this read-only session.
          if (object.method && object.id !== undefined) { disconnect('request_failed'); return; }
          if (object.id !== undefined) {
            const request = pending.get(object.id);
            if (!request) continue;
            pending.delete(object.id);
            clearTimeout(request.timeout);
            if (object.error) request.reject(failure('request_failed'));
            else if (!Object.hasOwn(object, 'result')) request.reject(failure('invalid_response'));
            else request.resolve(object.result);
          } else if (object.method === 'account/rateLimits/updated') {
            // Rolling notifications are sparse: refetch instead of erasing known metadata.
            onQuotaUpdate();
          } else if (['thread/status/changed', 'turn/started', 'turn/completed'].includes(object.method)
            && UUID.test(object.params?.threadId)) {
            // The protocol exposes these events, but another app-server process is
            // not guaranteed to broadcast to us. Treat them only as refresh hints.
            onTaskSignal({ threadId: object.params.threadId });
          }
        }
        if (Buffer.byteLength(buffer) > maxLineBytes) disconnect('invalid_response');
      });
      // Drain diagnostics without logging or retaining account data or paths.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { if (child === processForAttempt) disconnect('connection_failed'); });
      child.on('error', () => { if (child === processForAttempt) disconnect('connection_failed'); });
      child.on('exit', () => { if (child === processForAttempt) disconnect('connection_failed'); });
      await send('initialize', { clientInfo: { name: 'fudao_codex_float', title: '悬浮岛', version }, capabilities: { experimentalApi: true } });
      if (attempt !== generation) throw failure('stopped');
      write({ method: 'initialized' });
      ready = true;
    })();
    connecting = job;
    try { await job; }
    catch (error) {
      if (attempt === generation) disconnect(errorCode(error), false);
      throw error;
    } finally { if (connecting === job) connecting = null; }
  }

  return {
    async request(method, params) {
      if (!READ_METHODS.has(method)) throw failure('request_failed');
      await connect();
      return send(method, params);
    },
    stop() { disconnect('stopped', false); },
  };
}

function normalizeQuota(payload) {
  if (!payload || typeof payload !== 'object' || (!payload.rateLimits && !payload.rateLimitsByLimitId)) throw failure('invalid_response');
  const map = payload.rateLimitsByLimitId;
  const candidates = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length
    ? Object.entries(map).slice(0, 16)
    : [[payload.rateLimits?.limitId || 'codex', payload.rateLimits]];
  const buckets = candidates.filter(([, bucket]) => bucket && typeof bucket === 'object' && !Array.isArray(bucket)
    && (['primary', 'secondary'].some(slot => {
      const window = bucket[slot];
      return window && typeof window === 'object' && !Array.isArray(window)
        && Object.hasOwn(window, 'usedPercent') && (window.usedPercent === null || finite(window.usedPercent) !== null);
    }) || (typeof bucket.credits?.hasCredits === 'boolean' && typeof bucket.credits?.unlimited === 'boolean')
      || Boolean(clean(bucket.planType, 40))));
  if (!buckets.length) throw failure('invalid_response');
  const windows = [];
  for (const [key, bucket] of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    const limitId = clean(bucket.limitId || key, 80) || 'codex';
    for (const slot of ['primary', 'secondary']) {
      const window = bucket[slot];
      if (!window || typeof window !== 'object' || Array.isArray(window) || !Object.hasOwn(window, 'usedPercent')
        || (window.usedPercent !== null && finite(window.usedPercent) === null)) continue;
      const raw = finite(window.usedPercent);
      const usedPercent = raw === null ? null : Math.max(0, Math.min(100, raw));
      const duration = finite(window.windowDurationMins);
      const windowDurationMins = duration !== null && duration > 0 ? duration : null;
      const label = windowDurationMins === 300 ? '5 小时' : windowDurationMins === 10080 ? '每周'
        : windowDurationMins === 1440 ? '每日' : windowDurationMins !== null
          ? (windowDurationMins % 60 === 0 ? `${windowDurationMins / 60} 小时` : `${windowDurationMins} 分钟`)
          : (slot === 'primary' ? '主要额度' : '次要额度');
      windows.push({ id: `${limitId}:${slot}`, label, usedPercent,
        remainingPercent: usedPercent === null ? null : 100 - usedPercent,
        windowDurationMins, resetsAt: seconds(window.resetsAt), limitId, planType: clean(bucket.planType, 40) });
    }
  }
  const reset = payload.rateLimitResetCredits;
  const count = finite(reset?.availableCount);
  const credit = (map?.codex || payload.rateLimits)?.credits;
  return {
    windows,
    resets: { available: count !== null && count >= 0 ? Math.floor(count) : null,
      items: Array.isArray(reset?.credits) ? reset.credits.filter(item => item?.status === 'available').slice(0, 20).map(item => ({
        title: clean(item.title, 100), description: clean(item.description, 240), expiresAt: seconds(item.expiresAt),
      })) : [] },
    credits: { balance: clean(credit?.balance, 40),
      hasCredits: typeof credit?.hasCredits === 'boolean' ? credit.hasCredits : null,
      unlimited: typeof credit?.unlimited === 'boolean' ? credit.unlimited : null },
  };
}

function normalizeThreads(payload) {
  if (!Array.isArray(payload?.data)) throw failure('invalid_response');
  const seen = new Set();
  return payload.data.filter(thread => {
    if (!UUID.test(thread?.id) || seen.has(thread.id)) return false;
    seen.add(thread.id);
    return true;
  }).slice(0, MAX_TASK_THREADS).map(thread => {
    const activeFlags = thread.status?.type === 'active' && Array.isArray(thread.status.activeFlags)
      ? thread.status.activeFlags.filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) : [];
    const attentionKind = activeFlags.includes('waitingOnApproval') ? 'permission'
      : activeFlags.includes('waitingOnUserInput') ? 'input' : null;
    const liveStatus = thread.status?.type === 'active' ? (attentionKind ? 'attention' : 'running')
      : ({ idle: 'idle', systemError: 'failed' })[thread.status?.type] || null;
    return {
      id: thread.id, title: clean(thread.name) || '未命名任务',
      projectKey: typeof thread.cwd === 'string' && path.isAbsolute(thread.cwd)
        ? createHash('sha256').update(path.resolve(thread.cwd)).digest('hex') : null,
      status: liveStatus || 'unknown', statusSource: liveStatus ? 'app-server' : null,
      attentionKind,
      statusReason: attentionKind === 'permission' ? 'awaiting_permission'
        : attentionKind === 'input' ? 'awaiting_user_input' : null,
      notificationEligible: ['appServer', 'cli', 'vscode'].includes(thread.source)
        && thread.parentThreadId == null && !/cloud|remote/i.test(thread.threadSource || ''),
      updatedAt: latestTime(seconds(thread.recencyAt), seconds(thread.updatedAt)),
    };
  });
}

function createTaskStateReader({ home = os.homedir(), codexHome = process.env.CODEX_HOME || path.join(home, '.codex'),
  readDirectory = fs.promises.readdir, execute = runFile } = {}) {
  return async function readTaskStates(ids, { signal } = {}) {
    const safeIds = [...new Set(ids.filter(id => UUID.test(id)))].slice(0, MAX_TASK_THREADS);
    if (!safeIds.length) return [];
    let names;
    try { names = await readDirectory(codexHome); } catch { return null; }
    const newest = names.filter(name => /^thread_history_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/(\d+)\.sqlite$/)[1]) - Number(a.match(/(\d+)\.sqlite$/)[1]))[0];
    if (!newest) return null;
    // Only validated UUID literals enter SQL. Read-only mode cannot create or update a database.
    const query = `WITH latest AS (SELECT thread_id, turn_id, status, started_at, completed_at,
      ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS row_number
      FROM thread_turns WHERE thread_id IN (${safeIds.map(id => `'${id}'`).join(',')}))
      SELECT thread_id, turn_id, status, started_at, completed_at FROM latest WHERE row_number = 1;`;
    try {
      const result = await execute('/usr/bin/sqlite3', ['-readonly', '-json', path.join(codexHome, newest), query], {
        timeout: 2000, maxBuffer: 65536, encoding: 'utf8', windowsHide: true, signal,
      });
      const rows = JSON.parse(result.stdout || '[]');
      if (!Array.isArray(rows)) return null;
      return rows.filter(row => safeIds.includes(row?.thread_id)).map(row => ({
        id: row.thread_id, status: ['inProgress', 'completed', 'failed', 'interrupted'].includes(row.status) ? row.status : 'unknown',
        turnId: typeof row.turn_id === 'string' && /^[a-z0-9_.:-]{1,128}$/i.test(row.turn_id) ? row.turn_id : null,
        startedAt: seconds(row.started_at), completedAt: seconds(row.completed_at),
      }));
    } catch { return null; }
  };
}

function mergeTaskStates(threads, states, now) {
  const byId = new Map((Array.isArray(states) ? states : []).map(state => [state.id, state]));
  return threads.map(thread => {
    // A live state belongs to the queried server. Historical states never override it.
    if (thread.statusSource === 'app-server' && ['running', 'attention', 'failed'].includes(thread.status)) {
      return { ...thread, turnId: null, turnStartedAt: null, turnCompletedAt: null, statusRecordedAt: null,
        statusReason: thread.status === 'attention' ? thread.statusReason : null };
    }
    const state = byId.get(thread.id);
    if (!state) return { ...thread, status: 'unknown', statusSource: null, attentionKind: null,
      turnId: null, turnStartedAt: null, turnCompletedAt: null,
      statusRecordedAt: null, statusReason: 'history_unavailable' };
    const turn = { turnId: state.turnId || null, turnStartedAt: state.startedAt || null, turnCompletedAt: state.completedAt || null };
    const recordedAt = latestTime(state.completedAt, state.startedAt);
    const updatedAt = latestTime(thread.updatedAt, recordedAt);
    // thread/list can know about a new turn before the local history index catches up.
    // A previous completion/interruption must not be shown as the current task state.
    if (state.status !== 'inProgress' && (recordedAt === null
      || (thread.updatedAt !== null && thread.updatedAt - recordedAt > TASK_HISTORY_TOLERANCE_MS))) {
      return { ...thread, ...turn, status: 'unknown', attentionKind: null, updatedAt, statusSource: null,
        statusRecordedAt: recordedAt, statusReason: recordedAt === null ? 'history_time_unavailable' : 'history_older_than_task' };
    }
    const status = state.status === 'inProgress'
      ? (state.startedAt !== null && now - state.startedAt >= 0 && now - state.startedAt <= 86400000 ? 'running' : 'unknown')
      : ({ completed: 'completed', failed: 'failed', interrupted: 'interrupted' })[state.status] || 'unknown';
    return { ...thread, ...turn, status, attentionKind: null, updatedAt, statusSource: status === 'unknown' ? null : 'history',
      statusRecordedAt: recordedAt, statusReason: status === 'unknown' ? 'history_state_unconfirmed' : null };
  });
}

function createCodexFloatService({ onUpdate = () => {}, onTaskComplete = () => {}, version = '1.0.0', now = Date.now,
  clientFactory = createReadonlyAppServerClient, readTaskStates = createTaskStateReader(),
  readOwnerStates = readProcessOwnerStates, ownerIntervalMs = 10000, activityCache = null,
  tickMs = 2000, quotaIntervalMs = 30000, retryMs = 10000, ...clientOptions } = {}) {
  let snapshot = { connection: 'loading', updatedAt: null, error: null, windows: [],
    resets: { available: null, items: [] }, threads: [], runningTasks: [], attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [],
    credits: { balance: null, hasCredits: null, unlimited: null } };
  let running = false;
  let generation = 0;
  let timer = null;
  let pushTimer = null;
  let refreshing = null;
  let retryAt = 0;
  let lastQuota = 0;
  let lastTasks = 0;
  let lastStates = 0;
  let stateAbort = null;
  let ownerAbort = null;
  let ownerChecking = null;
  let cacheLoaded = false;
  let lastCache = 0;
  let recoveredTasks = 0;
  let lastOwners = 0;
  let dataRevision = 0;
  const completionTracker = createTaskCompletionTracker({ now });
  const lifecycle = createTaskLifecycleState({ now });
  const copy = () => JSON.parse(JSON.stringify(snapshot));
  const publish = () => {
    snapshot.threads = lifecycle.overlay(snapshot.threads);
    if (activityCache) void activityCache.updateMetadata(snapshot.threads).catch(() => {});
    const connected = snapshot.connection === 'connected' && snapshot.error !== 'tasks_unavailable';
    const events = completionTracker.observe(snapshot.threads, {
      connected, getObservedHookStart: (id, turnId) => lifecycle.getObservedStart(id, turnId),
    });
    snapshot.runningTasks = runningTaskActivities(snapshot.threads, { connected });
    snapshot.attentionTasks = attentionTaskActivities(snapshot.threads, { connected });
    snapshot.recentIssueTasks = recentIssueActivities(snapshot.threads, { now: now() });
    snapshot.recentCompletedTasks = recentCompletedActivities(snapshot.threads, { now: now() });
    // Reserve completion counts before publishing the terminal snapshot, so the
    // island never briefly drops a project while its confirmation is queued.
    for (const event of events) { try { onTaskComplete(event); } catch { /* Notification failures do not stop polling. */ } }
    try { onUpdate(copy()); } catch { /* A closed renderer cannot break polling. */ }
  };
  function scheduleRefreshHint() {
    if (!running || refreshing || pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; refresh(); }, 300);
    pushTimer.unref?.();
  }
  const client = clientFactory({ ...clientOptions, version,
    onQuotaUpdate: scheduleRefreshHint,
    onTaskSignal({ threadId }) {
      if (snapshot.threads.some(thread => thread.id === threadId)) scheduleRefreshHint();
    },
    onDisconnect(code) {
      if (!running) return;
      dataRevision += 1;
      snapshot = { ...snapshot, connection: snapshot.updatedAt === null ? 'unavailable' : 'stale', error: errorCode({ code }),
        threads: snapshot.threads.map(thread => ({ ...thread, status: 'unknown', attentionKind: null,
          statusReason: 'connection_unavailable' })) };
      retryAt = now() + retryMs;
      publish();
    },
  });

  async function statesFor(threads) {
    stateAbort?.abort();
    stateAbort = new AbortController();
    let states;
    try { states = await readTaskStates(threads.map(thread => thread.id), { signal: stateAbort.signal }); }
    catch { states = null; }
    return mergeTaskStates(threads, states, now());
  }

  async function restoreSavedActivities() {
    if (!activityCache) return;
    const attempt = generation;
    const initial = !cacheLoaded;
    lastCache = now();
    let saved;
    try { saved = activityCache.read(); } catch (_) { return; }
    const active = saved.filter(item => ['running', 'attention', 'stopping'].includes(item.event.kind));
    const owners = active.filter(item => item.event.ownerPid)
      .map(item => ({ pid: item.event.ownerPid, startedAt: item.event.ownerStartedAt }));
    ownerAbort = new AbortController();
    const signal = ownerAbort.signal;
    let results = [];
    try { if (owners.length) results = await readOwnerStates(owners, { signal }); } catch (_) {}
    if (!running || attempt !== generation || signal.aborted) return;
    const status = item => results.find(owner => owner.pid === item.event.ownerPid && owner.startedAt === item.event.ownerStartedAt)?.alive;
    const confirmed = saved.filter(item => !active.includes(item) || status(item) === true);
    const restored = lifecycle.restore(confirmed, { initial });
    if (initial) recoveredTasks = Math.min(restored, confirmed.filter(item => ['running', 'attention'].includes(item.event.kind)).length);
    lifecycle.reconcileOwners(results);
    snapshot.taskActivityKnown = saved.length > 0 && active.every(item => typeof status(item) === 'boolean');
    cacheLoaded = true;
  }

  async function checkOwners() {
    if (!running || ownerChecking) return ownerChecking;
    const identities = lifecycle.ownerIdentities();
    lastOwners = now();
    if (!identities.length) return;
    const attempt = generation;
    ownerAbort = new AbortController();
    const signal = ownerAbort.signal;
    const job = (async () => {
      let results;
      try { results = await readOwnerStates(identities, { signal }); }
      catch { return; } // A failed check is not evidence that the source exited.
      if (!running || attempt !== generation || signal.aborted) return;
      if (lifecycle.reconcileOwners(results)) publish();
    })();
    ownerChecking = job;
    try { await job; }
    finally { if (ownerChecking === job) ownerChecking = null; }
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(async () => {
      timer = null;
      const stamp = now();
      if (activityCache && stamp - lastCache >= ownerIntervalMs) { await restoreSavedActivities(); if (running) publish(); }
      // Source liveness is independent of quota RPC connectivity and chat activity.
      if (stamp - lastOwners >= ownerIntervalMs) await checkOwners();
      if (!running) return;
      if (!refreshing && stamp >= retryAt) {
        if (snapshot.connection !== 'connected' || stamp - lastQuota >= quotaIntervalMs) await refresh();
        else {
          const isActive = snapshot.threads.some(thread => ['running', 'attention'].includes(thread.status));
          if (stamp - lastTasks >= (isActive ? 10000 : 15000)) await updateTasks();
          else if (isActive && stamp - lastStates >= 2000) await updateStates();
        }
      }
      schedule();
    }, tickMs);
    timer.unref?.();
  }

  async function updateStates() {
    const attempt = generation;
    const revision = ++dataRevision;
    const threads = await statesFor(snapshot.threads);
    if (!running || attempt !== generation || revision !== dataRevision) return;
    snapshot = { ...snapshot, threads };
    lastStates = now();
    publish();
  }

  async function updateTasks() {
    const attempt = generation;
    const revision = ++dataRevision;
    try {
      const tasks = normalizeThreads(await client.request('thread/list', threadParams()));
      if (!running || attempt !== generation || revision !== dataRevision) return;
      const threads = await statesFor(tasks);
      if (!running || attempt !== generation || revision !== dataRevision) return;
      snapshot = { ...snapshot, threads, error: snapshot.error === 'tasks_unavailable' ? null : snapshot.error };
      lastTasks = lastStates = now();
      publish();
    } catch {
      if (!running || attempt !== generation || revision !== dataRevision) return;
      snapshot = { ...snapshot, threads: snapshot.threads.map(thread => ({ ...thread, status: 'unknown', attentionKind: null,
        statusReason: 'tasks_unavailable' })), error: 'tasks_unavailable' };
      lastTasks = now();
      publish();
    }
  }

  function threadParams() {
    return { limit: MAX_TASK_THREADS, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['appServer', 'cli', 'vscode'], archived: false, useStateDbOnly: true };
  }

  async function refresh() {
    if (refreshing) return refreshing;
    if (!running) { running = true; generation += 1; }
    const attempt = generation;
    const revision = ++dataRevision;
    const job = (async () => {
      if (activityCache && !cacheLoaded) await restoreSavedActivities();
      if (!running || attempt !== generation || revision !== dataRevision) return copy();
      try {
        const results = await Promise.allSettled([
          client.request('account/rateLimits/read'), client.request('thread/list', threadParams()),
        ]);
        if (!running || attempt !== generation || revision !== dataRevision) return copy();
        const quotaResult = results[0];
        if (quotaResult.status === 'rejected') throw quotaResult.reason;
        const quota = normalizeQuota(quotaResult.value);
        let threads = snapshot.threads;
        let taskError = null;
        try {
          if (results[1].status === 'rejected') throw results[1].reason;
          threads = await statesFor(normalizeThreads(results[1].value));
          lastTasks = lastStates = now();
        } catch {
          taskError = 'tasks_unavailable';
          threads = threads.map(thread => ({ ...thread, status: 'unknown', attentionKind: null,
            statusReason: 'tasks_unavailable' }));
        }
        if (!running || attempt !== generation || revision !== dataRevision) return copy();
        snapshot = { ...quota, threads, ...(activityCache ? { taskActivityKnown: snapshot.taskActivityKnown === true } : {}), connection: 'connected', updatedAt: now(), error: taskError };
        lastQuota = now();
        retryAt = 0;
      } catch (error) {
        if (!running || attempt !== generation || revision !== dataRevision) return copy();
        snapshot = { ...snapshot, connection: snapshot.updatedAt === null ? 'unavailable' : 'stale', error: errorCode(error),
          threads: snapshot.threads.map(thread => ({ ...thread, status: 'unknown', attentionKind: null,
            statusReason: 'connection_unavailable' })) };
        retryAt = now() + retryMs;
        client.stop();
      }
      publish();
      return copy();
    })();
    refreshing = job;
    try { return await job; }
    finally { if (refreshing === job) { refreshing = null; schedule(); } }
  }

  return {
    start: refresh, refresh, getSnapshot: copy,
    // Local health checks expose counts only, never titles, identifiers or account data.
    getDiagnostics() {
      const taskCounts = { running: 0, attention: 0, completed: 0, interrupted: 0, failed: 0, idle: 0, unknown: 0 };
      const taskSources = { hook: 0, history: 0, 'app-server': 0, unknown: 0 };
      for (const thread of snapshot.threads) {
        const confirmed = (snapshot.connection === 'connected' && snapshot.error !== 'tasks_unavailable') || thread.statusSource === 'hook';
        taskCounts[confirmed && Object.hasOwn(taskCounts, thread.status) ? thread.status : 'unknown']++;
        taskSources[confirmed && Object.hasOwn(taskSources, thread.statusSource) ? thread.statusSource : 'unknown']++;
      }
      return { connection: snapshot.connection, error: snapshot.error, taskCounts, taskSources, ...(activityCache ? { recoveredTasks } : {}) };
    },
    // The main-process HTTP boundary must authenticate the bearer token before calling this.
    ingestTaskEvent(payload) {
      if (!running) return { ok: false, error: 'service_stopped' };
      const existing = snapshot.threads.find(thread => thread.id === payload?.threadId);
      if (existing && !existing.notificationEligible) return { ok: false, error: 'ineligible_thread' };
      const result = lifecycle.ingest(payload);
      if (!result.ok || result.ignored) return result;
      if (activityCache) {
        snapshot.taskActivityKnown = true;
        void activityCache.record(payload, existing).catch(() => {});
      }
      if (existing) publish();
      else scheduleRefreshHint();
      return { ok: true, pendingMetadata: !existing };
    },
    hasThread(id) { return typeof id === 'string' && UUID.test(id) && snapshot.threads.some(thread => thread.id === id); },
    clearTaskCache() { return activityCache?.clear(); },
    stop() {
      running = false;
      completionTracker.reset();
      lifecycle.clear();
      cacheLoaded = false;
      lastCache = 0;
      generation += 1;
      refreshing = null;
      clearTimeout(timer);
      clearTimeout(pushTimer);
      timer = pushTimer = null;
      stateAbort?.abort();
      ownerAbort?.abort();
      ownerChecking = null;
      lastOwners = 0;
      client.stop();
    },
  };
}

module.exports = { createCodexFloatService, createReadonlyAppServerClient, locateCodexExecutable,
  normalizeQuota, normalizeThreads, createTaskStateReader, mergeTaskStates };
