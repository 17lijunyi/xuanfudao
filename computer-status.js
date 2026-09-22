'use strict';

const os = require('node:os');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const percent = (used, total) => finite(used) && finite(total) && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;

function macMemory(output, total) {
  if (!finite(total) || total <= 0) return null;
  const text = String(output);
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1024 || pageSize > 1024 * 1024 || !Number.isInteger(Math.log2(pageSize))) return null;
  const pages = new Map([...text.matchAll(/^([^:\n]+):\s*(\d+)\.\s*$/gm)].map((match) => [match[1].trim(), Number(match[2])]));
  const values = ['Pages free', 'File-backed pages', 'Pages purgeable', 'Pages occupied by compressor'].map((key) => {
    const count = pages.get(key);
    return Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(count * pageSize) ? count * pageSize : null;
  });
  if (values.some((value) => value === null)) return null;
  const [free, fileBacked, purgeable, compressed] = values;
  const cached = fileBacked + purgeable;
  // vm_stat's "Pages free" already excludes speculative pages; those pages
  // are included in file-backed cache. Do not subtract them a second time.
  // Keep system/reserved physical memory in used instead of losing it when
  // summing only anonymous, wired and compressor pages on newer macOS.
  const available = free + cached;
  const used = total - available;
  if (!Number.isSafeInteger(available) || available > total || compressed > used) return null;
  return { total, available, used, free, cached, compressed, percent: percent(used, total), includesCache: false };
}

function macMemoryPressure(output) {
  const level = String(output).trim();
  return level === '1' ? 'normal' : level === '2' ? 'warning' : level === '4' ? 'critical' : null;
}

function cpuTotals(cpus) {
  if (!Array.isArray(cpus) || !cpus.length) return null;
  let total = 0, idle = 0;
  for (const cpu of cpus) {
    const values = Object.values(cpu.times || {});
    if (!values.length || values.some((value) => !finite(value)) || !finite(cpu.times.idle)) return null;
    total += values.reduce((sum, value) => sum + value, 0);
    idle += cpu.times.idle;
  }
  return { total, idle };
}

function cpuUsage(previous, current) {
  if (!previous || !current) return null;
  const total = current.total - previous.total;
  const idle = current.idle - previous.idle;
  return total > 0 && idle >= 0 && idle <= total ? percent(total - idle, total) : null;
}

