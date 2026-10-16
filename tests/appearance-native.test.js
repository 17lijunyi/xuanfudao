'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppearanceNativeController } = require('../appearance-native');
function fixture() {
  const calls = [];
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  window.getContentBounds = () => ({ width: 420, height: 250 });
  window.getNativeWindowHandle = () => Buffer.alloc(8, 2);
  const controller = createAppearanceNativeController({ platform: 'darwin', addonPath: __filename, loadAddon: () => ({ regionSlots: 2, apply: (...args) => { calls.push(['apply', ...args]); return true; }, clear: (...args) => { calls.push(['clear', ...args]); return true; } }) });
  return { window, calls, controller, shape: { x: 0, y: 0, width: 256, height: 24, radii: [0, 0, 17, 17], opacity: 1 } };
}
test('native glass rejects malformed and overflowing geometry before native code', () => {
  const { window, calls, controller, shape } = fixture();
  for (const invalid of [{ ...shape, width: Infinity }, { ...shape, x: -1 }, { ...shape, height: 251.1 }, { ...shape, opacity: -0.1 }, { ...shape, radii: [NaN, 0, 0, 0] }, { ...shape, radii: [0, 0] }, ...[-1, 33, 1.5, '3', NaN, Infinity].map(backgroundBlurRadius => ({ ...shape, backgroundBlurRadius }))]) assert.equal(controller.apply(window, invalid), false);
  assert.deepEqual(calls, []);
});
test('native glass resets on lifecycle changes and removes listeners on dispose', () => {
  const { window, calls, controller, shape } = fixture();
  assert.equal(controller.apply(window, shape), true);
  assert.equal(window.listenerCount('resize'), 1);
  assert.equal(controller.apply(window, shape), true);
  assert.equal(window.listenerCount('resize'), 1);
  window.emit('resize'); window.emit('hide');
  assert.deepEqual(calls.map(call => call[0]), ['apply', 'apply', 'clear', 'clear']);
  controller.dispose();
  assert.equal(window.listenerCount('resize'), 0);
  assert.equal(window.listenerCount('hide'), 0);
  assert.equal(window.listenerCount('closed'), 0);
  window.isDestroyed = () => true;
  assert.equal(controller.apply(window, shape), false);
  assert.equal(controller.clear(window), false);
});
test('other platforms and unavailable native addon keep CSS appearance usable', () => {
  const { window, shape } = fixture();
  const controller = createAppearanceNativeController({ platform: 'linux', loadAddon: () => { assert.fail('must not load macOS native code'); } });
  assert.equal(controller.apply(window, shape), false);
  assert.deepEqual(controller.getStatus(), { available: false, reason: 'unsupported-platform' });
  const errors = [];
  const missing = createAppearanceNativeController({ platform: 'darwin', addonPath: __filename, loadAddon: () => { throw new Error('signature mismatch'); }, onError: error => errors.push(error.message) });
  assert.equal(missing.apply(window, shape), false);
  assert.equal(missing.apply(window, shape), false);
  assert.deepEqual(errors, ['signature mismatch']);
});

test('paired glass validates both regions before applying and derives bounded slots', () => {
  const {window,controller,calls,shape} = fixture();
  assert.equal(controller.applyPair(window,[shape,{...shape,width:999}]),false);
  assert.deepEqual(calls,[]);
  assert.equal(controller.applyPair(window,[{...shape,slot:99},{...shape,x:280,width:54}]),true);
  assert.deepEqual(calls.map(call=>call[2].slot),[0,1]);
  window.emit('hide');
  assert.equal(calls.at(-1)[0],'clear');
  assert.equal(controller.applyPair(window,[shape]),false);
});
