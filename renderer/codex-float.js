(() => {
  'use strict';

  const STATES = { loading: '正在连接', connected: '已连接', stale: '离线 · 保留上次数据', unavailable: '暂未连接' };
  const ERRORS = { cli_not_found: '未找到 Codex，请先安装客户端', connection_failed: '无法连接 Codex', request_timeout: '连接超时，请刷新重试', request_failed: '暂时无法读取额度', invalid_response: '暂未收到有效额度数据', tasks_unavailable: '暂时无法读取最近任务', stopped: '连接已停止' };
  const TASK_STATES = { running: '进行中', attention: '等待确认', idle: '待继续', completed: '已完成', failed: '需关注', interrupted: '已中断', unknown: '状态未知' };
  const TASK_GROUPS = [
    { key: 'attention', label: '需处理', projections: [['attentionTasks', 'attention'], ['recentIssueTasks', null]], statuses: new Set(['attention', 'failed', 'interrupted']), empty: '暂无待处理' },
    { key: 'running', label: '运行中', projections: [['runningTasks', 'running']], statuses: new Set(['running']), empty: '没有任务' },
    { key: 'completed', label: '最近完成', projections: [['recentCompletedTasks', 'completed']], statuses: new Set(['completed']), empty: '暂无记录' },
  ];
  const TASK_PROJECTIONS = ['attentionTasks', 'recentIssueTasks', 'runningTasks', 'recentCompletedTasks'];
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const percent = (value) => number(value) === null ? null : Math.max(0, Math.min(100, value));
  const list = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    return element;
  };
  const button = (label, action, className = '') => {
    const element = node('button', className, label);
    element.type = 'button';
    element.dataset.codexAction = action;
    return element;
  };
  const timestamp = (value, fallback = '时间未知') => {
    const parsed = number(value);
    if (parsed === null || !Number.isFinite(new Date(parsed).getTime())) return fallback;
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(parsed));
  };
  const remaining = (item) => {
    const value = percent(item.remainingPercent);
    const used = percent(item.usedPercent);
    return value !== null ? value : used === null ? null : 100 - used;
  };
  const windowLabel = (item) => {
    if (text(item.label)) return text(item.label);
    const minutes = number(item.windowDurationMins);
    if (minutes === null) return '额度窗口';
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} 天额度`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} 小时额度`;
    return `${minutes} 分钟额度`;
  };

  function create(root, options = {}) {
    if (!root) return null;
    const compact = options.compact === true;
    const api = () => window.notchAPI || {};
    let active = false;
    let revision = 0;
    let busy = false;
    let snapshot = { connection: 'loading', windows: [], resets: {}, threads: [], credits: {},
      attentionTasks: [], recentIssueTasks: [], runningTasks: [], recentCompletedTasks: [] };
    let returnFocus = null;
    let destroyed = false;
    let countdownTimer;
    let toolUI = null;

    root.classList.add('codex-float');
    root.dataset.compact = String(compact);
    root.dataset.active = 'false';
    const header = node('div', 'codex-head');
    const brand = button('', 'open', 'codex-brand');
    const glyph = node('span', 'codex-mark', '›_');
    glyph.setAttribute('aria-hidden', 'true');
    const brandLabel = node('span', 'codex-brand-label', 'Codex');
    brand.append(glyph, brandLabel);
    brand.setAttribute('aria-label', '打开 Codex');
    brand.title = '打开 Codex';
    const connection = node('span', 'codex-connection');
    const refresh = button('↻', 'refresh', 'codex-refresh');
    refresh.title = '刷新 Codex 额度';
    refresh.setAttribute('aria-label', '刷新 Codex 额度');
    header.append(brand, connection, refresh);
    const quotas = node('div', 'codex-quotas');
    const recent = node('div', 'codex-priority');
    const footer = node('div', 'codex-footer');
    const resetSummary = node('span', 'codex-reset-summary');
    const details = button('详情 ↗', 'details', 'codex-details-button');
    details.setAttribute('aria-label', '查看 Codex 额度、Reset 与最近任务');
    footer.append(resetSummary, details);
    root.append(header, quotas, recent, footer);

    const dialog = node('dialog', `codex-dialog${compact ? ' codex-dialog-compact' : ''}`);
    dialog.setAttribute('aria-label', 'Codex 额度与最近任务');
    const dialogHead = node('header', 'codex-dialog-head');
    const dialogTitle = node('strong', '', 'CodexFloat');
    const dialogStatus = node('span', 'codex-dialog-status');
    const close = button('关闭', 'close', 'codex-close');
    close.setAttribute('aria-label', '关闭 Codex 详情');
    dialogHead.append(dialogTitle, dialogStatus, close);
    const columns = node('div', 'codex-dialog-columns');
    dialog.append(dialogHead, columns);
    document.body.append(dialog);

    function quota(item, detailed = false) {
      const value = remaining(item);
      const row = node('div', 'codex-quota');
      row.dataset.level = value === null ? 'unknown' : value <= 10 ? 'critical' : value <= 30 ? 'warning' : 'healthy';
      const label = node('div', 'codex-quota-label');
      const name = node('span', '', windowLabel(item));
      name.title = windowLabel(item);
      const nameGroup = node('span', 'codex-quota-name');
      nameGroup.append(name);
      const resetsAt = number(item.resetsAt);
      if (resetsAt !== null) {
        const countdown = node('small', 'codex-countdown');
        countdown.dataset.codexResetAt = String(resetsAt);
        countdown.title = `${timestamp(resetsAt)} 重置`;
        nameGroup.append(countdown);
      }
      label.append(nameGroup, node('strong', '', value === null ? '未知' : `${Math.round(value)}% 剩余`));
      const track = node('div', 'codex-track');
      track.setAttribute('role', 'meter');
      track.setAttribute('aria-label', `${windowLabel(item)}剩余额度`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      if (value !== null) track.setAttribute('aria-valuenow', String(value));
      track.setAttribute('aria-valuetext', value === null ? '未知' : `${Math.round(value)}% 剩余`);
      const fill = node('i');
      fill.style.width = value === null ? '0%' : `${value}%`;
      track.append(fill);
      row.append(label, track);
      if (detailed) {
        const renewal = number(item.resetsAt) === null ? '重置时间未知' : `${timestamp(item.resetsAt)} 重置`;
        row.append(node('small', 'codex-renewal', renewal));
        const bucket = [text(item.limitId), text(item.planType)].filter(Boolean).join(' · ');
        if (bucket) row.append(node('small', 'codex-renewal', bucket));
      }
      return row;
    }

    function task(item) {
      const title = text(item.title) || '未命名任务';
      const state = TASK_STATES[item.status] ? item.status : 'unknown';
      const entry = button('', 'thread', 'codex-thread');
      entry.dataset.threadId = text(item.id);
      entry.dataset.status = state;
      entry.disabled = !entry.dataset.threadId || busy;
      const description = state === 'unknown' && item.statusReason === 'history_older_than_task'
        ? '任务记录尚未同步，暂无法确认状态'
        : state === 'attention' && item.attentionKind === 'permission' ? '等待权限确认'
          : state === 'attention' && item.attentionKind === 'input' ? '等待你的输入' : TASK_STATES[state];
      entry.title = `${title} · ${description}`;
      entry.setAttribute('aria-label', entry.title);
      const dot = node('i', 'codex-task-dot');
      dot.setAttribute('aria-hidden', 'true');
      const copy = node('span', 'codex-thread-title', title);
      const status = node('small', 'codex-thread-state', state === 'attention' ? description : TASK_STATES[state]);
      entry.append(dot, copy, status);
      return entry;
    }

    function taskTime(item) {
      return number(item.completedAt) ?? number(item.turnCompletedAt) ?? number(item.statusRecordedAt)
        ?? number(item.updatedAt) ?? number(item.turnStartedAt) ?? 0;
    }

    function groupedTasks(items = list(snapshot.threads)) {
      const usesProjections = TASK_PROJECTIONS.every((key) => Array.isArray(snapshot[key]));
      const ordered = [...items].sort((left, right) => taskTime(right) - taskTime(left));
      return TASK_GROUPS.map((group) => ({
        ...group,
        items: usesProjections
          ? group.projections.flatMap(([projection, status]) => list(snapshot[projection])
            .map((item) => ({ ...item, ...(status ? { status } : {}) })))
          : ordered.filter((item) => group.statuses.has(item.status)),
      }));
    }

    function limitTaskGroups(groups, maximum = 8) {
      let remaining = maximum;
      return groups.map((group) => {
        const totalCount = group.items.length;
        const items = group.items.slice(0, Math.max(0, remaining));
        remaining -= items.length;
        return { ...group, totalCount, items };
      });
    }

    function taskGroup(group, { detailed = false } = {}) {
      const section = node(detailed ? 'section' : 'div', detailed ? 'codex-detail-task-group' : 'codex-task-group');
      section.dataset.taskGroup = group.key;
      const heading = node(detailed ? 'h4' : 'div', 'codex-task-group-head');
      heading.append(node('span', '', group.label));
      const count = Number.isInteger(group.totalCount) ? group.totalCount : group.items.length;
      if (count) heading.append(node('small', '', String(count)));
      section.append(heading);
      if (!group.items.length) {
        section.append(node('span', 'codex-task-group-empty', count > 0 ? `另有 ${count} 项` : group.empty));
        return section;
      }
      const visible = detailed ? group.items : group.items.slice(0, 1);
      visible.forEach((item) => section.append(task(item)));
      return section;
    }

    function renderDetails() {
      const priorScroll = [...columns.querySelectorAll('.codex-detail-section')].map((section) => section.scrollTop);
      const activeControl = columns.contains(document.activeElement)
        ? document.activeElement.closest?.('[data-codex-action]') : null;
      const activeIdentity = activeControl ? {
        action: activeControl.dataset.codexAction,
        threadId: activeControl.dataset.threadId || '',
      } : null;
      dialogStatus.textContent = snapshot.updatedAt ? `${STATES[snapshot.connection]} · 上次更新 ${timestamp(snapshot.updatedAt)}` : STATES[snapshot.connection];
      const limitColumn = node('section', 'codex-detail-section');
      limitColumn.append(node('h3', '', '使用额度'));
      const windows = list(snapshot.windows);
      if (windows.length) windows.forEach((item) => limitColumn.append(quota(item, true)));
      else limitColumn.append(node('p', 'codex-empty', '暂未读取到额度。请打开 Codex 并登录后刷新。'));
      const credits = snapshot.credits || {};
      const creditText = credits.unlimited === true ? '积分：不限额' : text(credits.balance) ? `积分余额：${text(credits.balance)}` : credits.hasCredits === false ? '暂无额外积分' : '积分余额未知';
      limitColumn.append(node('p', 'codex-credit', creditText));

      const resetColumn = node('section', 'codex-detail-section');
      resetColumn.append(node('h3', '', 'Reset 额度重置'));
      const available = number(snapshot.resets?.available);
      resetColumn.append(node('p', 'codex-reset-total', available === null ? '可用次数未知' : `${Math.max(0, Math.floor(available))} 次可用`));
      const resets = list(snapshot.resets?.items);
      resets.forEach((item) => {
        const row = node('div', 'codex-reset-item');
        row.append(node('strong', '', text(item.title) || '额度重置'), node('p', '', text(item.description)));
        if (number(item.expiresAt) !== null) row.append(node('small', '', `${timestamp(item.expiresAt)} 到期`));
        resetColumn.append(row);
      });
      resetColumn.append(node('p', 'codex-reset-note', '仅展示可用次数，使用请前往 Codex。'));

      const threadColumn = node('section', 'codex-detail-section');
      threadColumn.append(node('h3', '', '最近任务'));
      const threads = list(snapshot.threads);
      const groups = limitTaskGroups(groupedTasks(threads));
      const representedIds = new Set(groups.flatMap((group) => group.items).map((item) => text(item.id)).filter(Boolean));
      const groupedStatuses = new Set(TASK_GROUPS.flatMap((group) => [...group.statuses]));
      if (threads.length || groups.some((group) => group.items.length)) {
        groups.forEach((group) => threadColumn.append(taskGroup(group, { detailed: true })));
        const displayed = groups.reduce((total, group) => total + group.items.length, 0);
        const other = threads.filter((item) => item.notificationEligible !== false
          && !representedIds.has(text(item.id)) && !groupedStatuses.has(item.status))
          .slice(0, Math.max(0, 8 - displayed));
        if (other.length) {
          const otherGroup = { key: 'other', label: '待继续', items: other };
          threadColumn.append(taskGroup(otherGroup, { detailed: true }));
        }
      } else threadColumn.append(node('p', 'codex-empty', '暂无可显示的本机任务'));
      const openApp = button('打开 Codex ↗', 'open', 'codex-open-app');
      openApp.disabled = busy;
      threadColumn.append(openApp);
      columns.replaceChildren(limitColumn, resetColumn, threadColumn);
      if (activeIdentity) {
        const restored = [...columns.querySelectorAll('[data-codex-action]')].find((control) =>
          control.dataset.codexAction === activeIdentity.action
            && (control.dataset.threadId || '') === activeIdentity.threadId) || openApp;
        restored.focus({ preventScroll: true });
      }
      [...columns.querySelectorAll('.codex-detail-section')].forEach((section, index) => {
        section.scrollTop = priorScroll[index] || 0;
      });
      tickCountdowns();
    }

    function paint() {
      if (window.AITools && window.AITools.currentTool().id !== 'codex') return;
      const state = STATES[snapshot.connection] ? snapshot.connection : 'unavailable';
      root.dataset.connection = state;
      connection.textContent = state === 'connected' ? '已连接' : state === 'loading' ? '连接中' : '离线';
      connection.title = `${STATES[state]}${snapshot.updatedAt ? ` · 上次更新 ${timestamp(snapshot.updatedAt)}` : ''}${text(snapshot.error) ? ` · ${ERRORS[snapshot.error] || '连接暂不可用，请重试'}` : ''}`;
      connection.setAttribute('aria-label', connection.title);
      const windows = list(snapshot.windows);
      quotas.replaceChildren();
      const standardWindows = windows.filter((item) => item.limitId === 'codex');
      const overviewWindows = standardWindows.length ? standardWindows : windows;
      if (overviewWindows.length) overviewWindows.slice(0, 2).forEach((item) => {
        const label = standardWindows.length ? windowLabel(item) : `${text(item.limitId) || '其他额度'} · ${windowLabel(item)}`;
        quotas.append(quota({ ...item, label }));
      });
      else {
        quotas.append(node('p', 'codex-empty', state === 'loading' ? '正在读取 Codex 额度…' : '打开 Codex 并登录后刷新额度'));
        quotas.append(node('span', 'codex-unavailable-value', '额度未知'));
      }
      const resets = number(snapshot.resets?.available);
      resetSummary.textContent = resets === null ? 'Reset · 未知' : `Reset · ${Math.max(0, Math.floor(resets))} 次`;
      resetSummary.title = '可用额度重置次数；这里不会消耗重置次数';
      recent.replaceChildren();
      const tasks = list(snapshot.threads);
      if (compact) {
        const first = tasks[0];
        if (first) recent.append(task(first));
        else recent.append(node('span', 'codex-no-tasks', '暂无最近任务'));
      } else {
        const groups = groupedTasks(tasks);
        const primaryIndex = groups.findIndex((group) => group.items.length > 0);
        groups.forEach((group, index) => {
          const element = taskGroup(group);
          element.dataset.primary = String(index === primaryIndex);
          recent.append(element);
        });
      }
      root.querySelectorAll('[data-codex-action]').forEach((item) => { item.disabled = busy; });
      root.querySelectorAll('[data-codex-action="thread"]').forEach((item) => { item.disabled = busy || !item.dataset.threadId; });
      refresh.dataset.busy = String(busy);
      root.setAttribute('aria-busy', String(busy));
      if (dialog.open) renderDetails();
      tickCountdowns();
    }

    function tickCountdowns() {
      for (const area of [root, dialog]) {
        area.querySelectorAll('[data-codex-reset-at]').forEach((element) => {
          const minutes = Math.max(0, Math.ceil((Number(element.dataset.codexResetAt) - Date.now()) / 60000));
          const days = Math.floor(minutes / 1440);
          const hours = Math.floor(minutes / 60) % 24;
          const value = minutes === 0 ? '待刷新' : days > 0 ? `${days}天${hours}时后重置`
            : hours > 0 ? `${hours}时${minutes % 60}分后重置` : `${minutes}分后重置`;
          if (element.textContent !== value) element.textContent = value;
        });
      }
    }

    function accept(value) {
      if (window.AITools && (window.AITools.currentTool().id !== 'codex' || value?.providerId !== 'codex')) return;
      if (!value || typeof value !== 'object') return;
      revision++;
      snapshot = { ...value, connection: STATES[value.connection] ? value.connection : 'unavailable' };
      if (active) paint();
    }

    function fail(message) {
      snapshot = { ...snapshot, connection: snapshot.updatedAt ? 'stale' : 'unavailable', error: message };
      paint();
      options.notify?.(message);
    }

    async function read(manual = false) {
      if (window.AITools && window.AITools.currentTool().id !== 'codex') return;
      if (!active || busy || destroyed) return;
      const token = ++revision;
      if (manual) { busy = true; paint(); }
      try {
        const reader = manual ? api().refreshCodexFloat : api().getCodexFloatStatus;
        if (typeof reader !== 'function') throw new Error('Codex 连接暂不可用，请重试');
        const value = await reader();
        if (!active || destroyed || token !== revision) return;
        if (!value || typeof value !== 'object') throw new Error('暂未读取到 Codex 数据');
        accept(value);
      } catch (_) {
        if (active && !destroyed && token === revision) fail('暂时无法连接 Codex，请打开 Codex 后刷新');
      } finally {
        if (manual) { busy = false; if (active && !destroyed) paint(); }
      }
    }

    function closeDetails(restoreFocus = true) {
      const toolWasOpen = toolUI?.close(restoreFocus) === true;
      const wasOpen = dialog.open;
      if (wasOpen) dialog.close();
      if (restoreFocus && active && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
      return wasOpen || toolWasOpen;
    }

    async function act(event) {
      const control = event.target.closest('[data-codex-action]');
      if (!control || !active || event.defaultPrevented || root.closest('.is-dragging')) return;
      event.stopPropagation();
      const action = control.dataset.codexAction;
      if (action === 'close') { closeDetails(); return; }
      if (action === 'details') {
        returnFocus = control;
        options.onDetails?.();
        renderDetails();
        dialog.showModal();
        close.focus({ preventScroll: true });
        return;
      }
      if (busy) return;
      if (action === 'refresh') { await read(true); return; }
      busy = true;
      paint();
      try {
        const result = action === 'thread' ? await api().openCodexThread?.(control.dataset.threadId) : await api().openCodexApp?.();
        if (result?.ok !== true && active) options.notify?.('暂时无法打开 Codex，请确认已安装客户端');
      } catch (_) {
        if (active) options.notify?.('暂时无法打开 Codex，请重试');
      } finally {
        busy = false;
        if (active) paint();
      }
    }

    function onKey(event) {
      if (event.key !== 'Escape' || !dialog.open) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeDetails();
    }
    root.addEventListener('click', act);
    dialog.addEventListener('click', act);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDetails(); });
    document.addEventListener('keydown', onKey, true);
    const unsubscribe = (window.AITools?.onStatus || api().onCodexFloatStatus)?.(accept);
    toolUI = window.AITools?.attachCard(root, {
      notify: options.notify, onOpen: options.onDetails,
      onToolChange(id) {
        if (dialog.open) dialog.close();
        revision++; snapshot = { connection: 'loading', windows: [], threads: [] };
        if (id === 'codex') queueMicrotask(() => { paint(); void read(); });
      },
    });
    paint();
    return Object.freeze({
      setActive(value) {
        const next = value === true;
        if (active === next) return;
        active = next;
        toolUI?.setActive(active);
        root.dataset.active = String(active);
        revision++;
        clearInterval(countdownTimer);
        if (active) { paint(); read(); countdownTimer = setInterval(tickCountdowns, 30000); }
        else { closeDetails(false); }
      },
      refresh: () => read(),
      closeDetails,
      hasOpenDetails: () => dialog.open || toolUI?.isOpen() === true,
      destroy() {
        destroyed = true;
        toolUI?.destroy();
        clearInterval(countdownTimer);
        active = false;
        revision++;
        closeDetails(false);
        dialog.remove();
        root.removeEventListener('click', act);
        document.removeEventListener('keydown', onKey, true);
        if (typeof unsubscribe === 'function') unsubscribe();
      },
    });
  }

  window.CodexFloatCard = Object.freeze({ create });
})();
