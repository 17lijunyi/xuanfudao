(() => {
  'use strict';
  const api = window.notchAPI;
  if (!api?.updateAppearanceSurface) return;
  const root = document.documentElement;
  const quick = document.getElementById('quick-island');
  const app = document.getElementById('app');
  const panel = document.getElementById('panel');
  let raf = 0;
  let until = 0;
  let last = '';

  // Chromium serializes inset interpolation as px or simple calc(% +/- px).
  // Parse only those lengths; never execute a CSS expression as JavaScript.
  function length(value, extent) {
    const input = value.trim().replace(/^calc\((.*)\)$/, '$1').replace(/\s+/g, '');
    if (input === '0') return 0;
    const terms = input.match(/[+-]?(?:\d*\.)?\d+(?:px|%)/g);
    if (!terms || terms.join('') !== input) return NaN;
    return terms.reduce((total, term) => total + parseFloat(term) * (term.endsWith('%') ? extent / 100 : 1), 0);
  }
  function four(values) {
    return [values[0], values[1] ?? values[0], values[2] ?? values[0], values[3] ?? values[1] ?? values[0]];
  }
  function shape(element, pseudo, opacity) {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element, pseudo);
    let x = rect.x, y = rect.y, width = rect.width, height = rect.height;
    const motionHeight = window.islandCardMotion?.surfaceHeight();
    if (Number.isFinite(motionHeight) && motionHeight > 0) height = Math.min(height, motionHeight);
    let radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(v => length(v, width));
    if (style.clipPath !== 'none') {
      const match = style.clipPath.match(/^inset\((.*)\)$/);
      if (!match) return null;
      const [insets, round] = match[1].split(/\s+round\s+/);
      const parts = four(insets.match(/calc\([^)]*\)|[^\s]+/g) || []);
      const [top, right, bottom, left] = parts.map((v, i) => length(v || '', i % 2 ? width : height));
      if (round) radii = four(round.split('/')[0].trim().split(/\s+/)).map(v => length(v, width));
      x += left; y += top; width -= left + right; height -= top + bottom;
    }
    const backgroundBlurRadius = parseFloat(style.getPropertyValue('--glass-desktop-blur')) || 20;
    const result = { x, y, width, height, radii, opacity: opacity * Number(style.opacity), backgroundBlurRadius };
    return [x, y, width, height, result.opacity, ...radii].every(Number.isFinite) && width > 0 && height > 0 ? result : null;
  }
  function frame() {
    raf = 0;
    let surface = null;
    if (root.dataset.appearance === 'system-glass-blurred' && (!document.hidden || root.dataset.surfaceHandoff)) {
      if (quick) surface = shape(quick, '::before', Number(getComputedStyle(quick).opacity));
      else if (app && !app.classList.contains('opening')) {
        surface = app.classList.contains('expanded') || app.classList.contains('closing')
          ? shape(panel, '::before', 1) : null;
      }
    }
    if (surface?.opacity < .005) surface = null;
    const message = { viewport: { width: innerWidth, height: innerHeight }, surface };
    const key = JSON.stringify(message);
    if (key !== last) { last = key; api.updateAppearanceSurface(message); }
    if (performance.now() < until) raf = requestAnimationFrame(frame);
  }
  function refresh() {
    until = performance.now() + 1300;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function repaint() { last = ''; refresh(); }
  window.repaintIslandSurface = () => { last = ''; cancelAnimationFrame(raf); frame(); };
  // Both documents use the same ordering: publish the final native glass mask,
  // let Chromium paint two frames, then acknowledge this particular handoff.
  window.prepareIslandSurface = async (handoffId) => {
    const motionReady = window.islandCardMotion?.stage(handoffId) === true;
    last = '';
    refresh();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (root.dataset.surfaceHandoff !== String(handoffId)) return;
    api.surfaceReady?.(handoffId, motionReady);
    if (!motionReady) delete root.dataset.surfaceHandoff;
  };
  // Bound sampling to actual style transitions; no polling while the island rests.
  const observer = new MutationObserver(repaint);
  observer.observe(root, { attributes: true, attributeFilter: ['data-appearance', 'style'] });
  if (app) observer.observe(app, { attributes: true, attributeFilter: ['class', 'style'] });
  if (quick) observer.observe(quick, { attributes: true, attributeFilter: ['data-visible', 'style'] });
  window.addEventListener('resize', repaint);
  document.addEventListener('visibilitychange', repaint);
  document.addEventListener('transitionrun', refresh, true);
  // Native layers are removed on hide/resize. Resend on reopening or a saved
  // preference, even when the final CSS geometry matches the previous frame.
  const unsubscribe = api.onAppearanceSettingsChanged?.(repaint);
  window.addEventListener('pagehide', () => {
    observer.disconnect(); cancelAnimationFrame(raf);
    if (typeof unsubscribe === 'function') unsubscribe();
    api.updateAppearanceSurface({ surface: null });
  }, { once: true });
  refresh();
})();
