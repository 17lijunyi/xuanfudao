/* Appearance is persisted by the main process and shared by both island windows. */
(() => {
  'use strict';

  const presets = [
    { id: 'system-glass-blurred', name: '柔焦玻璃', detail: '默认 · 柔焦背景', sampleAlpha: .10 },
    { id: 'classic', name: '纯黑', detail: '不透明 · 浅色文字', sampleAlpha: 1 },
  ];
  const presetIds = new Set(presets.map((preset) => preset.id));
  const root = document.documentElement;
  const api = window.notchAPI;
  let committed = { selectedId: 'system-glass-blurred', revision: -1 };
  let desiredId = null;
  let pending = false;
  let ready = false;
  let options;
  let note;
  let statusText = '正在读取外观…';
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
    root.dataset.appearance = selectedId;
    if (!options) return;
    options.setAttribute('aria-busy', String(pending));
    options.querySelectorAll('[data-appearance-preset]').forEach((button) => {
      const selected = button.dataset.appearancePreset === selectedId;
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected && ready ? 0 : -1;
      button.disabled = !ready;
    });
    window.cardReflow?.selectOption(options, options.querySelector(`[data-appearance-preset="${selectedId}"]`));
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
    return `已保存 · ${selected.name}`;
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
        result = await api.setAppearancePreset(requestedId);
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
        setStatus(saved ? savedLabel() : '保存失败，已恢复原来的外观。请重试。', saved ? 'saved' : 'error');
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
    options = document.getElementById('settings-appearance-options');
    note = document.getElementById('settings-appearance-note');
    if (!options) return;
    options.setAttribute('role', 'radiogroup');
    options.setAttribute('aria-label', '窗口风格');
    for (const preset of presets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'appearance-option';
      button.dataset.appearancePreset = preset.id;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `${preset.name}，${preset.detail}`);
      const sample = document.createElement('span');
      sample.className = 'appearance-sample';
      sample.setAttribute('aria-hidden', 'true');
      sample.style.setProperty('--appearance-sample-alpha', String(preset.sampleAlpha));
      const surface = document.createElement('span');
      surface.className = 'appearance-sample-surface';
      const island = document.createElement('span');
      island.className = 'appearance-sample-island';
      sample.append(surface, island);
      const caption = document.createElement('span');
      caption.className = 'appearance-option-caption';
      const name = document.createElement('strong');
      name.textContent = preset.name;
      const amount = document.createElement('small');
      amount.textContent = preset.detail;
      caption.append(name, amount);
      const check = document.createElement('span');
      check.className = 'appearance-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      button.append(sample, caption, check);
      button.addEventListener('click', () => choose(preset.id));
      button.addEventListener('keydown', (event) => {
        const buttons = Array.from(options.querySelectorAll('[data-appearance-preset]'));
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
        choose(target.dataset.appearancePreset);
      });
      options.append(button);
    }
    paint();
    setStatus(statusText, statusKind);
  }

  root.dataset.appearance = 'system-glass-blurred';
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  if (!api?.getAppearanceSettings || !api?.setAppearancePreset || !api?.onAppearanceSettingsChanged) {
    setStatus('外观设置暂不可用，请重新打开工作台。', 'error');
    return;
  }

  const unsubscribe = api.onAppearanceSettingsChanged((snapshot) => {
    if (acceptSnapshot(snapshot) && !desiredId && !pending) setStatus(savedLabel());
  });
  window.addEventListener('pagehide', () => {
    if (typeof unsubscribe === 'function') unsubscribe();
  }, { once: true });
  Promise.resolve().then(() => api.getAppearanceSettings()).then((snapshot) => {
    if (!acceptSnapshot(snapshot)) {
      if (!ready) setStatus('外观读取失败，请重新打开工作台。', 'error');
      return;
    }
    if (!desiredId && !pending) setStatus(savedLabel());
  }).catch(() => {
    if (!ready) setStatus('外观读取失败，请重新打开工作台。', 'error');
  });
})();
