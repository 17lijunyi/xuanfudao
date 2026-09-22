'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAppearanceSurface } = require('../appearance-surface');

const bounds = { width: 1280, height: 640 };
const request = () => ({
  viewport: { ...bounds },
  surface: { x: 20, y: 10, width: 1240, height: 620, radii: [0, 0, 24, 24], opacity: 0.48 },
});

test('返回有限窗口内形状，丢弃额外字段并独立复制圆角', () => {
  const payload = request();
  payload.surface.css = 'background: red';
  payload.surface.path = '/tmp/anything';
  const result = normalizeAppearanceSurface(payload, bounds);
  assert.deepEqual(result, { x: 20, y: 10, width: 1240, height: 620, radii: [0, 0, 24, 24], opacity: 0.48, backgroundBlurRadius: 20 });
  payload.surface.radii[2] = 200;
  assert.equal(result.radii[2], 24);
});

test('拒绝展开收回之前的旧窗口尺寸，仅接受一像素内的 viewport 误差', () => {
  const payload = request();
  assert.equal(normalizeAppearanceSurface(payload, { width: 256, height: 32 }), null);
  payload.viewport.width = 1278.99;
  assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  payload.viewport.width = 1279;
  payload.viewport.height = 641;
  assert.notEqual(normalizeAppearanceSurface(payload, bounds), null);
  payload.viewport.height = 641.01;
  assert.equal(normalizeAppearanceSurface(payload, bounds), null);
});

test('边界容差收紧到内容区，圆角统一按重叠比例缩放', () => {
  const payload = request();
  payload.surface = { x: -1, y: -0.5, width: 1282, height: 641, radii: [-4, 1000, 12, 500], opacity: 1 };
  assert.deepEqual(normalizeAppearanceSurface(payload, bounds), {
    x: 0, y: 0, width: 1280, height: 640,
    radii: [0, 1000 * (640 / 1012), 12 * (640 / 1012), 500 * (640 / 1012)], opacity: 1, backgroundBlurRadius: 20,
  });
  payload.surface.x = -1.01;
  assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  payload.surface.x = 0;
  assert.equal(normalizeAppearanceSurface(payload, bounds), null);
});

test('24px 高折叠岛保留 17px 下圆角，与 CSS 边缘一致', () => {
  const viewport = { width: 256, height: 24 };
  const surface = { x: 0, y: 0, ...viewport, radii: [0, 0, 17, 17], opacity: 0.48 };
  assert.deepEqual(normalizeAppearanceSurface({ viewport, surface }, viewport)?.radii, [0, 0, 17, 17]);
  surface.radii = [0, 0, 240, 240];
  assert.deepEqual(normalizeAppearanceSurface({ viewport, surface }, viewport)?.radii, [0, 0, 24, 24]);
  surface.radii = [240, 240, 240, 240];
  assert.deepEqual(normalizeAppearanceSurface({ viewport, surface }, viewport)?.radii, [12, 12, 12, 12]);
  surface.radii = [0, 0, 0, 0];
  assert.deepEqual(normalizeAppearanceSurface({ viewport, surface }, viewport)?.radii, [0, 0, 0, 0]);
});

test('拒绝非数字、非有限值、非法尺寸、透明度和圆角', () => {
  for (const property of ['x', 'y', 'width', 'height', 'opacity']) {
    for (const invalid of ['10', NaN, Infinity, -Infinity, null, {}, undefined]) {
      const payload = request();
      payload.surface[property] = invalid;
      assert.equal(normalizeAppearanceSurface(payload, bounds), null, `${property}: ${String(invalid)}`);
    }
  }
  for (const [property, invalid] of [['width', 0], ['height', -1], ['opacity', -0.01], ['opacity', 1.01], ['x', 1281], ['y', 641]]) {
    const payload = request();
    payload.surface[property] = invalid;
    assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  }
  for (const radii of [null, Array(4), [0, 0, 0], [0, 0, 0, 0, 0], [0, 0, '24', 24], [0, 0, NaN, 24], [0, 0, Infinity, 24]]) {
    const payload = request();
    payload.surface.radii = radii;
    assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  }
  for (const invalid of ['1280', null, NaN, Infinity, 0, -1]) {
    const payload = request();
    payload.viewport.width = invalid;
    assert.equal(normalizeAppearanceSurface(payload, bounds), null);
    assert.equal(normalizeAppearanceSurface(request(), { ...bounds, width: invalid }), null);
  }
});

test('清空不需要 viewport，缺失数据或窗口拒绝应用表面', () => {
  for (const payload of [null, undefined, {}, { surface: null }, { viewport: bounds }, { surface: request().surface }]) {
    assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  }
  assert.equal(normalizeAppearanceSurface(request(), null), null);
});

test('旧透明与弱模糊帧统一使用柔焦，缺失半径不回退透明玻璃', () => {
  for (const backgroundBlurRadius of [undefined, 0, 3, 20, 32]) {
    const payload = request();
    payload.surface.backgroundBlurRadius = backgroundBlurRadius;
    const result = normalizeAppearanceSurface(payload, bounds);
    assert.equal(result.backgroundBlurRadius, 20);
    assert.equal(result.opacity, payload.surface.opacity);
  }
  for (const backgroundBlurRadius of [-1, 33, 1.5, '3', NaN, Infinity, null, {}]) {
    const payload = request();
    payload.surface.backgroundBlurRadius = backgroundBlurRadius;
    assert.equal(normalizeAppearanceSurface(payload, bounds), null);
  }
});
