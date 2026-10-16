const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { createAIToolsService, CATALOG } = require(path.join(root, 'ai-tools'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-ui-'));
app.setPath('userData', base);
const settingsPath = path.join(base, 'ai-tools.json');
let service = createAIToolsService({ settingsPath });
const windows = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = (win, code) => win.webContents.executeJavaScript(code).catch((error) => { throw Error(`${error.message}\nEvaluation: ${code}`); });
let failSave = false;
let delayedGet;
let quota = 80;
let codexReads = 0;
const detections = [];
let hookConnected = false;
const { createAICodeRuntime } = require(path.join(root, 'ai-code-runtime'));
const runtime = createAICodeRuntime({
  codex: { stop() {}, start() { codexReads++; return Promise.resolve(snapshot()); }, refresh() { codexReads++; return Promise.resolve(snapshot()); } },
  connectors: {
    inspect(id) {
      detections.push(id);
      return id === 'claude-code' ? { connection: hookConnected ? 'connected' : 'not_connected', installed: true, monitoringReady: hookConnected,
        windows: [], threads: hookConnected ? [{ id: 'claude-session', providerId: id, title: 'Claude 独立长任务', status: 'running', statusSource: 'hook', turnStartedAt: Date.now()-3600000 }] : [] }
        : { connection: 'not_installed', installed: false, windows: [], threads: [] };
    },
    connect(id) { assert.equal(id, 'claude-code'); hookConnected = true; return {ok:true}; }
  },
  onStatus(value) { emit('ai-code:status',value); },
});
const snapshot = () => ({ connection: 'connected', updatedAt: Date.now(),
  windows: [{ limitId: 'codex', label: '每周', windowDurationMins: 10080, remainingPercent: quota }],
  threads: [{ id: '11111111-1111-1111-1111-111111111111', title: '测试中的长任务', status: 'running', statusSource: 'hook', turnStartedAt: Date.now() - 3600000 }],
  resets: { available: 1 },
});
const emit = (channel, value) => windows.forEach((win) => win.webContents.send(channel, value));
async function waitFor(win, code, label) {
  const end = Date.now() + 5500;
  while (Date.now() < end) { if (await evaluate(win, code)) return; await sleep(25); }
  throw Error(label+' '+JSON.stringify(await evaluate(win, `(async()=>({tool:window.AITools?.currentTool(),card:document.querySelector('#quick-codex')?.outerHTML,errors:window.__errors,status:await window.AITools?.getStatus()}))()`))); 
}
async function click(win, selector) {
  const point = await evaluate(win, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return {error:'missing'};
    node.scrollIntoView({block:'nearest',inline:'nearest'});
    const rect=node.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2, hit=document.elementFromPoint(x,y);
    if(node.disabled || !rect.width || node.closest('[inert]') || !(node===hit || node.contains(hit))) return {error:'unreachable',box:rect.toJSON(),hit:hit?.outerHTML.slice(0,250),inert:!!node.closest('[inert]')};
    return {x,y}; })()`);
  if (point.error) throw Error(selector+': '+JSON.stringify(point));
  for (const type of ['mousePressed','mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}

async function main() {
  await app.whenReady();
  const preload = path.join(root, 'preload.js');
  const responses = {
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'workspace:get': { path: base }, 'workspace:load-data': {}, 'transcription:get-config': {},
    'tasks:recent': [], 'credentials:list': { items: [], secureStorage: true },
    'system:status:get': {}, 'island:activities-get': {}, 'weather:get': { ok: false }, 'quick-launch:list': { ok: true, apps: [] },
  };
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))) {
    ipcMain.handle(channel, (event, ...args) => {
      if (channel === 'ai-tools:get') return delayedGet || service.getSnapshot();
      if (channel === 'ai-tools:update') {
        const result = failSave ? { ok: false, error: 'save_failed' } : service.update(args[0]);
        if (result.ok) { emit('ai-tools:changed', result); void runtime.select(result); }
        return result;
      }
      if (channel === 'ai-tools:website') return { ok: !!service.website(args[0]) };
      if (channel === 'ai-code:get') return runtime.getStatus();
      if (channel === 'ai-code:refresh') return runtime.refresh(args[0]);
      if (channel === 'ai-code:connect') return runtime.connect(args[0]);
      if (channel === 'codex-float:get') { codexReads++; return runtime.getStatus(); }
      if (channel === 'codex-float:refresh') return runtime.refresh('codex');
      if (channel === 'window:set-mode') {
        const win=BrowserWindow.fromWebContents(event.sender);
        win.setSize(...(args[0] === 'expanded' ? [1240,616] : [256,38]));
        return { ok:true, mode:args[0] };
      }
      if (channel === 'quick-island:open-workspace') {
        windows[1]?.webContents.send('quick-island:hide', { reason:'explicit' });
        windows[0]?.webContents.send('island:open-workspace', args[0]);
        return {ok:true};
      }
      if (channel === 'quick-island:show') {
        (windows[1]?.webContents || event.sender).send('quick-island:show', { interactive: args[0]?.focus === true, width: 1240, height: 270, stripHeight: 38 });
        return { ok: true };
      }
      if (channel === 'quick-island:hide') { event.sender.send('quick-island:hide', { reason: 'explicit' }); return { ok: true }; }
      return responses[channel] ?? null;
    });
  }
  async function create(file, width, height) {
    const win = new BrowserWindow({ width, height, frame: false, show: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    windows.push(win);
    win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message); });
    await win.loadURL('about:blank'); win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "window.__errors=[];addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));" });
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await win.loadFile(path.join(root, 'renderer', file));
    win.showInactive(); win.setIgnoreMouseEvents(true); return win;
  }
  await runtime.select(service.getSnapshot());
  const notch = await create('index.html',256,38);
  const quick = await create('quick-island.html',1240,270);
  const show=()=>quick.webContents.send('quick-island:show',{interactive:true,width:1240,height:270,stripHeight:38});
  show();
  await waitFor(quick,`document.querySelector('#quick-codex').dataset.active==='true' && document.querySelector('#quick-island').dataset.visible==='true'`,'quick ready');
  assert.deepEqual(await evaluate(quick,`[...document.querySelectorAll('.island-nav [data-workspace]')].map(n=>n.dataset.workspace)`),['home','todo','projects','codes']);
  assert.equal(await evaluate(quick,`document.querySelector('#quick-codex .ai-change-code')!==null`),false,'footer entry removed');
  assert.equal(await evaluate(quick,`document.querySelector('.ai-tools-dialog')!==null`),false,'no quick-island picker');
  assert.equal(codexReads,0);assert.deepEqual(detections,[]);
  await click(quick,'[data-workspace="codes"]');
  await waitFor(notch,`document.querySelector('#tab-codes').classList.contains('active') && !document.querySelector('.ai-tools-page').hidden && document.querySelectorAll('.ai-tool-row').length===14`,'nav opens full code page');
  assert.equal(await evaluate(notch,'document.title'),'工作台');
  assert.equal(await evaluate(notch,`document.querySelector('[data-tab="projects"]').nextElementSibling.dataset.tab`),'codes');
  assert.equal(await evaluate(notch,`document.querySelectorAll('#tab-codes [role="radio"][aria-checked="true"]').length`),0);
  const screenshot=process.env.AI_TOOLS_SCREENSHOT_DIR;
  async function capture(win,name){if(!screenshot)return;fs.mkdirSync(screenshot,{recursive:true});await sleep(100);fs.writeFileSync(path.join(screenshot,name+'.png'),(await win.webContents.capturePage()).toPNG());}
  await waitFor(notch,`[...document.querySelectorAll('.ai-tools-list img')].every(i=>i.complete&&i.naturalWidth>0)`,'local icons');
  await capture(notch,'code-list-page');
  await click(notch,'[data-ai-id="kimi-code"]');
  await waitFor(notch,`!document.querySelector('.ai-tools-confirm').hidden`,'confirmation stays in code page');
  assert.deepEqual(detections,[]);assert.equal(codexReads,0);assert.equal(service.getSnapshot().state.selected,null);
  await capture(notch,'confirm-kimi');
  notch.webContents.send('key:escape');
  await waitFor(notch,`document.querySelector('.ai-tools-confirm').hidden`,'Escape cancels only candidate');
  assert.equal(await evaluate(notch,`document.querySelector('#app').classList.contains('expanded')`),true);
  async function codePage(){
    await evaluate(notch,`window.notchAPI.openIslandWorkspace('codes')`);
    await waitFor(notch,`!document.querySelector('.ai-tools-page').hidden && document.querySelector('#tab-codes').classList.contains('active')`,'code page ready');
  }
  async function select(id){
    await codePage();
    const count=detections.length,reads=codexReads;
    await click(notch,`[data-ai-id="${id}"]`);
    assert.equal(detections.length,count);assert.equal(codexReads,reads);
    await click(notch,'[data-ai-action="confirm"]');
    await waitFor(notch,`document.querySelector('.ai-tools-confirm').hidden && document.querySelector('[data-ai-id="${id}"]').getAttribute('aria-checked')==='true'`,'single choice saved '+id);
    assert.equal(await evaluate(notch,`document.querySelectorAll('#tab-codes [role="radio"][aria-checked="true"]').length`),1);
    assert.equal(await evaluate(notch,`document.querySelector('#tab-codes').classList.contains('active')`),true,'remains in workbench after selection');
  }
  await select('codex');
  await click(notch,'.ai-tools-close');
  await waitFor(notch,`document.querySelector('#home-codex-card').textContent.includes('测试中的长任务')`,'return to workbench with real Codex data');
  assert.equal(await evaluate(notch,`document.querySelector('.mirror-photo').getAttribute('src')`),'assets/xuanfudao-icon.png');
  await waitFor(notch,`[...document.querySelectorAll('.mirror-photo')].every(i=>i.complete&&i.naturalWidth>0)`,'default cover loads');
  assert.equal(await evaluate(notch,`document.querySelector('#settings-mirror-preview').getAttribute('src')`),'assets/xuanfudao-icon.png');
  await capture(notch,'workbench-icon');
  for(const tool of CATALOG.filter(t=>t.id!=='codex')){
    await select(tool.id);
    assert.equal(await evaluate(notch,`document.querySelector('.codex-notch-mark').getAttribute('src')`),tool.icon);
    assert.equal(await evaluate(notch,`document.querySelector('.codex-notch-quota strong').textContent`),'—');
    assert.equal(await evaluate(notch,`document.querySelector('#home-codex-card .codex-thread')!==null`),false,'no stale Codex task DOM');
    // Shared presentation is exercised with isolated provider-specific fixtures;
    // unsupported production connectors above still return no invented data.
    await evaluate(notch, `window.CodexNotch.render(${JSON.stringify({ providerId: tool.id, connection: 'connected', windows: [],
      threads: [], runningTasks: [{ id: 'fixture', projectKey: 'project', title: 'fixture', status: 'running' }],
      attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [] })})`);
    assert.equal(await evaluate(notch, `document.querySelector('.codex-notch-project-count').textContent`), '1', tool.id);
    assert.deepEqual(await evaluate(notch, `[...document.querySelectorAll('.codex-notch-mark')].map(n=>n.getAttribute('src'))`), [tool.icon, tool.icon]);
    assert.equal(await evaluate(notch, `document.querySelector('.codex-notch-reset-days').textContent`), '—');
    await evaluate(notch, `window.CodexNotch.render(${JSON.stringify({ providerId: tool.id, connection: 'connected', windows: [], threads: [],
      runningTasks: [], attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [] })})`);
    assert.equal(await evaluate(notch, `document.querySelector('.codex-notch-project-count').textContent`), '°', tool.id);
  }
  await select('claude-code');
  await waitFor(notch, `!document.querySelector('.ai-tools-setup').hidden && !document.querySelector('.ai-tools-setup [data-ai-action="connect"]').hidden`, 'connect available directly after selection');
  await click(notch,'.ai-tools-setup [data-ai-action="connect"]');
  await waitFor(notch, `document.querySelector('.ai-tools-setup').textContent.includes('已收到事件')`, 'selection page shows real event receipt');
  await click(notch,'.ai-tools-close');
  await waitFor(notch,`document.querySelector('#home-codex-card').dataset.active==='true'`,'home active');
  assert.equal(await evaluate(notch, `document.querySelector('#home-codex-card [data-ai-action="connect"]').textContent`), '修复连接');
  await waitFor(notch,`document.querySelector('#home-codex-card').textContent.includes('Claude 独立长任务')`,'selected tool task source');
  await codePage();await click(notch,'[data-ai-id="deepseek"]');failSave=true;
  await click(notch,'[data-ai-action="confirm"]');
  await waitFor(notch,`document.querySelector('.ai-tools-feedback').textContent.includes('保存失败')`,'save failure');
  assert.equal(service.getSnapshot().state.selected,'claude-code');assert.equal(detections.at(-1),'claude-code');
  failSave=false;await click(notch,'[data-ai-action="confirm"]');
  await waitFor(notch,`document.querySelector('.ai-tools-confirm').hidden`,'retry');
  for(const width of [1240,1000]){
    notch.setSize(width,616);await sleep(60);
    for(const tool of CATALOG){
      await evaluate(notch,`document.querySelector('[data-ai-id="${tool.id}"]').scrollIntoView({block:'nearest'});`);
      assert.ok(await evaluate(notch,`(()=>{const r=document.querySelector('[data-ai-id="${tool.id}"]').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;})()`),'all options reachable at '+width);
    }
  }
  service=createAIToolsService({settingsPath});await runtime.select(service.getSnapshot());
  await notch.loadFile(path.join(root,'renderer/index.html'));await quick.loadFile(path.join(root,'renderer/quick-island.html'));show();
  await waitFor(quick,`document.querySelector('#quick-codex').dataset.aiTool==='deepseek' && document.querySelector('#quick-codex').dataset.active==='true' && document.querySelector('#quick-island').dataset.visible==='true'`,'restart selection');
  await click(quick,'#quick-codex .ai-provider-brand');
  await waitFor(notch,`document.querySelector('#tab-codes').classList.contains('active')`,'brand also routes to code page');
  runtime.acceptCodex(snapshot());emit('codex-float:status',snapshot());await sleep(70);
  assert.equal(await evaluate(notch,`document.querySelector('.codex-notch-quota strong').textContent`),'—');
  for(const win of windows)assert.deepEqual(await evaluate(win,'window.__errors'),[],'renderer errors');
  runtime.stop();
  console.log('PASS workbench code page, nav order, no old footer/modal, confirmed single selection, data isolation, 14 icons, cover/title, restart, save failure, Escape, two widths');

}
main().then(() => { windows.forEach((win) => win.destroy()); fs.rmSync(base, { recursive: true, force: true }); app.quit(); }, (error) => { console.error(error); app.exit(1); });
