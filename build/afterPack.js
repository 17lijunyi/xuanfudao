// electron-builder afterPack hook
// identity:null 跳过 electron-builder 签名；这里从内到外签名整个 bundle。
// 可显式选择固定证书身份；未配置时保留上游 ad-hoc 行为。
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { buildSystemStatusHelper } = require('../scripts/build-system-helper');
const { buildAppearanceGlass } = require('../scripts/build-appearance-glass');
const { resolveSigningPolicy, signTarget } = require('./signing-policy');
const notarizeApp = require('./notarize');

const HELPER_SUFFIXES = ['', ' (Renderer)', ' (GPU)', ' (Plugin)'];

function readPlistString(file, key) {
  return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', file], { encoding: 'utf8' }).trim();
}

function writePlistString(file, key, value) {
  execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, file], { stdio: 'pipe' });
}

function requireBundleName(value) {
  if (typeof value !== 'string' || !value || ['.', '..'].includes(value) || path.basename(value) !== value) {
    throw new Error(`无效的 macOS bundle 名称：${value}`);
  }
  return value;
}

function verifyMacHelperLayout(appPath, { readString = readPlistString } = {}) {
  const bundleName = requireBundleName(readString(path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleName'));
  for (const suffix of HELPER_SUFFIXES) {
    const helperName = `${bundleName} Helper${suffix}`;
    const helperPath = path.join(appPath, 'Contents', 'Frameworks', `${helperName}.app`);
    const executablePath = path.join(helperPath, 'Contents', 'MacOS', helperName);
    if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
      throw new Error(`Electron 无法找到 helper 可执行文件：${executablePath}`);
    }
    fs.accessSync(executablePath, fs.constants.X_OK);
    if (readString(path.join(helperPath, 'Contents', 'Info.plist'), 'CFBundleExecutable') !== helperName) {
      throw new Error(`Electron helper 的 CFBundleExecutable 与路径不一致：${helperPath}`);
    }
  }
}

function alignMacHelperNames(appPath, productFilename, { readString = readPlistString, writeString = writePlistString } = {}) {
  const bundleName = requireBundleName(readString(path.join(appPath, 'Contents', 'Info.plist'), 'CFBundleName'));
  const sourcePrefix = requireBundleName(productFilename);
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks');
  // Electron resolves helpers from CFBundleName before main.js/app.setName runs.
  // electron-builder instead uses the product name, ignoring extendInfo's name.
  // Plan every move first so a missing helper fails before changing the bundle.
  const plans = HELPER_SUFFIXES.map((suffix) => {
    const targetName = `${bundleName} Helper${suffix}`;
    const sourcePath = path.join(frameworksPath, `${sourcePrefix} Helper${suffix}.app`);
    const targetPath = path.join(frameworksPath, `${targetName}.app`);
    if (sourcePath !== targetPath && fs.existsSync(sourcePath) && fs.existsSync(targetPath)) {
      throw new Error(`Electron helper 目标目录已存在：${targetPath}`);
    }
    const existingPath = fs.existsSync(sourcePath) ? sourcePath : targetPath;
    if (!fs.existsSync(existingPath)) throw new Error(`缺少 Electron helper：${sourcePath}`);
    const plistPath = path.join(existingPath, 'Contents', 'Info.plist');
    const executableName = requireBundleName(readString(plistPath, 'CFBundleExecutable'));
    const executablePath = path.join(existingPath, 'Contents', 'MacOS', executableName);
    const renamedExecutablePath = path.join(existingPath, 'Contents', 'MacOS', targetName);
    if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
      throw new Error(`缺少 Electron helper 可执行文件：${executablePath}`);
    }
    if (executablePath !== renamedExecutablePath && fs.existsSync(renamedExecutablePath)) {
      throw new Error(`Electron helper 目标可执行文件已存在：${renamedExecutablePath}`);
    }
    return { existingPath, targetPath, targetName, plistPath, executablePath, renamedExecutablePath };
  });

  for (const plan of plans) {
    if (plan.executablePath !== plan.renamedExecutablePath) fs.renameSync(plan.executablePath, plan.renamedExecutablePath);
    writeString(plan.plistPath, 'CFBundleExecutable', plan.targetName);
    if (plan.existingPath !== plan.targetPath) fs.renameSync(plan.existingPath, plan.targetPath);
  }
  verifyMacHelperLayout(appPath, { readString });
}

