'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { createCodeConnectors, SPECS } = require(path.join(root, 'ai-code-connectors'));
const { HOOK_PROVIDERS } = require(path.join(root, 'code-provider-specs'));
const { createAIToolsService } = require(path.join(root, 'ai-tools'));
const { record, readSelection, ownerProcess } = require(path.join(root, 'scripts/ai-code-hook'));
const jsonc = require('jsonc-parser');
const executable = process.env.AI_HOOK_TEST_EXECUTABLE || process.execPath;

function fixture(t, id) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "监测 新用户's-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, '用户'), userData = path.join(home, 'Library/Application Support/悬浮岛');
  const bin = path.join(home, '.local/bin'), apps = path.join(home, 'Applications');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(apps);
  const spec = SPECS[id];
  if (spec.bins?.length) fs.writeFileSync(path.join(bin, spec.bins[0]), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
  else fs.mkdirSync(path.join(apps, spec.apps[0]));
  const service = createAIToolsService({ settingsPath: path.join(userData, 'ai-tools.json') });
  const choose = (tool = id) => service.update({ action: 'select', id: tool, confirmed: true });
  choose();
  const options = { home, userData, env: { PATH: '/usr/bin:/bin', HOME: home }, searchPaths: [bin], applicationDirs: [apps], executable };
  const connectors = createCodeConnectors(options);
  const file = spec.config ? path.join(home, spec.config) : null;
  return { base, home, userData, options, connectors, file, choose, spec };
}
function commandFor(f, event) {
  const text = fs.readFileSync(f.file, 'utf8');
  if (f.spec.format === 'toml') {
    const block = text.split('[[hooks]]').find(block => block.includes(`event = ${JSON.stringify(event)}`));
    return JSON.parse(block.match(/^command = (.+)$/m)[1]);
  }
  const data = jsonc.parse(text), events = f.spec.format === 'zcode' ? data.hooks.events : data.hooks;
  return f.spec.format === 'cursor' ? events[event].at(-1).command : events[event].at(-1).hooks[0].command;
}
function execute(f, event, extra = {}) {
  return execFileSync('/bin/sh', ['-c', commandFor(f, event)], {
    env: f.options.env, input: JSON.stringify({ session_id: 'main-session', conversation_id: 'main-session',
      ...(f.spec.format === 'cursor' ? { generation_id: 'turn-1' } : {}), cwd: '/Fixture/项目甲', workspace_roots: ['/Fixture/项目甲'],
      prompt: 'PRIVATE PROMPT', transcript_path: '/private/conversation.json', ...extra }),
    encoding: 'utf8', timeout: 5000,
  });
}

