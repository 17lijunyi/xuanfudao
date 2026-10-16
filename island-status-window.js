const path = require('node:path');
const { installLocalWebContentsGuards } = require('./main-services');
const { normalizeAppearanceSurface } = require('./appearance-surface');

function getStatusIslandBounds(display, stripHeight, compact, data) {
  const popupWidth = 348;
  const width = Math.round(Math.min(compact ? 360 : popupWidth, Math.max(1, display.bounds.width - 48)));
  const strip = Math.max(24, Math.min(80, Number(stripHeight) || 38));
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: display.bounds.y,
    width,
    height: Math.round(strip + (compact ? 0 : 86)),
  };
}

function createIslandStatusWindow({ BrowserWindow, getBounds, isAllowed, onClosed, alwaysOnTopLevel = 1, getAppearance = () => ({ selectedId: 'classic', revision: 0 }), appearanceNative = null }) {
  let window = null;
  let ready = null;
  let generation = 0;
  let hideTimer = null;
  let expiration = null;
  let feedback = null;
  let persistent = null;
  let current = null;
  let held = false;
  let heartbeat = null;
  let focusRequested = false;
  let interactiveSession = false;
  let changingVisibility = false;
  let presentation = 0;
  let surfaceEventId = null;
  let surfaceEnabled = false;
  let materialReady = false;
  let restoring = false;

  async function ensureWindow() {
    if (window && !window.isDestroyed()) return ready;
    const target = new BrowserWindow({
      ...getBounds(false), frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, focusable: false, alwaysOnTop: true, enableLargerThanScreen: true,
      skipTaskbar: true, hasShadow: false, acceptFirstMouse: true, hiddenInMissionControl: true,
      fullscreenable: false, minimizable: false, maximizable: false, roundedCorners: false, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window = target;
    installLocalWebContentsGuards(target.webContents);
    target.setAlwaysOnTop(true, 'screen-saver', alwaysOnTopLevel);
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    target.on('blur', () => { if (!changingVisibility && interactiveSession) { held = false; dismiss(); } });
    target.webContents.on('render-process-gone', () => { if (!target.isDestroyed()) target.destroy(); });
    target.on('closed', () => {
      if (window !== target) return;
      window = null; ready = null; current = null; surfaceEventId = null; surfaceEnabled = false; materialReady = false;
      held = false; interactiveSession = false; focusRequested = false; feedback = null;
      clearTimeout(expiration); clearTimeout(hideTimer);
      onClosed?.();
    });
    ready = target.loadFile(path.join(__dirname, 'renderer', 'status-island.html'))
      .then(() => target).catch(() => { if (!target.isDestroyed()) target.destroy(); return null; });
    return ready;
  }

  function hide(immediate = false) {
    generation++; restoring = false;
    current = null;
    const wasHeld = held;
    held = false;
    interactiveSession = false;
    focusRequested = false;
    if (wasHeld && feedback) expire();
    const target = window;
    clearTimeout(hideTimer);
    if (!target || target.isDestroyed() || !target.isVisible()) return;
    changingVisibility = true;
    target.setFocusable(false);
    target.webContents.send('island:status-hide');
    const finish = () => {
      if (!target.isDestroyed()) { appearanceNative?.clear(target); target.hide(); }
      surfaceEnabled = false; materialReady = false;
    };
    if (immediate) finish();
    else hideTimer = setTimeout(() => { if (!current) finish(); }, 320);
    changingVisibility = false;
  }

  async function sync() {
    const data = feedback || persistent;
    if (!isAllowed(data)) { hide(true); return; }
    if (restoring && !feedback) return;
    if (!data) { hide(); return; }
    const token = ++generation;
    const target = await ensureWindow();
    if (token !== generation || !target || target.isDestroyed() || !isAllowed(data)) return;
    clearTimeout(hideTimer);
    const bounds = getBounds(data.compact === true, data);
    target.setBounds(bounds, false);
    const wasCompact = current?.compact === true;
    if (current !== data) surfaceEventId = `status-${++presentation}`;
    current = data; surfaceEnabled = data.compact !== true;
    if (!surfaceEnabled) { appearanceNative?.clear(target); materialReady = false; }
    const wasVisible = target.isVisible();
    changingVisibility = true;
    target.setFocusable(interactiveSession && Boolean(feedback));
    changingVisibility = false;
    if (focusRequested && interactiveSession && feedback) {
      focusRequested = false;
      target.show(); target.focus();
    } else if (!wasVisible) target.showInactive();
    target.webContents.send('island:status-show', { ...data, interactive: interactiveSession && Boolean(feedback), width: bounds.width, height: bounds.height, stripHeight: getBounds(true).height, collapsedWidth: 256, eventId: surfaceEventId, appearance: getAppearance(), animate: !wasVisible || wasCompact !== (data.compact === true) });
  }

  function expire(delay = 3000) {
    clearTimeout(expiration);
    expiration = null;
    if (!held) expiration = setTimeout(() => { feedback = null; interactiveSession = false; focusRequested = false; restoreAfterFeedback(); }, delay);
  }

  function showFeedback(data) {
    restoring = false;
    const opening = !window || window.isDestroyed() || !window.isVisible() || current?.compact === true;
    const continuingInteraction = interactiveSession && feedback?.kind === data?.kind;
    if (feedback?.kind !== data?.kind || data?.adjustable !== true) held = false;
    feedback = data;
    if (data?.interactive === true) { interactiveSession = true; focusRequested = true; }
    else if (!continuingInteraction) { interactiveSession = false; focusRequested = false; }
    expire();
    return sync().then(() => { if (feedback === data) expire(opening ? 3420 : 3000); });
  }

  function syncForAppSurface() {
    // Hardware-key feedback is the user's direct action and may briefly sit over
    // an app surface. Passive recording/timer cards yield to that surface.
    if (feedback?.fromMediaKey === true || feedback?.interactive === true) return sync();
    hide(true);
    return Promise.resolve();
  }

  function setPersistent(data) { persistent = data; return sync(); }
  function hold(value) {
    if (!feedback || feedback.adjustable !== true) return;
    const next = value === true;
    if (held === next) return;
    held = next;
    if (held) clearTimeout(expiration); else expire();
  }
  function restoreAfterFeedback() {
    if (current && current.compact !== true && persistent && isAllowed(persistent)) {
      hide();
      const token = generation;
      restoring = true;
      return new Promise(resolve => setTimeout(() => {
        if (token === generation) { restoring = false; sync().then(resolve); } else resolve();
      }, 320));
    }
    return sync();
  }
  function dismiss() { clearTimeout(expiration); feedback = null; interactiveSession = false; focusRequested = false; held = false; return restoreAfterFeedback(); }
  function syncAppearance(snapshot = getAppearance()) {
    const target = window;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    if (snapshot.selectedId === 'classic') { appearanceNative?.clear(target); materialReady = false; }
    target.webContents.send('appearance:changed', snapshot);
  }
  function updateSurface(payload) {
    const target = window;
    if (!target || target.isDestroyed() || payload?.eventId !== surfaceEventId) return;
    const appearance = getAppearance();
    const values = surfaceEnabled && target.isVisible() && appearance.selectedId === 'system-glass-blurred'
      && Array.isArray(payload.surfaces) && payload.surfaces.length === 2
      ? payload.surfaces.map(surface => normalizeAppearanceSurface({ viewport: payload.viewport, surface }, target.getContentBounds())) : [];
    const applied = values.length === 2 && values.every(Boolean) && appearanceNative?.applyPair(target, values) === true;
    if (!applied) appearanceNative?.clear(target);
    if (materialReady !== applied) {
      materialReady = applied;
      target.webContents.send('island:status-material', { native: applied, appearance });
    }
  }
  function start() {
    if (!heartbeat) heartbeat = setInterval(() => { if (feedback || persistent || current) sync(); }, 1000);
    heartbeat?.unref?.();
  }
  function destroy() {
    generation++; restoring = false; clearInterval(heartbeat); clearTimeout(expiration); clearTimeout(hideTimer);
    heartbeat = null; feedback = null; persistent = null; current = null;
    held = false; interactiveSession = false; focusRequested = false;
    if (window && !window.isDestroyed()) { appearanceNative?.clear(window); window.destroy(); }
  }
  return { showFeedback, setPersistent, sync, syncForAppSurface, hold, hide, dismiss, start, destroy, syncAppearance, updateSurface,
    getWindow: () => window, getCurrent: () => current };
}

module.exports = { createIslandStatusWindow, getStatusIslandBounds };
