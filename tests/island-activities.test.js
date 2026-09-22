const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanActivity, selectIslandActivity, systemFeedback,
  hasCodexAttention, statusIslandSurfaceAllowed } = require('../island-activities');

test('renderer activity boundary rejects unrelated sources and invalid clocks', () => {
  assert.equal(cleanActivity({ kind: 'system', title: 'spoofed' }), null);
  assert.equal(cleanActivity({ kind: 'recording', status: 'recording', elapsedMs: -1 }), null);
  assert.equal(cleanActivity({ kind: 'timer', active: true, running: true, remainingSeconds: 60, endAt: 'later' }), null);
  const valid = cleanActivity({ kind: 'timer', active: true, running: false, remainingSeconds: 15, title: 'not accepted' });
  assert.equal(valid.remainingSeconds, 15);
  assert.equal(Object.hasOwn(valid, 'title'), false);
});

test('recording takes precedence and paused recording does not advance', () => {
  const selected = selectIslandActivity({ recording: { status: 'paused', elapsedMs: 72000, updatedAt: 1000 }, timer: { active: true, running: false, remainingSeconds: 20 }, music: { running: true, playing: true } }, 999999);
  assert.equal(selected.kind, 'recording');
  assert.equal(selected.value, '01:12');
  assert.equal(selected.target, 'recordings');
});

test('timer uses deadline after a sleeping or throttled renderer', () => {
  const state = { timer: { active: true, running: true, remainingSeconds: 300, endAt: 305000 } };
  assert.equal(selectIslandActivity(state, 286000).value, '00:19');
  assert.equal(selectIslandActivity(state, 500000), null, 'expired background activity cannot remain stuck at 00:00');
});

test('removed music never produces a playing island', () => {
  assert.equal(selectIslandActivity({ music: { running: true, playing: null } }), null);
  assert.equal(selectIslandActivity({ music: { running: false, playing: true } }), null);
  assert.equal(selectIslandActivity({ music: { running: true, playing: true } }), null);
});

test('system feedback preserves actual values and device changes take priority', () => {
  const snapshot = { volume: { ok: true, volume: 63, muted: true }, brightness: { ok: false, error: 'unsupported' }, output: { ok: true, id: 4, name: '耳机', kind: 'headphones' } };
  assert.equal(systemFeedback(snapshot, ['volume']).value, 0);
  assert.equal(systemFeedback(snapshot, ['brightness']), null);
  assert.equal(systemFeedback(snapshot, ['volume', 'output']).kind, 'headphones');
});

test('Codex attention suppresses passive activities while direct media-key feedback remains visible', () => {
  assert.equal(hasCodexAttention({ attentionTasks: [
    { status: 'attention', attentionKind: 'permission' },
  ] }), true);
  assert.equal(hasCodexAttention({ attentionTasks: [
    { status: 'running', attentionKind: null },
    { status: 'attention', attentionKind: 'unknown' },
  ] }), false);
  assert.equal(hasCodexAttention({ attentionTasks: [], recentIssueTasks: [
    { status: 'failed' },
  ] }), true, 'a recent failed task also needs the island surface');
  assert.equal(hasCodexAttention({ attentionTasks: [], recentIssueTasks: [
    { status: 'interrupted' },
  ] }), true, 'a recent interrupted task also needs the island surface');

  const passive = { kind: 'recording', compact: true };
  const mediaKey = { kind: 'volume', fromMediaKey: true };
  const explicitControl = { kind: 'brightness', interactive: true };
  const visible = { passiveAllowed: true };
  assert.equal(statusIslandSurfaceAllowed(passive, visible), true);
  assert.equal(statusIslandSurfaceAllowed(passive, { ...visible, codexAttentionActive: true }), false);
  assert.equal(statusIslandSurfaceAllowed(mediaKey, { ...visible, codexAttentionActive: true }), true);
  assert.equal(statusIslandSurfaceAllowed(explicitControl, { ...visible, codexAttentionActive: true }), true,
    'an explicit volume or brightness button must still open its control during task attention');
  assert.equal(statusIslandSurfaceAllowed(passive, visible), true, 'clearing attention restores the persistent activity policy');
  assert.equal(statusIslandSurfaceAllowed(mediaKey, { ...visible, notificationActive: true }), false,
    'task completion remains the highest-priority surface');
});
