import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { flagsOf, packageOfOutside, structureChanged, structureGraph, structureSummary } from "#/views/structure.ts";

/** A declaration "<path>\0<label>" (a package: "outside\0<source>\0<name>", path ""). */
function declaration(id: string, status: GraphDeclaration["status"]): GraphDeclaration {
  const [path = "", label = ""] = id.split("\0");
  if (status === "outside") return { id, path: "", label: id.split("\0").slice(1).join(" "), line: 0, endLine: 0, parts: [], status, tag: null, exported: false };
  return { id, path, label, line: 1, endLine: 2, parts: [], status, tag: null, exported: true };
}

function graphWith(
  declarations: Record<string, GraphDeclaration["status"]>,
  links: ScannedGraph["links"],
  ripple: Array<{ from: string; to: string }> = [],
): ScannedGraph {
  return {
    status: "scanned",
    declarations: Object.fromEntries(Object.entries(declarations).map(([id, status]) => [id, declaration(id, status)])),
    targets: {},
    problems: [],
    seeds: Object.entries(declarations)
      .filter(([, status]) => status === "changed" || status === "added")
      .map(([id]) => id),
    ripple: { edges: ripple, affected: 0, shown: 0 },
    links,
    pointReach: {},
    packages: [
      { dir: "", name: "root" },
      { dir: "apps/web", name: "@x/web" },
      { dir: "packages/ui", name: "@x/ui" },
    ],
  };
}

const page = "apps/web/src/page.ts\0Page";
const other = "apps/web/src/other.ts\0Other";
const button = "packages/ui/src/button.ts\0Button";
const card = "packages/ui/src/card.ts\0Card";
const zod = "outside\0zod\0z";
const zodObject = "outside\0zod\0object";
const fetchGlobal = "outside\0global\0fetch";

test("a package's name from its outside id; a global has none", () => {
  assert.equal(packageOfOutside(zod), "zod");
  assert.equal(packageOfOutside("outside\0@medplum/core\0MedplumClient"), "@medplum/core");
  assert.equal(packageOfOutside(fetchGlobal), null);
  assert.equal(packageOfOutside(page), null);
});

test("a first use from one app into another is a new dependency", () => {
  const data = graphWith({ [page]: "changed", [button]: "unchanged" }, [{ from: page, to: button, status: "added" }]);
  assert.deepEqual(flagsOf(data, data.links[0]!), [{ kind: "new-dependency", from: "apps/web", to: "packages/ui" }]);
});

test("not a new dependency when the app already used the other (a kept use, or one the ripple follows)", () => {
  const kept = graphWith({ [page]: "changed", [other]: "changed", [button]: "unchanged", [card]: "changed" }, [
    { from: page, to: button, status: "added" },
    { from: other, to: card, status: "kept" },
  ]);
  assert.deepEqual(flagsOf(kept, kept.links[0]!), []);
  // The ripple: Card changed, Other (in apps/web) uses it and that use isn't new.
  const rippled = graphWith({ [page]: "changed", [other]: "affected", [button]: "unchanged", [card]: "changed" }, [{ from: page, to: button, status: "added" }], [{ from: card, to: other }]);
  assert.deepEqual(flagsOf(rippled, rippled.links[0]!), []);
  // ...but the ripple's edge for the added use itself doesn't count.
  const itself = graphWith({ [page]: "changed", [button]: "changed" }, [{ from: page, to: button, status: "added" }], [{ from: button, to: page }]);
  assert.deepEqual(flagsOf(itself, itself.links[0]!), [{ kind: "new-dependency", from: "apps/web", to: "packages/ui" }]);
});

test("a use within one app is no new dependency", () => {
  const data = graphWith({ [page]: "changed", [other]: "unchanged" }, [{ from: page, to: other, status: "added" }]);
  assert.deepEqual(flagsOf(data, data.links[0]!), []);
});

test("a package the app didn't use before is flagged, by package, not by name", () => {
  const first = graphWith({ [page]: "changed", [zod]: "outside" }, [{ from: page, to: zod, status: "added" }]);
  assert.deepEqual(flagsOf(first, first.links[0]!), [{ kind: "new-package", package: "zod", app: "apps/web" }]);
  // Other already used zod (another name from it), in the same app.
  const known = graphWith({ [page]: "changed", [other]: "changed", [zod]: "outside", [zodObject]: "outside" }, [
    { from: page, to: zod, status: "added" },
    { from: other, to: zodObject, status: "kept" },
  ]);
  assert.deepEqual(flagsOf(known, known.links[0]!), []);
  // A use from another app doesn't count for this one.
  const elsewhere = graphWith({ [page]: "changed", [button]: "changed", [zod]: "outside" }, [
    { from: page, to: zod, status: "added" },
    { from: button, to: zod, status: "kept" },
  ]);
  assert.deepEqual(flagsOf(elsewhere, elsewhere.links[0]!), [{ kind: "new-package", package: "zod", app: "apps/web" }]);
  // A global isn't a package.
  const global = graphWith({ [page]: "changed", [fetchGlobal]: "outside" }, [{ from: page, to: fetchGlobal, status: "added" }]);
  assert.deepEqual(flagsOf(global, global.links[0]!), []);
});

