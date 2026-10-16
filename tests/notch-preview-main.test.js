const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing main-process section: ${start}`);
  return source.slice(from, to);
}

test('display reposition preserves an active compact preview and refreshes its metrics', () => {
  const calls = [];
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    mainWindow: {
      isDestroyed: () => false,
      setBounds: (bounds) => calls.push(['bounds', bounds]),
      webContents: { send: (channel, payload) => calls.push(['send', channel, payload]) },
    },
    currentMode: 'collapsed',
    workbenchOpeningUntil: 0,
    notchPreviewActive: true,
    hideQuickIsland: (immediate) => calls.push(['hide-quick', immediate]),
    getBoundsForMode: (mode, display) => ({ mode, display }),
    getLayoutMetrics: (display) => ({ display }),
    display: { id: 8 },
  };
  vm.runInNewContext(`${section('function repositionWindow(', '\nfunction beginNativeCollapse(')}\nrepositionWindow(display);`, context);
  assert.deepEqual(calls, [
    ['hide-quick', true],
    ['bounds', { mode: 'preview', display: { id: 8 } }],
    ['send', 'window:metrics-changed', { display: { id: 8 } }],
  ]);
});

test('system or notification interruption atomically retracts the preview surface', () => {
  const calls = [];
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    notchPreviewActive: true,
    currentMode: 'collapsed',
    mainWindow: {
      isDestroyed: () => false,
      setBounds: (bounds) => calls.push(['bounds', bounds]),
      webContents: {
        isDestroyed: () => false,
        send: (channel) => calls.push(['send', channel]),
      },
    },
    getBoundsForMode: (mode) => ({ mode }),
    result: null,
  };
  vm.runInNewContext(`${section('function dismissNotchPreviewSurface(', '\nfunction stopQuickIslandPointerWatch(')}\nresult = dismissNotchPreviewSurface();`, context);
  assert.equal(context.result, true);
  assert.equal(context.notchPreviewActive, false);
  assert.deepEqual(calls, [
    ['bounds', { mode: 'collapsed' }],
    ['send', 'window:request-collapse'],
  ]);
});

test('large quick island cannot open over the compact hover preview', () => {
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    isQuitting: false,
    mainWindow: { isDestroyed: () => false, isVisible: () => true },
    currentMode: 'collapsed',
    workbenchOpeningUntil: 0,
    notchPreviewActive: true,
    activeTaskNotification: null,
    notificationWindow: null,
    result: null,
  };
  vm.runInNewContext(`${section('function canShowQuickIsland(', '\nfunction dismissNotchPreviewSurface(')}\nresult = canShowQuickIsland();`, context);
  assert.equal(context.result, false);
  context.notchPreviewActive = false;
  vm.runInNewContext('result = canShowQuickIsland();', context);
  assert.equal(context.result, true);
});

test('compact preview cannot steal a quick-island request while its HTML is loading', async () => {
  let handler = null;
  let resized = false;
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    ipcMain: { handle: (channel, callback) => { if (channel === 'window:set-mode') handler = callback; } },
    isIslandSender: () => true,
    mainWindow: { isDestroyed: () => false, setBounds: () => { resized = true; } },
    currentMode: 'collapsed',
    quickIslandOpening: 1,
    workbenchOpeningUntil: 0,
    activeTaskNotification: null,
    notificationWindow: null,
    quickIslandWindow: null,
    notchPreviewActive: false,
    getBoundsForMode: () => ({ width: 256, height: 56 }),
    islandPasteTargetPrepared: null,
    rememberPasteTarget: async () => {},
    applyMode: () => {},
  };
  vm.runInNewContext(section("ipcMain.handle('window:set-mode'", "\nipcMain.handle('window:begin-collapse'"), context);
  assert.equal(typeof handler, 'function');
  const result = await handler({}, 'preview');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'preview_unavailable');
  assert.equal(resized, false);
  assert.equal(context.notchPreviewActive, false);
});

test('a quick-island opening reserves the surface until delayed HTML loading finishes', async () => {
  const calls = [];
  let directFeedback = false;
  let release;
  let releaseSecondSync;
  let syncCount = 0;
  const loading = new Promise((resolve) => { release = resolve; });
  const secondSync = new Promise((resolve) => { releaseSecondSync = resolve; });
  const target = {
    isDestroyed: () => false,
    isVisible: () => false,
    setBounds: (bounds) => calls.push(['bounds', bounds]),
    setAlwaysOnTop: (...args) => calls.push(['level', ...args]),
    setFocusable: (value) => calls.push(['focusable', value]),
    show: () => calls.push(['show']),
    focus: () => calls.push(['focus']),
    showInactive: () => calls.push(['show-inactive']),
    webContents: { send: (channel) => calls.push(['send', channel]), focus: () => calls.push(['web-focus']) },
  };
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    canShowQuickIsland: () => true,
    statusIsland: { syncForAppSurface: async () => {
      syncCount += 1;
      calls.push(['sync-app-surface', directFeedback ? 'direct' : 'passive']);
      if (syncCount === 2) await secondSync;
    } },
    quickIslandOpening: 0,
    quickIslandInteractive: false,
    quickIslandNativeFocusable: false,
    quickIslandGeneration: 0,
    quickIslandHideTimer: null,
    clearTimeout,
    getWindowDisplay: () => ({ id: 8 }),
    createQuickIslandWindow: () => loading,
    getCollapsedHeight: () => 38,
    getMenuBarHeight: () => 34,
    getQuickIslandBounds: () => ({ x: 1, y: 2, width: 1240, height: 270 }),
    COLLAPSED_WIDTH: 256,
    app: { getVersion: () => 'test' },
    islandActivities: {},
    systemStatus: { getSnapshot: () => Promise.resolve({}) },
    setCollapsedIslandCovered: () => {},
    startQuickIslandPointerWatch: () => calls.push(['pointer-watch']),
    resultPromise: null,
  };
  vm.runInNewContext(`${section('async function showQuickIsland(', '\nfunction cancelCollapseWatchdog(')}\nresultPromise = showQuickIsland({ focus: false });`, context);
  assert.equal(context.quickIslandOpening, 1, 'status heartbeat must see the surface reservation while loadFile is pending');
  assert.deepEqual(calls, [['sync-app-surface', 'passive']]);
  directFeedback = true;
  release(target);
  while (syncCount < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.quickIslandOpening, 1,
    'the surface reservation must remain held while the final status arbitration is pending');
  releaseSecondSync();
  const result = await context.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.interactive, false);
  assert.deepEqual(calls.find(([name]) => name === 'level'), ['level', true, 'screen-saver', 1]);
  assert.equal(context.quickIslandOpening, 0);
  assert.equal(calls.filter(([name]) => name === 'sync-app-surface').length, 2,
    'the central status policy must run again immediately before the loaded island is shown');
  assert.deepEqual(calls.filter(([name]) => name === 'sync-app-surface').at(-1), ['sync-app-surface', 'direct'],
    'direct media-key feedback arriving during load must be reconsidered instead of being consumed');
  assert.ok(calls.findIndex(([name]) => name === 'sync-app-surface') < calls.findIndex(([name]) => name === 'show-inactive'));
  assert.match(source, /passiveAllowed:\s*quickIslandOpening === 0 && canShowQuickIsland\(\)/,
    'persistent status policy must honor the opening reservation');
});

test('a completion notification can cancel quick-island opening during final status arbitration', async () => {
  let syncCount = 0;
  let releaseFinalSync;
  const finalSync = new Promise((resolve) => { releaseFinalSync = resolve; });
  let shown = false;
  const target = {
    isDestroyed: () => false,
    isVisible: () => false,
    setBounds: () => {}, setFocusable: () => {}, focus: () => {},
    show: () => { shown = true; }, showInactive: () => { shown = true; },
    webContents: { send: () => {} },
  };
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    canShowQuickIsland: () => true,
    statusIsland: { syncForAppSurface: async () => {
      syncCount += 1;
      if (syncCount === 2) await finalSync;
    } },
    quickIslandOpening: 0,
    quickIslandInteractive: false,
    quickIslandNativeFocusable: false,
    quickIslandGeneration: 0,
    quickIslandHideTimer: null,
    clearTimeout,
    getWindowDisplay: () => ({ id: 8 }),
    createQuickIslandWindow: async () => target,
    getCollapsedHeight: () => 38,
    getMenuBarHeight: () => 34,
    getQuickIslandBounds: () => ({ x: 1, y: 2, width: 1240, height: 270 }),
    COLLAPSED_WIDTH: 256,
    app: { getVersion: () => 'test' },
    islandActivities: {},
    systemStatus: { getSnapshot: () => Promise.resolve({}) },
    setCollapsedIslandCovered: () => {},
    startQuickIslandPointerWatch: () => {},
    resultPromise: null,
  };
  vm.runInNewContext(`${section('async function showQuickIsland(', '\nfunction cancelCollapseWatchdog(')}\nresultPromise = showQuickIsland({ focus: false });`, context);
  while (syncCount < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.quickIslandOpening, 1);
  context.quickIslandGeneration += 1; // showNextTaskNotification -> hideQuickIsland(true)
  releaseFinalSync();
  const result = await context.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'island_unavailable');
  assert.equal(shown, false, 'a cancelled quick island must never appear over the completion notification');
  assert.equal(context.quickIslandOpening, 0);
});

test('opening the full workbench reserves the status surface across paste-target preparation', async () => {
  const calls = [];
  let release;
  const preparing = new Promise((resolve) => { release = resolve; });
  const target = {
    isDestroyed: () => false,
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: { send: (channel, tab) => calls.push([channel, tab]) },
  };
  const context = {
    systemUIBlocks: () => false,
    getBoundsForMode: () => ({}),
    QUICK_ISLAND_WORKSPACE_TABS: new Set(['home']),
    mainWindow: target,
    quickIslandWindow: null,
    windowHandoff: require('../window-handoff').createWindowHandoffController(),
    isQuitting: false,
    workbenchOpeningRevision: 0,
    workbenchOpeningUntil: 0,
    hideQuickIsland: (immediate) => calls.push(['hide-quick', immediate]),
    statusIsland: {
      syncForAppSurface: async () => { calls.push(['sync-app-surface']); },
      sync: () => calls.push(['sync-status']),
    },
    currentMode: 'collapsed',
    rememberPasteTarget: () => preparing,
    islandPasteTargetPrepared: null,
    hideWhenCollapsed: true,
    resultPromise: null,
  };
  vm.runInNewContext(`${section('async function openIslandWorkspace(', "\nipcMain.handle('quick-island:open-workspace'")}\nresultPromise = openIslandWorkspace('home');`, context);
  assert.ok(context.workbenchOpeningUntil > Date.now(),
    'the persistent status heartbeat must be blocked before the async paste-target read');
  assert.deepEqual(calls.slice(0, 2), [['hide-quick', true], ['sync-app-surface']]);
  release();
  const result = await context.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(context.islandPasteTargetPrepared.window, target);
  assert.ok(context.workbenchOpeningUntil > Date.now(),
    'the reservation must remain until the renderer confirms expanded mode');
  assert.deepEqual(calls.slice(-3), ['show', 'focus', ['island:open-workspace', 'home']]);
  assert.match(section('function canShowQuickIsland(', '\nfunction dismissNotchPreviewSurface('), /Date\.now\(\) >= workbenchOpeningUntil/);
  assert.match(source, /Date\.now\(\) < workbenchOpeningUntil \|\| activeTaskNotification/,
    'compact preview requests must also yield while an explicit workbench opening is pending');
  assert.match(section('function applyMode(', '\nfunction repositionWindow('), /workbenchOpeningUntil = 0/,
    'expanded mode must release the reservation after hiding the status surface');
});

test('preview checks its full height instead of only the menu-bar strip', async () => {
  let handler;
  const context = {
    ipcMain: { handle: (channel, callback) => { if (channel === 'window:set-mode') handler = callback; } },
    isIslandSender: () => true,
    mainWindow: { isDestroyed: () => false, setBounds: () => assert.fail('blocked preview must not resize') },
    currentMode: 'collapsed',
    getBoundsForMode: mode => ({ height: mode === 'preview' ? 56 : 34 }),
    systemUIBlocks: bounds => bounds.height > 34,
  };
  vm.runInNewContext(section("ipcMain.handle('window:set-mode'", "\nipcMain.handle('window:begin-collapse'"), context);
  const result = await handler({}, 'preview');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'preview_unavailable');
});
