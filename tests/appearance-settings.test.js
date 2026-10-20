'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CATALOG, createAppearanceSettingsService } = require('../appearance-settings');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-appearance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'appearance.json');
  return { filePath, make: (filesystem = fs) => createAppearanceSettingsService({ filePath, fs: filesystem }) };
}
test('soft glass defaults and both presets survive saved reload', async (t) => {
  const f = fixture(t), service = f.make();
  assert.deepEqual(CATALOG, [{ id: 'system-glass-blurred', name: '柔焦玻璃', transparency: 80 }, { id: 'classic', name: '纯黑', transparency: 0 }]);
  assert.equal(service.getSnapshot().selectedId, 'system-glass-blurred');
  assert.equal(service.getSnapshot().showNotchWings, true);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal((await service.setPreset('system-glass-blurred')).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), { version: 1, selectedId: 'system-glass-blurred', showNotchWings: true });
  assert.equal(f.make().getSnapshot().selectedId, 'system-glass-blurred');
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  assert.equal((await service.setPreset('classic')).ok, true);
  assert.equal(f.make().getSnapshot().selectedId, 'classic');
  assert.equal((await service.setPreset('system-glass-blurred')).ok, true);
});
test('old clear and five-glass preferences migrate to soft glass', async (t) => {
  const f = fixture(t);
  for (const selectedId of ['system-glass', 'glass-01', 'glass-02', 'glass-03', 'glass-04', 'glass-05']) {
    const before = JSON.stringify({ version: 1, selectedId });
    fs.writeFileSync(f.filePath, before);
    const service = f.make();
    assert.equal(service.getSnapshot().selectedId, 'system-glass-blurred');
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
    assert.equal((await service.setPreset('system-glass-blurred')).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(f.filePath)).selectedId, 'system-glass-blurred');
  }
});
test('removed clear glass, arbitrary CSS and paths cannot be selected or written', async (t) => {
  const f = fixture(t), service = f.make();
  const first = service.getSnapshot(); first.presets[0].name = 'tampered';
  for (const id of ['system-glass', 'glass-01', 'custom', '../system-glass', 'background:red', { id:'system-glass-blurred' }, null, 18]) {
    assert.equal((await service.setPreset(id)).error, 'invalid_preset');
  }
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(service.getSnapshot().presets[0].name, '柔焦玻璃');
});
test('damaged preferences still render glass without destroying the source file', async (t) => {
  const f = fixture(t);
  for (const value of ['{broken', 'null', '{"version":2,"selectedId":"classic"}']) {
    fs.writeFileSync(f.filePath, value);
    assert.equal(f.make().getSnapshot().selectedId, 'system-glass-blurred');
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), value);
  }
});
test('failed migration preserves the file and retries atomically', async (t) => {
  const f = fixture(t), before = '{"version":1,"selectedId":"system-glass"}';
  for (const operation of ['writeFile', 'rename']) {
    fs.writeFileSync(f.filePath, before);
    let fail = true;
    const filesystem = { ...fs, promises: { ...fs.promises, [operation]: async (...args) => {
      if (fail) throw new Error('disk_unavailable');
      return fs.promises[operation](...args);
    } } };
    const service = f.make(filesystem);
    assert.equal((await service.setPreset('system-glass-blurred')).error, 'save_failed');
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
    assert.equal(service.getSnapshot().selectedId, 'system-glass-blurred');
    fail = false;
    assert.equal((await service.setPreset('system-glass-blurred')).ok, true);
  }
});
test('concurrent migration writes serialize and remain idempotent', async (t) => {
  const f = fixture(t); let writes = 0;
  const filesystem = { ...fs, promises: { ...fs.promises, writeFile: async (...args) => {
    writes++; return fs.promises.writeFile(...args);
  } } };
  const service = f.make(filesystem);
  const results = await Promise.all([service.setPreset('system-glass-blurred'), service.setPreset('system-glass-blurred')]);
  assert.ok(results.every(r => r.ok && r.snapshot.revision === 1));
  assert.equal(writes, 1);
});

test('version 1 settings without wings default to visible and preserve the selected theme', async (t) => {
  const f = fixture(t);
  for (const selectedId of ['classic', 'system-glass-blurred']) {
    const before = JSON.stringify({ version: 1, selectedId });
    fs.writeFileSync(f.filePath, before);
    const service = f.make();
    assert.equal(service.getSnapshot().selectedId, selectedId);
    assert.equal(service.getSnapshot().showNotchWings, true);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
    assert.equal((await service.setNotchWingsVisible(false)).ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), { version: 1, selectedId, showNotchWings: false });
    assert.equal(f.make().getSnapshot().showNotchWings, false);
    assert.equal(f.make().getSnapshot().selectedId, selectedId);
  }
});

test('theme migration retains a saved wings choice and malformed optional fields use the visible default', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, selectedId: 'glass-01', showNotchWings: false }));
  const migrated = f.make();
  assert.equal(migrated.getSnapshot().showNotchWings, false);
  assert.equal((await migrated.setPreset('system-glass-blurred')).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), {
    version: 1, selectedId: 'system-glass-blurred', showNotchWings: false,
  });
  for (const showNotchWings of [null, 0, 1, 'false', 'true', {}, []]) {
    const before = JSON.stringify({ version: 1, selectedId: 'classic', showNotchWings });
    fs.writeFileSync(f.filePath, before);
    assert.equal(f.make().getSnapshot().showNotchWings, true);
    assert.equal(f.make().getSnapshot().selectedId, 'classic');
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
  }
});

