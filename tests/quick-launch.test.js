const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createQuickLaunchService, inspectApplication } = require('../quick-launch');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = (name) => {
    const target = path.join(root, `${name}.app`);
    fs.mkdirSync(path.join(target, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(target, 'Contents', 'Info.plist'), JSON.stringify({ CFBundlePackageType: 'APPL', CFBundleExecutable: 'main', CFBundleName: name }));
    fs.writeFileSync(path.join(target, 'Contents', 'MacOS', 'main'), 'fixture, never execute');
    return target;
  };
  const original = appPath('原应用');
  const chosen = appPath('新应用');
  const settingsPath = path.join(root, 'data', 'quick-launch.json');
  const readInfo = async (target) => JSON.parse(await fs.promises.readFile(path.join(target, 'Contents', 'Info.plist'), 'utf8'));
  const make = () => createQuickLaunchService({ settingsPath, readInfo,
    defaults: () => [{ name: '原应用', appPath: original }, ...Array(7).fill(null)],
    readIcon: async (target) => `icon:${path.basename(target)}` });
  return { root, original, chosen, settingsPath, readInfo, appPath, make };
}

test('替换只修改指定位置，重启保留名称、图标与启动目标', async (t) => {
  const f = fixture(t); const service = f.make();
  const before = await service.list();
  assert.equal(before.items.length, 8);
  assert.equal(before.items[1].empty, true);
  const selected = await service.replace('app-slot-0', async () => ({ filePaths: [f.chosen] }));
  assert.equal(selected.ok, true);
  assert.equal(selected.items[0].name, '新应用');
  assert.equal(selected.items[0].icon, 'icon:新应用.app');
  assert.deepEqual(selected.items.slice(1), before.items.slice(1));
  const restarted = f.make();
  assert.deepEqual(await restarted.list(), selected);
  const opened = [];
  assert.deepEqual(await restarted.launch('app-slot-0', async (target) => { opened.push(target); return ''; }), { ok: true });
  assert.deepEqual(opened, [f.chosen]);
});

test('取消选择不写配置，不改变原应用', async (t) => {
  const f = fixture(t); const service = f.make();
  const before = await service.list();
  assert.deepEqual(await service.replace('app-slot-0', async () => ({ canceled: true, filePaths: [] })), { ok: true, canceled: true });
  assert.deepEqual(await service.list(), before);
  assert.equal(fs.existsSync(f.settingsPath), false);
});

test('普通文件、伪装应用及越界槽位不能替换或启动', async (t) => {
  const f = fixture(t); const service = f.make();
  const folder = path.join(f.root, '普通文件夹.app'); fs.mkdirSync(folder);
  for (const target of [folder, path.join(f.original, 'Contents', 'Info.plist'), '/missing.app']) {
    assert.equal((await service.replace('app-slot-0', async () => ({ filePaths: [target] }))).error, 'invalid_app');
  }
  let called = false;
  for (const id of ['app-slot-8', '../app-slot-0', f.chosen, null, 0]) {
    assert.equal((await service.replace(id, async () => { called = true; })).error, 'invalid_slot');
    assert.equal((await service.launch(id, async () => { called = true; })).ok, false);
  }
  assert.equal(called, false);
  await assert.rejects(inspectApplication(f.original, async () => ({ CFBundlePackageType: 'APPL', CFBundleExecutable: '../main' })), /invalid_app/);
  assert.equal((await service.list()).items[0].name, '原应用');
});

test('重复应用（包括符号链接）不占第二个槽位，空位可添加', async (t) => {
  const f = fixture(t); const service = f.make();
  const alias = path.join(f.root, '别名.app'); fs.symlinkSync(f.original, alias);
  assert.equal((await service.replace('app-slot-1', async () => ({ filePaths: [alias] }))).error, 'duplicate_app');
  const selected = await service.replace('app-slot-1', async () => ({ filePaths: [f.chosen] }));
  assert.equal(selected.items[0].name, '原应用');
  assert.equal(selected.items[1].name, '新应用');
});

test('选择期间拒绝重复弹窗，关闭和异常后可重试', async (t) => {
  const f = fixture(t); const service = f.make();
  let close; let started;
  const shown = new Promise((resolve) => { started = resolve; });
  const pending = service.replace('app-slot-0', () => { started(); return new Promise((resolve) => { close = resolve; }); });
  await shown;
  assert.equal((await service.replace('app-slot-1', async () => { throw Error('must not show'); })).error, 'busy');
  close({ canceled: true }); await pending;
  assert.equal((await service.replace('app-slot-0', async () => { throw Error('dialog failed'); })).error, 'choose_failed');
  assert.equal((await service.replace('app-slot-0', async () => ({ filePaths: [f.chosen] }))).ok, true);
});

test('保存失败保留原应用和原配置，允许之后重新保存', async (t) => {
  const f = fixture(t); const service = f.make();
  await service.list();
  fs.mkdirSync(f.settingsPath, { recursive: true });
  fs.writeFileSync(path.join(f.settingsPath, 'keep'), 'keep');
  assert.equal((await service.replace('app-slot-0', async () => ({ filePaths: [f.chosen] }))).error, 'save_failed');
  assert.equal((await service.list()).items[0].name, '原应用');
  assert.equal(fs.readFileSync(path.join(f.settingsPath, 'keep'), 'utf8'), 'keep');
  fs.rmSync(f.settingsPath, { recursive: true });
  assert.equal((await service.replace('app-slot-0', async () => ({ filePaths: [f.chosen] }))).ok, true);
});

test('已移除的应用保留槽位并提示不可用，可在该位置更换', async (t) => {
  const f = fixture(t); const service = f.make();
  await service.replace('app-slot-0', async () => ({ filePaths: [f.chosen] }));
  fs.rmSync(f.chosen, { recursive: true });
  const restarted = f.make();
  const result = await restarted.list();
  assert.equal(result.items[0].name, '新应用');
  assert.equal(result.items[0].available, false);
  assert.equal(result.items[0].empty, undefined);
  let opened = false;
  assert.equal((await restarted.launch('app-slot-0', async () => { opened = true; })).error, 'app_missing');
  assert.equal(opened, false);
  assert.equal((await restarted.replace('app-slot-0', async () => ({ filePaths: [f.original] }))).ok, true);
});

test('损坏配置不会被默认值或新选择覆盖', async (t) => {
  const f = fixture(t); fs.mkdirSync(path.dirname(f.settingsPath), { recursive: true });
  fs.writeFileSync(f.settingsPath, '{broken');
  const service = f.make();
  await assert.rejects(service.list(), /settings_unavailable/);
  let picked = false;
  const result = await service.replace('app-slot-0', async () => { picked = true; return { filePaths: [f.chosen] }; });
  assert.equal(result.error, 'settings_unavailable');
  assert.equal(picked, false);
  assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), '{broken');
});

test('macOS 自带访达使用 FNDR 类型，仍可作为常用应用', { skip: process.platform !== 'darwin' }, async () => {
  const finder = await inspectApplication('/System/Library/CoreServices/Finder.app');
  assert.equal(finder.name, '访达');
  assert.equal(finder.appPath, '/System/Library/CoreServices/Finder.app');
});
