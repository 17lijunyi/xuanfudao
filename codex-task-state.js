'use strict';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TURN_ID = /^[a-z0-9_.:-]{1,128}$/i;
const validTime = value => Number.isFinite(value) && value > 0;
const MAX_LIFECYCLE_RECORDS = 32;
const RECENT_TERMINAL_TTL_MS = 5 * 60 * 1000;
const OWNER_START = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/;
const ACTIVE_KINDS = new Set(['running', 'attention', 'stopping']);
const TERMINAL_KINDS = new Set(['completed', 'interrupted', 'failed']);
const ATTENTION_KINDS = new Set(['permission', 'input']);
const isActiveRecord = record => ACTIVE_KINDS.has(record?.kind);

// Only transitions observed in this monitoring session can produce a completion.
// Absence, disconnection or an unconfirmed state breaks that evidence chain.
function createTaskCompletionTracker({ now = Date.now } = {}) {
  const armed = new Map();
  const delivered = new Set();
  return {
    reset() { armed.clear(); },
    observe(threads, { connected = true, getObservedHookStart = () => null } = {}) {
      const stamp = now();
      const present = new Set();
      const events = [];
      // lifecycle.overlay can contain the 32 current list rows plus 32 retained
      // authenticated activities. Scan that complete bounded set so tasks pushed
      // out of the recent list never lose their completion evidence.
      for (const thread of threads.slice(0, MAX_LIFECYCLE_RECORDS * 2)) {
        if (!UUID.test(thread.id)) continue;
        present.add(thread.id);
        let prior = armed.get(thread.id);
        const eligible = thread.notificationEligible === true && ['history', 'hook'].includes(thread.statusSource)
          && (connected || thread.statusSource === 'hook')
          && TURN_ID.test(thread.turnId || '') && validTime(thread.turnStartedAt)
          && thread.turnStartedAt <= stamp
          && (thread.statusSource === 'hook' || stamp - thread.turnStartedAt <= 86400000);
        if (!eligible) { armed.delete(thread.id); continue; }
        // A new task can finish before thread/list supplies its metadata. Use
        // only the authenticated start retained for this exact turn, after
        // metadata has established local parent-task eligibility.
        if (!prior && thread.statusSource === 'hook') {
          const startedAt = getObservedHookStart(thread.id, thread.turnId);
          if (validTime(startedAt) && startedAt === thread.turnStartedAt) {
            prior = { turnId: thread.turnId, startedAt, observedAt: startedAt };
          }
        }
        const key = `${thread.id}:${thread.turnId}`;
        if (thread.status === 'unknown' && thread.statusSource === 'hook' && thread.statusReason === 'awaiting_completion'
          && prior?.turnId === thread.turnId) continue;
        // Waiting for the user is still the same live turn. Keep its completion
        // evidence armed while the spinner is replaced by an attention state.
        if (thread.status === 'running' || thread.status === 'attention') {
          if (!delivered.has(key)) armed.set(thread.id, {
            turnId: thread.turnId, startedAt: thread.turnStartedAt,
            observedAt: prior?.turnId === thread.turnId ? prior.observedAt : stamp,
          });
          continue;
        }
        armed.delete(thread.id);
        if (thread.status !== 'completed' || !prior || prior.turnId !== thread.turnId
          || prior.startedAt !== thread.turnStartedAt || delivered.has(key)
          || !validTime(thread.turnCompletedAt) || thread.turnCompletedAt < prior.startedAt
          || thread.turnCompletedAt < prior.observedAt - 1000
          || thread.turnCompletedAt > stamp + 1000 || stamp - thread.turnCompletedAt > 60000) continue;
        delivered.add(key);
        while (delivered.size > 512) delivered.delete(delivered.values().next().value);
        events.push({ id: `codex:${key}`, threadId: thread.id, turnId: thread.turnId,
          title: thread.title, projectKey: thread.projectKey || null, completedAt: thread.turnCompletedAt });
      }
      for (const id of armed.keys()) if (!present.has(id)) armed.delete(id);
      return events;
    },
  };
}

