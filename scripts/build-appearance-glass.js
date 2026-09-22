#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function buildAppearanceGlass({ projectRoot = path.resolve(__dirname, '..'), outputPath = path.join(projectRoot, '.cache', 'native', 'appearance-glass.node'), includePath, arch = process.arch, runFile = execFileSync } = {}) {
  if (process.platform !== 'darwin') throw new Error('原生玻璃背景只能在 macOS 上构建');
  const headerPath = [includePath, process.env.FUDAO_NODE_INCLUDE, '/usr/local/include/node', '/opt/homebrew/include/node', path.resolve(path.dirname(process.execPath), '../include/node')]
    .filter(Boolean).find(candidate => fs.existsSync(path.join(candidate, 'node_api.h')));
  if (!headerPath) throw new Error('缺少 Node.js 的 node_api.h；安装 Node.js 开发头文件，或设置 FUDAO_NODE_INCLUDE');
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error('不支持的 macOS 架构');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  const architectures = arch === 'universal' ? ['arm64', 'x86_64'] : [arch === 'x64' ? 'x86_64' : arch];
  try {
    runFile('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-fblocks', '-bundle', '-undefined', 'dynamic_lookup', '-mmacosx-version-min=13.0', ...architectures.flatMap(value => ['-arch', value]), '-DNAPI_VERSION=8', '-I', headerPath, '-framework', 'Cocoa', '-framework', 'QuartzCore', path.join(projectRoot, 'native', 'appearance-glass.mm'), '-o', temporaryPath], { stdio: 'inherit' });
    runFile('/usr/bin/codesign', ['--force', '--sign', '-', temporaryPath], { stdio: 'inherit' });
    fs.chmodSync(temporaryPath, 0o755);
    fs.renameSync(temporaryPath, outputPath);
    return outputPath;
  } finally { try { fs.unlinkSync(temporaryPath); } catch (_) {} }
}
module.exports = { buildAppearanceGlass };
if (require.main === module) process.stdout.write(`${buildAppearanceGlass({ outputPath: process.argv[2] || undefined })}\n`);
