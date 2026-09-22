'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Renderer requests can select a preset, never supply CSS or filesystem paths.
const CATALOG = Object.freeze([
  ['system-glass-blurred', '柔焦玻璃', 80],
  ['classic', '纯黑', 0],
].map(([id, name, transparency]) => Object.freeze({ id, name, transparency })));
const PRESET_IDS = new Set(CATALOG.map(({ id }) => id));
const LEGACY_GLASS_IDS = new Set(['system-glass', 'glass-01', 'glass-02', 'glass-03', 'glass-04', 'glass-05']);

function createAppearanceSettingsService({ filePath, fs = nodeFs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath_required');

  let selectedId = 'system-glass-blurred';
  let revision = 0;
  let persisted = false;
  let pending = Promise.resolve();
  try {
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.version === 1 && PRESET_IDS.has(saved.selectedId)) {
      selectedId = saved.selectedId;
      persisted = true;
    } else if (saved?.version === 1 && LEGACY_GLASS_IDS.has(saved.selectedId)) {
      selectedId = 'system-glass-blurred';
    }
  } catch (_) {
    // Missing or damaged preferences must not prevent the workbench opening.
  }

  function getSnapshot() {
    return { selectedId, revision, presets: CATALOG.map((preset) => ({ ...preset })) };
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

module.exports = { CATALOG, catalog: CATALOG, createAppearanceSettingsService };
