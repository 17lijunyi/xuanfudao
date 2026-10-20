'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native system UI policy excludes the cursor but preserves menus and other system overlays',
  { skip: process.platform !== 'darwin' }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-system-ui-policy-'));
    try {
      const source = path.join(directory, 'policy-test.cpp');
      const executable = path.join(directory, 'policy-test');
      fs.writeFileSync(source, `
#include <CoreGraphics/CGWindowLevel.h>
#include <iostream>
#include "system-ui-window-policy.h"

// Reproduce the Window Server pointer layer observed during hover, without
// depending on its value staying the same on future macOS releases.
static_assert(!shouldInspectSystemUIWindowLayer(2147483630, 2147483630));
static_assert(!shouldInspectSystemUIWindowLayer(4096, 4096));
static_assert(shouldInspectSystemUIWindowLayer(2147483630, 4096));

int main() {
  const std::int64_t cursorLayer = CGWindowLevelForKey(kCGCursorWindowLevelKey);
  struct Case { std::int64_t layer; bool expected; const char *name; };
  const Case cases[] = {
    {cursorLayer, false, "system cursor"},
    {-1, false, "background"}, {0, false, "normal app"},
    {3, false, "floating app"}, {19, false, "below system UI"},
    {20, true, "system input overlay"},
    {24, false, "menu-bar background"}, {25, false, "status-item hit area"},
    {26, true, "system overlay"}, {101, true, "open menu"},
    {1000, true, "screen saver"},
    {cursorLayer - 1, true, "high layer below cursor"},
    {cursorLayer + 1, true, "high layer above cursor"},
  };
  for (const auto &entry : cases) {
    if (shouldInspectSystemUIWindowLayer(entry.layer, cursorLayer) != entry.expected) {
      std::cerr << entry.name << " (layer " << entry.layer << ") failed\\n";
      return 1;
    }
  }
  std::cout << "system-ui-window-policy: passed\\n";
}
`);
      execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++17',
        '-Wall', '-Wextra', '-Werror', '-I', path.resolve(__dirname, '../native'),
        source, '-framework', 'CoreGraphics', '-o', executable],
      { timeout: 30000, stdio: 'pipe' });
      assert.equal(execFileSync(executable, { encoding: 'utf8', timeout: 3000 }).trim(),
        'system-ui-window-policy: passed');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
