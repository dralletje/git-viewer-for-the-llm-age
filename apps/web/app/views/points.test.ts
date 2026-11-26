import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { capabilityTrees, pointTrees, type ReachNode } from "#/views/points.ts";

function declaration(id: string, status: GraphDeclaration["status"], tag: string | null = null): GraphDeclaration {
  return { id, path: status === "outside" ? "" : `src/${id}.ts`, label: id, line: 1, endLine: 2, parts: [], status, tag, exported: true };
}

function graph(declarations: Array<GraphDeclaration>, rest: Partial<ScannedGraph>): ScannedGraph {
  return {
    status: "scanned",
    declarations: Object.fromEntries(declarations.map((entry) => [entry.id, entry])),
    targets: {
      "point:Medplum": { key: "point:Medplum", label: "Medplum", kind: "point", about: "The patient record" },
      "point:Billing": { key: "point:Billing", label: "Billing", kind: "point", about: null },
      "capability:network": { key: "capability:network", label: "network", kind: "capability", about: null },
      "capability:database": { key: "capability:database", label: "database", kind: "capability", about: null },
    },
    problems: [],
    seeds: declarations.filter((entry) => entry.status === "changed" || entry.status === "added").map((entry) => entry.id),
    ripple: { edges: [], affected: 0, shown: 0 },
    links: [],
    pointReach: {},
    packages: [],
    ...rest,
  };
}

/** A tree as "id(use)" lines, indented two spaces a level. */
function lines(nodes: Array<ReachNode>, depth = 0): Array<string> {
  return nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.id}${node.use === null ? "" : `(${node.use})`}`, ...lines(node.children, depth + 1)]);
}

test("a point's tree runs from its package to the changed declarations, through what's in between", () => {
  const data = graph(
    [declaration("medplum", "outside", "point:Medplum"), declaration("client", "unchanged"), declaration("save", "changed"), declaration("page", "affected"), declaration("direct", "added")],
    {
      pointReach: {
        save: [{ target: "point:Medplum", next: "client", way: ["client", "medplum"] }],
        page: [{ target: "point:Medplum", next: "save", way: ["save", "client", "medplum"] }],
        direct: [{ target: "point:Medplum", next: null, way: ["medplum"] }],
      },
      links: [{ from: "direct", to: "medplum", status: "added" }],
    },
  );
  const { reached, notReached } = pointTrees(data);
  assert.deepEqual(
    notReached.map((target) => target.key),
    ["point:Billing"],
  );
  assert.equal(reached.length, 1);
  assert.equal(reached[0]?.changed, 2);
  assert.equal(reached[0]?.affected, 1);
  assert.deepEqual(lines(reached[0]?.roots ?? []), ["medplum", "  client", "    save", "      page", "  direct(added)"]);
});

test("a declaration that no longer uses a point shows, marked", () => {
  const data = graph([declaration("medplum", "outside", "point:Medplum"), declaration("old", "removed")], {
    links: [{ from: "old", to: "medplum", status: "removed" }],
  });
  assert.deepEqual(lines(pointTrees(data).reached[0]?.roots ?? []), ["medplum", "  old(removed)"]);
});

test("the point's own changed code is at the top of its tree", () => {
  const data = graph([declaration("db", "changed", "point:Billing")], { pointReach: { db: [{ target: "point:Billing", next: null, way: [] }] } });
  assert.deepEqual(lines(pointTrees(data).reached[0]?.roots ?? []), ["db"]);
});

test("a capability's tree: the package, what uses it, and what uses that in the ripple", () => {
  const data = graph([declaration("fetch", "outside", "capability:network"), declaration("load", "changed"), declaration("screen", "affected"), declaration("gone", "changed")], {
    links: [
      { from: "load", to: "fetch", status: "kept" },
      { from: "gone", to: "fetch", status: "removed" },
    ],
    ripple: { edges: [{ from: "load", to: "screen" }], affected: 1, shown: 1 },
  });
  const { reached, notReached } = capabilityTrees(data);
  assert.deepEqual(
    notReached.map((target) => target.key),
    ["capability:database"],
  );
  assert.deepEqual(lines(reached[0]?.roots ?? []), ["fetch", "  gone(removed)", "  load", "    screen"]);
});
