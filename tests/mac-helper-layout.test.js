const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { alignMacHelperNames, verifyMacHelperLayout } = require('../build/afterPack');

const suffixes = ['', ' (Renderer)', ' (GPU)', ' (Plugin)'];
const plist = {
  readString(file, key) { return JSON.parse(fs.readFileSync(file, 'utf8'))[key]; },
  writeString(file, key, value) {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...info, [key]: value }));
  },
};

function fixture(t, missingSuffix) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-helper-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const app = path.join(temporary, '悬浮岛.app');
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  fs.mkdirSync(frameworks, { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), JSON.stringify({
    CFBundleName: '工作台', CFBundleDisplayName: '悬浮岛', CFBundleIdentifier: 'com.dynamicpanel.app',
  }));
  for (const suffix of suffixes) {
    if (suffix === missingSuffix) continue;
    const name = `悬浮岛 Helper${suffix}`;
    const contents = path.join(frameworks, `${name}.app`, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(contents, 'MacOS', name), 'fixture executable', { mode: 0o755 });
    fs.writeFileSync(path.join(contents, 'Info.plist'), JSON.stringify({
      CFBundleName: `Electron Helper${suffix}`,
      CFBundleExecutable: name,
      CFBundleDisplayName: name,
      CFBundleIdentifier: `com.dynamicpanel.app.helper${suffix}`,
    }));
  }
  return { app, frameworks };
}

test('packing aligns all helper executable paths with the configured CFBundleName before signing', (t) => {
  const { app, frameworks } = fixture(t);
  assert.throws(() => verifyMacHelperLayout(app, plist), /无法找到 helper/);
  const mainPlist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'));
  alignMacHelperNames(app, '悬浮岛', plist);
  verifyMacHelperLayout(app, plist);
  assert.deepEqual(fs.readFileSync(path.join(app, 'Contents', 'Info.plist')), mainPlist);
  for (const suffix of suffixes) {
    const name = `工作台 Helper${suffix}`;
    const contents = path.join(frameworks, `${name}.app`, 'Contents');
    assert.equal(fs.existsSync(path.join(contents, 'MacOS', name)), true);
    assert.equal(plist.readString(path.join(contents, 'Info.plist'), 'CFBundleExecutable'), name);
    assert.equal(plist.readString(path.join(contents, 'Info.plist'), 'CFBundleDisplayName'), `悬浮岛 Helper${suffix}`);
    assert.equal(plist.readString(path.join(contents, 'Info.plist'), 'CFBundleIdentifier'), `com.dynamicpanel.app.helper${suffix}`);
    assert.equal(fs.existsSync(path.join(frameworks, `悬浮岛 Helper${suffix}.app`)), false);
  }
  assert.doesNotThrow(() => alignMacHelperNames(app, '悬浮岛', plist), 'the signing hook can safely recheck an aligned layout');
});

test('packing rejects a missing helper before moving any other helper', (t) => {
  const { app, frameworks } = fixture(t, ' (GPU)');
  assert.throws(() => alignMacHelperNames(app, '悬浮岛', plist), /缺少 Electron helper/);
  assert.equal(fs.existsSync(path.join(frameworks, '悬浮岛 Helper.app')), true);
  assert.equal(fs.existsSync(path.join(frameworks, '工作台 Helper.app')), false);
});

test('packing verification rejects wrong helper metadata and non-executable files', (t) => {
  const { app, frameworks } = fixture(t);
  alignMacHelperNames(app, '悬浮岛', plist);
  const contents = path.join(frameworks, '工作台 Helper.app', 'Contents');
  plist.writeString(path.join(contents, 'Info.plist'), 'CFBundleExecutable', 'missing');
  assert.throws(() => verifyMacHelperLayout(app, plist), /CFBundleExecutable/);
  plist.writeString(path.join(contents, 'Info.plist'), 'CFBundleExecutable', '工作台 Helper');
  fs.chmodSync(path.join(contents, 'MacOS', '工作台 Helper'), 0o644);
  assert.throws(() => verifyMacHelperLayout(app, plist), /EACCES/);
});