function validateTaskEvent(payload, now = Date.now()) {
  const keys = ['version', 'kind', 'threadId', 'turnId', 'at', 'source', 'parentThreadId', 'agentId'];
  const ownerKeys = ['ownerPid', 'ownerStartedAt'];
  const optionalKeys = ['attentionKind', ...ownerKeys];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !keys.includes(key) && !optionalKeys.includes(key)) || payload.version !== 1
    || !['running', 'attention', 'stopping', 'interrupted', 'completed'].includes(payload.kind)
    || typeof payload.threadId !== 'string' || !UUID.test(payload.threadId)
    || typeof payload.turnId !== 'string' || !TURN_ID.test(payload.turnId)
    || !Number.isSafeInteger(payload.at) || payload.at <= 0 || now - payload.at > 60000 || payload.at - now > 5000
    || payload.source !== 'local' || payload.parentThreadId !== null || payload.agentId !== null) return null;
  const hasAttention = Object.hasOwn(payload, 'attentionKind');
  if ((payload.kind === 'attention' && (!hasAttention || !ATTENTION_KINDS.has(payload.attentionKind)))
    || (payload.kind !== 'attention' && hasAttention)) return null;
  const hasOwner = ownerKeys.some(key => Object.hasOwn(payload, key));
  if (hasOwner && (!Number.isSafeInteger(payload.ownerPid) || payload.ownerPid <= 1 || payload.ownerPid > 2147483647
    || typeof payload.ownerStartedAt !== 'string' || payload.ownerStartedAt.length > 40 || !OWNER_START.test(payload.ownerStartedAt))) return null;
  return Object.fromEntries([...keys, ...(hasAttention ? ['attentionKind'] : []), ...(hasOwner ? ownerKeys : [])]
    .map(key => [key, payload[key]]));
}

