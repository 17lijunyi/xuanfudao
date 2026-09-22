const { execFileSync } = require('child_process');

function resolveSigningPolicy({
  env = process.env,
  macIdentity,
  execute = execFileSync,
  warn = console.warn,
} = {}) {
  const requested = env.FUDAO_SIGNING_IDENTITY;
  if (requested === undefined) {
    warn('  ⚠ 未配置 FUDAO_SIGNING_IDENTITY，继续使用 ad-hoc 签名；它不能跨版本保持系统授权身份，更新后可能需要重新授权。');
    return { identity: '-', explicit: false, label: 'ad-hoc' };
  }
  if (typeof requested !== 'string' || !/^[a-fA-F0-9]{40}$/.test(requested)) {
    throw new Error('FUDAO_SIGNING_IDENTITY 必须是签名证书的 40 位 SHA-1 指纹；不会退回 ad-hoc 签名。');
  }
  if (macIdentity !== null) {
    throw new Error('设置 FUDAO_SIGNING_IDENTITY 时必须添加 --config.mac.identity=null，防止 electron-builder 后续签名覆盖指定身份。');
  }

  let output;
  try {
    output = execute('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`无法只读验证签名身份；不会退回 ad-hoc 签名：${error.message}`);
  }
  const identity = requested.toUpperCase();
  const available = Array.from(String(output).matchAll(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"([^"]+)"/gm), (match) => ({
    fingerprint: match[1].toUpperCase(),
    name: match[2],
  }));
  const selected = available.find((candidate) => candidate.fingerprint === identity);
  if (!selected) {
    throw new Error(`未找到有效且具有私钥的代码签名身份 ${identity}；不会退回 ad-hoc 签名。`);
  }
  const developerId = /^Developer ID Application:/i.test(selected.name);
  return { identity, explicit: true, developerId, certificateName: selected.name, label: `证书 ${identity}` };
}

function signTarget(file, { policy, executable = false, entitlementsPath, execute = execFileSync }) {
  // Apple requires a secure timestamp for Developer ID distribution. Keep
  // ad-hoc and local development identities offline and deterministic.
  const args = ['--force', '--sign', policy.identity, policy.developerId ? '--timestamp' : '--timestamp=none'];
  if (executable) args.push('--options', 'runtime', '--entitlements', entitlementsPath);
  args.push(file);
  execute('codesign', args, { stdio: 'pipe' });
}

module.exports = { resolveSigningPolicy, signTarget };
