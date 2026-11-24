// The main window opens again where it was closed, with its size and whether it was maximized.

/** What to keep of a window: its size and place when not maximized, and whether it was. */
function windowState(win) {
  const { x, y, width, height } = win.getNormalBounds();
  return { x, y, width, height, maximized: win.isMaximized() };
}

/**
 * Where to open a window kept as `saved`, given the work areas of the screens, the primary first.
 * It lands whole on the screen it overlapped most, or on the primary when its screen is gone, and
 * never smaller than `min`. Null without a usable saved place: the default size is used.
 */
function placeWindow(saved, areas, min = { width: 0, height: 0 }) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || !areas.length) return null;
  const overlap = (area) => Math.max(0, Math.min(area.x + area.width, saved.x + saved.width) - Math.max(area.x, saved.x))
    * Math.max(0, Math.min(area.y + area.height, saved.y + saved.height) - Math.max(area.y, saved.y));
  const area = areas.reduce((best, candidate) => (overlap(candidate) > overlap(best) ? candidate : best), areas[0]);
  const width = Math.round(Math.min(Math.max(saved.width, min.width), area.width));
  const height = Math.round(Math.min(Math.max(saved.height, min.height), area.height));
  const x = Math.round(Math.min(Math.max(saved.x, area.x), area.x + area.width - width));
  const y = Math.round(Math.min(Math.max(saved.y, area.y), area.y + area.height - height));
  return { x, y, width, height };
}

module.exports = { windowState, placeWindow };
