'use strict';

const { CATALOG } = require('./ai-tools');
const EMPTY = Object.freeze({ windows: [], threads: [], runningTasks: [], attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [], pendingCompletionTasks: [] });
const emptyStatus = (providerId = null, selectionRevision = 0, connection = 'unselected') => ({
  ...EMPTY, providerId, selectionRevision, connection, updatedAt: null, error: null,
});
function fillProjections(snapshot, value, stamp = Date.now()) {
  for (const [key, states] of Object.entries({ runningTasks: ['running'], attentionTasks: ['attention'],
    recentIssueTasks: ['failed', 'interrupted'], recentCompletedTasks: ['completed'] })) {
    if (!Array.isArray(value[key])) snapshot[key] = (value.threads || []).filter((item) => {
      if (!states.includes(item.status) || item.notificationEligible === false
        || (value.connection !== 'connected' && item.statusSource !== 'hook')) return false;
      if (!key.startsWith('recent')) return true;
      const terminalAt = item.turnCompletedAt || item.statusRecordedAt || item.updatedAt;
      return Number.isFinite(terminalAt) && terminalAt > 0
        && terminalAt <= stamp + 1000 && stamp - terminalAt <= 300000;
    });
  }
}

// Only a persisted, explicitly confirmed selection may reach a connector.
// Generation checks discard requests and events that finish after a switch.
function createAICodeRuntime({ codex, connectors, onStatus = () => {}, onTaskComplete = () => {}, intervalMs = 2000, retryMs = 10000, now = Date.now } = {}) {
  let selected = null;
  let monitoring = false;
  let revision = 0;
  let generation = 0;
  let timer = null;
  let snapshot = emptyStatus();
  let observingSince = now();
  const pendingCompletions = new Map();
  const armed = new Map();
  const delivered = new Set();
  const copy = () => JSON.parse(JSON.stringify({ ...snapshot, pendingCompletionTasks: [...pendingCompletions.values()] }));
  function publish() { onStatus(copy()); return copy(); }
  function stop() {
    monitoring = false;
    generation++; clearTimeout(timer); timer = null;
    pendingCompletions.clear(); armed.clear();
    codex.stop();
    snapshot = emptyStatus(selected, revision, selected ? 'stale' : 'unselected');
    publish();
  }
  function holdCompletion(id, task) {
    if (!monitoring || id !== selected || !task?.id || !task.threadId) return false;
    pendingCompletions.set(task.id, { eventId: task.id, id: task.threadId, turnId: task.turnId || '',
      title: task.title || '未命名项目', projectKey: task.projectKey || null, providerId: id });
    return true;
  }
  function finishCompletion(eventId) {
    if (!pendingCompletions.delete(eventId)) return false;
    publish(); return true;
  }
  function observeHookCompletions(id, threads) {
    const present = new Set();
    for (const task of threads) {
      if (typeof task?.id !== 'string') continue;
      present.add(task.id);
      const previous = armed.get(task.id);
      const valid = task.statusSource === 'hook' && typeof task.turnId === 'string' && task.turnId
        && Number.isFinite(task.turnStartedAt) && task.turnStartedAt > 0 && task.turnStartedAt <= now();
      if (!valid) { armed.delete(task.id); continue; }
      const key = `${id}:${task.id}:${task.turnId}`;
      if (['running', 'attention'].includes(task.status)) {
        if (!delivered.has(key)) armed.set(task.id, task);
        continue;
      }
      armed.delete(task.id);
      const completedAt = task.turnCompletedAt;
      // A short turn can start and finish between two polls. Its persisted start
      // must belong to this observation period; imported history never qualifies.
      const observed = previous ? previous.turnId === task.turnId && previous.turnStartedAt === task.turnStartedAt
        : task.observedStart === true && task.turnStartedAt >= observingSince;
      if (task.status !== 'completed' || !observed || delivered.has(key)
        || !Number.isFinite(completedAt) || completedAt < task.turnStartedAt
        || completedAt > now() + 1000 || now() - completedAt > 60000) continue;
      delivered.add(key);
      while (delivered.size > 512) delivered.delete(delivered.values().next().value);
      try { onTaskComplete(id, { id: key, threadId: task.id, turnId: task.turnId,
        title: task.title, projectKey: task.projectKey || previous?.projectKey || null, completedAt }); }
      catch (_) { /* Notification delivery cannot invalidate the status read. */ }
    }
    for (const id of armed.keys()) if (!present.has(id)) armed.delete(id);
  }
  async function scan(token) {
    const id = selected;
    if (!id || token !== generation) return copy();
    if (id === 'codex') {
      const result = await codex.start();
      if (token === generation) acceptCodex(result);
      return copy();
    }
    try {
      const result = await connectors.inspect(id);
      if (token !== generation) return copy();
      snapshot = { ...emptyStatus(id, revision), ...result, providerId: id, selectionRevision: revision };
      fillProjections(snapshot, result, now());
      // This is a new, observed parent-task completion, not imported history.
      observeHookCompletions(id, [...new Map([
        ...snapshot.threads, ...snapshot.runningTasks, ...snapshot.attentionTasks,
        ...snapshot.recentCompletedTasks, ...snapshot.recentIssueTasks,
      ].map((task) => [task.id, task])).values()]);
    } catch (_) {
      if (token !== generation) return copy();
      armed.clear();
      snapshot = { ...emptyStatus(id, revision, 'unavailable'), error: 'read_failed' };
    }
    publish();
    if (token === generation && CATALOG.find(tool => tool.id === id)?.monitoring === 'hooks') {
      // Recheck missing installs/configs and transient failures, too. Otherwise a
      // tool installed or approved after the first scan remains disconnected.
      timer = setTimeout(() => { void scan(token); }, snapshot.monitoringReady ? intervalMs : Math.max(intervalMs, retryMs));
      timer.unref?.();
    }
    return copy();
  }
  async function select(model) {
    const next = model?.state?.confirmed === true && CATALOG.some(tool => tool.id === model.state.selected)
      ? model.state.selected : null;
    if (monitoring && next && next === selected && model.revision === revision) return copy();
    const leavingCodex = selected === 'codex' && (model?.state?.confirmed !== true || model.state.selected !== 'codex');
    stop(); revision = model?.revision || 0;
    selected = next; observingSince = now();
    monitoring = Boolean(selected);
    snapshot = emptyStatus(selected, revision, selected ? 'loading' : 'unselected');
    publish();
    if (leavingCodex) await codex.clearTaskCache?.();
    if (selected) return scan(generation);
    return copy();
  }
  function acceptCodex(value) {
    if (!monitoring || selected !== 'codex' || !value) return;
    snapshot = { ...emptyStatus('codex', revision), ...value, providerId: 'codex', selectionRevision: revision };
    // Older Codex readers expose threads without the newer activity projections.
    fillProjections(snapshot, value, now());
    publish();
  }
  async function refresh(id) {
    if (!selected || selected !== id) return { ok: false, error: 'confirmation_required' };
    monitoring = true;
    clearTimeout(timer); timer = null;
    if (id === 'codex') {
      const token = generation;
      const value = await codex.refresh();
      if (token === generation) acceptCodex(value);
      return copy();
    }
    // A new scan invalidates a previous scan without touching other tools.
    return scan(++generation);
  }
  async function connect(id) {
    if (!selected || id !== selected) return { ok: false, error: 'confirmation_required' };
    if (CATALOG.find((tool) => tool.id === id)?.monitoring !== 'hooks') return { ok: false, error: 'unsupported' };
    // Config writes are synchronous and only happen on the user's Connect click.
    const result = connectors.connect(id);
    if (!result.ok) return result;
    await refresh(id);
    return { ok: true };
  }
  return { select, stop, refresh, connect, acceptCodex, holdCompletion, finishCompletion, getStatus: copy,
    isSelected: (id) => id === selected && selected !== null };
}

module.exports = { createAICodeRuntime, emptyStatus };
