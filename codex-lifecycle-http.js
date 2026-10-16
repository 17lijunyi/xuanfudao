'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function getLifecycleToken(directory) {
  try { fs.mkdirSync(directory, { recursive: true }); } catch (_) { return null; }
  const file = path.join(directory, 'codex-lifecycle-token');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') return null; }
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) return null;
    const token = fs.readFileSync(descriptor, 'utf8').trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch (_) { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function createLifecycleHttpHandler({ token, ingest }) {
  const respond = (response, status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  };
  return function handle(request, response) {
    if (request.method !== 'POST') { respond(response, 405, { ok: false }); return; }
    const received = Buffer.from(String(request.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (!token || request.headers.origin || received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      respond(response, 403, { ok: false, error: 'unauthorized' }); return;
    }
    if (String(request.headers['content-type'] || '').split(';')[0] !== 'application/json') { respond(response, 415, { ok: false }); return; }
    let size = 0, tooLarge = false;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) { tooLarge = true; chunks.length = 0; }
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on('end', async () => {
      if (tooLarge) { respond(response, 413, { ok: false }); return; }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result = await ingest(payload);
        respond(response, result?.ok ? 202 : 400, { ok: result?.ok === true, ...(result?.error ? { error: result.error } : {}) });
      } catch (_) { respond(response, 400, { ok: false, error: 'invalid_event' }); }
    });
    request.on('error', () => { if (!response.headersSent) respond(response, 400, { ok: false }); });
  };
}

module.exports = { getLifecycleToken, createLifecycleHttpHandler };