test("a removed use whose target nothing uses now is flagged; one still used, or removed itself, is said so", () => {
  const unused = graphWith({ [page]: "changed", [button]: "unchanged" }, [{ from: page, to: button, status: "removed" }]);
  assert.deepEqual(flagsOf(unused, unused.links[0]!), [{ kind: "now-unused" }]);
  const stillUsed = graphWith({ [page]: "changed", [other]: "changed", [button]: "unchanged" }, [
    { from: page, to: button, status: "removed" },
    { from: other, to: button, status: "added" },
  ]);
  assert.deepEqual(flagsOf(stillUsed, stillUsed.links[0]!), []);
  const rippled = graphWith({ [page]: "changed", [other]: "affected", [button]: "changed" }, [{ from: page, to: button, status: "removed" }], [{ from: button, to: other }]);
  assert.deepEqual(flagsOf(rippled, rippled.links[0]!), []);
  const gone = graphWith({ [page]: "changed", [button]: "removed" }, [{ from: page, to: button, status: "removed" }]);
  assert.deepEqual(flagsOf(gone, gone.links[0]!), [{ kind: "removed-with-it" }]);
  const packageGone = graphWith({ [page]: "changed", [zod]: "outside" }, [{ from: page, to: zod, status: "removed" }]);
  assert.deepEqual(flagsOf(packageGone, packageGone.links[0]!), [{ kind: "now-unused" }]);
});

test("the summary: per user file, new uses first, kept ones only when asked, and added or removed declarations", () => {
  const added = "apps/web/src/new.ts\0fresh";
  const data = graphWith({ [page]: "changed", [other]: "changed", [button]: "unchanged", [zod]: "outside", [added]: "added" }, [
    { from: page, to: zod, status: "removed" },
    { from: page, to: button, status: "added" },
    { from: page, to: other, status: "kept" },
  ]);
  const summary = structureSummary(data, { kept: false });
  assert.deepEqual(
    summary.map((file) => ({ path: file.path, app: file.app, uses: file.uses.map((use) => `${use.status} ${use.used}`), added: file.added })),
    [
      { path: "apps/web/src/new.ts", app: "apps/web", uses: [], added: [added] },
      { path: "apps/web/src/page.ts", app: "apps/web", uses: [`added ${button}`, `removed ${zod}`], added: [] },
    ],
  );
  const withKept = structureSummary(data, { kept: true }).find((file) => file.path === "apps/web/src/page.ts");
  assert.deepEqual(
    withKept?.uses.map((use) => use.status),
    ["added", "removed", "kept"],
  );
});

test("the drawing: only the changed uses' ends and added declarations, arrows from used to user, in app and file boxes", () => {
  const added = "apps/web/src/new.ts\0fresh";
  const bystander = "apps/web/src/far.ts\0far";
  const data = graphWith({ [page]: "changed", [button]: "unchanged", [added]: "added", [bystander]: "affected" }, [{ from: page, to: button, status: "added" }], [{ from: button, to: bystander }]);
  const graph = structureGraph(data, [], { kept: false });
  assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set([page, button, added]));
  assert.deepEqual(
    graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, wide: edge.wide })),
    [{ from: button, to: page, kind: "added", wide: true }],
  );
  assert.deepEqual(new Set(graph.groups.map((group) => `${group.id} in ${group.parent ?? "-"}`)), new Set([
    "package:apps/web in -",
    "package:packages/ui in -",
    "group:apps/web/src/page.ts in package:apps/web",
    "group:apps/web/src/new.ts in package:apps/web",
    "group:packages/ui/src/button.ts in package:packages/ui",
  ]));
});

test("the structure didn't change: only kept uses, no declaration added or removed", () => {
  const data = graphWith({ [page]: "changed", [other]: "changed" }, [{ from: page, to: other, status: "kept" }]);
  assert.equal(structureChanged(data), false);
  assert.equal(structureChanged(graphWith({ [page]: "added" }, [])), true);
});
