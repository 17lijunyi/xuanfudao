#!/usr/bin/env node
'use strict';

// Observation only: never makes permission decisions or reads conversation files.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { HOOK_PROVIDERS, SPECS } = require('../code-provider-specs');
const PROVIDERS = new Set(HOOK_PROVIDERS);
const INTEGRATION_VERSION = 2;

function readSelection(userData) {
  const fd = fs.openSync(path.join(userData, 'ai-tools.json'), 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) throw Error('invalid_selection');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return { ...value, key: `${stat.ino}:${stat.mtimeMs}` };
  } finally { fs.closeSync(fd); }
}

function ownerProcess(initialPid = process.ppid, readProcess = (pid) => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=,lstart=,comm='], {
  env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 150,
})) {
  let pid = initialPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const value = readProcess(pid).trim();
      const match = value.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
      if (!match) break;
      const comm = path.basename(match[3]).toLowerCase();
      if (/^(claude|kimi|gemini|qwen|node|bun|mimo|opencode|codebuddy|qoder|zcode|python[\d.]*)$/.test(comm)
        || /^(cursor|workbuddy|qoderwork|zcode)( helper.*)?$/.test(comm)
        // WorkBuddy runs its session host with its bundled Electron executable.
        // An arbitrary Electron process is not evidence of an agent task.
        || /\/(workbuddy|qoderwork|zcode)\.app\/Contents\/MacOS\/Electron$/i.test(match[3])) return { pid, started: match[2].trim() };
      pid = Number(match[1]);
    } catch (_) { break; }
  }
  return null;
}

function canonicalInput(input, event, providerId) {
  const aliases = { sessionStart: 'SessionStart', beforeSubmitPrompt: 'UserPromptSubmit', preToolUse: 'PreToolUse',
    postToolUse: 'PostToolUse', sessionEnd: 'SessionEnd', stop: input?.status === 'error' ? 'StopFailure' : input?.status === 'aborted' ? 'Interrupt' : 'Stop' };
  return { event: aliases[event] || event, input: { ...input,
    session_id: input?.session_id || input?.conversation_id,
    // Cursor's generation ID identifies the whole turn. WorkBuddy exposes the
    // previous generation at prompt submission and the new one only at Stop.
    turn_id: input?.turn_id || (providerId === 'cursor' ? input?.generation_id : undefined),
    cwd: input?.cwd || (Array.isArray(input?.workspace_roots) ? input.workspace_roots[0] : '') } };
}

function normalizeEvent(input, { providerId, event, previous = null, now = Date.now(), owner = null }) {
  if (!PROVIDERS.has(providerId) || !input || input.agent_id || input.parent_session_id || input.is_sidechain || input.isSidechain) return null;
  ({ input, event } = canonicalInput(input, event, providerId));
  const id = input.session_id;
  if (typeof id !== 'string' || !id || id.length > 200) return null;
  let status;
  if (['UserPromptSubmit', 'TurnStarted', 'BeforeAgent', 'PreToolUse', 'PostToolUse', 'BeforeTool', 'AfterTool', 'PermissionResult'].includes(event)) status = 'running';
  else if (['Stop', 'AfterAgent'].includes(event)) status = 'completed';
  else if (event === 'StopFailure') status = 'failed';
  else if (event === 'Interrupt') status = 'interrupted';
  else if (event === 'PermissionRequest') status = 'attention';
  else if (event === 'SessionEnd') {
    if (!previous || !['running', 'attention'].includes(previous.status)) return null;
    status = 'interrupted';
  } else return null;
  if (status === 'completed' && previous && ['failed', 'interrupted', 'completed'].includes(previous.status)) return null;
  const newTurn = (['UserPromptSubmit', 'TurnStarted', 'BeforeAgent'].includes(event)
    && (!input.turn_id || input.turn_id !== previous?.turnId))
    || status === 'running' && !['running', 'attention'].includes(previous?.status);
  if (!newTurn && input.turn_id && previous?.turnId && input.turn_id !== previous.turnId) return null;
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  // Titles are project names, never prompt text, responses, model inputs or keys.
  const title = (cwd ? path.basename(cwd) : previous?.title || '未命名项目').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100);
  const projectKey = path.isAbsolute(cwd) ? createHash('sha256').update(path.resolve(cwd)).digest('hex') : previous?.projectKey || null;
  return { version: INTEGRATION_VERSION, providerId, id, title, projectKey, status, updatedAt: now,
    observedStart: newTurn || previous?.observedStart === true,
    turnId: typeof input.turn_id === 'string' ? input.turn_id.slice(0, 200) : newTurn ? randomUUID() : previous?.turnId || '',
    startedAt: newTurn ? now : previous?.startedAt || now, owner: owner || previous?.owner || null };
}

function record(input, { userData, providerId, event, owner }) {
  // Switching away disables collection too, even if a previous tool keeps running.
  const selection = readSelection(userData);
  if (selection.version !== 2 || !selection.confirmed || selection.selected !== providerId) return;
  const spec = SPECS[providerId];
  if (!spec?.config || input?.agent_id || input?.parent_session_id || input?.is_sidechain || input?.isSidechain) return;
  if (spec.events.length && !spec.events.includes(event)) return;
  ({ input, event } = canonicalInput(input, event, providerId));
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 200) return;
  const directory = path.join(userData, 'ai-code-events', providerId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${createHash('sha256').update(input.session_id).digest('hex')}.json`);
  const lock = `${file}.lock`;
  let locked = false;
  // Providers can fire parallel tool hooks for one conversation. Serialize each
  // session so an older read cannot overwrite a completed/failed turn.
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.mkdirSync(lock); locked = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmdirSync(lock); continue; } } catch (_) {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (!locked) return;
  try {
  if (readSelection(userData).key !== selection.key) return;
  const receipt = path.join(directory, 'connection.json');
  const receiptTemporary = `${receipt}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(receiptTemporary, JSON.stringify({ version: INTEGRATION_VERSION, providerId, selectionKey: selection.key, lastEvent: event, receivedAt: Date.now() }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(receiptTemporary, receipt);
  } finally { try { fs.unlinkSync(receiptTemporary); } catch (_) {} }
  let previous = null;
  try { if (fs.lstatSync(file).isFile() && fs.statSync(file).size < 4096) previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (previous?.selectionKey !== selection.key) previous = null;
  const data = normalizeEvent(input, { providerId, event, previous, owner: owner || ownerProcess() });
  if (!data) return;
  data.selectionKey = selection.key;
  if (readSelection(userData).key !== selection.key) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (_) {} }
  } finally { try { fs.rmdirSync(lock); } catch (_) {} }
}

if (require.main === module) {
  if (process.argv[2] === '--check-runtime') { process.stdout.write('xuanfudao-monitor-v2\n'); process.exit(0); }
  const [userData, providerId, event] = process.argv.slice(2);
  let input = '', finished = false;
  function finish() {
    if (finished) return; finished = true;
    // Kimi appends text on stdout to the model context, so return no text there.
    if (providerId !== 'kimi-code') process.stdout.write('{}\n');
    process.exit(0);
  }
  setTimeout(finish, 1500).unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; if (input.length > 1024 * 1024) finish(); });
  process.stdin.on('error', finish);
  process.stdin.on('end', () => {
    try { if (PROVIDERS.has(providerId) && path.isAbsolute(userData || '')) record(JSON.parse(input), { userData, providerId, event }); }
    catch (_) { /* Never interrupt or change the agent's normal response. */ }
    finish();
  });
}

module.exports = { normalizeEvent, record, ownerProcess, readSelection, INTEGRATION_VERSION };
