'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const appRoot = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const { createAppearanceSettingsService } = require(path.join(appRoot, 'appearance-settings.js'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-compact-test-'));
const preferenceFile = path.join(userData, 'appearance.json');
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const preload = path.join(appRoot, 'preload.js');
  const windows = [];
  let auditWidth = 1240;
  const mediaCalls = [];
  const service = createAppearanceSettingsService({ filePath: preferenceFile });
  const GiB = 1024 ** 3;
  const codeStatus = { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [], resets: { available: null } };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(appRoot, 'ai-tools')).CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': codeStatus, 'codex-float:get': codeStatus,
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'settings:get': { features: { todo: true, projects: true, notes: true, links: true, recordings: true, credentials: true, clip: true } },
    'window-size:get': {selectedId:'B',revision:0}, 'transcription:get-config': { configured: false, llmConfigured: false },
    'credentials:list': { items: Array.from({length:8},(_,i)=>({id:'c'+i,service:'测试服务 '+(i+1),account:'demo@example.com',passwordMask:'********'})), secureStorage: true }, 'tasks:recent': [],
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
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === 'appearance:get') return service.getSnapshot();
      if (channel === 'appearance:set') {
        const result = await service.setPreset(args[0]);
        if (result.ok) broadcast(result.snapshot);
        return result;
      }
      if (channel === 'window:set-mode') {
        BrowserWindow.fromWebContents(event.sender).setSize(...(args[0] === 'expanded' ? [auditWidth, 480] : [256, 38]));
        return { ok: true, mode: args[0] };
      }
      if (channel === 'window:begin-collapse') return { ok: true };
      if (channel === 'media:camera' || channel === 'media:microphone') { mediaCalls.push(channel); return false; }
      return responses[channel] ?? null;
    });
  }

  const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false };
  const workbench = new BrowserWindow({ show: false, frame: false, transparent: true, width: 1240, height: 480, webPreferences });
  windows.push(workbench);
  workbench.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => { mediaCalls.push(`permission:${permission}`); callback(false); });
  const evaluate = (window, code) => window.webContents.executeJavaScript(code);
  async function waitFor(window, code, message) {
    for (let i = 0; i < 200; i++) { if (await evaluate(window, code)) return; await wait(20); }
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
  async function screenshot(window, name) {
    const directory = process.env.FUDAO_APPEARANCE_SCREENSHOTS;
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true });
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  // Assert real rendered bounds, including controls inside scrollable libraries.
  async function checkLayout(tab, width) {
    await evaluate(workbench, 'window.cardReflow?.whenIdle()');
    const failures = await evaluate(workbench, `(${function check(tab, expectedWidth) {
      const errors = [];
      const expect = (condition, label) => { if (!condition) errors.push(label); };
      const nodes = selector => [...document.querySelectorAll(selector)];
      const rect = element => element.getBoundingClientRect();
      const inside = (element, parent) => {
        const a = rect(element), b = rect(parent);
        return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
      };
      const hasRoom = selector => nodes(selector).forEach(element => expect(element.scrollWidth <= element.clientWidth + 2, selector + ' has no horizontal overflow'));
      expect(innerWidth === expectedWidth && innerHeight === 480, 'selected window dimensions');
      if (tab === 'codes') {
        const list = document.querySelector('.ai-tools-list');
        expect(getComputedStyle(list).gridTemplateColumns.split(' ').length === (expectedWidth === 1040 ? 4 : 5), 'code column count');
        expect(nodes('.ai-tool-row').length >= 14, 'full code catalogue fixture');
        nodes('.ai-tool-row').forEach(row => expect(inside(row, list), 'code card completely visible'));
        hasRoom('.ai-tool-row');
      }
      if (tab === 'credentials') {
        expect(nodes('.credential-item').length === 8, 'populated credentials fixture');
        nodes('.credential-actions button').forEach(button => expect(inside(button, button.closest('.credential-item')), 'credential action contained'));
        hasRoom('.credentials-library, .credentials-form-card');
      }
      if (tab === 'notes') {
        nodes('.notes-detail-head input, .notes-detail-head button').forEach(control => expect(inside(control, control.closest('.notes-detail-head')), 'note header control contained'));
        hasRoom('.notes-library, .notes-detail');
      }
      if (tab === 'links') hasRoom('.link-group, .link-item');
      if (tab === 'recordings') {
        const grid = document.querySelector('.computer-status-grid');
        expect(nodes('.computer-stat-card').length === 6, 'all computer metrics present');
        nodes('.computer-stat-card').forEach(card => expect(inside(card, grid) && rect(card).bottom <= innerHeight, 'computer metric visible'));
      }
      if (tab === 'settings') {
        for (const column of nodes('.settings-column')) {
          expect(getComputedStyle(column).overflowY === 'auto', 'settings column scrollable');
          expect(column.scrollWidth <= column.clientWidth + 2, 'settings no horizontal overflow');
          column.scrollTop = column.scrollHeight;
          const last = column.lastElementChild;
          expect(rect(last).bottom <= rect(column).bottom + 1, 'last settings card reachable');
          nodes('.settings-device-card button, .settings-auto-launch-row').filter(element => column.contains(element)).forEach(element => expect(inside(element, column), 'device controls reachable'));
          column.scrollTop = 0;
        }
      }
      if (tab === 'recording-library') {
        expect(nodes('.recording-item').length === 6, 'populated recording fixture');
        nodes('.recording-item').forEach(row => {
          expect(rect(row).height >= 66, 'recording row cannot shrink');
          nodes('.recording-item-main').filter(element => row.contains(element)).forEach(element => expect(inside(element, row), 'recording text contained'));
        });
        expect(rect(document.querySelector('.recording-transcript-editor')).height >= 160, 'transcript has usable height');
        hasRoom('.recording-library, .recording-detail');
      }
      return errors;
    }.toString()})(${JSON.stringify(tab)}, ${width})`);
    assert.deepEqual(failures, [], `${service.getSnapshot().selectedId} ${width} ${tab}`);
  }

  try {
    await load(workbench, 'index.html');
    await evaluate(workbench, `(() => {
      const now=Date.now();
      localStorage.setItem('notch-note-archive-v1', JSON.stringify(Array.from({length:8},(_,i)=>({id:'note'+i,title:'产品适配检查笔记 '+(i+1),content:'这是一条用于检查页面布局的测试内容。支持两种窗口宽度，内容需要可以滚动。',createdAt:now,updatedAt:now}))));
      localStorage.setItem('notch-link-groups', JSON.stringify(Array.from({length:4},(_,i)=>({id:'g'+i,name:'资源分类 '+(i+1),links:Array.from({length:5},(_,j)=>({id:'l'+i+j,title:'参考资料与产品文档 '+(j+1),url:'https://example.com/'+j}))}))));
      localStorage.setItem('notch-recordings',JSON.stringify(Array.from({length:6},(_,i)=>({id:'r'+i,title:'访谈录音 '+(i+1),createdAt:now,durationMs:65000,transcript:'这是一段用于检查布局的录音转写文本。'.repeat(30)}))));
    })()`);
    await load(workbench,'index.html');
    const report=[];
    for (const theme of ['system-glass-blurred','classic']) {
    await service.setPreset(theme); broadcast(service.getSnapshot());
    for (const width of [1040,1240]) {
      auditWidth = width; workbench.setSize(width,480);
      for (const tab of ['home','todo','codes','notes','links','recordings','credentials','settings','clip']) {
        await openTab(tab); if(tab === 'recordings') await evaluate(workbench, "document.getElementById('computer-back-status').click()"); await wait(180);
        await checkLayout(tab, width);
        await screenshot(workbench,theme+'-'+width+'-'+tab);
        report.push(await evaluate(workbench,`(() => {
          const page=document.querySelector('#tab-${tab}');
          const clip=(n)=>{const b=n.getBoundingClientRect();return b.width>0&&b.height>0};
          return {width:innerWidth,tab:'${tab}',scrollAreas:[...page.querySelectorAll('*')].filter(n=>clip(n)&&n.clientHeight>40&&n.scrollHeight>n.clientHeight+4&&['auto','scroll'].includes(getComputedStyle(n).overflowY)).map(n=>({class:n.className,height:n.clientHeight,content:n.scrollHeight})),
          outside:[...page.querySelectorAll('button,input,select')].filter(n=>clip(n)&&!n.closest('[hidden]')).filter(n=>{const b=n.getBoundingClientRect();return b.bottom>innerHeight||b.left<0||b.right>innerWidth}).map(n=>n.id||n.textContent.trim().slice(0,20)),
          codes:'${tab}'==='codes'?{rows:document.querySelectorAll('.ai-tool-row').length,height:document.querySelector('.ai-tools-list')?.clientHeight,columns:getComputedStyle(document.querySelector('.ai-tools-list')).gridTemplateColumns}:null};
        })()`));
      }
      await openTab('recordings');
      await evaluate(workbench,"document.getElementById('computer-open-recordings').click()");
      await wait(150); await checkLayout('recording-library', width); await screenshot(workbench,theme+'-'+width+'-recording-library');
    }
    }
    if (process.env.FUDAO_APPEARANCE_SCREENSHOTS) fs.writeFileSync(path.join(process.env.FUDAO_APPEARANCE_SCREENSHOTS,'report.json'),JSON.stringify(report,null,2));
    assert.equal(mediaCalls.length, 0, 'layout inspection never requests microphone or camera');
    console.log('Compact workspace: both widths and both themes passed.');
  } finally { for (const window of windows) if (!window.isDestroyed()) window.destroy(); }
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)});
