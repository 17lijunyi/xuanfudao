(() => {
  'use strict';
  const root = document.getElementById('notch');
  if (!root) return;
  const api = window.notchAPI || {};
  const content = document.createElement('div');
  content.className = 'codex-notch';
  const quota = document.createElement('div');
  quota.className = 'codex-notch-quota';
  const amount = document.createElement('strong');
  const resetDays = document.createElement('span');
  resetDays.className = 'codex-notch-reset-days';
  resetDays.setAttribute('aria-hidden', 'true');
  quota.append(amount, resetDays);
  const tasks = document.createElement('div');
  tasks.className = 'codex-notch-tasks';
  const indicator = document.createElement('span');
  indicator.id = 'codex-notch-indicator';
  indicator.className = 'codex-notch-task-icon';
  const mark = document.createElement('img');
  mark.className = 'codex-notch-mark';
  mark.src = 'assets/codex-mark.svg';
  mark.alt = '';
  mark.draggable = false;
  mark.setAttribute('aria-hidden', 'true');
  const glow = document.createElement('span');
  glow.className = 'codex-notch-glow';
  glow.setAttribute('aria-hidden', 'true');
  const glowMark = mark.cloneNode(true);
  glow.append(glowMark);
  indicator.append(mark, glow);
  const projectCount = document.createElement('span');
  projectCount.className = 'codex-notch-project-count';
  projectCount.setAttribute('aria-hidden', 'true');
  tasks.append(indicator, projectCount);
  const preview = document.createElement('div');
  preview.className = 'codex-notch-preview';
  preview.setAttribute('aria-hidden', 'true');
  const previewTitle = document.createElement('strong');
  previewTitle.className = 'codex-notch-preview-title';
  const previewMeta = document.createElement('small');
  previewMeta.className = 'codex-notch-preview-meta';
  preview.append(previewTitle, previewMeta);
  content.append(quota, tasks, preview);
  root.append(content);
  // Inset from the curved outer edge, fitting naturally within the 28px wing.
  // A wider reading must not disappear behind the physical notch.
  function fitQuota() {
    const height = quota.clientHeight || 34;
    content.style.setProperty('--codex-status-scale', String(Math.min(1, height / 34)));
    content.style.setProperty('--codex-status-top', `${Math.max(0, (height - 34) / 2)}px`);
    amount.style.fontSize = '';
    const maximum = quota.clientWidth - 0.5;
    const width = amount.getBoundingClientRect().width;
    if (maximum > 0 && width > maximum) {
      const size = parseFloat(getComputedStyle(amount).fontSize);
      amount.style.fontSize = `${Math.floor(size * maximum / width * 100) / 100}px`;
    }
  }
  new ResizeObserver(fitQuota).observe(quota);
  let resetAt = null;
  let quotaTitle = '';
  function updateSummary() {
    const summary = `${quota.title}；${tasks.title}`;
    content.setAttribute('aria-label', summary); root.setAttribute('aria-description', summary);
    root.title = `${summary}。点击展开悬浮岛`;
  }
  function paintReset() {
    const days = Number.isFinite(resetAt) && resetAt > 0 ? Math.max(0, Math.ceil((resetAt - Date.now()) / 86400000)) : null;
    resetDays.textContent = days === null ? '—' : days > 99 ? '99+' : String(days);
    const detail = days === null ? '重置时间暂未提供'
      : `${days} 天内重置（${new Date(resetAt).toLocaleString('zh-CN')}）`;
    quota.title = `${quotaTitle} · ${detail}`;
    resetDays.title = detail;
  }
  // Quota snapshots are refreshed by the selected provider. Recompute the day
  // boundary locally as well; never reuse a demo day or another tool's reset.
  const resetTimer = setInterval(() => { paintReset(); updateSummary(); }, 60000);
  window.addEventListener('pagehide', () => clearInterval(resetTimer), { once: true });
  const LABELS = { attention: '需要处理', completed: '已完成', failed: '需关注', interrupted: '已中断', idle: '空闲', unknown: '状态待同步' };
  const ATTENTION_LABELS = { permission: '等待授权', input: '等待回答', failed: '任务失败', interrupted: '已中断' };
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  let revision = 0;
  let previewVisible = false;
  let previewTimer = null;
  let previewModel = { title: '暂无运行中的任务', state: 'unknown', startedAt: null, extra: 0 };

  function taskKey(item) {
    return text(item?.id) || `unidentified:${text(item?.title)}`;
  }

  function elapsedLabel(startedAt) {
    if (!Number.isFinite(startedAt) || startedAt <= 0) return '';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const remainder = seconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }

  function paintPreview() {
    previewTitle.textContent = previewModel.title;
    const elapsed = previewModel.state === 'running' ? elapsedLabel(previewModel.startedAt) : '';
    const stateLabel = previewModel.state === 'running' ? '运行中'
      : previewModel.state === 'attention' ? (ATTENTION_LABELS[previewModel.attentionKind] || LABELS.attention)
        : (LABELS[previewModel.state] || LABELS.unknown);
    previewMeta.textContent = [elapsed, stateLabel, previewModel.extra > 0 ? `+${previewModel.extra}` : ''].filter(Boolean).join(' · ');
    preview.title = `${previewModel.title} · ${previewMeta.textContent}`;
  }

  function syncPreviewTimer() {
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = null;
    if (!previewVisible || previewModel.state !== 'running' || !Number.isFinite(previewModel.startedAt)) return;
    previewTimer = setInterval(paintPreview, 1000);
  }

  function setPreviewVisible(visible) {
    previewVisible = visible === true;
    preview.setAttribute('aria-hidden', String(!previewVisible));
    if (previewVisible) paintPreview();
    syncPreviewTimer();
  }

  function render(rawSnapshot = {}) {
    const tool = window.AITools?.currentTool() || { id: 'codex', name: 'Codex', icon: 'assets/codex-mark.svg' };
    content.dataset.aiTool = tool.id;
    if (mark.getAttribute('src') !== tool.icon) mark.src = tool.icon;
    if (glowMark.getAttribute('src') !== tool.icon) glowMark.src = tool.icon;
    if (!tool.id || (tool.id !== 'codex' && rawSnapshot?.providerId !== tool.id)) {
      content.dataset.connection = 'unavailable';
      amount.textContent = '—'; amount.dataset.compact = 'false'; fitQuota();
      resetAt = null; quotaTitle = `${tool.name} · 暂无额度`; paintReset();
      tasks.dataset.mode = 'mark'; tasks.dataset.runningCount = '0';
      projectCount.textContent = '—'; projectCount.dataset.idle = 'false'; projectCount.hidden = !tool.id;
      tasks.title = `${tool.name} · 暂无任务`;
      indicator.dataset.status = 'unknown'; indicator.setAttribute('role', 'img');
      indicator.removeAttribute('aria-valuetext'); delete indicator.dataset.attentionKind;
      indicator.title = tasks.title; indicator.setAttribute('aria-label', tasks.title);
      const summary = `${quota.title}；${tasks.title}`;
      content.setAttribute('aria-label', summary); root.setAttribute('aria-description', summary);
      root.title = `${summary}。点击展开悬浮岛`;
      previewModel = { title: tool.name, state: 'unknown', startedAt: null, extra: 0 };
      paintPreview(); previewMeta.textContent = '任务状态未接入'; syncPreviewTimer();
      return;
    }

    const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot : {};
    const windows = Array.isArray(snapshot.windows) ? snapshot.windows.filter((item) => item && typeof item === 'object') : [];
    const standard = tool.id === 'codex' ? windows.filter((item) => item.limitId === 'codex') : [];
    const duration = (item) => Number.isFinite(item.windowDurationMins) && item.windowDurationMins > 0 ? item.windowDurationMins : Infinity;
    const selected = (standard.length ? standard : windows).slice().sort((a, b) => duration(a) - duration(b))[0];
    const available = typeof selected?.remainingPercent === 'number' ? selected.remainingPercent : typeof selected?.usedPercent === 'number' ? 100 - selected.usedPercent : null;
    const value = Number.isFinite(available) ? Math.max(0, Math.min(100, available)) : null;
    const connected = snapshot.connection === 'connected';
    content.dataset.connection = text(snapshot.connection) || 'loading';
    const amountText = value === null ? '—' : `${Math.round(value)}%`;
    if (amount.textContent !== amountText) amount.textContent = amountText;
    amount.dataset.compact = String(amountText.length > 3);
    fitQuota();
    const quotaLabel = text(selected?.label) || text(selected?.limitId) || tool.name;
    resetAt = Number.isFinite(selected?.resetsAt) && selected.resetsAt > 0 ? selected.resetsAt : null;
    quotaTitle = value === null ? `${tool.name} 额度暂未读取` : `${quotaLabel}剩余额度 ${Math.round(value)}%${connected ? '' : ' · 上次读数，当前离线'}`;
    paintReset();

    const threads = Array.isArray(snapshot.threads) ? snapshot.threads.filter((item) => item && typeof item === 'object') : [];
    const taskConnected = (connected || snapshot.connection === 'waiting' && snapshot.monitoringReady === true) && snapshot.error !== 'tasks_unavailable';
    const threadById = new Map(threads.map((item) => [text(item.id), item]));
    const hydrateProjection = (item) => {
      const raw = threadById.get(text(item?.id));
      if (!raw || (text(item?.turnId) && text(raw.turnId) && item.turnId !== raw.turnId)) return item;
      // Projection membership remains authoritative. Raw task data only fills
      // display metadata such as the observed start time.
      return { ...raw, ...item };
    };
    const hasAttentionProjection = Array.isArray(snapshot.attentionTasks);
    const hasRunningProjection = Array.isArray(snapshot.runningTasks);
    const hasIssueProjection = Array.isArray(snapshot.recentIssueTasks);
    const hasCompletedProjection = Array.isArray(snapshot.recentCompletedTasks);
    const hasLifecycleProjection = hasAttentionProjection && hasRunningProjection
      && hasIssueProjection && hasCompletedProjection;
    const attentionSource = hasAttentionProjection ? snapshot.attentionTasks.map(hydrateProjection) : threads;
    const attentionKeys = new Set();
    const attention = attentionSource.filter((item) => {
      if (!item || item.status !== 'attention' || !['permission', 'input'].includes(item.attentionKind)
        || (!hasAttentionProjection && !taskConnected && item.statusSource !== 'hook')) return false;
      const key = taskKey(item);
      if (attentionKeys.has(key)) return false;
      attentionKeys.add(key);
      return true;
    });
    const runningSource = hasRunningProjection ? snapshot.runningTasks.map(hydrateProjection) : threads;
    const unique = new Set();
    const running = runningSource.filter((item) => {
      if (!item || item.status !== 'running'
        || (!hasRunningProjection && !taskConnected && item.statusSource !== 'hook')) return false;
      const key = taskKey(item);
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    });
    // Confirmed completions remain represented until the main process reports
    // that their own popup has fully disappeared, even when queued behind others.
    for (const item of Array.isArray(snapshot.pendingCompletionTasks) ? snapshot.pendingCompletionTasks : []) {
      if (!item || item.providerId !== tool.id || !text(item.id)) continue;
      if (!running.some((task) => task.id === item.id && task.turnId === item.turnId)) {
        running.push({ ...item, status: 'running', completionPending: true });
      }
    }
    const projects = new Set(running.map((item) => text(item.projectKey) || `session:${taskKey(item)}`)).size;
    const issueKeys = new Set();
    const issues = (hasIssueProjection ? snapshot.recentIssueTasks.map(hydrateProjection) : [])
      .filter((item) => {
        // Closing the code tool or stopping a turn is terminal history, not a
        // request for user action. Keep interruptions in details without an alert.
        if (!item || item.status !== 'failed') return false;
        const key = taskKey(item);
        if (issueKeys.has(key)) return false;
        issueKeys.add(key);
        return true;
      });
    const completedKeys = new Set();
    const completed = (hasCompletedProjection ? snapshot.recentCompletedTasks.map(hydrateProjection) : [])
      .filter((item) => {
        if (!item || item.status !== 'completed') return false;
        const key = taskKey(item);
        if (completedKeys.has(key)) return false;
        completedKeys.add(key);
        return true;
      });
    const priority = attention[0] || issues[0] || null;
    const mode = priority ? 'attention' : running.length ? 'running' : 'mark';
    if (tasks.dataset.mode !== mode) tasks.dataset.mode = mode;
    tasks.dataset.runningCount = String(projects);
    let state;
    if (priority) {
      const item = priority;
      const attentionLabel = item.status === 'attention'
        ? (ATTENTION_LABELS[item.attentionKind] || LABELS.attention)
        : (ATTENTION_LABELS[item.status] || LABELS[item.status] || LABELS.attention);
      state = 'attention';
      tasks.title = `${text(item.title) || '未命名任务'} · ${attentionLabel}`;
      indicator.setAttribute('role', 'img');
      indicator.removeAttribute('aria-valuetext');
      indicator.dataset.attentionKind = item.attentionKind || item.status;
    } else if (running.length) {
      state = 'running';
      tasks.title = running.length === 1
        ? `${text(running[0].title) || '未命名任务'} · ${running[0].completionPending ? '等待完成提醒结束' : '正在运行'}`
        : `${projects} 个项目进行中 · ${running.length} 个任务`;
      indicator.setAttribute('role', 'progressbar');
      indicator.setAttribute('aria-valuetext', `${projects} 个项目进行中，未提供进度百分比`);
      delete indicator.dataset.attentionKind;
    } else {
      // Older installed readers can publish empty activity projections while a
      // thread is still unresolved. That is unknown, not confirmed idle.
      const uncertain = hasLifecycleProjection && snapshot.taskActivityKnown !== true
        ? threads.find((item) => item.status === 'unknown') : null;
      const item = uncertain || completed[0] || (!hasLifecycleProjection ? threads[0] : null);
      const reported = uncertain ? 'unknown' : completed.length ? 'completed'
        : item && (taskConnected || item.statusSource === 'hook') ? item.status
          : hasLifecycleProjection && taskConnected ? 'idle' : 'unknown';
      state = Object.hasOwn(LABELS, reported) ? reported : 'unknown';
      tasks.title = item ? `${text(item.title) || '未命名任务'} · ${LABELS[state]}`
        : state === 'idle' ? '暂无运行中的任务 · 空闲' : '暂无可确认的任务，状态待同步';
      if (state === 'unknown' && !taskConnected) tasks.title = connected ? '任务状态暂未获取，状态待同步' : '任务状态未连接，状态待同步';
      indicator.setAttribute('role', 'img');
      indicator.removeAttribute('aria-valuetext');
      delete indicator.dataset.attentionKind;
    }
    projectCount.hidden = state === 'attention' && projects === 0;
    // The corner counts observed projects. A connected reader can still be
    // synchronizing historical tasks after a tool switch; keep its empty mark
    // stable without changing the unknown task state into confirmed idle.
    const emptyProjectMark = projects === 0 && (['idle', 'completed'].includes(state)
      || state === 'unknown' && taskConnected);
    projectCount.dataset.idle = String(emptyProjectMark);
    projectCount.textContent = projects > 0 ? (projects > 99 ? '99+' : String(projects))
      : projectCount.dataset.idle === 'true' ? '°' : '—';
    projectCount.title = projects > 0 ? `${projects} 个项目（完成提醒结束后减去对应项目）`
      : emptyProjectMark ? (state === 'unknown' ? '暂无已确认的运行项目 · 任务状态待同步' : '暂无运行中的项目') : '任务状态待同步';
    // One permanent indicator represents the whole running set. Keep the same
    // node and running style while counts, titles, order or quota are updated.
    if (indicator.dataset.status !== state) indicator.dataset.status = state;
    indicator.title = tasks.title;
    indicator.setAttribute('aria-label', tasks.title);
    const summary = `${quota.title}；${tasks.title}`;
    content.setAttribute('aria-label', summary);
    root.setAttribute('aria-description', summary);
    root.title = `${summary}。点击展开悬浮岛`;

    const primary = priority || running[0] || (state === 'unknown' ? threads.find((item) => item.status === 'unknown') : null)
      || completed[0] || (!hasLifecycleProjection ? threads[0] : null) || null;
    previewModel = {
      title: text(primary?.title) || ((attention.length || running.length) ? '未命名任务' : '暂无运行中的任务'),
      state,
      attentionKind: state === 'attention'
        ? (primary?.attentionKind || (primary?.status === 'interrupted' ? 'interrupted' : 'failed')) : null,
      startedAt: state === 'running' && Number.isFinite(primary?.turnStartedAt) ? primary.turnStartedAt : null,
      extra: state === 'attention' ? Math.max(0, attention.length + issues.length + running.length - 1) : Math.max(0, running.length - 1),
    };
    paintPreview();
    syncPreviewTimer();
  }

  render();
  (window.AITools?.onStatus || api.onCodexFloatStatus)?.((snapshot) => { revision++; render(snapshot); });
  const startedAt = revision;
  Promise.resolve((window.AITools?.getStatus || api.getCodexFloatStatus)?.()).then((snapshot) => { if (revision === startedAt) render(snapshot || {}); }).catch(() => {});
  document.addEventListener('notch:previewchange', (event) => setPreviewVisible(event.detail?.visible));
  window.CodexNotch = Object.freeze({ render, setPreviewVisible });
})();
