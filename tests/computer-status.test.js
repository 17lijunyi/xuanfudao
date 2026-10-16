const test = require('node:test');
const assert = require('node:assert/strict');
const { macMemory, macMemoryPressure, cpuTotals, cpuUsage, networkCounters, networkRate, createComputerStatusService } = require('../computer-status');

const vmSample = (pageSize = 16384) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free: 100.
Pages speculative: 20.
File-backed pages: 200.
Pages purgeable: 50.
Pages stored in compressor: 600.
Pages occupied by compressor: 120.
Pages tag-storage: 64.
`;

test('macOS memory excludes reclaimable cache once and uses the real 4K or 16K page size', () => {
  for (const pageSize of [4096, 16384]) {
    const memory = macMemory(vmSample(pageSize), 1000 * pageSize);
    assert.equal(memory.percent, 65);
    assert.equal(memory.used, 650 * pageSize);
    assert.equal(memory.cached, 250 * pageSize);
    assert.equal(memory.free, 100 * pageSize);
    assert.equal(memory.compressed, 120 * pageSize, 'compressed physical pages, not their uncompressed contents');
    assert.equal(memory.used + memory.available, memory.total);
    assert.equal(memory.includesCache, false);
    assert.equal(memory.used, memory.total - memory.free - memory.cached, 'retain other system/reserved memory, without hardcoded device offsets');
  }
});

test('missing, malformed or impossible VM readings remain unknown instead of displaying 0% or the cached old formula', () => {
  for (const output of ['', vmSample().replace('Pages purgeable: 50.', ''), vmSample().replace('16384 bytes', '0 bytes'), vmSample().replace('Pages free: 100.', 'Pages free: -1.'), vmSample().replace('Pages free: 100.', 'Pages free: 9999.'), vmSample().replace('Pages occupied by compressor: 120.', 'Pages occupied by compressor: 9999.')]) {
    assert.equal(macMemory(output, 1000 * 16384), null);
  }
  assert.equal(macMemory(vmSample(), 0), null);
  assert.equal(macMemory(vmSample(), NaN), null);
  assert.equal(macMemoryPressure('1\n'), 'normal');
  assert.equal(macMemoryPressure('2'), 'warning');
  assert.equal(macMemoryPressure('4'), 'critical');
  for (const output of ['', '0', '3', '__proto__', 'not available']) assert.equal(macMemoryPressure(output), null);
});

test('CPU uses sample deltas and does not invent a first or reset reading', () => {
  assert.equal(cpuUsage(null, { total: 100, idle: 30 }), null);
  assert.equal(cpuUsage({ total: 100, idle: 30 }, { total: 200, idle: 90 }), 40);
  assert.equal(cpuUsage({ total: 100, idle: 30 }, { total: 50, idle: 20 }), null);
  assert.deepEqual(cpuTotals([{ times: { user: 40, sys: 20, idle: 40 } }]), { total: 100, idle: 40 });
});

test('network counts physical Link rows once and ignores VPN loopback duplicates', () => {
  const output = `Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll
en0 1500 <Link#5> aa:bb:cc:dd:ee:ff 2 0 1024 3 0 2048 0
en0 1500 192.168.1 192.168.1.2 2 - 1024 3 - 2048 -
utun0 1500 <Link#6> 2 0 1024 3 0 2048 0
lo0 1500 <Link#1> 2 0 1024 3 0 2048 0`;
  assert.deepEqual(networkCounters(output), { en0: { received: 1024, sent: 2048 } });
  assert.deepEqual(networkRate({ en0: { received: 0, sent: 0 } }, networkCounters(output), 2000), { downloadBytesPerSecond: 512, uploadBytesPerSecond: 1024 });
  assert.equal(networkRate(null, networkCounters(output), 2000).downloadBytesPerSecond, null);
  assert.equal(networkRate(networkCounters(output), { en0: { received: 1, sent: 1 } }, 2000).downloadBytesPerSecond, null);
});

test('computer sampling coalesces requests, handles unavailable data and rebaselines after sleep', async () => {
  let time = 1000, calls = 0, ticks = 100;
  const system = { cpus: () => [{ model: 'Test CPU', times: { user: ticks, idle: ticks } }], totalmem: () => 1000, freemem: () => 300, homedir: () => '/test', networkInterfaces: () => ({ en0: [{ family: 'IPv4', internal: false }] }), uptime: () => 500, loadavg: () => [1, 2, 3] };
  const service = createComputerStatusService({ system, now: () => time, platform: 'darwin', statfs: async () => ({ bsize: 10, blocks: 100, bavail: 40 }), runFile: async () => { calls++; throw new Error('unavailable'); }, getBattery: async () => ({ ok: true, percent: 81, charging: true, onAC: true }) });
  const [first, same] = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
  assert.deepEqual(first, same); assert.equal(calls, 3);
  assert.equal(first.cpu.percent, null); assert.equal(first.network.downloadBytesPerSecond, null);
  assert.equal(first.memory.percent, null); assert.equal(first.memory.pressure, null); assert.equal(first.disk.percent, 60); assert.equal(first.battery.percent, 81);
  time += 3000; ticks += 100;
  assert.equal((await service.getSnapshot()).cpu.percent, 50);
  time += 60_000; ticks += 100;
  assert.equal((await service.getSnapshot()).cpu.percent, null);
});

test('VM and pressure failures are independent and refreshed readings recover without restarting', async () => {
  let time = 1000, vmFails = false, pressureFails = true;
  const system = { cpus: () => [{ times: { user: time, idle: time } }], totalmem: () => 1000 * 16384, freemem: () => { throw Error('must not use the cache-inclusive macOS fallback'); }, homedir: () => '/test', networkInterfaces: () => ({}), uptime: () => 500, loadavg: () => [] };
  const service = createComputerStatusService({ system, now: () => time, platform: 'darwin', statfs: async () => { throw Error('unavailable'); }, runFile: async (file, args, options) => {
    assert.ok(options.timeout <= 2000);
    if (file === '/usr/bin/vm_stat' && !vmFails) return { stdout: vmSample() };
    if (file === '/usr/sbin/sysctl' && !pressureFails) { assert.deepEqual(args, ['-n', 'kern.memorystatus_vm_pressure_level']); return { stdout: '1\n' }; }
    throw Error('unavailable');
  } });
  const first = await service.getSnapshot();
  assert.equal(first.memory.percent, 65);
  assert.equal(first.memory.pressure, null);
  time += 3000; vmFails = true; pressureFails = false;
  const failed = await service.getSnapshot();
  assert.equal(failed.memory.used, null);
  assert.equal(failed.memory.percent, null);
  assert.equal(failed.memory.pressure, 'normal');
  time += 3000; vmFails = false;
  const recovered = await service.getSnapshot();
  assert.equal(recovered.memory.percent, 65);
  assert.equal(recovered.memory.pressure, 'normal', 'pressure comes from the kernel, not percentage thresholds');
});
