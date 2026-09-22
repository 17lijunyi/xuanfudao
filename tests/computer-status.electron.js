'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const appRoot = path.resolve(process.env.FUDAO_APP_ROOT || path.join(__dirname, '..'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-computer-test-'));
app.setPath('userData', userData);
app.once('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const preload = path.join(appRoot, 'preload.js');
  const window = new BrowserWindow({ show: false, frame: false, width: 1240, height: 480,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const GiB = 1024 ** 3;
  let calls = 0;
  let snapshot = { updatedAt: Date.now(), platform: 'darwin', model: 'Fixture Mac',
    cpu: { percent: 21 }, memory: { total: 32 * GiB, used: 26.2 * GiB, available: 5.8 * GiB, cached: 5.5 * GiB, compressed: 8.9 * GiB, percent: 81.875, pressure: 'normal', includesCache: false },
    disk: { total: 512 * GiB, used: 286.72 * GiB, available: 225.28 * GiB, percent: 56 },
    battery: { present: true, percent: 100, charging: false, onBattery: false }, network: { connected: true }, uptimeSeconds: 3600, load: [1] };
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require(path.join(appRoot, 'ai-tools')).CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [] },
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, safeAreaTop: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'workspace:get': { path: userData }, 'workspace:load-data': {},
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'transcription:get-config': { configured: false, llmConfigured: false },
    'codex-float:get': { providerId: 'codex', connection: 'unavailable', windows: [], threads: [], resets: { available: null } },
    'credentials:list': { items: [], secureStorage: true }, 'tasks:recent': [], 'quick-launch:list': { items: [] },
  };
  for (const channel of new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]))) {
    ipcMain.handle(channel, async (_event, ...args) => {
      if (channel === 'computer:status') { calls++; return snapshot; }
      if (channel === 'window:set-mode') return { ok: true, mode: args[0] };
      return responses[channel] ?? null;
    });
  }
  const evaluate = code => window.webContents.executeJavaScript(code);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(code, message) {
    for (let i = 0; i < 160; i++) { if (await evaluate(code)) return; await wait(20); }
    assert.fail(message);
  }
  const value = key => evaluate(`document.querySelector('[data-computer-value="${key}"]').textContent`);
  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await window.loadFile(path.join(appRoot, 'renderer/index.html'));
    window.showInactive();
    window.webContents.send('island:open-workspace', 'home');
    await waitFor(`document.getElementById('app').classList.contains('expanded') && !modeBusy`, 'workspace opens');
    await evaluate(`window.NotchHome.setModuleVisible('windows', true); window.ComputerStatusView.openStatus()`);
    await waitFor(`document.getElementById('computer-status-view').dataset.active === 'true' && document.querySelector('[data-computer-value="memoryPercent"]').textContent === '82%'`, 'native preload delivers the memory reading');
    await waitFor(`!tabBusy && getComputedStyle(document.querySelector('.panels')).opacity === '1'`, 'details finish opening');
    assert.equal(await value('memoryCapacity'), '26.2 / 32 GB');
    assert.equal(await value('memoryDetail'), '26.2 / 32 GB 已用\n缓存 5.5 GB · 压缩 8.9 GB');
    assert.equal(await value('memoryPressure'), '内存压力：正常');
    for (const [width, height] of [[1240, 480], [1000, 480]]) {
      window.setSize(width, height);
      await wait(60);
      const clipped = await evaluate(`(() => {
        const card = document.querySelector('[data-computer-card="memory"]'), box = card.getBoundingClientRect();
        return [...card.querySelectorAll('strong,p,small')].filter(node => {
          const r = node.getBoundingClientRect();
          return r.width === 0 || r.right > box.right || r.bottom > box.bottom || node.scrollWidth > node.clientWidth + 1;
        }).map(node => node.textContent);
      })()`);
      assert.deepEqual(clipped, [], `memory details must fit at ${width} × ${height}`);
    }
    window.setSize(1240, 480);
    await wait(100);
    if (process.env.FUDAO_COMPUTER_SCREENSHOTS) {
      fs.mkdirSync(process.env.FUDAO_COMPUTER_SCREENSHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.FUDAO_COMPUTER_SCREENSHOTS, 'details.png'), (await window.webContents.capturePage()).toPNG());
    }
    snapshot = { ...snapshot, memory: { total: 32 * GiB, used: null, percent: null, pressure: null } };
    await evaluate(`window.ComputerStatusView.refresh()`);
    assert.equal(await value('memoryPercent'), '—');
    assert.equal(await value('memoryCapacity'), '—');
    assert.equal(await value('memoryDetail'), '暂不可用');
    assert.equal(await value('memoryPressure'), '内存压力：暂不可用');
    snapshot = { ...snapshot, memory: { total: 32 * GiB, used: 26.2 * GiB, percent: 81.875, cached: 5.5 * GiB, compressed: 8.9 * GiB, pressure: 'warning', includesCache: false } };
    await evaluate(`window.ComputerStatusView.refresh()`);
    assert.equal(await value('memoryPercent'), '82%');
    assert.equal(await value('memoryPressure'), '内存压力：偏高');
    await evaluate(`document.querySelector('[data-tab="home"]').click()`);
    await waitFor(`document.getElementById('home-computer').dataset.active === 'true'`, 'summary samples while visible');
    await waitFor(`!tabBusy && document.getElementById('tab-home').classList.contains('active')`, 'summary finishes opening');
    await wait(100);
    assert.equal(await evaluate(`document.querySelector('#home-computer [data-computer-value="memoryCapacity"]').textContent`), '26.2 / 32 GB');
    if (process.env.FUDAO_COMPUTER_SCREENSHOTS) fs.writeFileSync(path.join(process.env.FUDAO_COMPUTER_SCREENSHOTS, 'summary.png'), (await window.webContents.capturePage()).toPNG());
    await evaluate(`window.NotchHome.setModuleVisible('windows', false)`);
    const before = calls;
    await wait(3100);
    assert.equal(calls, before, 'hidden module must stop sampling');
    console.log('PASS memory details and summary, native preload, unknown/recovery, pressure, responsive geometry and visibility');
  } finally { window.destroy(); }
}

main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