function createTaskLifecycleState({ now = Date.now } = {}) {
  const records = new Map();
  // Only metadata already confirmed by thread/list is retained. A hook alone
  // never invents a visible task or grants eligibility to a child/cloud thread.
  const retainedMetadata = new Map();
  return {
    clear() { records.clear(); retainedMetadata.clear(); },
    restore(entries, { initial = false } = {}) {
      let restored = 0;
      for (const saved of (entries || []).slice(0, MAX_LIFECYCLE_RECORDS)) {
        const event = validateTaskEvent(saved.event, saved.event?.at);
        if (!event || event.at > now() + 5000
          || isActiveRecord(event) && (!validTime(saved.startedAt) || saved.startedAt > event.at || !event.ownerPid)) continue;
        const current = records.get(event.threadId);
        if (current && current.at >= event.at) continue;
        records.set(event.threadId, { ...event, startedAt: initial && !isActiveRecord(event) ? null : saved.startedAt });
        if (saved.metadata?.id === event.threadId && saved.metadata.notificationEligible === true) {
          retainedMetadata.set(event.threadId, { ...saved.metadata });
        }
        restored++;
      }
      return restored;
    },
    getObservedStart(threadId, turnId) {
      const record = records.get(threadId);
      return record?.turnId === turnId && validTime(record.startedAt) ? record.startedAt : null;
    },
    ingest(payload) {
      const event = validateTaskEvent(payload, now());
      if (!event) return { ok: false, error: 'invalid_event' };
      const previous = records.get(event.threadId);
      if (previous && (event.at < previous.at
        || (previous.turnId !== event.turnId && !['running', 'attention'].includes(event.kind))
        || (previous.turnId === event.turnId && TERMINAL_KINDS.has(previous.kind))
        || (previous.turnId === event.turnId && previous.at === event.at && previous.kind === event.kind
          && previous.attentionKind === event.attentionKind))) {
        return { ok: true, ignored: true };
      }
      if (!previous && records.size >= MAX_LIFECYCLE_RECORDS) {
        const evictable = [...records].find(([id, record]) => !isActiveRecord(record) || !retainedMetadata.has(id));
        if (!evictable) return { ok: false, error: 'activity_capacity_reached' };
        records.delete(evictable[0]);
        retainedMetadata.delete(evictable[0]);
      }
      const sameTurn = previous?.turnId === event.turnId;
      const owner = sameTurn && previous.ownerPid && !event.ownerPid
        ? { ownerPid: previous.ownerPid, ownerStartedAt: previous.ownerStartedAt } : {};
      records.set(event.threadId, { ...event, ...owner,
        startedAt: sameTurn && validTime(previous.startedAt) ? previous.startedAt
          : ['running', 'attention'].includes(event.kind) ? event.at : null });
      return { ok: true };
    },
    ownerIdentities() {
      const owners = new Map();
      for (const record of records.values()) {
        if (isActiveRecord(record) && record.ownerPid) {
          const owner = { pid: record.ownerPid, startedAt: record.ownerStartedAt };
          owners.set(`${owner.pid}:${owner.startedAt}`, owner);
        }
      }
      return [...owners.values()];
    },
    reconcileOwners(results) {
      const exited = new Set((Array.isArray(results) ? results : [])
        .filter(result => result?.alive === false).map(result => `${result.pid}:${result.startedAt}`));
      let changed = false;
      for (const [id, record] of records) {
        if (!isActiveRecord(record) || !exited.has(`${record.ownerPid}:${record.ownerStartedAt}`)) continue;
        records.set(id, { ...record, kind: 'unknown', attentionKind: null,
          startedAt: null, reason: 'source_process_exited' });
        changed = true;
      }
      return changed;
    },
    overlay(threads) {
      const stamp = now();
      for (const [id, record] of records) {
        if (TERMINAL_KINDS.has(record.kind) && stamp - record.at > RECENT_TERMINAL_TTL_MS) {
          records.delete(id);
          retainedMetadata.delete(id);
        }
      }
      const present = new Set(threads.map(thread => thread.id));
      const combined = [...threads, ...[...retainedMetadata.values()].filter(thread => !present.has(thread.id))];
      return combined.map(thread => {
        let record = records.get(thread.id);
        if (!record || !thread.notificationEligible) {
          retainedMetadata.delete(thread.id);
          return thread;
        }
        const indexedTurn = ['history', 'app-server'].includes(thread.statusSource) && TURN_ID.test(thread.turnId || '');
        if (indexedTurn) {
          if (thread.turnId !== record.turnId && validTime(thread.turnStartedAt)
            && thread.turnStartedAt > (validTime(record.startedAt) ? record.startedAt : record.at)
            && thread.turnStartedAt >= record.at - 1000) {
            // Explicit newer-turn metadata supersedes the old hook. Recency or
            // idle status alone never provides this evidence.
            records.delete(thread.id);
            retainedMetadata.delete(thread.id);
            return thread;
          }
          if (isActiveRecord(record) && thread.turnId === record.turnId && ['completed', 'interrupted', 'failed'].includes(thread.status)
            && validTime(thread.turnCompletedAt) && thread.turnCompletedAt >= record.startedAt
            && thread.turnCompletedAt >= record.at - 1000) {
            // Preserve the observed hook start, including its millisecond
            // precision, when the same turn's terminal index catches up.
            record = { ...record, kind: thread.status, attentionKind: null, at: thread.turnCompletedAt };
            records.set(thread.id, record);
          }
        }
        if (isActiveRecord(record) || TERMINAL_KINDS.has(record.kind)) retainedMetadata.set(thread.id, { ...thread });
        else retainedMetadata.delete(thread.id);
        // Confirmed terminal results persist until a later turn or newer metadata.
        if (TERMINAL_KINDS.has(record.kind) && thread.updatedAt > record.at + 30000) {
          records.delete(thread.id);
          retainedMetadata.delete(thread.id);
          return thread;
        }
        const status = record.kind === 'stopping' ? 'unknown' : record.kind;
        const attentionKind = status === 'attention' && ATTENTION_KINDS.has(record.attentionKind)
          ? record.attentionKind : null;
        return { ...thread, status, statusSource: 'hook', turnId: record.turnId,
          turnStartedAt: record.startedAt, turnCompletedAt: ['completed', 'interrupted', 'failed'].includes(record.kind) ? record.at : null,
          statusRecordedAt: record.at, updatedAt: Math.max(thread.updatedAt || 0, record.at),
          attentionKind,
          statusReason: record.reason || (record.kind === 'stopping' ? 'awaiting_completion'
            : attentionKind === 'permission' ? 'awaiting_permission'
              : attentionKind === 'input' ? 'awaiting_user_input' : null) };
      });
    },
  };
}

