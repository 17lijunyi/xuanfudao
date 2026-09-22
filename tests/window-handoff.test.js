'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWindowHandoffController, normalizeWindowMotion } = require('../window-handoff');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options) {
  const events = [];
  const window = () => Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { capturePage: async () => { events.push('paint'); return { isEmpty: () => false }; } }),
  });
  const source = window(), target = window();
  const controller = createWindowHandoffController(options);
  let id;
  const spec = { source, target, prepare: token => { id = token; events.push('prepare'); },
    commit: () => events.push('commit'), rollback: () => events.push('rollback') };
  return { controller, source, target, events, spec, get id() { return id; } };
}
test('outgoing surface survives preparation and only the intended renderer can commit a painted frame', async () => {
  const f = fixture();
  const result = f.controller.begin(f.spec);
  await tick();
  assert.deepEqual(f.events, ['prepare']);
  f.controller.ready(f.source.webContents, f.id);
  f.controller.ready(f.target.webContents, f.id + 1);
  await tick();
  assert.deepEqual(f.events, ['prepare']);
  f.controller.ready(f.target.webContents, f.id);
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(f.events, ['prepare', 'paint', 'commit']);
  assert.equal(f.source.listenerCount('hide'), 0);
});
test('a dismissed source invalidates a late ready message without opening the destination', async () => {
  const f = fixture();
  const result = f.controller.begin(f.spec);
  await tick();
  f.source.emit('hide');
  f.controller.ready(f.target.webContents, f.id);
  assert.equal((await result).ok, false);
  assert.deepEqual(f.events, ['prepare', 'rollback']);
});
test('superseded paint results cannot commit after a newer navigation', async () => {
  const f = fixture();
  let releasePaint;
  f.target.webContents.capturePage = () => new Promise(resolve => { releasePaint = resolve; });
  const first = f.controller.begin(f.spec);
  await tick();
  const oldId = f.id;
  f.controller.ready(f.target.webContents, oldId);
  const second = f.controller.begin(f.spec);
  await tick();
  releasePaint({ isEmpty: () => false });
  await tick();
  assert.equal((await first).error, 'superseded');
  assert.equal(f.events.includes('commit'), false);
  f.target.webContents.capturePage = async () => ({ isEmpty: () => false });
  f.controller.ready(f.target.webContents, oldId);
  f.controller.ready(f.target.webContents, f.id);
  assert.equal((await second).ok, true);
  assert.equal(f.events.filter(event => event === 'commit').length, 1);
});
test('unpainted or failed destination retains the outgoing view and rolls back', async () => {
  for (const paint of [async () => ({ isEmpty: () => true }), async () => { throw Error('renderer gone'); }]) {
    const f = fixture();
    f.target.webContents.capturePage = paint;
    const result = f.controller.begin(f.spec);
    await tick();
    f.controller.ready(f.target.webContents, f.id);
    assert.equal((await result).ok, false);
    assert.deepEqual(f.events, ['prepare', 'rollback']);
  }
});
test('a renderer that never prepares a frame times out without closing the outgoing view', async () => {
  const f = fixture({ timeoutMs: 15 });
  assert.equal((await f.controller.begin(f.spec)).error, 'surface_timeout');
  assert.deepEqual(f.events, ['prepare', 'rollback']);
});
test('synchronous focus/hide events at commit cannot cancel the completed handoff', async () => {
  const f = fixture();
  f.spec.commit = () => { f.source.emit('hide'); assert.equal(f.controller.cancel(), false); f.events.push('commit'); };
  const result = f.controller.begin(f.spec);
  await tick();
  f.controller.ready(f.target.webContents, f.id);
  assert.equal((await result).ok, true);
});
test('card motion waits for its own completion and interruption keeps the already presented window', async () => {
  for (const interrupted of [false, true]) {
    const f = fixture();
    f.spec.animate = () => f.events.push('animate');
    f.spec.settle = (id, surface) => { assert.equal(id, f.id); assert.equal(surface.height, 308); f.events.push('settle'); };
    const result = f.controller.begin(f.spec);
    await tick();
    f.controller.recordSurface(f.target, { height: 308 });
    f.controller.ready(f.target.webContents, f.id, true);
    await tick();
    assert.deepEqual(f.events, ['prepare', 'paint', 'commit', 'animate']);
    f.source.emit('hide');
    assert.equal(f.controller.complete(f.source.webContents, f.id), false);
    assert.equal(f.controller.complete(f.target.webContents, f.id + 1), false);
    if (interrupted) f.controller.cancel('collapse_requested');
    else assert.equal(f.controller.complete(f.target.webContents, f.id), true);
    assert.equal((await result).ok, true);
    assert.equal(f.events.at(-1), 'settle');
    assert.equal(f.events.includes('rollback'), false);
    assert.equal(f.controller.complete(f.target.webContents, f.id), false);
    assert.equal(f.target.listenerCount('hide'), 0);
  }
});
test('motion metadata admits only visible named cards from the caller canvas', () => {
  const bounds = { width: 1040, height: 308 };
  const value = { version: 1, view: 'quick', reducedMotion: false, viewport: bounds,
    cards: { note: { x: 30, y: 70, width: 180, height: 200, html: '<script>' }, arbitrary: { x: 0, y: 0, width: 1, height: 1 } } };
  assert.deepEqual(normalizeWindowMotion(value, bounds), { version: 1, view: 'quick', viewport: bounds, cards: { note: { x: 30, y: 70, width: 180, height: 200 } } });
  for (const patch of [{ reducedMotion: true }, { view: 'credentials' }, { viewport: {} },
    { viewport: { width: Infinity, height: 308 } }, { viewport: { width: 1240, height: 308 } },
    { cards: { note: { x: -1, y: 0, width: 10, height: 20 } } }, { cards: { note: { x: 800, y: 0, width: 500, height: 200 } } }]) {
    assert.equal(normalizeWindowMotion({ ...value, ...patch }, bounds), null);
  }
});
test('workspace motion admits bounded anonymous geometry without card contents or identifiers', () => {
  const bounds = { width: 1040, height: 480 };
  const geometry = { x: 30, y: 100, width: 200, height: 160 };
  const normalized = normalizeWindowMotion({ version: 1, view: 'workspace', reducedMotion: false, viewport: bounds,
    cards: { slot0: { ...geometry, text: 'private', id: '/private/file' }, slot23: geometry, slot24: geometry, credentials: geometry } }, bounds);
  assert.deepEqual(normalized.cards, { slot0: geometry, slot23: geometry });
  assert.equal(normalized.view, 'workspace');
});
