'use strict';
// Review-only probes. No product module is changed; files, audio, credentials,
// permissions and network peers are fixtures owned by this process.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const dns = require('node:dns');
const root = process.argv[2];
assert.ok(root && path.isAbsolute(root));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const workspace = fs.readFileSync(path.join(root, 'renderer/workspace.js'), 'utf8');
const services = require(path.join(root, 'main-services.js'));
const Domain = require(path.join(root, 'renderer/domain.js'));
const results = [];
function section(text, from, to) {
  const a = text.indexOf(from), b = text.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `Cannot locate ${from}`);
  return text.slice(a, b);
}
const flush = () => new Promise(resolve => setImmediate(resolve));

async function recordingStartRace() {
  const streams = [], recorders = [];
  class Recorder {
    constructor(stream) { this.stream=stream; this.state='inactive'; this.mimeType='audio/webm'; recorders.push(this); }
    start() { this.state='recording'; }
    stop() { this.state='inactive'; void this.onstop?.(); }
  }
  const noop = () => {};
  const context = vm.createContext({
    window: { MediaRecorder: Recorder, notchAPI: { ensureMicrophone: async () => true } },
    navigator: { mediaDevices: { getUserMedia: async () => {
      const track={ readyState:'live', stopped:false, addEventListener:noop, stop(){this.stopped=true;this.readyState='ended';} };
      const stream={ getAudioTracks:()=>[track],getTracks:()=>[track] }; streams.push(stream); return stream;
    }}},
    MediaRecorder:Recorder, Blob, Date, Promise,
    recordingStatus:'idle', liveTranscript:null, mediaStream:null, mediaRecorder:null,
    audioChunks:[],recordingTranscript:'',interimTranscript:'',recordingCaptureIssue:'',
    recordingStartedAt:0,recordingStopDurationMs:0,pausedTotalMs:0,recordingTimer:null,
    speechRecognitionBlocked:false,speechRecognitionError:'',transcriptionStatus:'idle',
    transcriptionStartPromise:null,transcriptionFinishPromise:null,transcriptionConfig:{configured:false},
    startRecordingStrands:noop,stopRecordingStrands:noop,chooseRecordingMimeType:()=> 'audio/webm',
    beginRecordingDraft:noop,discardRecordingDraft:noop,startSpeechRecognition:noop,stopSpeechRecognition:noop,
    updateRecordingUi:noop,finalizeRecording:noop,currentDuration:()=> 1,
    setInterval:()=>1,clearInterval:noop,
  });
  vm.runInContext([
    section(workspace,'  function stopMediaTracks()', '\n  function chooseRecordingMimeType'),
    section(workspace,'  async function startRecording()', '\n  function togglePauseRecording'),
    section(workspace,'  function stopRecording()', '\n  if (recordStart)'),
  ].join('\n'),context);
  await Promise.all([context.startRecording(),context.startRecording()]);
  context.stopRecording(); await flush();
  const result={id:'recording-start-race',streamsOpened:streams.length,
    tracksStillLiveAfterStop:streams.filter(s=>!s.getTracks()[0].stopped).length,
    recordersStillRecording:recorders.filter(r=>r.state==='recording').length};
  assert.equal(result.streamsOpened,2); assert.equal(result.tracksStillLiveAfterStop,1);
  assert.equal(result.recordersStillRecording,1); results.push(result);
}

