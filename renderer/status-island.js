(() => {
  'use strict';
  const api = window.notchAPI || {};
  const root = document.getElementById('status-island');
  const compact = document.getElementById('status-compact');
  const expanded = document.getElementById('status-expanded');
  const range = document.getElementById('status-range');
  const number = document.getElementById('status-number');
  const heading = document.getElementById('status-heading');
  const detail = document.getElementById('status-detail');
  const error = document.getElementById('status-error');
  const paths = {
    volume: '<path d="M11 4 6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
    brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
    headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm16 0h-3v8h3a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2z"/>',
    output: '<rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="15" r="3"/><circle cx="12" cy="7" r="1"/>',
    battery: '<rect x="2" y="6" width="18" height="12" rx="2"/><path d="M22 10v4"/>',
    recording: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/>',
    music: '<path d="M9 18V5l11-2v13M9 9l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>',
  };
  let visible = false;
  let current = null;
  let generation = 0;
  let stateRevision = 0;
  let pending = null;
  let writing = false;
  let dragging = false;
  let writeTimer;
  let confirmed = 0;

  const popupAppearance = window.IslandPopupAppearance.create({
    api, elements: [document.getElementById('status-main'), document.getElementById('status-close')],
    isRendered: () => !!current && !current.compact,
    eventId: () => current?.eventId,
    sendSurface: payload => api.updateStatusIslandSurface?.(payload),
    onMaterial: callback => api.onStatusIslandMaterial?.(callback),
  });

  function icon(kind, muted = false) {
    const shape = kind === 'volume' && muted ? '<path d="M11 4 6 8H3v8h3l5 4zM16 9l6 6m0-6-6 6"/>' : paths[kind] || paths.volume;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
  }
  function paintValue(value) {
    range.value = String(value); range.style.setProperty('--status-fill', `${value}%`);
    number.value = `${value}%`; range.setAttribute('aria-valuetext', `${value}%`);
    if (current?.kind === 'volume') document.getElementById('status-icon').innerHTML = icon('volume', value === 0);
    describe();
  }
  function describe() {
    const parts = [current?.title, !number.hidden && number.value, current?.detail].filter(Boolean);
    const text = parts.join(' · ');
    heading.title = text;
    heading.setAttribute('aria-label', text);
    root.setAttribute('aria-label', text);
    range.title = text;
  }
  function show(data) {
    if (!data || !Object.hasOwn(paths, data.kind)) return;
    if (!visible || current?.kind !== data.kind) { generation++; pending = null; dragging = false; error.hidden = true; }
    const adjustable = data.adjustable === true && ['volume', 'brightness'].includes(data.kind) && Number.isFinite(data.value);
    stateRevision++;
    current = data; visible = true;
    root.inert = false; root.setAttribute('aria-hidden', 'false');
    root.dataset.compact = String(data.compact === true); root.dataset.kind = data.kind;
    root.dataset.layout = data.compact ? 'compact' : 'capsules';
    popupAppearance.applyAppearance(data.appearance);
    root.dataset.interactive = String(data.interactive === true);
    document.documentElement.style.setProperty('--notification-strip', `${Math.max(24, Math.min(80, data.stripHeight || 38))}px`);
    document.documentElement.style.setProperty('--notification-collapsed-width', `${Math.min(data.width || 348, data.collapsedWidth || 256)}px`);
    compact.hidden = !data.compact; expanded.hidden = !!data.compact;
    compact.setAttribute('aria-label', `${data.title || ''} ${data.value || ''}，点击展开`);
    document.getElementById('compact-icon').innerHTML = icon(data.kind);
    document.getElementById('status-icon').innerHTML = icon(data.kind);
    document.getElementById('compact-value').textContent = data.value ?? '';
    const device = ['output', 'headphones'].includes(data.kind);
    const lowBattery = data.kind === 'battery' && parseInt(data.value, 10) <= 20 && data.title === '使用电池';
    document.getElementById('status-title').textContent = device && data.detail ? data.detail : lowBattery ? '电量偏低' : data.title || '';
    detail.textContent = device ? data.title || '声音输出已切换' : data.detail || (lowBattery ? '请及时连接电源' : data.kind === 'battery' ? '电池状态' : '系统状态');
    document.getElementById('status-tool').innerHTML = icon(data.kind);
    const statePath = lowBattery ? '<path d="m12 3 10 18H2L12 3zM12 9v5m0 3v.01"/>'
      : device ? '<path d="m5 12 4.5 4.5L19 7"/>'
      : data.kind === 'battery' && data.title === '正在充电' ? '<path d="m13 2-8 12h6l-1 8 9-13h-7z"/>'
      : data.kind === 'battery' && data.title === '已连接电源' ? '<path d="M8 2v5m8-5v5M6 7h12v3a6 6 0 0 1-12 0V7zM12 16v6"/>' : '';
    if (statePath) document.getElementById('status-icon').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${statePath}</svg>`;

    document.getElementById('status-close').dataset.tone = lowBattery ? 'warning' : device || (data.kind === 'battery' && data.title !== '使用电池') ? 'success' : 'neutral';
    if (adjustable) confirmed = data.value;
    range.hidden = !adjustable;
    detail.hidden = adjustable;
    number.hidden = data.value === undefined || data.value === null || data.value === '';
    range.setAttribute('aria-label', data.kind === 'brightness' ? '屏幕亮度' : '系统输出音量');
    if (!adjustable) number.value = data.value ?? '';
    else if (!writing && pending === null && !dragging) paintValue(data.value);
    describe();
    if (data.animate) {
      root.dataset.visible = 'false'; expanded.classList.remove('is-visible');
      const token = generation;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (visible && token === generation) { root.dataset.visible = 'true'; expanded.classList.add('is-visible'); popupAppearance.refreshSurface(); } }));
    } else { root.dataset.visible = 'true'; expanded.classList.add('is-visible'); }
    popupAppearance.refreshSurface();
  }
  function hide() {
    generation++; visible = false; pending = null; dragging = false;
    clearTimeout(writeTimer); error.hidden = true;
    root.dataset.visible = 'false'; expanded.classList.remove('is-visible'); popupAppearance.refreshSurface(); root.inert = true; root.setAttribute('aria-hidden', 'true');
  }
  async function flush() {
    clearTimeout(writeTimer);
    if (!visible || writing || pending === null) return;
    const request = pending; pending = null; writing = true;
    const token = generation; const kind = current.kind;
    const revision = stateRevision;
    api.holdStatusIsland?.(true);
    try {
      const result = kind === 'brightness' ? await api.setSystemBrightness?.(request) : await api.setSystemVolume?.(request);
      if (!visible || token !== generation) return;
      // A newer native state, including another adjustment of this same control,
      // is authoritative over an older outstanding IPC response.
      if (revision !== stateRevision) return;
      const actual = kind === 'brightness' ? result?.brightness : result?.volume;
      if (result?.ok && Number.isFinite(actual)) { confirmed = result.muted ? 0 : actual; if (pending === null) paintValue(confirmed); error.hidden = true; }
      else { if (pending === null) paintValue(confirmed); error.textContent = kind === 'brightness' ? '无法调节此显示器亮度' : '音量调节失败，请重试'; error.hidden = false; }
    } catch (_) {
      if (visible && token === generation && revision === stateRevision) { paintValue(confirmed); error.textContent = '调节失败，请重试'; error.hidden = false; }
    } finally {
      writing = false;
      if (visible && pending !== null) flush();
      else if (visible && !dragging) {
        if (!range.hidden) paintValue(confirmed);
        api.holdStatusIsland?.(false);
      }
    }
  }
  range.addEventListener('input', () => {
    if (!visible) return;
    const value = Math.max(0, Math.min(100, Math.round(Number(range.value))));
    paintValue(value); pending = value; clearTimeout(writeTimer); writeTimer = setTimeout(flush, 70);
  });
  range.addEventListener('change', flush);
  range.addEventListener('pointerdown', () => { dragging = true; api.holdStatusIsland?.(true); });
  function endDrag() { dragging = false; flush(); if (!writing && pending === null) api.holdStatusIsland?.(false); }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  root.addEventListener('pointerenter', () => { if (!range.hidden) api.holdStatusIsland?.(true); });
  root.addEventListener('pointerleave', () => { if (!writing && !dragging) api.holdStatusIsland?.(false); });
  document.getElementById('status-close').addEventListener('click', () => api.dismissStatusIsland?.());
  compact.addEventListener('click', () => {
    if (current?.target === 'quick') api.showQuickIsland?.({ focus: true });
    else api.openIslandWorkspace?.(current?.target || 'home');
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') api.dismissStatusIsland?.(); });
  api.onStatusIslandShow?.(show); api.onStatusIslandHide?.(hide);
  window.addEventListener('beforeunload', hide);
  window.StatusIsland = Object.freeze({ show, hide });
})();
