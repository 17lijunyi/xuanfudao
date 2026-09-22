const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dao-island-entry-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));

async function main() {
  await app.whenReady();
  const preloadPath = path.join(__dirname, '..', 'preload.js');
  const requests = [];
  let collapsedModeGate = null;
  let returnGate = null;
  let collapsedModeOverride;
  let previewModeGate = null;
  let previewModeOverride;
  let expandedModeOverride;
  let quickIslandVisible = false;
  let quickIslandInteractive = false;
  const window = new BrowserWindow({
    width: 256,
    height: 38,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: preloadPath, backgroundThrottling: false },
  });

  // 保留真实 preload 的参数和事件传递，仅把主进程边界换成本地替身。
  const channels = [...new Set([...fs.readFileSync(preloadPath, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)]
    .map((match) => match[1]))];
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require('../ai-tools').CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'ai-code:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', windows: [], threads: [] },
    'window:metrics': { stripHeight: 38, previewHeight: 56, menuBarHeight: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'workspace:get': { path: isolatedUserData },
    'workspace:load-data': {},
    'transcription:get-config': { configured: true, verificationPending: true, llmConfigured: true, llmVerificationPending: true },
    'codex-float:get': { providerId: 'codex', selectionRevision: 0, connection: 'unavailable', error: 'codex_not_installed', windows: [], threads: [], resets: { available: null, items: [] } },
    'windows:list': { items: [] },
    'tasks:recent': [],
    'credentials:list': { items: [], secureStorage: true },
  };
  for (const channel of channels) {
    ipcMain.handle(channel, async (_event, ...args) => {
      requests.push({ channel, args });
      if (channel === 'window:set-mode') {
        if (args[0] === 'collapsed' && collapsedModeGate) await collapsedModeGate;
        if (args[0] === 'collapsed' && collapsedModeOverride !== undefined) {
          if (collapsedModeOverride instanceof Error) throw collapsedModeOverride;
          return collapsedModeOverride;
        }
        if (args[0] === 'expanded' && expandedModeOverride !== undefined) {
          if (expandedModeOverride instanceof Error) throw expandedModeOverride;
          return expandedModeOverride;
        }
        if (args[0] === 'preview' && previewModeOverride !== undefined) {
          if (previewModeOverride instanceof Error) throw previewModeOverride;
          return previewModeOverride;
        }
        if (args[0] === 'preview' && previewModeGate) {
          // The real main process resizes synchronously, then the invoke
          // result crosses back to the renderer on a later turn.
          window.setSize(256, 56);
          await previewModeGate;
          return { ok: true, mode: 'preview' };
        }
        const size = args[0] === 'expanded' ? [1240, 616] : args[0] === 'preview' ? [256, 56] : [256, 38];
        window.setSize(...size);
        return { ok: true, mode: args[0] };
      }
      if (channel === 'quick-island:return') {
        if (returnGate) await returnGate;
        if (!await window.webContents.executeJavaScript('quickIslandReturnRequested')) return { ok: false, error: 'superseded' };
        window.setSize(256, 38);
        quickIslandVisible = true;
        quickIslandInteractive = true;
        window.webContents.send('window:request-collapse', { immediate: true });
        return { ok: true };
      }
      if (channel === 'quick-island:show') {
        assert.deepEqual(window.getSize(), [256, 38], '必须先收完工作台，再打开速览');
        quickIslandVisible = true;
        quickIslandInteractive = args[0]?.focus === true;
        return { ok: true, interactive: quickIslandInteractive };
      }
      if (channel === 'quick-island:hide') {
        quickIslandVisible = false;
        quickIslandInteractive = false;
      }
      if (channel.startsWith('quick-island:')) return { ok: true };
      return responses[channel] ?? null;
    });
  }

  const evaluate = async (source) => {
    let timeout;
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(source),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source.slice(0, 120)}`)), 5000); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  const quickRequests = () => requests.filter((request) => ['quick-island:show', 'quick-island:return'].includes(request.channel));
  const state = () => evaluate(`({
    collapsed: document.getElementById('app').classList.contains('collapsed'),
    expanded: document.getElementById('app').classList.contains('expanded'),
    active: document.querySelector('.tab-panel.active')?.id,
  })`);

  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__entryAudit = { errors: [], media: [] };
        addEventListener('error', (event) => window.__entryAudit.errors.push(event.message));
        addEventListener('unhandledrejection', (event) => window.__entryAudit.errors.push(String(event.reason)));
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async (constraints) => {
          window.__entryAudit.media.push(constraints);
          throw new Error('island entry must not request media');
        };
      `,
    });
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    window.showInactive();
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await waitFor(() => evaluate(`document.getElementById('settings-transcription-status').textContent === '已保存·使用时验证'`),
      '启动应保留无需解密的配置摘要，并显示密文尚待使用时验证');
    assert.equal(requests.some((request) => request.channel === 'transcription:get-config'), true, '普通配置摘要仍应读取');
    assert.equal(requests.some((request) => ['credentials:list', 'credentials:get', 'transcription:start'].includes(request.channel)), false,
      '折叠启动不得解密密钥库或主动发起转写');
    await evaluate(`setActiveTab('credentials')`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await state()).collapsed, true);
    assert.equal(requests.some((request) => request.channel === 'credentials:list'), false,
      '仅恢复或切换隐藏页签不得触发密钥库读取');
    await evaluate(`setActiveTab('home')`);
    requests.length = 0;

    for (const trigger of ['click', 'Enter', 'Space']) {
      if (trigger === 'click') {
        const hit = await evaluate(`
          (() => {
            const notch = document.getElementById('notch');
            const box = notch.getBoundingClientRect();
            const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            const hitNotch = Boolean(target?.closest('#notch'));
            target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return hitNotch;
          })()
        `);
        assert.equal(hit, true, '点击测试必须命中真实折叠刘海');
      } else {
        await evaluate(`
          document.getElementById('notch').dispatchEvent(new KeyboardEvent('keydown', {
            key: ${JSON.stringify(trigger === 'Space' ? ' ' : 'Enter')},
            code: ${JSON.stringify(trigger)}, bubbles: true, cancelable: true,
          }));
        `);
      }
      await waitFor(async () => (await state()).expanded, `${trigger} 必须直接打开完整工作台`);
      assert.deepEqual(window.getSize(), [1240, 616]);
      assert.equal(quickRequests().length, 0, `${trigger} 不应经过大型速览窗口`);
      if (trigger === 'click') {
        window.webContents.send('ai-code:status', { providerId: 'codex', selectionRevision: 0,
          connection: 'connected', updatedAt: Date.now(), windows: [], resets: { available: null, items: [] }, threads: [],
          attentionTasks: [{ id: 'attention-primary', title: '等待用户确认', status: 'attention', attentionKind: 'permission' }],
          recentIssueTasks: [],
          runningTasks: [{ id: 'running-secondary', title: '后台长任务', status: 'running' }],
          recentCompletedTasks: [],
        });
        await waitFor(() => evaluate(`document.querySelector('#home-codex-card .codex-thread-title')?.textContent === '等待用户确认'`),
          'Codex 首页卡必须接收优先任务投影');
        for (const variant of ['mini', 'compact']) {
          const statusLine = await evaluate(`(() => {
            const card = document.getElementById('home-codex');
            card.dataset.layoutVariant = '${variant}';
            const priority = card.querySelector('.codex-priority');
            const primary = priority.querySelector('[data-primary="true"]');
            return {
              priorityDisplay: getComputedStyle(priority).display,
              primaryDisplay: getComputedStyle(primary).display,
              title: primary.querySelector('.codex-thread-title')?.textContent,
              state: primary.querySelector('.codex-thread-state')?.textContent,
              visibleGroups: [...priority.children].filter((item) => getComputedStyle(item).display !== 'none').length,
            };
          })()`);
          assert.notEqual(statusLine.priorityDisplay, 'none', `${variant} Codex 卡不能隐藏最高优先级任务`);
          assert.notEqual(statusLine.primaryDisplay, 'none');
          assert.equal(statusLine.title, '等待用户确认');
          assert.equal(statusLine.state, '等待权限确认');
          assert.equal(statusLine.visibleGroups, 1, `${variant} Codex 卡只保留一条最高优先级状态`);
        }
        await evaluate(`document.getElementById('home-codex').dataset.layoutVariant = 'full'`);
      }
      window.webContents.send('window:request-collapse');
      await waitFor(async () => (await state()).collapsed, `${trigger} 验证后必须能收回折叠态`);
      assert.deepEqual(window.getSize(), [256, 38]);
    }
    assert.equal(requests.filter((request) => request.channel === 'window:set-mode' && request.args[0] === 'expanded').length, 3);

    for (const failure of [null, { ok: false, error: 'busy' }, new Error('expanded IPC rejected')]) {
      expandedModeOverride = failure;
      const requestStart = requests.length;
      await evaluate(`document.getElementById('notch').click()`);
      await waitFor(() => requests.slice(requestStart)
        .some((request) => request.channel === 'window:set-mode' && request.args[0] === 'expanded'),
      '展开失败场景也必须发出一次真实请求');
      await waitFor(() => evaluate(`(() => {
        const app = document.getElementById('app');
        const panel = document.getElementById('panel');
        const notch = document.getElementById('notch');
        return app.classList.contains('collapsed') && !app.classList.contains('opening')
          && !app.classList.contains('expanded') && panel.inert
          && panel.getAttribute('aria-hidden') === 'true' && notch.tabIndex === 0;
      })()`), '主进程未确认展开时必须完整恢复折叠入口');
      assert.deepEqual(window.getSize(), [256, 38]);
    }
    expandedModeOverride = undefined;
    await evaluate(`document.getElementById('notch').click()`);
    await waitFor(async () => (await state()).expanded, '展开失败恢复后必须可以再次打开');
    assert.deepEqual(window.getSize(), [1240, 616]);
    for (const failure of [null, { ok: false, error: 'busy' }, new Error('collapsed IPC rejected')]) {
      collapsedModeOverride = failure;
      const requestStart = requests.length;
      window.webContents.send('window:request-collapse');
      await waitFor(() => requests.slice(requestStart)
        .some((request) => request.channel === 'window:set-mode' && request.args[0] === 'collapsed'),
      '收起失败场景也必须发出一次真实请求');
      await waitFor(() => evaluate(`(() => {
        const app = document.getElementById('app');
        const panel = document.getElementById('panel');
        return app.classList.contains('expanded') && !app.classList.contains('closing')
          && !panel.inert && panel.getAttribute('aria-hidden') === 'false';
      })()`), '主进程未确认收起时必须恢复为可操作工作台');
      assert.deepEqual(window.getSize(), [1240, 616]);
    }
    collapsedModeOverride = undefined;
    window.webContents.send('window:request-collapse');
    await waitFor(async () => (await state()).collapsed, '恢复验证后必须再次收回');
    assert.deepEqual(window.getSize(), [256, 38]);

    await evaluate(`
      document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'));
      document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'));
    `);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(window.getSize(), [256, 38], '快速划过刘海不得打开预览');

    for (const failure of [null, new Error('preview IPC rejected')]) {
      previewModeOverride = failure;
      const requestStart = requests.length;
      await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
      await waitFor(() => requests.slice(requestStart)
        .some((request) => request.channel === 'window:set-mode' && request.args[0] === 'preview'),
      '失败场景也必须发出一次真实预览请求');
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(await evaluate(`document.getElementById('app').classList.contains('previewing')`), false,
        '主进程未明确确认预览时，渲染层不得单独显示预览内容');
      assert.deepEqual(window.getSize(), [256, 38]);
      await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'))`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    previewModeOverride = undefined;

    let releasePreview;
    previewModeGate = new Promise((resolve) => { releasePreview = resolve; });
    const previewRequestStart = requests.length;
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
    await waitFor(() => requests.slice(previewRequestStart)
      .some((request) => request.channel === 'window:set-mode' && request.args[0] === 'preview'),
    '持续悬停必须发出预览请求');
    assert.deepEqual(window.getSize(), [256, 56], '主进程接受预览后会先增高原生窗口');
    window.setSize(256, 38);
    window.webContents.send('window:request-collapse');
    releasePreview();
    previewModeGate = null;
    await waitFor(() => evaluate(`innerHeight === 38 && !document.getElementById('app').classList.contains('previewing')`),
      '系统接管发生在预览 IPC 回传前时，迟到结果不得重新展开渲染层');
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'))`);

    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
    await waitFor(() => evaluate(`document.getElementById('app').classList.contains('previewing') && innerHeight === 56`),
      '持续悬停 400ms 必须打开同宽的小型预览');
    assert.equal((await state()).collapsed, true);
    assert.equal(quickRequests().length, 0, '小型预览必须留在折叠主窗口，不抢焦点也不启动大速览');
    assert.equal(await evaluate(`document.querySelector('.codex-notch-preview').getAttribute('aria-hidden')`), 'false');
    window.webContents.send('window:metrics-changed', {
      stripHeight: 34, previewHeight: 56, menuBarHeight: 34,
      collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28,
    });
    await waitFor(() => evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--notch-h').trim() === '34px'`),
      '显示器度量变化必须刷新预览的物理刘海高度');
    assert.deepEqual(window.getSize(), [256, 56], '显示器重定位期间不得把已展开的预览裁回折叠高度');
    window.setSize(256, 38);
    window.webContents.send('window:request-collapse');
    await waitFor(() => evaluate(`!document.getElementById('app').classList.contains('previewing')`),
      '系统 HUD 或完成提醒接管时必须清除预览渲染态');

    // 恢复常见的 38px 菜单栏，再验证离开容错与重新进入。
    window.webContents.send('window:metrics-changed', responses['window:metrics']);
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
    await waitFor(() => evaluate(`document.getElementById('app').classList.contains('previewing') && innerHeight === 56`),
      '中断后必须能再次打开预览');
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'))`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(window.getSize(), [256, 56], '离开后的 250ms 容错时间内不应闪退');
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerenter'))`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.deepEqual(window.getSize(), [256, 56], '容错期内重新进入必须取消收回');
    await evaluate(`document.getElementById('notch').dispatchEvent(new PointerEvent('pointerleave'))`);
    await waitFor(() => evaluate(`innerHeight === 38 && !document.getElementById('app').classList.contains('previewing')`),
      '离开 250ms 后应收回折叠高度');

    let before = quickRequests().length;
    window.webContents.send('island:open-workspace', 'home');
    await waitFor(async () => (await state()).expanded, '明确工作台事件必须展开完整工作台');
    assert.equal((await state()).active, 'tab-home');
    assert.deepEqual(window.getSize(), [1240, 616]);
    window.webContents.send('island:open-workspace', 'notes');
    await waitFor(async () => (await state()).active === 'tab-notes', '已展开时笔记入口必须直接切换笔记');

    const topbarLayout = await evaluate(`(() => {
      const bounds = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width }; };
      return { back:bounds('workspace-return-island'),home:bounds('tab-button-home'),settings:bounds('tab-button-settings'),width:innerWidth };
    })()`);
    assert.ok(topbarLayout.back.width > 0 && topbarLayout.back.right <= topbarLayout.home.left,
      '浮岛按钮必须独立可见，不与首页重叠');
    assert.ok(topbarLayout.settings.right <= topbarLayout.width, '设置按钮必须仍在工作台内');

    // 不等待输入防抖保存：按真实按钮返回时，两处笔记草稿应先持久化。
    before = quickRequests().length;
    let releaseReturn;
    returnGate = new Promise(resolve => { releaseReturn = resolve; });
    await evaluate(`(() => {
      localStorage.setItem('notch-note-archive-v1', JSON.stringify([{id:'return-draft',content:'旧内容',createdAt:1,updatedAt:1}]));
      selectedNoteId = 'return-draft';
      renderNotesLibrary();
      const editor = document.getElementById('notes-editor');
      editor.value = '返回浮岛前的笔记草稿';
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      const homeNote = document.getElementById('home-note');
      homeNote.value = '首页未等待保存的草稿';
      homeNote.dispatchEvent(new Event('input',{bubbles:true}));
      window.__entryAudit.stoppedTracks = 0;
      mirrorStream = {getTracks:()=>[{stop:()=>window.__entryAudit.stoppedTracks++}]};
      document.getElementById('workspace-return-island').click();
    })()`);
    const draftState = await evaluate(`({
      home:localStorage.getItem('notch-home-note'),
      archive:JSON.parse(localStorage.getItem('notch-note-archive-v1'))[0].content,
      stopped:window.__entryAudit.stoppedTracks,
      disabled:document.getElementById('workspace-return-island').disabled
    })`);
    assert.equal(draftState.home, '首页未等待保存的草稿', '返回之前必须保存首页草稿');
    assert.equal(draftState.archive, '返回浮岛前的笔记草稿', '返回之前必须保存笔记编辑草稿');
    assert.equal(draftState.stopped, 1, '返回按钮须立即释放现有摄像头 track');
    assert.equal(draftState.disabled, true, '收起过程中应避免重复请求');
    assert.equal((await state()).expanded, true, '速览准备期间工作台继续显示');
    returnGate = null;
    releaseReturn();
    await waitFor(async () => quickRequests().length === before + 1 && (await state()).collapsed, '返回浮岛按钮必须在准备完成后打开速览');
    assert.equal((await state()).collapsed, true);
    assert.equal(quickIslandVisible && quickIslandInteractive, true, '返回后必须是可交互速览');
    assert.equal(quickRequests().at(-1).channel, 'quick-island:return');
    window.webContents.send('window:request-collapse');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(quickIslandVisible && quickIslandInteractive, true, '旧工作台的迟到收起事件不能关掉速览');

    window.webContents.send('island:open-workspace', 'notes');
    await waitFor(async () => (await state()).expanded && (await state()).active === 'tab-notes', '速览仍能再次进入工作台');
    assert.equal(quickIslandVisible, false, '回到工作台应隐藏速览');
    await waitFor(() => evaluate(`document.getElementById('notes-editor')?.value === '返回浮岛前的笔记草稿'`), '再次打开笔记不应丢失内容');

    // 速览准备期间仍显示工作台；途中新的工作台请求应取消返回。
    let releaseCollapse;
    returnGate = new Promise((resolve) => { releaseCollapse = resolve; });
    const requestStart = requests.length;
    before = quickRequests().length;
    await evaluate(`document.getElementById('workspace-return-island').click()`);
    await waitFor(() => requests.slice(requestStart).some((request) => request.channel === 'quick-island:return'),
      '应等待目标页面准备');
    assert.equal(quickIslandVisible, false, '目标尚未准备好时不得展示速览');
    assert.equal((await state()).expanded, true, '目标尚未准备好时不得收起工作台');
    window.webContents.send('island:open-workspace', 'links');
    await new Promise((resolve) => setTimeout(resolve, 30));
    returnGate = null;
    releaseCollapse();
    await waitFor(async () => (await state()).expanded && (await state()).active === 'tab-links', '途中更晚的工作台入口应优先');
    assert.equal(quickIslandVisible, false, '取消返回时不得弹出速览抢焦点');
    assert.equal(await evaluate(`document.getElementById('workspace-return-island').disabled`), false);

    window.webContents.send('window:request-collapse');
    await waitFor(async () => (await state()).collapsed, '原有工作台必须仍能收起');
    window.webContents.send('island:open-workspace', 'notes');
    await waitFor(async () => {
      const current = await state();
      return current.expanded && current.active === 'tab-notes';
    }, '从折叠态打开笔记必须在展开后选择正确页面');

    assert.equal(requests.some((request) => request.channel === 'credentials:list'), false,
      '首页、笔记和轻量入口都不得读取密钥库');
    await evaluate(`document.getElementById('tab-button-credentials').click()`);
    await waitFor(() => requests.some((request) => request.channel === 'credentials:list'),
      '用户首次进入展开的密钥页才应读取密钥库');
    assert.equal(requests.filter((request) => request.channel === 'credentials:list').length, 1);
    await evaluate(`document.getElementById('tab-button-notes').click()`);
    await waitFor(async () => (await state()).active === 'tab-notes', '返回笔记页');
    await evaluate(`document.getElementById('tab-button-credentials').click()`);
    await waitFor(async () => (await state()).active === 'tab-credentials', '再次进入密钥页');
    assert.equal(requests.filter((request) => request.channel === 'credentials:list').length, 1,
      '密钥已经读取后普通页签切换不应再次解密');

    const audit = await evaluate('window.__entryAudit');
    assert.deepEqual(audit.errors, [], '主入口不得产生未处理的脚本错误');
    assert.deepEqual(audit.media, [], '进入轻量浮岛或工作台不得自动启动媒体');
    assert.equal(requests.some((request) => ['media:camera', 'media:microphone', 'music:control', 'system:volume:set'].includes(request.channel)), false, '入口检查不得触碰真实媒体或播放操作');
    console.log('Island entry Electron regression checks passed');
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    channels.forEach((channel) => ipcMain.removeHandler(channel));
  }
}

main().then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
