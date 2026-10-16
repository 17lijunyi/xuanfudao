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
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal((await service.setPreset('system-glass-blurred')).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), { version: 1, selectedId: 'system-glass-blurred' });
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
