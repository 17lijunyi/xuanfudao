'use strict';

const root = document.getElementById('notification-root');
const shell = document.getElementById('notification-shell');
const projectElement = document.getElementById('notification-project');
const markElement = document.getElementById('notification-mark');
const sourceElement = document.getElementById('notification-source');
const toolElement = document.getElementById('notification-tool');
const capsuleElement = document.querySelector('.notification-codex-content');

const api = window.notchAPI;
const HIDE_FALLBACK_MS = 420;
const MAX_QUEUE_COUNT = 99;

let hideFallback = null;
let currentEventId = null;
let isVisible = false;
let isHiding = false;
let announcement = '';
let showRevision = 0;
const popupAppearance = window.IslandPopupAppearance.create({
  api: api || {}, elements: [capsuleElement, markElement],
  isRendered: () => !root.hidden, eventId: () => currentEventId,
  sendSurface: payload => api?.updateTaskNotificationSurface?.(payload),
  onMaterial: callback => api?.onTaskNotificationMaterial?.(callback),
});
const { applyAppearance, refreshSurface } = popupAppearance;

function firstText(values, fallback) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function normalizeNotification(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const stringPayload = typeof payload === 'string' ? payload : '';
  const sourceKey = firstText(
    [data.source, data.provider, data.agent, data.app, data.type],
    'task'
  ).toLowerCase();
  const sourceNames = {
    codex: 'Codex',
    claude: 'Claude Code',
    gpt: 'GPT',
    chatgpt: 'GPT',
    task: '任务',
    todo: '待办',
    pomodoro: '番茄钟',
  };
  const project = firstText([data.project, data.projectName, data.workspace], '');
  const stripHeight = readDimension(data.stripHeight, 31, 24, 80);
  const compactCode = ['codex', 'claude'].includes(sourceKey) || data.compactCode === true || data.presentation === 'code-completed';
  const title = firstText([data.title, data.taskTitle, data.taskName, data.name, stringPayload], '任务已完成');

  return {
    title,
    source: firstText([data.sourceName, sourceNames[sourceKey]], '任务'),
    sourceIcon: typeof data.sourceIcon === 'string' && /^assets\/(?:codex-mark\.svg|ai-tools\/[a-z0-9-]+\.(?:svg|png))$/.test(data.sourceIcon) ? data.sourceIcon : '',
    detail: firstText(
      [data.detail, data.body],
      sourceKey === 'todo'
        ? '将在 1 小时内截止'
        : project
          ? `已完成 · ${project}`
          : '已完成，可以查看了'
    ),
    queueCount: readQueueCount(data.queueCount ?? data.pendingCount ?? data.pending),
    eventId: data.eventId ?? null,
    sourceKey,
    compactCode,
    project: compactCode ? project || title : title,
    width: readDimension(data.width, 348, 280, 400),
    height: stripHeight + 86,
    stripHeight,
    collapsedWidth: readDimension(data.collapsedWidth, 256, 100, 400),
    entranceMs: readDimension(data.confirmationMs, 420, 0, 5000),
    appearance: data.appearance,
  };
}

