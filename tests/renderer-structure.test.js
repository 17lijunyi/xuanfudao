const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const workspaceJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace.js'), 'utf8');
const effectsJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'effects.js'), 'utf8');
const computerJs = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'computer-status.js'), 'utf8');

test('clipboard rows define both favorite icons before rendering entries', () => {
  assert.match(appJs, /const starOutlineSvg\s*=/);
  assert.match(appJs, /const starFilledSvg\s*=/);
});

test('notes have a dedicated top-level tab and management panel', () => {
  assert.match(html, /data-tab="notes"/);
  assert.match(html, /id="tab-notes"/);
  assert.match(html, /id="notes-search"/);
  assert.match(html, /id="notes-list"/);
  assert.match(html, /id="notes-detail"/);
});

test('home scratch note keeps only the save action', () => {
  const homeNote = html.match(/<section class="tile home-note"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(homeNote, /id="note-save-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library-btn"/);
  assert.doesNotMatch(homeNote, /id="note-library"/);
});

test('recordings expose in-page API settings and create a live draft while recording', () => {
  assert.match(html, /id="recording-configure"/);
  assert.match(workspaceJs, /function beginRecordingDraft\(\)/);
  assert.match(workspaceJs, /recordingLiveTranscript/);
  assert.match(workspaceJs, /configure-transcription/);
});

test('a live recording can be paused, resumed, and stopped from the recordings tab', () => {
  assert.match(workspaceJs, /recording-live-pause/);
  assert.match(workspaceJs, /recording-live-stop/);
  assert.match(workspaceJs, /togglePauseRecording/);
  assert.match(workspaceJs, /stopRecording/);
});

test('computer status replaces the recording tab label while preserving the recording library and storage', () => {
  const tab = html.match(/<button class="tab" id="tab-button-recordings"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(tab, /data-tab="recordings"/);
  assert.match(tab, /电脑状态/);
  assert.match(html, /id="computer-status-view"/);
  assert.match(html, /id="computer-open-recordings"/);
  assert.match(html, /id="recording-library-view"[^>]*hidden/);
  assert.match(html, /id="computer-back-status"/);
  assert.match(workspaceJs, /const RECORDINGS_KEY = 'notch-recordings'/);
  assert.match(html, /id="recording-list"/);
  assert.match(html, /id="recording-detail"/);
  assert.match(html, /id="recording-new"/);
});

test('computer status owns six real metrics and never scans application windows', () => {
  assert.deepEqual([...html.matchAll(/data-computer-card="([^"]+)"/g)].map((match) => match[1]), [
    'cpu', 'memory', 'disk', 'battery', 'network', 'uptime',
  ]);
  assert.match(html, /id="home-computer"[^>]*data-home-module="windows"/);
  assert.doesNotMatch(html, /id="window-list"|id="windows-refresh"|id="windows-hidden"/);
  assert.doesNotMatch(workspaceJs, /listWindows|focusWindow|refreshWindows/);
  assert.doesNotMatch(computerJs, /listWindows|focusWindow|openPrivacySettings|ensureCamera|ensureMicrophone/);
  assert.match(computerJs, /getComputerStatus/);
  assert.match(computerJs, /onComputerStatus/);
  assert.match(computerJs, /document\.hidden/);
  assert.match(computerJs, /setInterval\([\s\S]*?3000\)/);
  assert.match(computerJs, /clearInterval\(timer\)/);
});

test('homepage visibility has one storage key, exact validation, and lifecycle events', () => {
  assert.match(appJs, /notch-home-hidden-modules-v1/);
  assert.match(appJs, /validateHomeWidgetLayout/);
  assert.match(appJs, /window\.NotchHome\s*=/);
  assert.match(appJs, /notch:home-modules-changed/);
  assert.match(appJs, /notch:home-layout-error/);
  assert.match(appJs, /stopMirror\(\)/);
  assert.match(appJs, /new Set\(homeTiles\.map\(\(tile\) => tile\.dataset\.homeModule\)\)/);
});

test('settings exposes exactly one switch for every homepage widget', () => {
  const switches = [...html.matchAll(/data-settings-home-module="([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(switches, [
    'music', 'pomodoro', 'note', 'commands', 'recorder', 'windows', 'mirror',
  ]);
  const core = html.match(/data-settings-tier="core"[\s\S]*?<\/section>/)?.[0] || '';
  assert.deepEqual([...core.matchAll(/data-settings-home-module="([^"]+)"/g)].map((match) => match[1]), ['music', 'pomodoro']);
  assert.match(workspaceJs, /isRecordingActive/);
  assert.match(workspaceJs, /recording_active/);
  assert.match(workspaceJs, /at_least_one_required/);
});

test('workspace controls have unique ids so every visible button targets one action', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepEqual(duplicates, []);
  assert.equal(ids.filter((id) => id === 'llm-api-help').length, 1);
});

test('hidden visual widgets stop presentation-only background work', () => {
  assert.doesNotMatch(effectsJs, /getContext\(['"]webgl/);
  assert.match(workspaceJs, /codexCard\?\.setActive/);
  assert.match(workspaceJs, /notch:home-modules-changed/);
  assert.match(workspaceJs, /NotchHome\?\.isVisible/);
});
