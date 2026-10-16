const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..');
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dao-codex-notch-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));

// 这些额度和任务只供隔离测试使用，不读取或改动用户的 Codex 数据。
const quotaWindows = [
  { limitId: 'codex', label: '每周', windowDurationMins: 10080, remainingPercent: 8 },
  { limitId: 'codex_spark', label: '1 小时', windowDurationMins: 60, remainingPercent: 96 },
  { limitId: 'codex', label: '5 小时', windowDurationMins: 300, remainingPercent: 74 },
];
const connectedSnapshot = (threads = []) => ({
  connection: 'connected',
  updatedAt: Date.now(),
  windows: quotaWindows,
  threads,
  resets: { available: null, items: [] },
});

async function main() {
  await app.whenReady();
  const preloadPath = path.join(root, 'preload.js');
  const requests = [];
  const channels = [...new Set([...fs.readFileSync(preloadPath, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)]
    .map((match) => match[1]))];
  let resolveInitialStatus;
  const initialStatus = new Promise((resolve) => { resolveInitialStatus = resolve; });
  const responses = {
    'ai-tools:get': { ok: true, revision: 0, catalog: require('../ai-tools').CATALOG, state: { selected: 'codex', confirmed: true }, needsSetup: false },
    'window:metrics': { stripHeight: 38, menuBarHeight: 38, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28 },
    'settings:get': { features: { todo: true, notes: true, links: true, recordings: true, credentials: true, clip: false } },
    'workspace:get': { path: isolatedUserData },
    'workspace:load-data': {},
    'transcription:get-config': {},
    'tasks:recent': [],
    'credentials:list': { items: [], secureStorage: true },
  };
  for (const channel of channels) {
    ipcMain.handle(channel, (_event, ...args) => {
      requests.push({ channel, args });
      if (channel === 'codex-float:get' || channel === 'ai-code:get') return initialStatus.then(value => ({ ...value, providerId: 'codex', selectionRevision: 0 }));
      if (channel.startsWith('quick-island:')) return { ok: true };
      return responses[channel] ?? null;
    });
  }

  const window = new BrowserWindow({
    width: 256,
    height: 38,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 1,
      backgroundThrottling: false,
    },
  });

  const evaluate = async (source) => {
    let timeout;
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(source),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source.slice(0, 140)}`)), 5000); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const waitFor = async (condition, message) => {
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline) {
      if (await evaluate(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(message);
  };
  const sendStatus = async (snapshot, condition) => {
    window.webContents.send('ai-code:status', { ...snapshot, providerId: 'codex', selectionRevision: 0 });
    await waitFor(condition, '真实 preload 必须把 Codex 状态事件送达刘海');
  };
  const capture = async (name) => {
    // 留出绘制时间，截图使用真实渲染结果。
    await new Promise((resolve) => setTimeout(resolve, 260));
    const destination = path.join(__dirname, '..', '.cache', `codex-notch-${name}.png`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const screenshot = await window.webContents.capturePage();
    fs.writeFileSync(destination, screenshot.toPNG());
    return screenshot;
  };
  const assertMonochrome = (screenshot) => {
    const pixels = screenshot.toBitmap();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (!pixels[offset + 3]) continue;
      // Native capture/color conversion may round neutral channels differently.
      const channels = [...pixels.subarray(offset, offset + 3)];
      assert.ok(Math.max(...channels) - Math.min(...channels) <= 2, '额度与状态图案应使用白色及中性灰阶，不能残留绿色');
    }
  };
  const measure = () => evaluate(`
    (() => {
      const box = (node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
      };
      const content = document.querySelector('.codex-notch');
      return {
        viewport: [innerWidth, innerHeight],
        notch: box(document.getElementById('notch')),
        bottomRadius: getComputedStyle(document.getElementById('notch')).borderBottomLeftRadius,
        quotaText: (() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('.codex-notch-quota strong')); return box(range); })(),
        amount: box(document.querySelector('.codex-notch-quota strong')),
        indicator: box(document.getElementById('codex-notch-indicator')),
        content: box(content),
        quota: box(document.querySelector('.codex-notch-quota')),
        tasks: box(document.querySelector('.codex-notch-tasks')),
        contents: [...content.children].map((node) => node.className),
        oldGripHidden: getComputedStyle(document.querySelector('.notch-dot')).display === 'none',
        left: [...content.querySelectorAll('.codex-notch-quota, .codex-notch-quota *')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length).map(box),
        right: [...content.querySelectorAll('.codex-notch-tasks, .codex-notch-tasks *')].filter((node) => getComputedStyle(node).display !== 'none' && node.getClientRects().length).map(box),
      };
    })()
  `);
  const assertInside = (geometry, height = 38, includeAll = true) => {
    assert.deepEqual(geometry.viewport, [256, height], `100% 缩放下的视口必须为 256×${height}`);
    assert.ok(Math.abs(geometry.notch.width - 256) < 0.01, '刘海与左右翼总宽必须为 256px');
    assert.ok(Math.abs(geometry.notch.height - height) < 0.01,
      `刘海与左右翼不得增加菜单栏下沿：${JSON.stringify(geometry.notch)}`);
    assert.equal(geometry.bottomRadius, '17px', '03 半圆落脚应使用 17px 底角');
    assert.deepEqual(geometry.contents, ['codex-notch-quota', 'codex-notch-tasks', 'codex-notch-preview'],
      '折叠行只保留左右翼，任务摘要必须留在悬停后的下方预览行');
    assert.equal(geometry.oldGripHidden, true, '旧中央抓握条必须隐藏，不侵入物理刘海');
    const scale = Math.min(1, height / 34), top = Math.max(0, (height - 34) / 2);
    for (const [node, center, vertical] of [[geometry.amount, 15.5, 19], [geometry.indicator, 231 + 8 * scale, 19.5]]) {
      assert.ok(Math.abs(node.x + node.width / 2 - center) < .1, '数字在内收 3px 后的左翼区域居中，图案为右上角项目数留白');
      assert.ok(Math.abs(node.y + node.height / 2 - (top + vertical * scale)) < .1, '品牌图标下移半像素做视觉校准，主读数保持原位');
    }
    assert.ok(geometry.quotaText.x >= 2.9 && geometry.quotaText.right <= 28.1, `额度必须离左边缘至少 3px，且完整留在左翼内：${JSON.stringify(geometry.quotaText)}`);
    for (const [side, minimum, maximum] of [['left', 0, 28], ['right', 228, 256]]) {
      const boxes = includeAll ? geometry[side] : [side === 'left' ? geometry.quota : geometry.tasks];
      for (const box of boxes) {
        assert.ok(box.width > 0 && box.height > 0, `${box.name} 必须可见`);
        assert.ok(box.x >= minimum - 0.1 && box.right <= maximum + 0.1 && box.y >= -0.1 && box.bottom <= height + 0.1,
          `${box.name} 必须处于 ${side} 的 28px 翼中且不侵入中央物理刘海：${JSON.stringify(box)}`);
      }
    }
    assert.ok(geometry.quota.right <= 28.1 && geometry.tasks.x >= 227.9, '中央 28…228px 必须完全留给物理刘海');
  };
  const changeMenuBarHeight = async (height) => {
    window.setSize(256, height);
    window.webContents.send('window:metrics-changed', {
      stripHeight: height, menuBarHeight: height, collapsedWidth: 256, notchCenterWidth: 200, notchWingWidth: 28,
    });
    await waitFor(`innerHeight === ${height} && Math.abs(document.getElementById('notch').getBoundingClientRect().height - ${height}) < 0.01`,
      '真实 metrics 事件必须把刘海与左右翼同步到菜单栏高度');
    assert.deepEqual(window.getSize(), [256, height]);
    assert.equal(window.webContents.getZoomFactor(), 1);
  };
  const rememberAnimations = async (selector) => {
    const records = await evaluate(`(() => {
      window.__notchAnimations = [...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => {
        const animation = node.getAnimations({ subtree: true }).find((item) => item.constructor.name === 'CSSAnimation');
        return { id: node.id, node, animation, time: animation?.currentTime };
      });
      return window.__notchAnimations.map(({ id, animation, time }) => ({
        id, time, duration: animation?.effect.getTiming().duration, delay: animation?.effect.getTiming().delay, easing: animation?.effect.getTiming().easing,
        infinite: animation?.effect.getTiming().iterations === Infinity, state: animation?.playState,
      }));
    })()`);
    assert.ok(records.length > 0, '应有正在运行的任务动画');
    for (const record of records) {
      assert.equal(record.duration, 2400, `${record.id} 应使用 2.4 秒的自下向上渐层动画`);
      assert.equal(record.easing, 'linear', '连续流光必须匀速');
      assert.equal(record.infinite, true, '流光必须连续循环');
      assert.equal(record.state, 'running');
      assert.equal(typeof record.time, 'number');
    }
  };
  const assertAnimationContinuity = async (selector, message) => {
    // 记录对象留在真实页面中，直接比较 DOM 与 Web Animations 实例而非只比较样式名。
    const records = await evaluate(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return window.__notchAnimations.map((record) => {
        const node = nodes.find((item) => item.id === record.id);
        const animation = node?.getAnimations({ subtree: true }).find((item) => item.constructor.name === 'CSSAnimation');
        const result = {
          id: record.id, sameNode: node === record.node, sameAnimation: animation === record.animation,
          previousTime: record.time, currentTime: animation?.currentTime, state: animation?.playState,
        };
        record.time = animation?.currentTime;
        return result;
      });
    })()`);
    for (const record of records) {
      assert.equal(record.sameNode, true, `${message}：${record.id} 必须复用 DOM 节点`);
      assert.equal(record.sameAnimation, true, `${message}：${record.id} 必须复用 Animation 实例`);
      assert.equal(record.state, 'running');
      assert.ok(record.currentTime > record.previousTime, `${message}：动画时间必须继续推进：${JSON.stringify(record)}`);
    }
  };

  try {
    await window.loadURL('about:blank');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__codexNotchAudit = { errors: [], media: [], xss: false };
        addEventListener('error', (event) => window.__codexNotchAudit.errors.push(event.message));
        addEventListener('unhandledrejection', (event) => window.__codexNotchAudit.errors.push(String(event.reason)));
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async (constraints) => {
          window.__codexNotchAudit.media.push(constraints);
          throw new Error('Codex notch must not request camera or microphone');
        };
      `,
    });
    await window.loadFile(path.join(root, 'renderer', 'index.html'));
    window.webContents.setZoomFactor(1);
    window.showInactive();
    window.setIgnoreMouseEvents(true);
    await waitFor(`typeof window.CodexNotch?.render === 'function'`, '真实 index 必须加载 Codex 刘海组件');
    assert.equal(window.webContents.getZoomFactor(), 1, '验收必须使用 100% 缩放');
    assert.deepEqual(window.getSize(), [256, 38], '测试不能扩大原生窗口绕过左右翼布局约束');

    const previewStartedAt = Date.now() - 65_000;
    await sendStatus(connectedSnapshot([{ id: 'running-one', title: '验收任务：正在运行', status: 'running', turnStartedAt: previewStartedAt }]),
      `document.querySelector('.codex-notch-quota strong').textContent === '74%' && document.getElementById('codex-notch-indicator')?.dataset.status === 'running'`);
    resolveInitialStatus({ connection: 'unavailable', windows: [], threads: [] });
    await evaluate(`document.getElementById('notch').focus(); true`);
    assert.deepEqual(await evaluate(`['.codex-notch-quota', '.codex-notch-tasks'].map(selector => getComputedStyle(document.querySelector(selector), '::after').content)`), ['none', 'none'], 'startup or keyboard focus must not draw blue rectangles around the status wings');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await evaluate(`document.querySelector('.codex-notch-quota strong').textContent`), '74%', '晚返回的初始读取不得覆盖新推送');
    const running = await evaluate(`(() => {
      const icon = document.getElementById('codex-notch-indicator');
      const style = getComputedStyle(icon);
      return {
        value: document.querySelector('.codex-notch-quota strong').textContent,
        title: document.querySelector('.codex-notch-quota').title,
        count: document.querySelectorAll('.codex-notch-task-icon').length,
        tracks: document.querySelectorAll('.codex-notch-task-track').length,
        width: icon.offsetWidth, height: icon.offsetHeight,
        text: document.querySelector('.codex-notch-tasks').textContent,
        markHidden: getComputedStyle(icon.querySelector('.codex-notch-mark')).display === 'none',
        background: style.backgroundImage, mask: getComputedStyle(icon.querySelector('.codex-notch-glow')).maskImage, animation: getComputedStyle(icon.querySelector('.codex-notch-glow')).animationName,
        role: icon.getAttribute('role'), progress: icon.getAttribute('aria-valuenow'), description: icon.getAttribute('aria-valuetext'),
      };
    })()`);
    assert.equal(running.value, '74%', '额度必须从 standard/codex 桶选择最短窗口，不能混用 Spark');
    assert.match(running.title, /5 小时/);
    assert.equal(running.count, 1);
    assert.equal(running.tracks, 0, '折叠任务状态不再显示横条');
    assert.equal(running.width, 16);
    assert.equal(running.height, 16);
    assert.equal(running.text, '1', '运行态右上角显示项目数');
    assert.equal(running.markHidden, false);
    assert.equal(running.background, 'none');
    assert.match(running.mask, /linear-gradient/, '渐层必须沿图标从下向上填充');
    assert.equal(running.animation, 'codex-notch-fill');
    assert.equal(running.role, 'progressbar');
    assert.equal(running.progress, null, '没有任务百分比时不得虚构进度数值');
    assert.match(running.description, /未提供进度百分比/);
    const resetStamp = Date.now() + 4.8 * 86400000;
    const resetSnapshot = { ...connectedSnapshot([{ id: 'running-one', title: '验收任务：正在运行', status: 'running', turnStartedAt: previewStartedAt }]),
      windows: [
        { limitId: 'codex_spark', windowDurationMins: 60, remainingPercent: 99, resetsAt: Date.now() + 86400000 },
        { limitId: 'codex', label: '每周', windowDurationMins: 10080, remainingPercent: 8, resetsAt: Date.now() + 6 * 86400000 },
        { limitId: 'codex', label: '5 小时', windowDurationMins: 300, remainingPercent: 74, resetsAt: resetStamp },
      ] };
    await sendStatus(resetSnapshot, `document.querySelector('.codex-notch-reset-days').textContent === '5'`);
    const superscripts = await evaluate(`(() => {
      const day = document.querySelector('.codex-notch-reset-days'), count = document.querySelector('.codex-notch-project-count');
      const ds = getComputedStyle(day), dr = day.getBoundingClientRect(), cr = count.getBoundingClientRect();
      return { size: ds.fontSize, countSize: getComputedStyle(count).fontSize, color: ds.color, day: [dr.x, dr.y], count: [cr.x, cr.y], title: day.title };
    })()`);
    assert.equal(superscripts.size, '8px'); assert.equal(superscripts.countSize, '9px');
    assert.equal(superscripts.color, 'rgba(255, 255, 255, 0.55)');
    assert.deepEqual(superscripts.day, [16, 6]); assert.deepEqual(superscripts.count, [244, 6.5]);
    assert.match(superscripts.title, /5 天内重置/);
    await evaluate(`window.__realStatusNow = Date.now; Date.now = () => window.__realStatusNow() + 2 * 86400000; undefined`);
    await sendStatus(resetSnapshot, `document.querySelector('.codex-notch-reset-days').textContent === '3'`);
    await evaluate(`Date.now = window.__realStatusNow; undefined`);
    await sendStatus(resetSnapshot, `document.querySelector('.codex-notch-reset-days').textContent === '5'`);
    window.setSize(256, 56);
    await evaluate(`(() => {
      document.getElementById('app').classList.add('previewing');
      window.CodexNotch.setPreviewVisible(true);
    })()`);
    await waitFor(`Math.abs(document.getElementById('notch').getBoundingClientRect().height - 56) < .1`,
      '预览外壳必须完成向下展开');
    const preview = await evaluate(`(() => {
      const root = document.getElementById('notch').getBoundingClientRect();
      const row = document.querySelector('.codex-notch-preview').getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight], rootHeight: root.height,
        row: { top: row.top, bottom: row.bottom, width: row.width },
        title: document.querySelector('.codex-notch-preview-title').textContent,
        meta: document.querySelector('.codex-notch-preview-meta').textContent,
        hidden: document.querySelector('.codex-notch-preview').getAttribute('aria-hidden'),
      };
    })()`);
    assert.deepEqual(preview.viewport, [256, 56]);
    assert.ok(Math.abs(preview.rootHeight - 56) < .1, '预览保持256px同宽，只向下增高到56px');
    assert.ok(Math.abs(preview.row.top - 38) < .1 && Math.abs(preview.row.bottom - 56) < .1
      && Math.abs(preview.row.width - 236) < .1, '摘要行必须紧贴物理刘海下沿且不溢出窗口');
    assert.equal(preview.title, '验收任务：正在运行');
    assert.match(preview.meta, /^01:0\d · 运行中$/);
    assert.equal(preview.hidden, 'false');
    assertMonochrome(await capture('preview'));
    await evaluate(`(() => {
      window.CodexNotch.setPreviewVisible(false);
      document.getElementById('app').classList.remove('previewing');
    })()`);
    window.setSize(256, 38);
    await waitFor(`Math.abs(document.getElementById('notch').getBoundingClientRect().height - 38) < .01`,
      '收回后必须恢复物理刘海高度');
    assertInside(await measure(), 38, false);
    const runningScreenshot = await capture('running');
    assertMonochrome(runningScreenshot);
    const pixelSize = runningScreenshot.getSize();
    const bitmap = runningScreenshot.toBitmap();
    for (const [x, y, alpha] of [[0, 0, 255], [255, 0, 255], [1, 8, 255], [254, 8, 255], [1, 35, 0], [254, 35, 0], [17, 37, 255], [238, 37, 255]]) {
      const pixelX = Math.floor((x + .5) * pixelSize.width / 256);
      const pixelY = Math.floor((y + .5) * pixelSize.height / 38);
      const offset = (pixelY * pixelSize.width + pixelX) * 4;
      assert.deepEqual([...bitmap.subarray(offset, offset + 4)], [0, 0, 0, alpha],
        `半圆落脚应保持顶部直角与圆润底角：${x},${y}`);
    }
    assert.equal(await evaluate(`document.querySelector('.codex-notch-quota').children.length`), 2, '额度侧仅显示读数和重置天数，不创建进度条');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.codex-notch-quota strong')).color`), 'rgb(237, 237, 237)');
    assertInside(await measure());
    await rememberAnimations('#codex-notch-indicator');
    for (const remainingPercent of [100, 73, 72]) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      await sendStatus({
        ...connectedSnapshot([{ id: 'running-one', title: `同一任务更新 ${remainingPercent}`, status: 'running' }]),
        windows: [{ limitId: 'codex', label: '5 小时', windowDurationMins: 300, remainingPercent }],
      }, `document.querySelector('.codex-notch-quota strong').textContent === '${remainingPercent}%'`);
      assertInside(await measure());
      await assertAnimationContinuity('#codex-notch-indicator', '重复额度和同任务推送后');
    }
    const fiveRunning = connectedSnapshot(Array.from({ length: 5 }, (_, index) => ({ id: `running-${index}`, title: `验收并行任务 ${index + 1}`, status: 'running' })));
    for (const threads of [
      fiveRunning.threads.slice(0, 4), fiveRunning.threads,
      fiveRunning.threads.slice().reverse(),
      [{ id: 'entirely-new-task', title: '运行集合替换后的任务', status: 'running' }],
    ]) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      await sendStatus(connectedSnapshot(threads), `document.querySelector('.codex-notch-tasks').dataset.runningCount === '${threads.length}'`);
      await assertAnimationContinuity('#codex-notch-indicator', '任务数量、排序或任务集合变化后');
      const indicator = await evaluate(`({
        count: document.querySelectorAll('.codex-notch-task-icon').length,
        tracks: document.querySelectorAll('.codex-notch-task-track').length,
        text: document.querySelector('.codex-notch-tasks').textContent,
        title: document.querySelector('.codex-notch-tasks').title,
      })`);
      assert.equal(indicator.count, 1, '任何数量的运行任务都只能显示一个品牌图标');
      assert.equal(indicator.tracks, 0);
      assert.equal(indicator.text, String(threads.length));
      if (threads.length > 1) assert.match(indicator.title, new RegExp(`${threads.length} 个任务`));
      assertInside(await measure());
    }

    const trustedStart = Date.now() - 12_000;
    const projectTasks = [
      { id: 'project-one-a', projectKey: 'same-project', title: '相同项目任务 A', status: 'running' },
      { id: 'project-one-b', projectKey: 'same-project', title: '相同项目任务 B', status: 'running' },
      { id: 'project-two', projectKey: 'second-project', title: '项目二', status: 'running' },
      { id: 'project-three', projectKey: 'third-project', title: '项目三', status: 'running' },
    ];
    await sendStatus(connectedSnapshot(projectTasks), `document.querySelector('.codex-notch-project-count').textContent === '3'`);
    const held = { ...projectTasks[3], providerId: 'codex', eventId: 'third-popup', turnId: 'third-turn' };
    await sendStatus({ ...connectedSnapshot(projectTasks.slice(0, 3)), pendingCompletionTasks: [held] },
      `document.querySelector('.codex-notch-project-count').textContent === '3'`);
    await sendStatus({ ...connectedSnapshot(projectTasks.slice(0, 3)), pendingCompletionTasks: [] },
      `document.querySelector('.codex-notch-project-count').textContent === '2'`);
    await sendStatus({ ...connectedSnapshot(), windows: resetSnapshot.windows, runningTasks: [], attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [], pendingCompletionTasks: [] },
      `document.querySelector('.codex-notch-project-count').textContent === '°'`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.codex-notch-project-count')).fontSize`), '11px');
    assert.equal(await evaluate(`document.querySelector('.codex-notch-project-count').getBoundingClientRect().top`), 8);
    assertMonochrome(await capture('idle-corners'));
    assert.equal(await evaluate(`document.getElementById('codex-notch-indicator').getAnimations({subtree:true}).length`), 0);
    await sendStatus({ ...connectedSnapshot(), connection: 'loading' },
      `document.querySelector('.codex-notch-project-count').textContent === '—'`);
    await sendStatus({ ...connectedSnapshot([{ id: 'unresolved', title: '尚未确认的任务', status: 'unknown' }]),
      runningTasks: [], attentionTasks: [], recentIssueTasks: [],
      recentCompletedTasks: [{ id: 'old-completion', status: 'completed', title: '已完成任务' }] },
      `document.getElementById('codex-notch-indicator').dataset.status === 'unknown' && document.querySelector('.codex-notch-project-count').textContent === '°'`);
    assert.match(await evaluate(`document.querySelector('.codex-notch-project-count').title`), /状态待同步/);
    assert.doesNotMatch(await evaluate(`document.getElementById('codex-notch-indicator').getAttribute('aria-label')`), /空闲/);
    await sendStatus({ ...connectedSnapshot([{ id: 'old-unloaded-history', status: 'unknown' }]), taskActivityKnown: true,
      runningTasks: [], attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [] },
      `document.querySelector('.codex-notch-project-count').textContent === '°'`);
    await sendStatus({
      ...connectedSnapshot([
        { id: 'raw-only-running', title: '不应显示的原始任务', status: 'running', turnStartedAt: Date.now() - 60_000 },
        { id: 'projected-running', title: '投影确认的运行任务', status: 'running', turnStartedAt: trustedStart },
      ]),
      runningTasks: [{ id: 'projected-running', title: '投影确认的运行任务', status: 'running' }],
      attentionTasks: [], recentIssueTasks: [], recentCompletedTasks: [],
    }, `document.querySelector('.codex-notch-tasks').dataset.runningCount === '1'`);
    assert.match(await evaluate(`document.querySelector('.codex-notch-tasks').title`), /投影确认的运行任务/,
      '有可信投影时不得把 raw threads 中未入选的任务显示为运行中');
    await evaluate(`document.getElementById('app').classList.add('previewing'); window.CodexNotch.setPreviewVisible(true)`);
    assert.match(await evaluate(`document.querySelector('.codex-notch-preview-meta').textContent`), /^00:1\d · 运行中$/,
      '运行投影可以从同 id 原始线程补齐开始时间，但原始线程不能决定成员资格');
    const finishedAt = Date.now() - 1_000;
    await sendStatus({
      ...connectedSnapshot([{ id: 'raw-only-running', title: '仍不应显示的原始任务', status: 'running' }]),
      runningTasks: [], attentionTasks: [],
      recentIssueTasks: [],
      recentCompletedTasks: [{ id: 'recent-finished', title: '刚完成的可信任务', status: 'completed', completedAt: finishedAt }],
    }, `document.getElementById('codex-notch-indicator').dataset.status === 'completed'`);
    assert.equal(await evaluate(`document.querySelector('.codex-notch-preview-title').textContent`), '刚完成的可信任务',
      '最近完成投影必须优先于 raw threads，不能被空闲态覆盖');
    assert.match(await evaluate(`document.querySelector('.codex-notch-preview-meta').textContent`), /已完成/);
    await evaluate(`window.CodexNotch.setPreviewVisible(false); document.getElementById('app').classList.remove('previewing')`);
    window.setSize(256, 38);
    await waitFor(`Math.abs(document.getElementById('notch').getBoundingClientRect().height - 38) < .01`,
      '可信投影预览收回后必须恢复折叠高度');

    const attentionTask = { id: 'attention-task', title: '需要我回答的任务', status: 'attention', attentionKind: 'input', statusSource: 'app-server' };
    await sendStatus({
      ...connectedSnapshot([
        { id: 'background-running', title: '后台继续运行', status: 'running', turnStartedAt: Date.now() - 8_000 },
        attentionTask,
      ]),
      attentionTasks: [{ id: attentionTask.id, title: attentionTask.title, status: 'attention', attentionKind: 'input' }],
      recentIssueTasks: [],
      runningTasks: [{ id: 'background-running', title: '后台继续运行', status: 'running', turnStartedAt: Date.now() - 8_000 }],
      recentCompletedTasks: [],
    }, `document.getElementById('codex-notch-indicator')?.dataset.status === 'attention'`);
    const attention = await evaluate(`(() => {
      const icon = document.getElementById('codex-notch-indicator');
      const style = getComputedStyle(icon);
      return {
        label: icon.getAttribute('aria-label'), role: icon.getAttribute('role'),
        glyph: getComputedStyle(icon, '::before').content,
        mark: getComputedStyle(icon.querySelector('.codex-notch-mark')).display,
        color: style.color, border: style.borderTopColor,
        animations: icon.getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length,
      };
    })()`);
    assert.match(attention.label, /等待回答/);
    assert.equal(attention.role, 'img');
    assert.equal(attention.glyph, '"!"', '需处理状态必须有静态感叹号，不能只靠颜色');
    assert.equal(attention.mark, 'none');
    assert.equal(attention.color, 'rgb(237, 237, 237)');
    assert.equal(attention.border, 'rgb(237, 237, 237)');
    assert.equal(attention.animations, 0, '等待用户时必须停止图标渐层');
    window.setSize(256, 56);
    await evaluate(`document.getElementById('app').classList.add('previewing'); window.CodexNotch.setPreviewVisible(true)`);
    await waitFor(`document.querySelector('.codex-notch-preview-meta').textContent.includes('等待回答')`,
      '小预览必须优先显示需回答的任务');
    assert.equal(await evaluate(`document.querySelector('.codex-notch-preview-title').textContent`), '需要我回答的任务');
    assert.match(await evaluate(`document.querySelector('.codex-notch-preview-meta').textContent`), /等待回答 · \+1/);
    assertMonochrome(await capture('attention-input'));
    await sendStatus({ ...connectedSnapshot([{ ...attentionTask, attentionKind: 'permission' }]),
      attentionTasks: [{ ...attentionTask, attentionKind: 'permission' }],
      recentIssueTasks: [], runningTasks: [], recentCompletedTasks: [] },
    `document.querySelector('.codex-notch-preview-meta').textContent.includes('等待授权')`);
    assert.match(await evaluate(`document.getElementById('codex-notch-indicator').getAttribute('aria-label')`), /等待授权/);
    await evaluate(`window.CodexNotch.setPreviewVisible(false); document.getElementById('app').classList.remove('previewing')`);
    window.setSize(256, 38);
    await waitFor(`Math.abs(document.getElementById('notch').getBoundingClientRect().height - 38) < .01`,
      '关注预览收回后必须恢复折叠高度');

    const stoppedTask = { id: 'quit-task', title: '退出时停止的任务', status: 'interrupted', statusSource: 'hook', turnId: 'quit-turn', recordedAt: Date.now() };
    const stoppedSnapshot = { ...connectedSnapshot([stoppedTask]), taskActivityKnown: true,
      attentionTasks: [], runningTasks: [], recentCompletedTasks: [], recentIssueTasks: [stoppedTask], pendingCompletionTasks: [] };
    await sendStatus(stoppedSnapshot, `document.getElementById('codex-notch-indicator')?.dataset.status === 'idle'`);
    assert.equal(await evaluate(`document.getElementById('codex-notch-indicator').getAnimations({ subtree: true }).filter(a => a.playState === 'running').length`), 0, '退出后没有运行闪烁');
    assert.equal(await evaluate(`document.querySelector('.codex-notch-project-count').textContent`), '°', '中断历史不占运行计数');
    assert.notEqual(await evaluate(`getComputedStyle(document.getElementById('codex-notch-indicator'), '::before').content`), '"!"', '正常退出不显示需处理感叹号');
    await sendStatus({ ...stoppedSnapshot, runningTasks: [{ id: 'other-active', title: '另一个正在运行的任务', status: 'running' }] },
      `document.getElementById('codex-notch-indicator')?.dataset.status === 'running'`);

    const failedAt = Date.now() - 2_000;
    await sendStatus({
      ...connectedSnapshot([{ id: 'raw-running-behind-issue', title: '后台任务', status: 'running' }]),
      attentionTasks: [], runningTasks: [], recentCompletedTasks: [],
      recentIssueTasks: [{ id: 'recent-failure', title: '生成桌面安装包失败', status: 'failed', statusRecordedAt: failedAt }],
    }, `document.getElementById('codex-notch-indicator')?.dataset.status === 'attention'`);
    assert.match(await evaluate(`document.getElementById('codex-notch-indicator').getAttribute('aria-label')`), /任务失败/,
      '近期失败投影必须升级为需处理提示，不能被原始运行记录覆盖');
    assert.equal(await evaluate(`document.getElementById('codex-notch-indicator').getAnimations({ subtree: true }).filter((item) => item.playState === 'running').length`), 0,
      '失败提示必须静止，不能继续显示运行动画');
    window.setSize(256, 56);
    await evaluate(`document.getElementById('app').classList.add('previewing'); window.CodexNotch.setPreviewVisible(true)`);
    await waitFor(`document.querySelector('.codex-notch-preview-meta').textContent.includes('任务失败')`,
      '失败任务的小预览必须说明失败原因状态');
    assert.equal(await evaluate(`document.querySelector('.codex-notch-preview-title').textContent`), '生成桌面安装包失败');
    await evaluate(`window.CodexNotch.setPreviewVisible(false); document.getElementById('app').classList.remove('previewing')`);
    window.setSize(256, 38);

    await waitFor(`innerHeight === 38`, '失败预览收回后必须等待原生窗口尺寸同步到渲染层');
    for (const status of ['completed', 'unknown', 'idle', 'interrupted', 'failed']) {
      await sendStatus(connectedSnapshot([{ id: `task-${status}`, title: '静态图标验收任务', status }]),
        `document.getElementById('codex-notch-indicator')?.dataset.status === '${status}'`);
      await waitFor(`document.querySelector('.codex-notch-mark').complete && document.querySelector('.codex-notch-mark').naturalWidth > 0`, '共用Codex图标必须加载成功');
      const still = await evaluate(`(() => {
        const icon = document.getElementById('codex-notch-indicator');
        const mark = icon.querySelector('.codex-notch-mark');
        return { text: icon.textContent, source: mark.getAttribute('src'), display: getComputedStyle(mark).display,
          role: icon.getAttribute('role'), label: icon.getAttribute('aria-label'),
          running: icon.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
          tracks: document.querySelectorAll('.codex-notch-task-track').length };
      })()`);
      assert.equal(still.text, '', `${status} 应显示Codex图标，不再显示勾、三点或文字占位`);
      assert.equal(still.source, 'assets/codex-mark.svg');
      assert.notEqual(still.display, 'none');
      assert.equal(still.role, 'img');
      assert.equal(still.running, 0, `${status} 不能伪造图标渐层`);
      assert.equal(still.tracks, 0);
      assert.match(still.label, new RegExp({ completed: '已完成', unknown: '状态待同步', idle: '空闲', interrupted: '已中断', failed: '需关注' }[status]));
      assertInside(await measure());
      if (status === 'completed' || status === 'idle') assertMonochrome(await capture(status));
    }
    for (const [missing, reason] of [
      [{ ...connectedSnapshot([{ id: 'unavailable-running', status: 'running' }]), error: 'tasks_unavailable' }, '暂未获取'],
      [{ ...connectedSnapshot([{ id: 'disconnected-running', status: 'running', statusSource: 'history' }]), connection: 'stale' }, '未连接'],
      [connectedSnapshot(), '暂无可确认'],
    ]) {
      await sendStatus(missing, `document.getElementById('codex-notch-indicator').dataset.status === 'unknown' && document.querySelector('.codex-notch-tasks').title.includes('${reason}')`);
      const unknown = await evaluate(`({
        title: document.querySelector('.codex-notch-tasks').title,
        label: document.getElementById('codex-notch-indicator').getAttribute('aria-label'),
        display: getComputedStyle(document.querySelector('.codex-notch-mark')).display,
        text: document.querySelector('.codex-notch-tasks').textContent,
        animations: document.getElementById('codex-notch-indicator').getAnimations().length,
      })`);
      assert.match(unknown.title, /状态待同步/);
      assert.match(unknown.label, /状态待同步/);
      assert.doesNotMatch(unknown.label, /空闲/);
      assert.notEqual(unknown.display, 'none');
      assert.equal(unknown.text, missing.connection === 'connected' && !missing.error ? '°' : '—');
      assert.equal(unknown.animations, 0);
      assertInside(await measure());
    }
    await capture('waiting');
    await sendStatus({ ...connectedSnapshot([{ id: 'hook-running', title: '离线Hook验收', status: 'running', statusSource: 'hook' }]), connection: 'stale' },
      `document.getElementById('codex-notch-indicator')?.dataset.status === 'running'`);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.codex-notch-glow')).animationName`), 'codex-notch-fill', '有效Hook运行事件可独立于额度连接显示渐层');

    await sendStatus({ ...connectedSnapshot(), windows: [{ limitId: 'codex', label: '5 小时', windowDurationMins: 300, remainingPercent: null, usedPercent: null }] },
      `document.querySelector('.codex-notch-quota strong').textContent === '—'`);
    assert.notEqual(await evaluate(`document.querySelector('.codex-notch-quota strong').textContent`), '0%');
    assert.match(await evaluate(`document.querySelector('.codex-notch-quota').title`), /暂未读取/);
    await sendStatus({ ...connectedSnapshot(), windows: [{ limitId: 'codex', windowDurationMins: 300, usedPercent: 25 }] },
      `document.querySelector('.codex-notch-quota strong').textContent === '75%'`);

    await sendStatus(fiveRunning, `document.querySelector('.codex-notch-tasks').dataset.runningCount === '5'`);
    await capture('multiple');
    await rememberAnimations('#codex-notch-indicator');
    await changeMenuBarHeight(34);
    assertInside(await measure(), 34);
    await capture('running-34');
    await changeMenuBarHeight(24);
    assertInside(await measure(), 24);
    await capture('multiple-24');
    await sendStatus(connectedSnapshot([{ id: 'running-24', title: '24px 菜单栏渐层验收', status: 'running' }]),
      `document.querySelector('.codex-notch-tasks').dataset.runningCount === '1'`);
    await assertAnimationContinuity('#codex-notch-indicator', '24px菜单栏从多任务切到单任务后');
    await capture('running-24');
    assertInside(await measure(), 24);

    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const reduced = await evaluate(`({
      requested: matchMedia('(prefers-reduced-motion: reduce)').matches,
      running: document.querySelector('.codex-notch').getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length,
      animationNames: [...document.querySelectorAll('.codex-notch *')].map((node) => getComputedStyle(node).animationName).filter((name) => name !== 'none'),
      transitionDurations: [...document.querySelectorAll('.codex-notch *')].flatMap((node) => getComputedStyle(node).transitionDuration.split(',')).map(parseFloat).filter((duration) => duration > 0),
    })`);
    assert.equal(reduced.requested, true);
    assert.equal(reduced.running, 0);
    assert.deepEqual(reduced.animationNames, []);
    assert.deepEqual(reduced.transitionDurations, []);
    assertInside(await measure(), 24);
    await sendStatus(fiveRunning, `document.querySelector('.codex-notch-tasks').dataset.runningCount === '5'`);
    assert.equal(await evaluate(`document.getElementById('codex-notch-indicator').getAnimations({ subtree: true }).length`), 0, '减少动态效果时多任务也不得恢复渐层动画');
    assertInside(await measure(), 24);
    await capture('running-24-reduced');
    await changeMenuBarHeight(38);

    await sendStatus({ ...connectedSnapshot([{ id: 'stale-completed', title: '过期的完成状态', status: 'completed' }]), connection: 'stale' },
      `document.querySelector('.codex-notch').dataset.connection === 'stale' && document.getElementById('codex-notch-indicator').dataset.status === 'unknown'`);
    const stale = await evaluate(`({
      value: document.querySelector('.codex-notch-quota strong').textContent,
      title: document.querySelector('.codex-notch-quota').title,
      opacity: getComputedStyle(document.querySelector('.codex-notch-quota')).opacity,
      state: document.getElementById('codex-notch-indicator').dataset.status,
      text: document.getElementById('codex-notch-indicator').textContent,
    })`);
    assert.equal(stale.value, '74%');
    assert.match(stale.title, /上次读数.*离线/);
    assert.ok(Number(stale.opacity) < 1);
    assert.equal(stale.state, 'unknown');
    assert.equal(stale.text, '');

    const unsafeTitle = '<img src=x onerror="window.__codexNotchAudit.xss=true"><script>window.__codexNotchAudit.xss=true</script>';
    await sendStatus({ ...connectedSnapshot([{ id: 'unsafe-title', title: unsafeTitle, status: 'completed' }]), windows: [{ limitId: 'codex', windowDurationMins: 300, label: unsafeTitle, remainingPercent: 64 }] },
      `document.querySelector('.codex-notch-quota strong').textContent === '64%'`);
    const security = await evaluate(`({
      taskTitle: document.querySelector('.codex-notch-tasks').title,
      insertedElements: document.querySelectorAll('.codex-notch img:not(.codex-notch-mark), .codex-notch script').length,
      markSources: [...document.querySelectorAll('.codex-notch img')].map((node) => node.getAttribute('src')),
      audit: window.__codexNotchAudit,
    })`);
    assert.match(security.taskTitle, /<img/);
    assert.equal(security.insertedElements, 0, '任务标题只能作为文字属性，不能生成 HTML');
    assert.deepEqual(security.markSources, ['assets/codex-mark.svg', 'assets/codex-mark.svg'], '只能存在固定的本地图标资源');
    assert.equal(security.audit.xss, false, '任务标题不得执行脚本');
    assert.deepEqual(security.audit.media, [], '刘海状态显示不得自动启动摄像头或麦克风');
    assert.deepEqual(security.audit.errors, [], '刘海状态显示不得产生未处理脚本错误');
    assert.equal(requests.some((request) => ['media:camera', 'media:microphone'].includes(request.channel)), false, '真实 preload 不得发起媒体权限请求');
    assert.deepEqual(window.getSize(), [256, 38]);
    assert.equal(window.webContents.getZoomFactor(), 1);
    console.log('Codex notch Electron regression checks passed');
  } finally {
    resolveInitialStatus({ connection: 'unavailable', windows: [], threads: [] });
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
    channels.forEach((channel) => ipcMain.removeHandler(channel));
  }
}

main().then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
