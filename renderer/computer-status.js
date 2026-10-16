(() => {
  'use strict';

  const statusView = document.getElementById('computer-status-view');
  const recordingsView = document.getElementById('recording-library-view');
  const summary = document.getElementById('home-computer');
  const updatedLabel = document.getElementById('computer-updated');
  if (!statusView || !recordingsView || !summary) return;

  let currentTab = document.querySelector('.tab.active')?.dataset.tab || 'home';
  let expanded = document.getElementById('app')?.classList.contains('expanded') || false;
  let subview = 'status';
  let active = false;
  let timer = null;
  let revision = 0;
  let pending = null;
  let lastSnapshot = null;

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function percentage(value) {
    const number = finiteNumber(value);
    return number === null ? null : Math.min(100, number);
  }

  function percentText(value) {
    return value === null ? '—' : `${Math.round(value)}%`;
  }

  function bytesText(value, suffix = '') {
    const bytes = finiteNumber(value);
    if (bytes === null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let scaled = bytes;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    const digits = unit > 0 && scaled < 100 ? 1 : 0;
    return `${scaled.toFixed(digits)} ${units[unit]}${suffix}`;
  }

  function uptimeText(value) {
    const seconds = finiteNumber(value);
    if (seconds === null) return '—';
    const minutes = Math.floor(seconds / 60);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    const rest = minutes % 60;
    if (days) return `${days} 天 ${hours} 小时`;
    if (hours) return `${hours} 小时 ${rest} 分钟`;
    return minutes ? `${minutes} 分钟` : '不足 1 分钟';
  }

  function setValue(key, value) {
    document.querySelectorAll(`[data-computer-value="${key}"]`).forEach((node) => { node.textContent = value; });
  }

  function setMeter(key, value) {
    document.querySelectorAll(`[data-computer-meter="${key}"]`).forEach((node) => {
      node.dataset.available = String(value !== null);
      node.style.setProperty('--computer-meter-value', `${value === null ? 0 : value}%`);
      node.setAttribute('aria-hidden', 'true');
    });
  }

  function usageDetail(section) {
    const total = finiteNumber(section?.total);
    const used = finiteNumber(section?.used);
    const available = finiteNumber(section?.available);
    if (total === null || used === null) return '暂不可用';
    const capacity = `${bytesText(used)} / ${bytesText(total)}`;
    return available === null ? `${capacity} 已用` : `${capacity} 已用 · ${bytesText(available)} 可用`;
  }

  function memoryCapacity(section) {
    if (finiteNumber(section?.used) === null || finiteNumber(section?.total) === null) return '暂不可用';
    const used = bytesText(section.used);
    const total = bytesText(section.total).replace(/\.0(?= )/, '');
    const unit = total.split(' ').at(-1);
    return `${used.endsWith(` ${unit}`) ? used.slice(0, -(unit.length + 1)) : used} / ${total}`;
  }

  function paint(snapshot) {
    const cpu = percentage(snapshot?.cpu?.percent);
    const memory = percentage(snapshot?.memory?.percent);
    const disk = percentage(snapshot?.disk?.percent);
    const battery = snapshot?.battery;
    const batteryPercent = battery?.present === false ? null : percentage(battery?.percent);
    const connected = snapshot?.network?.connected;
    const networkState = connected === true ? '网络接口已接通' : connected === false ? '网络接口未接通' : '网络接口状态暂不可用';
    const platform = snapshot?.platform === 'darwin' ? 'macOS' : typeof snapshot?.platform === 'string' && snapshot.platform.trim() ? snapshot.platform.trim() : '系统信息暂不可用';

    setValue('cpuPercent', percentText(cpu));
    setValue('memoryPercent', percentText(memory));
    setValue('diskPercent', percentText(disk));
    setValue('batteryPercent', battery?.present === false ? '无电池' : percentText(batteryPercent));
    const memoryData = snapshot?.memory;
    const capacity = memoryCapacity(memoryData);
    setValue('memoryCapacity', capacity === '暂不可用' ? '—' : capacity);
    const memoryDetail = capacity === '暂不可用' ? capacity : memoryData?.includesCache === true
      ? `${capacity} 已用 · 含系统缓存`
      : `${capacity} 已用\n缓存 ${bytesText(memoryData?.cached)} · 压缩 ${bytesText(memoryData?.compressed)}`;
    setValue('memoryDetail', memoryDetail);
    const pressureState = ['normal', 'warning', 'critical'].includes(memoryData?.pressure) ? memoryData.pressure : 'unavailable';
    const pressureText = { normal: '正常', warning: '偏高', critical: '高', unavailable: '暂不可用' }[pressureState];
    setValue('memoryPressure', `内存压力：${pressureText}`);
    document.querySelectorAll('[data-computer-value="memoryPressure"]').forEach((node) => { node.dataset.state = pressureState; });
    const summaryMemory = summary.querySelector('[data-computer-value="memoryPercent"]')?.closest('.computer-summary-item');
    if (summaryMemory) summaryMemory.title = `${memoryDetail}\n内存压力：${pressureText}`;
    setValue('diskDetail', usageDetail(snapshot?.disk));
    const load = Array.isArray(snapshot?.load) ? finiteNumber(snapshot.load[0]) : null;
    setValue('cpuDetail', cpu === null ? '暂不可用' : load === null ? '所有处理器的平均使用率' : `过去 1 分钟平均负载 ${load.toFixed(2)}`);

    let batteryState = '电源状态暂不可用';
    let batteryDetail = '暂不可用';
    if (battery?.present === false) {
      batteryState = '无内置电池';
      batteryDetail = '这台电脑未检测到内置电池';
    } else if (battery) {
      batteryState = battery.charging === true ? '正在充电' : battery.onBattery === true ? '使用电池' : battery.onBattery === false ? '电源供电' : '电源状态暂不可用';
      batteryDetail = batteryPercent === null ? '暂不可用' : battery.charging === true ? '电池正在补充电量' : batteryPercent >= 100 ? '电量已充满' : battery.onBattery === false ? '已连接外部电源' : '当前电池剩余电量';
    }
    setValue('batteryState', batteryState);
    setValue('batteryDetail', batteryDetail);
    setValue('networkState', networkState);
    setValue('downloadRate', bytesText(snapshot?.network?.downloadBytesPerSecond, '/s'));
    setValue('uploadRate', bytesText(snapshot?.network?.uploadBytesPerSecond, '/s'));
    setValue('uptime', uptimeText(snapshot?.uptimeSeconds));
    setValue('platform', platform);
    document.getElementById('computer-model').textContent = typeof snapshot?.model === 'string' && snapshot.model.trim()
      ? snapshot.model.trim()
      : snapshot ? '这台电脑' : '设备信息暂不可用';
    setMeter('cpu', cpu);
    setMeter('memory', memory);
    setMeter('disk', disk);
    setMeter('battery', batteryPercent);

    const timestamp = finiteNumber(snapshot?.updatedAt);
    if (timestamp !== null && timestamp > 0) {
      updatedLabel.textContent = `更新于 ${new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      updatedLabel.dataset.state = 'ready';
    } else {
      updatedLabel.textContent = '状态暂不可用';
      updatedLabel.dataset.state = 'unavailable';
    }
  }

  function isVisible() {
    if (!expanded || document.hidden) return false;
    if (currentTab === 'recordings') return subview === 'status';
    return currentTab === 'home' && window.NotchHome?.isVisible?.('windows') !== false;
  }

  function setLoading(loading) {
    document.querySelectorAll('[data-computer-refresh]').forEach((button) => {
      button.disabled = loading;
      button.setAttribute('aria-busy', String(loading));
    });
  }

  async function refresh() {
    if (!active || pending) return pending;
    const token = revision;
    const reader = window.notchAPI?.getComputerStatus;
    if (typeof reader !== 'function') {
      if (!lastSnapshot) paint(null);
      updatedLabel.textContent = '状态暂不可用';
      updatedLabel.dataset.state = 'unavailable';
      return null;
    }
    setLoading(true);
    pending = Promise.resolve().then(() => reader());
    try {
      const snapshot = await pending;
      if (!active || token !== revision) return null;
      if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) throw new Error('status_unavailable');
      lastSnapshot = snapshot;
      paint(snapshot);
      return snapshot;
    } catch (_) {
      if (active && token === revision) {
        if (!lastSnapshot) paint(null);
        updatedLabel.textContent = lastSnapshot ? '暂时无法刷新 · 显示上次读数' : '暂时无法读取 · 点击刷新重试';
        updatedLabel.dataset.state = 'unavailable';
      }
      return null;
    } finally {
      pending = null;
      setLoading(false);
      if (active && token !== revision) void refresh();
    }
  }

  function syncVisibility() {
    const next = isVisible();
    summary.dataset.active = String(next && currentTab === 'home');
    statusView.dataset.active = String(next && currentTab === 'recordings');
    if (next === active) return;
    active = next;
    revision++;
    clearInterval(timer);
    timer = null;
    if (active) {
      void refresh();
      timer = setInterval(() => { void refresh(); }, 3000);
    }
  }

  function setSubview(next) {
    const panel = document.getElementById('tab-recordings');
    const source = window.cardReflow?.capturePage(panel);
    subview = next === 'recordings' ? 'recordings' : 'status';
    statusView.hidden = subview !== 'status';
    statusView.inert = subview !== 'status';
    statusView.setAttribute('aria-hidden', String(subview !== 'status'));
    recordingsView.hidden = subview !== 'recordings';
    recordingsView.inert = subview !== 'recordings';
    recordingsView.setAttribute('aria-hidden', String(subview !== 'recordings'));
    syncVisibility();
    void window.cardReflow?.playPage(source, panel);
  }

  function openStatus() {
    setSubview('status');
    document.getElementById('tab-button-recordings')?.click();
  }

  function openRecordings() {
    setSubview('recordings');
  }

  document.querySelectorAll('[data-computer-refresh]').forEach((button) => button.addEventListener('click', () => { void refresh(); }));
  document.querySelector('[data-computer-open]')?.addEventListener('click', openStatus);
  document.getElementById('computer-open-recordings')?.addEventListener('click', openRecordings);
  document.getElementById('computer-back-status')?.addEventListener('click', () => setSubview('status'));
  document.getElementById('tab-button-recordings')?.addEventListener('click', () => setSubview('status'));
  document.addEventListener('notch:open-recording-library', openRecordings);
  document.addEventListener('notch:tabchange', (event) => {
    currentTab = event.detail?.tab || 'home';
    syncVisibility();
  });
  document.addEventListener('notch:modechange', (event) => {
    expanded = event.detail?.expanded === true;
    syncVisibility();
  });
  document.addEventListener('notch:home-modules-changed', syncVisibility);
  document.addEventListener('visibilitychange', syncVisibility);
  const unsubscribe = window.notchAPI?.onComputerStatus?.((snapshot) => {
    if (!active || !snapshot || snapshot.ok === false) return;
    lastSnapshot = snapshot;
    paint(snapshot);
  });
  window.addEventListener('beforeunload', () => {
    active = false;
    revision++;
    clearInterval(timer);
    if (typeof unsubscribe === 'function') unsubscribe();
  });

  window.ComputerStatusView = Object.freeze({ refresh, openStatus, openRecordings });
  syncVisibility();
})();
