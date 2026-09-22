'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HOOK_PROVIDERS, SPECS } = require('./code-provider-specs');

// Only this catalog supplies IDs, images and destinations to the renderer.
const CATALOG = Object.freeze([
  ['codex', 'Codex', 'OpenAI · 编程与任务', 'codex', 'https://chatgpt.com/codex'],
  ['claude-code', 'Claude Code', 'Anthropic · 编程助手', 'claudecode', 'https://claude.com/product/claude-code'],
  ['kimi-code', 'Kimi Code', '月之暗面 · 编程助手', 'kimi', 'https://www.kimi.com/code'],
  ['mimo-code', 'MiMo Code', '小米 · 终端编程助手', 'xiaomimimo', 'https://mimo.xiaomi.com/mimocode'],
  ['doubao-work', '豆包工作', '豆包 · 工作助手', 'doubao', 'https://www.doubao.com/'],
  ['workbuddy', 'WorkBuddy', '腾讯 · 工作助手', 'codebuddy', 'https://www.workbuddy.ai/'],
  ['qoderwork', 'QoderWork', 'Qoder · 工作助手', 'qoder', 'https://docs.qoder.com/qoderwork/introduction'],
  ['traework', 'TraeWork', 'TRAE · 工作助手', 'trae', 'https://www.trae.ai/work'],
  ['deepseek', 'DeepSeek Harness', 'DeepSeek · 开发者预览版', 'deepseek', 'https://www.deepseek.com/harness/'],
  ['cursor', 'Cursor', 'Cursor · 编程助手', 'cursor', 'https://cursor.com/'],
  ['gemini-cli', 'Gemini CLI', 'Google · 终端助手', 'gemini', 'https://geminicli.com/'],
  ['qwen-code', 'Qwen Code', '阿里通义 · 编程助手', 'qwen', 'https://qwenlm.github.io/qwen-code-docs/en/'],
  ['zcode', 'ZCode', '智谱 · 编程助手', 'zcode', 'https://zcode.z.ai/en'],
  ['opencode', 'OpenCode', '开源 · 多模型编程助手', 'opencode', 'https://opencode.ai/'],
].map(([id, name, description, mark, website]) => Object.freeze({
  id, name, description, website,
  icon: mark === 'codex' ? 'assets/codex-mark.svg' : `assets/ai-tools/${mark}.${mark === 'zcode' ? 'png' : 'svg'}`,
  monitoring: id === 'codex' ? 'native' : HOOK_PROVIDERS.includes(id) ? 'hooks' : 'unavailable',
  monitoringNote: SPECS[id]?.reason || (id === 'codex' ? '只读额度与任务事件' : '需配置并收到真实事件后验证'),
})));
const IDS = new Set(CATALOG.map((tool) => tool.id));

function createAIToolsService({ settingsPath, filesystem = fs } = {}) {
  let state = { version: 2, selected: null, confirmed: false };
  let suggested = null;
  let revision = 0;
  let loadError = false;
  try {
    const saved = JSON.parse(filesystem.readFileSync(settingsPath, 'utf8'));
    if (saved.version === 1 && Array.isArray(saved.enabled) && saved.enabled.length
      && saved.enabled.every((id) => IDS.has(id)) && saved.enabled.includes(saved.selected)) {
      // A legacy checkbox was not consent to inspect the user's other tools.
      suggested = saved.selected;
    } else if (saved.version === 2 && IDS.has(saved.selected) && saved.confirmed === true) {
      state = { version: 2, selected: saved.selected, confirmed: true };
    } else throw Error('invalid_settings');
  } catch (error) { loadError = error.code !== 'ENOENT'; }

  function getSnapshot() {
    return { ok: true, revision, catalog: CATALOG.map((tool) => ({ ...tool })),
      state: { ...state }, needsSetup: !state.confirmed, suggested,
      error: loadError ? 'settings_unavailable' : null };
  }

  function update(request) {
    const { action, id, confirmed } = request || {};
    if (!IDS.has(id) || action !== 'select') return { ok: false, error: 'invalid_tool' };
    if (confirmed !== true) return { ok: false, error: 'confirmation_required' };
    if (loadError) return { ok: false, error: 'settings_unavailable' };
    const next = { version: 2, selected: id, confirmed: true };
    if (JSON.stringify(next) === JSON.stringify(state)) return getSnapshot();
    const temporary = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      filesystem.mkdirSync(path.dirname(settingsPath), { recursive: true });
      filesystem.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      filesystem.renameSync(temporary, settingsPath);
    } catch (_) {
      try { filesystem.unlinkSync(temporary); } catch (_) {}
      return { ok: false, error: 'save_failed' };
    }
    state = next; suggested = null; revision++;
    return getSnapshot();
  }

  function website(id) { return CATALOG.find((tool) => tool.id === id)?.website || null; }
  return Object.freeze({ getSnapshot, update, website });
}

module.exports = { CATALOG, createAIToolsService };
