const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readNotarizationPolicy, notarizeApp } = require('../build/notarize');

test('the self-signing afterPack hook owns notarization when builder signing is disabled', () => {
  const packageConfig = require('../package.json');
  const afterPack = fs.readFileSync(path.join(__dirname, '..', 'build', 'afterPack.js'), 'utf8');
  assert.equal(packageConfig.build.afterPack, './build/afterPack.js');
  assert.equal(packageConfig.build.electronFuses, undefined,
    'afterPack signing and notarization require electronFuses to stay disabled until they move to a post-fuse hook');
  assert.equal(Object.hasOwn(packageConfig.build, 'afterSign'), false,
    'electron-builder skips afterSign when mac.identity=null');
  assert.match(afterPack, /await notarizeApp\(context\)/,
    'notarization must run after the project self-signs and verifies the app');
});

const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
const context = {
  electronPlatformName: 'darwin',
  appOutDir: '/fixture/output',
  packager: {
    platformSpecificBuildOptions: { identity: null },
    appInfo: { productFilename: '浮岛' },
  },
};

test('ordinary local builds skip notarization without touching credentials', async () => {
  assert.deepEqual(readNotarizationPolicy({ env: {} }), { enabled: false, required: false, profile: null });
  let submitted = false;
  await notarizeApp(context, { env: {}, submit: async () => { submitted = true; } });
  assert.equal(submitted, false);
});

test('distribution builds fail closed when the keychain profile is missing or invalid', () => {
  assert.throws(() => readNotarizationPolicy({ env: { FUDAO_NOTARIZE_REQUIRED: '1' } }), /KEYCHAIN_PROFILE/);
  assert.throws(() => readNotarizationPolicy({ env: { FUDAO_NOTARY_KEYCHAIN_PROFILE: 'bad\nprofile' } }), /控制字符/);
});

test('notarization accepts only an explicit Developer ID Application identity', async () => {
  const env = { FUDAO_SIGNING_IDENTITY: fingerprint, FUDAO_NOTARY_KEYCHAIN_PROFILE: 'FuDao Notary' };
  await assert.rejects(notarizeApp(context, {
    env,
    resolveSigning: () => ({ identity: '-', explicit: false, developerId: false }),
    submit: async () => assert.fail('ad-hoc apps must not be submitted'),
    verify: () => assert.fail('ad-hoc apps must not be verified'),
  }), /Developer ID Application/);
  await assert.rejects(notarizeApp(context, {
    env,
    resolveSigning: () => ({ identity: fingerprint, explicit: true, developerId: false }),
    submit: async () => assert.fail('development identities must not be submitted'),
    verify: () => assert.fail('development identities must not be verified'),
  }), /Developer ID Application/);
});

test('a Developer ID app is submitted by keychain profile and never exposes credentials', async () => {
  const calls = [];
  const verifications = [];
  const logs = [];
  const env = { FUDAO_SIGNING_IDENTITY: fingerprint, FUDAO_NOTARY_KEYCHAIN_PROFILE: 'FuDao Notary' };
  await notarizeApp(context, {
    env,
    resolveSigning: () => ({ identity: fingerprint, explicit: true, developerId: true }),
    submit: async (options) => calls.push(options),
    verify: (...args) => verifications.push(args),
    log: (message) => logs.push(message),
  });
  assert.deepEqual(calls, [{ appPath: '/fixture/output/浮岛.app', keychainProfile: 'FuDao Notary' }]);
  assert.deepEqual(verifications, [['/usr/bin/xcrun', ['stapler', 'validate', '/fixture/output/浮岛.app'], { stdio: 'pipe' }]]);
  assert.equal(JSON.stringify({ calls, logs }).includes('password'), false);
});
