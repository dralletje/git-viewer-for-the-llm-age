import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, filesInTreeOrder, type FileTreeNode } from "#/file-tree.ts";

function show(nodes: Array<FileTreeNode<string>>, depth = 0): Array<string> {
  return nodes.flatMap((node) =>
    node.kind === "file" ? [`${"  ".repeat(depth)}${node.name}`] : [`${"  ".repeat(depth)}${node.name}/`, ...show(node.children, depth + 1)],
  );
}

test("folders first, single-folder chains merged, files in tree order", () => {
  const paths = ["README.md", "apps/web/app/routes/a.tsx", "apps/web/app/routes/b.tsx", "apps/web/app/root.tsx", "packages/git/src/index.ts", "package.json"];
  const tree = buildFileTree(paths, (path) => path);

  assert.deepEqual(show(tree), [
    "apps/web/app/",
    "  routes/",
    "    a.tsx",
    "    b.tsx",
    "  root.tsx",
    "packages/git/src/",
    "  index.ts",
    "package.json",
    "README.md",
  ]);
  assert.deepEqual(filesInTreeOrder(tree), [
    "apps/web/app/routes/a.tsx",
    "apps/web/app/routes/b.tsx",
    "apps/web/app/root.tsx",
    "packages/git/src/index.ts",
    "package.json",
    "README.md",
  ]);
});
