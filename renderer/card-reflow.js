/* Geometry-only card transitions. Real controls stay in their original DOM;
   no screenshots, cloned content, media streams or stored data are involved. */
(() => {
  'use strict';
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const transactions = new Set();
  root.dataset.cardReflowEnabled = '';
  const pageSelectors = {
    home: '#home-bento > [data-home-module]', todo: '.quadrant',
    projects: '.pd-sidebar, .pd-file, .pd-empty',
    codes: '.ai-tool-row, .ai-tools-confirm', notes: '.notes-library, .notes-detail',
    links: '.link-group, .links-empty',
    recordings: '.computer-stat-card, .recording-library, .recording-detail',
    credentials: '.credentials-form-card, .credentials-library',
    clip: '.clip-item, .clip-empty', settings: '.settings-card',
  };
  const ownedProperties = ['position', 'left', 'top', 'width', 'height', 'min-width', 'min-height',
    'max-width', 'max-height', 'margin', 'grid-area', 'align-self', 'box-sizing', 'z-index', 'transition'];
  const box = element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  function visible(element) {
    if (!element?.isConnected || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const r = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (style.visibility === 'hidden' || r.width < 2 || r.height < 2
      || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const s = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(s.overflowX + s.overflowY)) {
        const p = parent.getBoundingClientRect();
        if (r.right <= p.left || r.left >= p.right || r.bottom <= p.top || r.top >= p.bottom) return false;
      }
    }
    return true;
  }
  function key(element) {
    if (element.matches('#home-codex, .quick-codex')) return 'codex';
    if (element.matches('.home-note, .quick-note, .notes-detail')) return 'note';
    if (element.matches('#home-pomodoro, .quick-pomodoro')) return 'pomodoro';
    return element.dataset.reflowKey || element.id || element.dataset.entry || element.dataset.aiId || element.dataset.groupId
      || element.dataset.id || element.dataset.priority || element.dataset.computerCard
      || element.dataset.appearancePreset || element.dataset.windowSizePreset || element.className;
  }
  function elements(scope, selector) {
    if (!scope) return [];
    const candidates = [...scope.querySelectorAll(selector || ':scope > *')]
      .filter(el => !el.hasAttribute('data-reflow-placeholder') && visible(el));
    return candidates.filter(el => !candidates.some(parent => parent !== el && parent.contains(el))).slice(0, 24);
  }
  function pageCards(panel = document.querySelector('.tab-panel.active')) {
    if (!panel) return [];
    const cards = elements(panel, pageSelectors[panel.id.replace('tab-', '')]);
    return cards.length ? cards : elements(panel, ':scope > *');
  }
  function restore(element, saved) {
    for (const [name, value, priority] of saved) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
  }
  function finish(transaction) {
    if (!transactions.delete(transaction)) return;
    clearTimeout(transaction.timer);
    transaction.animations.forEach(animation => animation.cancel());
    transaction.items.forEach(({ element, style, placeholder }) => {
      delete element.dataset.cardReflow;
      restore(element, style);
      placeholder.remove();
    });
    transaction.resolve();
  }
  function cancel(scope) {
    for (const transaction of [...transactions]) {
      if (!scope || scope === transaction.scope || scope.contains(transaction.scope) || transaction.scope.contains(scope)) finish(transaction);
    }
  }
  function capture(scope, options = {}) {
    const items = (options.items || elements(scope, options.selector)).map(element => ({ key: key(element), ...box(element) }));
    const snapshot = { items, width: innerWidth, height: innerHeight };
    // Read the current interpolated rectangles before cancelling an interrupted move.
    cancel(scope);
    return snapshot;
  }
  function play(snapshot, scope, options = {}) {
    if (!scope || !snapshot?.items.length || reduced.matches || root.dataset.surfaceHandoff || root.dataset.cardMotion
      || !visible(scope)) return Promise.resolve();
    cancel(scope);
    const candidates = options.items || elements(scope, options.selector);
    const destinations = candidates.map(element => ({ element, key: key(element), to: box(element) }));
    const remaining = new Set(snapshot.items);
    // Reserve semantic matches before spatially matching different pages.
    for (const item of destinations) {
      item.from = [...remaining].find(from => from.key === item.key);
      if (item.from) remaining.delete(item.from);
    }
    if (options.spatial) for (const item of destinations) {
      if (item.from || !remaining.size) continue;
      item.from = [...remaining].sort((a, b) => Math.hypot(a.x - item.to.x, a.y - item.to.y)
        - Math.hypot(b.x - item.to.x, b.y - item.to.y))[0];
      remaining.delete(item.from);
    }
    const style = getComputedStyle(root);
    const duration = parseFloat(style.getPropertyValue('--card-reflow-duration')) || 460;
    const stagger = parseFloat(style.getPropertyValue('--card-reflow-stagger')) || 22;
    const easing = style.getPropertyValue('--card-reflow-ease').trim() || 'ease-out';
    const offset = parseFloat(style.getPropertyValue('--card-reflow-reveal')) || 9;
    const transaction = { scope, items: [], animations: [], resolve: null, timer: null };
    const done = new Promise(resolve => { transaction.resolve = resolve; });
    transaction.done = done;
    transactions.add(transaction);
    try {
      destinations.forEach(({ element, from, to }, index) => {
        const moved = from && ['x', 'y', 'width', 'height'].some(name => Math.abs(from[name] - to[name]) > .75);
        if (from && !moved && from.key === key(element)) return;
        const delay = Math.min(100, index * stagger);
        let frames;
        if (moved) {
          const computed = getComputedStyle(element);
          const placeholder = document.createElement('div');
          placeholder.dataset.reflowPlaceholder = '';
          placeholder.setAttribute('aria-hidden', 'true');
          placeholder.inert = true;
          Object.assign(placeholder.style, { width: to.width + 'px', height: to.height + 'px',
            minWidth: '0', minHeight: '0', boxSizing: 'border-box', visibility: 'hidden',
            gridArea: computed.gridArea, order: computed.order, flex: computed.flex,
            alignSelf: computed.alignSelf, margin: computed.margin });
          const saved = ownedProperties.map(name => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
          transaction.items.push({ element, style: saved, placeholder });
          element.before(placeholder);
          element.dataset.cardReflow = '';
          const properties = { position: 'absolute', left: '0px', top: '0px', width: to.width + 'px', height: to.height + 'px',
            'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none', margin: '0',
            'grid-area': 'auto', 'align-self': 'start', 'box-sizing': 'border-box', 'z-index': String(20 + index), transition: 'none' };
          for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value);
          const origin = box(element);
          // Animate dimensions instead of scale so text and controls retain their size.
          frames = [from, to].map(r => ({ left: r.x - origin.x + 'px', top: r.y - origin.y + 'px', width: r.width + 'px', height: r.height + 'px' }));
        } else {
          frames = [{ opacity: 0, translate: `0 ${offset}px` }, { opacity: 1, translate: '0 0' }];
        }
        const animation = element.animate(frames, { duration: duration - delay, delay, easing, fill: 'both' });
        animation.finished.catch(() => {});
        transaction.animations.push(animation);
      });
      if (!transaction.animations.length) { finish(transaction); return done; }
      transaction.timer = setTimeout(() => finish(transaction), duration + 200);
      Promise.all(transaction.animations.map(animation => animation.finished.catch(() => {}))).then(() => finish(transaction));
    } catch (_) { finish(transaction); }
    return done;
  }
  function run(scope, mutate, options = {}) {
    const snapshot = capture(scope, options);
    const result = mutate();
    void play(snapshot, scope, options);
    return result;
  }
  function selectOption(scope, selected) {
    if (!scope || !selected || scope.firstElementChild === selected) return;
    const focused = document.activeElement;
    run(scope, () => scope.prepend(selected));
    if (focused?.isConnected && scope.contains(focused)) focused.focus({ preventScroll: true });
  }
  window.cardReflow = Object.freeze({ capture, play, run, cancel, pageCards, key, visible, selectOption,
    whenIdle: () => Promise.all([...transactions].map(transaction => transaction.done)),
    capturePage: panel => capture(panel, { items: pageCards(panel) }),
    playPage: (snapshot, panel) => play(snapshot, panel, { items: pageCards(panel), spatial: true }),
  });
  document.addEventListener('notch:beforecollapse', () => cancel());
  document.addEventListener('notch:modechange', event => { if (!event.detail?.expanded) cancel(); });
  window.addEventListener('resize', () => cancel());
  window.addEventListener('pagehide', () => cancel(), { once: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  document.addEventListener('scroll', event => { if (event.target instanceof Element) cancel(event.target); }, true);
  reduced.addEventListener('change', () => { if (reduced.matches) cancel(); });
})();
