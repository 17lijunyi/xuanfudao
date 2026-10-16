const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { installProjectDrawer } = require(path.join(root, 'project-drawer-electron'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-drawer-ui-'));
const desktop = path.join(base, 'Desktop');
const collection = path.join(desktop, '全部文件');
const userData = path.join(base, 'userData');
fs.mkdirSync(collection, { recursive: true });
fs.mkdirSync(userData);
for (const name of ['github', '悬浮岛', '个人网站', '写作', '项目灵感', 'Skill', '美甲', '项目', '个人知识库', '高端穿戴甲', '黑客松', '幻想之境']) fs.mkdirSync(path.join(collection, name));
fs.writeFileSync(path.join(collection, '<测试文件>.txt'), 'unchanged');
app.setPath('userData', userData); app.setPath('desktop', desktop);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let workspace, quick;
async function main() {
  await app.whenReady();
  const preload = path.join(root, 'preload.js');
  const options = { show: false, frame: false, webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } };
  workspace = new BrowserWindow({ ...options, width: 256, height: 38 });
  quick = new BrowserWindow({ ...options, width: 1240, height: 270 });
  const opened = [], revealed = [], requests = [];
  let chosen = { canceled: true, filePaths: [] };
  const dialogs = [];
  installProjectDrawer({ app, ipcMain, powerMonitor,
    shell: { openPath: async (file) => { opened.push(file); return ''; }, showItemInFolder: (file) => revealed.push(file) },
    isSender: (event) => event.sender === workspace.webContents && event.senderFrame === workspace.webContents.mainFrame,
    chooseDirectory: async (options) => { dialogs.push(options); return chosen; },
    onChange: (snapshot) => { if (!workspace.isDestroyed()) workspace.webContents.send('projects:changed', snapshot); },
  });
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require('../ai-tools').CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': { providerId: 'codex', selectionRevision: 0, connection: 'connected', windows: [{ limitId: 'codex', remainingPercent: 84 }], threads: [] },
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'workspace:get': { path: userData }, 'workspace:load-data': {}, 'settings:get': { features: { clip: false } },
    'codex-float:get': { providerId: 'codex', connection: 'connected', windows: [{ limitId: 'codex', remainingPercent: 84 }], threads: [], resets: { available: null } },
    'windows:list': { items: [] }, 'credentials:list': { items: [] }, 'tasks:recent': [], 'quick-launch:list': { items: [] },
  };
  for (const channel of [...new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))]) {
    if (channel.startsWith('projects:')) continue;
    ipcMain.handle(channel, async (_event, ...args) => {
      requests.push({ channel, args });
      if (channel === 'window:set-mode') { workspace.setSize(...(args[0] === 'expanded' ? [1240, 480] : [256, 38])); return { ok: true, mode: args[0] }; }
      if (channel === 'quick-island:open-workspace') { workspace.webContents.send('island:open-workspace', args[0]); return { ok: true }; }
      if (channel.startsWith('quick-island:')) return { ok: true };
      return responses[channel] ?? null;
    });
  }
  const evaluate = (code, w = workspace) => w.webContents.executeJavaScript(code).catch(error => {
    console.error('Renderer evaluation failed:', code);
    throw error;
  });
  async function waitFor(condition, label, w = workspace) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await evaluate(condition, w)) return; await sleep(30); }
    console.error(await evaluate(`({app:document.getElementById('app')?.className,active:document.querySelector('.tab.active')?.dataset.tab,title:document.getElementById('pd-title')?.textContent,count:document.querySelectorAll('#pd-files [data-entry]').length,message:document.getElementById('pd-message')?.textContent})`));
    console.error(requests.slice(-12));
    throw new Error(label);
  }
  async function click(selector, w = workspace, modifiers = 0, clickCount = 1, offset = null) {
    await evaluate('window.cardReflow?.whenIdle()', w);
    const point = await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw Error('missing node');
      node.scrollIntoView({block:'nearest'}); const box = node.getBoundingClientRect(); const offset=${JSON.stringify(offset)}; const x=box.x+(offset?.x??box.width/2),y=box.y+(offset?.y??box.height/2);
      const hit=document.elementFromPoint(x,y);
      if(node.disabled || node.closest('[inert]') || !box.width || !(node===hit || node.contains(hit))) throw Error('unreachable '+${JSON.stringify(selector)}+' '+hit?.outerHTML.slice(0,160));
      return {x,y}; })()`, w);
    await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount, modifiers });
    await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount, modifiers });
    await sleep(35);
  }
  function input(id, value) { return evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value=${JSON.stringify(value)}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`); }
  async function key(key, code, modifiers = 0) {
    await workspace.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers });
    await workspace.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
    await sleep(40);
  }
  async function waitIdle() { await waitFor(`document.getElementById('project-drawer').getAttribute('aria-busy')==='false'`, 'drawer never becomes idle'); }
  const errors = [];
  workspace.webContents.on('console-message', (_event, _level, message) => { if (String(message).includes('Uncaught')) errors.push(message); });
  workspace.webContents.debugger.attach('1.3'); quick.webContents.debugger.attach('1.3');
  await workspace.loadFile(path.join(root, 'renderer/index.html'));
  await quick.loadFile(path.join(root, 'renderer/quick-island.html'));
  quick.webContents.send('quick-island:show', { interactive: true, width: 1240, height: 270, stripHeight: 38 });
  await sleep(250);
  const quota = await evaluate(`(() => { const n=document.querySelector('.codex-notch-quota strong'); const b=n.getBoundingClientRect(); const p=n.closest('.codex-notch').getBoundingClientRect(); return {text:n.textContent,left:b.left-p.left,right:b.right-p.left,width:p.width}; })()`);
  assert.equal(quota.text, '84%'); assert.equal(quota.width, 256); assert.ok(quota.left >= 3 && quota.right <= 28, JSON.stringify(quota));
  assert.equal(await evaluate(`window.notchAPI.listProjectDrawer().then(r=>r.ok)`, quick), false, 'quick window cannot access file actions');
  await click('[data-workspace="projects"]', quick);
  await waitFor(`document.querySelector('#tab-projects.active') && document.querySelectorAll('#pd-files [data-entry]').length===13`, 'drawer route or directory scan failed');
  await waitIdle(); await sleep(300);
  assert.equal(await evaluate(`document.getElementById('tab-button-todo').nextElementSibling.id`), 'tab-button-projects');
  assert.equal(await evaluate(`document.querySelectorAll('#pd-files img').length`), 0, 'filenames must be text, not HTML');
  const selection = () => evaluate(`[...document.querySelectorAll('#pd-files .is-selected')].map(n=>n.dataset.entry)`);
  await click('#pd-files .pd-file:nth-child(1) input');
  await click('#pd-files .pd-file:nth-child(2) input');
  assert.equal((await selection()).length, 2, 'successive checkbox clicks should accumulate');
  await click('#pd-files .pd-file:nth-child(3) .pd-file-name');
  assert.equal((await selection()).length, 3, 'clicking another card must retain the two already selected');
  await click('#pd-files .pd-file:nth-child(2) .pd-file-name');
  assert.equal((await selection()).length, 2, 'clicking a selected card removes only that card');
  await click('#pd-files .pd-file:nth-child(4) .pd-select-hit', workspace, 0, 1, {x:2,y:2});
  assert.equal((await selection()).length, 3, 'enlarged checkbox hit area toggles only once');
  await click('#pd-clear');
  await click('#pd-files .pd-file:nth-child(1) .pd-file-name');
  await click('#pd-files .pd-file:nth-child(5) .pd-file-name', workspace, 8);
  assert.equal((await selection()).length, 5, 'Shift selects the contiguous range');
  await click('#pd-clear');
  await evaluate(`document.querySelector('#pd-files .pd-file:nth-child(2)').focus()`);
  await key(' ', 'Space');
  assert.equal((await selection()).length, 1, 'Space on a card selects instead of collapsing the app');
  assert.equal(await evaluate(`document.querySelector('#app.expanded')!==null`), true);
  await key('a', 'KeyA', 4);
  assert.equal((await selection()).length, 13, 'Command+A selects the current list');
  await click('#pd-clear');
  await input('pd-search', 'github'); await evaluate(`document.getElementById('pd-search').focus()`); await key('a', 'KeyA', 4);
  assert.equal((await selection()).length, 0, 'Command+A in search must not select files');
  await input('pd-search', '');
  await click('#pd-files .pd-file:nth-child(3) .pd-file-name');
  await click('#pd-files .pd-file:nth-child(3) .pd-file-name', workspace, 0, 2);
  await waitIdle();
  assert.equal(opened.length, 1, 'double-click still opens once');
  assert.equal((await selection()).length, 1, 'double-click keeps the opened card selected');
  opened.length = 0;
  await click('#pd-files .pd-file:nth-child(4) .pd-file-name');
  const chosenIds = await selection();
  assert.equal(chosenIds.length, 2);
  await evaluate(`document.getElementById('pd-target').value='development';document.getElementById('pd-target').dispatchEvent(new Event('change'))`);
  await click('#pd-assign'); await waitIdle();
  const partial = await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)');
  assert.deepEqual(partial.entries.filter(e=>e.category==='development').map(e=>e.id).sort(), chosenIds.sort(), 'batch action applies exactly the chosen cards');
  await click('#pd-undo'); await waitIdle();
  await click('#pd-view');
  await click('#pd-files .pd-file:nth-child(1) .pd-file-name');
  await click('#pd-files .pd-file:nth-child(2) .pd-file-name');
  assert.equal((await selection()).length, 2, 'list view supports the same successive multiselection');
  await click('#pd-clear'); await click('#pd-view');
  await click('#pd-add'); await input('pd-name', '客户项目'); await click('#pd-save');
  await waitFor(`!document.getElementById('pd-editor').open`, 'create category dialog did not close');
  let snapshot = await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)');
  const category = snapshot.categories.find((c) => c.name === '客户项目').id;
  await click('#pd-all');
  await evaluate(`document.getElementById('pd-target').value=${JSON.stringify(category)};document.getElementById('pd-target').dispatchEvent(new Event('change'))`);
  await click('#pd-assign'); await waitIdle();
  snapshot = await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)');
  assert.ok(snapshot.entries.every((e) => e.category === category));
  await click(`[data-category="${category}"]`); await click('#pd-edit'); await input('pd-name', '客户资料'); await click('#pd-save');
  await waitFor(`document.getElementById('pd-title').textContent==='客户资料' && !document.getElementById('pd-editor').open`, 'rename failed');
  await click('#pd-edit'); await click('#pd-delete'); await waitIdle();
  await waitFor(`!document.getElementById('pd-editor').open`, 'delete dialog stayed open');
  assert.equal(await evaluate(`document.getElementById('pd-title').textContent`), '未分类');
  await click('#pd-undo'); await waitIdle();
  snapshot = await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)');
  assert.equal(snapshot.entries.filter((e) => e.category === category).length, 13);
  await click('[data-category="all"]'); await input('pd-search', 'github');
  assert.equal(await evaluate(`document.querySelectorAll('#pd-files [data-entry]').length`), 1);
  await click('#pd-files input'); await click('#pd-open'); await waitIdle(); await click('#pd-reveal'); await waitIdle();
  assert.deepEqual(opened, [path.join(collection, 'github')]); assert.deepEqual(revealed, opened);
  await input('pd-search', '');
  const firstId = snapshot.entries[0].id;
  await evaluate(`(() => {const card=[...document.querySelectorAll('[data-entry]')].find(n=>n.dataset.entry===${JSON.stringify(firstId)}); const transfer=new DataTransfer();card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const target=document.querySelector('[data-category=""]');target.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer})); })()`);
  await waitIdle();
  snapshot = await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)');
  assert.equal(snapshot.entries.find((e) => e.id === firstId).category, '');
  fs.mkdirSync(path.join(collection, '自动发现的新项目'));
  await waitFor(`document.querySelectorAll('#pd-files [data-entry]').length===14`, 'new folder was not watched');
  fs.renameSync(path.join(collection, 'github'), path.join(collection, 'github改名'));
  await waitFor(`[...document.querySelectorAll('.pd-file-name')].some(n=>n.textContent==='github改名')`, 'rename not refreshed');
  await click('#pd-add'); await input('pd-name', '客户资料'); await click('#pd-save'); await waitIdle();
  assert.equal(await evaluate(`document.getElementById('pd-form-error').hidden`), false, 'duplicate category should show error');
  workspace.webContents.send('key:escape'); await sleep(100);
  assert.equal(await evaluate(`document.getElementById('pd-editor').open`), false);
  assert.equal(await evaluate(`document.querySelector('#tab-projects.active')!==null`), true, 'Escape should close dialog, keep workbench');
  await click('#pd-choose'); await waitIdle();
  assert.equal(dialogs[0].properties[0], 'openDirectory');
  assert.equal((await evaluate('window.notchAPI.listProjectDrawer().then(r=>r.snapshot)')).entries.length, 14, 'cancel must retain root');
  await click('#pd-view');
  assert.equal(await evaluate(`document.getElementById('project-drawer').dataset.view`), 'list');
  await click('#pd-view');
  for (const width of [1040, 1240]) {
    workspace.setSize(width, 480); await sleep(150);
    const geometry = await evaluate(`(() => {const ids=['pd-all','pd-search','pd-view','pd-refresh','pd-add','pd-open','pd-reveal','pd-target','pd-assign','pd-undo'];return ids.map(id=>{const el=document.getElementById(id),b=el.getBoundingClientRect(),h=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return {id,visible:b.width>0 && b.height>0 && b.bottom<=innerHeight && b.left>=0 && b.right<=innerWidth && (el===h||el.contains(h))};});})()`);
    assert.ok(geometry.every((e) => e.visible), JSON.stringify(geometry.filter((e) => !e.visible)));
    const layout = await evaluate(`(() => {
      const scroller = document.querySelector('.pd-files-scroll'), box = scroller.getBoundingClientRect();
      const cards = [...document.querySelectorAll('.pd-file')];
      const rows = [...new Set(cards.map(n=>n.offsetTop))];
      const row2 = cards.filter(n=>n.offsetTop === rows[1]);
      return { completeRows: row2.length > 0 && row2.every(n=>n.getBoundingClientRect().bottom <= box.bottom),
        noOverflow: scroller.scrollWidth <= scroller.clientWidth + 1,
        cardHeight: cards[0].getBoundingClientRect().height };
    })()`);
    assert.ok(layout.completeRows, 'two complete rows at '+width+': '+JSON.stringify(layout));
    assert.ok(layout.noOverflow, 'no horizontal overflow at '+width);
    assert.equal(layout.cardHeight,92);
    const previews = path.join(os.tmpdir(),'fudao-drawer-compact');
    fs.mkdirSync(previews,{recursive:true});
    fs.writeFileSync(path.join(previews,width+'.png'),(await workspace.webContents.capturePage()).toPNG());

  }
  const out = path.join(__dirname, '..', '.cache', 'project-drawer-20260912'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, process.env.FUDAO_TEST_APP_DIR ? 'installed-preview.png' : 'preview.png'), (await workspace.webContents.capturePage()).toPNG());
  assert.equal(fs.readFileSync(path.join(collection, '<测试文件>.txt'), 'utf8'), 'unchanged');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checked: ['entry after todo', 'quota inset', 'create/rename/delete/undo', 'successive card/checkbox/list multiselection', 'expanded checkbox target', 'Shift range', 'Space/Command+A', 'double-click', 'exact batch assignment', 'drag category', 'search', 'open/reveal', 'automatic index', 'escape', 'cancel picker', '1040/1240 × 480 geometry, two complete rows'], quota, screenshot: out }));
}
main().then(() => { workspace?.destroy(); quick?.destroy(); app.quit(); }).catch((error) => { console.error(error); fs.rmSync(base, { recursive: true, force: true }); app.exit(1); });
app.on('will-quit', () => fs.rmSync(base, { recursive: true, force: true }));
