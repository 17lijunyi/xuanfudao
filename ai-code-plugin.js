'use strict';

// OpenCode uses a plugin function; MiMo also supports a default file-hook object.
// Only event metadata crosses the bridge. No tools, prompts or permissions change.
function createPluginSource({ script, userData, providerId, fileHook = false }) {
  const configuration = JSON.stringify({ script, userData, providerId });
  return `// XUANFUDAO TASK MONITOR v2 — generated local event observer\n` +
    `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n` +
    `const config = ${configuration};\n` +
    `const createHooks = ${createHooks.toString()};\n` +
    (fileHook ? `export default createHooks({}, config, require);\n` : `export default async function XuanfudaoMonitor(ctx) { return createHooks(ctx, config, require); }\n`);
}

function createHooks(ctx, config, require) {
  const sessions = new Map(), queue = new Map();
  async function observe(event) {
    const p = event?.properties || {}, info = p.info;
    if (info?.id && ['session.created', 'session.updated'].includes(event.type)) sessions.set(info.id, info);
    const id = p.sessionID || info?.id;
    if (!id) return;
    let meta = sessions.get(id);
    if (!meta && ctx.client?.session?.get) {
      try { meta = (await ctx.client.session.get({ path: { id } })).data; if (meta) sessions.set(id, meta); } catch (_) {}
    }
    // Unknown ancestry must not produce a completion for a subagent.
    if (!meta || meta.parentID) return;
    let name;
    if (event.type === 'session.status') {
      if (['busy', 'retry'].includes(p.status?.type)) name = 'PreToolUse';
      else if (p.status?.type === 'idle') name = 'Stop';
    } else if (event.type === 'session.error') name = p.error?.name === 'MessageAbortedError' ? 'Interrupt' : 'StopFailure';
    else if (event.type === 'session.deleted') name = 'SessionEnd';
    else if (event.type === 'permission.asked') name = 'PermissionRequest';
    else if (event.type === 'permission.replied') name = 'PermissionResult';
    else if (event.type === 'session.created') name = 'SessionStart';
    if (!name) return;
    const bridge = require(config.script);
    bridge.record({ session_id: id, cwd: meta.directory || ctx.directory || '', hook_event_name: name },
      { ...config, event: name, owner: bridge.ownerProcess(process.pid) });
    if (event.type === 'session.deleted') sessions.delete(id);
    while (sessions.size > 128) sessions.delete(sessions.keys().next().value);
  }
  return { event: async ({ event }) => {
    const id = event?.properties?.sessionID || event?.properties?.info?.id;
    if (!id) return;
    const work = (queue.get(id) || Promise.resolve()).then(() => observe(event)).catch(() => {});
    queue.set(id, work);
    await work;
    if (queue.get(id) === work) queue.delete(id);
  } };
}
module.exports = { createPluginSource };
