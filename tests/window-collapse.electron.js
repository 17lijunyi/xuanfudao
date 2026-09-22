const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = process.env.FUDAO_APP_ROOT || path.join(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-surface-test-'));
app.setPath('userData', userData);
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));

async function run() {
  await app.whenReady();
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  // Read the production options instead of giving this fixture its own frame
  // throttling policy, which previously concealed hidden-window regressions.
  const creation = main.slice(main.indexOf('function createWindow()'));
  const match = creation.match(/mainWindow = new BrowserWindow\(([\s\S]*?)\);\n\n  installLocalWebContentsGuards/);
  assert.ok(match, 'main window construction must be available to the regression fixture');
  const expression = match[1];
  const options = vm.runInNewContext(`(${expression})`, {
    initial: { x: 300, y: 0, width: 256, height: 38 }, path, __dirname: root,
  });
  const geometry = vm.createContext({ currentTab: 'home', windowSizeSettings: require(path.join(root, 'window-size-settings')).createWindowSizeSettingsService({ filePath: path.join(userData, 'window-size.json') }) });
  vm.runInContext(main.slice(main.indexOf('const EXPANDED_WIDTH ='), main.indexOf('const COLLAPSE_WATCHDOG_MS')), geometry);
  vm.runInContext(main.slice(main.indexOf('function getMenuBarHeight('), main.indexOf('// display 不传时')), geometry);
  const display = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
  const expandedSize = geometry.getExpandedSize(display);
  assert.equal(expandedSize.width, 1040);
  assert.equal(expandedSize.height, 480, 'B height includes the menu bar and navigation');
  for (const menuHeight of [24, 38]) {
    assert.equal(geometry.getExpandedSize({ ...display, workArea: { ...display.workArea, y: menuHeight } }).height, 480);
  }
  assert.equal(geometry.getExpandedSize({ ...display, bounds: { ...display.bounds, height: 450 } }).height, 426, 'short screens retain the safety margin');
  const window = new BrowserWindow(options);
  let nativeMode = 'collapsed';
  let watchdog = null;
  let watchdogCount = 0;
  const resize = (mode) => {
    nativeMode = mode;
    window.setBounds({ x: mode === 'expanded' ? 24 : 516, y: 0, width: mode === 'expanded' ? expandedSize.width : 256, height: mode === 'expanded' ? expandedSize.height : 38 }, false);
  };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(root, 'ai-tools.js')).CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [] },
    'window:metrics': { stripHeight: 38, previewHeight: 56, menuBarHeight: 38, safeAreaTop: 38, chromeY: 114, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'transcription:get-config': { configured: false, verificationPending: false, llmConfigured: false },
    'codex-float:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [], resets: { available: null, items: [] } },
    'windows:list': { items: [] }, 'tasks:recent': [], 'credentials:list': { items: [], secureStorage: true },
  };
  const channels = [...new Set([...fs.readFileSync(path.join(root, 'preload.js'), 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))];
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => {
    if (channel === 'window:set-mode') {
      clearTimeout(watchdog);
      resize(args[0] === 'expanded' ? 'expanded' : 'collapsed');
      return { ok: true, mode: nativeMode };
    }
    if (channel === 'window:begin-collapse') {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { watchdogCount++; resize('collapsed'); }, 650);
      return;
    }
    if (channel.startsWith('quick-island:')) return { ok: true };
    return responses[channel] ?? null;
  });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () => evaluate(`({ classes: document.getElementById('app').className, busy: modeBusy, expanded: isExpanded, visibility: document.visibilityState })`);
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(30);
    }
    throw new Error(label);
  };
  try {
    await window.loadFile(path.join(root, 'renderer/index.html'));
    window.showInactive();
    await delay(450);
    const cases = [];
    for (const hideDuringCollapse of [true, false, true]) {
      window.showInactive();
      await evaluate('void setMode(true); true');
      await waitFor(async () => (await state()).classes.includes('expanded'), 'workbench did not expand');
      await delay(400);
      assert.equal(window.getBounds().y, 0, 'expanded canvas remains pinned to the physical screen top');
      const layout = await evaluate(`({ nav: document.querySelector('.topbar').getBoundingClientRect().y, panels: document.querySelector('.panels').getBoundingClientRect().height })`);
      assert.ok(layout.nav >= 38, 'navigation is not covered by the native menu bar');
      assert.equal(layout.panels, 366, '480 total height reserves 38px menu safety and 76px chrome');
      if (hideDuringCollapse) window.hide();
      const began = Date.now();
      window.webContents.send('window:request-collapse');
      await delay(900);
      const result = { hideDuringCollapse, elapsed: Date.now() - began, nativeMode, size: window.getSize(), ...(await state()) };
      cases.push(result);
      if (result.busy || !result.classes.includes('collapsed')) break;
    }
    // Exercise production main-process immediate collapse against the real renderer.
    const collapseContext = vm.createContext({
      windowHandoff: require('../window-handoff').createWindowHandoffController(),
      mainWindow: window, currentMode: 'expanded',
      mediaPermissionRequests: 0, transientSystemInteractionRequests: 0, cameraBlurDeferred: false,
      applyMode: mode => { clearTimeout(watchdog); resize(mode); collapseContext.currentMode = mode; },
      beginNativeCollapse: () => { throw new Error('blur must not wait for a watchdog'); },
    });
    const from = main.indexOf('function requestRendererCollapse(');
    const to = main.indexOf('\nfunction hideWindowAfterCollapse(', from);
    vm.runInContext(main.slice(from, to), collapseContext);
    const blurFrom = main.indexOf("  mainWindow.on('blur', () => {");
    const blurTo = main.indexOf("  mainWindow.on('focus'", blurFrom);
    vm.runInContext(main.slice(blurFrom, blurTo), collapseContext);
    for (const phase of ['expanded', 'opening', 'closing']) {
      window.showInactive();
      await evaluate('void setMode(true); true');
      await waitFor(async () => nativeMode === 'expanded', 'native workbench did not expand');
      if (phase !== 'opening') {
        await waitFor(async () => !(await state()).busy, 'opening transaction did not finish');
      }
      if (phase === 'closing') await evaluate('void setMode(false); true');
      collapseContext.currentMode = 'expanded';
      await evaluate(`noteInput.value = 'draft survives desktop click'; noteInput.dispatchEvent(new Event('input')); window.stoppedTracks = 0; mirrorStream = {getTracks: () => [{stop: () => window.stoppedTracks++}]}; true`);
      window.emit('blur');
      assert.deepEqual(window.getSize(), [256, 38], `${phase}: native bounds collapse synchronously`);
      await waitFor(async () => !(await state()).expanded && !(await state()).busy, 'immediate renderer reset');
      assert.equal(await evaluate('localStorage.getItem(NOTE_KEY)'), 'draft survives desktop click');
      assert.equal(await evaluate('window.stoppedTracks'), 1, 'immediate collapse releases camera track');
      await delay(750);
      const settled = await state();
      assert.equal(settled.expanded, false, `${phase}: stale continuation must not reopen the workbench`);
      assert.equal(settled.busy, false);
      assert.ok(settled.classes.includes('collapsed'));
      assert.deepEqual(window.getSize(), [256, 38]);
      assert.equal(watchdogCount, 0);
    }
    const result = { root, hasShadow: window.hasShadow(), watchdogCount, cases };
    console.log(JSON.stringify(result, null, 2));
    assert.equal(window.hasShadow(), false, 'transparent island must not retain native shadow silhouettes');
    assert.equal(watchdogCount, 0, 'collapse must finish without the native watchdog shrinking a stale renderer surface');
    assert.equal(cases.length, 3);
    for (const item of cases) {
      assert.equal(item.busy, false);
      assert.equal(item.expanded, false);
      assert.ok(item.classes.includes('collapsed'));
      assert.deepEqual(item.size, [256, 38]);
    }
  } finally {
    clearTimeout(watchdog);
    window.destroy();
  }
}
function finish(code) {
  fs.rmSync(userData, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0)).catch((error) => { console.error(error); finish(1); });
