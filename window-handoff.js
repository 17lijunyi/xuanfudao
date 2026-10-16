'use strict';

// Keep the outgoing window painted until the incoming renderer has prepared
// its complete frame. A failed, dismissed or superseded handoff rolls back;
// a late renderer acknowledgement can never reopen either window.
function createWindowHandoffController({ timeoutMs = 3000, onError = () => {} } = {}) {
  let active = null;
  let sequence = 0;
  function finish(transaction, result) {
    if (active !== transaction) return;
    active = null;
    clearTimeout(transaction.timer);
    for (const [emitter, event, listener] of transaction.listeners) emitter.removeListener(event, listener);
    if (transaction.committed) {
      try { transaction.settle?.(transaction.id, transaction.surface); } catch (error) { onError(error); }
    } else if (!result.ok) {
      try { transaction.rollback(transaction.id); } catch (error) { onError(error); }
    }
    transaction.resolve(result);
  }
  function cancel(error = 'cancelled') {
    if (!active || active.phase === 'committing') return false;
    finish(active, active.committed ? { ok: true, interrupted: true } : { ok: false, error });
    return true;
  }
  async function present(transaction) {
    if (active !== transaction || !transaction.prepared || !transaction.ready || transaction.phase !== 'preparing') return;
    transaction.phase = 'painting';
    try {
      // Flush Chromium's own transparent window, not a desktop screenshot.
      // The image is discarded and never persisted or sent anywhere.
      const image = await transaction.target.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image?.isEmpty?.()) throw new Error('Incoming window has no painted frame');
      if (active !== transaction) return;
      if (transaction.source.isDestroyed() || transaction.target.isDestroyed()) {
        finish(transaction, { ok: false, error: 'window_closed' });
        return;
      }
      transaction.phase = 'committing';
      transaction.commit();
      transaction.committed = true;
      if (transaction.motionReady && transaction.animate) {
        transaction.phase = 'animating';
        clearTimeout(transaction.timer);
        transaction.timer = setTimeout(() => cancel('motion_timeout'), 1400);
        transaction.animate(transaction.id);
      } else finish(transaction, { ok: true });
    } catch (error) {
      onError(error);
      finish(transaction, { ok: false, error: 'surface_unavailable' });
    }
  }
  function begin(specification) {
    cancel('superseded');
    const transaction = { ...specification, id: ++sequence, phase: 'preparing', prepared: false, ready: false, listeners: [] };
    const result = new Promise(resolve => { transaction.resolve = resolve; });
    active = transaction;
    for (const [emitter, event] of [[transaction.source, 'hide'], [transaction.source, 'closed'],
      [transaction.target, 'hide'], [transaction.target, 'closed'], [transaction.target.webContents, 'render-process-gone']]) {
      const listener = () => {
        if (active !== transaction) return;
        if (emitter === transaction.source && transaction.committed) return;
        if (emitter === transaction.target && event === 'hide' && !transaction.committed) return;
        cancel('window_closed');
      };
      emitter.on(event, listener);
      transaction.listeners.push([emitter, event, listener]);
    }
    transaction.timer = setTimeout(() => {
      if (active === transaction) cancel('surface_timeout');
    }, timeoutMs);
    Promise.resolve().then(() => active === transaction && transaction.prepare(transaction.id)).then(() => {
      transaction.prepared = true;
      void present(transaction);
    }).catch(error => {
      onError(error);
      finish(transaction, { ok: false, error: 'surface_unavailable' });
    });
    return result;
  }
  function ready(sender, id, motionReady = false) {
    const transaction = active;
    if (!transaction || transaction.target.webContents !== sender || transaction.id !== id) return;
    transaction.ready = true;
    transaction.motionReady = motionReady === true;
    void present(transaction);
  }
  function complete(sender, id) {
    if (!active || active.target.webContents !== sender || active.id !== id || active.phase !== 'animating') return false;
    finish(active, { ok: true });
    return true;
  }
  return {
    begin, ready, complete, cancel,
    recordSurface: (window, surface) => { if (active?.target === window) active.surface = surface; },
    isCurrent: id => active?.id === id,
    isSource: window => Boolean(active && active.source === window),
    isTarget: window => Boolean(active && active.target === window),
    isCommitting: () => active?.phase === 'committing',
  };
}

// Only normalized geometry of the caller's own visible cards crosses IPC.
// No HTML, text, images, selectors, filenames or native handles are accepted.
function normalizeWindowMotion(value, bounds) {
  if (!value || value.version !== 1 || !['quick', 'home', 'workspace'].includes(value.view)
    || value.reducedMotion !== false || !bounds || !value.viewport
    || !Number.isFinite(value.viewport.width) || !Number.isFinite(value.viewport.height)
    || Math.abs(value.viewport.width - bounds.width) > 1
    || Math.abs(value.viewport.height - bounds.height) > 1) return null;
  const cards = {};
  const keys = value.view === 'workspace' ? Array.from({ length: 24 }, (_, index) => 'slot' + index) : ['codex', 'note', 'pomodoro'];
  for (const key of keys) {
    const rect = value.cards?.[key];
    if (!rect || !['x', 'y', 'width', 'height'].every(name => Number.isFinite(rect[name]))) continue;
    if (rect.x < 0 || rect.y < 0 || rect.width < 20 || rect.height < 20
      || rect.x + rect.width > bounds.width + 1 || rect.y + rect.height > bounds.height + 1) continue;
    cards[key] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (!Object.keys(cards).length) return null;
  return { version: 1, view: value.view, viewport: { width: bounds.width, height: bounds.height }, cards };
}
module.exports = { createWindowHandoffController, normalizeWindowMotion };
