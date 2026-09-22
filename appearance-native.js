'use strict';
const fs = require('node:fs');
const path = require('node:path');

// The only caller is Electron's main process. The renderer supplies geometry,
// never handles, filenames or AppKit selectors. The native module also verifies
// that a handle belongs to a live NSApp view before using it.
function createAppearanceNativeController({ platform = process.platform, addonPath, loadAddon = require, onError = () => {} } = {}) {
  let native = null;
  let attempted = false;
  let unavailable = null;
  const watched = new Map();
  const validWindow = window => window && typeof window.isDestroyed === 'function' && !window.isDestroyed();
  function load() {
    if (attempted) return native;
    attempted = true;
    if (platform !== 'darwin') { unavailable = 'unsupported-platform'; return null; }
    const candidates = [addonPath, path.join(__dirname, 'native', 'appearance-glass.node'), path.join(__dirname, '.cache', 'native', 'appearance-glass.node'), process.resourcesPath && path.join(process.resourcesPath, 'native', 'appearance-glass.node')].filter(Boolean);
    const selected = candidates.find(file => fs.existsSync(file));
    if (!selected) { unavailable = 'native-addon-missing'; return null; }
    try {
      native = loadAddon(selected);
      if (typeof native.apply !== 'function' || typeof native.clear !== 'function') throw new Error('Invalid native appearance module');
    } catch (error) { native = null; unavailable = 'native-addon-unavailable'; onError(error); }
    return native;
  }
  function clear(window) {
    if (!native || !validWindow(window)) return false;
    try { return native.clear(window.getNativeWindowHandle()) === true; }
    catch (error) { onError(error); return false; }
  }
  function pinWindow(window) {
    if (!validWindow(window)) return false;
    try { return load()?.pinWindow?.(window.getNativeWindowHandle()) === true; }
    catch (error) { onError(error); return false; }
  }
  function watch(window) {
    if (watched.has(window)) return;
    const reset = () => clear(window);
    const closed = () => { watched.delete(window); };
    window.on('resize', reset);
    window.on('hide', reset);
    window.once('closed', closed);
    watched.set(window, { reset, closed });
  }
  function validatedShape(window, shape) {
    if (!validWindow(window) || !shape) return null;
    const bounds = window.getContentBounds();
    const x = shape.x ?? 0, y = shape.y ?? 0, opacity = shape.opacity ?? 1;
    const { width, height } = shape;
    const radii = shape.radii ?? [0, 0, 0, 0];
    const backgroundBlurRadius = shape.backgroundBlurRadius ?? 0;
    if (![x, y, width, height, opacity].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > bounds.width + 1 || y + height > bounds.height + 1 || opacity < 0 || opacity > 1 ||
      !Array.isArray(radii) || radii.length !== 4 || radii.some(radius => !Number.isFinite(radius) || radius < 0) ||
      !Number.isInteger(backgroundBlurRadius) || backgroundBlurRadius < 0 || backgroundBlurRadius > 32) {
      return null;
    }
    return { x, y, width, height, radii, opacity, backgroundBlurRadius };
  }
  function apply(window, shape) {
    const value = validatedShape(window, shape);
    if (!value) { clear(window); return false; }
    const { opacity } = value;
    if (opacity <= 0 || !load()) { clear(window); return false; }
    watch(window);
    try { return native.apply(window.getNativeWindowHandle(), value) === true; }
    catch (error) { clear(window); onError(error); return false; }
  }
  function applyPair(window, shapes) {
    const values = Array.isArray(shapes) && shapes.length === 2
      ? shapes.map(shape => validatedShape(window, shape)) : [];
    if (values.length !== 2 || values.some(value => !value)
      || values.every(value => value.opacity <= 0) || !load() || native.regionSlots !== 2) {
      clear(window); return false;
    }
    watch(window);
    try {
      const handle = window.getNativeWindowHandle();
      for (let slot = 0; slot < 2; slot++) {
        if (native.apply(handle, { ...values[slot], slot }) !== true) { clear(window); return false; }
      }
      return true;
    } catch (error) { clear(window); onError(error); return false; }
  }
  function dispose() {
    for (const [window, handlers] of watched) {
      clear(window);
      window.removeListener('resize', handlers.reset);
      window.removeListener('hide', handlers.reset);
      window.removeListener('closed', handlers.closed);
    }
    watched.clear();
  }
  function readSystemUIBounds() {
    try { return load()?.systemUIBounds?.() ?? null; }
    catch (error) { onError(error); return null; }
  }
  return { apply, applyPair, clear, pinWindow, dispose, readSystemUIBounds,
    getStatus: () => ({ available: Boolean(native), reason: unavailable }) };
}
module.exports = { createAppearanceNativeController };
