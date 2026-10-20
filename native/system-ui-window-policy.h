#ifndef FUDAO_SYSTEM_UI_WINDOW_POLICY_H
#define FUDAO_SYSTEM_UI_WINDOW_POLICY_H

#include <cstdint>

inline constexpr bool shouldInspectSystemUIWindowLayer(std::int64_t layer, std::int64_t cursorLayer) {
  // Menu-bar backgrounds (24), persistent status-item hit areas (25), and
  // the pointer itself are not transient UI that should hide the island.
  return layer >= 20 && layer != 24 && layer != 25 && layer != cursorLayer;
}

#endif
