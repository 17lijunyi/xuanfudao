const { execFile } = require('node:child_process');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const execute = promisify(execFile);
const READ_VOLUME_SCRIPT = `
set currentVolume to get volume settings
return (output volume of currentVolume as text) & "|" & (output muted of currentVolume as text)
`;
const WRITE_VOLUME_SCRIPT = `
on run argv
  set requestedVolume to (item 1 of argv) as integer
  set volume output volume requestedVolume
  if requestedVolume > 0 then set volume without output muted
  set currentVolume to get volume settings
  return (output volume of currentVolume as text) & "|" & (output muted of currentVolume as text)
end run
`;

function createSystemVolumeService({ platform = process.platform, runFile = execute } = {}) {
  let pending = Promise.resolve();

  function enqueue(task) {
    const result = pending.then(task);
    pending = result.catch(() => {});
    return result;
  }

  async function run(script, args, errorCode) {
    try {
      const { stdout } = await runFile('/usr/bin/osascript', ['-e', script, '--', ...args], {
        timeout: 3000,
        maxBuffer: 4096,
      });
      const [level, mutedValue] = String(stdout || '').trim().split('|');
      const volume = Number(level);
      if (!Number.isInteger(volume) || volume < 0 || volume > 100 || !['true', 'false'].includes(mutedValue)) {
        return { ok: false, error: errorCode };
      }
      return { ok: true, volume, muted: mutedValue === 'true' };
    } catch (error) {
      return { ok: false, error: errorCode };
    }
  }

  function getSystemVolume() {
    if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'unsupported' });
    return enqueue(() => run(READ_VOLUME_SCRIPT, [], 'volume_unavailable'));
  }

  function setSystemVolume(volume) {
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
      return Promise.resolve({ ok: false, error: 'invalid_volume' });
    }
    if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'unsupported' });
    // Standard Additions changes only system output volume; it does not request
    // microphone access or automate another application's interface.
    return enqueue(() => run(WRITE_VOLUME_SCRIPT, [String(volume)], 'volume_change_failed'));
  }

  return { getSystemVolume, setSystemVolume };
}

const SYSTEM_STATUS_PROTOCOL_VERSION = 1;
const SNAPSHOT_KEYS = ['volume', 'brightness', 'battery', 'output', 'hudReplacement'];

function normalizeHudReplacement(value) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean'
      || typeof value.active !== 'boolean' || !['granted', 'required', 'unknown'].includes(value.permission)) return null;
  return {
    enabled: value.enabled,
    active: value.enabled && value.active && value.permission === 'granted',
    permission: value.permission,
    error: typeof value.error === 'string' ? value.error.slice(0, 128) : null,
  };
}

function unavailable(error) {
  return { ok: false, error };
}

function unavailableSnapshot(error) {
  return {
    volume: unavailable(error),
    brightness: unavailable(error),
    battery: unavailable(error),
    output: unavailable(error),
  };
}

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};

  const volume = value.volume;
  if (volume?.ok === true && Number.isInteger(volume.volume) && volume.volume >= 0 && volume.volume <= 100
      && typeof volume.muted === 'boolean') {
    result.volume = { ok: true, volume: volume.volume, muted: volume.muted };
  } else {
    result.volume = unavailable(String(volume?.error || 'volume_unavailable'));
  }

  const brightness = value.brightness;
  if (brightness?.ok === true && Number.isInteger(brightness.brightness)
      && brightness.brightness >= 0 && brightness.brightness <= 100
      && Number.isInteger(brightness.displayId) && brightness.displayId >= 0) {
    result.brightness = {
      ok: true,
      brightness: brightness.brightness,
      displayId: brightness.displayId,
    };
  } else {
    result.brightness = unavailable(String(brightness?.error || 'brightness_unavailable'));
  }

  const battery = value.battery;
  if (battery?.ok === true && Number.isInteger(battery.percent) && battery.percent >= 0 && battery.percent <= 100
      && typeof battery.charging === 'boolean' && typeof battery.onAC === 'boolean') {
    result.battery = {
      ok: true,
      percent: battery.percent,
      charging: battery.charging,
      onAC: battery.onAC,
    };
  } else {
    result.battery = unavailable(String(battery?.error || 'battery_unavailable'));
  }

  const output = value.output;
  if (output?.ok === true && typeof output.id === 'string' && output.id.length > 0
      && output.id.length <= 512 && typeof output.name === 'string' && output.name.length <= 512
      && typeof output.kind === 'string' && output.kind.length > 0 && output.kind.length <= 64) {
    result.output = {
      ok: true,
      id: output.id,
      name: output.name,
      kind: output.kind,
    };
  } else {
    result.output = unavailable(String(output?.error || 'output_unavailable'));
  }
  const hudReplacement = normalizeHudReplacement(value.hudReplacement);
  if (hudReplacement) result.hudReplacement = hudReplacement;
  return result;
}

