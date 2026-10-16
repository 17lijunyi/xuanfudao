'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COLORS = ['#8bceff', '#baabff', '#efb5d4', '#edc48d', '#9cd4b0', '#a8acb8'];
const defaults = () => ({
  version: 1, root: '', memberships: {},
  categories: [
    { id: 'development', name: '开发项目', color: COLORS[0] },
    { id: 'creation', name: '内容创作', color: COLORS[2] },
    { id: 'learning', name: '资料学习', color: COLORS[1] },
  ],
});
const copy = (value) => JSON.parse(JSON.stringify(value));
// birthtime prevents a deleted file's recycled inode inheriting its category.
function identity(stat, name) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}${stat.nlink > 1n && !stat.isDirectory() ? `:${name}` : ''}`;
}
function readableError(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '找不到文件夹，请重新选择。';
  if (error.code === 'EACCES' || error.code === 'EPERM') return '无法读取文件夹，请在系统设置中允许访问，或重新选择文件夹。';
  return '文件夹读取失败，请稍后刷新。';
}

function createProjectDrawer({ defaultRoot, statePath, onChange = () => {}, pollMs = 5000, watch = true }) {
  let state = defaults();
  let loaded = false;
  let storageError = '';
  let entries = [];
  let root = defaultRoot;
  let scope = '';
  let error = '';
  let undo = null;
  let tail = Promise.resolve();
  let watcher;
  let watchedIdentity = '';
  let timer;
  let debounce;
  let disposed = false;
  let previous = '';
  let revision = 0;

  function enqueue(fn) {
    const result = tail.then(async () => {
      if (disposed) throw new Error('项目抽屉已关闭。');
      await load();
      return fn();
    });
    tail = result.catch(() => {});
    return result;
  }
  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (parsed.version !== 1 || !Array.isArray(parsed.categories) || !parsed.memberships
        || typeof parsed.memberships !== 'object' || Array.isArray(parsed.memberships)
        || Object.values(parsed.memberships).some((group) => !group || typeof group !== 'object' || Array.isArray(group)
          || Object.values(group).some((value) => typeof value !== 'string'))
        || parsed.categories.some((c) => !c || typeof c.id !== 'string' || !c.id || typeof c.name !== 'string'
          || !COLORS.includes(c.color))) throw new Error('invalid_state');
      state = parsed;
      root = typeof state.root === 'string' && path.isAbsolute(state.root) ? state.root : defaultRoot;
    } catch (e) {
      if (e.code !== 'ENOENT') storageError = '分类记录无法读取，已保留原记录。请检查数据文件后重启应用。';
    }
    if (watch) {
      timer = setInterval(() => { void refresh().catch(() => {}); }, pollMs);
      timer.unref?.();
    }
  }
  async function persist(next) {
    if (storageError) throw new Error(storageError);
    const temp = `${statePath}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(statePath), { recursive: true });
      await fsp.writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
      await fsp.rename(temp, statePath);
    } catch (e) {
      await fsp.unlink(temp).catch(() => {});
      throw new Error('分类没有保存成功，请检查磁盘空间与文件夹权限后重试。');
    }
    state = next;
  }
  function observe(key) {
    if (!watch || disposed || (watcher && watchedIdentity === key)) return;
    watcher?.close();
    watcher = null;
    watchedIdentity = key;
    if (!key) return;
    try {
      const currentWatcher = fs.watch(root, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { void refresh().catch(() => {}); }, 180);
        debounce.unref?.();
      });
      watcher = currentWatcher;
      watcher.unref?.();
      watcher.on('error', () => { currentWatcher.close(); if (watcher === currentWatcher) watcher = null; });
    } catch (_) { /* Periodic reconciliation also recovers a replaced/missing root. */ }
  }
  async function scan() {
    try {
      const realRoot = await fsp.realpath(root);
      const rootStat = await fsp.stat(realRoot, { bigint: true });
      const names = (await fsp.readdir(realRoot)).filter((name) => !name.startsWith('.'));
      const found = [];
      // Bound filesystem work; large project trees are never traversed.
      for (let offset = 0; offset < names.length; offset += 32) {
        const batch = await Promise.all(names.slice(offset, offset + 32).map(async (name) => {
          try {
            const stat = await fsp.lstat(path.join(realRoot, name), { bigint: true });
            return { id: identity(stat, name), name, kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'folder' : 'file' };
          } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
        }));
        found.push(...batch.filter(Boolean));
      }
      entries = found.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      scope = identity(rootStat, '');
      error = '';
      observe(`${realRoot}:${scope}`);
    } catch (e) {
      entries = [];
      scope = '';
      error = readableError(e);
      observe('');
    }
  }
  function snapshot() {
    const membership = state.memberships[scope] || {};
    return {
      root, rootName: path.basename(root), error: error || storageError, canUndo: Boolean(undo),
      revision, categories: copy(state.categories),
      entries: entries.map((entry) => ({ ...entry, category: state.categories.some((c) => c.id === membership[entry.id]) ? membership[entry.id] : '' })),
    };
  }
  function publish() {
    const value = snapshot();
    const signature = JSON.stringify({ ...value, revision: 0 });
    if (signature !== previous) {
      previous = signature;
      revision += 1;
      value.revision = revision;
      onChange(value);
    }
    return value;
  }
  function refresh() { return enqueue(async () => { await scan(); return publish(); }); }
  function mutate(action) {
    return enqueue(async () => {
      if (!action || typeof action !== 'object') throw new Error('操作无效。');
      if (storageError) throw new Error(storageError);
      await scan();
      const next = copy(state);
      let category = next.categories.find((c) => c.id === action.id);
      if (action.type === 'save-category') {
        const name = typeof action.name === 'string' ? action.name.trim() : '';
        if (!name || [...name].length > 20) throw new Error('分类名称请填写 1–20 个字。');
        if (['全部文件', '未分类'].includes(name) || next.categories.some((c) => c.id !== action.id && c.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('这个分类名称已经存在。');
        if (!COLORS.includes(action.color)) throw new Error('请选择分类颜色。');
        if (action.id && !category) throw new Error('这个分类已不存在。');
        if (!category) {
          if (next.categories.length >= 60) throw new Error('最多可创建 60 个分类。');
          category = { id: randomUUID() };
          next.categories.push(category);
        }
        Object.assign(category, { name, color: action.color });
      } else if (action.type === 'delete-category') {
        if (!category) throw new Error('这个分类已不存在。');
        next.categories = next.categories.filter((c) => c.id !== action.id);
        for (const group of Object.values(next.memberships)) {
          for (const [id, value] of Object.entries(group)) { if (value === action.id) delete group[id]; }
        }
      } else if (action.type === 'assign') {
        if (error) throw new Error(error);
        if (action.category !== '' && !next.categories.some((c) => c.id === action.category)) throw new Error('请选择一个分类。');
        if (!Array.isArray(action.ids) || !action.ids.length || action.ids.length > entries.length) throw new Error('请先选择文件。');
        const ids = [...new Set(action.ids)];
        if (ids.some((id) => !entries.some((e) => e.id === id))) throw new Error('部分文件已变动，请刷新后重新选择。');
        const group = next.memberships[scope] || (next.memberships[scope] = {});
        for (const id of ids) { if (action.category) group[id] = action.category; else delete group[id]; }
      } else if (action.type === 'undo') {
        if (!undo) throw new Error('没有可撤销的操作。');
        await persist(undo);
        undo = null;
        return publish();
      } else throw new Error('操作无效。');
      const previousState = copy(state);
      await persist(next);
      undo = previousState;
      return publish();
    });
  }
  function chooseRoot(selectedRoot) {
    return enqueue(async () => {
      if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot)) throw new Error('请选择文件夹。');
      const realRoot = await fsp.realpath(selectedRoot);
      await fsp.readdir(realRoot);
      await persist({ ...state, root: realRoot });
      root = realRoot;
      undo = null;
      await scan();
      return publish();
    });
  }
  // Renderer passes a current catalogue ID, never an arbitrary filesystem path.
  function resolveEntry(id) {
    return enqueue(async () => {
      const oldScope = scope;
      const known = entries.find((entry) => entry.id === id);
      if (!known) throw new Error('文件已变动，请刷新后重试。');
      const target = path.join(root, known.name);
      try {
        const parent = await fsp.stat(root, { bigint: true });
        const stat = await fsp.lstat(target, { bigint: true });
        if (identity(parent, '') !== oldScope || identity(stat, known.name) !== id) throw new Error('changed');
        return target;
      } catch (_) { throw new Error('文件已移动或删除，请刷新后重试。'); }
    });
  }
  return {
    refresh, mutate, chooseRoot, resolveEntry,
    async dispose() {
      disposed = true;
      clearInterval(timer); clearTimeout(debounce); watcher?.close();
      await tail;
      clearInterval(timer); clearTimeout(debounce); watcher?.close();
    },
  };
}

module.exports = { createProjectDrawer, COLORS };
