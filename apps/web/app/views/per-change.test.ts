import { test } from "node:test";
import assert from "node:assert/strict";
import { rippleWithoutFileBoxes, type ScannedGraph } from "#/graphs.ts";
import { changeData, perChange } from "#/views/per-change.ts";

type Status = ScannedGraph["declarations"][string]["status"];

/** Graph data from "path#name" declarations with their statuses, and ripple edges as "used>user". */
function graphOf(declared: Record<string, Status>, edges: Array<string>, extra: Partial<ScannedGraph> = {}): ScannedGraph {
  const declarations: ScannedGraph["declarations"] = {};
  for (const [id, status] of Object.entries(declared)) {
    const [path = "", label = ""] = id.split("#");
    declarations[id] = { id, path, label, line: 1, endLine: 2, parts: [], status, tag: null, exported: false };
  }
  return {
    status: "scanned",
    declarations,
    targets: {},
    problems: [],
    seeds: Object.keys(declarations).filter((id) => ["changed", "added", "affected"].includes(declarations[id]?.status ?? "")),
    ripple: {
      edges: edges.map((edge) => {
        const [from = "", to = ""] = edge.split(">");
        return { from, to };
      }),
      affected: 0,
      shown: 0,
    },
    links: [],
    pointReach: {},
    packages: [
      { dir: "", name: null },
      { dir: "apps/web", name: "web" },
      { dir: "packages/ui", name: "ui" },
    ],
    ...extra,
  };
}

test("each change reaches what uses it, and what uses those, nearest first", () => {
  const data = graphOf(
    { "packages/ui/a.ts#a": "changed", "apps/web/b.ts#b": "affected", "apps/web/c.ts#c": "affected", "apps/web/d.ts#d": "added", "apps/web/c.ts#e": "affected" },
    ["packages/ui/a.ts#a>apps/web/b.ts#b", "apps/web/b.ts#b>apps/web/c.ts#c", "apps/web/d.ts#d>apps/web/c.ts#e"],
  );
  const { changes, total, topFor80 } = perChange(data);
  assert.deepEqual(
    changes.map((change) => [change.id, change.reached]),
    [
      ["packages/ui/a.ts#a", ["apps/web/b.ts#b", "apps/web/c.ts#c"]],
      ["apps/web/d.ts#d", ["apps/web/c.ts#e"]],
    ],
  );
  const [first] = changes;
  assert.deepEqual(first?.files, ["apps/web/b.ts", "apps/web/c.ts"]);
  assert.deepEqual(first?.packages, ["apps/web"]);
  assert.equal(first?.edges.length, 2);
  assert.equal(total, 3);
  // a reaches 2 of 3: under 80%, so d is needed too.
  assert.equal(topFor80, 2);
});

test("a seed that's affected within its file is part of the change that reaches it, no card of its own", () => {
  const data = graphOf({ "x.ts#changedOne": "changed", "x.ts#sameCode": "affected", "y.ts#user": "affected" }, ["x.ts#changedOne>x.ts#sameCode", "x.ts#sameCode>y.ts#user"]);
  const { changes } = perChange(data);
  assert.deepEqual(
    changes.map((change) => change.id),
    ["x.ts#changedOne"],
  );
  assert.deepEqual(changes[0]?.reached, ["x.ts#sameCode", "y.ts#user"]);
});

test("an affected seed no change reaches stands for itself, rather than going missing", () => {
  const data = graphOf({ "x.ts#orphan": "affected", "y.ts#user": "affected" }, ["x.ts#orphan>y.ts#user"]);
  assert.deepEqual(
    perChange(data).changes.map((change) => [change.id, change.status]),
    [["x.ts#orphan", "affected"]],
  );
});

test("overlap: what two changes both reach is counted for each, and not as unique", () => {
  const data = graphOf({ "a.ts#a": "changed", "b.ts#b": "changed", "c.ts#shared": "affected", "d.ts#mine": "affected" }, ["a.ts#a>c.ts#shared", "b.ts#b>c.ts#shared", "a.ts#a>d.ts#mine"]);
  const { changes, reachedBy, total } = perChange(data);
  assert.equal(reachedBy.get("c.ts#shared"), 2);
  assert.equal(reachedBy.get("d.ts#mine"), 1);
  assert.equal(total, 2);
  assert.deepEqual(
    changes.map((change) => [change.id, change.reached.length, change.unique]),
    [
      ["a.ts#a", 2, 1],
      ["b.ts#b", 1, 0],
    ],
  );
});

test("a removed declaration is a change, with the uses it took away", () => {
  const data = graphOf({ "a.ts#gone": "removed", "b.ts#caller": "changed" }, [], {
    links: [
      { from: "b.ts#caller", to: "a.ts#gone", status: "removed" },
      { from: "b.ts#caller", to: "b.ts#other", status: "kept" },
    ],
  });
  const gone = perChange(data).changes.find((change) => change.id === "a.ts#gone");
  assert.equal(gone?.status, "removed");
  assert.deepEqual(gone?.reached, []);
  assert.deepEqual(gone?.links, [{ from: "b.ts#caller", to: "a.ts#gone", status: "removed" }]);
});

test("the points a change gets to: its own, and those of what it reaches", () => {
  const data = graphOf({ "a.ts#a": "changed", "b.ts#b": "affected" }, ["a.ts#a>b.ts#b"], {
    pointReach: { "b.ts#b": [{ target: "point:Medplum", next: null, way: [] }] },
  });
  assert.deepEqual(perChange(data).changes[0]?.points, ["point:Medplum"]);
});

test("a change's own data draws only it and what it reaches", () => {
  const data = graphOf({ "a.ts#a": "changed", "b.ts#b": "affected", "c.ts#c": "changed", "d.ts#d": "affected" }, ["a.ts#a>b.ts#b", "c.ts#c>d.ts#d"]);
  const [first] = perChange(data).changes;
  assert.ok(first !== undefined);
  const graph = rippleWithoutFileBoxes(changeData(data, first), []);
  assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set([first.id, ...first.reached]));
  assert.equal(graph.edges.length, 1);
});
