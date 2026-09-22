(() => {
  'use strict';
  // Shared by completion and system prompts; messages contain geometry only.
  window.IslandPopupAppearance = Object.freeze({
    create({ api, elements, isRendered, eventId, sendSurface, onMaterial }) {
      let revision = -1;
      let frame = 0;
      let until = 0;
      let previous = '';
      function sample() {
        frame = 0;
        let surfaces = null;
        if (isRendered() && !document.hidden && document.documentElement.dataset.appearance === 'system-glass-blurred') {
          surfaces = elements.map(element => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              radii: Array(4).fill(Math.min(rect.width, rect.height) / 2),
              opacity: Number(getComputedStyle(element).opacity), backgroundBlurRadius: 20 };
          });
        }
        const payload = { eventId: eventId(), viewport: { width: innerWidth, height: innerHeight }, surfaces };
        const key = JSON.stringify(payload);
        if (key !== previous) { previous = key; sendSurface?.(payload); }
        if (performance.now() < until && !document.hidden) frame = requestAnimationFrame(sample);
      }
      function refreshSurface() {
        previous = ''; until = performance.now() + 1100;
        if (!frame) frame = requestAnimationFrame(sample);
      }
      function applyAppearance(snapshot) {
        if (!snapshot || !['classic', 'system-glass-blurred'].includes(snapshot.selectedId)) return;
        const next = Number.isFinite(snapshot.revision) ? snapshot.revision : 0;
        if (next < revision) return;
        revision = next;
        const root = document.documentElement;
        if (root.dataset.appearance !== snapshot.selectedId) root.dataset.nativeGlass = 'false';
        root.dataset.appearance = snapshot.selectedId;
        refreshSurface();
      }
      function clearSurface() {
        cancelAnimationFrame(frame); frame = 0; until = 0; previous = '';
        sendSurface?.({ eventId: eventId(), surfaces: null });
      }
      api.onAppearanceSettingsChanged?.(applyAppearance);
      onMaterial?.(value => {
        if (value?.appearance?.revision !== revision || value.appearance.selectedId !== document.documentElement.dataset.appearance) return;
        document.documentElement.dataset.nativeGlass = value.native === true ? 'true' : 'false';
      });
      window.addEventListener('resize', refreshSurface);
      document.addEventListener('visibilitychange', refreshSurface);
      window.addEventListener('pagehide', clearSurface);
      return { applyAppearance, refreshSurface, clearSurface };
    },
  });
})();
