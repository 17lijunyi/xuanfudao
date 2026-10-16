/* Window size is persisted by the main process and shared by both island windows. */
(() => {
  'use strict';

  const presets = [
    { id: 'A', name: '适合 16 寸或 15.3 寸', detail: '1240 宽', width: 1240, sampleAlpha: .2 },
    { id: 'B', name: '适合 14 寸或 13 寸', detail: '1040 宽', width: 1040, sampleAlpha: .2 },
  ];
  const presetIds = new Set(presets.map((preset) => preset.id));
  const root = document.documentElement;
  const api = window.notchAPI;
  let committed = { selectedId: 'B', revision: -1 };
  let desiredId = null;
  let pending = false;
  let ready = false;
  let options;
  let note;
  let statusText = '正在读取尺寸…';
  let statusKind = 'loading';

  function setStatus(text, kind = 'saved') {
    statusText = text;
    statusKind = kind;
    if (note) {
      note.textContent = text;
      note.dataset.state = kind;
    }
  }

  function paint() {
    const selectedId = desiredId || committed.selectedId;
    root.dataset.windowSize = selectedId;
    if (!options) return;
    options.setAttribute('aria-busy', String(pending));
    options.querySelectorAll('[data-window-size-preset]').forEach((button) => {
      const selected = button.dataset.windowSizePreset === selectedId;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected && ready ? 0 : -1;
      button.disabled = !ready;
    });
    window.cardReflow?.selectOption(options, options.querySelector(`[data-window-size-preset="${selectedId}"]`));
  }

  function acceptSnapshot(snapshot) {
    if (!snapshot || !presetIds.has(snapshot.selectedId)
      || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
      || snapshot.revision < committed.revision) return false;
    // A revision identifies one saved value. An older asynchronous read cannot undo it.
    if (snapshot.revision === committed.revision && snapshot.selectedId !== committed.selectedId) return false;
    committed = { selectedId: snapshot.selectedId, revision: snapshot.revision };
    ready = true;
    paint();
    return true;
  }

  function savedLabel() {
    const selected = presets.find((preset) => preset.id === committed.selectedId);
    return `已保存 · ${selected.name} · ${selected.width} 宽`;
  }

  async function persistDesired() {
    if (pending || !desiredId || !ready) return;
    pending = true;
    paint();
    while (desiredId) {
      const requestedId = desiredId;
      setStatus('正在保存…', 'saving');
      let result;
      try {
        result = await api.setWindowSizePreset(requestedId);
      } catch {
        result = null;
      }
      if (result?.snapshot) acceptSnapshot(result.snapshot);
      const saved = result?.ok === true && result.snapshot?.selectedId === requestedId
        && Number.isSafeInteger(result.snapshot?.revision) && result.snapshot.revision >= 0;
      // Writes are serialized; clicks during a save replace the queued choice.
      // Keep the latest preview visible until that final choice has been saved.
      if (desiredId === requestedId) {
        desiredId = null;
        setStatus(saved ? savedLabel() : '保存失败，已恢复原来的尺寸。请重试。', saved ? 'saved' : 'error');
      }
    }
    pending = false;
    paint();
  }

  function choose(id) {
    if (!ready || !presetIds.has(id)) return;
    if (!pending && id === committed.selectedId) {
      setStatus(savedLabel());
      return;
    }
    desiredId = id;
    paint();
    void persistDesired();
  }

  function mount() {
    options = document.getElementById('settings-window-size-options');
    note = document.getElementById('settings-window-size-note');
    if (!options) return;
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', '窗口尺寸');
    const compact = !!options.closest('.quick-preference-panel');
    for (const preset of compact ? [...presets].reverse() : presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'appearance-option';
      button.dataset.windowSizePreset = preset.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `${preset.name}，${preset.detail}`);
      const sample = document.createElement('span');
      sample.className = 'appearance-sample';
      sample.setAttribute('aria-hidden', 'true');
      sample.style.setProperty('--appearance-sample-alpha', String(preset.sampleAlpha));
      const surface = document.createElement('span');
      surface.className = 'appearance-sample-surface';
      surface.style.width = `${preset.width / 1512 * 100}%`;
      surface.style.left = `${(1 - preset.width / 1512) * 50}%`;
      const island = document.createElement('span');
      island.className = 'appearance-sample-island';
      sample.append(surface, island);
      const caption = document.createElement('span');
      caption.className = 'appearance-option-caption';
      const name = document.createElement('strong');
      name.textContent = compact ? (preset.id === 'B' ? '13 / 14 寸' : '15.3 / 16 寸') : preset.name;
      const amount = document.createElement('small');
      amount.textContent = compact ? `${preset.width} px${preset.id === 'B' ? ' · 默认' : ''}` : preset.detail;
      caption.append(name, amount);
      const check = document.createElement('span');
      check.className = 'appearance-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(sample, caption, check);
      button.addEventListener('click', () => choose(preset.id));
      button.addEventListener('keydown', (event) => {
        const buttons = Array.from(options.querySelectorAll('[data-window-size-preset]'));
        const current = buttons.indexOf(button);
        const columns = getComputedStyle(options).gridTemplateColumns.split(' ').filter(Boolean).length || 2;
        const verticalStep = columns < buttons.length ? columns : 1;
        let next;
        if (event.key === 'ArrowRight') next = current + 1;
        else if (event.key === 'ArrowLeft') next = current - 1;
        else if (event.key === 'ArrowDown') next = current + verticalStep;
        else if (event.key === 'ArrowUp') next = current - verticalStep;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault();
        const target = buttons[(next + buttons.length) % buttons.length];
        target.focus();
        choose(target.dataset.windowSizePreset);
      });
      options.append(button);
    }
    paint();
    setStatus(statusText, statusKind);
  }

  root.dataset.windowSize = 'B';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  if (!api?.getWindowSizeSettings || !api?.setWindowSizePreset || !api?.onWindowSizeSettingsChanged) {
    setStatus('尺寸设置暂不可用，请重新打开工作台。', 'error');
    return;
  }

  const unsubscribe = api.onWindowSizeSettingsChanged((snapshot) => {
    if (acceptSnapshot(snapshot) && !desiredId && !pending) setStatus(savedLabel());
  });
  window.addEventListener('pagehide', () => {
    if (typeof unsubscribe === 'function') unsubscribe();
  }, { once: true });
  Promise.resolve().then(() => api.getWindowSizeSettings()).then((snapshot) => {
    if (!acceptSnapshot(snapshot)) {
      if (!ready) setStatus('尺寸读取失败，请重新打开工作台。', 'error');
      return;
    }
    if (!desiredId && !pending) setStatus(savedLabel());
  }).catch(() => {
    if (!ready) setStatus('尺寸读取失败，请重新打开工作台。', 'error');
  });
})();
