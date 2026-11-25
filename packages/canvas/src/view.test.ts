import { test } from "node:test";
import assert from "node:assert/strict";
import { fitView, viewShowing, zoomAt } from "#/view.ts";

const limits = { minScale: 0.1, maxScale: 4 };

test("zooming keeps the point under the pointer where it is", () => {
  const view = { x: 40, y: -20, scale: 1 };
  const pointer = { x: 300, y: 200 };
  const under = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };
  const zoomed = zoomAt(view, pointer, 2, limits);
  assert.equal(zoomed.scale, 2);
  assert.deepEqual({ x: zoomed.x + under.x * zoomed.scale, y: zoomed.y + under.y * zoomed.scale }, pointer);
});

test("zooming stops at the limits, and still keeps the point in place", () => {
  const zoomed = zoomAt({ x: 0, y: 0, scale: 3 }, { x: 100, y: 100 }, 10, limits);
  assert.equal(zoomed.scale, 4);
  assert.deepEqual({ x: zoomed.x, y: zoomed.y }, { x: 100 - 100 * (4 / 3), y: 100 - 100 * (4 / 3) });
});

test("fitting centers the content, as large as fits, not past the largest scale", () => {
  assert.deepEqual(fitView({ width: 2000, height: 500 }, { width: 1000, height: 500 }, 0, limits), { x: 0, y: 125, scale: 0.5 });
  // A small graph stays at its largest scale, centered.
  assert.deepEqual(fitView({ width: 100, height: 50 }, { width: 1000, height: 500 }, 0, { minScale: 0.1, maxScale: 1 }), { x: 450, y: 225, scale: 1 });
});

test("showing a rect moves as little as it takes, and not at all when it's in sight", () => {
  const view = { x: 0, y: 0, scale: 1 };
  const viewport = { width: 500, height: 300 };
  assert.deepEqual(viewShowing(view, { x: 100, y: 100, width: 50, height: 20 }, viewport, 10), view);
  // Off to the right: moved left until its right edge is `margin` inside.
  assert.deepEqual(viewShowing(view, { x: 600, y: 100, width: 50, height: 20 }, viewport, 10), { x: -160, y: 0, scale: 1 });
  // Above, at half the scale.
  assert.deepEqual(viewShowing({ x: 0, y: 0, scale: 0.5 }, { x: 100, y: -100, width: 20, height: 20 }, viewport, 10), { x: 0, y: 60, scale: 0.5 });
});
