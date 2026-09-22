'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { overlapsSystemUI, createSystemUIGuard } = require('../system-ui-guard');

test('system UI collision matrix preserves desktop points across scales, menu heights and negative displays', () => {
  let count = 0;
  for (const x of [0, -1920, 1710]) for (const y of [0, -1080, 900])
    for (const width of [1280, 1512, 1710, 1920, 2560]) for (const height of [24, 32, 34, 38, 48]) {
      const island = { x: x + (width - 256) / 2, y, width: 256, height };
      for (const scale of [1, 1.5, 2]) {
        // Electron and CG bounds both use points. Never multiply by backing scale.
        assert(overlapsSystemUI(island, [{ x: island.x + 240, y: y + 2, width: 44, height: height - 4 }]));
        assert(!overlapsSystemUI(island, [{ x: island.x + 300, y, width: 44, height }]));
        assert(!overlapsSystemUI(island, [{ x: island.x, y: y + height + 20, width: 256, height: 80 }]));
        count++;
      }
    }
  assert.equal(count, 675);
});
test('boundary touching, malformed geometry and invisible/empty areas do not obstruct', () => {
  const b = { x: 600, y: 0, width: 256, height: 34 };
  assert(!overlapsSystemUI(b, [{ x: 858, y: 0, width: 20, height: 34 }]));
  assert(overlapsSystemUI(b, [{ x: 857, y: 0, width: 20, height: 34 }]));
  for (const rect of [null, {}, { ...b, width: 0 }, { ...b, y: NaN }, { ...b, height: Infinity }]) assert(!overlapsSystemUI(b, [rect]));
});
test('polling changes only our window policy, recovers from failed reads and stops cleanly', () => {
  let obstacles = [{ x: 0, y: 0, width: 40, height: 24 }], calls = 0, timers = 0, cancelCount = 0;
  const guard = createSystemUIGuard({ read: () => obstacles, onRefresh: () => calls++,
    setInterval: () => { timers++; return 1; }, clearInterval: () => cancelCount++ });
  guard.start(); guard.start(); assert.equal(timers, 1); assert.equal(calls, 1);
  assert(guard.blocks({ x: 0, y: 0, width: 256, height: 24 }));
  obstacles = []; guard.refresh(); assert(!guard.blocks({ x: 0, y: 0, width: 256, height: 24 }));
  obstacles = null; guard.refresh(); assert.equal(guard.getStatus().available, false);
  obstacles = [{ x: -40, y: -20, width: 40, height: 24 }]; guard.refresh(); assert.equal(guard.getStatus().available, true);
  guard.stop(); guard.stop(); assert.equal(cancelCount, 1);
});

test('folded island retains its full width regardless of menu-bar overlap', () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('function getCollapsedWidth('), end = source.indexOf('\n// 展开尺寸', start);
  const context = { COLLAPSED_WIDTH: 256 };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  assert.equal(vm.runInContext('getCollapsedWidth()', context), 256);
});
