(() => {
  'use strict';
  const api = window.notchAPI;
  const root = document.documentElement;
  const quick = document.getElementById('quick-island');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const selectors = quick
    ? { codex: '.quick-codex', note: '.quick-note', pomodoro: '.quick-pomodoro' }
    : { codex: '#home-codex', note: '.home-note', pomodoro: '#home-pomodoro' };
  let pending = null;
  let active = null;
  function allCards() {
    const cards = quick ? [...document.querySelectorAll('.island-content > section')]
      : window.cardReflow?.pageCards() || [];
    return cards.filter(visible).slice(0, 24);
  }
  const visible = element => {
    if (!element || element.hidden || getComputedStyle(element).visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width >= 20 && rect.height >= 20;
  };
  function rect(element) {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { x, y, width, height };
  }
  function restoreStyle(element, style) {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }
  function cleanup(id) {
    if (id && active?.id !== id && pending?.id !== id) return;
    // setBounds and Chromium's resize arrive on different queues. Keep the
    // final quick layout until its viewport catches up to the smaller canvas.
    if (id && active && quick?.dataset.visible === 'true' && innerHeight > active.targetHeight + 1
      && (active.cleanupAttempts || 0) < 12) {
      active.cleanupAttempts = (active.cleanupAttempts || 0) + 1;
      cancelAnimationFrame(active.cleanupFrame);
      active.cleanupFrame = requestAnimationFrame(() => cleanup(id));
      return;
    }
    pending = null;
    const transaction = active;
    active = null;
    if (transaction) {
      clearTimeout(transaction.timer);
      cancelAnimationFrame(transaction.cleanupFrame);
      transaction.animations.forEach(animation => animation.cancel());
      transaction.items.forEach(({ element, style, placeholder }) => {
        element.removeAttribute('data-card-motion-item');
        restoreStyle(element, style);
        placeholder.remove();
      });
      restoreStyle(transaction.container, transaction.containerStyle);
      transaction.container.inert = transaction.wasInert;
    }
    delete root.dataset.cardMotion;
    root.style.removeProperty('--card-motion-target-height');
    root.style.removeProperty('--card-motion-surface-height');
    if (!id || root.dataset.surfaceHandoff === String(id)) delete root.dataset.surfaceHandoff;
    window.repaintIslandSurface?.();
  }
  function capture() {
    if (active || reduced.matches) return null;
    const home = document.getElementById('tab-home')?.classList.contains('active');
    const view = quick ? 'quick' : home ? 'home' : 'workspace';
    if (quick ? quick.dataset.visible !== 'true' : !document.getElementById('app')?.classList.contains('expanded')) return null;
    const cards = {};
    if (view === 'workspace') allCards().forEach((element, index) => { cards['slot' + index] = rect(element); });
    else for (const [key, selector] of Object.entries(selectors)) {
        const element = document.querySelector(selector);
        if (visible(element)) cards[key] = rect(element);
      }
    return { version: 1, view, reducedMotion: false, viewport: { width: innerWidth, height: innerHeight }, cards };
  }
  function configure(id, source, targetHeight) {
    window.cardReflow?.cancel();
    cleanup();
    if (Number.isSafeInteger(id) && id > 0 && source?.version === 1 && Number.isFinite(targetHeight)) {
      pending = { id, source, targetHeight };
    }
  }
  function stage(id) {
    if (active?.id === id) return true;
    const request = pending;
    if (!request || request.id !== id || reduced.matches
      || Math.abs(request.source.viewport.width - innerWidth) > 1) return false;
    const home = !quick && document.getElementById('tab-home')?.classList.contains('active');
    const general = request.source.view === 'workspace' || (!quick && !home);
    const container = quick ? document.querySelector('.island-content') : home ? document.getElementById('home-bento') : document.querySelector('.tab-panel.active');
    if (!container || typeof container.animate !== 'function') return false;
    const fromHeight = Math.min(innerHeight, request.source.viewport.height);
    const toHeight = Math.min(innerHeight, request.targetHeight);
    root.style.setProperty('--card-motion-target-height', toHeight + 'px');
    root.style.setProperty('--card-motion-surface-height', fromHeight + 'px');
    root.dataset.cardMotion = 'prepared';
    const targets = allCards();
    const pairs = general ? (() => {
      const remaining = Object.values(request.source.cards || {});
      return targets.flatMap(element => {
        if (!remaining.length) return [];
        const to = rect(element);
        remaining.sort((a, b) => Math.hypot(a.x - to.x, a.y - to.y) - Math.hypot(b.x - to.x, b.y - to.y));
        return [{ element, from: remaining.shift(), to }];
      });
    })() : Object.entries(selectors).flatMap(([key, selector]) => {
      const element = document.querySelector(selector);
      const from = request.source.cards?.[key];
      return from && visible(element) ? [{ element, from, to: rect(element) }] : [];
    });
    if (!pairs.length) { cleanup(); return false; }
    const style = getComputedStyle(root);
    const duration = Math.max(180, Math.min(800, parseFloat(style.getPropertyValue('--card-motion-duration')) || 460));
    const easing = style.getPropertyValue('--card-motion-ease').trim() || 'ease-out';
    const transaction = { ...request, container, containerStyle: container.getAttribute('style'),
      wasInert: container.inert, items: [], animations: [], duration, fromHeight, toHeight };
    active = transaction;
    const animate = (element, frames, timing = {}) => {
      const animation = element.animate(frames, { duration, easing, fill: 'both', ...timing });
      animation.pause();
      animation.currentTime = 0;
      // A superseding navigation cancels paused animations before play.
      animation.finished.catch(() => {});
      transaction.animations.push(animation);
    };
    try {
      const containerRect = rect(container);
      container.style.position = 'relative';
      container.style.height = containerRect.height + 'px';
      container.inert = true;
      for (const { element, from, to } of pairs) {
        const original = element.getAttribute('style');
        const computed = getComputedStyle(element);
        const placeholder = document.createElement('section');
        placeholder.dataset.cardMotionPlaceholder = '';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.style.cssText = 'grid-area:' + computed.gridArea + ';order:' + computed.order
          + ';width:' + to.width + 'px;height:' + to.height + 'px;min-width:0;min-height:0';
        element.before(placeholder);
        transaction.items.push({ element, style: original, placeholder });
        element.dataset.cardMotionItem = '';
        Object.assign(element.style, { left: '0px', top: '0px', width: to.width + 'px', height: to.height + 'px' });
        const origin = rect(element);
        animate(element, [
          { left: from.x - origin.x + 'px', top: from.y - origin.y + 'px', width: from.width + 'px', height: from.height + 'px' },
          { left: to.x - origin.x + 'px', top: to.y - origin.y + 'px', width: to.width + 'px', height: to.height + 'px' },
        ]);
      }
      const shared = new Set(pairs.map(pair => pair.element));
      for (const element of targets) {
        if (element.hasAttribute('data-card-motion-placeholder') || shared.has(element) || !visible(element)) continue;
        animate(element, [{ opacity: 0, translate: '0 ' + style.getPropertyValue('--card-motion-reveal-offset').trim() }, { opacity: 1, translate: '0 0' }],
          { delay: duration * .18, duration: duration * .72 });
      }
      animate(root, [{ '--card-motion-surface-height': fromHeight + 'px' }, { '--card-motion-surface-height': toHeight + 'px' }]);
      return true;
    } catch (_) { cleanup(id); return false; }
  }
  async function finish(transaction) {
    if (active !== transaction || transaction.finishing) return;
    transaction.finishing = true;
    clearTimeout(transaction.timer);
    transaction.animations.forEach(animation => { try { animation.finish(); } catch (_) {} });
    root.style.setProperty('--card-motion-surface-height', transaction.toHeight + 'px');
    window.repaintIslandSurface?.();
    try { await api?.completeWindowMotion?.(transaction.id); }
    catch (_) { /* A closing window may discard the acknowledgement. */ }
    finally { cleanup(transaction.id); }
  }
  async function play(id) {
    const transaction = active;
    if (!transaction || transaction.id !== id || root.dataset.cardMotion === 'playing') return;
    root.dataset.cardMotion = 'playing';
    if (reduced.matches) { await finish(transaction); return; }
    transaction.timer = setTimeout(() => { void finish(transaction); }, transaction.duration + 450);
    transaction.animations.forEach(animation => animation.play());
    await Promise.all(transaction.animations.map(animation => animation.finished.catch(() => {})));
    if (active === transaction) await finish(transaction);
  }
  window.islandCardMotion = { capture, configure, stage, cleanup,
    surfaceHeight: () => active ? parseFloat(getComputedStyle(root).getPropertyValue('--card-motion-surface-height')) : null };
  api?.onWindowMotionPlay?.(id => { void play(id); });
  api?.onWindowMotionCleanup?.(cleanup);
  reduced.addEventListener('change', () => { if (reduced.matches && active && root.dataset.cardMotion === 'playing') void finish(active); });
  document.addEventListener('notch:tabchange', event => {
    if (active && root.dataset.cardMotion === 'playing') void finish(active);
  });
  window.addEventListener('pagehide', () => cleanup(), { once: true });
})();