function snapshotChangedKeys(previous, next) {
  if (!previous) return [];
  return SNAPSHOT_KEYS.filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
}

function createSystemStatusService({
  platform = process.platform,
  helperPath,
  resourcesPath = process.resourcesPath,
  spawnProcess = spawn,
  accessFile = fs.promises.access,
  onChange = () => {},
  onError = () => {},
  onFeedback = () => {},
  onHudReplacementStatus = () => {},
  hudReplacementEnabled,
  startupTimeoutMs = 5000,
  requestTimeoutMs = 3000,
  restartBaseDelayMs = 300,
  restartMaximumDelayMs = 5000,
} = {}) {
  let child = null;
  let childReady = false;
  let desired = false;
  let currentSnapshot = null;
  let deliveredInitialBaseline = false;
  let startPromise = null;
  let startResolve = null;
  let startupTimer = null;
  let restartTimer = null;
  let restartAttempt = 0;
  let requestSequence = 0;
  let stdoutBuffer = '';
  let stderrTail = '';
  let desiredHudReplacement = typeof hudReplacementEnabled === 'boolean' ? hudReplacementEnabled : null;
  let hudCommandQueue = Promise.resolve();
  let hudLifecycleGeneration = 0;
  let hudStatus = null;
  const pending = new Map();

  function publishHudStatus(value) {
    const next = normalizeHudReplacement(value);
    if (!next || JSON.stringify(next) === JSON.stringify(hudStatus)) return;
    hudStatus = next;
    try { onHudReplacementStatus(next); } catch (_) {}
  }

  function helperCandidates() {
    if (helperPath) return [helperPath];
    return [
      resourcesPath && path.join(resourcesPath, 'native', 'system-status-helper'),
      path.join(__dirname, '.cache', 'native', 'system-status-helper'),
    ].filter(Boolean);
  }

  async function findHelper() {
    for (const candidate of helperCandidates()) {
      try {
        await accessFile(candidate, fs.constants.X_OK);
        return candidate;
      } catch (_) {}
    }
    return null;
  }

  function clearStartup() {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    startPromise = null;
    startResolve = null;
  }

  function resolveStartup(result) {
    const resolve = startResolve;
    clearStartup();
    if (resolve) resolve(result);
  }

  function resolvePending(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, error });
    }
    pending.clear();
  }

  function reportError(error, detail = '') {
    try { onError(error, String(detail || '').slice(0, 8192)); } catch (_) {}
  }

  function scheduleRestart() {
    if (!desired || restartTimer) return;
    const delay = Math.min(restartMaximumDelayMs, restartBaseDelayMs * (2 ** Math.min(5, restartAttempt++)));
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch().catch(() => {});
    }, delay);
    restartTimer.unref?.();
  }

  function childFailed(target, error) {
    if (target !== child) return;
    child = null;
    childReady = false;
    publishHudStatus({ enabled: desiredHudReplacement === true, active: false, permission: 'unknown', error });
    stdoutBuffer = '';
    resolvePending(error);
    if (startResolve) resolveStartup({ ok: false, error });
    if (desired) {
      reportError(error, stderrTail);
      scheduleRestart();
    }
  }

  function receiveMessage(target, message) {
    if (target !== child || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      const snapshot = normalizeSnapshot(message.snapshot);
      if (message.protocolVersion !== SYSTEM_STATUS_PROTOCOL_VERSION || !snapshot) {
        target.kill();
        childFailed(target, 'helper_protocol_error');
        return;
      }
      const previous = currentSnapshot;
      currentSnapshot = snapshot;
      childReady = true;
      restartAttempt = 0;
      publishHudStatus(snapshot.hudReplacement);
      if (deliveredInitialBaseline) {
        const changedKeys = snapshotChangedKeys(previous, snapshot);
        if (changedKeys.length) {
          try { onChange(snapshot, changedKeys); } catch (_) {}
        }
      } else {
        deliveredInitialBaseline = true;
      }
      resolveStartup({ ok: true, snapshot });
      if (desiredHudReplacement !== null) queueHudReplacement();
      return;
    }
    if (message.type === 'feedback') {
      const snapshot = normalizeSnapshot(message.snapshot);
      const kind = message.kind;
      if (!snapshot?.hudReplacement?.active || !['volume', 'brightness'].includes(kind)
          || !snapshot[kind]?.ok || desiredHudReplacement === false) return;
      currentSnapshot = snapshot;
      publishHudStatus(snapshot.hudReplacement);
      try { onFeedback(snapshot, kind); } catch (_) {}
      return;
    }
    if (message.type === 'change') {
      const snapshot = normalizeSnapshot(message.snapshot);
      if (!snapshot) return;
      const changedKeys = snapshotChangedKeys(currentSnapshot, snapshot);
      currentSnapshot = snapshot;
      publishHudStatus(snapshot.hudReplacement);
      if (changedKeys.length) {
        try { onChange(snapshot, changedKeys); } catch (_) {}
      }
      return;
    }
    if (message.type === 'response' && typeof message.id === 'string') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok === true && message.snapshot) {
        const snapshot = normalizeSnapshot(message.snapshot);
        if (!snapshot) {
          request.resolve({ ok: false, error: 'helper_protocol_error' });
          return;
        }
        const changedKeys = deliveredInitialBaseline ? snapshotChangedKeys(currentSnapshot, snapshot) : [];
        currentSnapshot = snapshot;
        publishHudStatus(snapshot.hudReplacement);
        if (changedKeys.length) {
          try { onChange(snapshot, changedKeys); } catch (_) {}
        }
        const result = { ok: true, snapshot };
        if (request.command === 'setVolume') result.volume = snapshot.volume;
        if (request.command === 'setBrightness') result.brightness = snapshot.brightness;
        if (request.command === 'setHudReplacement') {
          if (!snapshot.hudReplacement) {
            request.resolve({ ok: false, error: 'hud_replacement_unavailable' });
            return;
          }
          result.hudReplacement = snapshot.hudReplacement;
        }
        request.resolve(result);
      } else {
        request.resolve(message.ok === true && request.command === 'setHudReplacement'
          ? { ok: false, error: 'hud_replacement_unavailable' }
          : message.ok === true
          ? { ok: true }
          : { ok: false, error: String(message.error || 'system_status_failed') });
      }
    }
  }

  function receiveOutput(target, chunk) {
    if (target !== child) return;
    stdoutBuffer += chunk.toString('utf8');
    if (stdoutBuffer.length > 512 * 1024) {
      target.kill();
      childFailed(target, 'helper_protocol_error');
      return;
    }
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { receiveMessage(target, JSON.parse(line)); }
      catch (_) {
        target.kill();
        childFailed(target, 'helper_protocol_error');
        return;
      }
    }
  }

  async function launch() {
    if (platform !== 'darwin') return { ok: false, error: 'unsupported' };
    if (!desired) return { ok: false, error: 'service_stopped' };
    if (startPromise) return startPromise;
    if (child && childReady && currentSnapshot) return { ok: true, snapshot: currentSnapshot };
    startPromise = new Promise((resolve) => { startResolve = resolve; });
    const executable = await findHelper();
    if (!desired) {
      resolveStartup({ ok: false, error: 'service_stopped' });
      return { ok: false, error: 'service_stopped' };
    }
    if (!executable) {
      resolveStartup({ ok: false, error: 'helper_unavailable' });
      reportError('helper_unavailable');
      return { ok: false, error: 'helper_unavailable' };
    }
    let target;
    try {
      target = spawnProcess(executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolveStartup({ ok: false, error: 'helper_launch_failed' });
      reportError('helper_launch_failed', error?.message);
      scheduleRestart();
      return { ok: false, error: 'helper_launch_failed' };
    }
    child = target;
    childReady = false;
    stdoutBuffer = '';
    stderrTail = '';
    target.stdout.on('data', (chunk) => receiveOutput(target, chunk));
    target.stderr.on('data', (chunk) => {
      if (target === child) stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-8192);
    });
    target.once('error', (error) => {
      reportError('helper_launch_failed', error?.message);
      childFailed(target, 'helper_launch_failed');
    });
    target.once('exit', (code, signal) => {
      if (target !== child) return;
      const expected = !desired;
      childFailed(target, expected ? 'service_stopped' : 'helper_exited');
      if (!expected) reportError('helper_exited', `${code ?? ''}:${signal ?? ''}`);
    });
    startupTimer = setTimeout(() => {
      if (target !== child || !startResolve) return;
      target.kill();
      childFailed(target, 'helper_start_timeout');
    }, startupTimeoutMs);
    startupTimer.unref?.();
    return startPromise;
  }

  async function start() {
    desired = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    return launch();
  }

  async function request(command, value) {
    const started = await start();
    if (!started.ok || !child || child.killed || !child.stdin?.writable) return started;
    const target = child;
    const id = `${Date.now().toString(36)}-${++requestSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: 'helper_request_timeout' });
        if (target === child) target.kill();
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { command, resolve, timer });
      const payload = value === undefined ? { id, command } : { id, command, value };
      target.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error || !pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: 'helper_write_failed' });
      });
    });
  }

  function getSnapshot() {
    if (platform !== 'darwin') return Promise.resolve(unavailableSnapshot('unsupported'));
    return request('getSnapshot').then((result) => result.ok
      ? result.snapshot
      : unavailableSnapshot(result.error));
  }

  function setVolume(volume) {
    if (typeof volume !== 'number' || !Number.isInteger(volume) || volume < 0 || volume > 100) {
      return Promise.resolve({ ok: false, error: 'invalid_volume' });
    }
    if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'unsupported' });
    return request('setVolume', volume).then((result) => {
      if (!result.ok) return result;
      if (!result.volume?.ok) return unavailable(result.volume?.error || 'volume_change_failed');
      return { ...result.volume, snapshot: result.snapshot };
    });
  }

  function setBrightness(brightness) {
    if (typeof brightness !== 'number' || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) {
      return Promise.resolve({ ok: false, error: 'invalid_brightness' });
    }
    if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'unsupported' });
    return request('setBrightness', brightness).then((result) => {
      if (!result.ok) return result;
      if (!result.brightness?.ok) return unavailable(result.brightness?.error || 'brightness_change_failed');
      return { ...result.brightness, snapshot: result.snapshot };
    });
  }

  function queueHudReplacement() {
    // Keep preference updates in order. A queued enable uses the latest intent,
    // so it cannot turn interception back on after the user has disabled it.
    const generation = hudLifecycleGeneration;
    const next = hudCommandQueue.catch(() => {}).then(async () => {
      if (generation !== hudLifecycleGeneration) return { ok: false, error: 'service_stopped' };
      if (desiredHudReplacement === null) return { ok: false, error: 'hud_replacement_unavailable' };
      return request('setHudReplacement', desiredHudReplacement);
    });
    hudCommandQueue = next;
    return next;
  }

  function setHudReplacement(enabled) {
    if (typeof enabled !== 'boolean') return Promise.resolve({ ok: false, error: 'invalid_hud_replacement' });
    if (platform !== 'darwin') return Promise.resolve({ ok: false, error: 'unsupported' });
    desiredHudReplacement = enabled;
    return queueHudReplacement();
  }

  async function stop() {
    desired = false;
    hudLifecycleGeneration++;
    publishHudStatus({ enabled: desiredHudReplacement === true, active: false, permission: 'unknown', error: 'service_stopped' });
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
    const target = child;
    if (!target) {
      if (startResolve) resolveStartup({ ok: false, error: 'service_stopped' });
      return { ok: true };
    }
    child = null;
    childReady = false;
    resolvePending('service_stopped');
    if (startResolve) resolveStartup({ ok: false, error: 'service_stopped' });
    try {
      if (target.stdin?.writable) {
        target.stdin.write(`${JSON.stringify({ id: `stop-${Date.now()}`, command: 'shutdown' })}\n`);
      }
    } catch (_) {}
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      target.once('exit', finish);
      const timer = setTimeout(() => {
        try { target.kill(); } catch (_) {}
        finish();
      }, 500);
      timer.unref?.();
    });
    return { ok: true };
  }

  return { start, stop, getSnapshot, setVolume, setBrightness, setHudReplacement };
}

const volumeService = createSystemVolumeService();
module.exports = {
  ...volumeService,
  createSystemVolumeService,
  createSystemStatusService,
  normalizeSnapshot,
  snapshotChangedKeys,
  SYSTEM_STATUS_PROTOCOL_VERSION,
};