function runningTaskActivities(threads, { connected = true } = {}) {
  return threads.filter(thread => thread.notificationEligible && thread.status === 'running'
    && (connected || thread.statusSource === 'hook')).slice(0, MAX_LIFECYCLE_RECORDS)
    .map(thread => ({ id: thread.id, title: thread.title, turnId: thread.turnId || null,
      status: 'running', progressMode: 'indeterminate' }));
}

function attentionTaskActivities(threads, { connected = true } = {}) {
  return threads.filter(thread => thread.notificationEligible && thread.status === 'attention'
    && ATTENTION_KINDS.has(thread.attentionKind)
    && (connected || thread.statusSource === 'hook')).slice(0, MAX_LIFECYCLE_RECORDS)
    .map(thread => ({ id: thread.id, title: thread.title, turnId: thread.turnId || null,
      status: 'attention', attentionKind: thread.attentionKind }));
}

function recentCompletedActivities(threads, { now = Date.now(), maxAgeMs = RECENT_TERMINAL_TTL_MS } = {}) {
  const seen = new Set();
  return threads.filter(thread => {
    const completedAt = thread.turnCompletedAt || thread.statusRecordedAt;
    const key = `${thread.id}:${thread.turnId || completedAt || 'unknown'}`;
    if (!thread.notificationEligible || thread.status !== 'completed' || !validTime(completedAt)
      || completedAt > now + 1000 || now - completedAt > maxAgeMs || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (right.turnCompletedAt || right.statusRecordedAt)
    - (left.turnCompletedAt || left.statusRecordedAt)).slice(0, 8)
    .map(thread => ({ id: thread.id, title: thread.title, turnId: thread.turnId || null,
      status: 'completed', completedAt: thread.turnCompletedAt || thread.statusRecordedAt }));
}

function recentIssueActivities(threads, { now = Date.now(), maxAgeMs = RECENT_TERMINAL_TTL_MS } = {}) {
  const seen = new Set();
  return threads.filter(thread => {
    const recordedAt = thread.turnCompletedAt || thread.statusRecordedAt;
    const key = `${thread.id}:${thread.turnId || recordedAt || 'unknown'}`;
    if (!thread.notificationEligible || !['failed', 'interrupted'].includes(thread.status)
      || !validTime(recordedAt) || recordedAt > now + 1000 || now - recordedAt > maxAgeMs || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (right.turnCompletedAt || right.statusRecordedAt)
    - (left.turnCompletedAt || left.statusRecordedAt)).slice(0, 8)
    .map(thread => ({ id: thread.id, title: thread.title, turnId: thread.turnId || null,
      status: thread.status, recordedAt: thread.turnCompletedAt || thread.statusRecordedAt }));
}

module.exports = { createTaskCompletionTracker, runningTaskActivities, attentionTaskActivities,
  recentCompletedActivities, recentIssueActivities, validateTaskEvent, createTaskLifecycleState };
