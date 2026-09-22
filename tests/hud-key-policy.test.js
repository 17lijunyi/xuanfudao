'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native media-key policy preserves system handling and owns only successful key pairs', { skip: process.platform !== 'darwin' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-hud-policy-'));
  try {
    const executable = path.join(directory, 'policy-test');
    execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc',
      path.resolve(__dirname, '../native/hud-key-policy.swift'),
      path.resolve(__dirname, 'hud-key-policy.native.swift'), '-o', executable],
    { timeout: 30000, stdio: 'pipe' });
    assert.equal(execFileSync(executable, { encoding: 'utf8', timeout: 3000 }).trim(), 'hud-key-policy: passed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