for (const id of HOOK_PROVIDERS.filter(id => SPECS[id].events.length)) {
  test(`${id}: fresh HOME → config → native command → receipt → lifecycle → switch isolation`, t => {
    const f = fixture(t, id);
    assert.equal(f.connectors.inspect(id).connection, 'not_connected');
    assert.equal(f.connectors.connect(id).ok, true);
    const content = fs.readFileSync(f.file, 'utf8');
    assert.equal(f.connectors.connect(id).ok, true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), content, 'idempotent connection');
    assert.equal(f.connectors.inspect(id).monitoringVerified, false, 'config is not a receipt');
    execute(f, id === 'cursor' ? 'sessionStart' : 'SessionStart');
    let value = f.connectors.inspect(id);
    assert.equal(value.connection, 'connected'); assert.deepEqual(value.threads, []);
    const start = id === 'cursor' ? 'beforeSubmitPrompt' : id === 'kimi-code' ? 'TurnStarted' : id === 'gemini-cli' ? 'BeforeAgent' : 'UserPromptSubmit';
    execute(f, start);
    value = f.connectors.inspect(id);
    assert.equal(value.runningTasks.length, 1, id + ': parent runtime identity');
    assert.equal(value.threads[0].title, '项目甲'); assert.equal(value.threads[0].observedStart, true);
    assert.deepEqual(value.windows, [], 'no invented quota');
    if (f.spec.events.includes('PermissionRequest')) {
      execute(f, 'PermissionRequest'); assert.equal(f.connectors.inspect(id).attentionTasks.length, 1);
      execute(f, 'PostToolUse'); assert.equal(f.connectors.inspect(id).runningTasks.length, 1);
    }
    const stop = id === 'cursor' ? 'stop' : id === 'gemini-cli' ? 'AfterAgent' : 'Stop';
    execute(f, stop, { status: 'completed' });
    assert.equal(f.connectors.inspect(id).recentCompletedTasks.length, 1);
    assert.equal(f.connectors.inspect(id).runningTasks.length, 0);
    execute(f, start, { generation_id: 'turn-2' });
    f.choose(id === 'claude-code' ? 'kimi-code' : 'claude-code');
    execute(f, stop, { generation_id: 'turn-2' }); // Other tool cannot collect after switching away.
    f.choose(id);
    value = f.connectors.inspect(id);
    assert.equal(value.connection, 'waiting', 'old receipt cannot verify a new selection');
    assert.equal(value.runningTasks.length, 0, 'old persistent host must not resurrect a missed completion');
    assert.equal(value.threads[0].status, 'unknown');
    execute(f, start, { generation_id: 'turn-3' });
    assert.equal(f.connectors.inspect(id).runningTasks.length, 1);
    execute(f, stop, { generation_id: 'turn-3', agent_id: 'child' });
    assert.equal(f.connectors.inspect(id).runningTasks.length, 1, 'subagent must not end parent');
    const directory = path.join(f.userData, 'ai-code-events', id);
    const persisted = fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
    assert.doesNotMatch(persisted, /PRIVATE PROMPT|transcript_path|\/Fixture|\/private/);
  });
}

test('WorkBuddy native generations change after submission; its Electron session host is a valid owner', t => {
  const started = 'Wed Sep 16 01:13:00 2026';
  const owner = ownerProcess(100, pid => ({
    100: `101 ${started} /bin/zsh`,
    101: `102 ${started} /Users/example/Applications/WorkBuddy.app/Contents/MacOS/Electron`,
  })[pid]);
  assert.deepEqual(owner, { pid: 101, started });
  assert.equal(ownerProcess(100, () => `1 ${started} /Applications/Unrelated.app/Contents/MacOS/Electron`), null);
  const f = fixture(t, 'workbuddy');
  f.connectors = createCodeConnectors({ ...f.options, identity: pid => pid === owner.pid ? started : '' });
  assert.equal(f.connectors.connect('workbuddy').ok, true);
  const send = (event, extra) => record({ session_id: 'native-workbuddy', cwd: '/Fixture/项目甲', ...extra }, {
    userData: f.userData, providerId: 'workbuddy', event, owner,
  });
  send('UserPromptSubmit', {});
  const first = f.connectors.inspect('workbuddy').runningTasks[0];
  assert.ok(first);
  send('Stop', { generation_id: 'generated-only-at-stop' });
  assert.equal(f.connectors.inspect('workbuddy').recentCompletedTasks[0].turnId, first.turnId);
  send('UserPromptSubmit', { generation_id: 'generated-only-at-stop' });
  const second = f.connectors.inspect('workbuddy').runningTasks[0];
  assert.notEqual(second.turnId, first.turnId);
  send('Stop', { generation_id: 'next-generation' });
  assert.equal(f.connectors.inspect('workbuddy').recentCompletedTasks[0].turnId, second.turnId);
  assert.equal(f.connectors.inspect('workbuddy').runningTasks.length, 0);
});

