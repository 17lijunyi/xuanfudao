const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getStatusIslandBounds } = require('../island-status-window');
const { taskNotificationWindowPolicy } = require('../main-services');

// Exercise the actual main-process notification functions with an isolated
// window and clock: no Electron launch, user profile or real completion events.
const main = fs.readFileSync(path.join(process.env.FUDAO_TEST_APP_DIR || path.join(__dirname, '..'), 'main.js'), 'utf8');
function section(from, until) {
  const start = main.indexOf(`function ${from}(`);
  const end = main.indexOf(`function ${until}(`, start);
  assert.ok(start >= 0 && end > start, `${from} main-process section exists`);
  return main.slice(start, end);
}

function fixture(services = {}) {
  let now = 10000;
  let nextTimer = 0;
  const timers = new Map();
  const messages = [];
  const target = {
    destroyed: false, visible: false, bounds: null,
    isDestroyed() { return this.destroyed; },
    setBounds(bounds) { this.bounds = bounds; },
    showInactive() { this.visible = true; },
    hide() { this.visible = false; },
    destroy() { this.destroyed = true; },
    webContents: { isDestroyed:()=>false, send(channel, payload) { messages.push({ channel, payload, at: now }); } },
  };
  const display = { bounds: { x: 100, y: -1080, width: 1710, height: 1080 }, workArea: { y: -1046 } };
  const context = vm.createContext({
    systemUIBlocks: () => false,
    getCollapsedWidth: () => 256,
    Date: { now: () => now },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    getWindowDisplay: () => display,
    getTargetDisplay: () => display,
    getCollapsedHeight: (d) => d.workArea.y - d.bounds.y || 38,
    getStatusIslandBounds, taskNotificationWindowPolicy,
    createTaskNotificationWindow: () => target,
    // The real notification surface retracts an active notch preview before
    // presenting a completion. Preview behavior is covered by the dedicated
    // main-process tests; this fixture isolates the notification lifecycle.
    dismissNotchPreviewSurface: () => {},
    hideQuickIsland: () => {}, statusIsland: { hide() {} },
    appearanceSettings: {getSnapshot: () => ({selectedId:'system-glass-blurred',revision:0})},
    appearanceNative: {clear() {}},
    mainWindow: null, notificationWindow: target, notificationWindowReady: true,
    aiCodeRuntime: null,
    require: name => name === './ai-tools' ? require('../ai-tools') : assert.fail('Unexpected module'),
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    ...services,
  });
  vm.runInContext(`
    ${main.match(/const TASK_NOTIFICATION_VISIBLE_MS[\s\S]+?const TASK_NOTIFICATION_MAX_QUEUE = \d+;/)[0]}
    const COLLAPSED_WIDTH = 256;
    let isQuitting = false;
    let activeTaskNotification = null;
    let taskNotificationLeaving = false;
    let taskNotificationPaused = false;
    let taskNotificationTimer = null;
    let taskNotificationFallbackTimer = null;
    let taskNotificationTimerStartedAt = 0;
    let taskNotificationRemainingMs = TASK_NOTIFICATION_VISIBLE_MS;
    const taskNotificationQueue = [];
    const recentTaskNotifications = new Map();
    const taskCompletionHistory = [];
    ${section('getCenteredBounds', 'getMenuBarHeight')}
    ${section('getPendingTaskNotificationCount', 'clearTodoReminderTimer')}
    ${section('syncTaskNotificationAppearance', 'recoverClosedTaskNotificationWindow')}
    ${section('clearTaskNotificationTimers', 'sendTaskNotificationResponse')}
    ${main.slice(main.indexOf('function taskWindowMatchScore('), main.indexOf("ipcMain.handle('task-notification:activate'"))}
  `, context);
  return {
    target, messages, display,
    run: (script) => vm.runInContext(script, context),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const pending = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!pending) break;
        const [id, timer] = pending;
        timers.delete(id); now = timer.at; timer.callback();
      }
      now = end;
    },
  };
}

function enqueue(f, eventId, source = 'codex') {
  f.run(`enqueueTaskNotification(${JSON.stringify({ source, eventId, taskId: eventId, project: `项目 ${eventId}`, title: '任务已完成' })})`);
}

