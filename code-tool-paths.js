'use strict';
const fs = require('node:fs');
const path = require('node:path');

// A Finder-launched app doesn't inherit interactive shell/version-manager PATH.
// Read known installation directories; never execute shell startup scripts.
function binarySearchPaths(home, env = process.env) {
  const dirs = [...(env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin',
    ...['.local/bin', '.npm-global/bin', '.bun/bin', '.cargo/bin', '.volta/bin', '.local/share/mise/shims',
      '.opencode/bin', '.mimocode/bin', 'Library/pnpm'].map(dir => path.join(home, dir))];
  for (const relative of ['.nvm/versions/node', '.local/share/fnm/node-versions']) {
    try { for (const version of fs.readdirSync(path.join(home, relative)).sort().reverse().slice(0, 40)) {
      dirs.push(path.join(home, relative, version, relative.includes('fnm') ? 'installation/bin' : 'bin'));
    } } catch (_) {}
  }
  return [...new Set(dirs.filter(dir => path.isAbsolute(dir)))];
}
module.exports = { binarySearchPaths };