exports.alignMacHelperNames = alignMacHelperNames;
exports.verifyMacHelperLayout = verifyMacHelperLayout;

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  // Validate before this hook renames, compiles, or signs any artifact.
  const signingPolicy = resolveSigningPolicy({
    macIdentity: context.packager.platformSpecificBuildOptions?.identity,
  });

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  const projectRoot = path.resolve(__dirname, '..');
  const macOSDirectory = path.join(appPath, 'Contents', 'MacOS');
  const electronExecutablePath = path.join(macOSDirectory, context.packager.appInfo.productFilename);

  if (!fs.existsSync(electronExecutablePath)) {
    throw new Error(`找不到 Electron 主程序：${electronExecutablePath}`);
  }

  alignMacHelperNames(appPath, context.packager.appInfo.sanitizedProductName || context.packager.appInfo.productFilename);
  const systemHelperPath = buildSystemStatusHelper({
    projectRoot,
    outputPath: path.join(appPath, 'Contents', 'Resources', 'native', 'system-status-helper'),
  });
  const appearanceGlassPath = buildAppearanceGlass({
    projectRoot,
    outputPath: path.join(appPath, 'Contents', 'Resources', 'native', 'appearance-glass.node'),
    arch: context.arch === 1 ? 'x64' : context.arch === 4 ? 'universal' : 'arm64',
  });

  console.log(`  • ${signingPolicy.label} 签名 ${appPath}`);

  // 依次签：所有 dylib → Framework 内 Helpers → Framework binary → Helper apps → Frameworks → 主 bundle
  const entitlementsPath = path.join(projectRoot, 'build', 'entitlements.mac.plist');
  // 保留默认 ad-hoc 路径的失败汇总与最终 deep verify。
  // 显式证书路径任一步失败立即停止，避免旧签名掩盖身份切换失败。
  const signFailures = [];
  const cs = (file, executable = false) => {
    try {
      signTarget(file, { policy: signingPolicy, executable, entitlementsPath });
    } catch (e) {
      // A previously valid signature must not hide a failed identity change.
      if (signingPolicy.explicit) throw new Error(`指定证书签名失败，已停止且不会退回 ad-hoc：${file}: ${e.message}`);
      signFailures.push(`${file}: ${e.message}`);
      console.warn(`    codesign 失败 ${file}: ${e.message}`);
    }
  };

  const walk = (dir, predicate, cb) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.endsWith('.app') && !entry.name.endsWith('.framework')) {
        walk(full, predicate, cb);
      } else if (entry.isFile() && predicate(entry.name, full)) {
        cb(full);
      }
    }
  };

  const fwDir = path.join(appPath, 'Contents', 'Frameworks');

  // 1) 所有 dylib
  cs(appearanceGlassPath);
  walk(fwDir, (n) => n.endsWith('.dylib'), cs);

  // 2) Electron Framework 内部的 Helpers (chrome_crashpad_handler 等)
  const efw = path.join(fwDir, 'Electron Framework.framework', 'Versions', 'A', 'Helpers');
  if (fs.existsSync(efw)) {
    for (const f of fs.readdirSync(efw)) cs(path.join(efw, f), true);
  }

  // 3) Electron Framework 主 binary
  const efwBin = path.join(fwDir, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  if (fs.existsSync(efwBin)) cs(efwBin);

  // 4) 每个 Helper.app 的内部 binary
  for (const entry of fs.readdirSync(fwDir)) {
    if (entry.endsWith('.app')) {
      const macosDir = path.join(fwDir, entry, 'Contents', 'MacOS');
      if (fs.existsSync(macosDir)) {
        for (const f of fs.readdirSync(macosDir)) cs(path.join(macosDir, f), true);
      }
    }
  }

  // 5) 每个 Helper.app 整体
  for (const entry of fs.readdirSync(fwDir)) {
      if (entry.endsWith('.app')) cs(path.join(fwDir, entry), true);
  }

  // 6) 每个 Framework 整体
  for (const entry of fs.readdirSync(fwDir)) {
    if (entry.endsWith('.framework')) cs(path.join(fwDir, entry));
  }

  // The system observer is a separate user-level native process. Sign it before
  // the enclosing bundle so it is covered by the final deep verification.
  cs(systemHelperPath, true);

  // 7) Electron 主程序（Contents/MacOS 下唯一的可执行文件）
  cs(electronExecutablePath, true);

  // 8) 主 bundle
  cs(appPath, true);

  // 校验：失败必须中断构建，否则本地会拿到一个签名已坏、却看起来构建成功的 DMG。
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' });
    console.log(`  ✓ 签名校验通过`);
  } catch (e) {
    if (signFailures.length) {
      console.error(`  ✗ 期间有 ${signFailures.length} 个文件签名失败：`);
      for (const failure of signFailures) console.error(`      ${failure}`);
    }
    throw new Error(`${signingPolicy.label} 签名校验失败，产物不可分发：${e.message}`);
  }

  // Keep package.json electronFuses unset while this lives in afterPack: fuses
  // run later and would otherwise mutate the signed executable. This project
  // signs in afterPack itself, so notarization follows the verified signature.
  await notarizeApp(context);
};