function readDimension(value, fallback, minimum, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function readEventId(value) {
  if (value && typeof value === 'object') return value.eventId ?? null;
  return value ?? null;
}

function readQueueCount(value) {
  const raw = Array.isArray(value)
    ? value.length
    : value && typeof value === 'object'
      ? value.queueCount ?? value.pendingCount ?? value.pending ?? value.count
      : value;
  const count = Number(raw);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(MAX_QUEUE_COUNT, Math.floor(count));
}

function setQueueCount(value) {
  const count = readQueueCount(value);
  shell.setAttribute('aria-label', announcement + (count ? `，另有 ${count} 条提醒` : ''));
}

function clearHideFallback() {
  if (!hideFallback) return;
  clearTimeout(hideFallback);
  hideFallback = null;
}

function showNotification(payload) {
  const notification = normalizeNotification(payload);
  const samePresentation = isVisible && currentEventId !== null
    && currentEventId === notification.eventId && shell.dataset.source === notification.sourceKey;

  shell.dataset.source = notification.sourceKey;
  applyAppearance(notification.appearance);
  projectElement.textContent = notification.project;
  const description = notification.compactCode ? '任务已完成' : notification.detail;
  announcement = `${notification.project}，${description}`;
  shell.title = announcement;
  projectElement.title = announcement;
  projectElement.setAttribute('aria-label', notification.project);
  sourceElement.textContent = `${notification.source} · ${notification.sourceKey === 'todo' ? '即将截止' : notification.sourceKey === 'pomodoro' ? '阶段结束' : '任务完成'}`;
  toolElement.replaceChildren();
  if (notification.sourceIcon) {
    const image = document.createElement('img');
    image.src = notification.sourceIcon; image.alt = '';
    toolElement.appendChild(image);
  } else {
    toolElement.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 6 6-6 6M13 18h7"/></svg>';
  }
  // A deadline is a reminder, never a completed task. Both use the same right slot.
  const mark = notification.sourceKey === 'todo'
    ? '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>'
    : '<path d="m5 12 4.5 4.5L19 7"/>';
  markElement.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark}</svg>`;
  markElement.dataset.kind = notification.sourceKey === 'todo' ? 'reminder' : 'completed';
  const styles = document.documentElement.style;
  styles.setProperty('--notification-width', `${notification.width}px`);
  styles.setProperty('--notification-height', `${notification.height}px`);
  styles.setProperty('--notification-strip', `${notification.stripHeight}px`);
  styles.setProperty('--notification-collapsed-width', `${Math.min(notification.width, notification.collapsedWidth)}px`);
  styles.setProperty('--notification-open', `${notification.entranceMs}ms`);
  refreshSurface();
  setQueueCount(notification.queueCount);
  if (samePresentation) return;

  clearHideFallback();
  currentEventId = notification.eventId;
  isVisible = true;
  isHiding = false;
  const revision = ++showRevision;

  root.hidden = false;
  shell.classList.remove('is-visible', 'is-hiding');
  void shell.offsetWidth;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!isVisible || isHiding || revision !== showRevision) return;
      shell.classList.add('is-visible');
      refreshSurface();
    });
  });
}

function finishHide() {
  if (!isHiding) return;
  clearHideFallback();

  isVisible = false;
  isHiding = false;
  shell.classList.remove('is-visible', 'is-hiding');
  root.hidden = true;
  popupAppearance.clearSurface();

  if (api && typeof api.taskNotificationDismissed === 'function') {
    api.taskNotificationDismissed(currentEventId);
  }
}

function hideNotification(eventId) {
  if (!isVisible || isHiding) return;

  const requestedEventId = readEventId(eventId);
  if (requestedEventId !== null && requestedEventId !== currentEventId) return;
  isHiding = true;

  shell.classList.remove('is-visible');
  shell.classList.add('is-hiding');
  refreshSurface();
  hideFallback = setTimeout(finishHide, HIDE_FALLBACK_MS);
}

function subscribe(method, callback) {
  if (!api || typeof api[method] !== 'function') return;
  api[method](callback);
}

shell.addEventListener('click', async () => {
  const eventId = currentEventId;
  if (api && typeof api.activateTaskNotification === 'function') {
    try { await api.activateTaskNotification(eventId); } catch (error) {}
  }
  hideNotification(eventId);
});
shell.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    hideNotification(currentEventId);
  }
});
shell.addEventListener('transitionend', (event) => {
  if (event.target !== markElement || event.propertyName !== 'opacity') return;
  if (isHiding) finishHide();
});
subscribe('onTaskNotification', showNotification);
subscribe('onTaskNotificationQueue', setQueueCount);
subscribe('onTaskNotificationHide', hideNotification);
