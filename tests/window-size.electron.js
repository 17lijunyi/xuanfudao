'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=process.env.FUDAO_APP_ROOT||path.join(__dirname,'..');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fudao-width-ui-'));app.setPath('userData',dir);
const {createWindowSizeSettingsService}=require(path.join(root,'window-size-settings'));
let fail=false;const service=createWindowSizeSettingsService({filePath:path.join(dir,'width.json'),fs:{...fs,promises:{...fs.promises,rename:async(...args)=>{if(fail)throw Error('disk');return fs.promises.rename(...args);}}}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function run(){
 await app.whenReady();const main=fs.readFileSync(path.join(root,'main.js'),'utf8');
 const display={bounds:{x:0,y:0,width:1512,height:982},workArea:{x:0,y:38,width:1512,height:944}};
 const prefs={preload:path.join(root,'preload.js'),contextIsolation:true,sandbox:true,backgroundThrottling:false};
 const work=new BrowserWindow({show:false,frame:false,width:1040,height:480,webPreferences:prefs});
 const quick=new BrowserWindow({show:false,frame:false,width:1040,height:308,webPreferences:prefs});
 const context=vm.createContext({__dirname:root,path,fileURLToPath:require('node:url').fileURLToPath,currentTab:'settings',currentMode:'expanded',windowSizeSettings:service,mainWindow:work,quickIslandWindow:quick,ipcMain,
  isIslandSender:new Function('__dirname','path','fileURLToPath','mainWindow','quickIslandWindow',main.slice(main.indexOf('function isIslandSender('),main.indexOf('\nfunction isStatusIslandSender('))+'; return isIslandSender;')(root,path,require('node:url').fileURLToPath,work,quick),
  appearanceNative:{clear(){}},screen:{getDisplayMatching:()=>display},
  getCenteredBounds:(width,height,d)=>({x:Math.round((d.bounds.width-width)/2),y:0,width,height}),
  getWindowDisplay:()=>display,QUICK_ISLAND_HEIGHT:270,
  broadcastIsland:(channel,snapshot)=>{work.webContents.send(channel,snapshot);quick.webContents.send(channel,snapshot);},
  getLayoutMetrics:()=>({stripHeight:38,menuBarHeight:38,safeAreaTop:38,collapsedWidth:256})});
 vm.runInContext(main.slice(main.indexOf('const EXPANDED_WIDTH ='),main.indexOf('const COLLAPSE_WATCHDOG_MS')),context);
 vm.runInContext(main.slice(main.indexOf('function getMenuBarHeight('),main.indexOf('// display 不传时')),context);
 vm.runInContext(main.slice(main.indexOf('function getQuickIslandBounds('),main.indexOf('\nfunction canShowQuickIsland')),context);
 context.getBoundsForMode=()=>{const {width,height}=context.getExpandedSize(display);return context.getCenteredBounds(width,height,display);};
 vm.runInContext(main.slice(main.indexOf("ipcMain.handle('window-size:get'"),main.indexOf("ipcMain.handle('appearance:get'")),context);
 const responses={
 'ai-tools:get':{ok:true,revision:0,catalog:require(path.join(root,'ai-tools')).CATALOG,state:{selected:'codex',confirmed:true},needsSetup:false},
 'ai-code:get':{providerId:'codex',selectionRevision:0,connection:'unavailable',windows:[],threads:[]},
 'window:metrics':context.getLayoutMetrics(), 'workspace:get':{path:dir},'workspace:load-data':{},
 'settings:get':{features:{todo:true,notes:true,links:true,recordings:true,credentials:true,clip:true}},
 'appearance:get':{selectedId:'system-glass-blurred',revision:0},'transcription:get-config':{},'credentials:list':{items:[]},'tasks:recent':[],
 'quick-launch:list':{items:[]},'codex-float:get':{providerId:'codex',connection:'unavailable',windows:[],threads:[],resets:{available:null}},
 };
 for(const channel of new Set([...fs.readFileSync(path.join(root,'preload.js'),'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]))){
  if(channel.startsWith('window-size:'))continue;
  ipcMain.handle(channel,(_e,...args)=>channel==='window:set-mode'?{ok:true,mode:args[0]}:responses[channel]??null);
 }
 const evalWork=code=>work.webContents.executeJavaScript(code);
 async function waitFor(code){for(let i=0;i<150;i++){if(await evalWork(code))return;await delay(25);}throw Error('timeout '+code);}
 try{
 await work.loadFile(path.join(root,'renderer/index.html'));await quick.loadFile(path.join(root,'renderer/quick-island.html'));
 work.showInactive();work.webContents.send('island:open-workspace','settings');quick.webContents.send('quick-island:show',{interactive:true,width:1040,height:308,menuBarHeight:38,stripHeight:38});
 await waitFor(`document.querySelector('[data-window-size-preset="B"]')?.disabled===false && !modeBusy && !tabBusy`);
 await evalWork('cardReflow.whenIdle()');
 assert.equal(await evalWork(`document.querySelector('.settings-appearance-card').nextElementSibling.classList.contains('settings-window-size-card')`),true);
 assert.equal(await evalWork("document.querySelectorAll('[data-window-size-preset]').length"),2);
 assert.deepEqual(await evalWork("Array.from(document.querySelectorAll('#settings-window-size-options strong'),el=>el.textContent)"),['适合 14 寸或 13 寸','适合 16 寸或 15.3 寸']);
 for(const [id,width] of [['A',1240],['B',1040]]){
  await evalWork(`document.querySelector('[data-window-size-preset="${id}"]').click()`);
  await waitFor(`document.querySelector('#settings-window-size-options').getAttribute('aria-busy')==='false' && document.querySelector('[data-window-size-preset="${id}"]').getAttribute('aria-checked')==='true'`);
  await evalWork('cardReflow.whenIdle()');
  assert.equal(await evalWork("document.querySelector('#settings-window-size-options').firstElementChild.dataset.windowSizePreset"),id,'selected size moves to the first position');
  assert.deepEqual(work.getSize(),[width,480]);assert.deepEqual(quick.getSize(),[width,308]);assert.equal(work.getBounds().x,Math.round((1512-width)/2));
  assert.equal(await evalWork(`document.querySelector('#tab-settings').classList.contains('active')`),true);
  await delay(150);
  assert.equal(await quick.webContents.executeJavaScript(`(()=>{const x=document.querySelector('.island-content');return x.scrollWidth<=x.clientWidth+1})()`),true,'quick cards fit '+width);
 }
 fail=true;await evalWork(`document.querySelector('[data-window-size-preset="A"]').click()`);await waitFor(`document.querySelector('#settings-window-size-note').dataset.state==='error'`);assert.equal(work.getSize()[0],1040);fail=false;
 await evalWork(`document.querySelector('[data-window-size-preset="A"]').click();document.querySelector('[data-window-size-preset="B"]').click()`);
 await waitFor(`document.querySelector('#settings-window-size-options').getAttribute('aria-busy')==='false'`);assert.equal(service.getSnapshot().width,1040);
 assert.equal(createWindowSizeSettingsService({filePath:path.join(dir,'width.json')}).getSnapshot().width,1040);
 context.currentMode='collapsed';work.setSize(256,38);await evalWork(`window.notchAPI.setWindowSizePreset('A')`);assert.deepEqual(work.getSize(),[256,38]);assert.equal(quick.getSize()[0],1240);await evalWork(`window.notchAPI.setWindowSizePreset('B')`);
 await quick.webContents.executeJavaScript(`document.querySelector('[data-quick-preference="size"]').click(); document.querySelector('[data-window-size-preset="A"]').click()`);
 await waitFor(`document.documentElement.dataset.windowSize === 'A'`);
 assert.equal(quick.getSize()[0],1240);assert.deepEqual(work.getSize(),[256,38],'quick width choices preserve collapsed workbench');
 assert.equal(await quick.webContents.executeJavaScript(`(()=>{const r=document.querySelector('#quick-size-panel').getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`),true,'quick width menu fits');
 await quick.webContents.executeJavaScript(`document.querySelector('[data-window-size-preset="B"]').click()`);
 await waitFor(`document.documentElement.dataset.windowSize === 'B'`);
 assert.equal(quick.getSize()[0],1040);
 context.currentMode='expanded';work.setBounds(context.getBoundsForMode());
 await evalWork(`document.querySelector('.settings-window-size-card').scrollIntoView({block:'center'})`);await delay(150);
 if(process.env.FUDAO_WIDTH_SCREENSHOTS){fs.mkdirSync(process.env.FUDAO_WIDTH_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.FUDAO_WIDTH_SCREENSHOTS,'settings.png'),(await work.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(process.env.FUDAO_WIDTH_SCREENSHOTS,'quick.png'),(await quick.webContents.capturePage()).toPNG());}
 await quick.loadURL('about:blank');
 assert.equal((await quick.webContents.executeJavaScript(`window.notchAPI.setWindowSizePreset('A')`)).error,'unauthorized','navigation away from trusted quick page is rejected');
 console.log('PASS window size: real IPC, two widths, both windows, centered, persisted restart, fast clicks, save failure, quick controls, collapsed safety, sender guard, quick layout');
 }finally{work.destroy();quick.destroy();}
}
run().then(()=>{fs.rmSync(dir,{recursive:true,force:true});app.exit(0)}).catch(e=>{console.error(e);app.exit(1)});
