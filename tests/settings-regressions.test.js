'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const section = (first, last) => main.slice(main.indexOf(`function ${first}(`), main.indexOf(`function ${last}(`));

function migration(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-migration-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), target = path.join(root, 'target');
  fs.mkdirSync(source); fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'workspace.json'), JSON.stringify({ localStorage: { 'notch-home-note': 'A 的笔记' } }));
  fs.mkdirSync(path.join(source, 'recordings'));
  fs.writeFileSync(path.join(source, 'recordings', 'fixture.wav'), 'fixture audio');
  let current = source, selected = target;
  const messages = [], warnings = [];
  const context = vm.createContext({
    fs, path, RECORDINGS_DIR_NAME: 'recordings', CLIP_IMAGES_DIR_NAME: 'clipboard-images',
    WORKSPACE_DATA_FILE: 'workspace.json', MIRROR_IMAGE_FILE: 'mirror-cover.jpg', WORKSPACE_SETTINGS_FILE: 'settings.json',
    workspaceRoot: () => current, getJsonSettingsPath: name => path.join(root, name),
    showOwnedOpenDialog: async () => ({ canceled: !selected, filePaths: selected ? [selected] : [] }),
    writeJsonFile: (_file, value) => { current = value.path; return true; },
    dialog: { showMessageBox: async options => { warnings.push(options); return { response: 0 }; } },
    mainWindow: { isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } },
    refreshTrayMenu() {}, ...overrides,
  });
  vm.runInContext(section('copyWorkspaceAssets', 'applyFeatureServices'), context);
  return { root, source, target, messages, warnings, current: () => current,
    select: value => { selected = value; }, run: () => context.chooseWorkspaceFolder() };
}

test('choosing an existing workspace preserves its data and the current folder before renderer autosave', async t => {
  const f = migration(t);
  const existing = JSON.stringify({ localStorage: { 'notch-home-note': 'B 的已有笔记' } });
  fs.writeFileSync(path.join(f.target, 'workspace.json'), existing);
  assert.equal(await f.run(), false);
  assert.equal(f.current(), f.source);
  assert.equal(fs.readFileSync(path.join(f.target, 'workspace.json'), 'utf8'), existing);
  assert.equal(fs.existsSync(path.join(f.target, 'recordings')), false, 'detect all conflicts before copying any assets');
  assert.deepEqual(f.messages, [], 'the renderer must never be instructed to save A into B');
  assert.match(f.warnings[0].message, /已有悬浮岛数据/);
});

test('existing asset directories and dangling symlinks are not overwritten by migration', async t => {
  for (const kind of ['directory', 'symlink']) {
    const f = migration(t);
    const conflicting = path.join(f.target, 'recordings');
    if (kind === 'directory') fs.mkdirSync(conflicting);
    else fs.symlinkSync(path.join(f.root, 'missing'), conflicting);
    assert.equal(await f.run(), false);
    assert.equal(f.current(), f.source);
    assert.equal(fs.existsSync(path.join(f.target, 'workspace.json')), false);
    assert.equal(fs.lstatSync(conflicting).isSymbolicLink(), kind === 'symlink');
  }
});

test('a copy failure keeps the current workspace active with its source data intact', async t => {
  const f = migration(t, { fs: { ...fs, cpSync() { throw Object.assign(new Error('copy failed'), { code: 'EACCES' }); } } });
  assert.equal(await f.run(), false);
  assert.equal(f.current(), f.source);
  assert.equal(fs.readFileSync(path.join(f.source, 'recordings', 'fixture.wav'), 'utf8'), 'fixture audio');
  assert.deepEqual(f.messages, []);
  assert.equal(f.warnings.length, 1);
});

test('an empty destination migrates assets and data before notifying the renderer', async t => {
  const f = migration(t);
  assert.equal(await f.run(), true);
  assert.equal(f.current(), f.target);
  for (const file of ['workspace.json', 'recordings/fixture.wav']) {
    assert.deepEqual(fs.readFileSync(path.join(f.source, file)), fs.readFileSync(path.join(f.target, file)));
  }
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0][0], 'workspace:changed');
  assert.equal(f.messages[0][1].path, f.target);
  assert.deepEqual(f.warnings, []);
});

test('cancellation and choosing the current folder do not reload or rewrite the workspace', async t => {
  const f = migration(t);
  f.select(null); assert.equal(await f.run(), false);
  f.select(f.source); assert.equal(await f.run(), false);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.source, alias);
  f.select(alias); assert.equal(await f.run(), false);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.warnings, []);
});

function shortcuts(previous = 'Command+Shift+P', throwOnRegister = false) {
  const registered = new Set([previous]);
  const actions = [];
  const context = vm.createContext({ configuredShortcut: previous,
    globalShortcut: {
      isRegistered: key => registered.has(key),
      register(key) {
        actions.push(`register:${key}`);
        if (throwOnRegister) throw new Error('unavailable');
        if (key === 'Command+Shift+N') return false;
        registered.add(key); return true;
      },
      unregister(key) { actions.push(`unregister:${key}`); registered.delete(key); },
    },
    stopHoverSpaceShortcut() { actions.push('stop-hover'); registered.delete('Space'); },
    startHoverSpaceShortcut() { actions.push('start-hover'); },
  });
  vm.runInContext(section('isValidPanelShortcut', 'applyAppSettings'), context);
  return { context, registered, actions, set: value => context.setPanelShortcut(value) };
}

test('an occupied or failed new shortcut keeps both custom and hover shortcuts working', () => {
  for (const previous of ['Command+Shift+P', 'Space']) for (const throws of [false, true]) {
    const f = shortcuts(previous, throws);
    assert.equal(f.set('Command+Shift+N'), false);
    assert.equal(f.context.configuredShortcut, previous);
    assert.equal(f.registered.has(previous), true);
    assert.deepEqual(f.actions, ['register:Command+Shift+N']);
  }
});

test('successful shortcut changes acquire the replacement first and same-key updates do not unregister it', () => {
  const f = shortcuts();
  assert.equal(f.set('Command+Shift+P'), true);
  assert.equal(f.registered.has('Command+Shift+P'), true);
  f.actions.length = 0;
  assert.equal(f.set('Command+Shift+O'), true);
  assert.deepEqual(f.actions, ['register:Command+Shift+O', 'stop-hover', 'unregister:Command+Shift+P']);
  assert.deepEqual([...f.registered], ['Command+Shift+O']);
  assert.equal(f.set('Space'), true);
  assert.equal(f.context.configuredShortcut, 'Space');
  assert.equal(f.actions.at(-1), 'start-hover');
});
