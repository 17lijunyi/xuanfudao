function cleanActivity(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.kind === 'recording') {
    if (!['idle', 'recording', 'paused', 'saving'].includes(payload.status)) return null;
    if (!Number.isFinite(payload.elapsedMs) || payload.elapsedMs < 0 || payload.elapsedMs > 7 * 86400000) return null;
    return { kind: 'recording', status: payload.status, elapsedMs: Math.round(payload.elapsedMs), updatedAt: Date.now() };
  }
  if (payload.kind === 'timer') {
    if (typeof payload.active !== 'boolean' || typeof payload.running !== 'boolean') return null;
    if (!Number.isFinite(payload.remainingSeconds) || payload.remainingSeconds < 0 || payload.remainingSeconds > 3660) return null;
    if (payload.running && (!Number.isFinite(payload.endAt) || payload.endAt <= 0)) return null;
    const duration = Number.isInteger(payload.durationSeconds) && payload.durationSeconds >= 0 && payload.durationSeconds <= 3660 ? payload.durationSeconds : payload.remainingSeconds;
    return { kind: 'timer', active: payload.active, running: payload.running, remainingSeconds: Math.round(payload.remainingSeconds), durationSeconds: duration, phase: payload.phase === 'break' ? 'break' : 'focus', focusSeconds: Number.isInteger(payload.focusSeconds) && payload.focusSeconds > 0 && payload.focusSeconds <= 3660 ? payload.focusSeconds : duration, endAt: payload.running ? payload.endAt : null };
  }
  return null;
}

function clockText(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function selectIslandActivity(activities, now = Date.now()) {
  const recording = activities.recording;
  if (recording && recording.status !== 'idle') {
    const elapsed = recording.elapsedMs + (recording.status === 'recording' ? Math.max(0, now - recording.updatedAt) : 0);
    return { kind: 'recording', compact: true, title: recording.status === 'paused' ? '录音已暂停' : recording.status === 'saving' ? '正在保存录音' : '正在录音', value: clockText(elapsed / 1000), target: 'recordings' };
  }
  const timer = activities.timer;
  if (timer?.active && !(timer.running && timer.endAt <= now)) {
    const remaining = timer.running ? Math.max(0, Math.ceil((timer.endAt - now) / 1000)) : timer.remainingSeconds;
    return { kind: 'timer', compact: true, title: timer.running ? (timer.phase === 'break' ? '休息时间' : '专注时间') : '计时已暂停', value: clockText(remaining), target: 'home' };
  }
  return null;
}

function systemFeedback(snapshot, changedKeys) {
  const changed = new Set(changedKeys || []);
  if (changed.has('output') && snapshot.output?.ok) return {
    kind: snapshot.output.kind === 'headphones' || snapshot.output.kind === 'bluetooth' ? 'headphones' : 'output',
    title: '声音输出已切换', detail: snapshot.output.name, compact: false,
  };
  if (changed.has('brightness') && snapshot.brightness?.ok) return {
    kind: 'brightness', title: '屏幕亮度', value: snapshot.brightness.brightness, adjustable: true,
  };
  if (changed.has('volume') && snapshot.volume?.ok) return {
    kind: 'volume', title: snapshot.volume.muted ? '已静音' : '音量',
    value: snapshot.volume.muted ? 0 : snapshot.volume.volume, muted: snapshot.volume.muted,
    detail: snapshot.output?.ok ? snapshot.output.name : '', adjustable: true,
  };
  if (changed.has('battery') && snapshot.battery?.ok) return {
    kind: 'battery', title: snapshot.battery.charging ? '正在充电' : snapshot.battery.onAC ? '已连接电源' : '使用电池',
    value: `${snapshot.battery.percent}%`, compact: false,
  };
  return null;
}

function hasCodexAttention(snapshot) {
  const liveAttention = Array.isArray(snapshot?.attentionTasks)
    && snapshot.attentionTasks.some((task) => task?.status === 'attention'
      && ['permission', 'input'].includes(task.attentionKind));
  const recentIssue = Array.isArray(snapshot?.recentIssueTasks)
    && snapshot.recentIssueTasks.some((task) => ['failed', 'interrupted'].includes(task?.status));
  return liveAttention || recentIssue;
}

function statusIslandSurfaceAllowed(data, {
  isQuitting = false,
  notificationActive = false,
  notificationVisible = false,
  codexAttentionActive = false,
  passiveAllowed = false,
} = {}) {
  if (isQuitting || notificationActive || notificationVisible) return false;
  // Hardware keys and explicit island buttons are direct user actions. Passive
  // recording/timer/device surfaces yield to a Codex task that needs the user.
  if (data?.fromMediaKey === true || data?.interactive === true) return true;
  return codexAttentionActive !== true && passiveAllowed === true;
}

module.exports = { cleanActivity, clockText, selectIslandActivity, systemFeedback,
  hasCodexAttention, statusIslandSurfaceAllowed };
