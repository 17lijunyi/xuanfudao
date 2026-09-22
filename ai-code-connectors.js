'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { CATALOG } = require('./ai-tools');
const { emptyStatus } = require('./ai-code-runtime');
const { SPECS } = require('./code-provider-specs');
const jsonc = require('jsonc-parser');
const toml = require('@iarna/toml');
const { createPluginSource } = require('./ai-code-plugin');
const { readSelection } = require('./scripts/ai-code-hook');
const { binarySearchPaths } = require('./code-tool-paths');
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const MARKER_START = '# BEGIN XUANFUDAO TASK MONITOR';
const MARKER_END = '# END XUANFUDAO TASK MONITOR';

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return '';
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: 700 }).trim(); }
  catch (_) { return ''; }
}

function createCodeConnectors({ userData, home = os.homedir(), env = process.env, executable = process.execPath,
  script = path.join(__dirname, 'scripts/ai-code-hook.js'), identity = processIdentity, searchPaths = null, applicationDirs = null,
  probe = () => execFileSync(executable, [script, '--check-runtime'], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', timeout: 4000, maxBuffer: 4096 }).trim() === 'xuanfudao-monitor-v2' } = {}) {
  function binaryDirs() {
    if (searchPaths) return searchPaths;
    return binarySearchPaths(home, env);
  }
  const findTool = (id) => {
    const spec = SPECS[id];
    if (!spec) return null;
    const dirs = binaryDirs();
    for (const name of spec.bins || []) for (const dir of dirs) {
      const file = path.join(dir, name);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch (_) {}
    }
    for (const name of spec.apps || []) for (const dir of applicationDirs || ['/Applications', path.join(home, 'Applications')]) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isDirectory()) return file; } catch (_) {}
    }
    return null;
  };
  const isPlugin = id => ['plugin', 'file-hook'].includes(SPECS[id]?.format);
  function configPath(id) {
    const spec = SPECS[id];
    if (id === 'mimo-code' && env.MIMOCODE_HOME && path.isAbsolute(env.MIMOCODE_HOME)) return path.join(env.MIMOCODE_HOME, 'config/hooks/xuanfudao.ts');
    const override = env[spec.configEnv] || (id === 'workbuddy' ? env.CODEBUDDY_CONFIG_DIR : null);
    if (override && path.isAbsolute(override)) return path.join(override, path.basename(spec.config));
    if (isPlugin(id) && env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, spec.config.slice('.config/'.length));
    if (id === 'workbuddy' && !fs.existsSync(path.join(home, '.workbuddy')) && fs.existsSync(path.join(home, '.workbuddy-ai'))) return path.join(home, '.workbuddy-ai/settings.json');
    return path.join(home, spec.config);
  }
  function commands(id) {
    // Use the bundled Electron runtime, so recipients do not need a second Node install.
    return SPECS[id].events.map((event) => ({ event, command: `ELECTRON_RUN_AS_NODE=1 ${shellQuote(executable)} ${shellQuote(script)} ${shellQuote(userData)} ${shellQuote(id)} ${shellQuote(event)}` }));
  }
  function readConfig(id) {
    const file = configPath(id);
    let text = '';
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('config_unavailable');
      text = fs.readFileSync(file, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (isPlugin(id)) return { file, text };
    if (SPECS[id].format === 'toml') {
      const json = text.trim() ? toml.parse(text) : {};
      if (json.hooks !== undefined && !Array.isArray(json.hooks)) throw Error('config_unavailable');
      return { file, text, json };
    }
    const errors = [];
    const json = text.trim() ? jsonc.parse(text, errors, { allowTrailingComma: true }) : {};
    if (errors.length) throw Error('config_unavailable');
    if (!json || Array.isArray(json) || typeof json !== 'object'
      || (json.hooks !== undefined && (!json.hooks || Array.isArray(json.hooks) || typeof json.hooks !== 'object'))) throw Error('config_unavailable');
    return { file, text, json };
  }
  function disabled(config) {
    return config.json?.disableAllHooks === true || config.json?.allowManagedHooksOnly === true
      || config.json?.hooksConfig?.enabled === false || config.json?.hooks?.enabled === false;
  }
  const pluginSource = id => createPluginSource({ script, userData, providerId: id, fileHook: SPECS[id].format === 'file-hook' });
  const hookRoot = (id, config) => SPECS[id].format === 'zcode' ? config.json.hooks?.events : config.json.hooks;
  const owns = (id, hook) => typeof hook?.command === 'string' && hook.command.includes('ai-code-hook.js')
    && hook.command.includes(shellQuote(id)) && hook.command.includes('ELECTRON_RUN_AS_NODE=1');
  function hasHooks(id, config) {
    if (isPlugin(id)) return config.text === pluginSource(id);
    if (SPECS[id].format === 'toml') return commands(id).every(({ command, event }) => config.json.hooks?.some(hook => hook.event === event && hook.command === command && (!hook.matcher || hook.matcher === '*')));
    const hooks = hookRoot(id, config);
    return !disabled(config) && (SPECS[id].format !== 'zcode' || config.json.hooks?.enabled === true)
      && commands(id).every(({ event, command }) => Array.isArray(hooks?.[event]) && hooks[event].some(group =>
        SPECS[id].format === 'cursor' ? group.command === command && group.enabled !== false
          : (!group.matcher || group.matcher === '*') && Array.isArray(group.hooks)
            && group.hooks.some(hook => hook.type === 'command' && hook.command === command && hook.enabled !== false)));
  }
  function connect(id) {
    if (!SPECS[id]?.config) return { ok: false, error: 'unsupported' };
    if (!findTool(id)) return { ok: false, error: 'not_installed' };
    try {
      const config = readConfig(id);
      if (disabled(config)) return { ok: false, error: 'hooks_disabled' };
      try { if (!probe()) return { ok: false, error: 'runtime_unavailable' }; }
      catch (_) { return { ok: false, error: 'runtime_unavailable' }; }
      if (hasHooks(id, config)) return { ok: true };
      let next;
      if (isPlugin(id)) {
        if (config.text && !config.text.startsWith('// XUANFUDAO TASK MONITOR')) throw Error('config_unavailable');
        next = pluginSource(id);
      } else if (SPECS[id].format === 'toml') {
        // Append a marked TOML array; never reserialize models, credentials or other rules.
        if (/^\s*hooks\s*=/m.test(config.text)) throw Error('config_unavailable');
        const begin = config.text.indexOf(MARKER_START), end = config.text.indexOf(MARKER_END);
        if ((begin < 0) !== (end < 0) || (begin >= 0 && end < begin)) throw Error('config_unavailable');
        const previous = begin >= 0 ? config.text.slice(0, begin) + config.text.slice(end + MARKER_END.length) : config.text;
        next = `${previous.trimEnd()}\n\n${MARKER_START}\n` + commands(id).map(({ event, command }) =>
          `[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(command)}\ntimeout = ${SPECS[id].timeout}\n`).join('\n') + `${MARKER_END}\n`;
      } else {
        next = config.text.trim() ? config.text : '{}';
        const edits = (key, value) => { next = jsonc.applyEdits(next, jsonc.modify(next, key, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })); };
        const rootPath = SPECS[id].format === 'zcode' ? ['hooks', 'events'] : ['hooks'];
        const oldHooks = hookRoot(id, config) || {};
        if (SPECS[id].format === 'zcode') edits(['hooks', 'enabled'], true);
        if (SPECS[id].format === 'cursor') {
          if (config.json.version !== undefined && config.json.version !== 1) throw Error('config_unavailable');
          edits(['version'], 1);
        }
        for (const { event, command } of commands(id)) {
          let groups = oldHooks[event] ?? [];
          if (!Array.isArray(groups)) throw Error('config_unavailable');
          if (SPECS[id].format === 'cursor') {
            groups = groups.filter(hook => !owns(id, hook));
            groups.push({ command });
          } else {
            if (groups.some(group => !group || !Array.isArray(group.hooks))) throw Error('config_unavailable');
            groups = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => !owns(id, hook)) })).filter(group => group.hooks.length);
            groups.push({ hooks: [{ type: 'command', command, timeout: SPECS[id].timeout }] });
          }
          edits([...rootPath, event], groups);
        }
        next = next.trimEnd() + '\n';
      }
      fs.mkdirSync(path.dirname(config.file), { recursive: true });
      // Detect an external edit before committing and preserve a restorable original.
      let current = ''; try { current = fs.readFileSync(config.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== config.text) return { ok: false, error: 'config_changed' };
      if (config.text) fs.writeFileSync(`${config.file}.xuanfudao-${randomUUID()}.bak`, config.text, { mode: 0o600, flag: 'wx' });
      const temporary = `${config.file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, config.file);
      } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
      // A new installation/repair must receive a fresh event, not reuse an old
      // receipt from a different command or a previous app location.
      try { fs.unlinkSync(path.join(userData, 'ai-code-events', id, 'connection.json')); } catch (_) {}
      return { ok: true, verification: 'pending' };
    } catch (_) { return { ok: false, error: 'config_unavailable' }; }
  }
  function inspect(id) {
    const tool = CATALOG.find((item) => item.id === id);
    const result = { ...emptyStatus(id), installed: !!findTool(id), monitoringReady: false };
    if (!result.installed) return { ...result, connection: 'not_installed' };
    if (tool?.monitoring !== 'hooks') return { ...result, connection: 'unsupported', reason: SPECS[id]?.reason };
    let ready;
    try { const config = readConfig(id); if (disabled(config)) return { ...result, connection: 'not_connected', error: 'hooks_disabled' }; ready = hasHooks(id, config); }
    catch (_) { return { ...result, connection: 'not_connected', error: 'config_unavailable' }; }
    if (!ready) return { ...result, connection: 'not_connected' };
    let selectionKey = null;
    try { const selection = readSelection(userData); if (selection.selected === id && selection.confirmed) selectionKey = selection.key; } catch (_) {}
    const folder = path.join(userData, 'ai-code-events', id);
    let receipt = null;
    try {
      const file = path.join(folder, 'connection.json'), stat = fs.lstatSync(file);
      if (stat.isFile() && stat.size < 1024) {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.version === 2 && value.providerId === id && value.selectionKey === selectionKey && Number.isFinite(value.receivedAt)
          && value.receivedAt <= Date.now() + 5000) receipt = value;
      }
    } catch (_) {}
    const threads = [];
    let names = [];
    try { names = fs.readdirSync(folder).filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).slice(0, 500); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      try {
        const file = path.join(folder, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 4096) continue;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.providerId !== id || typeof data.id !== 'string' || typeof data.title !== 'string'
          || !Number.isFinite(data.updatedAt) || data.updatedAt > Date.now() + 60000
          || !['running', 'completed', 'interrupted', 'failed', 'attention'].includes(data.status)) continue;
        let status = data.status;
        // Silence never expires a long task. Verify the same process is still alive.
        if (['running', 'attention'].includes(status) && (data.selectionKey !== selectionKey
          || !data.owner?.started || identity(data.owner.pid) !== data.owner.started)) status = 'unknown';
        if (!['running', 'attention'].includes(status) && Date.now() - data.updatedAt > 7 * 86400000) continue;
        threads.push({ id: data.id, title: data.title.slice(0, 100), status, statusSource: 'hook',
          projectKey: /^[a-f0-9]{64}$/.test(data.projectKey || '') ? data.projectKey : null,
          attentionKind: status === 'attention' ? 'permission' : null, updatedAt: data.updatedAt,
          turnStartedAt: data.startedAt, turnCompletedAt: status === 'completed' ? data.updatedAt : null,
          observedStart: data.observedStart === true && data.selectionKey === selectionKey,
          turnId: data.turnId || '', providerId: id });
      } catch (_) { /* A concurrent atomic replacement cannot invalidate other sessions. */ }
    }
    threads.sort((a, b) => Number(['running', 'attention'].includes(b.status)) - Number(['running', 'attention'].includes(a.status)) || b.updatedAt - a.updatedAt);
    return { ...result, connection: receipt ? 'connected' : 'waiting', monitoringReady: true,
      monitoringVerified: !!receipt, lastEventAt: receipt?.receivedAt || null, updatedAt: Date.now(),
      threads: threads.slice(0, 30), runningTasks: threads.filter((item) => item.status === 'running'),
      attentionTasks: threads.filter((item) => item.status === 'attention'),
      recentIssueTasks: threads.filter((item) => ['failed', 'interrupted'].includes(item.status) && Date.now() - item.updatedAt <= 300000),
      recentCompletedTasks: threads.filter((item) => item.status === 'completed' && Date.now() - item.updatedAt <= 300000) };
  }
  return { inspect, connect };
}

module.exports = { createCodeConnectors, SPECS, shellQuote };
