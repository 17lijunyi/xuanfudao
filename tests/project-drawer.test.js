const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createProjectDrawer, COLORS } = require('../project-drawer');

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'fudao-drawer-'));
  const root = path.join(base, '全部文件');
  const statePath = path.join(base, 'data', 'project-drawer.json');
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, '项目甲'));
  await fs.writeFile(path.join(root, '说明.txt'), 'original content');
  await fs.writeFile(path.join(root, '.DS_Store'), 'hidden');
  const service = createProjectDrawer({ defaultRoot: root, statePath, watch: false, ...options });
  t.after(async () => { await service.dispose(); await fs.rm(base, { recursive: true, force: true }); });
  return { base, root, statePath, service };
}

test('catalogue reads only the collection top level and saves category metadata without moving files', async (t) => {
  const { service, root, statePath } = await fixture(t);
  await fs.writeFile(path.join(root, '项目甲', '内部.txt'), 'nested');
  let snapshot = await service.refresh();
  assert.deepEqual(snapshot.entries.map((e) => e.name), ['项目甲', '说明.txt']);
  assert.ok(snapshot.entries.every((e) => e.category === ''));
  const ids = snapshot.entries.map((e) => e.id);
  snapshot = await service.mutate({ type: 'save-category', name: '工作', color: COLORS[0] });
  const category = snapshot.categories.at(-1).id;
  snapshot = await service.mutate({ type: 'assign', ids, category });
  assert.ok(snapshot.entries.every((e) => e.category === category));
  assert.equal(await fs.readFile(path.join(root, '说明.txt'), 'utf8'), 'original content');
  assert.equal((await fs.readdir(root)).length, 3);
  assert.ok(JSON.parse(await fs.readFile(statePath, 'utf8')).memberships);
  const reopened = createProjectDrawer({ defaultRoot: root, statePath, watch: false });
  t.after(() => reopened.dispose());
  assert.ok((await reopened.refresh()).entries.every((e) => e.category === category));
  snapshot = await service.mutate({ type: 'delete-category', id: category });
  assert.ok(snapshot.entries.every((e) => e.category === ''));
  snapshot = await service.mutate({ type: 'undo' });
  assert.ok(snapshot.entries.every((e) => e.category === category));
  assert.equal(snapshot.canUndo, false);
});

test('rename preserves category; stale and invented file IDs cannot open paths', async (t) => {
  const { service, root } = await fixture(t);
  let snapshot = await service.refresh();
  const file = snapshot.entries.find((e) => e.name === '说明.txt');
  await service.mutate({ type: 'assign', ids: [file.id], category: 'development' });
  await fs.rename(path.join(root, file.name), path.join(root, '改名.txt'));
  await assert.rejects(service.resolveEntry(file.id), /移动或删除/);
  snapshot = await service.refresh();
  const renamed = snapshot.entries.find((e) => e.id === file.id);
  assert.equal(renamed.name, '改名.txt');
  assert.equal(renamed.category, 'development');
  assert.equal(await service.resolveEntry(file.id), path.join(root, '改名.txt'));
  await assert.rejects(service.resolveEntry('../../private'), /变动/);
  await fs.rm(path.join(root, '改名.txt'));
  await fs.writeFile(path.join(root, '改名.txt'), 'replacement');
  await assert.rejects(service.resolveEntry(file.id), /移动或删除/);
  snapshot = await service.refresh();
  assert.equal(snapshot.entries.find((e) => e.name === '改名.txt').category, '');
  await assert.rejects(service.mutate({ type: 'assign', ids: [file.id], category: 'development' }), /变动/);
});

test('concurrent edits serialize; invalid names and missing categories do not change data', async (t) => {
  const { service } = await fixture(t);
  await service.refresh();
  const results = await Promise.allSettled([1, 2].map(() => service.mutate({ type: 'save-category', name: '同名', color: COLORS[0] })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const name of ['', '全部文件', '未分类', '字'.repeat(21)]) await assert.rejects(service.mutate({ type: 'save-category', name, color: COLORS[0] }));
  await assert.rejects(service.mutate({ type: 'save-category', id: 'missing', name: '未知', color: COLORS[1] }));
  await assert.rejects(service.mutate({ type: 'assign', ids: ['fake'], category: 'fake' }));
  assert.equal((await service.refresh()).categories.length, 4);
});

test('changing root retains per-folder classifications and reconnects after missing folder returns', async (t) => {
  const { service, base, root } = await fixture(t);
  const old = await service.refresh();
  await service.mutate({ type: 'assign', ids: [old.entries[0].id], category: 'development' });
  const other = path.join(base, '另一个'); await fs.mkdir(other);
  await fs.writeFile(path.join(other, '新文件'), 'new');
  assert.equal((await service.chooseRoot(other)).entries[0].category, '');
  assert.equal((await service.chooseRoot(root)).entries[0].category, 'development');
  await fs.rename(root, `${root}-renamed`);
  assert.match((await service.refresh()).error, /找不到/);
  await fs.rename(`${root}-renamed`, root);
  const recovered = await service.refresh();
  assert.equal(recovered.error, '');
  assert.equal(recovered.entries[0].category, 'development');
});

test('filesystem watcher publishes newly added and deleted files automatically', async (t) => {
  let latest;
  const { service, root } = await fixture(t, { watch: true, pollMs: 500, onChange: (value) => { latest = value; } });
  await service.refresh();
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate(latest) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(predicate(latest));
  }
  await fs.mkdir(path.join(root, '新项目'));
  await waitFor((s) => s.entries.some((e) => e.name === '新项目' && e.category === ''));
  await fs.rmdir(path.join(root, '新项目'));
  await waitFor((s) => !s.entries.some((e) => e.name === '新项目'));
});

test('damaged metadata is preserved instead of silently resetting classifications', async (t) => {
  const { root, statePath } = await fixture(t);
  await fs.mkdir(path.dirname(statePath)); await fs.writeFile(statePath, '{broken');
  const service = createProjectDrawer({ defaultRoot: root, statePath, watch: false });
  t.after(() => service.dispose());
  assert.match((await service.refresh()).error, /分类记录无法读取/);
  await assert.rejects(service.mutate({ type: 'save-category', name: '工作', color: COLORS[0] }));
  assert.equal(await fs.readFile(statePath, 'utf8'), '{broken');
});
