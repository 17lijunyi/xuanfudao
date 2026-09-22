/* 悬浮岛列表选择动效；CodexFloat 不使用 WebGL 或常驻帧循环。 */
(function bootstrapPanelEffects() {
  'use strict';

  const LINE_LISTS = [
    ['#tab-todo .todo-list', '.todo-item'],
    ['#tab-links .link-list', '.link-item'],
    ['#tab-recordings .recording-list', '.recording-item'],
    ['#tab-credentials .credential-list', '.credential-item'],
    ['#tab-notes .notes-list', '.notes-list-item'],
  ];
  const lineStates = new WeakMap();
  let lineAnimation = 0;
  let lastLineFrame = performance.now();

  function runLineFrame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - lastLineFrame) / 1000));
    lastLineFrame = now;
    const blend = 1 - Math.exp(-dt / 0.1);
    let moving = false;
    document.querySelectorAll('[data-line-sidebar-item]').forEach((item) => {
      const state = lineStates.get(item) || { current: 0, target: 0 };
      const active = item.matches('.active, .multi-selected, [aria-current="true"], [aria-selected="true"]');
      const target = Math.max(state.target, active ? 0.72 : 0);
      state.current += (target - state.current) * blend;
      if (Math.abs(target - state.current) < 0.002) state.current = target;
      else moving = true;
      item.style.setProperty('--line-effect', state.current.toFixed(4));
      lineStates.set(item, state);
    });
    lineAnimation = moving ? requestAnimationFrame(runLineFrame) : 0;
  }

  function startLineFrame() {
    if (lineAnimation) return;
    lastLineFrame = performance.now();
    lineAnimation = requestAnimationFrame(runLineFrame);
  }

  function setLineTargets(list, clientY) {
    const radius = 100;
    list.querySelectorAll('[data-line-sidebar-item]').forEach((item) => {
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(clientY - (rect.top + rect.height / 2));
      const proximity = Math.max(0, 1 - distance / radius);
      const smooth = proximity * proximity * (3 - 2 * proximity);
      const state = lineStates.get(item) || { current: 0, target: 0 };
      state.target = smooth;
      lineStates.set(item, state);
    });
    startLineFrame();
  }

  function resetLineTargets(list) {
    list.querySelectorAll('[data-line-sidebar-item]').forEach((item) => {
      const state = lineStates.get(item) || { current: 0, target: 0 };
      state.target = 0;
      lineStates.set(item, state);
    });
    startLineFrame();
  }

  function decorateLineLists() {
    LINE_LISTS.forEach(([listSelector, itemSelector]) => {
      document.querySelectorAll(listSelector).forEach((list) => {
        list.classList.add('line-sidebar-list');
        list.querySelectorAll(itemSelector).forEach((item) => {
          item.dataset.lineSidebarItem = '';
          if (!lineStates.has(item)) lineStates.set(item, { current: 0, target: 0 });
        });
        if (list.dataset.lineSidebarBound === 'true') return;
        list.dataset.lineSidebarBound = 'true';
        list.addEventListener('pointermove', (event) => setLineTargets(list, event.clientY));
        list.addEventListener('pointerleave', () => resetLineTargets(list));
        list.addEventListener('focusin', (event) => {
          const item = event.target.closest('[data-line-sidebar-item]');
          if (!item) return;
          setLineTargets(list, item.getBoundingClientRect().top + item.offsetHeight / 2);
        });
        list.addEventListener('focusout', (event) => {
          if (!list.contains(event.relatedTarget)) resetLineTargets(list);
        });
      });
    });
  }

  decorateLineLists();
  const listObserver = new MutationObserver(decorateLineLists);
  const panels = document.getElementById('panels');
  if (panels) listObserver.observe(panels, { childList: true, subtree: true });

  window.DynamicPanelEffects = {
    redraw: () => {},
    refreshLists: decorateLineLists,
  };
  window.addEventListener('pagehide', () => {
    listObserver.disconnect();
    cancelAnimationFrame(lineAnimation);
  }, { once: true });
})();
