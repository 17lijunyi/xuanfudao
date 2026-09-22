const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = process.env.FUDAO_APP_ROOT || path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-text-input-'));
app.setPath('userData', userData);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  await app.whenReady();
  const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const section = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `missing production function ${from}`);
    return source.slice(start, end);
  };
  const bounds = { x: 24, y: 0, width: 1240, height: 304 };
  const creation = section('function createQuickIslandWindow(', '\nasync function showQuickIsland(');
  const expression = creation.match(/const target = new BrowserWindow\(([\s\S]*?)\);\n  quickIslandWindow/);
  assert.ok(expression, 'use the production hover-window configuration');
  const options = vm.runInNewContext(`(${expression[1]})`, {
    path, __dirname: root, display: {}, getQuickIslandBounds: () => bounds,
  });
  const window = new BrowserWindow(options);
  const assertNativeInputLayer = async (target = window) => {
    if (process.platform !== 'darwin') return;
    // Give AppKit a turn to submit the level change to WindowServer.
    await delay(50);
    const windowID = target.getMediaSourceId().split(':')[1];
    const layer = Number(execFileSync('swift', [path.join(__dirname, 'window-layer.native.swift'), windowID], { encoding: 'utf8' }).trim());
    assert.ok(layer > 0 && layer < 20, `native editor layer ${layer} must float above ordinary windows but below macOS Chinese candidates (20)`);
    assert.equal(target.getBounds().y, 0, 'lowering the input window must not move its canvas away from the screen top');
  };
  const levels = [];
  const setAlwaysOnTop = window.setAlwaysOnTop.bind(window);
  window.setAlwaysOnTop = (...args) => { levels.push(args); setAlwaysOnTop(...args); };
  const context = vm.createContext({
    windowHandoff: require('../window-handoff').createWindowHandoffController(),
    canShowQuickIsland: () => true,
    statusIsland: { hide: () => {}, syncForAppSurface: async () => {}, sync: async () => {} },
    quickIslandOpening: 0, quickIslandInteractive: false, quickIslandNativeFocusable: false,
    quickIslandGeneration: 0, quickIslandHideTimer: null,
    clearTimeout, getWindowDisplay: () => ({}), createQuickIslandWindow: async () => window,
    getCollapsedHeight: () => 38, getMenuBarHeight: () => 34, getQuickIslandBounds: () => bounds, COLLAPSED_WIDTH: 256,
    app, islandActivities: {}, systemStatus: { getSnapshot: async () => ({}) },
    // This fixture owns only the editor. Two-window coverage is exercised by
    // glass-window-lifecycle.electron.js with real separate BrowserWindows.
    setCollapsedIslandCovered: () => {}, appearanceNative: { clear: () => {} },
    startQuickIslandPointerWatch: () => {},
    mainWindow: window, notchPreviewActive: false, workbenchOpeningRevision: 0,
    workbenchOpeningUntil: 0, hideQuickIsland: () => {}, cancelCollapseWatchdog: () => {},
    getBoundsForMode: () => bounds, getLayoutMetrics: () => ({}), currentMode: 'collapsed',
    hideWhenCollapsed: false, syncHoverSpacePolling: () => {}, refreshTrayMenu: () => {},
  });
  vm.runInContext(section('async function showQuickIsland(', '\nfunction cancelCollapseWatchdog('), context);
  vm.runInContext(section('function applyMode(', '\n// 纯重新定位'), context);
  let requests = 0;
  let failFocus = false;
  let releaseFocus = null;
  let delayFocus = false;
  const responses = {
    'quick-launch:list': { items: [] }, 'island:get-activities': {},
    'ai-code:get': { providerId: null, windows: [], threads: [] },
    'codex-float:get': { connection: 'unavailable', windows: [], threads: [] },
    'mirror:get-image': null,
  };
  const channels = [...new Set([...fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
    .matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))];
  for (const channel of channels) ipcMain.handle(channel, async (_event, ...args) => {
    if (channel === 'quick-island:show') {
      requests++;
      if (failFocus) return { ok: false };
      if (delayFocus) return new Promise((resolve) => { releaseFocus = resolve; });
      return context.showQuickIsland(args[0]);
    }
    return responses[channel] ?? null;
  });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
    throw new Error(label);
  };
  const showPassive = async () => {
    window.webContents.send('quick-island:hide');
    await delay(50);
    window.hide();
    context.quickIslandInteractive = false;
    await context.showQuickIsland({ focus: false });
    await waitFor(() => evaluate(`document.querySelector('#quick-island').dataset.visible === 'true'`), 'island visible');
    assert.equal(window.isFocusable(), false, 'hover must not take keyboard focus');
  };
  // Deliver the initial press without manufacturing a DOM focus event. Native
  // non-key panels may withhold that event until the app makes the window key.
  const pointerPress = () => evaluate(`document.querySelector('#quick-note-input').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); true`);
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  try {
    await window.loadFile(path.join(root, 'renderer', 'quick-island.html'));
    window.webContents.debugger.attach('1.3');
    await showPassive();
    await pointerPress();
    try {
      await waitFor(() => window.isFocusable() && window.isFocused() && window.webContents.isFocused(), 'first pointer press must activate native text input without Space');
    } catch (error) {
      console.error({ requests, levels, focusable: window.isFocusable(), focused: window.isFocused(), webFocused: window.webContents.isFocused(), renderer: await evaluate(`({ visible: document.querySelector('#quick-island').dataset.visible, interactive: document.querySelector('#quick-island').dataset.interactive, active: document.activeElement.id, focused: document.hasFocus(), message: document.querySelector('#quick-message').textContent })`) });
      throw error;
    }
    assert.equal(await evaluate(`document.activeElement.id`), 'quick-note-input');
    assert.equal(requests, 1, 'pointer press and resulting DOM focus share one activation');
    assert.deepEqual(levels.at(-1), [true, 'floating', 0], 'editing stays below system candidate panels');
    await assertNativeInputLayer();
    assert.ok(Math.abs(await evaluate(`document.querySelector('.island-topbar').getBoundingClientRect().y`) - 34) < .5, 'navigation stays below the menu bar while the canvas is pinned to y=0');
    await window.webContents.debugger.sendCommand('Input.insertText', { text: '测试光标' });
    await evaluate(`document.querySelector('#quick-note-input').setSelectionRange(2, 2); true`);
    await pointerPress();
    await window.webContents.debugger.sendCommand('Input.insertText', { text: '中' });
    assert.equal(await evaluate(`document.querySelector('#quick-note-input').value`), '测试中光标', 'a second activation must preserve the caret');
    await delay(400);
    assert.equal(await evaluate(`localStorage.getItem('notch-home-note')`), '测试中光标', 'typing without an initial Space saves the draft');

    await showPassive();
    assert.deepEqual(levels.at(-1), [true, 'screen-saver', 1], 'passive mode regains its original level');
    failFocus = true;
    await pointerPress();
    await waitFor(() => evaluate(`document.querySelector('#quick-message').textContent.includes('再点击一次')`), 'failed activation gives feedback');
    assert.equal(await evaluate(`document.querySelector('#quick-island').dataset.interactive`), 'false');
    failFocus = false;
    await pointerPress();
    await waitFor(() => window.isFocusable() && window.isFocused(), 'a failed activation can be retried');

    await showPassive();
    delayFocus = true;
    await pointerPress();
    await waitFor(() => Boolean(releaseFocus), 'pending activation');
    window.webContents.send('quick-island:hide');
    await delay(50);
    releaseFocus({ ok: true });
    await delay(50);
    assert.equal(await evaluate(`document.querySelector('#quick-island').inert`), true);
    assert.notEqual(await evaluate(`document.activeElement.id`), 'quick-note-input', 'late activation must not refocus a hidden editor');

    const mainCreation = source.slice(source.indexOf('function createWindow()'));
    const mainExpression = mainCreation.match(/mainWindow = new BrowserWindow\(([\s\S]*?)\);/);
    assert.ok(mainExpression, 'use the production main-window configuration');
    const mainOptions = vm.runInNewContext(`(${mainExpression[1]})`, { path, __dirname: root, initial: bounds });
    const workbench = new BrowserWindow(mainOptions);
    try {
      await workbench.loadURL('about:blank');
      context.mainWindow = workbench;
      workbench.showInactive();
      context.applyMode('expanded');
      await assertNativeInputLayer(workbench);
      context.applyMode('collapsed');
      assert.equal(workbench.isAlwaysOnTop(), true, 'collapsed notch retains its own high window layer');
    } finally { workbench.destroy(); }
    console.log('PASS text input: passive native panel, first pointer activation, caret and draft, failure/retry, late response, IME window levels');
  } finally { window.destroy(); }
}

function finish(code) { fs.rmSync(userData, { recursive: true, force: true }); app.exit(code); }
run().then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
