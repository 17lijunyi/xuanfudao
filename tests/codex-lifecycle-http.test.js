const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { getLifecycleToken, createLifecycleHttpHandler } = require('../codex-lifecycle-http');

test('lifecycle token is private, stable and refuses symlinks or permissive files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fudao-token-'));
  try {
    const file = path.join(directory, 'codex-lifecycle-token');
    const token = getLifecycleToken(directory);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(getLifecycleToken(directory), token);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    assert.equal(getLifecycleToken(directory), null);
    fs.renameSync(file, `${file}.old`); fs.symlinkSync(`${file}.old`, file);
    assert.equal(getLifecycleToken(directory), null);
  } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('lifecycle HTTP authenticates, rejects browser origin and bounds JSON before ingestion', async () => {
  const seen = [], token = 'a'.repeat(64);
  const server = http.createServer(createLifecycleHttpHandler({ token, ingest: (value) => { seen.push(value); return {ok: true}; } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/codex-lifecycle`;
  const send = (headers, body = '{}') => fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body});
  try {
    assert.equal((await send({})).status, 403);
    assert.equal((await send({Authorization: `Bearer ${token}`, Origin: 'http://localhost'})).status, 403);
    assert.equal((await send({Authorization: `Bearer ${token}`}, 'x'.repeat(4097))).status, 413);
    assert.equal((await send({Authorization: `Bearer ${token}`}, '{bad')).status, 400);
    assert.equal(seen.length, 0);
    assert.equal((await send({Authorization: `Bearer ${token}`}, '{"version":1}')).status, 202);
    assert.deepEqual(seen, [{version: 1}]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
