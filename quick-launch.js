'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const SLOT_COUNT = 8;
const DEFAULT_APPS = [
  ['Codex', '/Applications/Codex.app', '/Applications/ChatGPT.app'],
  ['Safari', '/Applications/Safari.app', '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app'],
  ['VS Code', '/Applications/Visual Studio Code.app'],
  ['Chrome', '/Applications/Google Chrome.app'],
  ['终端', '/System/Applications/Utilities/Terminal.app'],
  ['备忘录', '/System/Applications/Notes.app'],
  ['访达', '/System/Library/CoreServices/Finder.app'],
  ['系统设置', '/System/Applications/System Settings.app'],
  ['日历', '/System/Applications/Calendar.app'],
  ['预览', '/System/Applications/Preview.app'],
];

function validAppPath(value) {
  return typeof value === 'string' && value.length <= 4096 && !value.includes('\0')
    && path.isAbsolute(value) && path.extname(value).toLowerCase() === '.app';
}

async function readBundleInfo(appPath) {
  const { stdout } = await runFile('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', path.join(appPath, 'Contents', 'Info.plist'),
  ], { timeout: 2500, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

async function inspectApplication(appPath, readInfo = readBundleInfo) {
  if (!validAppPath(appPath)) throw new Error('invalid_app');
  if (!(await fs.promises.stat(appPath)).isDirectory()) throw new Error('invalid_app');
  const info = await readInfo(appPath);
  const executable = info.CFBundleExecutable;
  // Finder is a launchable application with Apple's special FNDR bundle type.
  if (!['APPL', 'FNDR'].includes(info.CFBundlePackageType) || typeof executable !== 'string'
    || !executable || executable.includes('\0') || executable !== path.basename(executable)) throw new Error('invalid_app');
  const binary = await fs.promises.stat(path.join(appPath, 'Contents', 'MacOS', executable));
  if (!binary.isFile()) throw new Error('invalid_app');
  const known = DEFAULT_APPS.find(([name, ...paths]) => paths.includes(appPath)
    && (name !== 'Codex' || fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'codex'))));
  const label = known?.[0] || info.CFBundleDisplayName || info.CFBundleName || path.basename(appPath, '.app');
  return {
    appPath: path.resolve(appPath),
    name: String(label).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) || '应用',
    identity: await fs.promises.realpath(appPath),
  };
}

function defaultSlots() {
  const installed = DEFAULT_APPS.map(([name, ...paths]) => {
    const appPath = paths.find((item) => fs.existsSync(item));
    if (!appPath) return null;
    if (name === 'Codex' && !fs.existsSync(path.join(appPath, 'Contents', 'Resources', 'codex'))) return null;
    return { name, appPath };
  }).filter(Boolean).slice(0, SLOT_COUNT);
  return Array.from({ length: SLOT_COUNT }, (_, index) => installed[index] || null);
}

function createQuickLaunchService({ settingsPath, readIcon = async () => null, defaults = defaultSlots, readInfo = readBundleInfo }) {
  let slots;
  let loading;
  let choosing = false;
  const icons = new Map();

  async function load() {
    if (slots) return slots;
    if (loading) return loading;
    loading = (async () => {
      let stored;
      try { stored = JSON.parse(await fs.promises.readFile(settingsPath, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('settings_unavailable');
        slots = defaults();
        return slots;
      }
      if (stored?.version !== 1 || !Array.isArray(stored.slots) || stored.slots.length !== SLOT_COUNT
        || !stored.slots.every((item) => item === null || (validAppPath(item?.appPath)
          && typeof item.name === 'string' && item.name.trim() && item.name.length <= 100))) throw new Error('settings_unavailable');
      slots = stored.slots.map((item) => item && ({ appPath: item.appPath, name: item.name }));
      return slots;
    })().finally(() => { loading = null; });
    return loading;
  }

  const indexFor = (id) => typeof id === 'string' && /^app-slot-[0-7]$/.test(id) ? Number(id.slice(-1)) : -1;
  async function list() {
    const current = await load();
    const items = await Promise.all(current.map(async (item, index) => {
      const id = `app-slot-${index}`;
      if (!item) return { id, name: '添加应用', empty: true, available: false, icon: null };
      let available = false;
      try { available = (await fs.promises.stat(path.join(item.appPath, 'Contents', 'Info.plist'))).isFile(); } catch (_) {}
      if (available && !icons.has(item.appPath)) {
        icons.set(item.appPath, Promise.resolve().then(() => readIcon(item.appPath)).catch(() => null));
      }
      return { id, name: item.name, available, icon: available ? await icons.get(item.appPath) : null };
    }));
    return { ok: true, items };
  }

  async function save(next) {
    const temporary = `${settingsPath}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, slots: next }, null, 2), { mode: 0o600 });
      await fs.promises.rename(temporary, settingsPath);
    } catch (_) {
      await fs.promises.unlink(temporary).catch(() => {});
      throw new Error('save_failed');
    }
    slots = next;
  }

  async function replace(id, chooseApplication) {
    const index = indexFor(id);
    if (index < 0) return { ok: false, error: 'invalid_slot' };
    if (choosing) return { ok: false, error: 'busy' };
    choosing = true;
    try {
      const current = await load();
      const result = await chooseApplication();
      if (result?.canceled || !result?.filePaths?.length) return { ok: true, canceled: true };
      let chosen;
      try { chosen = await inspectApplication(result.filePaths[0], readInfo); }
      catch (_) { return { ok: false, error: 'invalid_app' }; }
      const identities = await Promise.all(current.map((item) => item
        ? fs.promises.realpath(item.appPath).catch(() => item.appPath) : null));
      if (identities.some((identity, slot) => slot !== index && identity === chosen.identity)) return { ok: false, error: 'duplicate_app' };
      const next = current.slice();
      next[index] = { appPath: chosen.appPath, name: chosen.name };
      await save(next);
      return await list();
    } catch (error) { return { ok: false, error: ['save_failed', 'settings_unavailable'].includes(error.message) ? error.message : 'choose_failed' }; }
    finally { choosing = false; }
  }

  async function launch(id, openPath) {
    const index = indexFor(id);
    if (index < 0) return { ok: false, error: 'invalid_app' };
    try {
      const item = (await load())[index];
      if (!item) return { ok: false, error: 'app_missing' };
      try { await inspectApplication(item.appPath, readInfo); }
      catch (_) { return { ok: false, error: 'app_missing' }; }
      return await openPath(item.appPath) ? { ok: false, error: 'open_failed' } : { ok: true };
    } catch (_) { return { ok: false, error: 'open_failed' }; }
  }

  return { list, replace, launch };
}

module.exports = { createQuickLaunchService, inspectApplication };
