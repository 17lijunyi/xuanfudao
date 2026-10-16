'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const appRoot = process.env.FUDAO_APP_ROOT || path.join(__dirname, '..');

// Only synthetic notification metadata enters this isolated renderer.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-notification-test-'));
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const received = { hover: [], dismissed: [], activated: [] };
  let resolveDelayedActivation;
  ipcMain.on('task-notification:hover', (_event, value) => received.hover.push(value));
  ipcMain.on('task-notification:dismissed', (_event, value) => received.dismissed.push(value));
  ipcMain.handle('task-notification:activate', (_event, value) => {
    received.activated.push(value);
    if (value === 'fixture-delayed-activation') return new Promise(resolve => { resolveDelayedActivation = resolve; });
    return true;
  });
  const window = new BrowserWindow({ width: 348, height: 120, show: false, frame: false, transparent: true, focusable: false,
    webPreferences: { preload: path.join(appRoot, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const evaluate = source => window.webContents.executeJavaScript(source);
  const addonPath = process.env.FUDAO_APPEARANCE_ADDON || [path.join(appRoot,'native','appearance-glass.node'),path.join(appRoot,'.cache','native','appearance-glass.node')].find(file=>fs.existsSync(file));
  const native = process.platform === 'darwin' && addonPath ? require(addonPath) : null;
  const nativeErrors = [];
  const controller = require(path.join(appRoot,'appearance-native')).createAppearanceNativeController({addonPath,onError:error=>nativeErrors.push(error.message)});
  const normalizeSurface = require(path.join(appRoot,'appearance-surface')).normalizeAppearanceSurface;
  let currentAppearance = {selectedId:'classic',revision:0};
  let activeEventId;
  const setTheme = snapshot => {
    if (snapshot.revision >= currentAppearance.revision) {
      currentAppearance = snapshot;
      if (snapshot.selectedId === 'classic') controller.clear(window);
    }
    window.webContents.send('appearance:changed',snapshot);
  };
  ipcMain.on('task-notification:surface', (event,payload) => {
    if (event.sender!==window.webContents || payload.eventId!==activeEventId) return;
    const pair = currentAppearance.selectedId==='system-glass-blurred' && payload.surfaces?.length===2
      ? payload.surfaces.map(surface=>normalizeSurface({viewport:payload.viewport,surface},window.getContentBounds())) : [];
    const applied = pair.length===2 && pair.every(Boolean) && controller.applyPair(window,pair);
    if (!applied) controller.clear(window);
    window.webContents.send('task-notification:material',{native:applied,appearance:currentAppearance});
  });
  const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const waitFor = async (condition, message, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(condition)) return;
      await wait(15);
    }
    assert.fail(message);
  };
  const send = async (payload, height = payload.stripHeight + 86) => {
    activeEventId = payload.eventId;
    window.setSize(payload.width || 348, height);
    window.webContents.send('task-notification:show', payload);
    await waitFor(`document.getElementById('notification-shell').classList.contains('is-visible') && document.getElementById('notification-project').textContent === ${JSON.stringify(payload.source === 'codex' || payload.source === 'claude' || payload.compactCode ? payload.project || payload.title : payload.title)}`, '真实 preload 应送达展示事件');
  };
  const base = { source: 'codex', eventId: 'fixture-one', project: '个人网站首页优化', title: '不应显示的任务说明', width: 348,
    stripHeight: 34, height: 120, collapsedWidth: 256, confirmationMs: 420, visibleMs: 3000,
    appearance: {selectedId:'classic',revision:0}, sourceName:'Codex', sourceIcon:'assets/codex-mark.svg' };
  const geometry = () => evaluate(`(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, center:r.x+r.width/2, centerY:r.y+r.height/2 }; };
    const shell = document.getElementById('notification-shell');
    const project = document.getElementById('notification-project');
    return { viewport:[innerWidth, innerHeight], shell:rect(shell), content:rect(document.querySelector('.notification-codex-content')),
      project:rect(project), copy:rect(document.querySelector('.notification-copy')), notch:rect(document.querySelector('.notification-notch')),
      check:rect(document.querySelector('.notification-completed-mark')),
      legacyHidden:document.querySelector('.notification-bookmark-line') === null,
      background:getComputedStyle(document.querySelector('.notification-codex-content')).backgroundColor,
      ellipsis:getComputedStyle(project).textOverflow, nowrap:getComputedStyle(project).whiteSpace,
      aria:project.getAttribute('aria-label'), scrollWidth:project.scrollWidth, clientWidth:project.clientWidth };
  })()`);
  const assertGeometry = async stripHeight => {
    const g = await geometry();
    assert.deepEqual(g.viewport, [348, stripHeight + 86]);
    assert.equal(g.shell.width, 316);
    assert.equal(g.content.y, stripHeight + 16);
    assert.equal(g.content.height, 54);
    assert.equal(g.content.width, 254);
    assert.equal(g.shell.height, 54);
    assert.equal(g.notch.width, 256);
    assert.equal(g.notch.height, stripHeight);
    assert.equal(g.notch.center, 174);
    assert.equal(g.check.width, 54);
    assert.equal(g.check.height, 54);
    assert.equal(g.check.x, 278);
    assert.equal(g.check.x - g.content.x - g.content.width, 8, '两颗胶囊保持真实透明的 8px 间隔');
    assert.equal(g.check.centerY, g.copy.centerY, '两行文字整体与完成圆点居中');
    assert.ok(g.project.x + g.project.width + 8 <= g.check.x, '长标题不能覆盖勾号');
    assert.equal(await evaluate(`document.querySelectorAll('.notification-completed-mark svg').length`), 1, '始终显示一个完成勾号');
    assert.equal(g.legacyHidden, true, '不保留旧书签短线');
    assert.equal(g.ellipsis, 'ellipsis');
    assert.equal(g.nowrap, 'nowrap');
    const font = await evaluate(`(() => { const s=getComputedStyle(document.querySelector('.notification-project')); return [s.fontFamily,s.fontSize,s.fontWeight,s.letterSpacing]; })()`);
    assert.match(font[0], /^-apple-system/);
    assert.deepEqual(font.slice(1), ['13px', '400', 'normal']);
  };
  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.__notificationErrors=[];
      addEventListener('error', event=>window.__notificationErrors.push(event.message));
      addEventListener('unhandledrejection', event=>window.__notificationErrors.push(String(event.reason)));
    ` });
    await window.loadFile(path.join(appRoot, 'renderer', 'notification.html'));
    window.showInactive();
    window.setIgnoreMouseEvents(true);
    await send(base);
    await wait(480);
    await assertGeometry(34);
    assert.equal((await geometry()).background,'rgb(5, 5, 6)');
    setTheme({selectedId:'system-glass-blurred',revision:1});
    await waitFor(`document.documentElement.dataset.appearance==='system-glass-blurred'`,'主题实时变为玻璃');
    if (native) {
      await waitFor(`document.documentElement.dataset.nativeGlass==='true'`,'真实原生背景到达两个胶囊');
      const handle=window.getNativeWindowHandle();
      assert.equal(native.inspect(handle,0).x,16);
      assert.equal(native.inspect(handle,0).width,254);
      assert.equal(native.inspect(handle,1).x,278);
      assert.equal(native.inspect(handle,1).width,54);
      assert.equal(native.inspect(handle,1).materialOpacity,.38);
      assert.equal(window.isFocused(),false,'自动切材质不能抢焦点');
    }
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('notification-project')).color`),'rgb(8, 10, 12)');
    assert.equal(await evaluate(`document.getElementById('notification-shell').getAnimations({subtree:true}).length`),0,'切主题不重播入场动画');
    setTheme({selectedId:'classic',revision:0});
    await wait(30);
    assert.equal(await evaluate('document.documentElement.dataset.appearance'),'system-glass-blurred','忽略旧主题快照');
    if (process.env.FUDAO_POPUP_SCREENSHOTS) fs.writeFileSync(path.join(process.env.FUDAO_POPUP_SCREENSHOTS,'capsule-glass.png'),(await window.webContents.capturePage()).toPNG());
    setTheme({selectedId:'classic',revision:2});
    await waitFor(`document.documentElement.dataset.appearance==='classic'`,'主题实时恢复纯黑');
    assert.equal((await geometry()).background,'rgb(5, 5, 6)');
    if (native) {
      assert.equal(native.inspect(window.getNativeWindowHandle(),0),null);
      assert.equal(native.inspect(window.getNativeWindowHandle(),1),null);
    }
    if (process.env.FUDAO_POPUP_SCREENSHOTS) fs.writeFileSync(path.join(process.env.FUDAO_POPUP_SCREENSHOTS,'capsule-black.png'),(await window.webContents.capturePage()).toPNG());

    window.webContents.send('task-notification:queue', 3);
    window.webContents.send('task-notification:show', { ...base, pendingCount: 3 });
    await wait(80);
    assert.equal(await evaluate(`document.getElementById('notification-shell').getAnimations({subtree:true}).length`),0,'同事件和队列更新不能重播展开动画');
    await evaluate(`document.getElementById('notification-shell').dispatchEvent(new Event('pointerenter'))`);
    await wait(25);
    assert.deepEqual(received.hover, [], 'Codex 悬停不得延长主进程的固定停留时间');

    const cache = path.join(__dirname, '..', '.cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(process.env.FUDAO_NOTIFICATION_SCREENSHOT || path.join(cache, 'codex-notification-bookmark.png'), (await window.webContents.capturePage()).toPNG());
    await wait(3100);
    assert.equal(await evaluate(`document.getElementById('notification-root').hidden`), false, '渲染层不能自行定时隐藏或伪造完成事件');

    const longName = '这是一个非常长的项目名称，用来验证单行居中、省略显示与完整无障碍名称 <script>禁止执行</script>';
    await send({ ...base, eventId: 'fixture-two', project: longName, stripHeight: 80, height: 118 });
    await wait(480);
    await assertGeometry(80);
    const long = await geometry();
    assert.equal(long.aria, longName);
    assert.ok(long.scrollWidth > long.clientWidth);
    assert.equal(await evaluate(`document.getElementById('notification-project').children.length`), 0, '项目名只能使用纯文本');
    window.webContents.send('task-notification:hide', 'fixture-one');
    await wait(30);
    assert.equal(await evaluate(`document.getElementById('notification-shell').classList.contains('is-hiding')`), false, '旧事件关闭不能关掉下一个任务');
    window.webContents.send('task-notification:hide', 'fixture-two');
    await waitFor(`document.getElementById('notification-root').hidden`, '主进程 hide 应收回岛体并确认关闭');
    assert.deepEqual(received.dismissed, ['fixture-two']);

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await send({ ...base, eventId: 'fixture-reduced', stripHeight: 24, height: 62, confirmationMs: 0 });
    await assertGeometry(24);
    assert.equal(await evaluate(`document.getElementById('notification-shell').getAnimations({subtree:true}).length`), 0, '减少动态效果时直接显示双段胶囊且没有变形');
    await evaluate(`document.getElementById('notification-shell').click()`);
    await waitFor(`document.getElementById('notification-root').hidden`, '点击完成提醒应激活对应任务并收回');
    assert.deepEqual(received.activated, ['fixture-reduced']);

    await send({ ...base, eventId: 'fixture-delayed-activation', stripHeight: 24, height: 62, confirmationMs: 0 });
    await evaluate(`document.getElementById('notification-shell').click()`);
    for (let attempt = 0; attempt < 100 && !resolveDelayedActivation; attempt++) await wait(10);
    assert.equal(typeof resolveDelayedActivation, 'function');
    window.webContents.send('task-notification:hide', 'fixture-delayed-activation');
    await waitFor(`document.getElementById('notification-root').hidden`, '原提醒可以在任务激活完成前到时收回');
    await send({ ...base, eventId: 'fixture-after-delayed', project: '排队的下一个项目', stripHeight: 24, height: 62, confirmationMs: 0 });
    resolveDelayedActivation(true);
    await wait(50);
    assert.equal(await evaluate(`document.getElementById('notification-shell').classList.contains('is-visible') && !document.getElementById('notification-root').hidden`), true,
      '上一条提醒的异步激活结果不能关闭排队展示的新提醒');
    window.webContents.send('task-notification:hide', 'fixture-after-delayed');
    await waitFor(`document.getElementById('notification-root').hidden`, '新提醒仅在收到自己的关闭事件后收回');

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    const otherPrompts = [
      { source: 'todo', eventId: 'fixture-todo', title: '课程作业', detail: '将在 1 小时内截止', pendingCount: 2 },
      { source: 'pomodoro', eventId: 'fixture-focus', project: '番茄钟', title: '专注完成', body: '开始 5 分钟休息，之后自动继续专注' },
      { source: 'pomodoro', eventId: 'fixture-break', project: '番茄钟', title: '休息结束', body: '开始下一轮 25 分钟专注' },
      { source: 'gpt', eventId: 'fixture-gpt', project: '学习资料', title: '整理资料完成', detail: '已完成 · 学习资料' },
      { source: 'task', eventId: 'fixture-summary', title: '另有 6 个任务已完成' },
    ];
    for (const payload of otherPrompts) {
      await send({ ...payload, width: 348, height: 120, stripHeight: 34, collapsedWidth: 256 });
      await wait(480); await assertGeometry(34);
      assert.equal(await evaluate(`document.getElementById('notification-project').textContent`), payload.title, '番茄钟显示阶段结束，不能被项目字段“番茄钟”覆盖');
      assert.equal(await evaluate(`document.getElementById('notification-shell').dataset.source`), payload.source);
      assert.equal(await evaluate(`document.getElementById('notification-mark').dataset.kind`), payload.source === 'todo' ? 'reminder' : 'completed', '截止提醒不伪装为待办已完成');
      if (payload.detail || payload.body) assert.ok(await evaluate(`document.getElementById('notification-shell').title.includes(${JSON.stringify(payload.detail || payload.body)})`), '完整截止和下一阶段说明可通过悬浮及无障碍读取');
      if (process.env.FUDAO_POPUP_SCREENSHOTS) fs.writeFileSync(path.join(process.env.FUDAO_POPUP_SCREENSHOTS, payload.eventId + '.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.getElementById('notification-shell').dispatchEvent(new Event('pointerenter'))`);
      assert.deepEqual(received.hover, [], '所有被动提醒统一三秒停留，不因悬停延长');
      await evaluate(`document.getElementById('notification-shell').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
      await waitFor(`document.getElementById('notification-root').hidden`, 'Escape 应正常关闭提醒');
      assert.equal(received.dismissed.at(-1), payload.eventId);
    }
    for (const source of ['claude', 'kimi-code', 'gemini-cli', 'qwen-code']) {
      await send({ ...base, source, compactCode: true, eventId: `fixture-${source}`, project: `项目 ${source}` });
      await wait(480); await assertGeometry(34);
      window.webContents.send('task-notification:hide', `fixture-${source}`);
      await waitFor(`document.getElementById('notification-root').hidden`, `${source} completion closes normally`);
    }
    assert.deepEqual(await evaluate('window.__notificationErrors'), []);
    assert.deepEqual(nativeErrors,[]);
    console.log('Notification renderer: dual capsules, live theme without replay, stale appearance rejection, geometry, queue continuity, reduced motion and all sources passed');
  } finally { controller.dispose(); window.destroy(); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
