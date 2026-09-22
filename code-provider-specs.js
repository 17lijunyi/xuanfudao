'use strict';

// Provider-specific contracts. Never assume two branded clients share a config.
const common = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop'];
const SPECS = Object.freeze({
  'claude-code': { bins: ['claude'], config: '.claude/settings.json', configEnv: 'CLAUDE_CONFIG_DIR', events: [...common, 'StopFailure', 'SessionEnd'], timeout: 5 },
  'kimi-code': { bins: ['kimi'], config: '.kimi-code/config.toml', format: 'toml', events: ['SessionStart', 'TurnStarted', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PermissionResult', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd'], timeout: 5 },
  'gemini-cli': { bins: ['gemini'], config: '.gemini/settings.json', events: ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'SessionEnd'], timeout: 5000 },
  'qwen-code': { bins: ['qwen'], config: '.qwen/settings.json', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'], timeout: 5000 },
  workbuddy: { apps: ['WorkBuddy.app'], config: '.workbuddy/settings.json', configEnv: 'WORKBUDDY_CONFIG_DIR', events: [...common, 'StopFailure', 'SessionEnd'], timeout: 5 },
  qoderwork: { apps: ['QoderWork.app'], config: '.qoderwork/settings.json', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'], timeout: 5 },
  cursor: { apps: ['Cursor.app'], bins: ['cursor-agent'], config: '.cursor/hooks.json', format: 'cursor', events: ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop', 'sessionEnd'], timeout: 5 },
  zcode: { apps: ['ZCode.app', 'Zcode.app'], bins: ['zcode'], config: '.zcode/cli/config.json', format: 'zcode', events: common, timeout: 5 },
  opencode: { bins: ['opencode'], apps: ['OpenCode.app'], config: '.config/opencode/plugins/xuanfudao.js', format: 'plugin', events: [] },
  'mimo-code': { bins: ['mimo'], config: '.config/mimocode/hooks/xuanfudao.ts', format: 'file-hook', events: [] },
  'doubao-work': { apps: ['DoubaoWork.app', '豆包工作.app'], reason: '尚未确认豆包工作提供可用的本机任务事件接口' },
  traework: { apps: ['TRAE SOLO.app', 'TRAE SOLO CN.app', 'TraeWork.app', 'Trae.app', 'Trae CN.app'], reason: 'TraeWork 与 TraeCode 接口不同，当前尚未完成 TraeWork 事件接入' },
  deepseek: { bins: ['dsh'], reason: 'DeepSeek Harness 需在实际启动的 preset 中挂载 Hook 插件，尚未完成自动接入' },
});
const HOOK_PROVIDERS = Object.freeze(Object.keys(SPECS).filter(id => SPECS[id].config));
module.exports = { SPECS, HOOK_PROVIDERS };
