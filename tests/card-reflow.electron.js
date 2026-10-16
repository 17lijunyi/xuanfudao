'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-reflow-'));
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const preload = path.join(root, 'preload.js');
  let width = 1040;
  let appearance = { selectedId: 'system-glass-blurred', revision: 0 };
  const errors = [], media = [], requests = [];
  const window = new BrowserWindow({ show: false, frame: false, width, height: 480,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const responses = {
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256 },
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'settings:get': { features: { clip: true } }, 'window-size:get': { selectedId: 'B', revision: 0 },
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(root, 'ai-tools')).CATALOG,
      state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [] },
    'projects:list': { ok: true, snapshot: { revision: 0, rootName: '测试目录', categories: [{ id: 'design', name: '设计', color: '#8bceff' }],
      entries: Array.from({ length: 6 }, (_, i) => ({ id: 'file-' + i, name: '项目 ' + i, kind: 'folder', category: i % 2 ? 'design' : '' })) } },
    'credentials:list': { items: [], secureStorage: true }, 'tasks:recent': [],
    'transcription:get-config': {}, 'island:activities-get': {}, 'computer:status': {},
  };
  for (const name of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]))) {
    ipcMain.handle(name, (event, ...args) => {
      requests.push(name);
      if (name === 'window:set-mode') { window.setSize(...(args[0] === 'expanded' ? [width, 480] : [256, 38])); return { ok: true, mode: args[0] }; }
      if (name === 'appearance:get') return appearance;
      if (name === 'appearance:set') {
        appearance = { selectedId: args[0], revision: appearance.revision + 1 };
        window.webContents.send('appearance:changed', appearance);
        return { ok: true, snapshot: appearance };
      }
      if (name.startsWith('media:')) media.push(name);
      return responses[name] ?? null;
    });
  }
  async function evaluate(code) {
    let timer;
    try {
      return await Promise.race([window.webContents.executeJavaScript(code), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Renderer check timed out: ' + code)), 10000);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function settle() {
    await evaluate(`(async () => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      await cardReflow.whenIdle();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  }
  async function open(tab) {
    if (process.env.FUDAO_REFLOW_TRACE) console.log('Checking', appearance.selectedId, width, tab);
    await evaluate(`setActiveTab(${JSON.stringify(tab)})`); await settle();
  }
  async function evidence(name) {
    if (!process.env.FUDAO_REFLOW_EVIDENCE) return;
    fs.mkdirSync(process.env.FUDAO_REFLOW_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(process.env.FUDAO_REFLOW_EVIDENCE, name + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  const geometry = `(() => [...document.querySelectorAll('[data-card-reflow]')].map(el => {
    const r = el.getBoundingClientRect(); return { key: cardReflow.key(el), x:r.x, y:r.y, width:r.width, height:r.height };
  }))()`;
  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source:
      "window.__motionErrors=[];addEventListener('error',e=>__motionErrors.push(e.message));addEventListener('unhandledrejection',e=>__motionErrors.push(String(e.reason)));" });
    await window.loadFile(path.join(root, 'renderer/index.html'));
    window.showInactive();
    await evaluate('setMode(true)'); await wait(500); await settle();
    await evaluate("window.__noteNode=document.getElementById('home-note');__noteNode.value='保留的动效草稿';__noteNode.dispatchEvent(new Event('input',{bubbles:true}));");
    for (const material of ['system-glass-blurred', 'classic']) for (const size of [1040, 1240]) {
      width = size; window.setSize(width, 480);
      appearance = { selectedId: material, revision: appearance.revision + 1 };
      window.webContents.send('appearance:changed', appearance);
      await open('home');
      if (material === 'system-glass-blurred' && width === 1040) await evidence('home');
      const nodes = await evaluate("[...document.querySelectorAll('#home-bento > [data-home-module]')].filter(el=>!el.hidden).length");
      await evaluate("setActiveTab('todo')");
      const start = await evaluate(geometry);
      assert.ok(start.length >= 2, `${material} ${width}: cards must start a spatial transition`);
      await wait(120);
      const middle = await evaluate(geometry);
      assert.ok(middle.some(b => { const a = start.find(c => c.key === b.key); return a && ['x','y','width','height'].some(k => Math.abs(a[k]-b[k]) > 1); }), 'real card bounds change between frames');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.quadrant')).transform"), 'none', 'text is never scaled');
      if (material === 'system-glass-blurred' && width === 1040) await evidence('todo-mid');
      await settle();
      assert.deepEqual(await evaluate(`(() => [...document.querySelectorAll('.quadrant')].flatMap(card => {
        const bounds = card.getBoundingClientRect();
        return [...card.querySelectorAll('.add-row > *')].filter(control => {
          const r = control.getBoundingClientRect();
          return r.left < bounds.left || r.right > bounds.right || r.bottom > bounds.bottom;
        }).map(control => ({ priority: card.dataset.priority, control: control.tagName, card: bounds.toJSON(), bounds: control.getBoundingClientRect().toJSON() }));
      }))()`), [], 'todo controls remain inside their cards after reordering');
      if (material === 'system-glass-blurred' && width === 1040) await evidence('todo-final');
      for (const tab of ['projects','codes','notes','links','recordings','credentials','clip','settings','home']) {
        await open(tab);
        if (material === 'system-glass-blurred' && width === 1040) await evidence(tab);
        assert.equal(await evaluate("document.querySelector('.tab-panel.active').id"), 'tab-' + tab);
        assert.equal(await evaluate("document.querySelectorAll('[data-reflow-placeholder], [data-card-reflow]').length"), 0, 'no temporary layout remains');
        assert.deepEqual(window.getSize(), [width, 480]);
      }
      assert.equal(await evaluate("document.getElementById('home-note')===__noteNode && __noteNode.value==='保留的动效草稿'"), true, 'real note control and draft survive every page');
      assert.equal(await evaluate("[...document.querySelectorAll('#home-bento > [data-home-module]')].filter(el=>!el.hidden).length"), nodes);
    }
    await open('projects');
    assert.equal(await evaluate("document.querySelectorAll('.pd-file').length"), 6);
    await evaluate("document.querySelector('[data-category=design]').click()");
    await settle();
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.pd-file')].map(el=>el.dataset.entry)"), ['file-1','file-3','file-5']);
    await evaluate("document.getElementById('pd-view').click()"); await settle();
    assert.equal(await evaluate("document.getElementById('project-drawer').dataset.view"), 'list');
    await open('codes');
    await evaluate("document.querySelector('[data-ai-id=\"claude-code\"]').click()"); await settle();
    assert.equal(await evaluate("document.querySelector('.ai-tools-confirm').hidden"), false);
    await evaluate("document.querySelector('[data-ai-action=back]').click()"); await settle();
    assert.equal(requests.includes('ai-tools:update'), false, 'previewing and cancelling do not select or scan a tool');
    await open('settings');
    await evaluate("document.querySelector('[data-appearance-preset=classic]').click()"); await settle();
    assert.equal(await evaluate("document.getElementById('settings-appearance-options').firstElementChild.dataset.appearancePreset"), 'classic');
    await open('home');
    await evaluate("setActiveTab('todo');setTimeout(()=>setActiveTab('notes'),30);setTimeout(()=>setActiveTab('settings'),60)");
    await wait(90); await settle();
    assert.equal(await evaluate("document.querySelector('.tab-panel.active').id"), 'tab-settings');
    await evaluate("setActiveTab('todo')");
    await evaluate('collapseImmediately()');
    assert.equal(await evaluate("document.querySelectorAll('[data-reflow-placeholder], [data-card-reflow]').length"), 0, 'collapse cleans up immediately');
    await evaluate('setMode(true)'); await wait(500); await settle();
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await open('todo');
    assert.equal(await evaluate("document.querySelectorAll('[data-reflow-placeholder], [data-card-reflow]').length"), 0);
    errors.push(...await evaluate('__motionErrors'));
    assert.deepEqual(errors, []);
    assert.deepEqual(media, [], 'navigation never requests camera or microphone access');
    console.log('PASS card reflow: all pages, both widths/materials, actual intermediate geometry, unscaled text, draft/DOM preservation, category/view selection, confirmation boundary, option order, interruption and reduced motion.');
  } finally { window.destroy(); }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
