'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { notarize } = require('@electron/notarize');
const { resolveSigningPolicy } = require('./signing-policy');

function readNotarizationPolicy({ env = process.env } = {}) {
  const required = env.FUDAO_NOTARIZE_REQUIRED === '1';
  const profile = env.FUDAO_NOTARY_KEYCHAIN_PROFILE;
  if (profile === undefined || profile === '') {
    if (required) throw new Error('正式分发要求 FUDAO_NOTARY_KEYCHAIN_PROFILE；请先把 Apple 公证凭据保存到 macOS 钥匙串。');
    return { enabled: false, required, profile: null };
  }
  if (typeof profile !== 'string' || profile.length > 128 || /[\u0000-\u001f\u007f]/.test(profile)) {
    throw new Error('FUDAO_NOTARY_KEYCHAIN_PROFILE 必须是 1–128 个字符且不含控制字符。');
  }
  return { enabled: true, required, profile };
}

async function notarizeApp(context, {
  env = process.env,
  submit = notarize,
  resolveSigning = resolveSigningPolicy,
  verify = execFileSync,
  log = console.log,
} = {}) {
  if (context?.electronPlatformName !== 'darwin') return;
  const notarization = readNotarizationPolicy({ env });
  if (!notarization.enabled) return;

  const policy = resolveSigning({
    env,
    macIdentity: context.packager?.platformSpecificBuildOptions?.identity,
  });
  if (!policy.explicit || !policy.developerId) {
    throw new Error('Apple 公证要求 Developer ID Application 证书；ad-hoc 或本地开发证书不能用于对外分发。');
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  log(`  • 提交 Apple 公证并装订票据 ${appPath}`);
  await submit({ appPath, keychainProfile: notarization.profile });
  verify('/usr/bin/xcrun', ['stapler', 'validate', appPath], { stdio: 'pipe' });
  log('  ✓ Apple 公证与票据装订完成');
}

module.exports = notarizeApp;
module.exports.default = notarizeApp;
module.exports.readNotarizationPolicy = readNotarizationPolicy;
module.exports.notarizeApp = notarizeApp;
