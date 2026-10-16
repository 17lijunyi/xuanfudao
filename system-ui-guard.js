'use strict';

function validRect(rect) {
  return rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0;
}

function overlapsSystemUI(bounds, obstacles, margin = 2) {
  if (!validRect(bounds) || !Array.isArray(obstacles)) return false;
  return obstacles.some(rect => validRect(rect)
    && rect.x < bounds.x + bounds.width + margin && rect.x + rect.width > bounds.x - margin
    && rect.y < bounds.y + bounds.height + margin && rect.y + rect.height > bounds.y - margin);
}

// Coordinates are WindowServer desktop points, matching Electron screen bounds.
// No window titles, microphone contents or user application data are collected.
function createSystemUIGuard({ read, onRefresh, intervalMs = 250,
  setInterval: schedule = setInterval, clearInterval: cancel = clearInterval } = {}) {
  let obstacles = [];
  let timer = null;
  let available = false;
  function refresh() {
    try {
      const snapshot = read();
      available = Array.isArray(snapshot);
      obstacles = available ? snapshot.filter(validRect).slice(0, 256) : [];
    } catch (_) { available = false; obstacles = []; }
    onRefresh?.();
  }
  function start() {
    if (timer !== null) return;
    refresh();
    timer = schedule(refresh, intervalMs);
    timer?.unref?.();
  }
  function stop() { if (timer !== null) cancel(timer); timer = null; obstacles = []; }
  return { start, stop, refresh, blocks: bounds => overlapsSystemUI(bounds, obstacles),
    getStatus: () => ({ available, obstacleCount: obstacles.length }) };
}

module.exports = { overlapsSystemUI, createSystemUIGuard };
