import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { collapse, expandAll, initialExpanded, zoomGraph, zoomTree } from "#/views/zoom.ts";

const declaration = (path: string, label: string, status: GraphDeclaration["status"]): GraphDeclaration => ({
  id: path === "" ? `outside\0${label}` : `${path}\0${label}`,
  path,
  label,
  line: 1,
  endLine: 2,
  parts: [],
  status,
  tag: null,
  exported: true,
});

// A server whose billing changed, used by the portal, which also newly uses a package and no longer uses the server's old helper.
const all = [
  declaration("apps/server/src/domain/billing/checkout.ts", "checkout", "changed"),
  declaration("apps/server/src/domain/billing/refund.ts", "refund", "affected"),
  declaration("apps/server/src/domain/billing/refund.ts", "oldHelper", "removed"),
  declaration("apps/portal/src/pay.tsx", "Pay", "affected"),
  declaration("apps/portal/src/pay.tsx", "PayButton", "affected"),
  declaration("scripts/seed.ts", "seed", "affected"),
  declaration("", "stripe", "outside"),
];
const id = (label: string) => all.find((entry) => entry.label === label)?.id ?? label;
const data: ScannedGraph = {
  status: "scanned",
  declarations: Object.fromEntries(all.map((entry) => [entry.id, entry])),
  targets: {},
  problems: [],
  seeds: [id("checkout")],
  ripple: {
    edges: [
      { from: id("checkout"), to: id("refund") },
      { from: id("checkout"), to: id("Pay") },
      { from: id("refund"), to: id("PayButton") },
      { from: id("checkout"), to: id("seed") },
    ],
    affected: 4,
    shown: 4,
  },
  links: [
    { from: id("Pay"), to: id("stripe"), status: "added" },
    { from: id("Pay"), to: id("oldHelper"), status: "removed" },
  ],
  pointReach: {},
  packages: [
    { dir: "", name: "root" },
    { dir: "apps/server", name: "@acme/server" },
    { dir: "apps/portal", name: null },
  ],
};
const tree = zoomTree(data);
const edgesOf = (expanded: Set<string>) =>
  zoomGraph(data, tree, expanded, [])
    .edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kind} ${edge.count}`)
    .sort();

test("at first: a node per package, the files in none, and the packages and globals", () => {
  assert.deepEqual(tree.roots, ["package:apps/portal", "package:apps/server", "package:", "outside:"]);
  const graph = zoomGraph(data, tree, new Set(), []);
  assert.deepEqual(graph.groups, []);
  const server = graph.nodes.find((node) => node.id === "package:apps/server");
  assert.equal(server?.label, "@acme/server");
  assert.equal(server?.note, "2 changed · 1 affected · 2 files");
});

test("uses between packages are one edge per pair and kind, counted", () => {
  assert.deepEqual(edgesOf(new Set()), [
    "outside: -> package:apps/portal added 1",
    "package:apps/server -> package: changed 1",
    "package:apps/server -> package:apps/portal changed 2",
    "package:apps/server -> package:apps/portal removed 1",
  ]);
});

test("a package whose code is in one folder opens to that folder's contents", () => {
  const server = tree.units.get("package:apps/server");
  assert.deepEqual(server?.children, ["file:apps/server/src/domain/billing/checkout.ts", "file:apps/server/src/domain/billing/refund.ts"]);
  // The portal's code is all in src: opening it shows its file.
  assert.deepEqual(tree.units.get("package:apps/portal")?.children, ["file:apps/portal/src/pay.tsx"]);
});

test("opened, the edges go between the most opened ends", () => {
  const expanded = new Set(["package:apps/server", "file:apps/server/src/domain/billing/refund.ts"]);
  const graph = zoomGraph(data, tree, expanded, []);
  assert.deepEqual(
    graph.groups.map((group) => `${group.id} in ${group.parent ?? "-"}`),
    ["package:apps/server in -", "file:apps/server/src/domain/billing/refund.ts in package:apps/server"],
  );
  assert.deepEqual(edgesOf(expanded), [
    `${id("oldHelper")} -> package:apps/portal removed 1`,
    `${id("refund")} -> package:apps/portal affected 1`,
    `file:apps/server/src/domain/billing/checkout.ts -> ${id("refund")} changed 1`,
    "file:apps/server/src/domain/billing/checkout.ts -> package: changed 1",
    "file:apps/server/src/domain/billing/checkout.ts -> package:apps/portal changed 1",
    "outside: -> package:apps/portal added 1",
  ]);
});

test("a declaration links to its code", () => {
  const graph = zoomGraph(data, tree, expandAll(tree), [{ path: "apps/portal/src/pay.tsx", href: "#file-2" }]);
  assert.equal(graph.nodes.find((node) => node.id === id("PayButton"))?.href, "#file-2--PayButton");
  assert.equal(graph.nodes.find((node) => node.id === id("stripe"))?.kind, "external");
});

test("closing a unit closes what's open in it; a lone package opens by itself", () => {
  assert.deepEqual([...collapse(tree, expandAll(tree), "package:apps/server")].sort(), ["file:apps/portal/src/pay.tsx", "file:scripts/seed.ts", "outside:", "package:", "package:apps/portal"]);
  assert.deepEqual([...initialExpanded(tree)], []);
  const lone = zoomTree({ ...data, seeds: [id("checkout")], ripple: { edges: [{ from: id("checkout"), to: id("refund") }], affected: 1, shown: 1 }, links: [] });
  assert.deepEqual([...initialExpanded(lone)], ["package:apps/server"]);
});