for (const id of ['opencode', 'mimo-code']) {
  test(`${id}: generated plugin observes official event shapes and rejects child/unknown ancestry`, async t => {
    const f = fixture(t, id);
    assert.equal(f.connectors.connect(id).ok, true);
    assert.equal(f.connectors.inspect(id).connection, 'waiting');
    const modulePath = path.join(f.base, 'plugin.mjs');
    fs.copyFileSync(f.file, modulePath);
    const plugin = (await import(pathToFileURL(modulePath).href)).default;
    const hooks = id === 'mimo-code' ? plugin : await plugin({ directory: '/Fixture/项目乙' });
    const event = (type, properties) => hooks.event({ event: { type, properties } });
    await event('session.status', { sessionID: 'unknown', status: { type: 'busy' } });
    assert.equal(f.connectors.inspect(id).connection, 'waiting');
    await event('session.created', { info: { id: 'child', parentID: 'parent', directory: '/Fixture/child' } });
    await event('session.status', { sessionID: 'child', status: { type: 'busy' } });
    assert.deepEqual(f.connectors.inspect(id).threads, []);
    await event('session.created', { info: { id: 'parent', directory: '/Fixture/项目乙' } });
    assert.equal(f.connectors.inspect(id).connection, 'connected');
    await event('session.status', { sessionID: 'parent', status: { type: 'busy' } });
    assert.equal(f.connectors.inspect(id).runningTasks.length, 1);
    await event('permission.asked', { sessionID: 'parent' });
    assert.equal(f.connectors.inspect(id).attentionTasks.length, 1);
    await event('permission.replied', { sessionID: 'parent' });
    assert.equal(f.connectors.inspect(id).runningTasks.length, 1);
    await event('session.status', { sessionID: 'parent', status: { type: 'idle' } });
    assert.equal(f.connectors.inspect(id).recentCompletedTasks.length, 1);
    await event('session.status', { sessionID: 'parent', status: { type: 'busy' } });
    await event('session.error', { sessionID: 'parent', error: { name: 'MessageAbortedError' } });
    await event('session.status', { sessionID: 'parent', status: { type: 'idle' } });
    assert.equal(f.connectors.inspect(id).threads[0].status, 'interrupted', 'idle after error is not success');
  });
}

test('JSONC repair preserves user settings, comments and other hooks without duplicates after relocation', t => {
  const f = fixture(t, 'workbuddy');
  fs.mkdirSync(path.dirname(f.file), { recursive: true });
  const original = '{\n  // USER COMMENT\n  "env": { "TOKEN": "local-only", },\n  "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "user-hook" }] }] }\n}';
  fs.writeFileSync(f.file, original);
  assert.equal(f.connectors.connect('workbuddy').ok, true);
  const relocated = path.join(f.base, "Moved ' 应用"); fs.mkdirSync(path.join(relocated, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/ai-code-hook.js'), path.join(relocated, 'scripts/ai-code-hook.js'));
  fs.copyFileSync(path.join(root, 'code-provider-specs.js'), path.join(relocated, 'code-provider-specs.js'));
  const next = createCodeConnectors({ ...f.options, script: path.join(relocated, 'scripts/ai-code-hook.js') });
  assert.equal(next.inspect('workbuddy').connection, 'not_connected');
  assert.equal(next.connect('workbuddy').ok, true);
  const saved = fs.readFileSync(f.file, 'utf8'), data = jsonc.parse(saved);
  assert.ok(saved.includes('// USER COMMENT')); assert.equal(data.env.TOKEN, 'local-only');
  assert.equal(data.hooks.Stop.length, 2); assert.equal(data.hooks.Stop[0].hooks[0].command, 'user-hook');
  const backups = fs.readdirSync(path.dirname(f.file)).filter(name => name.endsWith('.bak'));
  assert.ok(backups.some(name => fs.readFileSync(path.join(path.dirname(f.file), name), 'utf8') === original));
  execute(f, 'SessionStart'); assert.equal(next.inspect('workbuddy').connection, 'connected');
});

test('broken runtime, malformed configs and disabled policies never alter provider settings', t => {
  for (const id of ['claude-code', 'gemini-cli', 'workbuddy', 'qoderwork', 'cursor', 'zcode']) {
    const f = fixture(t, id); fs.mkdirSync(path.dirname(f.file), { recursive: true });
    for (const original of ['{invalid', '{"disableAllHooks":true}', '{"allowManagedHooksOnly":true}', '{"hooks":{"enabled":false}}']) {
      fs.writeFileSync(f.file, original);
      assert.equal(f.connectors.connect(id).ok, false, id);
      assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    }
    fs.writeFileSync(f.file, '{}');
    const broken = createCodeConnectors({ ...f.options, executable: path.join(f.base, 'missing') });
    assert.equal(broken.connect(id).error, 'runtime_unavailable');
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{}');
  }
});

test('CLI discovery works with GUI PATH, nvm, fnm and per-user install directories without executing tools', t => {
  const f = fixture(t, 'claude-code');
  fs.unlinkSync(path.join(f.options.searchPaths[0], 'claude'));
  for (const relative of ['.nvm/versions/node/v24/bin', '.local/share/fnm/node-versions/v22/installation/bin', '.local/bin', '.bun/bin']) {
    const directory = path.join(f.home, relative); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'claude'), '#!/bin/sh\nexit 7\n', { mode: 0o700 });
    const detector = createCodeConnectors({ ...f.options, searchPaths: null });
    assert.equal(detector.inspect('claude-code').installed, true, relative);
    fs.unlinkSync(path.join(directory, 'claude'));
  }
});