async function recordingSaveFailure() {
  const context=vm.createContext({
    window:{notchAPI:{saveRecording:async()=>({ok:false,error:'write_failed'})}},
    recordingStatus:'saving',updateRecordingUi:()=>{},liveTranscript:{},
    recordings:[{id:'fixture-draft',isDraft:true}],recordingDraftId:'fixture-draft',
    recordingSelection:new Set(),selectedRecordingId:'fixture-draft',recordingSelectionAnchor:'fixture-draft',
    renderRecordings:()=>{},audioChunks:[new Blob(['fixture-audio'])],recordingTranscript:'fixture transcript',
    interimTranscript:'',recordingStartedAt:10,pausedAt:0,pausedTotalMs:0,recordingCaptureIssue:'',
  });
  vm.runInContext([
    section(workspace,'  function discardRecordingDraft()', '\n  function syncRecordingDraftUi'),
    section(workspace,'  async function finalizeRecording(', '\n  async function startRecording'),
  ].join('\n'),context);
  await context.finalizeRecording(new Blob(['fixture-audio'],{type:'audio/webm'}),1000);
  const result={id:'recording-save-failure',remainingAudioChunks:context.audioChunks.length,
    remainingDrafts:context.recordings.length,transcriptRetained:Boolean(context.recordingTranscript),status:context.recordingStatus};
  assert.equal(result.remainingAudioChunks,0);assert.equal(result.remainingDrafts,0);assert.equal(result.transcriptRetained,false);
  results.push(result);
}

async function recordingDeleteFailure() {
  let persisted;
  const context=vm.createContext({window:{notchAPI:{deleteRecording:async()=>false}},Domain,
    recordings:[{id:'fixture-recording',audioPath:'recordings/recording-fixture.webm'}],
    recordingSelection:new Set(['fixture-recording']),selectedRecordingId:'fixture-recording',recordingSelectionAnchor:'fixture-recording',
    persistRecordings:()=>{persisted=context.recordings.length;},renderRecordings:()=>{},
  });
  vm.runInContext(section(workspace,'  async function deleteSingleRecording(', '\n  function renderRecordingList'),context);
  await context.deleteSingleRecording('fixture-recording');
  assert.equal(persisted,0);
  results.push({id:'recording-delete-failure',deleteReportedSuccess:false,remainingMetadataRows:context.recordings.length});
}