test('Codex dual capsule opens then holds three seconds, ignores hover, and presents each queued project', () => {
  const f = fixture();
  enqueue(f, 'first');
  const first = f.messages.find((message) => message.channel === 'task-notification:show');
  assert.equal(first.payload.project, '项目 first');
  assert.equal(first.payload.confirmationMs, 420);
  assert.equal(first.payload.visibleMs, 3000);
  assert.equal(f.target.bounds.width, 348);
  assert.equal(f.target.bounds.height, 120);
  assert.equal(f.target.bounds.x, 781);
  assert.equal(f.target.bounds.y, -1080, 'must anchor to the island display, including negative coordinates');
  assert.equal(first.payload.stripHeight, 34);
  assert.equal(first.payload.collapsedWidth, 256);
  enqueue(f, 'second');
  f.advance(420);
  f.run('setTaskNotificationPaused(true)');
  f.advance(2999);
  assert.equal(f.messages.filter((message) => message.channel === 'task-notification:hide').length, 0);
  f.advance(1);
  assert.equal(f.messages.at(-1).payload, 'first');
  assert.equal(f.messages.at(-1).at - first.at, 3420);
  f.run(`finishTaskNotification('wrong-event')`);
  assert.equal(f.target.visible, true);
  f.run(`finishTaskNotification('first')`);
  assert.equal(f.target.visible, false);
  f.advance(80);
  const shows = f.messages.filter((message) => message.channel === 'task-notification:show');
  assert.equal(shows.length, 2);
  assert.equal(shows[1].payload.project, '项目 second');
  f.run(`finishTaskNotification('first')`);
  assert.equal(f.target.visible, true, 'stale dismissal must not close the next project');
  f.advance(3420 + 480 + 80);
  assert.equal(f.target.visible, false);
  assert.equal(f.target.destroyed, true, 'fallback must finish and dispose even if renderer does not acknowledge');
});

test('compact completion geometry preserves the notch safe area on a new display without restarting the hold', () => {
  const f = fixture();
  enqueue(f, 'display-change');
  f.advance(2500);
  f.display.bounds = { x: -900, y: 100, width: 900, height: 700 };
  f.display.workArea.y = 124;
  const presentation = f.run('getTaskNotificationPresentation()');
  const bounds = f.run('getTaskNotificationBounds()');
  assert.equal(presentation.height, 110);
  assert.equal(presentation.stripHeight, 24);
  assert.equal(bounds.x, -624);
  assert.equal(bounds.y, 100);
  f.advance(920);
  assert.equal(f.messages.at(-1).channel, 'task-notification:hide');
});

test('todo, pomodoro, GPT and summary prompts share the dual capsule geometry and fixed hold', () => {
  for (const source of ['todo', 'pomodoro', 'gpt', 'task']) {
    const f = fixture();
    enqueue(f, source, source);
    const { payload } = f.messages.find(message => message.channel === 'task-notification:show');
    assert.equal(f.target.bounds.width, 348);
    assert.equal(f.target.bounds.height, 120);
    assert.equal(payload.source, source, 'format changes cannot change event identity or activation routing');
    assert.equal(payload.stripHeight, 34);
    assert.equal(payload.visibleMs, 3000);
    f.advance(1000);
    f.run('setTaskNotificationPaused(true)');
    f.advance(2419);
    assert.equal(f.messages.filter(message => message.channel === 'task-notification:hide').length, 0);
    f.advance(1);
    assert.equal(f.messages.at(-1).channel, 'task-notification:hide');
  }
});

test('user dismissal advances the queue without waiting for the timer', () => {
  const f = fixture();
  enqueue(f, 'dismiss');
  enqueue(f, 'next');
  f.advance(1000);
  f.run(`finishTaskNotification('dismiss')`);
  f.advance(80);
  assert.equal(f.messages.at(-1).payload.eventId, 'next');
});

test('reduced motion skips entrance time and holds the dual capsule for three seconds', () => {
  const f = fixture({ systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: true }) } });
  enqueue(f, 'reduced-motion');
  assert.equal(f.messages.at(-1).payload.confirmationMs, 0);
  f.advance(2999);
  assert.equal(f.messages.at(-1).channel, 'task-notification:show');
  f.advance(1);
  assert.equal(f.messages.at(-1).channel, 'task-notification:hide');
});

