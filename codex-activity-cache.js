'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateTaskEvent } = require('./codex-task-state');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(['running', 'attention', 'stopping']);

function safeMetadata(value, id) {
  if (value?.id !== id || value.notificationEligible !== true || typeof value.title !== 'string') return null;
  return { id, title: value.title.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 140), notificationEligible: true,
    projectKey: /^[a-f0-9]{64}$/.test(value.projectKey || '') ? value.projectKey : null,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null, status: 'unknown' };
}

// Only reduced, already-authenticated lifecycle metadata is durable. Hooks also
// update this cache while the island is closed, so missed terminal events cannot
// revive a completed turn when its long-lived Codex process still exists.
function createCodexActivityCache({ directory, isEnabled = () => true, now = Date.now } = {}) {
  if (!path.isAbsolute(directory || '')) throw Error('absolute_cache_path_required');
  const pending = new Set();
  const owner = stat => !process.getuid || stat.uid === process.getuid();
  function ensure() {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      return stat.isDirectory() && !stat.isSymbolicLink() && owner(stat) && (stat.mode & 0o077) === 0;
    } catch (_) { return false; }
  }
  function readOne(id) {
    let descriptor;
    try {
      descriptor = fs.openSync(path.join(directory, id + '.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || !owner(stat) || (stat.mode & 0o777) !== 0o600 || stat.size > 16384) return null;
      const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      const event = validateTaskEvent(value.event, value.event?.at);
      if (value.version !== 1 || !event || event.threadId !== id || event.at > now() + 5000) return null;
      const startedAt = Number.isFinite(value.startedAt) && value.startedAt > 0 && value.startedAt <= event.at ? value.startedAt : null;
      return { version: 1, event, startedAt, metadata: safeMetadata(value.metadata, id) };
    } catch (_) { return null; }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  function read() {
    if (!isEnabled() || !ensure()) return [];
    return fs.readdirSync(directory).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)))
      .slice(0, 256).map(name => readOne(name.slice(0, -5))).filter(Boolean)
      .sort((a, b) => Number(ACTIVE.has(b.event.kind)) - Number(ACTIVE.has(a.event.kind)) || b.event.at - a.event.at).slice(0, 64);
  }
  function prune() {
    const names = fs.readdirSync(directory).filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)));
    if (names.length <= 64) return;
    const ended = names.map(name => ({ name, value: readOne(name.slice(0, -5)) }))
      .filter(item => item.value && !ACTIVE.has(item.value.event.kind)).sort((a, b) => a.value.event.at - b.value.event.at);
    for (const item of ended.slice(0, Math.max(0, names.length - 64))) {
      // Only remove the exact terminal record we inspected, never a new turn
      // concurrently written to the same thread file.
      const lock = path.join(directory, item.value.event.threadId + '.lock');
      let descriptor;
      try {
        descriptor = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        const current = readOne(item.value.event.threadId);
        if (current?.event.at === item.value.event.at && current.event.turnId === item.value.event.turnId && !ACTIVE.has(current.event.kind)) fs.unlinkSync(path.join(directory, item.name));
      } catch (_) { /* A concurrent event owns this thread; prune on a later write. */ }
      finally { if (descriptor !== undefined) { fs.closeSync(descriptor); try { fs.unlinkSync(lock); } catch (_) {} } }
    }
  }
  function mutate(id, update) {
    if (!UUID.test(id || '') || !isEnabled() || !ensure()) return Promise.resolve(false);
    const job = (async () => {
      const lock = path.join(directory, id + '.lock');
      let fd;
      for (let attempt = 0; attempt < 30; attempt++) {
        try { fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); break; }
        catch (error) {
          if (error.code !== 'EEXIST') return false;
          try { const stat = fs.lstatSync(lock); if (stat.isFile() && owner(stat) && now() - stat.mtimeMs > 10000) fs.unlinkSync(lock); } catch (_) {}
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      if (fd === undefined) return false;
      let temporary;
      try {
        if (!isEnabled()) return false;
        const before = readOne(id), next = update(before);
        if (!next || JSON.stringify(before) === JSON.stringify(next)) return true;
        temporary = path.join(directory, `${id}.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, path.join(directory, id + '.json')); temporary = null;
        return true;
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lock); } catch (_) {}
        if (temporary) try { fs.unlinkSync(temporary); } catch (_) {}
      }
    })().catch(() => false);
    pending.add(job); job.finally(() => pending.delete(job)); return job;
  }
  function record(payload, metadata = null) {
    const event = validateTaskEvent(payload, now());
    if (!event) return Promise.resolve(false);
    return mutate(event.threadId, previous => {
      const sameTurn = previous?.event.turnId === event.turnId;
      if (previous && (event.at < previous.event.at
        || sameTurn && !ACTIVE.has(previous.event.kind) && ACTIVE.has(event.kind))) return previous;
      const source = sameTurn && previous.event.ownerPid && !event.ownerPid
        ? { ...event, ownerPid: previous.event.ownerPid, ownerStartedAt: previous.event.ownerStartedAt } : event;
      return { version: 1, event: source,
        startedAt: sameTurn ? previous.startedAt : ['running', 'attention'].includes(event.kind) ? event.at : null,
        metadata: safeMetadata(metadata, event.threadId) || previous?.metadata || null };
    }).then(result => { if (result) try { prune(); } catch (_) {} return result; });
  }
  function updateMetadata(threads) {
    return Promise.all((threads || []).filter(task => UUID.test(task?.id || '') && task.notificationEligible === true).slice(0, 64)
      .map(task => mutate(task.id, before => before ? { ...before, metadata: safeMetadata(task, task.id) } : null)));
  }
  async function clear() {
    await Promise.allSettled([...pending]);
    if (!ensure()) return;
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) try { fs.unlinkSync(path.join(directory, name)); } catch (_) {}
    }
  }
  return { read, record, updateMetadata, clear, drain: () => Promise.allSettled([...pending]) };
}

module.exports = { createCodexActivityCache };