test('wings choices survive restart and later theme changes without changing one another', async (t) => {
  const f = fixture(t), service = f.make();
  assert.equal((await service.setNotchWingsVisible(false)).ok, true);
  assert.equal(f.make().getSnapshot().showNotchWings, false);
  assert.equal((await service.setPreset('classic')).ok, true);
  assert.equal(f.make().getSnapshot().showNotchWings, false);
  assert.equal((await service.setNotchWingsVisible(true)).ok, true);
  const restored = f.make().getSnapshot();
  assert.equal(restored.selectedId, 'classic');
  assert.equal(restored.showNotchWings, true);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});

test('wings changes require a primitive boolean and invalid values do not alter preferences', async (t) => {
  const f = fixture(t), service = f.make();
  await service.setNotchWingsVisible(false);
  const before = fs.readFileSync(f.filePath, 'utf8');
  const snapshot = service.getSnapshot();
  for (const value of [undefined, null, 0, 1, 'false', 'true', {}, [], new Boolean(false)]) {
    const result = await service.setNotchWingsVisible(value);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_notch_wings_visibility');
    assert.deepEqual(result.snapshot, snapshot);
    assert.deepEqual(service.getSnapshot(), snapshot);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
  }
});

test('theme and wings requests share one queue and merge only after the previous save succeeds', async (t) => {
  const f = fixture(t);
  let entered, release;
  const firstWriteStarted = new Promise(resolve => { entered = resolve; });
  const firstWriteGate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const filesystem = { ...fs, promises: { ...fs.promises, writeFile: async (...args) => {
    writes++;
    if (writes === 1) { entered(); await firstWriteGate; }
    return fs.promises.writeFile(...args);
  } } };
  const service = f.make(filesystem);
  const requests = [service.setPreset('classic'), service.setNotchWingsVisible(false),
    service.setNotchWingsVisible(false), service.setPreset('system-glass-blurred'),
    service.setNotchWingsVisible(true), service.setNotchWingsVisible(false)];
  await firstWriteStarted;
  assert.equal(writes, 1);
  assert.equal(service.getSnapshot().selectedId, 'system-glass-blurred');
  assert.equal(service.getSnapshot().showNotchWings, true);
  assert.equal(service.getSnapshot().revision, 0);
  assert.equal(fs.existsSync(f.filePath), false);
  release();
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(results.map(({ snapshot }) => [snapshot.selectedId, snapshot.showNotchWings, snapshot.revision]), [
    ['classic', true, 1], ['classic', false, 2], ['classic', false, 2],
    ['system-glass-blurred', false, 3], ['system-glass-blurred', true, 4], ['system-glass-blurred', false, 5],
  ]);
  assert.equal(writes, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), {
    version: 1, selectedId: 'system-glass-blurred', showNotchWings: false,
  });
});

test('failed wings saves keep the active values and original file, clean up, and allow retry', async (t) => {
  const f = fixture(t);
  const before = JSON.stringify({ version: 1, selectedId: 'classic', showNotchWings: true });
  for (const operation of ['mkdir', 'writeFile', 'rename']) {
    fs.writeFileSync(f.filePath, before);
    let fail = true;
    const filesystem = { ...fs, promises: { ...fs.promises, [operation]: async (...args) => {
      if (fail) throw new Error('disk_unavailable');
      return fs.promises[operation](...args);
    } } };
    const service = f.make(filesystem), snapshot = service.getSnapshot();
    const result = await service.setNotchWingsVisible(false);
    assert.equal(result.error, 'save_failed');
    assert.deepEqual(result.snapshot, snapshot);
    assert.deepEqual(service.getSnapshot(), snapshot);
    assert.equal(fs.readFileSync(f.filePath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.dirname(f.filePath)), ['appearance.json']);
    fail = false;
    assert.equal((await service.setNotchWingsVisible(false)).ok, true);
    assert.equal(f.make().getSnapshot().showNotchWings, false);
    assert.equal(f.make().getSnapshot().selectedId, 'classic');
  }
});

test('a failed queued wings change cannot leak into the next successful theme save', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, selectedId: 'classic', showNotchWings: false }));
  let renames = 0;
  const filesystem = { ...fs, promises: { ...fs.promises, rename: async (...args) => {
    if (++renames === 1) throw new Error('disk_unavailable');
    return fs.promises.rename(...args);
  } } };
  const service = f.make(filesystem);
  const results = await Promise.all([service.setNotchWingsVisible(true), service.setPreset('system-glass-blurred')]);
  assert.equal(results[0].error, 'save_failed');
  assert.equal(results[1].ok, true);
  assert.equal(results[1].snapshot.revision, 1);
  assert.equal(results[1].snapshot.showNotchWings, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), {
    version: 1, selectedId: 'system-glass-blurred', showNotchWings: false,
  });
});
