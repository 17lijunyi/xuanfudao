#!/usr/bin/env node
'use strict';

// No prompt, response, transcript or arbitrary payload is sent to 浮岛 or written to disk.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { validateTaskEvent } = require('../codex-task-state');
const { findCodexOwner } = require('../codex-process');
const { createCodexActivityCache } = require('../codex-activity-cache');
const MAX_INPUT_BYTES = 1024 * 1024;
const TOKEN_PATH = path.join(os.homedir(), 'Library/Application Support/Dynamic Panel/codex-lifecycle-token');
const THREAD_ID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const ROLLOUT_NAME = new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${THREAD_ID})(?:_${THREAD_ID})?\\.jsonl$`, 'i');

function matchesToolThread(input, env) {
  // Desktop hooks may omit CODEX_THREAD_ID. The supplied filename contains an
  // independent thread identity (some desktop versions append a second UUID).
  // Inspect the name only; never open a transcript or retain its path.
  const filenameId = typeof input.transcript_path === 'string' && input.transcript_path.length <= 4096
    && path.isAbsolute(input.transcript_path) ? path.basename(input.transcript_path).match(ROLLOUT_NAME)?.[1] : null;
  if (env.CODEX_THREAD_ID && env.CODEX_THREAD_ID !== input.session_id) return false;
  if (filenameId && filenameId !== input.session_id) return false;
  return Boolean(env.CODEX_THREAD_ID === input.session_id || filenameId === input.session_id);
}

function selectedCodex(directory = path.dirname(TOKEN_PATH)) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'ai-tools.json'), 'utf8'));
    return state.version === 2 && state.confirmed === true && state.selected === 'codex';
  } catch (_) { return false; }
}

function projectHookEvent(input, { mode = 'hook', now = Date.now(), env = process.env } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.agent_id || input.parent_thread_id || input['parent-thread-id'] || input.parentThreadId || input.is_subagent || input.isSubagent
    || /cloud|remote|subagent/i.test(String(input.source || input.session_source || ''))) return null;
  let kind;
  if (mode === 'notify') {
    if (input.type !== 'agent-turn-complete') return null;
    kind = 'completed';
  } else {
    const eventName = input.hook_event_name;
    const normalizedTool = String(input.tool_name || '').replace(/[^a-z]/gi, '').toLowerCase();
    const requestsInput = normalizedTool === 'requestuserinput';
    kind = ({ UserPromptSubmit: 'running', PreToolUse: requestsInput ? 'attention' : 'running',
      PostToolUse: requestsInput ? 'running' : null, PermissionRequest: 'attention',
      Stop: 'stopping', Interrupt: 'interrupted' })[eventName];
    if (!kind) return null;
    // Subagent hooks share their parent's session_id; require another exact
    // thread identity before attributing tool activity to the parent.
    if (['PreToolUse', 'PostToolUse', 'PermissionRequest'].includes(eventName)
      && !matchesToolThread(input, env)) return null;
  }
  const threadId = input['thread-id'] || input.thread_id || input.session_id || env.CODEX_THREAD_ID;
  const turnId = input['turn-id'] || input.turn_id;
  const attentionKind = kind === 'attention'
    ? (input.hook_event_name === 'PermissionRequest' ? 'permission' : 'input') : null;
  return validateTaskEvent({ version: 1, kind, threadId, turnId, at: now,
    source: 'local', parentThreadId: null, agentId: null,
    ...(attentionKind ? { attentionKind } : {}) }, now);
}

function readToken(file = TOKEN_PATH) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid() || info.size > 65) return null;
    const token = fs.readFileSync(descriptor, 'utf8').trim();
    return /^[a-f0-9]{64}$/i.test(token) ? token : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function sendEvent(event, { token = readToken(), request = http.request } = {}) {
  if (!event || !token) return Promise.resolve(false);
  const body = Buffer.from(JSON.stringify(event));
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (!settled) { settled = true; resolve(ok); } };
    let req;
    try {
      req = request({ hostname: '127.0.0.1', port: 43821, path: '/codex-lifecycle', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: `Bearer ${token}` } }, response => {
        response.resume();
        finish(response.statusCode >= 200 && response.statusCode < 300);
      });
      req.on('error', () => finish(false));
      req.setTimeout(700, () => { req.destroy(); finish(false); });
      req.end(body);
    } catch { finish(false); }
  });
}

function forwardOriginalNotify(raw, { env = process.env, spawnProcess = spawn } = {}) {
  // Preserve the machine's existing Sky turn-ended notification exactly. Do not
  // chain the old 浮岛 notifier: it would duplicate the completion and forward text.
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sky = env.CODEX_COMPUTER_USE_CLIENT || path.join(codexHome, 'computer-use',
    'Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient');
  try {
    const child = spawnProcess(sky, ['turn-ended', raw], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* The existing observer cannot block Codex. */ }
}

async function main() {
  const mode = process.argv[2] === 'notify' ? 'notify' : 'hook';
  let raw;
  if (mode === 'notify') {
    raw = process.argv[3] || '{}';
    forwardOriginalNotify(raw);
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) return;
  } else {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) return;
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  let event = projectHookEvent(input, { mode });
  if (event && ['running', 'attention', 'stopping'].includes(event.kind)) {
    const owner = findCodexOwner();
    if (owner) event = { ...event, ...owner };
  }
  if (event && selectedCodex()) {
    const cache = createCodexActivityCache({ directory: path.join(path.dirname(TOKEN_PATH), 'codex-activities'), isEnabled: selectedCodex });
    await cache.record(event);
  }
  await sendEvent(event);
  if (mode === 'hook' && input?.hook_event_name === 'Stop') process.stdout.write('{}\n');
}

if (require.main === module) main().catch(() => {});
module.exports = { projectHookEvent, readToken, sendEvent, forwardOriginalNotify, selectedCodex };
