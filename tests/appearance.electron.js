'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const appRoot = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const { createAppearanceSettingsService, CATALOG } = require(path.join(appRoot, 'appearance-settings.js'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-appearance-test-'));
const preferenceFile = path.join(userData, 'appearance.json');
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const preload = path.join(appRoot, 'preload.js');
  const windows = [];
  const writes = [];
  const mediaCalls = [];
  const surfaceUpdates = new Map();
  const surfaceHistory = [];
  let failNextWrite = false;
  let holdNextWrite = false;
  let releaseWrite;
  const fileSystem = { ...fs, promises: { ...fs.promises, rename: async (...args) => {
    if (failNextWrite) { failNextWrite = false; throw new Error('fixture_write_failure'); }
    return fs.promises.rename(...args);
  } } };
  let service = createAppearanceSettingsService({ filePath: preferenceFile, fs: fileSystem });
  const GiB = 1024 ** 3;
  const codeStatus = { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [], resets: { available: null } };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(appRoot, 'ai-tools')).CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': codeStatus, 'codex-float:get': codeStatus,
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'settings:get': { features: { todo: true, projects: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'transcription:get-config': { configured: false, llmConfigured: false },
    'credentials:list': { items: [], secureStorage: true }, 'tasks:recent': [],
    'quick-launch:list': { items: ['Finder', 'Safari', '邮件', '日历', '提醒事项', '备忘录', '终端', 'Codex'].map((name, index) => ({ id: `fixture-app-${index}`, name, icon: null })) },
    'system:status:get': { volume: { ok: true, volume: 37, muted: false }, brightness: { ok: true, brightness: 63 } },
    'island:activities-get': { recording: null, timer: { active: false, running: false, remainingSeconds: 1500, durationSeconds: 1500 } },
    'weather:get': { ok: true, city: '测试城市', temperature: 23, weatherCode: 2, weatherText: '多云', isDay: true, updatedAt: Date.now() },
    'computer:status': { updatedAt: Date.now(), platform: 'darwin', model: 'Fixture Mac', cpu: { percent: 21 },
      memory: { total: 32 * GiB, used: 25.8 * GiB, percent: 80.625, cached: 5.5 * GiB, compressed: 8.9 * GiB, pressure: 'normal', includesCache: false },
      disk: { total: 512 * GiB, used: 286.72 * GiB, available: 225.28 * GiB, percent: 56 },
      battery: { present: true, percent: 100, charging: false, onBattery: false }, network: { connected: true }, uptimeSeconds: 3600, load: [1] },
  };
  function broadcast(snapshot) {
    for (const window of windows) if (!window.isDestroyed()) window.webContents.send('appearance:changed', snapshot);
  }
  ipcMain.on('appearance:surface', (event, payload) => {
    surfaceUpdates.set(event.sender.id, payload);
    surfaceHistory.push({ sender: event.sender.id, payload });
  });
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === 'appearance:get') return service.getSnapshot();
      if (channel === 'appearance:set') {
        writes.push(args[0]);
        if (holdNextWrite) {
          holdNextWrite = false;
          await new Promise(resolve => { releaseWrite = resolve; });
        }
        const result = await service.setPreset(args[0]);
        if (result.ok) broadcast(result.snapshot);
        return result;
      }
      if (channel === 'window:set-mode') {
        BrowserWindow.fromWebContents(event.sender).setSize(...(args[0] === 'expanded' ? [1240, 654] : [256, 38]));
        return { ok: true, mode: args[0] };
      }
      if (channel === 'window:begin-collapse') return { ok: true };
      if (channel === 'media:camera' || channel === 'media:microphone') { mediaCalls.push(channel); return false; }
      return responses[channel] ?? null;
    });
  }

  const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  const workbench = new BrowserWindow({ show: false, frame: false, transparent: true, width: 1240, height: 654, webPreferences });
  const quick = new BrowserWindow({ show: false, frame: false, transparent: true, width: 1240, height: 308, webPreferences });
  windows.push(workbench, quick);
  workbench.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { mediaCalls.push(`permission:${permission}`); callback(false); });
  const evaluate = (window, code) => window.webContents.executeJavaScript(code);
  async function waitFor(window, code, message) {
    for (let i = 0; i < 200; i++) { if (await evaluate(window, code)) return; await wait(20); }
    assert.fail(message);
  }
  async function waitForSurface(window, predicate, message) {
    for (let i = 0; i < 200; i++) {
      const payload = surfaceUpdates.get(window.webContents.id);
      if (payload && predicate(payload)) return payload;
      await wait(20);
    }
    assert.fail(message);
  }
  async function load(window, filename) {
    await window.loadFile(path.join(appRoot, 'renderer', filename));
    window.showInactive();
    await waitFor(window, `document.documentElement.dataset.appearance === ${JSON.stringify(service.getSnapshot().selectedId)}`, `${filename} receives saved appearance`);
  }
  async function openTab(tab) {
    workbench.webContents.send('island:open-workspace', tab);
    await waitFor(workbench, `document.getElementById('app').classList.contains('expanded') && !modeBusy && !tabBusy && document.getElementById('tab-${tab}').classList.contains('active')`, `${tab} opens`);
    await waitFor(workbench, `getComputedStyle(document.querySelector('.panels')).opacity === '1'`, `${tab} content is fully visible`);
  }
  async function showQuick() {
    quick.webContents.send('quick-island:show', { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, interactive: true, version: 'test' });
    await waitFor(quick, `document.getElementById('quick-island').dataset.visible === 'true' && getComputedStyle(document.querySelector('.island-content')).opacity === '1'`, 'quick island opens');
  }
  async function waitForSelection(id) {
    for (const window of windows) await waitFor(window, `document.documentElement.dataset.appearance === ${JSON.stringify(id)}`, `${id} syncs to both renderers`);
    await waitFor(workbench, `document.getElementById('settings-appearance-options').getAttribute('aria-busy') === 'false' && document.querySelector('[data-appearance-preset="${id}"]').getAttribute('aria-checked') === 'true'`, `${id} finishes saving`);
    assert.equal(service.getSnapshot().selectedId, id);
  }
  async function choose(id) {
    await evaluate(workbench, `document.querySelector('[data-appearance-preset="${id}"]').click()`);
    await waitForSelection(id);
  }
  async function screenshot(window, name) {
    const directory = process.env.FUDAO_APPEARANCE_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  const geometryCode = selector => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height }; })()`;
  try {
    for (const window of windows) {
      await window.loadURL('about:blank');
      window.webContents.debugger.attach('1.3');
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    }
    await load(workbench, 'index.html');
    await load(quick, 'quick-island.html');
    await openTab('settings');
    await showQuick();
    await waitFor(workbench, `document.querySelectorAll('[data-appearance-preset]:not(:disabled)').length === 2`, 'both appearances are ready');
    assert.deepEqual(await evaluate(workbench, `[...document.querySelectorAll('[data-appearance-preset]')].map(button => button.dataset.appearancePreset)`), ['system-glass-blurred', 'classic']);
    const initialBounds = windows.map(window => window.getBounds());
    const initialPanel = await evaluate(workbench, geometryCode('#panel'));
    const initialQuick = await evaluate(quick, geometryCode('#quick-island'));
    assert.equal(await evaluate(quick, `document.querySelector('#quick-appearance-panel').hidden`), true, 'quick preferences start closed');
    await evaluate(quick, `document.querySelector('[data-quick-preference="appearance"]').click()`);
    await waitFor(quick, `!document.querySelector('#quick-appearance-panel').hidden && document.activeElement.dataset.appearancePreset === 'system-glass-blurred'`, 'quick appearance opens and focuses default glass');
    const popupFits = await evaluate(quick, `(() => { const p = document.querySelector('#quick-appearance-panel').getBoundingClientRect(); return p.left >= 0 && p.right <= innerWidth && p.bottom <= innerHeight; })()`);
    assert.equal(popupFits, true, 'quick appearance stays inside the native window');
    await screenshot(quick, 'quick-appearance-menu');
    await evaluate(quick, `document.querySelector('[data-appearance-preset="classic"]').click()`);
    await waitForSelection('classic');
    await evaluate(quick, `document.querySelector('[data-appearance-preset="system-glass-blurred"]').click()`);
    await waitForSelection('system-glass-blurred');
    await evaluate(quick, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await evaluate(quick, `document.querySelector('#quick-appearance-panel').hidden && document.activeElement.dataset.quickPreference === 'appearance' && document.querySelector('#quick-island').dataset.visible === 'true'`), true, 'Escape closes preferences and restores trigger focus without collapsing');
    await evaluate(quick, `document.querySelector('[data-quick-preference="size"]').click(); document.querySelector('[data-quick-preference="appearance"]').click()`);
    assert.equal(await evaluate(quick, `document.querySelector('#quick-size-panel').hidden && !document.querySelector('#quick-appearance-panel').hidden`), true, 'only one quick preference menu opens at a time');
    await evaluate(quick, `document.querySelector('.island-content').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    assert.equal(await evaluate(quick, `document.querySelector('#quick-appearance-panel').hidden`), true, 'clicking outside dismisses the quick menu');
    await evaluate(quick, `document.querySelector('[data-quick-preference="appearance"]').click(); window.QuickIsland.hide()`);
    assert.equal(await evaluate(quick, `document.querySelector('#quick-appearance-panel').hidden`), true, 'hiding the island clears the popup');
    await showQuick();
    const clippedChoices = await evaluate(workbench, `(() => {
      const card = document.querySelector('.settings-appearance-card').getBoundingClientRect();
      const viewport = document.querySelector('.settings-column-primary').getBoundingClientRect();
      return [...document.querySelectorAll('[data-appearance-preset]')].filter(button => {
        const r = button.getBoundingClientRect();
        return r.width <= 0 || r.height <= 0 || r.top < Math.max(card.top,viewport.top) || r.bottom > Math.min(card.bottom,viewport.bottom) || r.left < card.left || r.right > card.right || button.scrollWidth > button.clientWidth + 1;
      }).map(button => button.dataset.appearancePreset);
    })()`);
    assert.deepEqual(clippedChoices, [], 'the glass setting fits without clipping');

    for (const { id } of CATALOG) {
      await choose(id);
      assert.deepEqual(windows.map(window => window.getBounds()), initialBounds, `${id} does not resize native windows`);
      assert.deepEqual(await evaluate(workbench, geometryCode('#panel')), initialPanel, `${id} does not resize the workbench`);
      assert.deepEqual(await evaluate(quick, geometryCode('#quick-island')), initialQuick, `${id} does not resize the quick island`);
      for (const [window, selector] of [[workbench, '.panels'], [quick, '.island-content']]) {
        assert.equal(await evaluate(window, `getComputedStyle(document.querySelector('${selector}')).opacity`), '1', `${id} leaves text at full opacity`);
      }
      if (id.startsWith('system-glass')) {
        for (const [window, selector, pseudo] of [[workbench, '#app', '::before'], [quick, '#quick-island', '::after']]) {
          assert.deepEqual(await evaluate(window, `(() => {const s=getComputedStyle(document.querySelector('${selector}'),'${pseudo}'); return {width:s.width,background:s.backgroundColor,pointerEvents:s.pointerEvents};})()`), { width: '200px', background: 'rgb(0, 0, 0)', pointerEvents: 'none' }, `${id} preserves physical notch safety`);
        }
        for (const [window, expected] of [[workbench, initialPanel], [quick, initialQuick]]) {
          const payload = await waitForSurface(window, value => value.surface?.width === expected.width && value.surface?.height === expected.height && value.surface?.opacity === 1 && value.surface?.backgroundBlurRadius === (id === 'system-glass-blurred' ? 20 : 3), `${id} emits final visible native shape`);
          assert.deepEqual({ x: payload.surface.x, y: payload.surface.y, width: payload.surface.width, height: payload.surface.height }, expected);
          assert.ok([...Object.values(payload.viewport), payload.surface.opacity, ...payload.surface.radii].every(Number.isFinite), 'native material geometry is finite');
          assert.equal(payload.surface.backgroundBlurRadius, id === 'system-glass-blurred' ? 20 : 3, 'desktop blur comes from the shared CSS value without changing opacity');
          assert.deepEqual(payload.viewport, await evaluate(window, '({width:innerWidth,height:innerHeight})'));
        }
        assert.deepEqual(await evaluate(workbench, `(() => { const app=document.getElementById('app'); app.classList.add('opening'); const hidden=getComputedStyle(app,'::before').display; app.classList.remove('opening'); return {opening:hidden,expanded:getComputedStyle(app,'::before').display}; })()`), { opening: 'none', expanded: 'block' }, 'opening hides the physical notch layer before resize');
        assert.equal(await evaluate(workbench, 'getComputedStyle(document.documentElement).colorScheme'), 'light', 'transparent glass uses dark foreground controls');
        for (const [window, selectors] of [
          [workbench, ['.settings-card-heading strong', '.tile-label', '.appearance-option-caption strong']],
          [quick, ['.clock-time', '#quick-month', '#quick-timer-time', '#quick-note-input', '.module-kicker', '.quick-apps-edit']],
        ]) {
          const unreadable = await evaluate(window, `(${JSON.stringify(selectors)}).filter(selector => { const node=document.querySelector(selector); const color=node && getComputedStyle(node).color.match(/[\\d.]+/g); return !color || color.slice(0,3).some(value=>Number(value)>180); })`);
          assert.deepEqual(unreadable, [], `${id} uses darker readable text on clear glass`);
          const shadowed = await evaluate(window, `(${JSON.stringify(selectors)}).filter(selector => getComputedStyle(document.querySelector(selector)).textShadow !== 'none')`);
          assert.deepEqual(shadowed, [], `${id} keeps text sharp without glow or shadow`);
        }
      }
      if (id === 'classic') {
        for (const window of windows) await waitForSurface(window, payload => payload.surface === null, 'classic disables native glass');
        const label = await evaluate(workbench, `getComputedStyle(document.querySelector('.appearance-option-caption strong')).color.match(/[\\d.]+/g).slice(0,3).map(Number)`);
        assert.ok(label.every(value => value >= 200), 'classic option labels stay readable on black');
        for (const [window, selector] of [[workbench, '#panel'], [quick, '#quick-island']]) {
          assert.deepEqual(await evaluate(window, `(() => {const s=getComputedStyle(document.querySelector('${selector}'),'::before');return {background:s.backgroundColor,image:s.backgroundImage,blur:s.backdropFilter};})()`),
            {background:'rgb(0, 0, 0)',image:'none',blur:'none'}, 'pure black has an opaque shell and no glass filtering');
        }
        await screenshot(workbench, 'classic-settings');
        await screenshot(quick, 'classic-quick');
        await openTab('home');
        await screenshot(workbench, 'classic-home');
        await openTab('settings');
        const restored = createAppearanceSettingsService({ filePath: preferenceFile });
        assert.equal(restored.getSnapshot().selectedId, 'classic', 'explicit black choice survives restart');
      }
      if (id.startsWith('system-glass')) {
        await screenshot(workbench, id + '-settings');
        await screenshot(quick, id + '-quick');
        await openTab('home');
        await evaluate(workbench, `window.NotchHome.setModuleVisible('windows', true)`);
        await wait(80);
        assert.equal(await evaluate(workbench, `getComputedStyle(document.querySelector('.home-pomodoro'), '::before').content`), 'none', 'timer has no second orange frame');
        assert.deepEqual(await evaluate(quick, `(() => {const b=document.querySelector('.note-save');const s=getComputedStyle(b);const root=getComputedStyle(document.documentElement);return {color:s.color,background:s.backgroundColor};})()`), { color: 'rgb(8, 10, 12)', background: 'rgba(255, 255, 255, 0.1)' }, 'save button shares the neutral glass palette');
        await screenshot(workbench, id + '-home');
        await openTab('settings');
      }
    }

    // Keep only the latest choice while an earlier write is delayed.
    holdNextWrite = true;
    await evaluate(workbench, `document.querySelector('[data-appearance-preset="system-glass-blurred"]').click()`);
    for (let i = 0; i < 100 && !releaseWrite; i++) await wait(10);
    assert.equal(typeof releaseWrite, 'function', 'fixture holds the first appearance save');
    await evaluate(workbench, `document.querySelector('[data-appearance-preset="classic"]').click()`);
    assert.equal(await evaluate(workbench, 'document.documentElement.dataset.appearance'), 'classic', 'last click remains previewed during an earlier save');
    releaseWrite();
    await waitForSelection('classic');
    assert.equal(JSON.parse(fs.readFileSync(preferenceFile)).selectedId, 'classic', 'last rapid choice is persisted');

    // A failed save restores both the UI and native surface instead of leaving
    // a translucent preview behind an opaque persisted preference.
    failNextWrite = true;
    await evaluate(workbench, `document.querySelector('[data-appearance-preset="system-glass-blurred"]').click()`);
    await waitFor(workbench, `document.getElementById('settings-appearance-note').dataset.state === 'error'`, 'save failure is surfaced');
    await waitForSelection('classic');
    for (const window of windows) await waitForSurface(window, payload => payload.surface === null, 'failed glass preview releases native surface');
    await choose('system-glass-blurred');
    const current = service.getSnapshot();
    broadcast({ ...current, selectedId: 'classic', revision: current.revision - 1 });
    await wait(50);
    await waitForSelection('system-glass-blurred');

    const rejected = await evaluate(workbench, `window.notchAPI.setAppearancePreset('system-glass')`);
    assert.equal(rejected.ok, false, 'removed clear glass cannot be selected via IPC');
    assert.equal(service.getSnapshot().selectedId, 'system-glass-blurred');
    fs.writeFileSync(preferenceFile, JSON.stringify({ version: 1, selectedId: 'system-glass' }));
    service = createAppearanceSettingsService({ filePath: preferenceFile, fs: fileSystem });
    await load(workbench, 'index.html');
    await load(quick, 'quick-island.html');
    await openTab('settings');
    await showQuick();
    await waitForSelection('system-glass-blurred');
    assert.equal(await evaluate(workbench, `document.querySelector('[data-appearance-preset="system-glass"]') === null`), true);
    const groups = await evaluate(quick, `Array.from(document.querySelectorAll('.island-content > section')).filter(n => !n.hidden).map(n => { const s=getComputedStyle(n); return {radius:parseFloat(s.borderRadius), shadow:s.boxShadow, width:n.getBoundingClientRect().width}; })`);
    assert.equal(groups.length, 6);
    assert.ok(groups.every(g => g.radius >= 16 && g.shadow !== 'none' && g.width > 100), 'all six functions have separate rounded frames');
    for (const [window, selector] of [[quick,'.island-nav button'],[workbench,'.tab:not([hidden])']]) {
      const frames = await evaluate(window, `Array.from(document.querySelectorAll('${selector}')).map(n=>getComputedStyle(n).boxShadow)`);
      assert.ok(frames.length >= 4 && frames.every(s => s !== 'none'), 'navigation entries have individual frames');
    }
    assert.equal(await evaluate(quick, `document.querySelector('.island-brand').textContent.includes('悬浮岛')`), true, 'brand uses full product name');
    await openTab('codes');
    await waitFor(workbench, `Array.from(document.querySelectorAll('.ai-tool-copy strong')).some(n=>n.textContent==='MiMo Code')`, 'MiMo Code card loads');
    await screenshot(workbench, 'system-codes');

    await evaluate(workbench, 'setMode(false)');
    await waitFor(workbench, `document.getElementById('app').classList.contains('collapsed') && !modeBusy`, 'workbench collapses');
    const collapsed = await evaluate(workbench, geometryCode('#notch'));
    assert.equal(collapsed.width, 256, 'collapsed island stays 256 px wide');
    assert.equal(collapsed.height, 38, 'collapsed island stays at menu bar height');
    await waitForSurface(workbench, payload => payload.viewport?.width === 256 && payload.viewport?.height === 38 && payload.surface === null, 'collapsed island has no native glass material');
    assert.deepEqual(await evaluate(workbench, `(() => { const s=getComputedStyle(document.getElementById('notch')); return {background:s.backgroundColor,shadow:s.boxShadow}; })()`), {background:'rgb(0, 0, 0)',shadow:'none'}, 'the whole collapsed island including both wings remains pure black');
    assert.equal(await evaluate(workbench, `getComputedStyle(document.querySelector('.codex-notch-quota')).color`), 'rgb(237, 237, 237)', 'collapsed quota remains white');
    assert.ok(surfaceHistory.filter(entry => entry.sender === workbench.webContents.id && entry.payload.viewport?.width === 256).every(entry => !entry.payload.surface), 'collapsed viewport never receives any glass shape');
    quick.webContents.send('quick-island:hide', { reason: 'explicit' });
    await waitFor(quick, `document.getElementById('quick-island').dataset.visible === 'false'`, 'quick island collapses');
    await waitForSurface(quick, payload => payload.surface === null, 'hidden quick island clears native material');
    assert.deepEqual(mediaCalls, [], 'appearance selection never requests camera or microphone');
    console.log('PASS appearance: soft-glass default, pure black, legacy migration, clear-glass rejection, rounded navigation and six groups, deep text, full product name, MiMo Code, geometry, preload sync, notch safety, full-opacity content and collapse');
  } finally { for (const window of windows) if (!window.isDestroyed()) window.destroy(); }
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
