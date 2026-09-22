'use strict';

const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const START = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}';
const ROW = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${START})\\s+(.+?)\\s*$`);
const validPid = value => Number.isSafeInteger(value) && value > 1 && value <= 2147483647;
const validStart = value => typeof value === 'string' && value.length <= 40 && new RegExp(`^${START}$`).test(value);
const options = { encoding: 'utf8', maxBuffer: 32768, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } };
const argsFor = ids => ['-p', ids.join(','), '-o', 'pid=,ppid=,lstart=,comm='];

function parseProcesses(output) {
  const rows = [];
  for (const line of String(output).split('\n').filter(line => line.trim())) {
    const match = line.match(ROW);
    if (!match) return null; // Incomplete/unavailable process data is not evidence of an exit.
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt: match[3].replace(/\s+/g, ' '),
      isCodex: path.basename(match[4]) === 'codex' });
  }
  return rows;
}

// Inspect only the hook's ancestor chain, never process arguments or environment.
function findCodexOwner({ parentPid = process.ppid, execute = execFileSync, platform = process.platform, now = Date.now } = {}) {
  if (platform !== 'darwin') return null;
  const deadline = now() + 500;
  const seen = new Set();
  let pid = parentPid;
  for (let depth = 0; depth < 8 && validPid(pid) && !seen.has(pid) && now() < deadline; depth++) {
    seen.add(pid);
    let rows;
    try { rows = parseProcesses(execute('/bin/ps', argsFor([pid]), { ...options, timeout: 150 })); }
    catch { return null; }
    const row = rows?.find(row => row.pid === pid);
    if (!row) return null;
    if (row.isCodex) return { ownerPid: row.pid, ownerStartedAt: row.startedAt };
    pid = row.ppid;
  }
  return null;
}

// Liveness only preserves an already observed task. It never creates task activity.
async function readOwnerStates(identities, { signal, execute = runFile, platform = process.platform } = {}) {
  const owners = identities.filter(owner => validPid(owner?.pid) && validStart(owner.startedAt)).slice(0, 64);
  if (!owners.length) return [];
  const unknown = () => owners.map(owner => ({ ...owner, alive: null }));
  if (platform !== 'darwin' || signal?.aborted) return unknown();
  let rows;
  try {
    const result = await execute('/bin/ps', argsFor([...new Set(owners.map(owner => owner.pid))]),
      { ...options, timeout: 1500, signal });
    rows = parseProcesses(result.stdout);
  } catch (error) {
    // ps exits with 1 and no diagnostic when none of the requested PIDs exists.
    if (error.code === 1 && !String(error.stdout || '').trim() && !String(error.stderr || '').trim()) rows = [];
    else return unknown();
  }
  if (!rows || signal?.aborted) return unknown();
  return owners.map(owner => {
    const row = rows.find(row => row.pid === owner.pid);
    return { ...owner, alive: Boolean(row?.isCodex && row.startedAt === owner.startedAt) };
  });
}

module.exports = { findCodexOwner, readOwnerStates };
