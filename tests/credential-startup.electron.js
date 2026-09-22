const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dao-credential-startup-test-'));
app.setPath('userData', testDirectory);
app.once('will-quit', () => fs.rmSync(testDirectory, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  const requests = [];
  let resolveCredentialList;
  const credentialList = new Promise((resolve) => { resolveCredentialList = resolve; });
  const fixtureItem = { id: 'startup-fixture', service: '测试服务', account: 'fixture@example.invalid', passwordMask: '**********' };
  const window = new BrowserWindow({
    width: 360, height: 38, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const responses = {
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, collapsedWidth: 360, notchCenterWidth: 200, notchWingWidth: 80 },
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'workspace:get': { path: testDirectory },
    'workspace:load-data': {},
    'transcription:get-config': { asrConfigured: false, llmConfigured: false, secureStorage: true },
    'codex-float:get': { connection: 'unavailable', windows: [], threads: [], resets: { available: null, items: [] } },
    'system:hud-replacement:get': { enabled: true, active: false, permission: 'required', supported: true, error: null },
    'windows:list': { items: [] },
    'tasks:recent': [],
  };
  // Use the real contextBridge and renderer. Replace only main-process services;
  // this process never loads the real vault, safeStorage or the native helper.
  const channels = [...new Set([...fs.readFileSync(preloadPath, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)]
    .map((match) => match[1]))];
  for (const channel of channels) {
    ipcMain.handle(channel, (_event, ...args) => {
      requests.push({ channel, args });
      if (channel === 'credentials:list') return credentialList;
      if (channel === 'credentials:get') return { ok: true, item: { ...fixtureItem, password: 'test-only-placeholder' } };
      if (channel === 'window:set-mode') {
        window.setSize(...(args[0] === 'expanded' ? [1240, 616] : [360, 38]));
        return { ok: true, mode: args[0] };
      }
      if (channel.startsWith('quick-island:')) return { ok: true };
      return responses[channel] ?? null;
    });
  }

  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  const count = (channel) => requests.filter((request) => request.channel === channel).length;
  const noCredentialAccess = (stage) => {
    assert.equal(count('credentials:list'), 0, `${stage}不得列出并解密密钥库`);
    assert.equal(count('credentials:get'), 0, `${stage}不得读取明文密钥`);
  };
  const settleRenderer = () => evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 80))))`);
  const page = () => evaluate(`({
    collapsed: document.getElementById('app').classList.contains('collapsed'),
    expanded: document.getElementById('app').classList.contains('expanded'),
    opening: document.getElementById('app').classList.contains('opening'),
    tab: document.querySelector('.tab.active')?.dataset.tab,
    visible: !document.hidden,
  })`);

  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__credentialStartupAudit = { errors: [], media: [] };
        addEventListener('error', event => __credentialStartupAudit.errors.push(event.message));
        addEventListener('unhandledrejection', event => __credentialStartupAudit.errors.push(String(event.reason)));
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async constraints => {
          __credentialStartupAudit.media.push(constraints);
          throw new Error('Startup must not activate media');
        };
      `,
    });
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    window.showInactive();
    await waitFor(() => evaluate(`Boolean(window.NotchWorkspace)`), '完整工作区脚本必须初始化成功');
    await settleRenderer();
    assert.equal((await page()).collapsed, true);
    assert.ok(count('transcription:get-config') >= 1, '启动应能获取不解密的配置元数据');
    noCredentialAccess('折叠启动');

    // A selected but collapsed page is not a user visit. Exercise the real tab
    // handler to cover restored-tab and lifecycle ordering without a fake event.
    await evaluate(`document.getElementById('tab-button-credentials').click()`);
    await waitFor(async () => (await page()).tab === 'credentials', '折叠时模拟恢复密钥页选择');
    await settleRenderer();
    assert.equal((await page()).collapsed, true);
    noCredentialAccess('仅恢复折叠页签');

    window.webContents.send('island:open-workspace', 'home');
    await waitFor(async () => {
      const state = await page();
      return state.expanded && !state.opening && state.tab === 'home' && state.visible;
    }, '真实工作台入口必须展开首页');
    await settleRenderer();
    noCredentialAccess('展开首页');
    await evaluate(`document.getElementById('tab-button-settings').click()`);
    await waitFor(async () => (await page()).tab === 'settings', '设置页必须可以正常打开');
    await settleRenderer();
    noCredentialAccess('展开设置页');

    await evaluate(`document.getElementById('tab-button-credentials').click()`);
    await waitFor(() => count('credentials:list') === 1, '主动访问已展开的密钥页才列出密钥');
    assert.equal(count('credentials:get'), 0, '列表展示不能主动读取单条明文密码');
    assert.deepEqual(requests.find((request) => request.channel === 'credentials:list').args, []);
    await evaluate(`
      document.getElementById('tab-button-credentials').click();
      document.dispatchEvent(new Event('visibilitychange'));
      document.dispatchEvent(new Event('visibilitychange'));
    `);
    await settleRenderer();
    assert.equal(count('credentials:list'), 1, '列表读取未完成时必须合并重复可见事件');
    resolveCredentialList({ ok: true, items: [fixtureItem], secureStorage: true });
    await waitFor(() => evaluate(`!!document.querySelector('.credential-item[data-id="startup-fixture"]')`), '按需加载的列表应正常显示');
    assert.equal(count('credentials:get'), 0);

    await evaluate(`document.querySelector('.credential-item[data-id="startup-fixture"] .credential-copy').click()`);
    await waitFor(() => count('credentials:get') === 1, '主动编辑密钥才读取该条密码');
    assert.deepEqual(requests.find((request) => request.channel === 'credentials:get').args, [fixtureItem.id]);
    await waitFor(() => evaluate(`!!document.querySelector('.credential-item.editing[data-id="startup-fixture"]')`), '延迟加载后仍可进入编辑');

    const audit = await evaluate(`window.__credentialStartupAudit`);
    assert.deepEqual(audit.errors, []);
    assert.deepEqual(audit.media, []);
    console.log('Credential startup: collapsed/home/settings never decrypt; explicit visible vault loads once; explicit editing reads one credential.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

main().then(() => app.quit()).catch((error) => {
  console.error(error);
  app.exit(1);
});
