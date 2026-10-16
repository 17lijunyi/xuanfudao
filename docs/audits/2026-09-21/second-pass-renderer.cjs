'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=process.argv[2];
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fudao-review-renderer-'));
app.setPath('userData',profile);
app.on('window-all-closed',()=>{});
app.once('will-quit',()=>fs.rmSync(profile,{recursive:true,force:true}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(){
 await app.whenReady();
 const preload=path.join(root,'preload.js');
 const responses={
  'ai-tools:get':{ok:true,revision:0,catalog:require(path.join(root,'ai-tools')).CATALOG,state:{selected:'codex',confirmed:true},needsSetup:false},
  'ai-code:get':{providerId:'codex',selectionRevision:0,connection:'unavailable',windows:[],threads:[]},
  'window:metrics':{stripHeight:34,menuBarHeight:34,safeAreaTop:34,collapsedWidth:256,notchCenterWidth:200,notchWingWidth:28},
  'workspace:get':{path:profile},'workspace:load-data':{},'workspace:save-data':true,
  'settings:get':{features:{todo:true,notes:true,links:true,recordings:true,credentials:true,clip:false}},
  'transcription:get-config':{configured:false,llmConfigured:false},
  'codex-float:get':{providerId:'codex',connection:'unavailable',windows:[],threads:[],resets:{available:null}},
  'windows:list':{items:[]},'credentials:list':{items:[],secureStorage:true},'tasks:recent':[],
  'quick-launch:list':{items:[]},'island:activities-get':{},'system:status:get':{},
  'media:microphone':true,'recordings:save':{ok:false,error:'fixture_write_failed'},
 };
 const channels=[...new Set([...fs.readFileSync(preload,'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m=>m[1]))];
 for(const channel of channels)ipcMain.handle(channel,(_event,...args)=>{
   if(channel==='window:set-mode')return{ok:true,mode:args[0]};
   return responses[channel]??null;
 });
 const results=[];
 for(const [name,seed]of[['baseline',{}],['commands-wrong-shape',{'notch-home-commands':'{}'}],['recordings-wrong-shape',{'notch-recordings':'{}'}],['recording-start-race',{}]]){
  const win=new BrowserWindow({show:false,width:1040,height:480,frame:false,webPreferences:{preload,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,partition:`review-${name}`}});
  const evaluate=code=>win.webContents.executeJavaScript(code);
  win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  try{
   await win.loadURL('about:blank');win.webContents.debugger.attach('1.3');
   await win.webContents.debugger.sendCommand('Page.enable');
   await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`if(location.protocol==='file:'){localStorage.clear();sessionStorage.clear();for(const[k,v]of Object.entries(${JSON.stringify(seed)}))localStorage.setItem(k,v);window.__reviewErrors=[];addEventListener('error',e=>__reviewErrors.push(e.message));addEventListener('unhandledrejection',e=>__reviewErrors.push(String(e.reason)));}`});
   await win.loadFile(path.join(root,'renderer/index.html'));await delay(150);
   const state=await evaluate(`({initialized:!!window.NotchWorkspace,errors:window.__reviewErrors})`);
   if(name==='baseline'){assert.equal(state.initialized,true);assert.deepEqual(state.errors,[]);}
   else if(name.endsWith('wrong-shape')){assert.equal(state.initialized,false);assert.ok(state.errors.some(x=>x.includes('map is not a function')));}
   else{
    assert.equal(state.initialized,true);
    const outcome=await evaluate(`(async()=>{
      const streams=[],recorders=[];window.__reviewMedia={streams,recorders};
      navigator.mediaDevices.getUserMedia=async()=>{
        const track={readyState:'live',stopped:false,addEventListener(){},stop(){this.stopped=true;this.readyState='ended';}};
        const stream={getAudioTracks:()=>[track],getTracks:()=>[track]};streams.push(stream);return stream;
      };
      window.MediaRecorder=class{
        static isTypeSupported(){return true;}
        constructor(stream){this.stream=stream;this.state='inactive';this.mimeType='audio/webm';recorders.push(this);}
        start(){this.state='recording';}
        stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture-audio'])});void this.onstop?.();}
      };
      window.SpeechRecognition=undefined;window.webkitSpeechRecognition=undefined;
      await Promise.all([NotchWorkspace.startRecording(),NotchWorkspace.startRecording()]);
      document.querySelector('#record-stop').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      return {streamsOpened:streams.length,liveTracks:streams.filter(s=>!s.getTracks()[0].stopped).length,activeRecorders:recorders.filter(r=>r.state==='recording').length,uiActive:NotchWorkspace.isRecordingActive()};
    })()`);
    assert.equal(outcome.streamsOpened,2);assert.equal(outcome.liveTracks,1);assert.equal(outcome.activeRecorders,1);
    results.push({name,...outcome});continue;
   }
   results.push({name,...state});
  }finally{win.destroy();}
 }
 console.log(JSON.stringify({scope:'actual renderer + preload; fresh isolated profiles; mocked services and microphone; network denied',results},null,2));
}
run().then(()=>app.quit()).catch(error=>{console.error(error);app.exit(1);});
