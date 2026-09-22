'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { CATALOG, createAppearanceSettingsService } = require('../appearance-settings');
const { normalizeAppearanceSurface } = require('../appearance-surface');

const appRoot = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing main-process section: ${start}`);
  return source.slice(from, to);
}

function fixture(t, { storedId } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-appearance-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'appearance.json');
  if (storedId) fs.writeFileSync(filePath, JSON.stringify({ version: 1, selectedId: storedId }));
  let failSave = false;
  const counts = { get: 0, set: 0, normalize: 0, bounds: 0, writes: 0 };
  const filesystem = { ...fs, promises: { ...fs.promises,
    writeFile: async (...args) => { counts.writes += 1; return fs.promises.writeFile(...args); },
    rename: async (...args) => {
      if (failSave) throw new Error('disk_unavailable');
      return fs.promises.rename(...args);
    },
  } };
  const service = createAppearanceSettingsService({ filePath, fs: filesystem });
  const messages = [];
  const native = [];
  const statusUpdates = [];
  const statusSurfaces = [];
  function window(name, filename, bounds) {
    const owner = {
      name, destroyed: false, visible: true, bounds,
      isVisible: () => owner.visible,
      isDestroyed: () => owner.destroyed,
      getContentBounds: () => { counts.bounds += 1; return { ...owner.bounds }; },
      webContents: {
        mainFrame: { url: pathToFileURL(path.join(appRoot, 'renderer', filename)).href },
        isDestroyed: () => owner.destroyed,
        send: (channel, snapshot) => messages.push({ name, channel, snapshot }),
      },
    };
    return owner;
  }
  const mainWindow = window('main', 'index.html', { width: 1280, height: 640 });
  const quickIslandWindow = window('quick', 'quick-island.html', { width: 1240, height: 304 });
  const handlers = new Map();
  const listeners = new Map();
  const context = {
    __dirname: appRoot, path, fileURLToPath,
    statusIsland: { getWindow: () => context.statusWindow, syncAppearance: value => statusUpdates.push(value), updateSurface: value => statusSurfaces.push(value) },
    windowHandoff: require('../window-handoff').createWindowHandoffController(),
    mainWindow, quickIslandWindow, notificationWindow: null, activeTaskNotification: {eventId: 'theme-fixture'}, taskNotificationPaused: false, currentMode: 'expanded',
    ipcMain: {
      handle: (channel, callback) => handlers.set(channel, callback),
      on: (channel, callback) => listeners.set(channel, callback),
    },
    appearanceSettings: {
      getSnapshot: () => { counts.get += 1; return service.getSnapshot(); },
      setPreset: (id) => { counts.set += 1; return service.setPreset(id); },
    },
    normalizeAppearanceSurface: (...args) => { counts.normalize += 1; return normalizeAppearanceSurface(...args); },
    appearanceNative: {
      apply: (owner, surface) => native.push({ action: 'apply', name: owner.name, surface }),
      applyPair: (owner, surfaces) => { native.push({ action: 'pair', name: owner.name, surfaces }); return true; },
      clear: (owner) => native.push({ action: 'clear', name: owner.name }),
    },
  };
  // Exercise the real sender checks, two-window broadcast and IPC handlers.
  vm.runInNewContext([
    section('function isIslandSender(', '\nfunction isStatusIslandSender('),
    section('function isStatusIslandSender(', '\nfunction broadcastIsland('),
    section("ipcMain.on('island:status-surface'", "ipcMain.on('island:status-hold'"),
    section('function broadcastIsland(', '\nfunction handleIslandSystemChange('),
    section('function syncTaskNotificationAppearance(', '\nfunction getTaskNotificationBounds('),
    section("ipcMain.on('task-notification:surface'", "ipcMain.on('task-notification:hover'"),
    section("ipcMain.handle('appearance:get'", "ipcMain.handle('settings:set-feature'"),
  ].join('\n'), context);
  const event = (owner) => ({ sender: owner.webContents, senderFrame: owner.webContents.mainFrame });
  const payload = (owner) => ({
    viewport: { ...owner.bounds },
    surface: { x: 0, y: 0, ...owner.bounds, radii: [0, 0, 24, 24], opacity: 0.48 },
  });
  return {
    statusUpdates, statusSurfaces,
    status: () => (context.statusWindow = window('status', 'status-island.html', { width: 348, height: 120 })),
    statusSurface: (sender,value) => listeners.get('island:status-surface')(sender,value),
    context, counts, service, filePath, mainWindow, quickIslandWindow, messages, native, event, payload,
    get: (sender) => handlers.get('appearance:get')(sender),
    set: (sender, id) => handlers.get('appearance:set')(sender, id),
    surface: (sender, value) => listeners.get('appearance:surface')(sender, value),
    failSave: () => { failSave = true; },
    notification: () => (context.notificationWindow = window('notification', 'notification.html', { width: 348, height: 120 })),
    notificationSurface: (sender, value) => listeners.get('task-notification:surface')(sender, value),
  };
}

test('非可信发送者在读取、写入、归一化和背景操作之前被拒绝', async (t) => {
  const f = fixture(t);
  const own = f.event(f.mainWindow);
  const events = [
    {},
    { sender: {}, senderFrame: own.senderFrame },
    { sender: own.sender, senderFrame: { url: own.senderFrame.url } },
    { sender: own.sender, senderFrame: null },
    { sender: f.quickIslandWindow.webContents, senderFrame: { url: f.quickIslandWindow.webContents.mainFrame.url } },
  ];
  async function rejected(event) {
    assert.equal(f.get(event), null);
    const result = await f.set(event, 'system-glass-blurred');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'unauthorized');
    f.surface(event, f.payload(f.mainWindow));
  }
  for (const event of events) await rejected(event);
  const originalURL = own.senderFrame.url;
  for (const url of ['https://example.com/index.html', pathToFileURL(path.join(appRoot, 'index.html')).href]) {
    own.senderFrame.url = url;
    await rejected(own);
  }
  own.senderFrame.url = originalURL;
  f.mainWindow.destroyed = true;
  await rejected(own);
  assert.deepEqual(f.counts, { get: 0, set: 0, normalize: 0, bounds: 0, writes: 0 });
  assert.deepEqual(f.native, []);
  assert.deepEqual(f.messages, []);
  assert.equal(fs.existsSync(f.filePath), false);
});

test('工作台与速览的可信主框架都能保存，速览选择向两窗同步', async (t) => {
  const f = fixture(t);
  assert.equal(f.get(f.event(f.mainWindow)).selectedId, 'system-glass-blurred');
  assert.equal(f.get(f.event(f.quickIslandWindow)).selectedId, 'system-glass-blurred');
  const result = await f.set(f.event(f.quickIslandWindow), 'classic');
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.selectedId, 'classic');
  assert.equal(f.counts.get, 2);
  assert.equal(f.counts.set, 1);
  assert.equal(f.counts.writes, 1);
  assert.deepEqual(f.messages.map(message => message.name), ['main', 'quick']);
  assert.equal(createAppearanceSettingsService({ filePath: f.filePath }).getSnapshot().selectedId, 'classic');
});

test('两种预设实际保存并向两窗广播', async (t) => {
  const f = fixture(t);
  assert.equal(CATALOG.length, 2);
  for (const [index, preset] of CATALOG.entries()) {
    const result = await f.set(f.event(f.mainWindow), preset.id);
    assert.equal(result.ok, true);
    assert.equal(result.snapshot.selectedId, preset.id);
    assert.equal(result.snapshot.revision, index + 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, 'utf8')), { version: 1, selectedId: preset.id });
    assert.deepEqual(f.messages.slice(-2), [
      { name: 'main', channel: 'appearance:changed', snapshot: result.snapshot },
      { name: 'quick', channel: 'appearance:changed', snapshot: result.snapshot },
    ]);
  }
  assert.equal(f.messages.length, CATALOG.length * 2);
  assert.deepEqual(f.native, [{ action: 'clear', name: 'main' }, { action: 'clear', name: 'quick' }]);
});

test('旧五档和非法预设不能写盘或广播', async (t) => {
  const f = fixture(t);
  for (const id of ['system-glass', 'glass-01', 'glass-02', 'glass-03', 'glass-04', 'glass-05', 'custom', '../system-glass', { id: 'system-glass-blurred' }, 'background:red', null]) {
    const result = await f.set(f.event(f.mainWindow), id);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_preset');
  }
  assert.equal(f.service.getSnapshot().selectedId, 'system-glass-blurred');
  assert.equal(f.counts.writes, 0);
  assert.deepEqual(f.messages, []);
});

test('旧五档对两窗读取均迁移为柔焦玻璃且不自动写盘', (t) => {
  for (const storedId of ['system-glass', 'glass-01', 'glass-02', 'glass-03', 'glass-04', 'glass-05']) {
    const f = fixture(t, { storedId });
    assert.equal(f.get(f.event(f.mainWindow)).selectedId, 'system-glass-blurred');
    assert.equal(f.get(f.event(f.quickIslandWindow)).selectedId, 'system-glass-blurred');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath, 'utf8')), { version: 1, selectedId: storedId });
    assert.equal(f.counts.writes, 0);
    assert.deepEqual(f.messages, []);
  }
});

test('折叠工作台清除玻璃，即使旧全窗口消息仍匹配原尺寸', (t) => {
  const f = fixture(t, { storedId: 'system-glass-blurred' });
  const oldPayload = f.payload(f.mainWindow);
  f.context.currentMode = 'collapsed';
  f.surface(f.event(f.mainWindow), oldPayload);
  assert.deepEqual(f.native, [{ action: 'clear', name: 'main' }]);
  assert.equal(f.counts.normalize, 0);
  assert.equal(f.counts.bounds, 0);
});

test('展开工作台应用合法表面，旧 viewport 消息清除表面', (t) => {
  const f = fixture(t, { storedId: 'system-glass-blurred' });
  const value = f.payload(f.mainWindow);
  f.surface(f.event(f.mainWindow), value);
  assert.deepEqual(f.native, [{ action: 'apply', name: 'main', surface: { ...value.surface, backgroundBlurRadius: 20 } }]);
  value.viewport.width -= 40;
  f.surface(f.event(f.mainWindow), value);
  assert.deepEqual(f.native[1], { action: 'clear', name: 'main' });
  f.surface(f.event(f.mainWindow), { surface: null });
  assert.deepEqual(f.native[2], { action: 'clear', name: 'main' });
});

test('速览使用自己的真实窗口尺寸，不受工作台折叠状态影响', (t) => {
  const f = fixture(t, { storedId: 'system-glass-blurred' });
  f.context.currentMode = 'collapsed';
  const value = f.payload(f.quickIslandWindow);
  f.surface(f.event(f.quickIslandWindow), value);
  assert.deepEqual(f.native, [{ action: 'apply', name: 'quick', surface: { ...value.surface, backgroundBlurRadius: 20 } }]);
  f.surface(f.event(f.quickIslandWindow), f.payload(f.mainWindow));
  assert.deepEqual(f.native[1], { action: 'clear', name: 'quick' });
});

test('隐藏窗口与工作台展开时的旧速览消息不能重新创建背景', (t) => {
  const f = fixture(t);
  f.mainWindow.visible = false;
  f.surface(f.event(f.mainWindow), f.payload(f.mainWindow));
  f.surface(f.event(f.quickIslandWindow), f.payload(f.quickIslandWindow));
  assert.deepEqual(f.native, [{ action: 'clear', name: 'main' }, { action: 'clear', name: 'quick' }]);
  assert.equal(f.counts.normalize, 0);
  f.context.currentMode = 'collapsed';
  f.quickIslandWindow.visible = false;
  f.surface(f.event(f.quickIslandWindow), f.payload(f.quickIslandWindow));
  assert.equal(f.native.at(-1).action, 'clear');
});

test('原子保存失败保留旧值和配置且不广播', async (t) => {
  const f = fixture(t, { storedId: 'system-glass' });
  const before = fs.readFileSync(f.filePath, 'utf8');
  f.messages.length = 0;
  f.native.length = 0;
  f.failSave();
  const result = await f.set(f.event(f.mainWindow), 'system-glass-blurred');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'save_failed');
  assert.equal(result.snapshot.selectedId, 'system-glass-blurred');
  assert.equal(f.service.getSnapshot().selectedId, 'system-glass-blurred');
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.native, []);
});

test('纯黑拒绝迟到的玻璃几何，重新选择柔焦后恢复背景', async (t) => {
  const f = fixture(t, { storedId: 'classic' });
  f.surface(f.event(f.mainWindow), f.payload(f.mainWindow));
  assert.deepEqual(f.native, [{ action: 'clear', name: 'main' }]);
  assert.equal(f.counts.normalize, 0);
  await f.set(f.event(f.mainWindow), 'system-glass-blurred');
  f.surface(f.event(f.mainWindow), f.payload(f.mainWindow));
  assert.equal(f.native.at(-1).action, 'apply');
});

test('通知订阅已保存主题，不能借用通知窗口修改主题；无效和过期表面不影响当前事件', async t => {
  const f = fixture(t);
  const target = f.notification();
  const sender = f.event(target);
  assert.equal((await f.set(sender, 'classic')).ok, false, '通知窗口没有写入外观的权限');
  const surface = {x:16,y:50,width:254,height:54,radii:[27,27,27,27],opacity:1};
  const value = {eventId:'theme-fixture',viewport:{width:348,height:120},surfaces:[surface,{...surface,x:278,width:54}]};
  f.notificationSurface(f.event(f.mainWindow), value);
  f.notificationSurface({...sender,senderFrame:{url:sender.senderFrame.url}}, value);
  f.notificationSurface(sender, {...value,eventId:'old-event'});
  assert.equal(f.native.length,0);
  f.notificationSurface(sender,value);
  assert.equal(f.native.at(-1).action,'pair');
  assert.equal(f.native.at(-1).surfaces[1].x,278);
  const saved = await f.set(f.event(f.quickIslandWindow),'classic');
  assert.equal(saved.ok,true);
  assert.equal(f.messages.at(-1).name,'notification');
  assert.equal(f.messages.at(-1).channel,'appearance:changed');
  assert.equal(f.messages.at(-1).snapshot.selectedId,'classic');
  assert.equal(f.native.at(-1).action,'clear');
  f.notificationSurface(sender,value);
  assert.equal(f.native.at(-1).action,'clear','旧玻璃帧不能恢复纯黑后的材质');
  await f.set(f.event(f.mainWindow),'system-glass-blurred');
  f.notificationSurface(sender,value);
  assert.equal(f.native.at(-1).action,'pair');
  f.notificationSurface(sender,{...value,surfaces:[surface,{...surface,x:999}]});
  assert.equal(f.native.at(-1).action,'clear','两个区域必须一起通过尺寸检查');
});


test('系统提醒跟随已保存主题，几何入口只接受自己的本地主框架', async t => {
  const f=fixture(t);
  const status=f.status();
  const own=f.event(status);
  const payload={eventId:'status-fixture',surfaces:[]};
  for (const event of [{},f.event(f.mainWindow),{sender:own.sender,senderFrame:{url:own.senderFrame.url}}]) f.statusSurface(event,payload);
  assert.equal(f.statusSurfaces.length,0);
  f.statusSurface(own,payload);
  assert.deepEqual(f.statusSurfaces,[payload]);
  const result=await f.set(f.event(f.quickIslandWindow),'classic');
  assert.deepEqual(f.statusUpdates,[result.snapshot]);
  assert.equal((await f.set(own,'system-glass-blurred')).ok,false,'提醒无权写主题');
  f.failSave();
  assert.equal((await f.set(f.event(f.mainWindow),'system-glass-blurred')).ok,false);
  assert.equal(f.statusUpdates.length,1,'保存失败不得切换提醒材质');
});
