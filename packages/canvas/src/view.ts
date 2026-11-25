/**
 * Where the content is in the viewport: moved by `x`, `y` (pixels of the
 * viewport), then scaled by `scale` from its top left. A point of the
 * content at (cx, cy) shows at (x + cx * scale, y + cy * scale).
 */
export type View = { x: number; y: number; scale: number };

export type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Limits = { minScale: number; maxScale: number };

export function clampScale(scale: number, limits: Limits): number {
  return Math.min(limits.maxScale, Math.max(limits.minScale, scale));
}

/**
 * The view scaled by `factor` around a point of the viewport (the pointer,
 * the middle of a pinch): what's under that point stays under it.
 */
export function zoomAt(view: View, point: { x: number; y: number }, factor: number, limits: Limits): View {
  const scale = clampScale(view.scale * factor, limits);
  const applied = scale / view.scale;
  return { x: point.x - (point.x - view.x) * applied, y: point.y - (point.y - view.y) * applied, scale };
}

/**
 * The whole content in the viewport, centered, with `padding` around it:
 * as large as fits, but not past `limits` (a small graph isn't blown up
 * past `maxScale`).
 */
export function fitView(content: Size, viewport: Size, padding: number, limits: Limits): View {
  const room = { width: Math.max(1, viewport.width - padding * 2), height: Math.max(1, viewport.height - padding * 2) };
  const scale = clampScale(Math.min(room.width / Math.max(1, content.width), room.height / Math.max(1, content.height)), limits);
  return { x: (viewport.width - content.width * scale) / 2, y: (viewport.height - content.height * scale) / 2, scale };
}

/**
 * The view moved as little as it takes to show `rect` (in the content's
 * own coordinates) with `margin` around it; centered on it when it doesn't
 * fit. The same view when it's already in sight.
 */
export function viewShowing(view: View, rect: Rect, viewport: Size, margin: number): View {
  const left = view.x + rect.x * view.scale;
  const top = view.y + rect.y * view.scale;
  const width = rect.width * view.scale;
  const height = rect.height * view.scale;
  const along = (start: number, length: number, room: number): number => {
    if (length + margin * 2 > room) return room / 2 - (start + length / 2);
    if (start < margin) return margin - start;
    if (start + length > room - margin) return room - margin - (start + length);
    return 0;
  };
  return { x: view.x + along(left, width, viewport.width), y: view.y + along(top, height, viewport.height), scale: view.scale };
}
