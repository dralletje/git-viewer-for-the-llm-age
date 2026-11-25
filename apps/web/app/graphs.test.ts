import { test } from "node:test";
import assert from "node:assert/strict";
import { rippleInFolders, type ScannedGraph } from "#/graphs.ts";

/** Changes graph data with one changed declaration in each of these files, and these packages. */
function changedIn(paths: Array<string>, packages: Array<string>): ScannedGraph {
  const declarations: ScannedGraph["declarations"] = {};
  for (const path of paths) declarations[`${path}\0run`] = { id: `${path}\0run`, path, label: "run", line: 1, status: "changed", tag: null, exported: true };
  return {
    status: "scanned",
    declarations,
    targets: {},
    problems: [],
    seeds: Object.keys(declarations),
    ripple: { edges: [], affected: 0, shown: 0 },
    links: [],
    pointReach: {},
    packages: packages.map((dir) => ({ dir, name: null })),
  };
}

const files = [
  "apps/web/src/main.ts",
  "apps/web/src/domain/billing/checkout.ts",
  "apps/web/src/domain/billing/refund.ts",
  "apps/web/src/domain/patients/read.ts",
  "packages/ui/src/button/Button.tsx",
  "scripts/seed.ts",
];
const data = changedIn(files, ["apps/web", "packages/ui"]);
/** The boxes: each as "label (in parent)", and where each file's declaration went. */
const boxes = (nested: boolean) => {
  const graph = rippleInFolders(data, [], nested);
  const labelOf = new Map(graph.groups.map((group) => [group.id, group.label]));
  return {
    groups: graph.groups.map((group) => `${group.label}${group.parent === undefined ? "" : ` (in ${labelOf.get(group.parent)})`}`),
    files: Object.fromEntries(graph.nodes.map((node) => [node.id.split("\0")[0], node.group === null ? null : labelOf.get(node.group)])),
  };
};

test("a box per folder with changed files, named from its package", () => {
  const { groups, files: placed } = boxes(false);
  assert.deepEqual(
    new Set(groups),
    new Set(["apps/web", "packages/ui", "src (in apps/web)", "src/domain/billing (in apps/web)", "src/domain/patients (in apps/web)", "src/button (in packages/ui)", "scripts"]),
  );
  assert.deepEqual(placed, {
    "apps/web/src/main.ts": "src",
    "apps/web/src/domain/billing/checkout.ts": "src/domain/billing",
    "apps/web/src/domain/billing/refund.ts": "src/domain/billing",
    "apps/web/src/domain/patients/read.ts": "src/domain/patients",
    "packages/ui/src/button/Button.tsx": "src/button",
    "scripts/seed.ts": "scripts",
  });
});

test("nested: every folder with files, and above them only the ones that hold two or more", () => {
  const { groups, files: placed } = boxes(true);
  assert.deepEqual(
    new Set(groups),
    new Set([
      "apps/web",
      "packages/ui",
      // src has a file of its own; domain holds billing and patients.
      "src (in apps/web)",
      "domain (in src)",
      "billing (in domain)",
      "patients (in domain)",
      // packages/ui/src holds only button, and has no files: left out, its name on button's.
      "src/button (in packages/ui)",
      // In no package: from the repository's root.
      "scripts",
    ]),
  );
  assert.equal(placed["apps/web/src/domain/billing/refund.ts"], "billing");
  assert.equal(placed["apps/web/src/main.ts"], "src");
  // Outer boxes come first: drawn under the ones in them.
  assert.ok(groups.indexOf("domain (in src)") > groups.indexOf("src (in apps/web)"));
  assert.ok(groups.indexOf("billing (in domain)") > groups.indexOf("domain (in src)"));
});
