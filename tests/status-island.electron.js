const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const appRoot = process.env.FUDAO_APP_ROOT || path.join(__dirname, '..');
const { createIslandStatusWindow, getStatusIslandBounds } = require(path.join(appRoot, 'island-status-window'));
const { statusIslandSurfaceAllowed } = require('../island-activities');
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-status-island-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const display = { bounds: { x: 0, y: 100, width: 800, height: 900 } };
  const adjustableVolume = { kind: 'volume', adjustable: true, value: 52 };
  assert.deepEqual(getStatusIslandBounds(display, 38, false, adjustableVolume), { x: 226, y: 100, width: 348, height: 124 });
  assert.deepEqual(getStatusIslandBounds({ bounds: { x: -1920, y: -1080, width: 1920, height: 1080 } }, 38, false, adjustableVolume), { x: -1134, y: -1080, width: 348, height: 124 }, 'the selected display origin controls both centering and top edge');
  assert.deepEqual(getStatusIslandBounds({ bounds: { x: 1200, y: 300, width: 240, height: 800 } }, 24, false, adjustableVolume), { x: 1224, y: 300, width: 192, height: 110 }, 'a narrow display retains 24 px of horizontal safety space');
  assert.deepEqual(getStatusIslandBounds(display, 38, true, adjustableVolume), { x: 220, y: 100, width: 360, height: 38 });
  assert.deepEqual(getStatusIslandBounds(display, 38, false, { kind: 'task-completed', collapsedWidth: 256 }), { x: 226, y: 100, width: 348, height: 124 }, 'task completion keeps the folded island width and template 04 content below the notch');
  for (const payload of [{ kind: 'headphones', value: '已连接' }, { kind: 'brightness', adjustable: false, value: 60 }, { kind: 'brightness', adjustable: true, value: null }]) {
    assert.deepEqual(getStatusIslandBounds(display, 38, false, payload), { x: 226, y: 100, width: 348, height: 124 }, 'nonadjustable and unavailable states share the completion popup bounds');
  }
  let stripHeight = 38;
  let allowed = true;
  let attention = false;
  let deferred;
  const calls = [];
  const brightnessCalls = [];
  let appearance = { selectedId: 'classic', revision: 0 };
  const addonPath = process.env.FUDAO_APPEARANCE_ADDON || [path.join(appRoot,'native/appearance-glass.node'),path.join(appRoot,'.cache/native/appearance-glass.node')].find(file=>fs.existsSync(file));
  const native = process.platform === 'darwin' && addonPath ? require(addonPath) : null;
  const nativeErrors = [];
  const appearanceNative = require(path.join(appRoot,'appearance-native')).createAppearanceNativeController({addonPath,onError:error=>nativeErrors.push(error.message)});
  const controller = createIslandStatusWindow({ BrowserWindow, getAppearance: () => appearance, appearanceNative, getBounds: (compact, data) => getStatusIslandBounds(display, stripHeight, compact, data), isAllowed: data => statusIslandSurfaceAllowed(data, {
    codexAttentionActive: attention,
    passiveAllowed: allowed,
  }) });
  ipcMain.handle('system:volume:set', async (_, value) => { calls.push(value); if (value === 80) return new Promise(resolve => { deferred = resolve; }); return { ok: true, volume: value === 0 || value === 100 ? value : 25, muted: value === 0 }; });
  ipcMain.handle('system:brightness:set', async (_, value) => { brightnessCalls.push(value); return value === 0 || value === 100 ? { ok: true, brightness: value } : { ok: false, error: 'unsupported' }; });
  ipcMain.on('island:status-surface', (_event,payload)=>controller.updateSurface(payload));
  ipcMain.on('island:status-hold', (_, held) => controller.hold(held));
  ipcMain.handle('island:status-dismiss', () => controller.dismiss());
  const evaluate = source => controller.getWindow().webContents.executeJavaScript(source);
  async function waitFor(source) {
    const end = Date.now() + 2500;
    while (Date.now() < end) { if (await evaluate(source)) return; await delay(20); }
    assert.fail(`Timed out: ${source}`);
  }
  const changeRange = value => evaluate(`(() => {const el=document.getElementById('status-range');el.value=${value};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  async function assertCapsuleLayout(kind, adjustable = true, strip = 38) {
    await waitFor(`innerWidth === 348 && innerHeight === ${strip + 86} && document.getElementById('status-island').dataset.layout === 'capsules'`);
    await waitFor(`document.getElementById('status-island').dataset.visible === 'true'`);
    await delay(80);
    await waitFor(`document.getElementById('status-expanded').getAnimations({subtree:true}).length === 0`);
    const layout = await evaluate(`(() => {
      const rect = id => { const {x,y,width,height,right,bottom} = document.getElementById(id).getBoundingClientRect(); return {x,y,width,height,right,bottom}; };
      const font = getComputedStyle(document.getElementById('status-heading'));
      return { width:innerWidth, height:innerHeight, heading:rect('status-heading'), main:rect('status-main'), icon:rect('status-close'), range:rect('status-range'),
        rangeHidden:document.getElementById('status-range').hidden,
        font:[font.fontFamily,font.fontSize,font.fontWeight,font.letterSpacing,font.textAlign,font.textOverflow],
        background:getComputedStyle(document.getElementById('status-main')).backgroundColor };
    })()`);
    assert.equal(layout.main.x,16);
    assert.equal(layout.main.width,254);
    assert.equal(layout.main.y,strip+16);
    assert.equal(layout.main.height,54);
    assert.equal(layout.icon.x,278);
    assert.equal(layout.icon.width,54);
    assert.equal(layout.icon.height,54);
    assert.equal(layout.icon.x-layout.main.right,8);
    assert.match(layout.font[0], /^-apple-system/);
    assert.deepEqual(layout.font.slice(1), ['13px','400','normal','left','ellipsis']);
    assert.equal(layout.background, 'rgb(5, 5, 6)');
    assert.equal(layout.rangeHidden, !adjustable);
    assert.equal(await evaluate(`document.getElementById('status-bookmark-line') === null`),true);
    if (adjustable) assert.ok(layout.range.width >= 24 && layout.range.height >= 16 && layout.range.right <= layout.main.right && layout.range.bottom <= layout.main.bottom);
    const snapshot = await controller.getWindow().webContents.capturePage();
    const captureDir = process.env.FUDAO_POPUP_SCREENSHOTS || path.join(__dirname, '..', '.cache');
    fs.mkdirSync(captureDir, { recursive: true });
    fs.writeFileSync(path.join(captureDir, `status-${kind}.png`), snapshot.toPNG());
    const size = snapshot.getSize({ scaleFactor: 1 });
    const bitmap = snapshot.toBitmap({ scaleFactor: 1 });
    const xScale = size.width / layout.width;
    const yScale = size.height / layout.height;
    let foregroundInNotch = 0;
    let foregroundBelowNotch = 0;
    for (let y = 0; y < size.height; y++) {
      for (let x = Math.ceil(74 * xScale); x < Math.floor(274 * xScale); x++) {
        const offset = (y * size.width + x) * 4;
        const foreground = bitmap[offset + 3] > 100 && Math.min(bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]) > 100;
        if (foreground && y < strip * yScale) foregroundInNotch++;
        else if (foreground) foregroundBelowNotch++;
      }
    }
    assert.equal(foregroundInNotch, 0, '刘海安全区中没有任何文字、图标或调节条像素');
    assert.ok(foregroundBelowNotch > 0, '提示真实绘制在刘海下方');
    return layout;
  }

  try {
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 52, adjustable: true });
    controller.getWindow().setIgnoreMouseEvents(true);
    await waitFor(`document.getElementById('status-island').dataset.visible === 'true'`);
    assert.equal(controller.getWindow().isFocused(), false, 'automatic feedback must not take focus');
    assert.equal(await evaluate(`document.getElementById('status-range').value`), '52');
    const volumeLayout = await assertCapsuleLayout('volume');
    await evaluate(`(() => {const el=document.getElementById('status-range');el.value=23;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.getElementById('status-range').value === '25'`);
    assert.deepEqual(calls, [23], 'write result is read back, not assumed');
    for (const value of [0, 100]) {
      await changeRange(value);
      await waitFor(`document.getElementById('status-range').value === '${value}' && document.getElementById('status-number').value === '${value}%'`);
      const writeDeadline = Date.now() + 1500;
      while (calls.at(-1) !== value && Date.now() < writeDeadline) await delay(20);
      assert.equal(calls.at(-1), value, 'the endpoint reaches the real preload bridge');
      await delay(30);
      assert.equal(await evaluate(`document.getElementById('status-range').getAttribute('aria-valuetext')`), `${value}%`);
      assert.equal(await evaluate(`document.getElementById('status-error').hidden`), true);
    }
    const beforeMouse = calls.length;
    const webContents = controller.getWindow().webContents;
    const pointer = { x: Math.round(volumeLayout.width / 2), y: Math.round(volumeLayout.range.y + volumeLayout.range.height / 2), button: 'left', clickCount: 1 };
    webContents.sendInputEvent({ type: 'mouseMove', x: pointer.x, y: pointer.y });
    webContents.sendInputEvent({ type: 'mouseDown', ...pointer });
    webContents.sendInputEvent({ type: 'mouseUp', ...pointer });
    const mouseDeadline = Date.now() + 1500;
    while (calls.length === beforeMouse && Date.now() < mouseDeadline) await delay(20);
    assert.equal(calls.length, beforeMouse + 1, 'clicking the visible lower track sends a system write');
    assert.ok(calls.at(-1) > 0 && calls.at(-1) < 100);
    await waitFor(`document.getElementById('status-range').value === '25'`);
    await evaluate(`(() => {const el=document.getElementById('status-range');el.value=80;el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const deadline = Date.now() + 1500;
    while (!deferred && Date.now() < deadline) await delay(20);
    assert.equal(typeof deferred, 'function');
    controller.hide(true);
    deferred({ ok: false, error: 'failed' });
    await delay(30);
    assert.equal(await evaluate(`document.getElementById('status-error').hidden`), true, 'late write response cannot revive a hidden HUD');
    await controller.dismiss();
    await controller.setPersistent({ kind: 'timer', title: '番茄钟', value: '03:20', target: 'home', compact: true });
    await waitFor(`document.getElementById('status-island').dataset.compact === 'true'`);
    assert.equal(controller.getWindow().getBounds().height, 38);
    attention = true;
    await controller.sync();
    assert.equal(controller.getWindow().isVisible(), false, 'Codex attention must replace a passive timer surface');
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 25, adjustable: true, fromMediaKey: true });
    assert.equal(controller.getWindow().isVisible(), true, 'a direct media-key adjustment gets brief feedback during attention');
    await controller.dismiss();
    assert.equal(controller.getWindow().isVisible(), false, 'attention returns after direct feedback closes');
    await controller.showFeedback({ kind: 'brightness', title: '屏幕亮度', value: 40, adjustable: true, interactive: true });
    assert.equal(controller.getWindow().isVisible(), true, 'an explicit quick-island control remains usable during Codex attention');
    assert.equal(controller.getWindow().isFocusable(), true);
    await controller.syncForAppSurface();
    assert.equal(controller.getWindow().isVisible(), true, 'opening another app surface must preserve an explicit interactive control');
    await controller.dismiss();
    attention = false;
    await controller.sync();
    await waitFor(`document.getElementById('status-island').dataset.compact === 'true'`);
    assert.equal(controller.getWindow().isVisible(), true, 'clearing attention restores the persistent timer');
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 25, adjustable: true, interactive: true });
    deferred = null;
    await evaluate(`(() => {const el=document.getElementById('status-range');el.value=80;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const secondDeadline = Date.now() + 1500;
    while (!deferred && Date.now() < secondDeadline) await delay(20);
    assert.equal(typeof deferred, 'function');
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 44, adjustable: true });
    assert.equal(controller.getWindow().isFocusable(), true, 'native readback must preserve a manual interaction session');
    deferred({ ok: true, volume: 80, muted: false });
    await waitFor(`document.getElementById('status-range').value === '44'`);
    await controller.dismiss();
    assert.equal(controller.getWindow().isFocusable(), false, 'return to a persistent activity must release keyboard focus');
    await controller.showFeedback({ kind: 'brightness', title: '屏幕亮度', value: 60, adjustable: true });
    await waitFor(`document.getElementById('status-title').textContent === '屏幕亮度'`);
    await assertCapsuleLayout('brightness');
    assert.equal(await evaluate(`typeof window.notchAPI.setSystemBrightness`), 'undefined', 'removed brightness IPC must stay absent');
    await changeRange(0);
    await waitFor(`!document.getElementById('status-error').hidden`);
    assert.deepEqual(brightnessCalls, [], 'legacy brightness payload cannot regain control of system brightness');
    assert.equal(await evaluate(`document.getElementById('status-range').value`), '60', 'unavailable bridge restores the last confirmed value');
    await controller.dismiss();
    const prompts = [
      { kind: 'battery', title: '已连接电源', value: '100%', fixture: 'power' },
      { kind: 'battery', title: '正在充电', value: '65%', fixture: 'charging' },
      { kind: 'battery', title: '使用电池', value: '84%', fixture: 'unplugged' },
      { kind: 'battery', title: '使用电池', value: '20%', fixture: 'low20' },
      { kind: 'battery', title: '使用电池', value: '10%', fixture: 'low10' },
      { kind: 'headphones', title: '声音输出已切换', detail: 'AirPods Pro', fixture: 'headphones' },
      { kind: 'output', title: '声音输出已切换', detail: 'MacBook Pro 扬声器', fixture: 'speaker' },
      { kind: 'headphones', title: '声音输出已切换', detail: '一个非常长的蓝牙耳机名称，用来确认不会挡住右侧图标 <script>不能执行</script>', fixture: 'long-device' },
      { kind: 'volume', title: '已静音', value: 0, adjustable: true, fixture: 'muted' },
      { kind: 'volume', title: '音量不可用', detail: '请使用系统设置调节', fixture: 'volume-unavailable' },
      { kind: 'brightness', title: '此显示器的亮度不可用', detail: '请使用系统设置调节', fixture: 'brightness-unavailable' },
    ];
    for (const payload of prompts) {
      await controller.showFeedback(payload);
      await assertCapsuleLayout(payload.fixture, payload.adjustable === true);
      if (payload.detail) {
        assert.ok(await evaluate(`document.getElementById('status-heading').title.includes(${JSON.stringify(payload.detail)})`));
        assert.equal(await evaluate(`document.getElementById('status-detail').children.length`), 0, '设备名称只能以文本展示');
      }
      assert.equal(await evaluate(`document.getElementById('status-error').hidden`), true, '切换提示不能留下上一次控件错误');
    }
    await controller.showFeedback({kind:'headphones', title:'声音输出已切换', detail:'AirPods Pro'});
    await delay(480);
    const eventId = await evaluate('document.documentElement.dataset.appearance');
    assert.equal(eventId,'classic');
    const focusBeforeTheme = controller.getWindow().isFocused();
    appearance={selectedId:'system-glass-blurred',revision:1};
    controller.syncAppearance(appearance);
    await waitFor(`document.documentElement.dataset.appearance==='system-glass-blurred'`);
    if (native) {
      await waitFor(`document.documentElement.dataset.nativeGlass==='true'`);
      assert.equal(native.inspect(controller.getWindow().getNativeWindowHandle(),0).width,254);
      assert.equal(native.inspect(controller.getWindow().getNativeWindowHandle(),1).width,54);
      controller.updateSurface({eventId:'stale-event',surfaces:null});
      assert.ok(native.inspect(controller.getWindow().getNativeWindowHandle(),1),'旧事件不能清除当前胶囊');
    }
    assert.equal(await evaluate(`document.getElementById('status-expanded').getAnimations({subtree:true}).length`),0,'切主题不能重播');
    controller.getWindow().webContents.send('appearance:changed',{selectedId:'classic',revision:0});
    await delay(50);
    assert.equal(await evaluate('document.documentElement.dataset.appearance'),'system-glass-blurred','旧快照不能覆盖新材质');
    assert.equal(controller.getWindow().isFocused(),focusBeforeTheme,'切主题不能改变原来的焦点');
    assert.equal(controller.getWindow().isFocusable(),false);
    appearance={selectedId:'classic',revision:2};
    controller.syncAppearance(appearance);
    await waitFor(`document.documentElement.dataset.appearance==='classic'`);
    if(native) assert.equal(native.inspect(controller.getWindow().getNativeWindowHandle(),1),null);
    await controller.dismiss();
    assert.equal(controller.getCurrent().compact,true,'短时提醒后恢复计时');
    if(native) assert.equal(native.inspect(controller.getWindow().getNativeWindowHandle(),0),null);
    assert.deepEqual(nativeErrors,[]);
    const debuggerSession = controller.getWindow().webContents.debugger;
    debuggerSession.attach('1.3');
    await debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    for (const height of [24, 34, 80]) {
      stripHeight = height;
      await controller.showFeedback({ kind: 'battery', title: '使用电池', value: '20%' });
      await assertCapsuleLayout(`menu-${height}`, false, height);
      assert.equal(await evaluate(`document.getElementById('status-island').getAnimations({subtree:true}).length`), 0);
    }
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 52, adjustable: true });
    await assertCapsuleLayout('volume-reduced-motion', true, 80);
    await debuggerSession.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    debuggerSession.detach();
    stripHeight = 38;
    await controller.dismiss();
    allowed = false;
    await controller.sync();
    assert.equal(controller.getWindow().isVisible(), false, 'expanded workspace/notification suppresses system HUD');
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 44, adjustable: true, fromMediaKey: true });
    assert.equal(controller.getWindow().isVisible(), true, 'handled media keys retain their HUD over an expanded workspace');
    await controller.syncForAppSurface();
    assert.equal(controller.getWindow().isVisible(), true, 'opening another app surface must not consume direct key feedback');
    assert.equal(controller.getWindow().isFocused(), false, 'handled media keys never steal workspace focus');
    await controller.dismiss();
    assert.equal(controller.getWindow().isVisible(), false, 'persistent activities remain hidden after the keyboard HUD expires');
    allowed = true;
    await controller.dismiss();
    await waitFor(`document.getElementById('status-island').dataset.compact === 'true'`);
    await controller.setPersistent(null);
    await controller.showFeedback({ kind: 'volume', title: '音量', value: 44, adjustable: true, interactive: true });
    controller.hold(true);
    controller.getWindow().destroy();
    await controller.sync();
    assert.equal(controller.getWindow(), null, 'a crashed held transient must not be recreated forever');
    console.log('Status island: real preload, shared dual-capsule geometry, all prompt kinds and pixels, mouse hit target, endpoints, readback, stale response, focus and activity return passed');
  } finally { controller.destroy(); appearanceNative.dispose(); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