test('live theme changes only appearance, retaining the active event and its original deadline', () => {
  const f=fixture();
  enqueue(f,'theme-live');
  f.advance(1200);
  f.run("syncTaskNotificationAppearance({selectedId:'classic',revision:1})");
  assert.equal(f.messages.at(-1).channel,'appearance:changed');
  assert.equal(f.run('activeTaskNotification.eventId'),'theme-live');
  f.advance(2219);
  assert.equal(f.messages.filter(message=>message.channel==='task-notification:hide').length,0);
  f.advance(1);
  assert.equal(f.messages.at(-1).payload,'theme-live');
  assert.equal(f.messages.at(-1).at,13420);
});

test('delayed activation cannot dismiss the next project notification', async () => {
  let resolveActivation;
  const f = fixture({ shell: { openExternal: () => new Promise((resolve) => { resolveActivation = resolve; }) } });
  enqueue(f, 'slow-click');
  f.run(`activeTaskNotification.threadId = '12345678-1234-1234-1234-123456789abc'`);
  const activation = f.run(`activateActiveTaskNotification('slow-click')`);
  enqueue(f, 'next');
  f.advance(3420 + 480 + 80);
  assert.equal(f.messages.at(-1).payload.eventId, 'next');
  resolveActivation();
  assert.equal(await activation, false);
  assert.equal(f.messages.at(-1).channel, 'task-notification:show');
  assert.equal(f.target.visible, true);
});

test('a burst of Codex completions keeps every name, order, compact bounds and three-second hold', () => {
  const f = fixture();
  for (let index = 0; index < 32; index++) enqueue(f, `burst-${index}`);
  for (let index = 0; index < 32; index++) {
    const shows = f.messages.filter(message => message.channel === 'task-notification:show');
    const next = shows.at(-1).payload;
    assert.equal(next.eventId, `burst-${index}`);
    assert.equal(next.project, `项目 burst-${index}`);
    assert.equal(next.source, 'codex');
    assert.equal(next.width, 348);
    assert.equal(next.height, 120);
    assert.equal(next.confirmationMs, 420);
    assert.equal(next.visibleMs, 3000);
    f.advance(3420);
    assert.equal(f.messages.at(-1).channel, 'task-notification:hide');
    f.run(`finishTaskNotification(${JSON.stringify(next.eventId)})`);
    f.advance(80);
  }
  assert.equal(f.messages.filter(message => message.channel === 'task-notification:show').length, 32);
  assert.equal(f.target.visible, false);
});

test('overflow from other notification sources cannot replace queued Codex projects', () => {
  const f = fixture();
  enqueue(f, 'active');
  for (let index = 0; index < 5; index++) enqueue(f, `todo-${index}`, 'todo');
  enqueue(f, 'codex-last');
  enqueue(f, 'todo-overflow', 'todo');
  const queue = JSON.parse(f.run('JSON.stringify(taskNotificationQueue)'));
  assert.equal(queue.at(-1).eventId, 'codex-last');
  assert.equal(queue.at(-1).source, 'codex');
  assert.equal(queue.filter(item => item.source !== 'codex').length, 5);
  assert.equal(queue.filter(item => item.isSummary).length, 1);
});

test('all code provider popups retain counts through entrance, hold and exit, releasing after native hide', () => {
  const pending = new Set(), released = [];
  let f;
  f = fixture({ aiCodeRuntime: { isSelected: () => true,
    holdCompletion(_id, task) { pending.add(task.id); return true; },
    finishCompletion(id) { assert.equal(f.target.visible, false, 'native popup is hidden before count changes'); pending.delete(id); released.push(id); },
  } });
  const providers = ['codex', 'claude-code', 'kimi-code', 'gemini-cli', 'qwen-code'];
  for (const id of providers) assert.equal(f.run(`enqueueCodeTaskNotification('${id}', { id:'${id}-event', threadId:'${id}-thread', turnId:'one', title:'项目 ${id}' })`), 'queued');
  assert.equal(pending.size, 5);
  for (const [index, id] of providers.entries()) {
    const presentation = f.messages.filter(item => item.channel === 'task-notification:show').at(-1).payload;
    assert.equal(presentation.compactCode, true); assert.equal(presentation.width, 348); assert.equal(presentation.height, 120);
    assert.equal(presentation.visibleMs, 3000);
    f.run("finishTaskNotification('wrong-event')"); assert.equal(pending.size, 5 - index);
    f.advance(3420); assert.equal(pending.size, 5 - index, 'exit animation still owns the count');
    f.run(`finishTaskNotification('${id}-event')`);
    assert.equal(pending.size, 4 - index);
    f.advance(80);
  }
  assert.deepEqual(released, providers.map(id => id + '-event'));
});
