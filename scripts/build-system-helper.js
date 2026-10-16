#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function buildSystemStatusHelper({
  projectRoot = path.resolve(__dirname, '..'),
  outputPath = process.argv[2] || path.join(projectRoot, '.cache', 'native', 'system-status-helper'),
  runFile = execFileSync,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('system-status-helper 只能在 macOS 上构建');
  const sourcePath = path.join(projectRoot, 'native', 'system-status-helper.swift');
  if (!fs.existsSync(sourcePath)) throw new Error(`缺少原生 helper 源码：${sourcePath}`);
  const policyPath = path.join(projectRoot, 'native', 'hud-key-policy.swift');
  if (!fs.existsSync(policyPath)) throw new Error(`缺少按键策略源码：${policyPath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    runFile('/usr/bin/xcrun', [
      '--sdk', 'macosx', 'swiftc',
      '-O', '-whole-module-optimization',
      '-target', 'arm64-apple-macos13.0',
      '-framework', 'CoreAudio',
      '-framework', 'AudioToolbox',
      '-framework', 'CoreGraphics',
      '-framework', 'IOKit',
      '-framework', 'AppKit',
      '-framework', 'ApplicationServices',
      sourcePath, policyPath,
      '-o', temporaryPath,
    ], { stdio: 'inherit' });
    fs.chmodSync(temporaryPath, 0o755);
    fs.renameSync(temporaryPath, outputPath);
    return outputPath;
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
  }
}

module.exports = { buildSystemStatusHelper };

if (require.main === module) {
  const outputPath = buildSystemStatusHelper();
  process.stdout.write(`${outputPath}\n`);
}
