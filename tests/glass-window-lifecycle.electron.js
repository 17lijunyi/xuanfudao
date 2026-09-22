'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { app, BrowserWindow, screen } = require('electron');
const root = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-glass-lifecycle-'));
app.setPath('userData', data);
app.once('will-quit', () => fs.rmSync(data, { recursive:true, force:true }));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function section(start, end) {
  const from=source.indexOf(start), to=source.indexOf(end,from);
  assert.ok(from>=0 && to>from); return source.slice(from,to);
}
async function main() {
  await app.whenReady();
  const addonPath = fs.existsSync(path.join(root,'native/appearance-glass.node')) ? path.join(root,'native/appearance-glass.node') : path.join(root,'.cache/native/appearance-glass.node');
  const native = require(addonPath);
  const appearanceNative = require(path.join(root,'appearance-native')).createAppearanceNativeController({addonPath});
  const display = screen.getPrimaryDisplay();
  function bounds(mode) { const width=mode==='expanded'?1240:256, height=mode==='expanded'?654:38; return {x:Math.round(display.bounds.x+(display.bounds.width-width)/2),y:display.bounds.y,width,height}; }
  const mainWindow = new BrowserWindow({...bounds('collapsed'),frame:false,transparent:true,show:false,hasShadow:false,webPreferences:{backgroundThrottling:false}});
  const quickIslandWindow = new BrowserWindow({...bounds('expanded'),height:308,frame:false,transparent:true,show:false,hasShadow:false,focusable:false,webPreferences:{backgroundThrottling:false}});
  await mainWindow.loadURL('data:text/html,<body style="margin:0;background:black;color:white">running task</body>');
  await quickIslandWindow.loadURL('data:text/html,<body style="margin:0;color:black">island content</body>');
  const context = vm.createContext({
    systemUIBlocks: () => false,
    windowHandoff: require('../window-handoff').createWindowHandoffController(),
    mainWindow, quickIslandWindow, appearanceNative, currentMode:'collapsed',
    appearanceSettings: { getSnapshot: () => ({ selectedId: 'system-glass-blurred' }) },
    quickIslandGeneration:0,quickIslandInteractive:false,quickIslandNativeFocusable:false,quickIslandHideTimer:null,quickIslandOpening:0,
    isQuitting:false,workbenchOpeningUntil:0,workbenchOpeningRevision:0,notchPreviewActive:false,activeTaskNotification:null,notificationWindow:null,
    hideWhenCollapsed:false,collapseGeneration:0,collapseWatchdog:null,
    QUICK_ISLAND_HIDE_MS:40,COLLAPSED_WIDTH:256,app,
    setTimeout,clearTimeout,Date,Promise,
    stopQuickIslandPointerWatch:()=>{},startQuickIslandPointerWatch:()=>{},syncHoverSpacePolling:()=>{},refreshTrayMenu:()=>{},
    statusIsland:{hide:()=>{},sync:async()=>{},syncForAppSurface:async()=>{}},
    getWindowDisplay:()=>display,getCollapsedHeight:()=>38,getMenuBarHeight:()=>38,getBoundsForMode:bounds,getLayoutMetrics:()=>({stripHeight:38}),
    getQuickIslandBounds:()=>({...bounds('expanded'),height:308}),createQuickIslandWindow:async()=>quickIslandWindow,
    islandActivities:{},systemStatus:{getSnapshot:async()=>({})},isIslandSender:()=>true,
    normalizeAppearanceSurface:require(path.join(root,'appearance-surface')).normalizeAppearanceSurface,
    ipcMain:{on:(_name,handler)=>{context.surfaceHandler=handler;}},
  });
  vm.runInContext([
    section('function canShowQuickIsland(', root===path.resolve(__dirname,'..')?'\nfunction dismissNotchPreviewSurface(':'\nfunction stopQuickIslandPointerWatch('),
    section('function setCollapsedIslandCovered(', '\nfunction startQuickIslandPointerWatch('),
    section('async function showQuickIsland(', '\nfunction cancelCollapseWatchdog('),
    section('function cancelCollapseWatchdog(', '\nfunction repositionWindow('),
    section("ipcMain.on('appearance:surface'", "\nipcMain.handle('settings:set-feature'"),
  ].join('\n'),context);
  function payload(window) {const b=window.getContentBounds();return {viewport:{width:b.width,height:b.height},surface:{x:0,y:0,width:b.width,height:b.height,opacity:1,radii:[0,0,34,34],backgroundBlurRadius:3}};}
  try {
    mainWindow.showInactive();
    for (let i=0;i<6;i++) {
      vm.runInContext("applyMode('expanded')",context);
      context.surfaceHandler({sender:mainWindow.webContents},payload(mainWindow));
      assert.ok(native.inspect(mainWindow.getNativeWindowHandle()));
      vm.runInContext("applyMode('collapsed')",context);
      assert.equal(native.inspect(mainWindow.getNativeWindowHandle()),null,'return clears old workbench background before the next surface');
      const result = await vm.runInContext(`showQuickIsland({focus:${i%2===1}})`,context);
      assert.equal(result.ok,true);
      assert.equal(mainWindow.isVisible(),true,'entry policy remains live while covered');
      assert.equal(mainWindow.getOpacity(),0,'collapsed task wings do not overlay the island');
      assert.equal(quickIslandWindow.getOpacity(),1,'island text remains fully opaque');
      context.surfaceHandler({sender:quickIslandWindow.webContents},payload(quickIslandWindow));
      assert.ok(native.inspect(quickIslandWindow.getNativeWindowHandle()));
      await mainWindow.webContents.executeJavaScript(`document.body.textContent='${i} running projects'`);
      assert.equal(mainWindow.getOpacity(),0,'task updates cannot expose the covered collapsed window');
      const late=payload(quickIslandWindow);
      vm.runInContext(`hideQuickIsland(${i%2===0})`,context);
      await wait(65);
      assert.equal(quickIslandWindow.isVisible(),false);
      assert.equal(mainWindow.getOpacity(),1,'collapsing restores task marks');
      context.surfaceHandler({sender:quickIslandWindow.webContents},late);
      assert.equal(native.inspect(quickIslandWindow.getNativeWindowHandle()),null,'late renderer frames cannot revive a hidden backdrop');
    }
    console.log('PASS glass lifecycle: six workbench returns, passive/focused island, running-task updates, opaque content, restore and late-frame cleanup');
  } finally {appearanceNative.dispose();mainWindow.destroy();quickIslandWindow.destroy();}
}
main().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
