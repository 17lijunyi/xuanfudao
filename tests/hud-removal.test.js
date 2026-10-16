'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
test('removed HUD controls cannot re-enable old preferences or emit keyboard feedback', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  let options;
  const feedback = [];
  const context = vm.createContext({
    createSystemStatusService: value => { options = value; return {}; },
    handleIslandSystemChange() {},
  });
  vm.runInContext(main.slice(main.indexOf('const systemStatus ='), main.indexOf('const computerStatus =')), context);
  assert.equal(options.hudReplacementEnabled, false);
  assert.equal(options.onFeedback, undefined);
  assert.doesNotMatch(main, /system:hud-replacement:|island:system-show|系统音量与亮度提示|system-hud-settings\.json/);
  const changeContext = vm.createContext({
    broadcastIsland() {}, lastIslandSystemSnapshot: null,
    systemFeedback: (_, keys) => { feedback.push(Array.from(keys)); return null; },
  });
  vm.runInContext(main.slice(main.indexOf('function handleIslandSystemChange('), main.indexOf('function updateIslandActivities(')), changeContext);
  changeContext.handleIslandSystemChange({}, ['volume','brightness','output']);
  assert.deepEqual(feedback, [['output']]);
  for (const file of ['renderer/index.html', 'renderer/quick-island.html', 'preload.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root,file),'utf8'), /settings-hud|data-system-hud|hud-settings|system:hud-replacement:|island:system-show/);
  }
});