function networkCounters(output) {
  const counters = {};
  for (const line of String(output).split('\n')) {
    const fields = line.trim().split(/\s+/);
    // Link rows only: IP rows repeat the same counters. Ignore tunnel/loopback
    // devices to avoid counting the same VPN traffic twice.
    if (!/^(en\d+|bridge\d+|bond\d+)$/.test(fields[0]) || !/^<Link#/.test(fields[2])) continue;
    const tail = fields.slice(-7);
    if (tail.length !== 7 || !tail.every((value) => /^\d+$/.test(value))) continue;
    counters[fields[0]] = { received: Number(tail[2]), sent: Number(tail[5]) };
  }
  return counters;
}

function networkRate(previous, current, elapsedMs) {
  if (!previous || !current || elapsedMs <= 0 || elapsedMs > 30_000) return { downloadBytesPerSecond: null, uploadBytesPerSecond: null };
  let received = 0, sent = 0, samples = 0;
  for (const [name, value] of Object.entries(current)) {
    const before = previous[name];
    if (!before || value.received < before.received || value.sent < before.sent) continue;
    received += value.received - before.received;
    sent += value.sent - before.sent;
    samples++;
  }
  return {
    downloadBytesPerSecond: samples ? received * 1000 / elapsedMs : null,
    uploadBytesPerSecond: samples ? sent * 1000 / elapsedMs : null,
  };
}

function createComputerStatusService({ system = os, statfs = fs.statfs, runFile = execute, now = Date.now, getBattery = async () => null, platform = process.platform } = {}) {
  let pending = null, snapshot = null, previousCpu = null, previousNetwork = null, previousAt = null;
  let disk = null, diskAt = 0;

  async function collect() {
    const sampledAt = now();
    const cpus = system.cpus();
    const currentCpu = cpuTotals(cpus);
    // A long pause is a new baseline, not an instantaneous CPU reading.
    const cpu = { percent: previousAt !== null && sampledAt - previousAt <= 30_000 ? cpuUsage(previousCpu, currentCpu) : null, cores: cpus.length };
    const total = system.totalmem();
    let memory = { total: finite(total) && total > 0 ? total : null, available: null, used: null, free: null, cached: null, compressed: null, percent: null, includesCache: platform !== 'darwin', pressure: null };
    if (platform !== 'darwin') {
      const available = system.freemem();
      if (finite(available) && finite(total) && total > 0 && available <= total) {
        memory = { ...memory, available, used: total - available, percent: percent(total - available, total) };
      }
    }
    const results = await Promise.allSettled([
      !disk || sampledAt - diskAt >= 60_000 ? statfs(system.homedir()) : Promise.resolve(null),
      platform === 'darwin' ? runFile('/usr/sbin/netstat', ['-ibn'], { timeout: 2000, maxBuffer: 256 * 1024 }) : Promise.resolve(null),
      getBattery(),
      platform === 'darwin' ? runFile('/usr/bin/vm_stat', [], { timeout: 2000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } }) : Promise.resolve(null),
      platform === 'darwin' ? runFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 2000, maxBuffer: 4096 }) : Promise.resolve(null),
    ]);
    if (results[3].status === 'fulfilled' && results[3].value) {
      memory = { ...memory, ...macMemory(results[3].value.stdout, total) };
    }
    if (results[4].status === 'fulfilled' && results[4].value) {
      memory.pressure = macMemoryPressure(results[4].value.stdout);
    }
    if (results[0].status === 'fulfilled' && results[0].value) {
      const stats = results[0].value;
      const diskTotal = Number(stats.bsize) * Number(stats.blocks);
      const diskAvailable = Number(stats.bsize) * Number(stats.bavail);
      if (finite(diskTotal) && diskTotal > 0 && finite(diskAvailable) && diskAvailable <= diskTotal) {
        disk = { total: diskTotal, available: diskAvailable, used: diskTotal - diskAvailable, percent: percent(diskTotal - diskAvailable, diskTotal) };
        diskAt = sampledAt;
      }
    }
    const currentNetwork = results[1].status === 'fulfilled' && results[1].value ? networkCounters(results[1].value.stdout) : null;
    const network = networkRate(previousNetwork, currentNetwork, previousAt === null ? 0 : sampledAt - previousAt);
    network.connected = Object.entries(system.networkInterfaces()).some(([name, addresses]) => /^(en\d+|bridge\d+|bond\d+)$/.test(name) && addresses?.some((entry) => !entry.internal && (entry.family === 'IPv4' || entry.family === 4)));
    const value = results[2].status === 'fulfilled' ? results[2].value : null;
    const battery = value?.ok && finite(value.percent) ? { present: true, percent: value.percent, charging: value.charging === true, onBattery: value.onAC === false } : { present: value?.error === 'no_battery' ? false : null, percent: null, charging: null, onBattery: null };
    previousCpu = currentCpu;
    previousNetwork = currentNetwork;
    previousAt = sampledAt;
    snapshot = { updatedAt: sampledAt, cpu, memory, disk: disk || { total: null, available: null, used: null, percent: null }, network, uptimeSeconds: system.uptime(), battery, platform, model: cpus[0]?.model || '', load: system.loadavg() };
    return structuredClone(snapshot);
  }

  function getSnapshot() {
    if (pending) return pending;
    if (snapshot && now() - snapshot.updatedAt < 1000) return Promise.resolve(structuredClone(snapshot));
    pending = collect().finally(() => { pending = null; });
    return pending;
  }
  return { getSnapshot };
}

module.exports = { macMemory, macMemoryPressure, cpuTotals, cpuUsage, networkCounters, networkRate, createComputerStatusService };
