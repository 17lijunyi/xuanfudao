const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const appVersion = require('../package.json').version;

const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dao-quick-island-test-'));
app.setPath('userData', isolatedUserData);
app.once('will-quit', () => fs.rmSync(isolatedUserData, { recursive: true, force: true }));

// 在真实页面运行前提供桥接替身，测试不触碰本机 Codex、音量、亮度或摄像头。
const fixtureSource = `
  (() => {
    const fixture = window.__quickTest = {
      codex: { connection: 'unavailable', updatedAt: null, windows: [], resets: { available: null }, threads: [] },
      system: {
        volume: { ok: true, volume: 37, muted: false },
        brightness: { ok: true, brightness: 63 },
        output: { ok: true, name: 'MacBook 扬声器', kind: 'speaker' },
      },
      activities: { recording: null, timer: { kind: 'timer', active: false, running: false, remainingSeconds: 300, durationSeconds: 300, endAt: null } },
      deferCodex: false,
      weather: { ok: true, city: '测试城市', temperature: 23.4, weatherCode: 2, weatherText: '多云', isDay: true, updatedAt: Date.now() },
      deferCamera: false,
      cameraAllowed: true,
      calls: { apps: [], weatherReads: [], weather: 0, timer: [], codex: [], workspace: [], focus: [], hide: [], hud: [], media: [], status: 0, trackStops: 0 },
      errors: [],
      listeners: {},
    };
    const subscribe = (name, callback) => {
      fixture.listeners[name] = callback;
      return () => { delete fixture.listeners[name]; };
    };
    fixture.show = (stripHeight = 38, interactive = false) => fixture.listeners.show?.({
      stripHeight, interactive, width: 1240, height: 270, version: ${JSON.stringify(appVersion)},
    });
    fixture.hide = (payload = { reason: 'explicit' }) => fixture.listeners.hide?.(payload);
    fixture.emitSystem = () => fixture.listeners.system?.(fixture.system);
    fixture.emitActivities = () => fixture.listeners.activities?.(fixture.activities);
    const tagCodex = value => ({...value, providerId: 'codex', selectionRevision: 0});
    fixture.emitCodex = () => fixture.listeners.code?.(tagCodex(fixture.codex));
    window.notchAPI = {
      getAITools: async () => ({ok:true,revision:0,catalog:${JSON.stringify(require('../ai-tools').CATALOG)},state:{selected:'codex',confirmed:true},needsSetup:false}),
      getAICodeStatus: async () => tagCodex(fixture.codex),
      onAICodeStatus: callback => subscribe('code', callback),
      onQuickIslandShow: (callback) => subscribe('show', callback),
      onQuickIslandHide: (callback) => subscribe('hide', callback),
      onEscape: (callback) => subscribe('escape', callback),
      onSystemStatus: (callback) => subscribe('system', callback),
      onIslandActivities: (callback) => subscribe('activities', callback),
      onCodexFloatStatus: (callback) => subscribe('codex', callback),
      showQuickIsland: async (options) => {
        fixture.calls.focus.push(options);
        fixture.show(38, options?.focus === true);
        return { ok: true };
      },
      getCodexFloatStatus: async () => {
        fixture.calls.status += 1;
        return tagCodex(fixture.codex);
      },
      refreshCodexFloat: async () => {
        fixture.calls.codex.push('refresh');
        return fixture.deferCodex ? new Promise((resolve) => { fixture.finishCodex = value => resolve(tagCodex(value)); }) : tagCodex(fixture.codex);
      },
      openCodexApp: async () => { fixture.calls.codex.push('open'); return { ok: true }; },
      openCodexThread: async (id) => { fixture.calls.codex.push(id); return { ok: true }; },
      getIslandActivities: async () => fixture.activities,
      getQuickLaunchApps: async () => ({ items: ['Finder', 'Safari', '邮件', '日历', '提醒事项', '备忘录', '终端', 'Codex'].map((name, index) => ({ id: 'app-' + index, name, icon: null })) }),
      launchQuickApp: async (id) => { fixture.calls.apps.push(id); return { ok: true }; },
      openWeatherApp: async () => { fixture.calls.weather += 1; return { ok: true }; },
      getWeather: async (city) => { fixture.calls.weatherReads.push(city); return fixture.weather; },
      controlPomodoro: async (payload) => {
        fixture.calls.timer.push(payload);
        const timer = fixture.activities.timer;
        if (payload.action === 'set-duration') {
          timer.durationSeconds = payload.seconds; timer.remainingSeconds = payload.seconds; timer.active = false; timer.running = false; timer.endAt = null;
          localStorage.setItem('dynamic-panel-pomodoro-duration-v3', JSON.stringify([Math.floor(payload.seconds / 60), payload.seconds % 60]));
        } else if (payload.action === 'reset') {
          timer.active = false; timer.running = false; timer.remainingSeconds = timer.durationSeconds; timer.endAt = null;
        } else {
          timer.active = true; timer.running = !timer.running;
          timer.endAt = timer.running ? Date.now() + timer.remainingSeconds * 1000 : null;
        }
        fixture.emitActivities();
        return { ok: true };
      },
      getSystemStatus: async () => fixture.system,
      showSystemHud: async (kind) => { fixture.calls.hud.push(kind); return { ok: true }; },
      openIslandWorkspace: async (tab) => {
        fixture.calls.workspace.push(tab);
        fixture.hide();
        return { ok: true };
      },
      hideQuickIsland: async (payload) => {
        fixture.calls.hide.push(performance.now());
        fixture.hide(payload);
        return { ok: true };
      },
      ensureCamera: async () => {
        fixture.calls.media.push('ensure-camera');
        if (fixture.deferCamera) return new Promise((resolve) => { fixture.finishCamera = resolve; });
        return fixture.cameraAllowed;
      },
    };
    const mediaDevices = {
      getUserMedia: async (constraints) => {
        fixture.calls.media.push(constraints);
        const stream = new MediaStream();
        const track = { stop: () => { fixture.calls.trackStops += 1; } };
        Object.defineProperty(stream, 'getTracks', { value: () => [track] });
        return stream;
      },
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });
    HTMLMediaElement.prototype.play = async function play() {};
    HTMLMediaElement.prototype.pause = function pause() {};
    addEventListener('error', (event) => fixture.errors.push(event.message));
    addEventListener('unhandledrejection', (event) => fixture.errors.push(String(event.reason)));
  })();
`;

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1240,
    height: 270,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { backgroundThrottling: false },
  });
  const evaluate = async (source) => {
    let timeout;
    try {
      return await Promise.race([
        window.webContents.executeJavaScript(source),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Renderer evaluation timed out: ${source.slice(0, 160)}`)), 5000); }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const waitFor = async (condition, message) => {
    const matched = await evaluate(`
      (async () => {
        const deadline = performance.now() + 3000;
        do {
          if (${condition}) return true;
          await new Promise((resolve) => setTimeout(resolve, 15));
        } while (performance.now() < deadline);
        return false;
      })()
    `);
    assert.equal(matched, true, message);
  };
  const show = async (interactive = false) => {
    await evaluate(`
      (async () => {
        window.__quickTest.hide();
        window.__quickTest.show(38, ${interactive});
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      })()
    `);
    await waitFor(`document.getElementById('quick-island').dataset.visible === 'true'`, '浮岛必须响应显示事件');
  };

  try {
    await window.loadURL('about:blank');
    await window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: fixtureSource });
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await window.loadFile(path.join(__dirname, '..', 'renderer', 'quick-island.html'));
    window.showInactive();
    window.setIgnoreMouseEvents(true);
    await waitFor(`typeof window.__quickTest.listeners.show === 'function'`, '浮岛必须注册显示生命周期');
    await show();

    const geometry = await evaluate(`
      (() => {
        const box = (selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        return {
          viewport: [innerWidth, innerHeight],
          scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
          contentScroll: [document.querySelector('.island-content').clientWidth, document.querySelector('.island-content').scrollWidth],
          codex: box('.quick-codex'),
          calendar: box('.quick-calendar'),
          modules: [...document.querySelectorAll('.island-content > section')].map((node) => node.className),
          tiers: [...document.querySelectorAll('.island-content > section')].map((node) => node.dataset.islandTier),
          mirror: box('.mirror-button'),
          timer: box('.quick-timer-ring'),
          clipped: [...document.querySelectorAll('button:not([hidden])')].filter((node) => node.getClientRects().length).filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.top < -1
              || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
          }).map((node) => node.id || node.dataset.workspace || node.dataset.codexAction || node.dataset.islandAction),
          radius: getComputedStyle(document.getElementById('quick-island')).borderBottomLeftRadius,
        };
      })()
    `);
    assert.deepEqual(geometry.viewport, [1240, 270], '首页应与工作台总宽一致');
    assert.ok(geometry.scroll[0] <= 1240 && geometry.scroll[1] <= 270, '首页外框不得产生滚动溢出');
    assert.ok(geometry.contentScroll[1] <= geometry.contentScroll[0], `首页内容不得横向滚动：${geometry.contentScroll.join(' / ')}`);
    assert.deepEqual(geometry.clipped, [], '所有可见按钮必须完整位于浮岛内');
    assert.deepEqual(geometry.modules, ['quick-codex', 'quick-pomodoro', 'quick-calendar', 'quick-note', 'quick-clock', 'quick-apps'], '首页应优先放置 AI 任务与番茄钟');
    assert.deepEqual(geometry.tiers, ['primary', 'primary', 'support', 'support', 'secondary', 'secondary'], '通用工具应放在 AI 任务之后');
    assert.ok(geometry.codex.width > geometry.calendar.width, 'Codex 任务区应保留较宽阅读空间');
    assert.ok(Math.abs(geometry.timer.width - geometry.timer.height) < 1, '番茄钟必须保持圆形');
    assert.ok(Math.abs(geometry.mirror.width - geometry.mirror.height) < 1, '顶部镜子入口应保持方形点击区域');
    assert.ok(parseFloat(geometry.radius) >= 50, '展开态底部圆角必须接近参考图');
    assert.equal(await evaluate(`document.querySelector('.island-brand').title`), `悬浮岛 v${appVersion}`, '实际版本必须保留在辅助提示中');

    const calendar = await evaluate(`
      (() => {
        const localDate = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0')].join('-');
        return {
          today: localDate(new Date()),
          days: [...document.querySelectorAll('#quick-week button[data-date]')].map((node) => ({
            date: node.dataset.date,
            current: node.getAttribute('aria-current'),
          })),
        };
      })()
    `);
    assert.equal(calendar.days.length, 7, '周历必须显示连续七天');
    assert.deepEqual(calendar.days.filter((day) => day.current === 'date').map((day) => day.date), [calendar.today], '今天必须使用本机日期标记');
    for (let index = 1; index < calendar.days.length; index += 1) {
      const previous = new Date(`${calendar.days[index - 1].date}T12:00:00`);
      previous.setDate(previous.getDate() + 1);
      const expected = [previous.getFullYear(), String(previous.getMonth() + 1).padStart(2, '0'), String(previous.getDate()).padStart(2, '0')].join('-');
      assert.equal(calendar.days[index].date, expected, '周历跨月时日期必须连续');
    }

    const todayTodos = await evaluate(`
      (() => {
        const now = new Date();
        const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30).toISOString();
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 30).toISOString();
        localStorage.setItem('notch-todo-data', JSON.stringify({
          P0: [{ id: 'today', text: '提交今天的方案', done: false, deadline }],
          P1: [{ id: 'done', text: '已经完成', done: true, deadline }],
          P2: [{ id: 'tomorrow', text: '明天的任务', done: false, deadline: tomorrow }],
          P3: [{ id: 'legacy', text: '没有日期的旧任务', done: false }],
        }));
        dispatchEvent(new StorageEvent('storage', { key: 'notch-todo-data' }));
        return {
          title: document.getElementById('quick-agenda-title').textContent,
          meta: document.getElementById('quick-agenda-meta').textContent,
          count: document.getElementById('quick-todo-count').textContent,
        };
      })()
    `);
    assert.deepEqual(todayTodos, { title: '提交今天的方案', meta: '今天的待办', count: '1' }, '首页只能显示截止日期确实为今天的未完成待办');

    const selectedDay = await evaluate(`(() => {
      const cell = [...document.querySelectorAll('#quick-week [data-date]')].find(node => node.getAttribute('aria-current') !== 'date');
      const deadline = new Date(cell.dataset.date + 'T23:30:00').toISOString();
      const original = localStorage.getItem('notch-todo-data');
      localStorage.setItem('notch-todo-data', JSON.stringify({P0:[{id:'selected-day',text:'所选日期的任务',done:false,deadline}]}));
      cell.click();
      const result = {title:document.querySelector('#quick-agenda-title').textContent, selected:cell.getAttribute('aria-pressed')};
      localStorage.setItem('notch-todo-data', original);
      document.querySelector('#quick-week [aria-current="date"]').click();
      return result;
    })()`);
    assert.deepEqual(selectedDay, {title:'所选日期的任务',selected:'true'}, '选择日期必须显示当天任务，不得所有日期都打开同一个列表');

    const localModules = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        const apps = [...document.querySelectorAll('[data-launch-app]')];
        apps[0].click();
        document.getElementById('quick-weather').click();
        document.getElementById('quick-weather-system').click();
        document.getElementById('quick-weather-close').click();
        await tick();
        const todayCell = document.querySelector('#quick-heatmap [aria-current="date"]');
        const clock = document.getElementById('quick-clock-time');
        const note = document.getElementById('quick-note-input');
        localStorage.setItem('notch-note-archive-v1', JSON.stringify([{ id: 'keep-existing', content: '原有笔记', createdAt: 1, updatedAt: 1 }]));
        localStorage.setItem('notch-home-note', '旧草稿');
        dispatchEvent(new StorageEvent('storage', { key: 'notch-home-note' }));
        const originalDraft = note.value;
        note.value = '首页记录的新想法';
        note.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('quick-note-save').click();
        const saved = JSON.parse(localStorage.getItem('notch-note-archive-v1'));
        const duration = document.getElementById('quick-timer-duration');
        duration.value = '1500';
        duration.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
        document.getElementById('quick-timer-toggle').click();
        await tick();
        const running = document.getElementById('quick-island').dataset.timerRunning;
        document.getElementById('quick-timer-toggle').click();
        await tick();
        document.getElementById('quick-timer-reset').click();
        await tick();
        return {
          apps: apps.length, appCalls: fixture.calls.apps, weatherCalls: fixture.calls.weather,
          clockMatchesLocalTime: clock.textContent === new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()),
          heatmap: document.querySelectorAll('#quick-heatmap button').length, todayCount: todayCell.dataset.count,
          originalDraft, savedExisting: saved.some((item) => item.id === 'keep-existing' && item.content === '原有笔记'),
          savedNew: saved.some((item) => item.content === note.value), draft: localStorage.getItem('notch-home-note'),
          timerCalls: fixture.calls.timer, running,
          resetTime: document.getElementById('quick-timer-time').textContent,
        };
      })()
    `);
    assert.equal(localModules.apps, 8, '常用应用只显示返回的 8 个真实入口');
    assert.deepEqual(localModules.appCalls, ['app-0']);
    assert.equal(localModules.weatherCalls, 1, '天气入口必须打开系统天气，不显示编造温度');
    assert.equal(localModules.clockMatchesLocalTime, true);
    assert.equal(localModules.heatmap, 28);
    assert.equal(localModules.todayCount, '2', '热力格按真实截止日期汇总，不计算明天及无日期项');
    assert.equal(localModules.originalDraft, '旧草稿');
    assert.equal(localModules.savedExisting, true, '新增笔记不能覆盖已有笔记');
    assert.equal(localModules.savedNew, true);
    assert.equal(localModules.draft, '首页记录的新想法');
    assert.deepEqual(localModules.timerCalls, [{ action: 'set-duration', seconds: 1500 }, { action: 'toggle' }, { action: 'toggle' }, { action: 'reset' }], '首页番茄钟必须控制同一个工作台计时器');
    assert.equal(localModules.running, 'true');
    assert.equal(localModules.resetTime, '25:00');

    const separateNotes = await evaluate(`
      (() => {
        const note = document.getElementById('quick-note-input');
        const previousId = localStorage.getItem('notch-note-active-archive-v1');
        note.value = '';
        note.dispatchEvent(new Event('input', { bubbles: true }));
        note.value = '清空后写下的独立随笔';
        note.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('quick-note-save').click();
        const notes = JSON.parse(localStorage.getItem('notch-note-archive-v1'));
        return {
          previousPreserved: notes.some((item) => item.id === previousId && item.content === '首页记录的新想法'),
          newSaved: notes.some((item) => item.id !== previousId && item.content === '清空后写下的独立随笔'),
          unrelatedPreserved: notes.some((item) => item.id === 'keep-existing' && item.content === '原有笔记'),
        };
      })()
    `);
    assert.deepEqual(separateNotes, { previousPreserved: true, newSaved: true, unrelatedPreserved: true }, '清空草稿后立即写新稿必须保留先前已归档笔记');

    const weather = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        const setCity = (city) => {
          document.getElementById('quick-weather').click();
          document.getElementById('quick-weather-city').value = city;
          document.getElementById('quick-weather-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        };
        setCity('测试城市');
        await tick();
        const actual = document.getElementById('quick-weather-label').textContent;
        const description = document.getElementById('quick-weather-detail').textContent;
        fixture.weather = { ok: false, error: 'request_failed' };
        setCity('测试城市');
        await tick();
        const failedRetained = document.getElementById('quick-weather-label').textContent;
        const stale = document.getElementById('quick-weather').dataset.stale;
        const originalGetWeather = window.notchAPI.getWeather;
        delete window.notchAPI.getWeather;
        setCity('另一个城市');
        await tick();
        const unavailable = document.getElementById('quick-weather-label').textContent;
        const unavailableDetail = document.getElementById('quick-weather-detail').textContent;
        window.notchAPI.getWeather = originalGetWeather;
        fixture.weather = { ok: true, city: '测试城市', temperature: 23.4, weatherText: '多云', updatedAt: Date.now() };
        setCity('测试城市');
        await tick();
        return { actual, description, failedRetained, stale, unavailable, unavailableDetail,
          savedCity: localStorage.getItem('notch-weather-city-v1'), reads: fixture.calls.weatherReads,
          closed: !document.getElementById('quick-weather-dialog').open };
      })()
    `);
    assert.equal(weather.actual, '测试城市 23°', '天气温度必须来自真实桥接结果');
    assert.equal(weather.description, '多云');
    assert.equal(weather.failedRetained, '测试城市 23°', '刷新失败应保留同城市最近天气');
    assert.equal(weather.stale, 'true', '失败数据必须标记过期');
    assert.equal(weather.unavailable, '另一个城市', '切换城市失败时不能展示旧城市温度');
    assert.match(weather.unavailableDetail, /暂不可用/);
    assert.equal(weather.savedCity, '测试城市');
    assert.equal(weather.reads.length, 3);
    assert.equal(weather.closed, true);

    assert.match(await evaluate(`document.getElementById('quick-codex').textContent`), /额度未知/, '不可用时不得把未知额度显示为 0');
    assert.equal(await evaluate(`document.querySelectorAll('[data-music-action]').length`), 0, '必须删除全部音乐控件');
    const codex = await evaluate(`
      (() => {
        const fixture = window.__quickTest;
        fixture.codex = {
          connection: 'connected', updatedAt: Date.now(),
          windows: [
            { id: 'other', label: '专属额度', remainingPercent: 20, limitId: 'codex_other' },
            { id: 'primary', label: '5 小时', remainingPercent: 67, resetsAt: Date.now() + 60000, limitId: 'codex' },
            { id: 'weekly', label: '本周', usedPercent: 95, limitId: 'codex' },
          ],
          resets: { available: 2, items: [{ title: '<img src=x onerror=alert(1)>', description: '可用重置' }] },
          threads: [{ id: 'thread-1', title: '<img src=x onerror=alert(1)>', status: 'running' }],
          attentionTasks: [],
          recentIssueTasks: [],
          runningTasks: [{ id: 'thread-1', title: '<img src=x onerror=alert(1)>', status: 'running' }],
          recentCompletedTasks: [],
        };
        fixture.emitCodex();
        return {
          labels: [...document.querySelectorAll('#quick-codex .codex-quota-label')].map((item) => item.textContent),
          values: [...document.querySelectorAll('#quick-codex [role="meter"]')].map((item) => item.getAttribute('aria-valuenow')),
          injectedImages: document.querySelectorAll('#quick-codex img').length,
          title: document.querySelector('#quick-codex .codex-thread-title').textContent,
          reset: document.querySelector('#quick-codex .codex-reset-summary').textContent,
        };
      })()
    `);
    assert.deepEqual(codex.values, ['67', '5'], '优先展示 Codex 标准窗口，并将已用百分比准确换算为剩余');
    assert.match(codex.labels[0], /5 小时/);
    assert.match(codex.labels[1], /本周/);
    assert.equal(codex.injectedImages, 0, '任务标题必须按文本显示，不能注入 HTML');
    assert.equal(codex.title, '<img src=x onerror=alert(1)>');
    assert.equal(codex.reset, 'Reset · 2 次');

    const groupedTasks = await evaluate(`
      (() => {
        const fixture = window.__quickTest;
        const originalThreads = fixture.codex.threads;
        const originalAttention = fixture.codex.attentionTasks;
        const originalIssues = fixture.codex.recentIssueTasks;
        const originalRunning = fixture.codex.runningTasks;
        const originalCompleted = fixture.codex.recentCompletedTasks;
        fixture.codex.threads = [
          { id: 'raw-running', title: '不应绕过投影显示', status: 'running', updatedAt: 50 },
          { id: 'idle-task', title: '待继续任务', status: 'idle', updatedAt: 10 },
        ];
        fixture.codex.attentionTasks = [
          { id: 'needs-attention', title: '等待权限确认', status: 'attention', attentionKind: 'permission' },
        ];
        fixture.codex.recentIssueTasks = [
          { id: 'recent-failure', title: '需要检查失败原因', status: 'failed', recordedAt: 30 },
        ];
        fixture.codex.runningTasks = [
          { id: 'running-long', title: '执行长任务', status: 'running', progressMode: 'indeterminate' },
        ];
        fixture.codex.recentCompletedTasks = [
          { id: 'recent-complete', title: '已生成方案', status: 'completed', completedAt: 20 },
        ];
        fixture.emitCodex();
        const groups = [...document.querySelectorAll('#quick-codex [data-task-group]')].map((group) => ({
          key: group.dataset.taskGroup,
          heading: group.querySelector('.codex-task-group-head span')?.textContent,
          title: group.querySelector('.codex-thread-title')?.textContent || '',
          aria: group.querySelector('.codex-thread')?.getAttribute('aria-label') || '',
        }));
        document.querySelector('#quick-codex [data-codex-action="details"]').click();
        const dialog = document.querySelector('.codex-dialog');
        const detailTitles = [...dialog.querySelectorAll('.codex-thread-title')].map((node) => node.textContent);
        dialog.querySelector('[data-codex-action="close"]').click();
        fixture.codex.threads = originalThreads;
        fixture.codex.attentionTasks = originalAttention;
        fixture.codex.recentIssueTasks = originalIssues;
        fixture.codex.runningTasks = originalRunning;
        fixture.codex.recentCompletedTasks = originalCompleted;
        fixture.emitCodex();
        return { groups, detailTitles };
      })()
    `);
    assert.deepEqual(groupedTasks.groups, [
      { key: 'attention', heading: '需处理', title: '等待权限确认', aria: '等待权限确认 · 等待权限确认' },
      { key: 'running', heading: '运行中', title: '执行长任务', aria: '执行长任务 · 进行中' },
      { key: 'completed', heading: '最近完成', title: '已生成方案', aria: '已生成方案 · 已完成' },
    ], 'Codex 主卡必须将需处理、运行中和最近完成分开展示');
    assert.deepEqual(groupedTasks.detailTitles, ['等待权限确认', '需要检查失败原因', '执行长任务', '已生成方案', '待继续任务'],
      '详情必须沿用安全投影，保留近期失败，并只在附加区展示合格的未归类任务');

    const detailContinuity = await evaluate(`
      (() => {
        const fixture = window.__quickTest;
        const original = {
          threads: fixture.codex.threads,
          attention: fixture.codex.attentionTasks,
          issues: fixture.codex.recentIssueTasks,
          running: fixture.codex.runningTasks,
          completed: fixture.codex.recentCompletedTasks,
        };
        fixture.codex.threads = [];
        fixture.codex.attentionTasks = Array.from({ length: 10 }, (_, index) => ({
          id: 'attention-' + index, title: '等待处理 ' + (index + 1), status: 'attention', attentionKind: 'input',
        }));
        fixture.codex.recentIssueTasks = [{ id: 'issue-after-cap', title: '不应挤过八项上限', status: 'failed' }];
        fixture.codex.runningTasks = [{ id: 'running-after-cap', title: '后台仍在运行', status: 'running' }];
        fixture.codex.recentCompletedTasks = [{ id: 'complete-after-cap', title: '最近完成', status: 'completed' }];
        fixture.emitCodex();
        document.querySelector('#quick-codex [data-codex-action="details"]').click();
        const style = document.createElement('style');
        style.textContent = '.codex-dialog .codex-detail-section:last-child{height:92px!important;max-height:92px!important;}';
        document.head.append(style);
        const beforeColumn = document.querySelector('.codex-dialog .codex-detail-section:last-child');
        const focusTarget = beforeColumn.querySelector('[data-thread-id="attention-5"]');
        focusTarget.focus({ preventScroll: true });
        beforeColumn.scrollTop = beforeColumn.scrollHeight;
        const beforeScroll = beforeColumn.scrollTop;
        fixture.emitCodex();
        const afterColumn = document.querySelector('.codex-dialog .codex-detail-section:last-child');
        const result = {
          beforeScroll,
          afterScroll: afterColumn.scrollTop,
          focusedId: document.activeElement?.dataset?.threadId || '',
          visibleTasks: document.querySelectorAll('.codex-dialog .codex-thread').length,
          attentionTotal: document.querySelector('.codex-dialog [data-task-group="attention"] .codex-task-group-head small')?.textContent,
          runningOverflow: document.querySelector('.codex-dialog [data-task-group="running"] .codex-task-group-empty')?.textContent,
          completedOverflow: document.querySelector('.codex-dialog [data-task-group="completed"] .codex-task-group-empty')?.textContent,
        };
        document.querySelector('.codex-dialog [data-codex-action="close"]').click();
        style.remove();
        fixture.codex.threads = original.threads;
        fixture.codex.attentionTasks = original.attention;
        fixture.codex.recentIssueTasks = original.issues;
        fixture.codex.runningTasks = original.running;
        fixture.codex.recentCompletedTasks = original.completed;
        fixture.emitCodex();
        return result;
      })()
    `);
    assert.ok(detailContinuity.beforeScroll > 0 && detailContinuity.afterScroll > 0,
      '详情自动刷新后必须保留任务列滚动位置');
    assert.equal(detailContinuity.focusedId, 'attention-5', '详情自动刷新后必须把键盘焦点还给同一任务');
    assert.equal(detailContinuity.visibleTasks, 8, '详情最多显示八个任务，避免高频任务把弹层撑满');
    assert.equal(detailContinuity.attentionTotal, '11', '分组标题应保留十项等待处理与一项近期失败的真实总数，即使详情只显示前八项');
    assert.equal(detailContinuity.runningOverflow, '另有 1 项');
    assert.equal(detailContinuity.completedOverflow, '另有 1 项');

    const codexActions = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        document.querySelector('#quick-codex [data-codex-action="thread"]').click();
        await tick();
        document.querySelector('#quick-codex .codex-brand').click();
        await tick();
        if (fixture.calls.workspace.at(-1) !== 'codes') throw Error('工具名称应跳转到工作台的 code列表');
        fixture.show(38, true);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.querySelector('#quick-codex [data-codex-action="details"]').click();
        document.querySelector('.codex-dialog [data-codex-action="open"]').click();
        await tick();
        document.querySelector('.codex-dialog [data-codex-action="close"]').click();
        fixture.deferCodex = true;
        const refresh = document.querySelector('#quick-codex [data-codex-action="refresh"]');
        refresh.click(); refresh.click();
        const busy = refresh.disabled;
        fixture.finishCodex(fixture.codex);
        await tick();
        fixture.deferCodex = false;
        document.querySelector('#quick-codex [data-codex-action="details"]').click();
        const dialog = document.querySelector('.codex-dialog');
        const rect = dialog.getBoundingClientRect();
        const close = dialog.querySelector('[data-codex-action="close"]').getBoundingClientRect();
        const allWindows = dialog.querySelectorAll('[role="meter"]').length;
        const detailsSafe = dialog.querySelectorAll('img').length === 0;
        fixture.listeners.escape?.();
        return { actions: fixture.calls.codex, busy, allWindows, detailsSafe,
          inside: rect.top >= 38 && rect.bottom <= innerHeight && close.right <= innerWidth,
          dialogClosed: !dialog.open,
          islandVisible: document.getElementById('quick-island').dataset.visible === 'true' };
      })()
    `);
    assert.deepEqual(codexActions.actions, ['thread-1', 'open', 'refresh'], '任务跳转和刷新各执行一次；没有消耗 Reset');
    assert.equal(codexActions.busy, true, '刷新期间必须防止重复请求');
    assert.equal(codexActions.allWindows, 3, '详情必须展示全部动态额度窗口');
    assert.equal(codexActions.detailsSafe, true);
    assert.equal(codexActions.inside, true, '详情必须避开刘海且关闭入口位于窗口内');
    assert.equal(codexActions.dialogClosed, true);
    assert.equal(codexActions.islandVisible, true, '第一次 Escape 只关闭详情');
    const unsyncedTask = await evaluate(`
      (() => {
        const fixture = window.__quickTest;
        const originalTask = fixture.codex.threads[0];
        const originalAttention = fixture.codex.attentionTasks;
        const originalIssues = fixture.codex.recentIssueTasks;
        const originalRunning = fixture.codex.runningTasks;
        const originalCompleted = fixture.codex.recentCompletedTasks;
        fixture.codex.threads[0] = { id: 'thread-1', title: '当前任务', status: 'unknown', statusReason: 'history_older_than_task' };
        fixture.codex.attentionTasks = [];
        fixture.codex.recentIssueTasks = [];
        fixture.codex.runningTasks = [];
        fixture.codex.recentCompletedTasks = [];
        fixture.emitCodex();
        document.querySelector('#quick-codex [data-codex-action="details"]').click();
        const dialog = document.querySelector('.codex-dialog');
        const task = dialog.querySelector('.codex-thread[data-status="unknown"]');
        const result = { title: task.title, aria: task.getAttribute('aria-label'), visible: task.querySelector('.codex-thread-state').textContent };
        dialog.querySelector('[data-codex-action="close"]').click();
        fixture.codex.threads[0] = originalTask;
        fixture.codex.attentionTasks = originalAttention;
        fixture.codex.recentIssueTasks = originalIssues;
        fixture.codex.runningTasks = originalRunning;
        fixture.codex.recentCompletedTasks = originalCompleted;
        fixture.emitCodex();
        return result;
      })()
    `);
    assert.deepEqual(unsyncedTask, {
      title: '当前任务 · 任务记录尚未同步，暂无法确认状态',
      aria: '当前任务 · 任务记录尚未同步，暂无法确认状态',
      visible: '状态未知',
    }, '过旧任务记录应说明未同步，不能误示待继续或已完成');
    const distinctBuckets = await evaluate(`
      (() => {
        const fixture = window.__quickTest;
        const originalWindows = fixture.codex.windows;
        fixture.codex.windows = [
          { id: 'special-primary', label: '5 小时', remainingPercent: 100, limitId: 'codex_bengalfox' },
          { id: 'standard-weekly', label: '每周', remainingPercent: 65, limitId: 'codex' },
          { id: 'special-weekly', label: '每周', remainingPercent: 100, limitId: 'codex_bengalfox' },
        ];
        fixture.emitCodex();
        const standard = [...document.querySelectorAll('#quick-codex .codex-quota-label')].map((item) => item.textContent);
        fixture.codex.windows = fixture.codex.windows.filter((item) => item.limitId !== 'codex');
        fixture.emitCodex();
        const fallback = [...document.querySelectorAll('#quick-codex .codex-quota-label')].map((item) => item.textContent);
        fixture.codex.windows = originalWindows;
        fixture.emitCodex();
        return { standard, fallback };
      })()
    `);
    assert.deepEqual(distinctBuckets.standard, ['每周65% 剩余'], '只有一条标准 Codex 额度时，概览不得混入专属额度');
    assert.equal(distinctBuckets.fallback.length, 2);
    assert.ok(distinctBuckets.fallback.every((label) => label.startsWith('codex_bengalfox · ')), '无标准额度时，概览必须明确标注其他额度所属 bucket');
    await evaluate(`window.__quickTest.codex.connection = 'stale'; window.__quickTest.emitCodex();`);
    assert.match(await evaluate(`document.querySelector('#quick-codex .codex-connection').getAttribute('aria-label')`), /离线.*上次更新/);
    assert.equal(await evaluate(`document.querySelector('#quick-codex [role="meter"]').getAttribute('aria-valuenow')`), '67', '离线应保留真实的最近额度');

    assert.equal(await evaluate(`document.querySelectorAll('[data-system-hud]').length`), 0);
    assert.deepEqual(await evaluate(`window.__quickTest.calls.hud`), []);

    await evaluate(`
      window.__quickTest.activities = {
        recording: { kind: 'recording', status: 'recording', elapsedMs: 65000, updatedAt: Date.now() },
        timer: { kind: 'timer', active: true, running: true, remainingSeconds: 600, endAt: Date.now() + 600000 },
      };
      window.__quickTest.emitActivities();
    `);
    assert.match(await evaluate(`document.getElementById('quick-activity').textContent`), /^录音 01:0[45]$/, '录音状态优先显示真实时长');

    const mirrorStarted = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        document.getElementById('quick-mirror').click();
        const deadline = performance.now() + 1000;
        while (document.getElementById('quick-island').dataset.mirror !== 'true' && performance.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return {
          active: document.getElementById('quick-island').dataset.mirror,
          pressed: document.getElementById('quick-mirror').getAttribute('aria-pressed'),
          media: fixture.calls.media,
          focused: fixture.calls.focus.at(-1),
        };
      })()
    `);
    assert.equal(mirrorStarted.active, 'true');
    assert.equal(mirrorStarted.pressed, 'true');
    assert.deepEqual(mirrorStarted.focused, { focus: true }, '打开镜子前必须把悬停预览转为可交互浮岛');
    assert.equal(mirrorStarted.media[0], 'ensure-camera', '摄像头只能在用户主动点击后请求');
    assert.deepEqual(mirrorStarted.media[1], { audio: false, video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } } });
    await evaluate(`window.__quickTest.hide()`);
    assert.equal(await evaluate(`window.__quickTest.calls.trackStops`), 1, '收起浮岛必须立即释放摄像头轨道');
    assert.equal(await evaluate(`document.getElementById('quick-mirror-video').srcObject === null`), true);

    await show();
    const stalePermission = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        fixture.deferCamera = true;
        const beforeMedia = fixture.calls.media.length;
        document.getElementById('quick-mirror').click();
        const deadline = performance.now() + 1000;
        while (typeof fixture.finishCamera !== 'function' && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        fixture.hide();
        fixture.finishCamera(true);
        await new Promise((resolve) => setTimeout(resolve, 25));
        fixture.deferCamera = false;
        return {
          requested: fixture.calls.media.slice(beforeMedia),
          active: document.getElementById('quick-island').dataset.mirror,
        };
      })()
    `);
    assert.deepEqual(stalePermission.requested, ['ensure-camera'], '授权期间若已收起，不得继续调用摄像头');
    assert.equal(stalePermission.active, 'false');

    for (const tab of ['home', 'todo', 'projects', 'codes', 'notes', 'settings']) {
      await show(true);
      await evaluate(`document.querySelector('[data-workspace="${tab}"]').click()`);
      await waitFor(`window.__quickTest.calls.workspace.at(-1) === '${tab}'`, '工作台入口必须路由到正确页面');
    }
    assert.deepEqual(await evaluate(`window.__quickTest.calls.workspace`), ['codes', 'home', 'todo', 'projects', 'codes', 'notes', 'settings']);

    await show(true);
    const capHit = await evaluate(`
      (() => {
        const rect = document.querySelector('.island-cap-handle').getBoundingClientRect();
        const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const action = target?.closest('button')?.dataset.islandAction;
        target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return action;
      })()
    `);
    assert.equal(capHit, 'focus', '顶部中央必须保留刘海交互入口');
    await evaluate(`window.__quickTest.listeners.escape?.()`);
    await waitFor(`document.getElementById('quick-island').dataset.visible === 'false'`, '主进程转发的 Escape 必须收起浮岛');

    await show();
    const handoffLeave = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        fixture.calls.hide = [];
        document.documentElement.dataset.surfaceHandoff = '99';
        document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise(resolve => setTimeout(resolve, 320));
        const during = fixture.calls.hide.length;
        delete document.documentElement.dataset.surfaceHandoff;
        document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
        document.documentElement.dataset.surfaceHandoff = '100';
        await new Promise(resolve => setTimeout(resolve, 320));
        const pending = fixture.calls.hide.length;
        delete document.documentElement.dataset.surfaceHandoff;
        return { during, pending };
      })()
    `);
    assert.deepEqual(handoffLeave, { during: 0, pending: 0 }, '卡片交接期间不得由鼠标离开或旧计时器打断');
    await show();
    const hover = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        fixture.calls.hide = [];
        document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise((resolve) => setTimeout(resolve, 120));
        const early = fixture.calls.hide.length;
        document.documentElement.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const reentered = fixture.calls.hide.length;
        document.documentElement.dispatchEvent(new PointerEvent('pointerleave'));
        await new Promise((resolve) => setTimeout(resolve, 320));
        return { early, reentered, final: fixture.calls.hide.length };
      })()
    `);
    assert.deepEqual(hover, { early: 0, reentered: 0, final: 1 }, '悬停预览离开延迟与重新进入取消逻辑必须保留');

    // The real main process hides the native window after closing. Keep this
    // synthetic re-entry audit hidden too, so the physical mouse cannot inject
    // an extra pointerenter during its intentionally simulated hover grace time.
    window.hide();
    const explicitClose = await evaluate(`
      (async () => {
        const fixture = window.__quickTest;
        fixture.show(38, true);
        fixture.hide({ reason: 'explicit' });
        const before = fixture.calls.focus.length;
        document.documentElement.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        fixture.show(38, false);
        fixture.hide({ reason: 'hover' });
        await new Promise((resolve) => setTimeout(resolve, 280));
        document.documentElement.dispatchEvent(new PointerEvent('pointerenter'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { before, after: fixture.calls.focus.length, visible: document.getElementById('quick-island').dataset.visible };
      })()
    `);
    assert.equal(explicitClose.after, explicitClose.before, '主动收起及迟到的鼠标进入都不得重新展开首页');
    assert.equal(explicitClose.visible, 'false');

    await evaluate(`window.__quickTest.hide()`);
    assert.equal(await evaluate(`document.getElementById('quick-codex').dataset.active`), 'false');
    const hiddenPolling = await evaluate(`
      (async () => {
        const before = window.__quickTest.calls.status;
        await new Promise((resolve) => setTimeout(resolve, 2100));
        return { before, after: window.__quickTest.calls.status };
      })()
    `);
    assert.equal(hiddenPolling.after, hiddenPolling.before, '隐藏浮岛后不得继续请求 Codex 数据');

    window.showInactive();
    await show();
    const safety = await evaluate(`({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animations: document.getAnimations().filter((animation) => animation.playState === 'running').length,
      transitions: [...document.querySelectorAll('#quick-island, #quick-island *')].filter((node) =>
        getComputedStyle(node).transitionDuration.split(',').some((duration) => parseFloat(duration) > 0.00001)
      ).length,
      errors: window.__quickTest.errors,
    })`);
    assert.equal(safety.reduced, true);
    assert.equal(safety.animations, 0, '减少动态效果时不得运行动画');
    assert.equal(safety.transitions, 0, '减少动态效果时不得保留过渡');
    assert.deepEqual(safety.errors, [], '浮岛不得出现未处理脚本错误');

    if (process.env.QUICK_ISLAND_SCREENSHOT) {
      const screenshotPath = path.resolve(process.env.QUICK_ISLAND_SCREENSHOT);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      fs.writeFileSync(screenshotPath, (await window.webContents.capturePage()).toPNG());
    }
    console.log('Quick island Electron regression checks passed');
  } finally {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
  }
}

main().then(() => app.quit(), (error) => {
  console.error(error);
  app.exit(1);
});
