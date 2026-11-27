import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { heatTree, indexTree, layoutTreemap, rippleDistances, squarify, type Rect } from "#/views/heatmap.ts";

function declaration(id: string, path: string, status: GraphDeclaration["status"], line: number, endLine: number): GraphDeclaration {
  return { id, path, label: id, line, endLine, parts: [], status, tag: null, exported: false };
}

function graph(declarations: Array<GraphDeclaration>, extra: Partial<ScannedGraph> = {}): ScannedGraph {
  return {
    status: "scanned",
    declarations: Object.fromEntries(declarations.map((entry) => [entry.id, entry])),
    targets: {},
    problems: [],
    seeds: [],
    ripple: { edges: [], affected: 0, shown: 0 },
    links: [],
    pointReach: {},
    packages: [],
    ...extra,
  };
}

const area = (rect: Rect) => rect.width * rect.height;

test("squarify: every rectangle's area is its share, and together they fill the space", () => {
  const values = [6, 6, 4, 3, 2, 2, 1];
  const space = { x: 0, y: 0, width: 600, height: 400 };
  const rects = squarify(values, space);
  const sum = values.reduce((a, b) => a + b, 0);
  rects.forEach((rect, index) => {
    assert.ok(Math.abs(area(rect) - ((values[index] ?? 0) / sum) * 600 * 400) < 1e-6, `rect ${index}`);
    assert.ok(rect.x >= -1e-9 && rect.y >= -1e-9 && rect.x + rect.width <= 600 + 1e-9 && rect.y + rect.height <= 400 + 1e-9, `rect ${index} inside`);
  });
  // No two overlap.
  for (let a = 0; a < rects.length; a++) {
    for (let b = a + 1; b < rects.length; b++) {
      const one = rects[a] as Rect;
      const two = rects[b] as Rect;
      const overlapX = Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
      const overlapY = Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
      assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${a} and ${b} overlap`);
    }
  }
});

test("squarify: the paper's example keeps every rectangle within a 3:1 aspect ratio", () => {
  const rects = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, width: 6, height: 4 });
  for (const rect of rects) assert.ok(Math.max(rect.width / rect.height, rect.height / rect.width) <= 3, JSON.stringify(rect));
});

test("squarify: results come back in the order of the values, not by size", () => {
  const rects = squarify([1, 9], { x: 0, y: 0, width: 10, height: 10 });
  assert.ok(area(rects[1] as Rect) > area(rects[0] as Rect));
});

test("squarify: zero values and an empty space give empty rectangles", () => {
  assert.deepEqual(
    squarify([0, 5], { x: 0, y: 0, width: 10, height: 10 }).map(area),
    [0, 100],
  );
  assert.deepEqual(squarify([1, 2], { x: 0, y: 0, width: 0, height: 10 }).map(area), [0, 0]);
});

test("rippleDistances: a change is 0, each use along the ripple one more, the nearest way counts", () => {
  const data = graph(
    [
      declaration("a", "src/a.ts", "changed", 1, 5),
      declaration("b", "src/b.ts", "affected", 1, 5),
      declaration("c", "src/c.ts", "affected", 1, 5),
      declaration("d", "src/d.ts", "unchanged", 1, 5),
    ],
    {
      seeds: ["a"],
      ripple: {
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "a", to: "c" },
        ],
        affected: 2,
        shown: 2,
      },
    },
  );
  const distances = rippleDistances(data);
  assert.equal(distances.get("a"), 0);
  assert.equal(distances.get("b"), 1);
  assert.equal(distances.get("c"), 1);
  assert.equal(distances.has("d"), false);
});

test("heatTree: package → folder → file → declaration, sized by lines, a lone folder chain as one box", () => {
  const data = graph(
    [
      declaration("one", "apps/web/src/domain/billing/a.ts", "changed", 1, 10),
      declaration("two", "apps/web/src/domain/billing/a.ts", "affected", 12, 31),
      declaration("three", "apps/web/src/other.ts", "unchanged", 1, 1),
      declaration("lodash", "", "outside", 0, 0),
      declaration("loose", "scripts/run.ts", "added", 1, 4),
    ],
    { seeds: ["one"], ripple: { edges: [{ from: "one", to: "two" }], affected: 1, shown: 1 }, packages: [{ dir: "apps/web", name: "@room/web" }, { dir: "", name: "root" }] },
  );
  const root = heatTree(data);
  assert.equal(root.size, 10 + 20 + 1 + 4);
  const labels = root.children.map((child) => child.label).sort();
  assert.deepEqual(labels, ["(repository root)", "@room/web"]);
  const web = root.children.find((child) => child.label === "@room/web");
  assert.ok(web !== undefined);
  assert.deepEqual(web.counts, { changed: 1, added: 0, removed: 0, affected: 1, unchanged: 1 });
  assert.equal(web.distance, 0);
  const src = web.children[0];
  assert.equal(src?.label, "src");
  // src holds a file of its own, so it stays; domain/billing has only one folder in it: one box.
  const billing = src?.children.find((child) => child.kind === "folder");
  assert.equal(billing?.label, "domain/billing");
  assert.equal(billing?.children[0]?.label, "a.ts");
  assert.equal(billing?.children[0]?.children[1]?.distance, 1);
  const { parentOf } = indexTree(root);
  assert.equal(parentOf.get("one"), "file:apps/web/src/domain/billing/a.ts");
});

test("layoutTreemap: boxes come before what's in them, and each declaration is inside its file", () => {
  const data = graph(
    [declaration("one", "a/x.ts", "changed", 1, 30), declaration("two", "a/x.ts", "affected", 31, 60), declaration("three", "b/y.ts", "affected", 1, 60)],
    { packages: [] },
  );
  const placed = layoutTreemap(heatTree(data), { x: 0, y: 0, width: 800, height: 400 });
  const position = new Map(placed.map((entry, index) => [entry.node.id, index]));
  const file = placed.find((entry) => entry.node.id === "file:a/x.ts");
  const one = placed.find((entry) => entry.node.id === "one");
  assert.ok(file !== undefined && one !== undefined);
  assert.ok((position.get(file.node.id) ?? 0) < (position.get("one") ?? 0));
  assert.ok(one.x >= file.x && one.y >= file.y && one.x + one.width <= file.x + file.width + 1e-6 && one.y + one.height <= file.y + file.height + 1e-6);
  assert.equal(file.header, true);
});
