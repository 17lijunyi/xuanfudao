(() => {
  'use strict';
  const api = window.notchAPI || {};
  const unselected = { id: '', name: '选择code工具', icon: 'assets/codex-mark.svg', monitoring: 'unavailable' };
  let model = { revision: -1, catalog: [], needsSetup: true, state: { selected: null, confirmed: false } };
  let latest = { providerId: null, connection: 'unselected', windows: [], threads: [] };
  let statusRevision = 0;
  let pending = false;
  let closeOpenPicker = null;
  const listeners = new Set();
  const statusListeners = new Set();
  const currentTool = () => model.state.confirmed ? model.catalog.find((tool) => tool.id === model.state.selected) || unselected : unselected;
  const status = () => latest.providerId === model.state.selected && latest.selectionRevision === model.revision ? latest
    : { providerId: model.state.selected, connection: model.state.confirmed ? 'loading' : 'unselected', windows: [], threads: [], runningTasks: [], attentionTasks: [], recentCompletedTasks: [], recentIssueTasks: [] };
  const publishStatus = () => statusListeners.forEach((listener) => listener(status()));
  const publish = () => listeners.forEach((listener) => listener(model));
  function acceptStatus(value) {
    if (!value || value.providerId !== model.state.selected || value.selectionRevision !== model.revision) return false;
    latest = value; statusRevision++; publishStatus(); return true;
  }
  async function readStatus() {
    await ready;
    const token = statusRevision;
    try { const value = await api.getAICodeStatus?.(); if (token === statusRevision) acceptStatus(value); } catch (_) {}
    return status();
  }
  function accept(value) {
    if (!value?.ok || !Array.isArray(value.catalog) || !value.state || value.revision < model.revision
      || value.state.confirmed && !value.catalog.some((tool) => tool.id === value.state.selected)) return false;
    const changed = value.state.selected !== model.state.selected || value.revision !== model.revision;
    model = value;
    if (changed) latest = { providerId: null, connection: 'unselected', windows: [], threads: [] };
    publish(); publishStatus();
    if (changed) queueMicrotask(() => { void readStatus(); });
    return true;
  }
  api.onAIToolsChanged?.(accept);
  api.onAICodeStatus?.(acceptStatus);
  const ready = Promise.resolve(api.getAITools?.()).then(accept).catch(() => false);
  const messages = {
    confirmation_required: '请先确认使用这款工具', invalid_tool: '这个工具暂不可用，请重新打开列表',
    settings_unavailable: '工具设置暂时无法读取，请重新打开悬浮岛', save_failed: '保存失败，原来的选择已保留，请重试',
    config_unavailable: '暂时无法更新工具配置，原配置已保留', config_changed: '工具配置刚被修改，请重试',
    hooks_disabled: '这款工具已关闭 Hook，请在工具内启用后再连接', not_installed: '未检测到这款工具，请安装后重新检测',
    unsupported: '这款工具的任务监测暂未接入',
    runtime_unavailable: '监测程序无法运行，请重新安装悬浮岛后再连接',
  };
  const connectionText = { unselected: '未选择', loading: '检测中', not_installed: '未检测到', not_connected: '待连接', unsupported: '监测未接入', waiting: '等待验证', connected: '已收到事件', unavailable: '读取失败' };
  const stateText = { running: '进行中', attention: '等待授权', completed: '已完成', interrupted: '已中断', failed: '失败', unknown: '状态未知' };
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const button = (text, action, className = '') => { const el = node('button', className, text); el.type = 'button'; el.dataset.aiAction = action; return el; };
  function icon(tool) { const el = node('img', 'ai-tool-icon'); el.src = tool.icon; el.alt = ''; el.draggable = false; return el; }

  function attachCard(root, options = {}) {
    const codexBrand = root.querySelector('.codex-brand');
    if (!codexBrand) return null;
    let active = false, destroyed = false, candidate = null, operation = 0, pickerOpen = false;
    const pageHost = document.getElementById('code-list-page');
    let mounted = 'codex', lastTool = null, connectionBusy = false;
    codexBrand.append(node('span', 'ai-switch-chevron', '⌄'));
    codexBrand.title = 'code列表'; codexBrand.setAttribute('aria-label', '当前工具 Codex，打开工作台 code列表');

    // Store the entire original card, including legacy .codex-recent nodes.
    // Only one provider's content is ever attached to the visible root.
    const codexNodes = [...root.childNodes];
    const generic = node('section', 'ai-provider-card');
    const head = node('div', 'ai-provider-head');
    const brand = button('', 'switch', 'ai-provider-brand'); brand.title = 'code列表';
    const connection = node('span', 'ai-provider-connection');
    head.append(brand, connection);
    const quota = node('div', 'ai-provider-quota'); quota.append(node('span', '', '剩余额度'), node('strong', '', '—'));
    const body = node('div', 'ai-provider-body');
    const hint = node('p', 'ai-provider-hint');
    const tasks = node('div', 'ai-provider-tasks'); body.append(hint, tasks);
    const actions = node('div', 'ai-provider-actions');
    const detect = button('重新检测', 'detect');
    const connect = button('连接任务监测', 'connect'); actions.append(detect, connect);
    const genericFooter = node('div', 'ai-provider-footer');
    genericFooter.append(button('前往官网 ↗', 'website', 'ai-tool-website'));
    generic.append(head, quota, body, actions, genericFooter);
    const dialog = node('div', 'ai-tools-page');
    dialog.hidden = true;
    dialog.setAttribute('aria-label', 'code列表');
    const header = node('header', 'ai-tools-header');
    const title = node('strong', '', 'code列表');
    const search = node('input', 'ai-tools-search'); search.type = 'search'; search.placeholder = '搜索工具'; search.setAttribute('aria-label', '搜索 code 工具');
    const closeButton = button('关闭', 'close', 'ai-tools-close'); header.append(title, search, closeButton);
    const instruction = node('p', 'ai-tools-instruction', '选择一款你使用的工具，确认后才开始检测');
    const list = node('div', 'ai-tools-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', '当前 code 工具，只能选择一款');
    const confirmation = node('section', 'ai-tools-confirm'); confirmation.hidden = true;
    const question = node('strong', 'ai-tools-question');
    const explain = node('p', '', '确认后，仅检测并连接这款工具。未安装时显示空状态。');
    const confirmationActions = node('div', 'ai-tools-confirm-actions');
    const confirm = button('是，我使用 · 开始检测', 'confirm', 'ai-confirm-primary');
    confirmationActions.append(button('返回选择', 'back'), confirm);
    confirmation.append(question, explain, confirmationActions);
    const feedback = node('p', 'ai-tools-feedback'); feedback.setAttribute('role', 'status');
    const selectedSetup = node('section', 'ai-tools-setup');
    const setupHint = node('p', 'ai-provider-hint'); setupHint.setAttribute('role', 'status');
    const setupConnect = button('连接任务监测', 'connect');
    selectedSetup.append(setupHint, setupConnect); selectedSetup.hidden = true;
    dialog.append(header, instruction, list, confirmation, selectedSetup, feedback); pageHost?.append(dialog);

    function paintList() {
      if (!pickerOpen) return;
      const motionOptions = { selector: '.ai-tool-row, .ai-tools-confirm', spatial: true };
      const source = window.cardReflow?.capture(dialog, motionOptions);
      title.textContent = model.needsSetup ? 'code列表 · 选择你使用的工具' : 'code列表';
      closeButton.textContent = '返回工作台';
      search.hidden = !!candidate; instruction.hidden = !!candidate; list.hidden = !!candidate; confirmation.hidden = !candidate;
      selectedSetup.hidden = !!candidate || !currentTool().id || currentTool().id === 'codex';
      confirm.disabled = pending;
      dialog.querySelector('[data-ai-action="back"]').disabled = pending;
      if (candidate) {
        selectedSetup.hidden = true;
        question.replaceChildren(icon(candidate), node('span', '', `你是否使用 ${candidate.name}？`));
        explain.textContent = candidate.monitoring === 'unavailable'
          ? `${candidate.monitoringNote || '任务监测暂未接入'}。确认后仅检查安装情况。`
          : candidate.monitoring === 'hooks' ? '确认后检查安装情况；还需点击「连接任务监测」，在工具内按提示启用并开始新任务，收到真实事件才算连接成功。额度暂无数据。'
            : '确认后仅检测并连接 Codex。未安装或未登录时显示空状态。';
        void window.cardReflow?.play(source, dialog, motionOptions);
        return;
      }
      const focusId = document.activeElement?.dataset.aiId, scroll = list.scrollTop;
      const query = search.value.trim().toLocaleLowerCase();
      const entries = model.catalog.filter((tool) => `${tool.name} ${tool.description} ${tool.id}`.toLocaleLowerCase().includes(query))
        .sort((a, b) => Number(b.id === currentTool().id) - Number(a.id === currentTool().id)).map((tool) => {
        const selected = currentTool().id === tool.id;
        const row = button('', 'choose', 'ai-tool-row'); row.dataset.aiId = tool.id;
        row.setAttribute('role', 'radio'); row.setAttribute('aria-checked', String(selected)); row.disabled = pending;
        row.dataset.selected = String(selected);
        const copy = node('span', 'ai-tool-copy');
        copy.append(node('strong', '', tool.name), node('small', '', tool.monitoring === 'unavailable' ? '任务监测未接入' : tool.monitoring === 'hooks' ? '任务监测需连接并验证' : tool.description));
        row.title = tool.monitoringNote || tool.description;
        const radio = node('span', 'ai-tool-radio'); radio.setAttribute('aria-hidden', 'true');
        row.append(icon(tool), copy, radio); return row;
      });
      list.replaceChildren(...entries.length ? entries : [node('p', 'ai-tools-no-results', '没有匹配的工具')]);
      list.scrollTop = scroll;
      if (focusId) list.querySelector(`[data-ai-id="${focusId}"]`)?.focus({ preventScroll: true });
      void window.cardReflow?.play(source, dialog, motionOptions);
    }
    function paintStatus() {
      selectedSetup.hidden = !!candidate || !currentTool().id || currentTool().id === 'codex';
      if (destroyed || currentTool().id === 'codex') return;
      const tool = currentTool(), value = status(), state = value.connection;
      root.dataset.connection = state || 'unselected';
      connection.textContent = connectionText[state] || '未连接';
      quota.hidden = !tool.id;
      const descriptions = {
        unselected: '先选择你使用的 code 工具', loading: `正在检测 ${tool.name}…`,
        not_installed: `未检测到 ${tool.name}，暂无额度或任务`,
        not_connected: '点击连接后会配置任务监测，再按工具提示启用', unsupported: tool.monitoringNote || '该工具的任务监测暂未接入',
        waiting: `配置已写入；请重启 ${tool.name}，按提示启用监测，再开始新任务。尚未收到事件。`,
        connected: '已收到真实任务事件；额度暂无数据', unavailable: '暂时无法读取，请重新检测',
      };
      hint.textContent = messages[value.error] || descriptions[state] || '暂无任务';
      if (state === 'connected' && value.lastEventAt) hint.textContent += `（最近 ${new Date(value.lastEventAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）`;
      tasks.replaceChildren(...(value.threads || []).filter((item) => item.providerId === tool.id).slice(0, 3).map((item) => {
        const row = node('div', 'ai-provider-task'); row.dataset.status = item.status;
        const name = node('span', '', item.title); name.title = item.title;
        row.append(name, node('small', '', stateText[item.status] || '状态未知')); return row;
      }));
      detect.hidden = !tool.id; detect.disabled = connectionBusy || state === 'loading';
      connect.hidden = !(tool.monitoring === 'hooks' && value.installed);
      connect.textContent = value.monitoringReady ? '修复连接' : '连接任务监测';
      connect.disabled = connectionBusy;
      setupHint.textContent = `${tool.name} · ${connectionText[state] || '检测中'}：${hint.textContent}`;
      setupConnect.hidden = connect.hidden; setupConnect.disabled = connect.disabled;
      setupConnect.textContent = connect.textContent;
      genericFooter.querySelector('[data-ai-action="website"]').hidden = !tool.id;
    }
    function paint() {
      if (destroyed) return;
      const tool = currentTool(), id = tool.id;
      if (lastTool !== id) { options.onToolChange?.(id); lastTool = id; }
      root.dataset.aiTool = id;
      const target = id === 'codex' ? 'codex' : 'generic';
      if (mounted !== target) { root.replaceChildren(...(target === 'codex' ? codexNodes : [generic])); mounted = target; }
      brand.replaceChildren(...(id ? [icon(tool)] : []), node('span', '', tool.name), node('span', 'ai-switch-chevron', '⌄'));
      brand.setAttribute('aria-label', id ? `当前工具 ${tool.name}，打开工作台 code列表` : '打开工作台选择code工具');
      paintStatus(); paintList();

    }
    // A code page is part of the workspace, not a modal on the quick island.
    // Escape cancels the confirmation first; outside it, normal workspace Escape applies.
    function close() {
      if (!pickerOpen || !candidate) return false;
      candidate = null; operation++; feedback.textContent = ''; paintList();
      search.focus({ preventScroll: true });
      return true;
    }
    async function open() {
      try {
        const result = await api.openIslandWorkspace?.('codes', window.islandCardMotion?.capture());
        if (result?.ok === false) throw Error('navigation_failed');
      } catch (_) { options.notify?.('暂时无法打开 code列表，请重试'); }
    }
    function syncPage(event) {
      if (!pageHost) return;
      const expanded = document.getElementById('app')?.classList.contains('expanded');
      const visible = expanded && pageHost.closest('.tab-panel')?.classList.contains('active');
      if (visible === pickerOpen) return;
      pickerOpen = visible;
      dialog.hidden = !visible;
      candidate = null; operation++; feedback.textContent = ''; search.value = '';
      if (visible) {
        closeOpenPicker = close; paintList();
        if (model.error) feedback.textContent = messages[model.error];
      } else if (closeOpenPicker === close) closeOpenPicker = null;
    }
    async function commit() {
      if (!candidate || pending) return;
      const id = candidate.id, token = ++operation;
      pending = true; publish(); feedback.textContent = '';
      try {
        const result = await api.updateAITools?.({ action: 'select', id, confirmed: true });
        if (!accept(result)) throw Error(result?.error || 'save_failed');
        if (!destroyed && token === operation) {
          candidate = null; paintList();
          feedback.textContent = `当前使用 ${currentTool().name}，选择已保存`;
          list.querySelector(`[data-ai-id="${id}"]`)?.focus({ preventScroll: true });
        }
      } catch (error) { if (!destroyed && pickerOpen) feedback.textContent = messages[error.message] || messages.save_failed; }
      finally { pending = false; publish(); }
    }
    async function providerAction(action) {
      if (connectionBusy || !currentTool().id) return;
      const id = currentTool().id;
      connectionBusy = true; paintStatus();
      try {
        const result = await (action === 'connect' ? api.connectAICode?.(id) : action === 'detect' ? api.refreshAICode?.(id) : api.openAIToolWebsite?.(id));
        if (result?.ok === false) throw Error(result.error);
        await readStatus();
      } catch (error) { if (currentTool().id === id) {
        hint.textContent = messages[error.message] || '操作未完成，请重试';
        if (pickerOpen) feedback.textContent = hint.textContent;
      } }
      finally { connectionBusy = false; detect.disabled = false; connect.disabled = false; setupConnect.disabled = false; }
    }
    function onRootClick(event) {
      const control = event.target.closest('[data-ai-action], .codex-brand');
      if (!control || !root.contains(control) || !active || control.disabled || root.closest('.is-dragging')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (['website', 'connect', 'detect'].includes(control.dataset.aiAction)) void providerAction(control.dataset.aiAction);
      else open(control);
    }
    dialog.addEventListener('click', (event) => {
      const control = event.target.closest('[data-ai-action]'); if (!control || control.disabled) return;
      const action = control.dataset.aiAction;
      if (action === 'connect') { void providerAction('connect'); }
      else if (action === 'close') { void api.openIslandWorkspace?.('home'); }
      else if (action === 'back') { candidate = null; feedback.textContent = ''; paintList(); search.focus(); }
      else if (action === 'choose') {
        candidate = model.catalog.find((tool) => tool.id === control.dataset.aiId);
        feedback.textContent = ''; paintList(); confirm.focus();
      } else if (action === 'confirm') void commit();
    });
    function onKey(event) {
      if (event.key === 'Escape' && pickerOpen && candidate) { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      else if (pickerOpen && !candidate && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key) && list.contains(document.activeElement)) {
        event.preventDefault();
        const rows = [...list.querySelectorAll('[role="radio"]')], index = rows.indexOf(document.activeElement);
        rows[(index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + rows.length) % rows.length]?.focus();
      }
    }
    root.addEventListener('click', onRootClick, true); search.addEventListener('input', paintList);
    document.addEventListener('notch:tabchange', syncPage);
    document.addEventListener('notch:modechange', syncPage);
    document.addEventListener('notch:beforecollapse', () => { candidate = null; });
    document.addEventListener('keydown', onKey, true); listeners.add(paint); statusListeners.add(paintStatus); paint();
    syncPage();
    return Object.freeze({ close: (restoreFocus = true) => restoreFocus ? close() : false, isOpen: () => pickerOpen && !!candidate,
      setActive(value) { active = value === true; paint(); },
      destroy() { destroyed = true; listeners.delete(paint); statusListeners.delete(paintStatus); dialog.remove();
        document.removeEventListener('notch:tabchange', syncPage); document.removeEventListener('notch:modechange', syncPage);
        if (closeOpenPicker === close) closeOpenPicker = null;
        document.removeEventListener('keydown', onKey, true); root.removeEventListener('click', onRootClick, true); },
    });
  }
  window.AITools = Object.freeze({ currentTool, attachCard, closePicker: () => closeOpenPicker?.() === true,
    onStatus(callback) { statusListeners.add(callback); return () => statusListeners.delete(callback); }, getStatus: readStatus,
  });
})();
