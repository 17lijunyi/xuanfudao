'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-handoff-'));
app.setPath('userData', data);
app.once('will-quit', () => fs.rmSync(data, { recursive: true, force: true }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
async function main() {
  await app.whenReady();
  const handlers = new Map(), listeners = new Map(), errors = [];
  const held = [];
  let pointer = { x: 200, y: 150 };
  let holdReady = true, width = 1040, preset = 'system-glass-blurred', appearanceRevision = 0;
  const nativePath = [path.join(root, 'native/appearance-glass.node'), path.join(root, '.cache/native/appearance-glass.node'), path.join(root, '../native/appearance-glass.node')].find(fs.existsSync);
  const native = require(nativePath);
  const appearanceNative = require(path.join(root, 'appearance-native')).createAppearanceNativeController({ addonPath: nativePath });
  const handoff = require(path.join(root, 'window-handoff')).createWindowHandoffController({ onError: error => errors.push(String(error)), timeoutMs: 5000 });
  const bounds = mode => ({ x: 40, y: 40, width: mode === 'expanded' ? width : 256, height: mode === 'expanded' ? 480 : 38 });
  const quickBounds = () => ({ ...bounds('expanded'), height: 308 });
  const metrics = () => ({ stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 });
  const options = { frame: false, transparent: true, backgroundColor: '#00000000', show: false, hasShadow: false,
    webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } };
  const mainWindow = new BrowserWindow({ ...options, ...bounds('collapsed') });
  const quickIslandWindow = new BrowserWindow({ ...options, ...quickBounds(), focusable: false });
  const windows = [mainWindow, quickIslandWindow];
  const context = vm.createContext({
    app, mainWindow, quickIslandWindow, appearanceNative, windowHandoff: handoff,
    currentMode: 'collapsed', isQuitting: false, notchPreviewActive: false, activeTaskNotification: null, notificationWindow: null,
    workbenchOpeningUntil: 0, workbenchOpeningRevision: 0, hideWhenCollapsed: false, islandPasteTargetPrepared: null,
    quickIslandGeneration: 0, quickIslandInteractive: false, quickIslandNativeFocusable: false, quickIslandHideTimer: null, quickIslandOpening: 0,
    collapseGeneration: 0, collapseWatchdog: null, COLLAPSE_WATCHDOG_MS: 1000, COLLAPSED_WIDTH: 256, QUICK_ISLAND_HIDE_MS: 40,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, Number,
    quickIslandPointerTimer: null, quickIslandOutsideSince: 0,
    screen: { getCursorScreenPoint: () => pointer },
    canShowQuickIsland: () => context.currentMode === 'collapsed',
    QUICK_ISLAND_WORKSPACE_TABS: new Set(['home', 'todo', 'projects', 'codes', 'notes', 'links', 'recordings', 'credentials', 'settings']),
    systemUIBlocks: () => false, getWindowDisplay: () => ({}), getBoundsForMode: bounds, getQuickIslandBounds: quickBounds,
    getCollapsedHeight: () => 38, getMenuBarHeight: () => 38, getLayoutMetrics: metrics,
    refreshTrayMenu: () => {}, syncHoverSpacePolling: () => {},
    statusIsland: { sync: async () => {}, syncForAppSurface: async () => {} },
    createQuickIslandWindow: async () => quickIslandWindow, rememberPasteTarget: async () => {},
    isIslandSender: (event, allowQuick = true) =>
      (!mainWindow.isDestroyed() && event.sender === mainWindow.webContents) ||
      (allowQuick && !quickIslandWindow.isDestroyed() && event.sender === quickIslandWindow.webContents),
    isStatusIslandSender: () => false,
    normalizeAppearanceSurface: require(path.join(root, 'appearance-surface')).normalizeAppearanceSurface,
    normalizeWindowMotion: require(path.join(root, 'window-handoff')).normalizeWindowMotion,
    appearanceSettings: { getSnapshot: () => ({ selectedId: preset }) },
    islandActivities: {}, systemStatus: { getSnapshot: async () => ({}) },
    ipcMain: { handle: (name, callback) => handlers.set(name, callback), on: (name, callback) => listeners.set(name, callback) },
  });
  vm.runInContext([
    section('function stopQuickIslandPointerWatch(', '\nfunction createQuickIslandWindow('),
    section('async function showQuickIsland(', '\nfunction cancelCollapseWatchdog('),
    section("ipcMain.handle('quick-island:show'", '\nasync function openIslandWorkspace('),
    section('function cancelCollapseWatchdog(', '\n// 纯重新定位'),
    section('function beginNativeCollapse(', '\nfunction requestRendererCollapse('),
    section('async function openIslandWorkspace(', "\nipcMain.handle('system:volume:get'"),
    section("ipcMain.handle('window:set-mode'", "\nipcMain.handle('window:begin-collapse'"),
    section("ipcMain.handle('window:begin-collapse'", "\nipcMain.handle('app:quit'"),
    section("ipcMain.on('appearance:surface'", "\nipcMain.handle('settings:set-feature'"),
  ].join('\n'), context);
  const appearance = () => ({ selectedId: preset, revision: appearanceRevision, presets: require(path.join(root, 'appearance-settings')).CATALOG });
  const status = { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [] };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(root, 'ai-tools')).CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': status, 'codex-float:get': status, 'window:metrics': metrics(),
    'workspace:get': { path: data }, 'workspace:load-data': {},
    'settings:get': { features: { todo: true, projects: true, notes: true, links: true, clip: false } },
    'transcription:get-config': {}, 'quick-launch:list': { items: [] }, 'tasks:recent': [],
    'island:activities-get': {}, 'computer:status': {}, 'weather:get': { ok: false },
  };
  for (const name of new Set([...fs.readFileSync(path.join(root, 'preload.js'), 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) {
    ipcMain.handle(name, (event, ...args) => {
      if (handlers.has(name)) return handlers.get(name)(event, ...args);
      if (name === 'appearance:get') return appearance();
      return responses[name] ?? null;
    });
  }
  for (const [name, callback] of listeners) ipcMain.on(name, (event, ...args) => {
    if (name === 'window:surface-ready' && holdReady) held.push(() => callback(event, ...args));
    else callback(event, ...args);
  });
  const evaluate = (window, code) => window.webContents.executeJavaScript(code);
  async function until(condition, message) {
    for (let i = 0; i < 250; i++) { if (await condition()) return; await wait(20); }
    assert.fail(message);
  }
  async function painted(window, selector) {
    const values = await evaluate(window, `(() => {const n=document.querySelector('${selector}');const s=getComputedStyle(n);return {opacity:s.opacity,width:n.getBoundingClientRect().width};})()`);
    assert.equal(values.opacity, '1', 'incoming content must already be fully painted');
    assert.ok(values.width > 100);
    const shape = native.inspect(window.getNativeWindowHandle());
    if (preset === 'system-glass-blurred') {
      assert.ok(shape, 'incoming native glass must exist before the source disappears');
      assert.equal(shape.width, width);
      const prepared = await evaluate(window, 'document.documentElement.dataset.cardMotion === "prepared"');
      assert.equal(shape.height, prepared ? (window === mainWindow ? 308 : 480) : (window === mainWindow ? 480 : 308));
      assert.equal(shape.opacity, 1);
    } else assert.equal(shape, null);
  }
  async function preparedCards(window, original) {
    const cards = await evaluate(window, `(() => {const items=[...document.querySelectorAll('[data-card-motion-item]')];return {state:document.documentElement.dataset.cardMotion,items:items.map(el=>{const r=el.getBoundingClientRect();return {key:el.matches('.quick-codex,#home-codex')?'codex':el.matches('.quick-note,.home-note')?'note':'pomodoro',x:r.x,y:r.y,width:r.width,height:r.height};})};})()`);
    assert.equal(cards.state, 'prepared', 'selected card motion must be staged before the old window disappears');
    assert.equal(cards.items.length, 3, 'all three shared cards participate');
    for (const item of cards.items) for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(item[key] - original.cards[item.key][key]) < 1.1, `${item.key}.${key} must start at its outgoing position`);
    }
  }
  async function evidence(window, name) {
    if (!process.env.FUDAO_MOTION_EVIDENCE) return;
    fs.mkdirSync(process.env.FUDAO_MOTION_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(process.env.FUDAO_MOTION_EVIDENCE, name + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await Promise.all([mainWindow.loadFile(path.join(root, 'renderer/index.html')), quickIslandWindow.loadFile(path.join(root, 'renderer/quick-island.html'))]);
    await until(() => evaluate(mainWindow, 'Boolean(window.prepareIslandSurface && window.notchAPI)'), 'renderer ready');
    mainWindow.showInactive();
    await evaluate(mainWindow, 'setMode(true)');
    await wait(450);
    for (const size of [1040, 1240]) for (const material of ['system-glass-blurred', 'classic']) {
      width = size; preset = material;
      appearanceRevision++;
      mainWindow.setBounds(bounds('expanded'));
      windows.forEach(window => window.webContents.send('appearance:changed', appearance()));
      await until(() => evaluate(mainWindow, `document.documentElement.dataset.appearance === '${preset}'`), 'material set');
      const homeSource = await evaluate(mainWindow, 'window.islandCardMotion.capture()');
      await evaluate(mainWindow, "document.getElementById('home-note').value='handoff draft'; document.getElementById('home-note').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('workspace-return-island').click()");
      await until(() => held.length > 0, 'quick renderer prepares its frame');
      assert.equal(context.currentMode, 'expanded');
      assert.equal(mainWindow.getOpacity(), 1, 'old workbench remains painted throughout preparation');
      assert.equal(await evaluate(mainWindow, "document.getElementById('app').classList.contains('closing')"), false, 'switching pages never collapses the outgoing workbench');
      assert.equal(quickIslandWindow.getOpacity(), 0);
      await preparedCards(quickIslandWindow, homeSource);
      await painted(quickIslandWindow, '.island-content');
      held.shift()();
      await until(() => context.currentMode === 'collapsed' && quickIslandWindow.getOpacity() === 1, 'quick handoff commits');
      if (size === 1040 && material === 'system-glass-blurred') { await wait(140); await evidence(quickIslandWindow, 'return-mid'); }
      await until(() => evaluate(mainWindow, "document.getElementById('app').classList.contains('collapsed')"), 'old renderer resets after handoff');
      await until(() => evaluate(quickIslandWindow, '!document.documentElement.dataset.cardMotion'), 'return card motion settles');
      assert.deepEqual(quickIslandWindow.getContentSize(), [size, 308], 'temporary animation canvas shrinks back to the quick view');
      assert.equal(await evaluate(quickIslandWindow, "document.getElementById('quick-note-input').value"), 'handoff draft');
      assert.equal(mainWindow.getOpacity(), 0, 'folded wings cannot flash over the quick view');
      assert.equal(context.quickIslandInteractive, false, 'return must not pin the quick view');
      assert.equal(context.quickIslandNativeFocusable, false);
      assert.equal(await evaluate(quickIslandWindow, "document.getElementById('quick-island').dataset.interactive"), 'false');

      const quickSource = await evaluate(quickIslandWindow, 'window.islandCardMotion.capture()');
      await evaluate(quickIslandWindow, "document.querySelector('[data-workspace=home]').click()");
      await until(() => held.length > 0, 'workbench renderer prepares its frame');
      assert.equal(quickIslandWindow.isVisible(), true);
      assert.equal(quickIslandWindow.getOpacity(), 1, 'old quick view remains painted until the workbench is ready');
      assert.equal(mainWindow.getOpacity(), 0);
      await preparedCards(mainWindow, quickSource);
      await painted(mainWindow, '.panels');
      held.shift()();
      await until(() => !quickIslandWindow.isVisible() && mainWindow.getOpacity() === 1, 'workbench handoff commits');
      if (size === 1040 && material === 'system-glass-blurred') { await wait(140); await evidence(mainWindow, 'workspace-mid'); }
      await until(() => evaluate(mainWindow, '!document.documentElement.dataset.cardMotion'), 'workbench card motion settles');
      assert.equal(await evaluate(mainWindow, 'document.querySelectorAll("[data-card-motion-placeholder], [data-card-motion-item]").length'), 0);
      assert.deepEqual(mainWindow.getContentSize(), [size, 480]);
      if (size === 1040 && material === 'system-glass-blurred') await evidence(mainWindow, 'workspace-final');
    }
    // Every quick navigation uses the same geometry handoff, including return
    // from a non-home page. No real content crosses the process boundary.
    for (const tab of ['todo', 'projects', 'codes', 'notes', 'links', 'recordings', 'credentials', 'settings']) {
      await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
      await until(() => held.length > 0, 'prepare quick view from ' + tab);
      held.shift()();
      await until(async () => await evaluate(quickIslandWindow, '!document.documentElement.dataset.cardMotion') && context.currentMode === 'collapsed', 'return settles');
      await evaluate(quickIslandWindow, `(() => {
        const button = document.querySelector('[data-workspace="${tab}"]');
        if (button) button.click();
        else void notchAPI.openIslandWorkspace('${tab}', islandCardMotion.capture());
      })()`);
      await until(() => held.length > 0, 'prepare ' + tab);
      assert.equal(await evaluate(mainWindow, 'document.documentElement.dataset.cardMotion'), 'prepared', tab + ' uses card reordering');
      assert.ok(await evaluate(mainWindow, 'document.querySelectorAll("[data-card-motion-item]").length > 0'));
      held.shift()();
      await until(() => !quickIslandWindow.isVisible() && mainWindow.getOpacity() === 1, tab + ' visible');
      if (process.env.FUDAO_MOTION_EVIDENCE) { await wait(140); await evidence(mainWindow, tab + '-handoff-mid'); }
      await until(() => evaluate(mainWindow, '!document.documentElement.dataset.cardMotion'), tab + ' settled');
      assert.equal(await evaluate(mainWindow, 'document.querySelector(".tab-panel.active").id'), 'tab-' + tab);
      assert.equal(await evaluate(mainWindow, 'document.querySelectorAll("[data-card-motion-placeholder], [data-card-motion-item]").length'), 0);
    }
    await evaluate(mainWindow, "setActiveTab('home')");
    await evaluate(mainWindow, 'cardReflow.whenIdle()');
    // OS reduced motion bypasses reordering in both directions, without a tall
    // transparent quick window remaining over the user's desktop.
    for (const window of windows) {
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
    await until(() => held.length > 0, 'reduced-motion quick preparation');
    assert.equal(await evaluate(quickIslandWindow, 'Boolean(document.documentElement.dataset.cardMotion)'), false);
    held.shift()();
    await until(() => context.currentMode === 'collapsed' && quickIslandWindow.getOpacity() === 1, 'reduced-motion quick visible');
    assert.deepEqual(quickIslandWindow.getContentSize(), [width, 308]);
    await evaluate(quickIslandWindow, "document.querySelector('[data-workspace=home]').click()");
    await until(() => held.length > 0, 'reduced-motion workbench preparation');
    assert.equal(await evaluate(mainWindow, 'Boolean(document.documentElement.dataset.cardMotion)'), false);
    held.shift()();
    await until(() => !quickIslandWindow.isVisible() && mainWindow.getOpacity() === 1, 'reduced-motion workbench visible');
    for (const window of windows) {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      window.webContents.debugger.detach();
    }
    // A hidden home card is never resurrected by the transition.
    await evaluate(mainWindow, "document.getElementById('home-codex').hidden=true;document.getElementById('workspace-return-island').click()");
    await until(() => held.length > 0, 'partial shared-card preparation');
    assert.equal(await evaluate(quickIslandWindow, 'document.querySelectorAll("[data-card-motion-item]").length'), 2);
    held.shift()();
    await until(() => evaluate(quickIslandWindow, '!document.documentElement.dataset.cardMotion'), 'partial card motion settles');
    await evaluate(mainWindow, "document.getElementById('home-codex').hidden=false");
    await evaluate(quickIslandWindow, "document.querySelector('[data-workspace=home]').click()");
    await until(() => held.length > 0, 'prepare moving workbench for interruption');
    held.shift()();
    await until(() => evaluate(mainWindow, 'document.documentElement.dataset.cardMotion === "playing"'), 'card motion actually starts');
    await evaluate(mainWindow, 'setMode(false)');
    await wait(100);
    assert.equal(context.currentMode, 'collapsed', 'Escape during motion must retain normal collapse');
    assert.equal(quickIslandWindow.isVisible(), false, 'interrupted motion must not resurrect the outgoing quick view');
    assert.equal(await evaluate(mainWindow, 'document.querySelectorAll("[data-card-motion-item], [data-card-motion-placeholder]").length'), 0);
    assert.deepEqual(mainWindow.getContentSize(), [256, 38]);
    await evaluate(mainWindow, 'setMode(true)');
    await wait(450);
    // Dismiss the source while its target is ready but before presentation.
    await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
    await until(() => held.length > 0, 'prepare cancelled quick view');
    handoff.cancel('dismissed');
    held.shift()();
    await wait(100);
    assert.equal(quickIslandWindow.isVisible(), false, 'late ready cannot reopen a cancelled destination');
    assert.equal(mainWindow.getOpacity(), 1);
    assert.equal(context.currentMode, 'expanded');
    assert.equal(await evaluate(mainWindow, "document.getElementById('app').classList.contains('expanded')"), true);
    await until(() => evaluate(mainWindow, "!document.getElementById('workspace-return-island').disabled"), 'return control restored');
    // A newer navigation must win while an old ready event is still in flight.
    await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
    await until(() => held.length > 0, 'quick ready for rapid navigation');
    held.shift()();
    await until(() => quickIslandWindow.getOpacity() === 1 && context.currentMode === 'collapsed', 'quick visible');
    await evaluate(quickIslandWindow, "document.querySelector('[data-workspace=home]').click()");
    await until(() => held.length > 0, 'first workspace navigation prepared');
    const staleReady = held.shift();
    const newer = context.openIslandWorkspace('notes');
    await until(() => held.length > 0, 'newer workspace navigation prepared');
    staleReady();
    await wait(50);
    assert.equal(mainWindow.getOpacity(), 0, 'stale ready cannot expose the previous destination');
    assert.equal(quickIslandWindow.getOpacity(), 1);
    held.shift()();
    assert.equal((await newer).ok, true);
    assert.equal(await evaluate(mainWindow, "document.querySelector('.tab-panel.active').id"), 'tab-notes');
    // Escape during preparation cancels the return and retains normal folding.
    await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
    await until(() => held.length > 0, 'prepare before escape');
    await evaluate(mainWindow, 'setMode(false)');
    held.shift()();
    await wait(100);
    assert.equal(context.currentMode, 'collapsed');
    assert.equal(quickIslandWindow.isVisible(), false, 'Escape must not be undone by a late quick frame');
    assert.deepEqual(mainWindow.getContentSize(), [256, 38]);
    // Exercise the real return handler, main pointer watch and renderer bridge.
    // The cursor may already be outside when return finishes, with no DOM leave.
    for (const material of ['system-glass-blurred', 'classic']) {
      preset = material; appearanceRevision++;
      windows.forEach(window => window.webContents.send('appearance:changed', appearance()));
      await evaluate(mainWindow, 'setMode(true)');
      await wait(450);
      await evaluate(mainWindow, "document.getElementById('workspace-return-island').click()");
      await until(() => held.length > 0, 'return for hover regression');
      pointer = { x: -100, y: -100 };
      held.shift()();
      await until(() => context.currentMode === 'collapsed', 'return commits in hover mode');
      await wait(300);
      assert.equal(context.quickIslandOutsideSince, 0, 'handoff must not consume the leave delay');
      assert.equal(quickIslandWindow.isVisible(), true, 'motion remains visible with cursor outside');
      await until(() => !handoff.isTarget(quickIslandWindow), 'return animation settles');
      await wait(200);
      pointer = { x: 200, y: 150 };
      await wait(500);
      assert.equal(quickIslandWindow.isVisible(), true, 're-entry cancels pending collapse');
      pointer = { x: -100, y: -100 };
      await until(() => !quickIslandWindow.isVisible(), 'returned quick view auto-hides without a DOM leave');
      assert.equal(mainWindow.getOpacity(), 1, 'collapsed island restored');
      assert.equal(native.inspect(quickIslandWindow.getNativeWindowHandle()), null, 'hidden glass cleared');
      assert.equal(await evaluate(quickIslandWindow, "document.getElementById('quick-island').dataset.visible"), 'false');
      pointer = { x: 200, y: 150 };
    }
    await context.showQuickIsland({ focus: true });
    pointer = { x: -100, y: -100 };
    await wait(700);
    assert.equal(quickIslandWindow.isVisible(), true, 'explicit keep-open still protects editing');
    assert.equal(context.quickIslandInteractive, true);
    context.hideQuickIsland(true);
    assert.deepEqual(errors, []);
    console.log('PASS window handoff and card reordering: real main/preload/renderers/native glass; both widths/themes, actual card origins, draft preservation, reduced motion, hidden modules, rapid navigation, cancellation Escape before/during motion, return auto-hide, re-entry cancellation and explicit keep-open.');
  } finally {
    holdReady = false;
    handoff.cancel();
    context.stopQuickIslandPointerWatch();
    appearanceNative.dispose();
    windows.forEach(window => window.destroy());
  }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
