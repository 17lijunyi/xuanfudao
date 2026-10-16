'use strict';

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const EDGE_TOLERANCE = 1;
// Only soft glass reaches this path; classic clears the native surface.
// Old renderer frames must not restore the retired clear/weak-blur material.
const SOFT_GLASS_BLUR_RADIUS = 20;

function normalizeAppearanceSurface(payload, bounds) {
  if (!payload || payload.surface === null) return null;
  const viewport = payload.viewport;
  const surface = payload.surface;
  if (!viewport || !surface || !bounds) return null;
  if (![bounds.width, bounds.height, viewport.width, viewport.height].every(finiteNumber)) return null;
  if (bounds.width <= 0 || bounds.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  if (Math.abs(viewport.width - bounds.width) > EDGE_TOLERANCE
    || Math.abs(viewport.height - bounds.height) > EDGE_TOLERANCE) return null;

  const { x, y, width, height, radii, opacity } = surface;
  const backgroundBlurRadius = surface.backgroundBlurRadius;
  if (backgroundBlurRadius !== undefined && (!Number.isInteger(backgroundBlurRadius)
    || backgroundBlurRadius < 0 || backgroundBlurRadius > 32)) return null;
  if (![x, y, width, height, opacity].every(finiteNumber)) return null;
  if (width <= 0 || height <= 0 || opacity < 0 || opacity > 1) return null;
  if (!Array.isArray(radii) || radii.length !== 4
    || ![radii[0], radii[1], radii[2], radii[3]].every(finiteNumber)) return null;
  if (x < -EDGE_TOLERANCE || y < -EDGE_TOLERANCE
    || x + width > bounds.width + EDGE_TOLERANCE
    || y + height > bounds.height + EDGE_TOLERANCE) return null;

  // Tolerate rounding at window edges without drawing outside its content area.
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(bounds.width, x + width);
  const bottom = Math.min(bounds.height, y + height);
  const normalizedWidth = right - left;
  const normalizedHeight = bottom - top;
  if (normalizedWidth <= 0 || normalizedHeight <= 0) return null;
  const normalizedRadii = radii.map((radius) => Math.max(0, radius));
  const [topLeft, topRight, bottomRight, bottomLeft] = normalizedRadii;
  // CSS scales all corners together only when two radii overlap on an edge.
  // Thus a 24px island can retain its 17px lower corners and square top corners.
  const scale = Math.min(1,
    normalizedWidth / (topLeft + topRight),
    normalizedWidth / (bottomLeft + bottomRight),
    normalizedHeight / (topLeft + bottomLeft),
    normalizedHeight / (topRight + bottomRight));
  return {
    x: left, y: top, width: normalizedWidth, height: normalizedHeight,
    radii: normalizedRadii.map((radius) => radius * scale),
    opacity,
    backgroundBlurRadius: SOFT_GLASS_BLUR_RADIUS,
  };
}

module.exports = { normalizeAppearanceSurface };