test('selection identity persists across restart but changes on A→B→A', t => {
  const f = fixture(t, 'kimi-code');
  const original = readSelection(f.userData).key;
  f.choose(); assert.equal(readSelection(f.userData).key, original);
  f.choose('claude-code'); f.choose(); assert.notEqual(readSelection(f.userData).key, original);
  record({ session_id: 'one', cwd: '/Fixture/项目' }, { userData: f.userData, providerId: 'claude-code', event: 'UserPromptSubmit' });
  assert.equal(fs.existsSync(path.join(f.userData, 'ai-code-events')), false);
});

test('Kimi TOML validation preserves models and rejects broken or incompatible hooks tables', t => {
  const f = fixture(t, 'kimi-code'); fs.mkdirSync(path.dirname(f.file), { recursive: true });
  for (const original of ['broken = [', '[hooks]\ncustom = true', 'hooks = "disabled"']) {
    fs.writeFileSync(f.file, original); assert.equal(f.connectors.connect('kimi-code').ok, false);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  }
  const original = '# user notes\n[models.custom]\nmodel = "custom-model"\n';
  fs.writeFileSync(f.file, original); assert.equal(f.connectors.connect('kimi-code').ok, true);
  const parsed = require('@iarna/toml').parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(parsed.models.custom.model, 'custom-model'); assert.ok(Array.isArray(parsed.hooks));
  assert.equal(parsed.hooks.length, f.spec.events.length);
});

test('custom config homes are honored for Claude, WorkBuddy, OpenCode and MiMo', t => {
  for (const [id, key, suffix] of [['claude-code', 'CLAUDE_CONFIG_DIR', 'settings.json'],
    ['workbuddy', 'WORKBUDDY_CONFIG_DIR', 'settings.json'], ['opencode', 'XDG_CONFIG_HOME', 'opencode/plugins/xuanfudao.js'],
    ['mimo-code', 'MIMOCODE_HOME', 'config/hooks/xuanfudao.ts']]) {
    const f = fixture(t, id), directory = path.join(f.base, 'custom');
    const c = createCodeConnectors({ ...f.options, env: { ...f.options.env, [key]: directory } });
    assert.equal(c.connect(id).ok, true); assert.ok(fs.existsSync(path.join(directory, suffix)));
    assert.equal(fs.existsSync(f.file), false);
  }
});

test('providers without a verified event contract do not pretend installation means monitoring', t => {
  for (const id of ['doubao-work', 'traework', 'deepseek']) {
    const f = fixture(t, id), value = f.connectors.inspect(id);
    assert.equal(value.installed, true); assert.equal(value.connection, 'unsupported');
    assert.ok(value.reason); assert.deepEqual(value.threads, []);
    assert.equal(f.connectors.connect(id).error, 'unsupported');
  }
});
