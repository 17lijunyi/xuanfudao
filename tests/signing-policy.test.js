const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSigningPolicy, signTarget } = require('../build/signing-policy');

const fingerprint = '0123456789ABCDEF0123456789ABCDEF01234567';
const options = (overrides = {}) => ({
  env: { FUDAO_SIGNING_IDENTITY: fingerprint },
  macIdentity: null,
  execute: () => `  1) ${fingerprint} "Local signing identity"\n     1 valid identities found\n`,
  warn: () => assert.fail('Explicit signing must not warn and fall back'),
  ...overrides,
});

const developerOptions = (overrides = {}) => options({
  execute: () => `  1) ${fingerprint} "Developer ID Application: Fu Dao (ABCDE12345)"\n     1 valid identities found\n`,
  ...overrides,
});

test('unconfigured builds preserve ad-hoc behavior and warn about authorization across updates', () => {
  const warnings = [];
  const policy = resolveSigningPolicy({ env: {}, execute: () => assert.fail('No certificate query is needed'), warn: (message) => warnings.push(message) });
  assert.equal(policy.identity, '-');
  assert.equal(policy.explicit, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /不能跨版本保持系统授权身份/);
});

test('explicit identity accepts only a complete SHA-1 and rejects before querying the system', () => {
  for (const invalid of ['', '-', 'Local signing identity', fingerprint + '0', fingerprint.slice(1), fingerprint + '\n']) {
    assert.throws(() => resolveSigningPolicy(options({ env: { FUDAO_SIGNING_IDENTITY: invalid }, execute: () => assert.fail('Invalid input must fail first') })), /40 位 SHA-1/);
  }
});

test('explicit identity prevents electron-builder from overwriting the hook signature', () => {
  for (const identity of [undefined, '-', 'Local signing identity', false]) {
    assert.throws(() => resolveSigningPolicy(options({ macIdentity: identity, execute: () => assert.fail('Unsafe builder config must fail first') })), /--config.mac.identity=null/);
  }
});

test('identity lookup is read-only, matches a valid identity exactly, and normalizes case', () => {
  const calls = [];
  const policy = resolveSigningPolicy(options({
    env: { FUDAO_SIGNING_IDENTITY: fingerprint.toLowerCase() },
    execute: (...args) => { calls.push(args); return `  1) ${fingerprint} "Local signing identity"\n  1 valid identities found\n`; },
  }));
  assert.deepEqual(calls, [['/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }]]);
  assert.equal(policy.identity, fingerprint);
  assert.equal(policy.explicit, true);
  assert.equal(policy.developerId, false);
  assert.equal(policy.certificateName, 'Local signing identity');
});

test('missing identities, misleading names, and lookup failures never return an ad-hoc policy', () => {
  for (const output of ['  0 valid identities found\n', `  1) ${'F'.repeat(40)} "${fingerprint}"\n`, fingerprint]) {
    assert.throws(() => resolveSigningPolicy(options({ execute: () => output })), /未找到有效.*不会退回 ad-hoc/);
  }
  assert.throws(() => resolveSigningPolicy(options({ execute: () => { throw new Error('lookup unavailable'); } })), /无法只读验证.*不会退回 ad-hoc/);
});

test('every target uses the selected certificate with existing executable entitlements', () => {
  const policy = resolveSigningPolicy(options());
  const calls = [];
  const execute = (...args) => calls.push(args);
  signTarget('/fixture/Framework', { policy, execute });
  signTarget('/fixture/浮岛.app', { policy, executable: true, entitlementsPath: '/fixture/entitlements.plist', execute });
  assert.deepEqual(calls, [
    ['codesign', ['--force', '--sign', fingerprint, '--timestamp=none', '/fixture/Framework'], { stdio: 'pipe' }],
    ['codesign', ['--force', '--sign', fingerprint, '--timestamp=none', '--options', 'runtime', '--entitlements', '/fixture/entitlements.plist', '/fixture/浮岛.app'], { stdio: 'pipe' }],
  ]);
});

test('Developer ID signatures use the secure timestamp required for notarization', () => {
  const policy = resolveSigningPolicy(developerOptions());
  const calls = [];
  signTarget('/fixture/浮岛.app', {
    policy,
    executable: true,
    entitlementsPath: '/fixture/entitlements.plist',
    execute: (...args) => calls.push(args),
  });
  assert.equal(policy.developerId, true);
  assert.match(policy.certificateName, /^Developer ID Application:/);
  assert.deepEqual(calls[0][1].slice(0, 5), ['--force', '--sign', fingerprint, '--timestamp', '--options']);
});

test('a signing failure propagates without attempting any fallback signature', () => {
  const calls = [];
  assert.throws(() => signTarget('/fixture/浮岛.app', {
    policy: resolveSigningPolicy(options()),
    execute: (...args) => { calls.push(args); throw new Error('private key unavailable'); },
  }), /private key unavailable/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1][2], fingerprint);
});

test('afterPack validates explicit identity before accessing or mutating the app bundle', async () => {
  const previous = process.env.FUDAO_SIGNING_IDENTITY;
  process.env.FUDAO_SIGNING_IDENTITY = 'invalid';
  try {
    await assert.rejects(require('../build/afterPack').default({
      electronPlatformName: 'darwin',
      packager: { platformSpecificBuildOptions: { identity: null } },
      get appOutDir() { assert.fail('Artifact access must follow signing preflight'); },
    }), /40 位 SHA-1/);
  } finally {
    if (previous === undefined) delete process.env.FUDAO_SIGNING_IDENTITY;
    else process.env.FUDAO_SIGNING_IDENTITY = previous;
  }
});
