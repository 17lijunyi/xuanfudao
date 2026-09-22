(() => {
  'use strict';

  const api = window.notchAPI || {};
  const island = document.getElementById('quick-island');
  const message = document.getElementById('quick-message');
  const activity = document.getElementById('quick-activity');
  const mirrorButton = document.getElementById('quick-mirror');
  const mirrorVideo = document.getElementById('quick-mirror-video');
  const mirrorPanel = document.getElementById('quick-mirror-panel');
  const noteInput = document.getElementById('quick-note-input');
  const noteStatus = document.getElementById('quick-note-status');
  const timerToggle = document.getElementById('quick-timer-toggle');
  const timerReset = document.getElementById('quick-timer-reset');
  const timerDuration = document.getElementById('quick-timer-duration');
  const NOTE_KEY = 'notch-home-note';
  const NOTE_ARCHIVE_KEY = 'notch-note-archive-v1';
  const NOTE_ACTIVE_KEY = 'notch-note-active-archive-v1';
  const POMODORO_DURATION_KEY = 'dynamic-panel-pomodoro-duration-v3';
  const WEATHER_CITY_KEY = 'notch-weather-city-v1';
  const WEATHER_LAST_KEY = 'notch-weather-last-v1';
  const weatherButton = document.getElementById('quick-weather');
  const weatherDialog = document.getElementById('quick-weather-dialog');
  const weatherCityInput = document.getElementById('quick-weather-city');
  const weatherLabel = document.getElementById('quick-weather-label');
  const weatherDetail = document.getElementById('quick-weather-detail');
  let weatherCity = '';
  let weatherLast = null;
  let weatherPending = false;
  let weatherFailed = false;
  let weatherAttemptedAt = 0;
  let weatherRevision = 0;
  let weatherTimer;
  try {
    weatherCity = (localStorage.getItem(WEATHER_CITY_KEY) || '').trim();
    const saved = JSON.parse(localStorage.getItem(WEATHER_LAST_KEY) || 'null');
    if (saved && typeof saved.query === 'string' && typeof saved.city === 'string'
      && Number.isFinite(saved.temperature) && Number.isFinite(saved.updatedAt)) weatherLast = saved;
  } catch (_) {}

  let visible = false;
  let interactive = false;
  let focusRequest = null;
  let textFocusRevision = 0;
  let generation = 0;
  let leaveTimer;
  let messageTimer;
  let refreshTimer;
  let activityTimer;
  let refreshing = false;
  let resumeClosingUntil = 0;
  let requestedHideReason = 'explicit';
  let quickApps = [];
  let appsEditing = false;
  let appsBusy = false;
  let appsRevision = 0;
  let noteTimer;
  let noteDirty = false;
  let calendarDay = '';
  let selectedCalendarDay = '';
  let heatmapKey = '';
  let timerBusy = false;
  let currentActivities = null;
  let mirrorStream = null;
  let mirrorStarting = false;
  let mirrorRevision = 0;
  let preferencePanel = null;
  let preferenceTrigger = null;

  function closePreferences(restoreFocus = false) {
    if (!preferencePanel) return false;
    const trigger = preferenceTrigger;
    preferencePanel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    preferencePanel = null;
    preferenceTrigger = null;
    if (restoreFocus && visible) trigger.focus({ preventScroll: true });
    return true;
  }

  async function togglePreferences(trigger) {
    const panel = document.getElementById(trigger.getAttribute('aria-controls'));
    if (!panel) return;
    const wasOpen = panel === preferencePanel;
    const source = window.cardReflow?.capture(preferencePanel || panel, { selector: '.appearance-option' });
    closePreferences();
    if (wasOpen) return;
    closeWeatherSettings(false);
    codexCard.closeDetails();
    stopMirror();
    preferencePanel = panel;
    preferenceTrigger = trigger;
    panel.hidden = false;
    void window.cardReflow?.play(source, panel, { selector: '.appearance-option', spatial: true });
    trigger.setAttribute('aria-expanded', 'true');
    const token = generation;
    const result = await focusIsland();
    if (result.ok && visible && token === generation && preferencePanel === panel) {
      panel.querySelector('[role="radio"][aria-checked="true"]:not(:disabled)')?.focus({ preventScroll: true });
    }
  }

  document.addEventListener('pointerdown', (event) => {
    if (preferencePanel && !preferencePanel.contains(event.target)
      && !event.target.closest('[data-quick-preference]')) closePreferences();
  });

  function cleanText(value) {
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join('、');
    return typeof value === 'string' ? value.trim() : '';
  }

  function tell(text, duration = 3500) {
    clearTimeout(messageTimer);
    message.textContent = text;
    message.hidden = !text;
    if (text) messageTimer = setTimeout(() => { message.hidden = true; }, duration);
  }

  function requestHide(reason = 'explicit') {
    requestedHideReason = reason === 'hover' ? 'hover' : 'explicit';
    Promise.resolve(api.hideQuickIsland?.({ reason: requestedHideReason })).catch(() => {});
  }

  function focusIsland() {
    if (!visible) return Promise.resolve({ ok: false });
    if (focusRequest) return focusRequest;
    const wasInteractive = interactive;
    if (wasInteractive && document.hasFocus()) return Promise.resolve({ ok: true });
    interactive = true;
    island.dataset.interactive = 'true';
    clearTimeout(leaveTimer);
    const token = generation;
    const request = Promise.resolve(api.showQuickIsland?.({ focus: true }))
      .then((result) => {
        if (result?.ok === false) throw new Error('focus_unavailable');
        return { ok: true };
      })
      .catch(() => {
        if (visible && token === generation) {
          interactive = wasInteractive;
          island.dataset.interactive = String(wasInteractive);
          tell('暂时无法开始输入，请再点击一次');
        }
        return { ok: false };
      })
      .finally(() => { if (focusRequest === request) focusRequest = null; });
    focusRequest = request;
    return request;
  }

  // A hover window cannot become key by focusing a DOM textarea alone. Start
  // native activation on the first pointer press, then keep the clicked caret.
  document.addEventListener('pointerdown', (event) => {
    const revision = ++textFocusRevision;
    if (event.button !== 0 || !visible || !(event.target instanceof Element)) return;
    const control = event.target.closest('textarea, input, select, [contenteditable="true"], [contenteditable=""]');
    if (!control || control.disabled || control.closest('[inert]')) return;
    const token = generation;
    void focusIsland().then((result) => {
      if (result.ok && visible && token === generation && revision === textFocusRevision
        && control.isConnected && !control.closest('[inert]')) {
        control.focus({ preventScroll: true });
      }
    });
  }, true);

  const codexCard = window.CodexFloatCard.create(document.getElementById('quick-codex'), {
    compact: false,
    notify: tell,
    onDetails: () => {
      stopMirror();
      interactive = true;
      island.dataset.interactive = 'true';
      Promise.resolve(api.showQuickIsland?.({ focus: true })).catch(() => {});
    },
  });

  function localDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function readTodos() {
    try {
      const todos = JSON.parse(localStorage.getItem('notch-todo-data') || '{}');
      return ['P0', 'P1', 'P2', 'P3'].flatMap((key) => Array.isArray(todos?.[key]) ? todos[key] : [])
        .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim());
    } catch (_) { return []; }
  }

  function readTodayTodos(today) {
    return readTodos().filter((item) => item.done !== true && typeof item.deadline === 'string'
      && Number.isFinite(Date.parse(item.deadline)) && localDate(new Date(item.deadline)) === today)
      .sort((left, right) => Date.parse(left.deadline) - Date.parse(right.deadline));
  }

  function paintClock() {
    const now = new Date();
    const clock = document.getElementById('quick-clock-time');
    clock.dateTime = now.toISOString();
    clock.textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    document.getElementById('quick-clock-date').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(now);
  }

  function paintWeather() {
    const last = weatherLast?.query === weatherCity ? weatherLast : null;
    const stale = Boolean(last && (weatherFailed || Date.now() - last.updatedAt > 15 * 60 * 1000));
    weatherButton.dataset.stale = String(stale);
    if (!weatherCity) {
      weatherLabel.textContent = '设置城市';
      weatherDetail.textContent = '查看当地天气 ↗';
      weatherButton.title = '设置城市以读取真实天气';
    } else if (last) {
      weatherLabel.textContent = `${last.city} ${Math.round(last.temperature)}°`;
      const description = cleanText(last.weatherText) || '天气已更新';
      weatherDetail.textContent = weatherPending ? '正在更新…' : `${stale ? '已过期 · ' : ''}${description}`;
      const time = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(last.updatedAt));
      weatherButton.title = `${weatherLabel.textContent} · ${description} · 上次更新 ${time}${stale ? '，当前显示上次数据' : ''}，点击更改城市`;
    } else {
      weatherLabel.textContent = weatherCity;
      weatherDetail.textContent = weatherPending ? '正在读取天气…' : '天气暂不可用 · 重试';
      weatherButton.title = `${weatherCity}：${weatherPending ? '正在读取天气' : '暂未读取到天气，请检查城市名称并重试'}`;
    }
    weatherButton.setAttribute('aria-label', weatherButton.title);
  }

  async function refreshWeather(force = false) {
    if (!visible || !weatherCity || weatherPending) { paintWeather(); return; }
    const now = Date.now();
    const current = weatherLast?.query === weatherCity ? weatherLast : null;
    if (!force && ((current && now - current.updatedAt < 15 * 60 * 1000 && !weatherFailed) || now - weatherAttemptedAt < 60000)) { paintWeather(); return; }
    const city = weatherCity;
    const token = ++weatherRevision;
    weatherPending = true;
    weatherAttemptedAt = now;
    paintWeather();
    try {
      const result = await api.getWeather?.(city);
      if (city !== weatherCity || token !== weatherRevision) return;
      if (!result?.ok || !Number.isFinite(result.temperature) || !Number.isFinite(result.updatedAt)) throw new Error('weather_unavailable');
      weatherLast = { query: city, city: cleanText(result.city) || city, temperature: result.temperature,
        weatherText: cleanText(result.weatherText), weatherCode: result.weatherCode,
        isDay: result.isDay === true, updatedAt: result.updatedAt };
      weatherFailed = false;
      try { localStorage.setItem(WEATHER_LAST_KEY, JSON.stringify(weatherLast)); } catch (_) {}
    } catch (_) {
      if (city === weatherCity && token === weatherRevision) weatherFailed = true;
    } finally {
      if (token === weatherRevision) { weatherPending = false; paintWeather(); }
    }
  }

  function openWeatherSettings() {
    stopMirror();
    focusIsland();
    weatherCityInput.value = weatherCity;
    document.getElementById('quick-weather-note').textContent = '输入城市即可查看天气，无需开启定位。';
    weatherDialog.showModal();
    weatherCityInput.focus();
    weatherCityInput.select();
  }

  function closeWeatherSettings(restoreFocus = true) {
    if (weatherDialog.open) weatherDialog.close();
    if (restoreFocus && visible) weatherButton.focus({ preventScroll: true });
  }

  function paintHeatmap() {
    const today = new Date();
    const counts = new Map();
    for (const item of readTodos()) {
      if (typeof item.deadline !== 'string' || !Number.isFinite(Date.parse(item.deadline))) continue;
      const key = localDate(new Date(item.deadline));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const days = Array.from({ length: 28 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 27 + index);
      const key = localDate(date);
      return { date, key, count: counts.get(key) || 0 };
    });
    const nextKey = JSON.stringify(days.map(({ key, count }) => [key, count]));
    if (nextKey === heatmapKey) return;
    heatmapKey = nextKey;
    const grid = document.getElementById('quick-heatmap');
    grid.replaceChildren();
    days.forEach(({ date, key, count }) => {
      const day = document.createElement('button');
      day.type = 'button';
      day.dataset.date = key;
      day.dataset.calendarDay = key;
      day.dataset.count = String(Math.min(4, count));
      day.title = `${date.getMonth() + 1}月${date.getDate()}日 · ${count} 项待办（按截止日期）`;
      day.setAttribute('aria-label', day.title);
      if (key === localDate(today)) day.setAttribute('aria-current', 'date');
      grid.append(day);
    });
    document.getElementById('quick-heatmap-count').textContent = `${days.reduce((sum, item) => sum + item.count, 0)} 项`;
  }

  function paintApps() {
    const grid = document.getElementById('quick-apps-grid');
    const empty = document.getElementById('quick-apps-empty');
    const edit = document.getElementById('quick-apps-edit');
    const focusId = grid.contains(document.activeElement) ? document.activeElement.dataset.launchApp : null;
    grid.closest('.quick-apps').dataset.editing = String(appsEditing);
    grid.setAttribute('aria-busy', String(appsBusy));
    edit.textContent = appsEditing ? '完成' : '更换';
    edit.setAttribute('aria-pressed', String(appsEditing));
    edit.disabled = appsBusy || quickApps.length === 0;
    document.getElementById('quick-apps-hint').hidden = !appsEditing;
    grid.replaceChildren();
    quickApps.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quick-app';
      button.dataset.launchApp = item.id;
      button.dataset.unavailable = String(item.available === false);
      button.disabled = appsBusy;
      const label = item.empty ? '添加应用' : appsEditing ? `更换${item.name}` : `打开${item.name}`;
      button.setAttribute('aria-label', label);
      button.title = item.available === false && !item.empty && !appsEditing ? `${item.name}已不在原位置，点「更换」重新选择` : label;
      const safeIcon = /^data:image\/(?:png|jpeg|jpg|webp);base64,[a-z0-9+/=\s]+$/i.test(item.icon || '');
      const icon = document.createElement(safeIcon ? 'img' : 'span');
      if (safeIcon) { icon.src = item.icon; icon.alt = ''; }
      else { icon.className = 'quick-app-icon'; icon.textContent = item.empty ? '+' : Array.from(item.name)[0] || '·'; icon.setAttribute('aria-hidden', 'true'); }
      const name = document.createElement('small');
      name.textContent = item.name;
      button.append(icon, name);
      grid.append(button);
      if (focusId === item.id && !appsBusy) button.focus({ preventScroll: true });
    });
    empty.hidden = quickApps.length > 0;
    grid.hidden = quickApps.length === 0;
    empty.textContent = '暂未读取到常用应用';
  }

  function acceptApps(result) {
    if (result?.ok === false || !Array.isArray(result?.items)) throw new Error('apps_unavailable');
    quickApps = result.items.filter((item) => cleanText(item?.id) && cleanText(item?.name)).slice(0, 8);
    paintApps();
  }

  async function refreshApps() {
    const token = generation;
    const revision = ++appsRevision;
    try {
      const result = await api.getQuickLaunchApps?.();
      if (!visible || token !== generation || revision !== appsRevision) return;
      acceptApps(result);
    } catch (_) {
      if (visible && token === generation && revision === appsRevision) {
        const empty = document.getElementById('quick-apps-empty');
        empty.hidden = false;
        empty.textContent = '暂时无法读取应用，请重新打开悬浮岛';
      }
    }
  }

  async function editApps() {
    if (appsBusy) return;
    if (appsEditing) {
      appsEditing = false;
      paintApps();
      document.getElementById('quick-apps-edit').focus();
      return;
    }
    const token = generation;
    const wasInteractive = interactive;
    interactive = true;
    clearTimeout(leaveTimer);
    appsBusy = true;
    paintApps();
    try {
      const result = await api.showQuickIsland?.({ focus: true });
      if (!result?.ok) throw new Error('island_unavailable');
      if (visible && token === generation) appsEditing = true;
    } catch (_) {
      interactive = wasInteractive;
      if (visible && token === generation) tell('暂时无法更换应用，请重试');
    } finally {
      appsBusy = false;
      if (visible) paintApps();
    }
  }

  async function replaceApp(id) {
    if (appsBusy) return;
    const token = generation;
    appsRevision++;
    appsBusy = true;
    interactive = true;
    clearTimeout(leaveTimer);
    paintApps();
    try {
      const result = await api.chooseQuickLaunchApp?.(id);
      if (!visible || token !== generation) return;
      if (result?.ok) {
        if (!result.canceled) { acceptApps(result); tell('已更换，选择已保存'); }
      } else {
        const errors = {
          invalid_app: '请选择有效的 Mac 应用（.app）',
          duplicate_app: '这个应用已经在常用应用中，请选择其他应用',
          save_failed: '保存失败，原应用已保留，请重试',
          busy: '请先完成当前应用的选择',
          settings_unavailable: '暂时无法读取常用应用设置',
        };
        tell(errors[result?.error] || '暂时无法更换应用，请重试');
      }
    } catch (_) { if (visible && token === generation) tell('暂时无法更换应用，请重试'); }
    finally {
      appsBusy = false;
      if (visible) {
        paintApps();
        if (token !== generation) refreshApps();
        else [...document.querySelectorAll('[data-launch-app]')].find((button) => button.dataset.launchApp === id)?.focus({ preventScroll: true });
      }
    }
  }

  function handleAppsEscape() {
    if (appsBusy) return true;
    if (appsEditing) { editApps(); return true; }
    return false;
  }

  function loadNote() {
    if (noteDirty) return;
    try { noteInput.value = localStorage.getItem(NOTE_KEY) || ''; }
    catch (_) { noteStatus.textContent = '暂时无法读取'; }
  }

  function saveNoteDraft() {
    clearTimeout(noteTimer);
    if (!noteDirty) return true;
    try {
      localStorage.setItem(NOTE_KEY, noteInput.value);
      if (!noteInput.value.trim()) localStorage.removeItem(NOTE_ACTIVE_KEY);
      noteDirty = false;
      noteStatus.textContent = '草稿已保存';
      return true;
    } catch (_) { noteStatus.textContent = '保存失败，请保留内容'; return false; }
  }

  function archiveNote() {
    if (!saveNoteDraft()) return;
    const content = noteInput.value.trim();
    if (!content) { tell('先写点内容再保存'); return; }
    try {
      const notes = JSON.parse(localStorage.getItem(NOTE_ARCHIVE_KEY) || '[]');
      if (!Array.isArray(notes)) throw new Error('invalid_notes');
      let id = localStorage.getItem(NOTE_ACTIVE_KEY) || '';
      const existing = notes.find((item) => item && item.id === id);
      const now = Date.now();
      if (existing) { existing.content = content; existing.updatedAt = now; }
      else { id = crypto.randomUUID(); notes.unshift({ id, content, createdAt: now, updatedAt: now }); }
      localStorage.setItem(NOTE_ARCHIVE_KEY, JSON.stringify(notes.slice(0, 200)));
      localStorage.setItem(NOTE_ACTIVE_KEY, id);
      localStorage.setItem(NOTE_KEY, noteInput.value);
      noteStatus.textContent = '已保存到笔记库';
      tell('笔记已保存', 1600);
    } catch (_) { noteStatus.textContent = '保存失败，请保留内容'; tell('暂时无法保存笔记，请重试'); }
  }

  function configuredDuration() {
    try {
      const raw = JSON.parse(localStorage.getItem(POMODORO_DURATION_KEY) || 'null');
      if (Array.isArray(raw) && raw.length === 3) return Math.max(0, Math.min(3660, (Math.min(60, (Number(raw[0]) || 0) * 60 + (Number(raw[1]) || 0)) * 60) + Math.min(60, Number(raw[2]) || 0)));
      if (Array.isArray(raw) && raw.length === 2) return Math.max(0, Math.min(3660, Math.min(60, Number(raw[0]) || 0) * 60 + Math.min(60, Number(raw[1]) || 0)));
    } catch (_) {}
    return 1500;
  }

  function paintTimer() {
    const timer = currentActivities?.timer;
    const known = timer && typeof timer.active === 'boolean' && typeof timer.running === 'boolean';
    const duration = Number.isFinite(timer?.durationSeconds) ? timer.durationSeconds : configuredDuration();
    const focusDuration = Number.isFinite(timer?.focusSeconds) ? timer.focusSeconds : duration;
    const phase = timer?.phase === 'break' ? '休息' : '专注';
    const remaining = known && timer.active ? timer.running && Number.isFinite(timer.endAt)
      ? Math.max(0, Math.ceil((timer.endAt - Date.now()) / 1000)) : Number(timer.remainingSeconds) : duration;
    const running = known && timer.active && timer.running;
    island.dataset.timerRunning = String(running);
    document.getElementById('quick-timer-time').textContent = known ? clockText(remaining) : '--:--';
    document.getElementById('quick-timer-state').textContent = !known ? '状态尚未同步' : running ? `正在${phase}` : timer.active ? `${phase}已暂停` : '准备专注';
    const ratio = known && timer.active ? Math.max(0, Math.min(1, remaining / Math.max(1, duration))) : 1;
    document.getElementById('quick-timer-progress').style.strokeDashoffset = String((1 - ratio) * 333.009);
    timerToggle.setAttribute('aria-label', running ? '暂停番茄钟' : '开始番茄钟');
    timerToggle.disabled = timerBusy || !known || typeof api.controlPomodoro !== 'function';
    timerReset.disabled = timerBusy || !known || !timer.active;
    timerDuration.disabled = timerBusy || !known || timer.active;
    timerDuration.title = timer?.active ? '重置后可修改专注时长' : '专注结束后自动休息 5 分钟并循环';
    if (![...timerDuration.options].some((option) => option.value === String(focusDuration))) {
      timerDuration.querySelector('[data-custom]')?.remove();
      const option = document.createElement('option');
      option.value = String(focusDuration);
      option.textContent = `${Math.floor(focusDuration / 60)}分${focusDuration % 60 ? `${focusDuration % 60}秒` : ''}`;
      option.dataset.custom = 'true';
      timerDuration.append(option);
    }
    timerDuration.value = String(focusDuration);
  }

  async function controlTimer(action, seconds) {
    if (timerBusy || !visible || typeof api.controlPomodoro !== 'function') return;
    timerBusy = true;
    paintTimer();
    try {
      const result = await api.controlPomodoro(seconds === undefined ? { action } : { action, seconds });
      if (!result?.ok) { if (visible) tell('番茄钟暂时无法操作，请重试'); }
      else {
        const activities = await api.getIslandActivities?.();
        if (activities) paintActivities(activities);
      }
    } catch (_) { if (visible) tell('番茄钟暂时无法操作，请重试'); }
    finally { timerBusy = false; paintTimer(); }
  }

  function paintCalendar() {
    const now = new Date();
    const today = localDate(now);
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
    const week = document.getElementById('quick-week');
    document.getElementById('quick-month').textContent = `${now.getMonth() + 1}月`;
    if (calendarDay !== today) {
      calendarDay = today;
      selectedCalendarDay = today;
      week.replaceChildren();

    ['一', '二', '三', '四', '五', '六', '日'].forEach((label, index) => {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      const day = document.createElement('button');
      day.type = 'button';
      day.dataset.date = localDate(date);
      day.dataset.calendarDay = day.dataset.date;
      day.setAttribute('aria-label', `${date.getMonth() + 1}月${date.getDate()}日，查看当天待办`);
      if (day.dataset.date === today) day.setAttribute('aria-current', 'date');
      const weekday = document.createElement('span');
      weekday.textContent = label;
      const number = document.createElement('strong');
      number.textContent = date.getDate();
      day.append(weekday, number);
      week.append(day);
    });
    }

    week.querySelectorAll('[data-date]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.date === selectedCalendarDay)));
    const label = selectedCalendarDay === today ? '今天' : `${Number(selectedCalendarDay.slice(5, 7))}月${Number(selectedCalendarDay.slice(8))}日`;
    const items = readTodayTodos(selectedCalendarDay || today);
    const agenda = document.querySelector('.today-agenda');
    const agendaTitle = document.getElementById('quick-agenda-title');
    const agendaMeta = document.getElementById('quick-agenda-meta');
    const count = document.getElementById('quick-todo-count');
    agenda.dataset.hasTodos = String(items.length > 0);
    agenda.title = '打开全部待办，可继续编辑任务';
    agendaTitle.textContent = items[0]?.text.trim() || `${label}没有待办事项`;
    agendaMeta.textContent = items.length > 1 ? `${label}还有 ${items.length - 1} 项` : items.length === 1 ? `${label}的待办` : '待办';
    count.textContent = String(items.length);
    count.hidden = items.length === 0;
    agenda.setAttribute('aria-label', items.length ? `${label}有 ${items.length} 项待办，打开全部待办` : `${label}没有待办事项，打开全部待办`);
  }

  function clockText(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function paintActivities(activities = currentActivities) {
    currentActivities = activities && typeof activities === 'object' ? activities : null;
    const recording = currentActivities?.recording;
    const timer = currentActivities?.timer;
    let kind = '';
    let text = '';
    if (recording && recording.status !== 'idle') {
      const elapsed = Number(recording.elapsedMs) + (recording.status === 'recording' ? Math.max(0, Date.now() - Number(recording.updatedAt || Date.now())) : 0);
      kind = 'recording';
      text = `${recording.status === 'paused' ? '录音暂停' : recording.status === 'saving' ? '保存录音' : '录音'} ${clockText(elapsed / 1000)}`;
    } else if (timer?.active) {
      const remaining = timer.running ? Math.max(0, (Number(timer.endAt) - Date.now()) / 1000) : Number(timer.remainingSeconds);
      kind = 'timer';
      text = `${timer.running ? '计时' : '计时暂停'} ${clockText(remaining)}`;
    }
    activity.hidden = !text;
    activity.textContent = text;
    if (kind) activity.dataset.kind = kind;
    else delete activity.dataset.kind;
    paintTimer();
  }

  async function refresh() {
    if (!visible || refreshing) return;
    refreshing = true;
    const token = generation;
    try {
      const [activities] = await Promise.allSettled([api.getIslandActivities?.()]);
      if (!visible || token !== generation) return;
      paintCalendar();
      paintHeatmap();
      paintClock();
      paintActivities(activities.status === 'fulfilled' && activities.value ? activities.value : currentActivities);
    } finally {
      refreshing = false;
    }
  }

  function stopMirror() {
    mirrorRevision++;
    mirrorStarting = false;
    if (mirrorStream) {
      mirrorStream.getTracks().forEach((track) => track.stop());
      mirrorStream = null;
    }
    try { mirrorVideo.pause(); } catch (_) {}
    mirrorVideo.srcObject = null;
    mirrorButton.removeAttribute('aria-busy');
    mirrorButton.setAttribute('aria-label', '打开实时镜子');
    mirrorButton.setAttribute('aria-pressed', 'false');
    island.dataset.mirror = 'false';
    mirrorPanel.hidden = true;
  }

  async function startMirror() {
    if (!visible || mirrorStarting || mirrorStream) return;
    const token = ++mirrorRevision;
    mirrorStarting = true;
    interactive = true;
    island.dataset.interactive = 'true';
    mirrorButton.setAttribute('aria-busy', 'true');
    mirrorPanel.hidden = false;
    try {
      await api.showQuickIsland?.({ focus: true });
      const permitted = typeof api.ensureCamera === 'function' ? await api.ensureCamera() : true;
      if (!permitted) throw new Error('camera_permission_denied');
      if (!visible || token !== mirrorRevision || !mirrorStarting) return;
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera_unavailable');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } },
      });
      if (!visible || token !== mirrorRevision || !mirrorStarting) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mirrorStream = stream;
      mirrorVideo.srcObject = stream;
      await mirrorVideo.play();
      if (!visible || token !== mirrorRevision || mirrorStream !== stream) {
        stream.getTracks().forEach((track) => track.stop());
        if (mirrorStream === stream) mirrorStream = null;
        mirrorVideo.srcObject = null;
        return;
      }
      island.dataset.mirror = 'true';
      mirrorButton.setAttribute('aria-label', '关闭实时镜子');
      mirrorButton.setAttribute('aria-pressed', 'true');
    } catch (error) {
      if (token === mirrorRevision) {
        const denied = error?.name === 'NotAllowedError' || error?.message === 'camera_permission_denied';
        stopMirror();
        tell(denied ? '需要摄像头权限才能打开镜子' : '暂时无法打开摄像头');
      }
    } finally {
      if (token === mirrorRevision) {
        mirrorStarting = false;
        mirrorButton.removeAttribute('aria-busy');
      }
    }
  }

  function show(payload = {}) {
    const handoffId = payload.handoffId;
    window.islandCardMotion?.configure(handoffId, payload.motion, payload.height);
    if (Number.isSafeInteger(handoffId) && handoffId > 0) document.documentElement.dataset.surfaceHandoff = String(handoffId);
    interactive = payload.interactive === true;
    island.dataset.interactive = String(interactive);
    const version = cleanText(payload.version);
    document.getElementById('quick-version').textContent = version ? `v${version}` : '';
    document.querySelector('.island-brand').title = version ? `悬浮岛 v${version}` : '悬浮岛';
    const strip = Math.max(20, Math.min(80, Number(payload.stripHeight) || 38));
    document.documentElement.style.setProperty('--island-notch-height', `${strip}px`);
    const menuInset = Math.max(0, Math.min(80, Number(payload.menuBarHeight) || 0));
    document.documentElement.style.setProperty('--island-menu-inset', `${menuInset}px`);
    const collapsedWidth = Math.max(200, Math.min(480, Number(payload.collapsedWidth) || 256));
    document.documentElement.style.setProperty('--island-collapsed-width', `${collapsedWidth}px`);
    if (visible) {
      clearTimeout(leaveTimer);
      refresh();
      if (handoffId) void window.prepareIslandSurface?.(handoffId);
      return;
    }
    generation++;
    visible = true;
    resumeClosingUntil = 0;
    clearTimeout(leaveTimer);
    clearTimeout(messageTimer);
    clearInterval(refreshTimer);
    clearInterval(activityTimer);
    clearInterval(weatherTimer);
    message.hidden = true;
    island.inert = false;
    island.setAttribute('aria-hidden', 'false');
    island.dataset.visible = 'false';
    codexCard.setActive(true);
    const token = generation;
    if (handoffId) island.dataset.visible = 'true';
    else requestAnimationFrame(() => requestAnimationFrame(() => {
      if (visible && token === generation) island.dataset.visible = 'true';
    }));
    paintCalendar();
    paintHeatmap();
    paintClock();
    loadNote();
    paintApps();
    refreshApps();
    refreshWeather();
    weatherTimer = setInterval(() => refreshWeather(), 60000);
    paintActivities();
    refresh();
    refreshTimer = setInterval(refresh, 2000);
    activityTimer = setInterval(() => { paintActivities(); paintClock(); }, 1000);
    if (handoffId) void window.prepareIslandSurface?.(handoffId);
  }

  function hide(payload = {}) {
    window.islandCardMotion?.cleanup();
    window.cardReflow?.cancel();
    delete document.documentElement.dataset.surfaceHandoff;
    generation++;
    focusRequest = null;
    textFocusRevision++;
    const reason = payload?.reason || requestedHideReason;
    resumeClosingUntil = visible && reason === 'hover' ? performance.now() + 250 : 0;
    requestedHideReason = 'explicit';
    saveNoteDraft();
    visible = false;
    interactive = false;
    appsEditing = false;
    clearTimeout(leaveTimer);
    clearTimeout(messageTimer);
    clearInterval(refreshTimer);
    clearInterval(activityTimer);
    clearInterval(weatherTimer);
    closeWeatherSettings(false);
    closePreferences();
    stopMirror();
    island.dataset.visible = 'false';
    codexCard.setActive(false);
    if (island.contains(document.activeElement)) document.activeElement.blur();
    island.inert = true;
    island.setAttribute('aria-hidden', 'true');
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button || !visible) return;
    if (button.dataset.quickPreference) {
      await togglePreferences(button);
      return;
    }
    if (preferencePanel && !preferencePanel.contains(button)) closePreferences();
    if (button.dataset.islandAction === 'hide') {
      requestHide();
      return;
    }
    if (button.dataset.islandAction === 'focus') {
      try { await api.showQuickIsland?.({ focus: true }); }
      catch (_) { tell('暂时无法保持悬浮岛打开，请重试'); }
      return;
    }
    if (button.dataset.mirrorAction === 'close') { stopMirror(); return; }
    if (button === mirrorButton) {
      if (mirrorStream || mirrorStarting) stopMirror();
      else startMirror();
      return;
    }
    if (button === timerToggle) { controlTimer('toggle'); return; }
    if (button === timerReset) { controlTimer('reset'); return; }
    if (button.id === 'quick-note-save') { archiveNote(); return; }
    if (button === weatherButton) { openWeatherSettings(); return; }
    if (button.id === 'quick-weather-close') { closeWeatherSettings(); return; }
    if (button.id === 'quick-apps-edit') { editApps(); return; }
    if (button.dataset.launchApp && (appsEditing || quickApps.find((item) => item.id === button.dataset.launchApp)?.empty)) {
      replaceApp(button.dataset.launchApp);
      return;
    }
    if (button.id === 'quick-weather-system' || button.dataset.launchApp) {
      button.disabled = true;
      try {
        const result = button.dataset.launchApp ? await api.launchQuickApp?.(button.dataset.launchApp) : await api.openWeatherApp?.();
        if (!result?.ok && visible) tell(result?.error === 'app_missing' ? '应用已不在原位置，点「更换」重新选择' : button.dataset.launchApp ? '暂时无法打开应用，请重试' : '暂时无法打开系统天气');
      } catch (_) { if (visible) tell('暂时无法打开，请重试'); }
      finally { button.disabled = false; }
      return;
    }
    if (button.dataset.calendarDay) {
      selectedCalendarDay = button.dataset.calendarDay;
      paintCalendar();
      return;
    }
    if (button.dataset.workspace) {
      saveNoteDraft();
      resumeClosingUntil = 0;
      requestedHideReason = 'explicit';
      stopMirror();
      try {
        const result = await api.openIslandWorkspace?.(button.dataset.workspace, window.islandCardMotion?.capture());
        if (result?.ok === false && !['superseded', 'dismissed', 'mode_changed'].includes(result.error)) tell('暂时无法打开工作台，请重试');
      } catch (_) {
        tell('暂时无法打开工作台，请重试');
      }
    }
  });

  document.documentElement.addEventListener('pointerenter', () => {
    clearTimeout(leaveTimer);
    if (!visible && performance.now() < resumeClosingUntil) {
      resumeClosingUntil = 0;
      Promise.resolve(api.showQuickIsland?.()).catch(() => {});
    } else { resumeClosingUntil = 0; }
  });
  document.documentElement.addEventListener('pointerleave', () => {
    clearTimeout(leaveTimer);
    if (!interactive && !document.documentElement.dataset.surfaceHandoff) {
      leaveTimer = setTimeout(() => {
        if (visible && !interactive && !document.documentElement.dataset.surfaceHandoff) requestHide('hover');
      }, 260);
    }
  });
  function handleEscape() {
    if (closePreferences(true)) return true;
    if (handleAppsEscape()) return true;
    if (codexCard.closeDetails()) return true;
    if (weatherDialog.open) { closeWeatherSettings(); return true; }
    if (mirrorStream || mirrorStarting) { stopMirror(); return true; }
    requestHide();
    return true;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleEscape();
    }
  });

  api.onEscape?.(handleEscape);
  api.onQuickIslandShow?.((metrics) => {
    show(metrics);
    api.getAppSettings?.().then((settings) => {
      const entry = document.querySelector('[data-workspace="projects"]');
      if (entry) entry.hidden = settings?.features?.projects === false;
    }).catch(() => {});
  });
  api.onQuickIslandHide?.(hide);
  api.onIslandActivities?.((activities) => paintActivities(activities));
  window.addEventListener('storage', (event) => {
    if (!event.key || event.key === 'notch-todo-data') { paintCalendar(); paintHeatmap(); }
    if (!event.key || event.key === NOTE_KEY) loadNote();
    if (!event.key || event.key === POMODORO_DURATION_KEY) paintTimer();
    if (event.key === WEATHER_CITY_KEY) {
      weatherCity = (event.newValue || '').trim(); weatherRevision++; weatherPending = false; weatherFailed = false; weatherAttemptedAt = 0;
      refreshWeather(true);
    }
  });
  weatherDialog.addEventListener('cancel', (event) => { event.preventDefault(); closeWeatherSettings(); });
  document.getElementById('quick-weather-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const nextCity = weatherCityInput.value.trim();
    if (!nextCity || nextCity.length > 80) return;
    try { localStorage.setItem(WEATHER_CITY_KEY, nextCity); }
    catch (_) { document.getElementById('quick-weather-note').textContent = '暂时无法保存城市，请重试。'; return; }
    weatherCity = nextCity;
    weatherRevision++;
    weatherPending = false;
    weatherFailed = false;
    weatherAttemptedAt = 0;
    closeWeatherSettings();
    refreshWeather(true);
  });
  paintWeather();
  noteInput.addEventListener('focus', focusIsland);
  noteInput.addEventListener('input', () => {
    noteDirty = true;
    // Match the workspace: clearing a saved draft starts a new note, even if
    // new text arrives before the deferred draft write runs.
    if (!noteInput.value.trim()) {
      try { localStorage.removeItem(NOTE_ACTIVE_KEY); } catch (_) {}
    }
    noteStatus.textContent = '正在保存…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNoteDraft, 300);
  });
  noteInput.addEventListener('blur', saveNoteDraft);
  timerDuration.addEventListener('focus', focusIsland);
  timerDuration.addEventListener('change', () => {
    const seconds = Number(timerDuration.value);
    if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 3660) controlTimer('set-duration', seconds);
  });
  window.addEventListener('beforeunload', () => { hide(); codexCard.destroy(); });
  window.QuickIsland = Object.freeze({ show, hide, stopMirror });
})();
