import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";
import { areaOf, changeMatrix, lengthenAlike, reachedFrom, shadeOf } from "#/views/matrix.ts";

/** A declaration "<path>#<label>" with this status. */
function declaration(id: string, status: GraphDeclaration["status"]): GraphDeclaration {
  const [path = "", label = id] = id.split("#");
  return { id, path, label, line: 1, endLine: 2, parts: [], status, tag: null, exported: true };
}

/** Two packages: a server and a portal that uses its code, a script outside both, and the Medplum point. */
function graph(): ScannedGraph {
  const all = [
    declaration("apps/server/src/db.ts#query", "changed"),
    declaration("apps/server/src/db.ts#helper", "affected"),
    declaration("apps/server/src/api/users.ts#getUser", "affected"),
    declaration("apps/server/src/api/users.ts#listUsers", "affected"),
    declaration("apps/portal/src/page.tsx#Page", "affected"),
    declaration("scripts/seed.ts#seed", "affected"),
    declaration("apps/portal/src/new.ts#fresh", "added"),
    declaration("apps/portal/src/page.tsx#Footer", "affected"),
    declaration("apps/server/src/old.ts#gone", "removed"),
    { ...declaration("@medplum/core", "outside"), path: "" },
  ];
  return {
    status: "scanned",
    declarations: Object.fromEntries(all.map((one) => [one.id, one])),
    targets: { medplum: { key: "medplum", label: "Medplum", kind: "point", about: "The patient record" } },
    problems: [],
    // The helper is a seed too (affected within its file), but not a row.
    seeds: ["apps/server/src/db.ts#query", "apps/server/src/db.ts#helper", "apps/portal/src/new.ts#fresh", "apps/server/src/old.ts#gone"],
    ripple: {
      edges: [
        { from: "@medplum/core", to: "apps/server/src/db.ts#query" },
        { from: "apps/server/src/db.ts#query", to: "apps/server/src/db.ts#helper" },
        { from: "apps/server/src/db.ts#query", to: "apps/server/src/api/users.ts#getUser" },
        { from: "apps/server/src/api/users.ts#getUser", to: "apps/server/src/api/users.ts#listUsers" },
        { from: "apps/server/src/api/users.ts#getUser", to: "apps/portal/src/page.tsx#Page" },
        // A loop back: reached once.
        { from: "apps/portal/src/page.tsx#Page", to: "apps/server/src/api/users.ts#getUser" },
        { from: "apps/server/src/db.ts#helper", to: "scripts/seed.ts#seed" },
        { from: "apps/portal/src/new.ts#fresh", to: "apps/portal/src/page.tsx#Footer" },
      ],
      affected: 7,
      shown: 7,
    },
    links: [],
    pointReach: {
      "apps/server/src/db.ts#query": [{ target: "medplum", next: null, way: [] }],
      "apps/server/src/api/users.ts#getUser": [{ target: "medplum", next: "apps/server/src/db.ts#query", way: ["apps/server/src/db.ts#query"] }],
    },
    packages: [
      { dir: "", name: "root" },
      { dir: "apps/server", name: "@acme/server" },
      { dir: "apps/portal", name: null },
    ],
  };
}

test("reach follows the ripple from what's used to what uses it, nearest first, each once", () => {
  const edges = graph().ripple.edges;
  assert.deepEqual(reachedFrom(edges, "apps/server/src/db.ts#query"), [
    "apps/server/src/db.ts#helper",
    "apps/server/src/api/users.ts#getUser",
    "scripts/seed.ts#seed",
    "apps/server/src/api/users.ts#listUsers",
    "apps/portal/src/page.tsx#Page",
  ]);
  assert.deepEqual(reachedFrom(edges, "apps/server/src/old.ts#gone"), []);
});

test("a file's area: its nearest package, its folder, or itself", () => {
  const packages = graph().packages;
  assert.deepEqual(areaOf("apps/server/src/db.ts", "package", packages), { key: "apps/server", label: "@acme/server", title: "apps/server · @acme/server" });
  assert.deepEqual(areaOf("apps/portal/src/page.tsx", "package", packages), { key: "apps/portal", label: "apps/portal", title: "apps/portal" });
  assert.equal(areaOf("scripts/seed.ts", "package", packages).key, "");
  assert.deepEqual(areaOf("apps/server/src/api/users.ts", "folder", packages), { key: "apps/server/src/api", label: "src/api", title: "apps/server/src/api" });
  assert.deepEqual(areaOf("apps/server/src/api/users.ts", "file", packages), { key: "apps/server/src/api/users.ts", label: "users.ts", title: "apps/server/src/api/users.ts" });
});

/** A matrix as plain data: each row's label and its cells' counts. */
function counts(granularity: "package" | "folder" | "file") {
  const matrix = changeMatrix(graph(), granularity);
  return {
    columns: matrix.columns.map((column) => `${column.key}=${column.total}`),
    points: matrix.points.map((column) => `${column.label}=${column.total}`),
    rows: matrix.rows.map((row) => `${row.declaration.label} ${row.total}: ${[...matrix.columns, ...matrix.points].map((column) => row.cells.get(column.key)?.length ?? 0).join(" ")}`),
    total: matrix.total,
    max: matrix.max,
  };
}

test("by package: a row per changed, added or removed declaration, sorted by how much it reaches", () => {
  assert.deepEqual(counts("package"), {
    columns: ["apps/server=3", "apps/portal=2", "=1"],
    points: ["Medplum=2"],
    rows: ["query 5: 3 1 1 2", "fresh 1: 0 1 0 0", "gone 0: 0 0 0 0"],
    total: 6,
    max: 3,
  });
});

test("by folder and by file, the same declarations split finer", () => {
  assert.deepEqual(counts("folder").columns, ["apps/portal/src=2", "apps/server/src/api=2","apps/server/src=1", "scripts=1"]);
  assert.deepEqual(counts("file").columns, ["apps/portal/src/page.tsx=2", "apps/server/src/api/users.ts=2", "apps/server/src/db.ts=1", "scripts/seed.ts=1"]);
});

test("a point's cell lists the row's declaration and what it reaches that reach the point", () => {
  const matrix = changeMatrix(graph(), "package");
  const query = matrix.rows[0];
  assert.deepEqual(
    query?.cells.get("point:medplum")?.map((one) => one.label),
    ["query", "getUser"],
  );
});

test("headers that read the same take more of their path until they don't", () => {
  const columns = [
    { key: "apps/portal/src/pages/dashboard", label: "pages/dashboard" },
    { key: "apps/clinic/src/pages/dashboard", label: "pages/dashboard" },
    { key: "apps/clinic/src/pages/tasks", label: "pages/tasks" },
    { key: "apps/a/index.ts", label: "index.ts" },
    { key: "apps/b/index.ts", label: "index.ts" },
  ];
  lengthenAlike(columns);
  assert.deepEqual(
    columns.map((column) => column.label),
    ["portal/src/pages/dashboard", "clinic/src/pages/dashboard", "pages/tasks", "a/index.ts", "b/index.ts"],
  );
});

test("shades: empty is 0, the largest cell 5, small counts still show", () => {
  assert.equal(shadeOf(0, 10), 0);
  assert.equal(shadeOf(1, 1), 3);
  assert.equal(shadeOf(1, 100), 1);
  assert.equal(shadeOf(100, 100), 5);
  assert.ok(shadeOf(10, 100) > shadeOf(2, 100));
});