function vaultReadFailure() {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fudao-review-vault-'));
  try {
    const file=path.join(temp,'credentials.vault.json');
    const previous=JSON.stringify({version:1,payload:Buffer.from('fixture-encrypted-existing-vault').toString('base64')});
    fs.writeFileSync(file,previous);
    const handlers=new Map();
    const context=vm.createContext({fs,path,process,Buffer,crypto,Date,
      app:{getPath:()=>temp},CREDENTIALS_VAULT_FILE:'credentials.vault.json',
      safeStorage:{isEncryptionAvailable:()=>true,decryptString:()=>{throw new Error('fixture keychain unavailable');},encryptString:value=>Buffer.from(value)},
      normalizeCredentialInput:services.normalizeCredentialInput,ipcMain:{handle:(id,fn)=>handlers.set(id,fn)},
    });
    vm.runInContext(section(main,'function getCredentialsVaultPath()', '\n// AI tool choices'),context);
    const before=handlers.get('credentials:list')();
    const saved=handlers.get('credentials:save')({}, {service:'fixture',account:'fixture',password:'test-only-placeholder'});
    const after=fs.readFileSync(file,'utf8');
    assert.equal(before.ok,true);assert.equal(before.items.length,0);assert.equal(saved.ok,true);assert.notEqual(after,previous);
    results.push({id:'vault-read-failure',readReportedOk:before.ok,displayedRows:before.items.length,
      saveReportedOk:saved.ok,previousCiphertextOverwritten:after!==previous});
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
}

function makeLinkContext(fetchFn) {
  const context=vm.createContext({URL,AbortController,Buffer,Promise,Date,setTimeout,clearTimeout,dns,
    fetch:fetchFn,isPrivateAddress:services.isPrivateAddress,
    extractPageTitle:services.extractPageTitle,LINK_FETCH_MAX_BYTES:1024*1024,LINK_FETCH_MAX_REDIRECTS:3,LINK_FETCH_TIMEOUT_MS:30,
    enrichLinkMetadata:async(_url,title)=>({title,category:''}),fetchFaviconDataUrl:async()=>'',
  });
  vm.runInContext([
    section(main,'async function validatePublicHttpUrl(', '\nasync function fetchFaviconDataUrl('),
    section(main,'async function inspectLink(', "\nipcMain.handle('links:inspect'"),
  ].join('\n'),context);
  return context;
}

async function linkBodyTimeout() {
  let release,signal,settled=false;
  const context=makeLinkContext(async(_url,options)=>{
    signal=options.signal;
    return {ok:true,status:200,headers:{get:()=> 'text/html'},body:{getReader:()=>({read:()=>new Promise(resolve=>{release=resolve;}),cancel:async()=>{}})}};
  });
  context.validatePublicHttpUrl=async value=>new URL(value);
  const pending=context.inspectLink('https://fixture.invalid/').then(value=>{settled=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,90));
  const result={id:'link-body-timeout',configuredTimeoutMs:30,observedAfterMs:90,requestSettled:settled,signalAborted:signal.aborted};
  assert.equal(settled,false);assert.equal(signal.aborted,false);results.push(result);
  release({done:true});await pending;
}

async function dnsValidationGap() {
  const hostname='fudao-review-fixture.invalid';
  const lookup=dns.lookup,promiseLookup=dns.promises.lookup;
  let validated=0,connected=0,received=0;
  const server=http.createServer((_request,response)=>{received++;response.setHeader('Content-Type','text/html');response.end('<title>Fixture internal endpoint</title>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    dns.promises.lookup=async(host,options)=>{if(host!==hostname)throw new Error('Unexpected fixture DNS request');validated++;return [{address:'8.8.8.8',family:4}];};
    dns.lookup=(host,options,callback)=>{
      if(host!==hostname)return lookup(host,options,callback);
      connected++;const done=typeof options==='function'?options:callback;
      queueMicrotask(()=>options?.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4));
    };
    const context=makeLinkContext(fetch);context.LINK_FETCH_TIMEOUT_MS=2000;
    const value=await context.inspectLink(`http://${hostname}:${server.address().port}/fixture`);
    assert.equal(value.ok,true);assert.equal(received,1);assert.equal(validated,1);assert.equal(connected,1);
    results.push({id:'dns-validation-gap',validationAddress:'8.8.8.8',connectionAddress:'127.0.0.1',localFixtureRequests:received,inspectionReportedOk:value.ok});
  } finally {
    dns.lookup=lookup;dns.promises.lookup=promiseLookup;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
}

async function lateLinkMetadata() {
  let finish;
  const context=vm.createContext({Domain,Date,Promise,linkGroups:[],
    uid:()=> 'fixture-link',persistLinks:()=>{},renderLinkGroups:()=>{},setLinksStatus:()=>{},
    window:{notchAPI:{inspectLink:()=>new Promise(resolve=>{finish=resolve;})}},
  });
  context.allLinks=()=>context.linkGroups.flatMap(group=>group.links||[]);
  vm.runInContext(section(workspace,'  function addLink(', '\n  if (linkInput)'),context);
  assert.equal(context.addLink('https://fixture.invalid/article'),true);
  // This assignment is the production .link-title-edit change handler's update.
  context.allLinks()[0].title='User selected title';
  finish({ok:true,title:'Remote page title',url:'https://fixture.invalid/article'});
  await flush();
  const actual=context.allLinks()[0].title;
  assert.equal(actual,'Remote page title');
  results.push({id:'late-link-metadata',userTitle:'User selected title',titleAfterDelayedResponse:actual});
}

async function mainProbe() {
  await recordingStartRace();await recordingSaveFailure();await recordingDeleteFailure();vaultReadFailure();
  await linkBodyTimeout();await dnsValidationGap();await lateLinkMetadata();
  process.stdout.write(JSON.stringify({scope:'isolated fixtures; no real microphone, credentials or external network',results},null,2)+'\n');
}
mainProbe().catch(error=>{console.error(error);process.exitCode=1;});
