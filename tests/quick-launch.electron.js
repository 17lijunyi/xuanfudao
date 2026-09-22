const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const { createQuickLaunchService } = require(path.join(root, 'quick-launch'));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-launch-ui-'));
const userData = path.join(base, 'userData'); fs.mkdirSync(userData);
app.setPath('userData', userData);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeApp = (name) => {
  const appPath = path.join(base, `${name}.app`);
  fs.mkdirSync(path.join(appPath, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), JSON.stringify({ CFBundlePackageType: 'APPL', CFBundleExecutable: 'main', CFBundleName: name }));
  fs.writeFileSync(path.join(appPath, 'Contents', 'MacOS', 'main'), 'test, never execute');
  return { name, appPath };
};
const defaults = ['Codex', 'Safari', 'VS Code', 'Chrome', '终端', '备忘录', '访达', '系统设置'].map(makeApp);
const replacement = makeApp('新应用');
const settingsPath = path.join(userData, 'quick-launch.json');
const serviceOptions = { settingsPath, defaults: () => defaults.slice(), readInfo: async (target) => JSON.parse(fs.readFileSync(path.join(target, 'Contents', 'Info.plist'), 'utf8')) };
let service = createQuickLaunchService(serviceOptions);
let window;

async function main() {
  await app.whenReady();
  const preload = path.join(root, 'preload.js');
  window = new BrowserWindow({ width: 1240, height: 270, frame: false, show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const opened = [], picks = [], errors = [];
  let choice = { canceled: true };
  let finishPick;
  const show = (interactive = true) => window.webContents.send('quick-island:show', { interactive, width: 1240, height: 270, stripHeight: 38 });
  const responses = {
    'settings:get': { features: {} },
    'codex-float:get': { connection: 'unavailable', windows: [], threads: [], resets: { available: null } },
    'system:status:get': {}, 'island:activities-get': {}, 'weather:get': { ok: false },
  };
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]))) {
    ipcMain.handle(channel, async (_event, ...args) => {
      if (channel === 'quick-launch:list') return service.list();
      if (channel === 'quick-launch:open') return service.launch(args[0], async (target) => { opened.push(target); return ''; });
      if (channel === 'quick-launch:choose') return service.replace(args[0], () => {
        picks.push(args[0]);
        return choice === 'defer' ? new Promise((resolve) => { finishPick = resolve; }) : choice;
      });
      if (channel === 'quick-island:show') { show(args[0]?.focus === true); return { ok: true }; }
      if (channel === 'quick-island:hide') { window.webContents.send('quick-island:hide', { reason: 'explicit' }); return { ok: true }; }
      return responses[channel] ?? null;
    });
  }
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code, label) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (await evaluate(code)) return; await sleep(25); }
    throw Error(label);
  };
  const click = async (selector) => {
    const point = await evaluate(`(() => {
      const node=document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'nearest',inline:'nearest'});
      const box=node.getBoundingClientRect(), x=box.x+box.width/2,y=box.y+box.height/2, hit=document.elementFromPoint(x,y);
      if(node.disabled || !box.width || node.closest('[inert]') || !(node===hit || node.contains(hit))) throw Error('unreachable '+${JSON.stringify(selector)});
      return {x,y};
    })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  try {
    await window.loadURL('about:blank'); window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: "window.__errors=[];addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));" });
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await window.loadFile(path.join(root, 'renderer', 'quick-island.html'));
    window.showInactive(); window.setIgnoreMouseEvents(true); show(false);
    await waitFor(`document.querySelectorAll('[data-launch-app]').length===8`, 'initial apps');
    await waitFor(`document.querySelector('#quick-island').dataset.visible==='true' && getComputedStyle(document.querySelector('.island-content')).opacity==='1'`, 'initial island has finished opening before pointer input');
    const first = '[data-launch-app="app-slot-0"]';
    await click('#quick-apps-edit');
    await waitFor(`document.querySelector('.quick-apps').dataset.editing==='true' && !document.querySelector('#quick-apps-edit').disabled`, 'enter edit mode');
    assert.equal(await evaluate(`document.querySelector('#quick-apps-edit').textContent`), '完成');
    assert.equal(await evaluate(`document.querySelector('#quick-apps-hint').hidden`), false);
    await evaluate(`document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))`); await sleep(350);
    assert.equal(await evaluate(`document.querySelector('#quick-island').dataset.visible`), 'true', 'editing stays open while leaving island');
    choice = 'defer'; await click(first);
    await waitFor(`document.querySelector('#quick-apps-grid').getAttribute('aria-busy')==='true'`, 'picker busy');
    assert.deepEqual(opened, [], 'editing an icon never launches it');
    await evaluate(`document.querySelector('[data-launch-app="app-slot-1"]').click()`);
    assert.equal(picks.length, 1, 'busy grid cannot spawn a second picker');
    finishPick({ canceled: true });
    await waitFor(`!document.querySelector('#quick-apps-edit').disabled`, 'cancel releases controls');
    assert.equal(await evaluate(`document.querySelector('${first} small').textContent`), 'Codex');
    assert.equal(fs.existsSync(settingsPath), false);

    choice = { filePaths: [replacement.appPath] }; await click(first);
    await waitFor(`document.querySelector('${first} small').textContent==='新应用' && !document.querySelector('#quick-apps-edit').disabled`, 'selected app replaces current icon');
    assert.equal(JSON.parse(fs.readFileSync(settingsPath)).slots[0].appPath, replacement.appPath);
    assert.equal(await evaluate(`document.activeElement.dataset.launchApp`), 'app-slot-0', 'return keyboard focus to changed slot');
    choice = { filePaths: [defaults[1].appPath] }; await click(first);
    await waitFor(`document.querySelector('#quick-message').textContent.includes('已经在常用应用')`, 'duplicate choice gives feedback');
    assert.equal(await evaluate(`document.querySelector('${first} small').textContent`), '新应用');
    assert.deepEqual(opened, []);
    window.webContents.send('key:escape');
    await waitFor(`document.querySelector('.quick-apps').dataset.editing==='false'`, 'Escape ends editing');
    assert.equal(await evaluate(`document.querySelector('#quick-island').dataset.visible`), 'true');
    await click(first);
    await waitFor(`!document.querySelector('${first}').disabled`, 'launch finishes');
    assert.deepEqual(opened, [replacement.appPath], 'normal icon click launches saved replacement');

    service = createQuickLaunchService(serviceOptions);
    await window.loadFile(path.join(root, 'renderer', 'quick-island.html')); show();
    await waitFor(`document.querySelector('${first} small')?.textContent==='新应用'`, 'persist after renderer and service restart');
    await waitFor(`document.querySelector('#quick-island').dataset.visible==='true' && getComputedStyle(document.querySelector('.island-content')).opacity==='1'`, 'reloaded island has finished opening before pointer input');
    assert.equal(await evaluate(`document.querySelector('#quick-apps-edit').textContent`), '更换');
    for (const width of [1240, 1000]) {
      window.setSize(width, 270); await sleep(90);
      await click('#quick-apps-edit');
      await waitFor(`document.querySelector('.quick-apps').dataset.editing==='true'`, 'edit at viewport '+width);
      const layout = await evaluate(`(() => {const grid=document.querySelector('#quick-apps-grid').getBoundingClientRect(), hint=document.querySelector('#quick-apps-hint').getBoundingClientRect();return {bottom:hint.bottom,gridBottom:grid.bottom,hintTop:hint.top};})()`);
      assert.ok(layout.bottom <= 270 && layout.gridBottom <= layout.hintTop, 'hint and grid fit the existing island height');
      choice = { canceled: true };
      for (let slot = 0; slot < 8; slot++) {
        await click('[data-launch-app="app-slot-'+slot+'"]');
        await waitFor(`!document.querySelector('#quick-apps-edit').disabled`, 'every app slot reachable');
      }
      await click('#quick-apps-edit');
    }
    errors.push(...await evaluate('window.__errors'));
    assert.deepEqual(errors, [], 'no unhandled renderer errors');
    if (process.env.QUICK_LAUNCH_SCREENSHOT) {
      window.setSize(1240, 270); await sleep(90);
      await click('#quick-apps-edit'); await sleep(90);
      fs.writeFileSync(process.env.QUICK_LAUNCH_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    console.log('PASS app replacement: real preload, edit/choose/cancel, persistence, keyboard, 8 slots at both widths');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().then(() => { window?.destroy(); app.quit(); }, (error) => { console.error(error); app.exit(1); });
