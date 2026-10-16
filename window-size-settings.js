'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Renderer requests can select a preset, never supply CSS or filesystem paths.
const CATALOG = Object.freeze([
  ['A', '适合 16 寸或 15.3 寸', 1240], ['B', '适合 14 寸或 13 寸', 1040],
].map(([id, name, width]) => Object.freeze({ id, name, width })));
const PRESET_IDS = new Set(CATALOG.map(({ id }) => id));

function createWindowSizeSettingsService({ filePath, fs = nodeFs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath_required');

  let selectedId = 'B';
  let revision = 0;
  let persisted = false;
  let pending = Promise.resolve();
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version === 1 && PRESET_IDS.has(saved.selectedId)) {
      selectedId = saved.selectedId;
      persisted = true;
    }
  } catch (_) {
    // Missing or damaged preferences must not prevent the workbench opening.
  }

  function getSnapshot() {
    return { selectedId, width: CATALOG.find(preset => preset.id === selectedId).width, revision, presets: CATALOG.map((preset) => ({ ...preset })) };
  }

  async function save(id) {
    if (!PRESET_IDS.has(id)) return { ok: false, error: 'invalid_preset', snapshot: getSnapshot() };
    if (persisted && id === selectedId) return { ok: true, snapshot: getSnapshot() };

    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(temporary, `${JSON.stringify({ version: 1, selectedId: id })}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await fs.promises.rename(temporary, filePath);
    } catch (_) {
      try { await fs.promises.unlink(temporary); } catch (_) {}
      return { ok: false, error: 'save_failed', snapshot: getSnapshot() };
    }
    selectedId = id;
    revision += 1;
    persisted = true;
    return { ok: true, snapshot: getSnapshot() };
  }

  function setPreset(id) {
    // Serialize writes so a slower earlier request cannot replace a newer one.
    const result = pending.then(() => save(id));
    pending = result.catch(() => {});
    return result;
  }

  return Object.freeze({ getSnapshot, setPreset });
}

module.exports = { CATALOG, catalog: CATALOG, createWindowSizeSettingsService };
