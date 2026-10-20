'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fileURLToPath } = require('node:url');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const { createAppearanceSettingsService } = require(path.join(root, 'appearance-settings'));
const { createWindowSizeSettingsService } = require(path.join(root, 'window-size-settings'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-notch-wings-'));
const preferenceFile = path.join(userData, 'appearance.json');
app.setPath('userData', userData);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  await app.whenReady();
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  function extract(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first + start.length);
    assert.ok(first >= 0 && last > first, `production fixture anchors exist: ${start}`);
    return source.slice(first, last);
  }

  let failSave = false;
  const fileSystem = { ...fs, promises: { ...fs.promises, rename: async (...args) => {
    if (failSave) throw new Error('fixture_save_failure');
    return fs.promises.rename(...args);
  } } };
  const service = createAppearanceSettingsService({ filePath: preferenceFile, fs: fileSystem });
  const display = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 },
  };
  const webPreferences = {
    preload: path.join(root, 'preload.js'), contextIsolation: true,
    nodeIntegration: false, sandbox: true, backgroundThrottling: false,
  };
  const creation = source.slice(source.indexOf('function createWindow()'));
  const options = creation.match(/mainWindow = new BrowserWindow\(([\s\S]*?)\);\n\n  installLocalWebContentsGuards/);
  assert.ok(options, 'production main window options are available');
  const work = new BrowserWindow(vm.runInNewContext(`(${options[1]})`, {
    initial: { x: 628, y: 0, width: 256, height: 38 }, path, __dirname: root,
  }));
  const quick = new BrowserWindow({ show: false, frame: false, transparent: true, enableLargerThanScreen: true, width: 1040, height: 308, webPreferences });
  const handlers = new Map();
  const broadcasts = [];
  const notificationUpdates = [];
  const statusUpdates = [];
  const context = vm.createContext({
    __dirname: root, path, fileURLToPath,
    mainWindow: work, quickIslandWindow: quick, currentMode: 'collapsed', currentTab: 'home',
    notchPreviewActive: false, appearanceSettings: service,
    windowSizeSettings: createWindowSizeSettingsService({ filePath: path.join(userData, 'window-size.json') }),
    QUICK_ISLAND_HEIGHT: 270, NOTCH_PREVIEW_MIN_HEIGHT: 56, NOTCH_PREVIEW_DETAIL_HEIGHT: 18,
    getTargetDisplay: () => display, getWindowDisplay: () => display,
    appearanceNative: { clear() {} },
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); ipcMain.handle(channel, handler); } },
    broadcastIsland(channel, snapshot) {
      broadcasts.push({ channel, snapshot });
      for (const owner of [work, quick]) if (!owner.isDestroyed()) owner.webContents.send(channel, snapshot);
    },
    syncTaskNotificationAppearance: snapshot => notificationUpdates.push(snapshot),
    statusIsland: { syncAppearance: snapshot => statusUpdates.push(snapshot) },
    systemUIBlocks: () => false, quickIslandOpening: 0, workbenchOpeningUntil: 0,
    activeTaskNotification: null, notificationWindow: null, islandPasteTargetPrepared: null,
    rememberPasteTarget: async () => {},
    applyMode(mode) {
      context.currentMode = mode;
      context.notchPreviewActive = false;
      work.setBounds(context.getBoundsForMode(mode));
    },
  });
  // Keep Electron frame wrappers in their owning realm, as in window-size's
  // fixture; invoking their lazy native accessors inside a VM corrupts them.
  context.isIslandSender = new Function('__dirname', 'path', 'fileURLToPath', 'mainWindow', 'quickIslandWindow',
    `${extract('function isIslandSender(', '\nfunction isStatusIslandSender(')}; return isIslandSender;`
  )(root, path, fileURLToPath, work, quick);
  // Exercise the production geometry and guarded IPC, not copied formulas.
  for (const [start, end] of [
    ['const COLLAPSED_CENTER_WIDTH =', 'const COLLAPSE_WATCHDOG_MS'],
    ['function getCenteredBounds(', '\nfunction isIslandSender('],
    ['function getQuickIslandBounds(', '\nfunction canShowQuickIsland('],
    ['function getLayoutMetrics(', "\nipcMain.handle('window:metrics'"],
    ["ipcMain.handle('appearance:get'", "ipcMain.on('appearance:surface'"],
    ["ipcMain.handle('window:set-mode'", "ipcMain.handle('window:begin-collapse'"],
  ]) vm.runInContext(extract(start, end), context);

  const codeStatus = { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [], resets: { available: null } };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(root, 'ai-tools')).CATALOG,
      state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': codeStatus, 'codex-float:get': codeStatus,
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'settings:get': { features: { todo: true, projects: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'window-size:get': context.windowSizeSettings.getSnapshot(),
    'transcription:get-config': {}, 'credentials:list': { items: [] }, 'tasks:recent': [],
    'quick-launch:list': { items: [] }, 'window:begin-collapse': { ok: true },
    'island:activities-get': { recording: null, timer: null },
  };
  for (const channel of new Set([...fs.readFileSync(path.join(root, 'preload.js'), 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) {
    if (handlers.has(channel)) continue;
    ipcMain.handle(channel, () => channel === 'window:metrics' ? context.getLayoutMetrics() : responses[channel] ?? null);
  }
  work.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const evaluate = (code, owner = work) => owner.webContents.executeJavaScript(code);
  async function waitFor(code, message, owner = work) {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(code, owner)) return;
      await delay(25);
    }
    assert.fail(message);
  }
  function assertBounds(owner, width, height, message) {
    assert.deepEqual(owner.getBounds(), { x: Math.round((1512 - width) / 2), y: 0, width, height }, message);
  }
  async function setWings(visible, owner = work) {
    const result = await evaluate(`window.notchAPI.setNotchWingsVisible(${JSON.stringify(visible)})`, owner);
    assert.equal(result.ok, true);
    for (const target of [work, quick]) {
      await waitFor(`document.documentElement.dataset.notchWings === '${visible ? 'visible' : 'hidden'}'`, 'appearance reaches both renderers', target);
    }
    await waitFor(`parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--codex-notch-width')) === ${visible ? 256 : 200}`, 'metrics reach the real renderer');
    return result;
  }
  async function assertPainted(visible, message) {
    // capturePage sees Chromium paint, not native vibrancy or window opacity.
    // On this macOS Electron build toBitmap uses four-byte pixels with alpha
    // last; the visible baseline below also guards against an empty capture.
    let painted = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const image = await work.webContents.capturePage();
      const pixels = image.toBitmap({ scaleFactor: 1 });
      const size = image.getSize(1);
      assert.equal(image.isEmpty(), false, 'pixel capture is not empty');
      assert.equal(pixels.length, size.width * size.height * 4, 'capture has one four-byte pixel per position');
      painted = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset] !== 0) painted++;
      if (visible ? painted > 0 : painted === 0) break;
      await delay(25);
    }
    assert.equal(visible ? painted > 0 : painted === 0, true, `${message}: ${painted} nontransparent pixels`);
    assert.equal(work.getOpacity(), 1, 'transparency must come from renderer paint, not native window opacity');
    assert.equal(work.isVisible(), true, 'the entry window remains visible to the window server');
  }
  async function assertCenterHit() {
    assert.equal(await evaluate(`(() => {
      const notch = document.getElementById('notch');
      const rect = notch.getBoundingClientRect();
      return notch.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    })()`), true, 'transparent center retains DOM pointer hit testing');
  }

  try {
    work.setBounds(context.getBoundsForMode('collapsed'));
    quick.setBounds(context.getQuickIslandBounds());
    await work.loadFile(path.join(root, 'renderer/index.html'));
    await quick.loadFile(path.join(root, 'renderer/quick-island.html'));
    work.showInactive();
    await waitFor(`document.documentElement.dataset.notchWings === 'visible' && !modeBusy`, 'default wings are visible');
    assertBounds(work, 256, 38, 'default folded window is top-centered');
    await assertPainted(true, 'enabled wings provide the nontransparent baseline');

    await setWings(false);
    assertBounds(work, 200, 38, 'hiding wings preserves folded height and top-center');
    assertBounds(quick, 1040, 308, 'changing wings never resizes the quick window');
    assert.equal(context.getLayoutMetrics().notchWingWidth, 0);
    const hidden = await evaluate(`(() => {
      const notch = document.getElementById('notch');
      const rect = notch.getBoundingClientRect();
      return { wings: [...notch.querySelectorAll('.codex-notch-quota, .codex-notch-tasks')].map(el => {
          const style = getComputedStyle(el); return style.display === 'none' || style.visibility === 'hidden';
        }),
        width: rect.width, height: rect.height, role: notch.getAttribute('role'),
        hit: notch.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
    })()`);
    assert.deepEqual(hidden.wings, [true, true], 'real quota and task wings are hidden');
    assert.equal(hidden.width, 200);
    assert.equal(hidden.height, 38);
    assert.equal(hidden.hit, true, 'the retained center remains a pointer target');
    assert.equal(createAppearanceSettingsService({ filePath: preferenceFile }).getSnapshot().showNotchWings, false, 'fresh service restores hidden wings');

    for (const preset of ['classic', 'system-glass-blurred']) {
      assert.equal((await evaluate(`window.notchAPI.setAppearancePreset('${preset}')`)).ok, true);
      await waitFor(`document.documentElement.dataset.appearance === '${preset}'`, 'saved material reaches the renderer');
      for (const height of [24, 34, 38, 48]) {
        display.workArea.y = height;
        display.workArea.height = display.bounds.height - height;
        work.setBounds(context.getBoundsForMode('collapsed'));
        context.broadcastIsland('window:metrics-changed', context.getLayoutMetrics());
        await waitFor(`document.getElementById('notch').getBoundingClientRect().height === ${height}`, 'menu bar metrics reach the folded entry');
        assertBounds(work, 200, height, `${preset} preserves the ${height}px entry geometry`);
        await assertPainted(false, `${preset}, ${height}px: hidden folded window has zero alpha everywhere`);
        await assertCenterHit();
      }
    }
    display.workArea.y = 38;
    display.workArea.height = display.bounds.height - 38;
    work.setBounds(context.getBoundsForMode('collapsed'));
    context.broadcastIsland('window:metrics-changed', context.getLayoutMetrics());
    await waitFor(`document.getElementById('notch').getBoundingClientRect().height === 38`, 'restore the standard menu bar fixture');
    await setWings(true);
    await assertPainted(true, 'reenabling wings restores visible pixels');
    await setWings(false);
    await assertPainted(false, 'disabling wings removes every painted pixel again');

    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
    await waitFor(`document.getElementById('app').classList.contains('previewing')`, 'hidden-wing center still opens hover preview');
    assertBounds(work, 200, 56, 'preview uses the selected width and keeps its detail height');
    await assertPainted(true, 'hover preview remains visible with wings disabled');
    await setWings(true, quick);
    assertBounds(work, 256, 56, 'visible preview can change wings without collapsing');
    await setWings(false, quick);
    assertBounds(work, 200, 56, 'hiding wings preserves an active preview');
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'))`);
    await waitFor(`!document.getElementById('app').classList.contains('previewing')`, 'hover leave retracts preview');
    assertBounds(work, 200, 38, 'preview returns to the narrow folded window');
    await assertPainted(false, 'leaving preview restores complete transparency');

    await evaluate(`document.getElementById('notch').click()`);
    await waitFor(`document.getElementById('app').classList.contains('expanded') && !modeBusy`, 'hidden-wing center still opens the workbench');
    assertBounds(work, 1040, 480, 'click opens the unchanged workbench dimensions');
    await assertPainted(true, 'expanded content remains visible with wings disabled');
    await setWings(true);
    assertBounds(work, 1040, 480, 'showing wings does not resize an expanded workbench');
    await setWings(false);
    assertBounds(work, 1040, 480, 'hiding wings does not resize an expanded workbench');
    assertBounds(quick, 1040, 308, 'quick dimensions remain unchanged in expanded mode');
    const closing = await evaluate(`new Promise((resolve, reject) => {
      const app = document.getElementById('app');
      const observer = new MutationObserver(() => {
        if (!app.classList.contains('closing')) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve({ notch: getComputedStyle(document.getElementById('notch')).opacity,
          cap: getComputedStyle(app, '::before').opacity });
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('closing phase did not start')); }, 5000);
      observer.observe(app, { attributes: true, attributeFilter: ['class'] });
      document.getElementById('notch').click();
    })`);
    assert.deepEqual(closing, { notch: '0', cap: '0' }, 'closing hides the folded shell and cap while the workbench animates out');
    await waitFor(`document.getElementById('app').classList.contains('collapsed') && !modeBusy`, 'workbench can fold again');
    assertBounds(work, 200, 38, 'folding reuses the persisted narrow width');
    await assertPainted(false, 'completed collapse returns to zero alpha everywhere');
    await assertCenterHit();

    const before = { bounds: work.getBounds(), quick: quick.getBounds(), snapshot: service.getSnapshot(),
      broadcasts: broadcasts.length, notifications: notificationUpdates.length, status: statusUpdates.length };
    for (const value of ['false', null, 0, {}]) {
      assert.equal((await evaluate(`window.notchAPI.setNotchWingsVisible(${JSON.stringify(value)})`)).ok, false, 'invalid values are rejected');
    }
    failSave = true;
    assert.equal((await evaluate('window.notchAPI.setNotchWingsVisible(true)')).error, 'save_failed');
    failSave = false;
    await quick.loadURL('about:blank');
    assert.equal((await evaluate('window.notchAPI.setNotchWingsVisible(true)', quick)).error, 'unauthorized', 'navigated sender cannot update appearance');
    const handler = handlers.get('appearance:set-notch-wings');
    assert.equal((await handler({ sender: work.webContents, senderFrame: {} }, true)).error, 'unauthorized', 'non-main frame is rejected');
    assert.deepEqual(work.getBounds(), before.bounds, 'rejected or failed saves cannot resize the main window');
    assert.deepEqual(quick.getBounds(), before.quick);
    assert.deepEqual(service.getSnapshot(), before.snapshot);
    assert.equal(broadcasts.length, before.broadcasts, 'rejected or failed saves cannot broadcast new geometry');
    assert.equal(notificationUpdates.length, before.notifications);
    assert.equal(statusUpdates.length, before.status);
    assert.equal(JSON.parse(fs.readFileSync(preferenceFile)).showNotchWings, false);
    assert.ok(before.notifications > 0 && before.status > 0, 'successful changes synchronize popup appearance');
    console.log('PASS notch wings: production geometry/IPC, 256↔200 top-center, zero-alpha folded paint in 2 themes × 4 menu heights, visible preview/expanded, transparent closing return, opacity-1 hit target, restart, hover/click, failure and sender guards');
  } finally {
    work.destroy();
    quick.destroy();
  }
}

run().then(() => {
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(0);
}).catch(error => {
  console.error(error);
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(1);
});
