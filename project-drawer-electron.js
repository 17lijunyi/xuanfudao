'use strict';

const path = require('node:path');
const { createProjectDrawer } = require('./project-drawer');

function installProjectDrawer({ app, ipcMain, shell, powerMonitor, isSender, chooseDirectory, onChange }) {
  let service;
  const get = () => {
    if (!service) service = createProjectDrawer({
      defaultRoot: path.join(app.getPath('desktop'), '全部文件'),
      statePath: path.join(app.getPath('userData'), 'project-drawer.json'),
      onChange,
    });
    return service;
  };
  const handle = (channel, operation) => ipcMain.handle(`projects:${channel}`, async (event, payload) => {
    if (!isSender(event)) return { ok: false, error: '无法从此窗口访问项目抽屉。' };
    try { return await operation(payload); }
    catch (error) { return { ok: false, error: error.message || '操作失败，请重试。' }; }
  });
  handle('list', async () => ({ ok: true, snapshot: await get().refresh() }));
  handle('mutate', async (action) => ({ ok: true, snapshot: await get().mutate(action) }));
  handle('choose', async () => {
    const result = await chooseDirectory({ title: '选择项目抽屉的文件夹', buttonLabel: '使用此文件夹', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths?.[0]) return { ok: true, canceled: true };
    return { ok: true, snapshot: await get().chooseRoot(result.filePaths[0]) };
  });
  handle('open', async (id) => {
    const error = await shell.openPath(await get().resolveEntry(id));
    if (error) throw new Error('文件未能打开，请在访达中检查。');
    return { ok: true };
  });
  handle('reveal', async (id) => {
    shell.showItemInFolder(await get().resolveEntry(id));
    return { ok: true };
  });
  handle('root', async () => {
    const snapshot = await get().refresh();
    if (snapshot.error) throw new Error(snapshot.error);
    const error = await shell.openPath(snapshot.root);
    if (error) throw new Error('文件夹未能打开，请重新选择。');
    return { ok: true };
  });
  const resume = () => { void service?.refresh().catch(() => {}); };
  app.whenReady().then(() => powerMonitor.on('resume', resume));
  app.on('before-quit', () => {
    powerMonitor.removeListener('resume', resume);
    void service?.dispose();
  });
}

module.exports = { installProjectDrawer };
