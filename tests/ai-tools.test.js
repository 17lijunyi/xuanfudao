const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG, createAIToolsService } = require('../ai-tools');
const { createAICodeRuntime } = require('../ai-code-runtime');
const { createCodeConnectors } = require('../ai-code-connectors');
const { normalizeEvent } = require('../scripts/ai-code-hook');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tools-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const settingsPath = path.join(base, 'ai-tools.json');
  return { base, settingsPath, create: () => createAIToolsService({ settingsPath }) };
}
const choose = (service, id) => service.update({ action: 'select', id, confirmed: true });
test('fresh install has no default tool; only explicit confirmation saves one selection', (t) => {
  const f = fixture(t), service = f.create();
  assert.equal(service.getSnapshot().needsSetup, true);
  assert.equal(service.getSnapshot().state.selected, null);
  assert.equal(fs.existsSync(f.settingsPath), false);
  assert.equal(service.update({ action: 'select', id: 'codex' }).error, 'confirmation_required');
  assert.equal(service.update({ action: 'add', id: 'kimi-code' }).ok, false);
  choose(service, 'kimi-code'); choose(service, 'claude-code');
  assert.deepEqual(f.create().getSnapshot().state, { version: 2, selected: 'claude-code', confirmed: true });
  assert.equal(f.create().getSnapshot().needsSetup, false);
  assert.equal('enabled' in f.create().getSnapshot().state, false);
  assert.equal(CATALOG.length, 14);
  for (const tool of CATALOG) { assert.equal(new URL(tool.website).protocol, 'https:'); assert.ok(fs.statSync(path.join(__dirname, '../renderer', tool.icon)).size > 100); }
});
test('legacy multi-selection requires renewed confirmation and does not silently connect', (t) => {
  const f = fixture(t); const original = JSON.stringify({ version: 1, enabled: ['codex','kimi-code'], selected: 'kimi-code' });
  fs.writeFileSync(f.settingsPath, original);
  const service = f.create();
  assert.equal(service.getSnapshot().needsSetup, true);
  assert.equal(service.getSnapshot().state.selected, null);
  assert.equal(service.getSnapshot().suggested, 'kimi-code');
  assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), original);
  choose(service, 'kimi-code'); assert.equal(f.create().getSnapshot().state.selected, 'kimi-code');
});
test('invalid IDs, corrupt settings and failed writes preserve the original choice', (t) => {
  const f = fixture(t), service = f.create(); choose(service, 'codex');
  for (const id of ['__proto__','../../x',null]) assert.equal(choose(service, id).ok, false);
  const before = fs.readFileSync(f.settingsPath, 'utf8');
  const broken = createAIToolsService({ settingsPath: f.settingsPath, filesystem: { ...fs, renameSync() { throw Error('full'); } } });
  assert.equal(choose(broken, 'kimi-code').error, 'save_failed');
  assert.equal(broken.getSnapshot().state.selected, 'codex');
  assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), before);
  fs.writeFileSync(f.settingsPath, 'invalid');
  assert.equal(f.create().getSnapshot().state.selected, null);
  assert.equal(choose(f.create(),'codex').error, 'settings_unavailable');
});
test('no probing before confirmation, selected-only detection, stale replies cannot leak tasks', async (t) => {
  const service = fixture(t).create(); let codexStarts = 0; const inspected = []; let resolveKimi;
  const runtime = createAICodeRuntime({
    codex: { stop() {}, start() { codexStarts++; return Promise.resolve({ connection:'connected',threads:[{title:'Codex secret'}] }); }, refresh() { throw Error('unexpected'); } },
    connectors: { inspect(id) { inspected.push(id); return id === 'kimi-code' ? new Promise(resolve => { resolveKimi=resolve; }) : { connection:'not_installed',threads:[],windows:[] }; }, connect() { throw Error('unexpected'); } },
  }); t.after(()=>runtime.stop());
  await runtime.select(service.getSnapshot()); runtime.getStatus();
  assert.equal((await runtime.refresh('codex')).ok, false);
  assert.equal((await runtime.connect('kimi-code')).ok, false);
  assert.equal(codexStarts,0); assert.deepEqual(inspected,[]);
  const pending = runtime.select(choose(service,'kimi-code'));
  assert.deepEqual(inspected,['kimi-code']);
  await runtime.select(choose(service,'claude-code'));
  resolveKimi({connection:'connected',threads:[{title:'Kimi old'}]}); await pending;
  runtime.acceptCodex({connection:'connected',threads:[{title:'Codex secret'}]});
  assert.equal(runtime.getStatus().providerId,'claude-code'); assert.deepEqual(runtime.getStatus().threads,[]);
  assert.equal(codexStarts,0);
  await runtime.select(choose(service,'codex')); assert.equal(codexStarts,1);
});
test('per-tool hook setup preserves config, is idempotent, and never fakes quota', (t) => {
  const f=fixture(t), bin=path.join(f.base,'bin');fs.mkdirSync(bin);
  for(const name of ['claude','kimi']) fs.writeFileSync(path.join(bin,name),'test',{mode:0o700});
  const folder=path.join(f.base,'.claude');fs.mkdirSync(folder);
  const original={env:{PRIVATE_KEY:'keep locally'},hooks:{Stop:[{hooks:[{type:'command',command:'existing-hook'}]}]}};
  fs.writeFileSync(path.join(folder,'settings.json'),JSON.stringify(original));
  const connector=createCodeConnectors({home:f.base,userData:path.join(f.base,'data'),searchPaths:[bin],applicationDirs:[],executable:'/An App/Electron',script:"/Another app/agent's hook.js",probe:()=>true});
  assert.equal(connector.inspect('claude-code').connection,'not_connected');
  assert.equal(connector.inspect('qwen-code').connection,'not_installed');
  assert.equal(connector.connect('claude-code').ok,true);
  const saved=fs.readFileSync(path.join(folder,'settings.json'),'utf8');
  assert.deepEqual(JSON.parse(saved).env,original.env);
  assert.equal(JSON.parse(saved).hooks.Stop[0].hooks[0].command,'existing-hook');
  assert.equal(connector.connect('claude-code').ok,true);
  assert.equal(fs.readFileSync(path.join(folder,'settings.json'),'utf8'),saved);
  assert.equal(connector.inspect('claude-code').connection,'waiting');
  assert.deepEqual(connector.inspect('claude-code').windows,[]);
  assert.equal(connector.connect('kimi-code').ok,true);
  const kimi=fs.readFileSync(path.join(f.base,'.kimi-code/config.toml'),'utf8');
  assert.ok(kimi.includes('event = "TurnStarted"'));assert.ok(kimi.includes('timeout = 5'));
});
test('hook records project-only state and long tasks retain their original start until an end event', () => {
  const input={session_id:'test-session',cwd:'/Users/test/Private Project',prompt:'must never persist',message:'secret'};
  const start=normalizeEvent(input,{providerId:'kimi-code',event:'TurnStarted',now:1000,owner:{pid:123,started:'owner-start'}});
  const tool=normalizeEvent(input,{providerId:'kimi-code',event:'PreToolUse',previous:start,now:3600000});
  assert.equal(tool.startedAt,1000);assert.equal(tool.status,'running');assert.equal(tool.title,'Private Project');
  assert.ok(!JSON.stringify(tool).includes('secret'));assert.ok(!JSON.stringify(tool).includes('prompt'));
  const end=normalizeEvent(input,{providerId:'kimi-code',event:'Stop',previous:tool,now:7200000});
  assert.equal(end.status,'completed');
  assert.equal(normalizeEvent(input,{providerId:'kimi-code',event:'SessionEnd',previous:end}),null);
  assert.equal(normalizeEvent({...input,agent_id:'subagent'},{providerId:'claude-code',event:'Stop'}),null);
});

