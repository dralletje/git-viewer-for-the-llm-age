import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScannedGraph } from "#/graphs.ts";
import { anglesOnRing, circularMean, distancesFrom, pathsThrough, ringsLayout, shortLabel } from "#/views/rings.ts";

test("a declaration's ring is its shortest way from a change", () => {
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "a", to: "c" },
    { from: "c", to: "d" },
    { from: "x", to: "y" },
  ];
  const distance = distancesFrom(["a"], edges);
  assert.deepEqual(Object.fromEntries(distance), { a: 0, b: 1, c: 1, d: 2 });
});

test("several changes: each counts from the nearest", () => {
  const distance = distancesFrom(["a", "z"], [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "z", to: "c" },
  ]);
  assert.equal(distance.get("c"), 1);
  assert.equal(distance.get("z"), 0);
});

test("a use between changes doesn't move one off the middle", () => {
  const distance = distancesFrom(["a", "b"], [{ from: "a", to: "b" }]);
  assert.equal(distance.get("b"), 0);
});

test("pointing at a declaration lights its ways in and out, not across a ring", () => {
  const edges = [
    { from: "a", to: "b" }, // 0
    { from: "b", to: "d" }, // 1
    { from: "a", to: "c" }, // 2
    { from: "c", to: "b" }, // 3: within ring 1
    { from: "d", to: "e" }, // 4
    { from: "c", to: "f" }, // 5
  ];
  const ring = distancesFrom(["a"], edges);
  const lit = pathsThrough("d", edges, ring);
  assert.deepEqual([...lit.edges].sort(), [0, 1, 4]);
  assert.deepEqual([...lit.nodes].sort(), ["a", "b", "d", "e"]);
});

function graph(declarations: Array<{ id: string; path: string; status?: "changed" | "affected" }>, seeds: Array<string>, edges: Array<{ from: string; to: string }>, packages: Array<string> = []): ScannedGraph {
  return {
    status: "scanned",
    declarations: Object.fromEntries(
      declarations.map((entry) => [entry.id, { id: entry.id, path: entry.path, label: entry.id, line: 1, endLine: 2, parts: [], status: entry.status ?? "affected", tag: null, exported: false }]),
    ),
    targets: { "point:Medplum": { key: "point:Medplum", label: "Medplum", kind: "point", about: null } },
    problems: [],
    seeds,
    ripple: { edges, affected: declarations.length - seeds.length, shown: declarations.length - seeds.length },
    links: [],
    pointReach: { b: [{ target: "point:Medplum", next: null, way: [] }] },
    packages: packages.map((dir) => ({ dir, name: null })),
  };
}

test("one change in the middle, its users on ring 1, theirs on ring 2", () => {
  const layout = ringsLayout(
    graph(
      [
        { id: "a", path: "src/a.ts", status: "changed" },
        { id: "b", path: "src/b.ts" },
        { id: "c", path: "src/c.ts" },
        { id: "d", path: "src/d.ts" },
      ],
      ["a"],
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
      ],
    ),
  );
  assert.deepEqual(
    layout.rings.map((ring) => [ring.ring, ring.count]),
    [
      [0, 1],
      [1, 2],
      [2, 1],
    ],
  );
  const a = layout.nodes.find((node) => node.id === "a");
  assert.equal(a?.radius, 0);
  assert.deepEqual(layout.nodes.find((node) => node.id === "b")?.points, ["Medplum"]);
  assert.equal(layout.edges.length, 3);
  // Each ring starts past the longest pill of the one inside.
  const [, first, second] = layout.rings;
  const longestFirst = Math.max(...layout.nodes.filter((node) => node.ring === 1).map((node) => node.length));
  assert.ok((second?.radius ?? 0) >= (first?.radius ?? 0) + longestFirst);
});

test("a crowded ring is wide enough for its pills side by side, a file's declarations together", () => {
  const users = Array.from({ length: 120 }, (_, index) => ({ id: `u${index}`, path: `pkg${index % 3}/src/f${index % 7}.ts` }));
  const layout = ringsLayout(
    graph(
      [{ id: "a", path: "pkg0/src/a.ts", status: "changed" }, ...users],
      ["a"],
      users.map((user) => ({ from: "a", to: user.id })),
      ["pkg0", "pkg1", "pkg2"],
    ),
  );
  const ring = layout.nodes.filter((node) => node.ring === 1).sort((a, b) => a.angle - b.angle);
  for (let index = 1; index < ring.length; index++) {
    const gap = ((ring[index]?.angle ?? 0) - (ring[index - 1]?.angle ?? 0)) * (ring[index]?.radius ?? 0);
    assert.ok(gap >= 18.9, `pills ${index - 1} and ${index} are ${gap}px apart`);
  }
  // Going round, each file comes up once.
  const files = ring.map((node) => node.path).filter((path, index, all) => path !== all[index - 1]);
  assert.equal(files.length, new Set(files).size);
});

test("a ring with room puts each declaration near what it uses, a pill apart, clear of the ring's name", () => {
  const radius = 600;
  const angles = anglesOnRing([1, 1, 1, 3], [0, 1, 2, 4], radius, 6);
  // Around their wish, in order, at least a pill apart (19px along the ring).
  assert.ok(Math.abs((angles[1] ?? 0) - 1) < 0.1);
  assert.ok(((angles[1] ?? 0) - (angles[0] ?? 0)) * radius >= 18.9);
  assert.ok(Math.abs((angles[3] ?? 0) - 3) < 0.2);
  // Wished for at the top, where the name is: moved off it.
  const top = anglesOnRing([0, 0.01], [0, 1], radius, 6);
  assert.ok((top[0] ?? 0) * radius >= 3 * 19 - 0.01);
});

test("a full ring, or the middle, goes round evenly", () => {
  const middle = anglesOnRing([null, null, null], [0, 1, 2], 100, 4);
  assert.ok(Math.abs((middle[1] ?? 0) - (middle[0] ?? 0) - ((middle[2] ?? 0) - (middle[1] ?? 0))) < 1e-9);
  const slots = Array.from({ length: 30 }, (_, index) => index);
  const full = anglesOnRing(slots.map(() => 1), slots, (34 * 19) / (2 * Math.PI), 4);
  assert.ok((full.at(-1) ?? 0) - (full[0] ?? 0) > 4);
});

test("long labels lose their start", () => {
  assert.equal(shortLabel("short"), "short");
  const long = shortLabel("a".repeat(10) + "b".repeat(40));
  assert.equal(long.length, 32);
  assert.ok(long.startsWith("…b"));
});

test("the mean of angles goes round", () => {
  const mean = circularMean([(350 / 180) * Math.PI, (10 / 180) * Math.PI]);
  assert.ok(mean < 0.001 || mean > 2 * Math.PI - 0.001);
});
