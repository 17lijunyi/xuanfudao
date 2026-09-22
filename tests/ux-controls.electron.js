const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { cleanActivity } = require('../island-activities');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-ux-'));
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, {recursive:true, force:true}));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  const preload = path.join(__dirname, '../preload.js');
  const options = {show:false, frame:false, webPreferences:{preload, backgroundThrottling:false}};
  const workspace = new BrowserWindow({...options, width:256, height:38});
  const quick = new BrowserWindow({...options, width:1240, height:270});
  const requests = [];
  const activities = {};
  let vault = [];
  const responses = {
    'ai-tools:get': {ok:true,revision:0,catalog:require('../ai-tools').CATALOG,state:{selected:'codex',confirmed:true},needsSetup:false},
    'ai-code:get': {providerId:'codex',selectionRevision:0,connection:'unavailable',windows:[],threads:[]},
    'window:metrics': {stripHeight:38, menuBarHeight:38, safeAreaTop:38, collapsedWidth:256, notchCenterWidth:200, notchWingWidth:28},
    'workspace:get': {path:userData}, 'workspace:load-data': {},
    'settings:get': {features:{todo:true,notes:true,links:true,recordings:true,credentials:true,clip:true}},
    'transcription:get-config': {configured:false, llmConfigured:false},
    'codex-float:get': {providerId:'codex',connection:'unavailable',windows:[],threads:[],resets:{available:null}},
    'windows:list': {items:[]}, 'credentials:list': {items:[],secureStorage:true}, 'tasks:recent': [],
    'quick-launch:list': {items:[]},
    'system:status': {},
  };
  const channels = [...new Set([...fs.readFileSync(preload,'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]))];
  for (const channel of channels) ipcMain.handle(channel, async (event,...args) => {
    requests.push({channel,args});
    if(channel==='window:set-mode') {workspace.setSize(...(args[0]==='expanded'?[1240,480]:[256,38]));return {ok:true,mode:args[0]};}
    if(channel==='quick-island:open-workspace') { workspace.webContents.send('island:open-workspace',args[0]);return {ok:true}; }
    if(channel==='quick-island:return') { quick.webContents.send('quick-island:show',{interactive:true,width:1240,height:270,stripHeight:38});workspace.setSize(256,38);workspace.webContents.send('window:request-collapse',{immediate:true});return {ok:true}; }
    if(channel==='island:activities-get') return activities;
    if(channel==='quick-island:show') {quick.webContents.send('quick-island:show',{interactive:true,width:1240,height:270,stripHeight:38});return {ok:true};}
    if(channel==='pomodoro:control') {workspace.webContents.send('pomodoro:control',args[0]); await sleep(40); return {ok:true};}
    if(channel==='credentials:save'){vault=[{id:'fixture-vault',service:args[0].service,account:args[0].account,passwordMask:'********'}];return {ok:true};}
    if(channel==='credentials:list')return {items:vault,secureStorage:true};
    if(channel==='credentials:delete-many'){vault=[];return {ok:true};}
    if(channel==='credentials:copy')return true;
    if(channel==='settings:set-shortcut') return {ok:true};
    return responses[channel] ?? null;
  });
  ipcMain.on('island:activity-update', (event, state) => {
    const value=cleanActivity(state);if(value){activities[value.kind]=value;quick.webContents.send('island:activities',activities);}
  });
  async function evaluate(w,code) {try{return await w.webContents.executeJavaScript(code);}catch(error){throw new Error(error.message+'\n'+code);}}
  async function waitFor(w,condition,message) {
    for(let i=0;i<150;i++){if(await evaluate(w,condition))return; await sleep(20);}
    throw Error(message);
  }
  async function click(w,selector) {
    const point = await evaluate(w,`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw Error('missing '+${JSON.stringify(selector)});
      node.scrollIntoView({block:'nearest'});
      const box=node.getBoundingClientRect();
      const x=box.x+box.width/2, y=box.y+box.height/2;
      const hit=document.elementFromPoint(x,y);
      if (!box.width || !box.height || node.closest('[inert]') || node.disabled || !(node===hit || node.contains(hit))) throw Error('unreachable '+${JSON.stringify(selector)}+' hit '+hit?.outerHTML.slice(0,200));
      return {x,y};
    })()`);
    await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
    await sleep(40);
  }
  try {
    for(const w of [workspace,quick]) {
      await w.loadURL('about:blank');w.webContents.debugger.attach('1.3');
      await w.webContents.debugger.sendCommand('Page.enable');
      await w.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`window.__ux={errors:[],offset:0};const realNow=Date.now;Date.now=()=>realNow()+window.__ux.offset;addEventListener('error',e=>window.__ux.errors.push(e.message));addEventListener('unhandledrejection',e=>window.__ux.errors.push(String(e.reason)));`});
      await w.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    }
    await workspace.loadFile(path.join(__dirname,'../renderer/index.html'));
    await quick.loadFile(path.join(__dirname,'../renderer/quick-island.html'));
    workspace.showInactive();quick.showInactive();
    quick.webContents.send('quick-island:show',{interactive:true,width:1240,height:270,stripHeight:38});
    await waitFor(quick,`document.querySelector('#quick-island').dataset.visible==='true'`,'quick island show');
    await click(quick,'[data-workspace="settings"]');
    await waitFor(workspace,`document.querySelector('#app').classList.contains('expanded') && document.querySelector('#tab-settings').classList.contains('active')`,'settings gear must open settings from collapsed island');
    quick.hide();
    await sleep(80);
    fs.writeFileSync(path.join(os.tmpdir(),'fudao-ux-settings.png'),(await workspace.webContents.capturePage()).toPNG());
    console.log('PASS gear -> real preload -> settings opens');
    for(const tab of ['home','todo','projects','codes','notes','links','recordings','credentials','clip','settings']) {
      await click(workspace,`[data-tab="${tab}"]`);
      await waitFor(workspace,`document.querySelector('#tab-${tab}').classList.contains('active')`,'navigation '+tab);
    }
    for (const size of [[1240,480],[1000,480]]) {
      workspace.setSize(...size);await sleep(80);
      const blocked = await evaluate(workspace, `(() => {
        const bad=[];
        for(const node of document.querySelectorAll('#tab-settings button, #tab-settings label')) {
          if(!node.getClientRects().length || node.hidden || node.disabled || getComputedStyle(node).visibility==='hidden')continue;
          const hidden=[];for(let parent=node.parentElement;parent;parent=parent.parentElement){if(getComputedStyle(parent).overflowY==='hidden')hidden.push([parent,parent.scrollTop]);}
          node.scrollIntoView({block:'nearest'});
          for(const [parent,top] of hidden)if(parent.scrollTop!==top)bad.push({id:node.id||node.innerText,clippedBy:parent.className});
          const b=node.getBoundingClientRect();const hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
          if(!(node===hit||node.contains(hit)))bad.push({id:node.id||node.innerText,hit:hit?.id||hit?.className});
        }
        return bad;
      })()`);
      assert.deepEqual(blocked,[],`settings controls must be reachable at ${size}`);
    }
    workspace.setSize(1240,480);await sleep(80);
    await click(workspace,'#settings-api-configure');
    assert.equal(await evaluate(workspace,`document.querySelector('#transcription-settings-backdrop').hidden`),false);
    workspace.webContents.send('key:escape');await sleep(40);
    assert.equal(await evaluate(workspace,`document.querySelector('#transcription-settings-backdrop').hidden`),true);
    assert.equal(await evaluate(workspace,`document.querySelector('#app').classList.contains('expanded')`),true);
    await click(workspace,'[data-tab="home"]');
    await click(workspace,'#home-codex-card [data-codex-action="details"]');
    assert.equal(await evaluate(workspace,`document.querySelector('.codex-dialog').open`),true);
    workspace.webContents.send('key:escape');await sleep(40);
    assert.equal(await evaluate(workspace,`document.querySelector('.codex-dialog').open`),false);
    assert.equal(await evaluate(workspace,`document.querySelector('#app').classList.contains('expanded')`),true,
      '第一次主进程 Escape 只关闭 Codex 详情，不收起工作台');
    await click(workspace,'[data-tab="settings"]');
    await click(workspace,'#settings-shortcut-change');
    await evaluate(workspace,`document.querySelector('#shortcut-recorder').dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true}))`);
    await sleep(50);
    assert.equal(requests.some(r=>r.channel==='settings:set-shortcut'&&r.args[0]==='Space'),true);
    await sleep(460);
    console.log('PASS all tabs, settings dialogs, Escape and Space shortcut');

    await click(workspace,'[data-tab="todo"]');
    for(const priority of ['P0','P1','P2','P3']) {
      await click(workspace,`[data-deadline-priority="${priority}"]`);
      await click(workspace,'#todo-calendar-next');
      await click(workspace,'#todo-calendar-previous');
      await click(workspace,'#todo-calendar-grid [data-day="28"]');
      workspace.webContents.send('key:escape');await sleep(40);
    }
    const dates=await evaluate(workspace,`(() => {
      const deadline=new Date(new Date().getFullYear()+1,0,31,14,47).toISOString();
      data.P0=[{id:'date-test',text:'original',deadline,createdAt:Date.now(),done:false,remindedAt:123}];
      editingTodo={priority:'P0',id:'date-test'};renderList('P0');
      document.querySelector('.todo-inline-name').value='renamed';
      openTodoEditor('P0',data.P0[0]);
      const untouched=data.P0[0].deadline===deadline;
      const minute=document.querySelector('#todo-editor-minute').value;
      moveTodoCalendar(1);
      const februaryDays=document.querySelectorAll('#todo-calendar-grid button').length;
      document.querySelector('#todo-calendar-grid [data-day="28"]').click();
      closeTodoEditor();
      const draft=document.querySelector('.todo-inline-name').value;
      document.querySelector('.todo-inline-save').click();
      return {untouched,minute,februaryDays,draft,saved:data.P0[0].text,month:new Date(data.P0[0].deadline).getMonth(),reminded:data.P0[0].remindedAt};
    })()`);
    assert.deepEqual(dates,{untouched:true,minute:'47',februaryDays:new Date(new Date().getFullYear()+1,2,0).getDate(),draft:'renamed',saved:'renamed',month:1,reminded:0});
    assert.equal(await evaluate(workspace, `(() => { editingTodo={priority:'P0',id:'date-test'};renderList('P0');const input=document.querySelector('.todo-inline-name');input.value='long unsaved edit';input.focus();input.setSelectionRange(5,5);renderList('P0');const next=document.querySelector('.todo-inline-name');return next.value==='long unsaved edit'&&document.activeElement===next&&next.selectionStart===5; })()`),true);
    await click(workspace,'.todo-inline-deadline');
    workspace.webContents.send('key:escape');await sleep(40);
    await click(workspace,'.todo-inline-save');
    assert.equal(await evaluate(workspace, `data.P0[0].text`), 'long unsaved edit', 'Save click after closing calendar must preserve the draft');
    console.log('PASS all four date controls, year/month boundaries, exact minute and edit draft');

    const rollover=await evaluate(workspace, `(() => { const automatic=document.querySelector('[data-deadline-priority="P2"]');automatic.dataset.deadlineSource='default';const manual=document.querySelector('[data-deadline-priority="P3"]');manual.dataset.deadlineSource='manual';const keep=manual.dataset.deadline;const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(10,0,0,0);tickClock(tomorrow);return {auto:automatic.dataset.deadline===NotchDomain.defaultTodoDeadline(tomorrow),manual:manual.dataset.deadline===keep}; })()`);
    assert.deepEqual(rollover,{auto:true,manual:true});
    await click(workspace,'[data-tab="home"]');
    assert.equal(await evaluate(workspace,`pomodoroCycle.snapshot().focusSeconds`),1500);
    await evaluate(workspace, `document.querySelector('#pomodoro-toggle').focus()`);
    await workspace.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await workspace.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
    await sleep(40);
    assert.equal(await evaluate(workspace, `pomodoroCycle.snapshot().running`),true,'Space must activate focused timer button');
    assert.equal(await evaluate(workspace, `document.querySelector('#app').classList.contains('expanded')`),true);

    const timer=await evaluate(workspace,`(() => {
      window.__ux.offset+=1500000;pomodoroCycle.tick();renderPomodoro();
      const rest=pomodoroCycle.snapshot();
      pomodoroCycle.toggle();renderPomodoro();const paused=pomodoroCycle.snapshot();
      window.__ux.offset+=300000;pomodoroCycle.tick();
      const still= pomodoroCycle.snapshot().remainingSeconds;
      pomodoroCycle.toggle();window.__ux.offset+=300000;pomodoroCycle.tick();renderPomodoro();
      const next=pomodoroCycle.snapshot();
      return {rest:[rest.phase,rest.remainingSeconds,rest.running],paused:paused.running,still,next:[next.phase,next.remainingSeconds,next.running]};
    })()`);
    assert.deepEqual(timer,{rest:['break',300,true],paused:false,still:300,next:['focus',1500,true]});
    await waitFor(quick, `document.querySelector('#quick-timer-state').textContent==='正在专注'`, 'quick view must receive running focus');
    await evaluate(workspace, `window.__ux.offset+=1500000;pomodoroCycle.tick();renderPomodoro()`);
    await waitFor(quick, `document.querySelector('#quick-timer-state').textContent==='正在休息'`, 'quick view must receive rest phase');
    assert.equal(await evaluate(quick, `document.querySelector('#quick-timer-duration').value`),'1500');
    await click(workspace,'#pomodoro-reset');
    assert.equal(await evaluate(workspace,`pomodoroCycle.snapshot().active`),false);
    assert.equal(requests.filter(r=>r.channel==='pomodoro:notify').length,3);
    console.log('PASS actual timer controls and focus/rest loop');
    // All edits below use the temporary Electron profile and a mock vault.
    await click(workspace,'[data-tab="todo"]');
    await evaluate(workspace, `(() => {const input=document.querySelector('.add-row input[data-priority="P1"]');input.value='UX fixture todo';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await waitFor(workspace, `data.P1.length===1`, 'add todo by Enter');
    await click(workspace,'.todo-list[data-priority="P1"] [data-action="toggle"]');
    assert.equal(await evaluate(workspace,`data.P1[0].done`),true);
    await click(workspace,'.todo-list[data-priority="P1"] [data-action="toggle"]');
    assert.equal(await evaluate(workspace,`data.P1[0].done`),false);
    await click(workspace,'.todo-list[data-priority="P1"] [data-action="delete"]');
    assert.equal(await evaluate(workspace,`data.P1.length`),0);
    await click(workspace,'[data-tab="home"]');
    await evaluate(workspace,`document.querySelector('#home-note').value='UX fixture note';document.querySelector('#home-note').dispatchEvent(new Event('input',{bubbles:true}));`);
    await click(workspace,'#note-save-btn');
    await click(workspace,'[data-tab="notes"]');
    await waitFor(workspace, `document.querySelectorAll('.notes-list-item').length===1`, 'saved note reaches library');
    await click(workspace,'.notes-list-item');
    await evaluate(workspace, `document.querySelector('#notes-editor').value='edited fixture';document.querySelector('#notes-editor').dispatchEvent(new Event('input',{bubbles:true}));`);
    await click(workspace,'[data-tab="links"]');
    assert.equal(await evaluate(workspace,`JSON.parse(localStorage.getItem('notch-note-archive-v1'))[0].content`),'edited fixture');
    await evaluate(workspace,`document.querySelector('#link-add').value='https://example.com/ux-fixture';document.querySelector('#link-add').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`);
    await waitFor(workspace, `Boolean(document.querySelector('[data-action="open-link"]'))`, 'add link');
    await click(workspace,'[data-action="open-link"]');
    assert.equal(requests.some(r=>r.channel==='shell:openExternal'&&r.args[0]==='https://example.com/ux-fixture'),true);
    await click(workspace,'[data-action="delete-link"]');
    assert.equal(await evaluate(workspace,`Boolean(document.querySelector('[data-action="open-link"]'))`),false);
    await click(workspace,'[data-tab="notes"]');
    await click(workspace,'[data-action="delete-note"]');
    assert.equal(await evaluate(workspace,`JSON.parse(localStorage.getItem('notch-note-archive-v1')).length`),0);
    await click(workspace,'[data-tab="recordings"]');
    await click(workspace,'#computer-open-recordings');
    assert.equal(await evaluate(workspace,`document.querySelector('#recording-library-view').hidden`),false);
    await click(workspace,'#recording-configure');
    await click(workspace,'#transcription-settings-cancel');
    await click(workspace,'#computer-back-status');
    assert.equal(await evaluate(workspace,`document.querySelector('#recording-library-view').hidden`),true);
    await click(workspace,'[data-tab="credentials"]');
    await click(workspace,'#credential-save');
    assert.equal(await evaluate(workspace,`document.querySelector('#credentials-note').textContent.includes('完整填写')`),true);
    await evaluate(workspace,`document.querySelector('#credential-service').value='UX fixture';document.querySelector('#credential-account').value='fixture';document.querySelector('#credential-password').value='test-only-not-a-secret';`);
    await click(workspace,'#credential-save');
    await waitFor(workspace,`Boolean(document.querySelector('[data-credential-copy="account"]'))`,'saved mock vault entry');
    await click(workspace,'[data-credential-copy="account"]');
    await click(workspace,'[data-credential-copy="password"]');
    await click(workspace,'[data-credential-delete]');
    await waitFor(workspace,`!document.querySelector('[data-credential-delete]')`,'delete mock vault entry');
    await click(workspace,'#workspace-return-island');
    await waitFor(workspace,`document.querySelector('#app').classList.contains('collapsed')`,'return to island');
    console.log('PASS todo/note/link create-edit-delete, recording library return, mock vault buttons and return to island');
    assert.deepEqual(await evaluate(workspace,'window.__ux.errors'),[]);
    assert.deepEqual(await evaluate(quick,'window.__ux.errors'),[]);
    console.log('PASS no unhandled page errors');
  } finally {quick.destroy();workspace.destroy();}
}
main().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