test('actual hook executable is inert without selection and records only the confirmed provider', (t) => {
  const { execFileSync } = require('node:child_process');
  const f=fixture(t), script=path.join(__dirname,'../scripts/ai-code-hook.js');
  const execute=(id,event)=>execFileSync(process.env.AI_HOOK_TEST_EXECUTABLE || process.execPath,[script,f.base,id,event],{
    env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},input:JSON.stringify({session_id:'actual-fixture',cwd:'/Fixture/project',prompt:'do not persist'}),encoding:'utf8',timeout:3000,
  });
  assert.equal(execute('claude-code','UserPromptSubmit').trim(),'{}');
  assert.equal(fs.existsSync(path.join(f.base,'ai-code-events')),false);
  choose(f.create(),'kimi-code');
  execute('claude-code','UserPromptSubmit'); assert.equal(fs.existsSync(path.join(f.base,'ai-code-events')),false);
  assert.equal(execute('kimi-code','TurnStarted'),''); execute('kimi-code','Stop');
  const folder=path.join(f.base,'ai-code-events/kimi-code'), files=fs.readdirSync(folder).filter(name=>/^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(files.length,1);
  const value=JSON.parse(fs.readFileSync(path.join(folder,files[0]),'utf8'));
  assert.equal(value.status,'completed');assert.equal(value.providerId,'kimi-code');assert.equal(value.title,'project');
  assert.ok(!JSON.stringify(value).includes('persist'));
});
test('a silent four-hour task stays running only while the original process identity is valid', (t) => {
  const f=fixture(t),bin=path.join(f.base,'bin'),data=path.join(f.base,'data');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'claude'),'test',{mode:0o700});
  let alive=true;
  const connector=createCodeConnectors({home:f.base,userData:data,searchPaths:[bin],applicationDirs:[],identity:()=>alive?'birth-123':'birth-reused'});
  assert.equal(connector.connect('claude-code').ok,true);
  const dir=path.join(data,'ai-code-events/claude-code');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'a'.repeat(64)+'.json'),JSON.stringify({providerId:'claude-code',id:'long',title:'long project',status:'running',selectionKey:null,startedAt:Date.now()-4*3600000,updatedAt:Date.now()-4*3600000,owner:{pid:234,started:'birth-123'}}));
  assert.equal(connector.inspect('claude-code').threads[0].status,'running');
  alive=false;assert.equal(connector.inspect('claude-code').threads[0].status,'unknown');
});
