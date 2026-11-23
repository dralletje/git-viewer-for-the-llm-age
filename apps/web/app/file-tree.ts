export type FileTreeFolder<File> = {
  kind: "folder";
  /** One folder, or a chain of folders that each hold only the next: "app/routes". */
  name: string;
  path: string;
  children: Array<FileTreeNode<File>>;
};
export type FileTreeFile<File> = {
  kind: "file";
  name: string;
  path: string;
  file: File;
};
export type FileTreeNode<File> = FileTreeFolder<File> | FileTreeFile<File>;

/**
 * Paths as a tree: folders before files, each alphabetical, and a folder
 * that only holds one folder merged into it ("apps/web/app"), so a deep
 * monorepo path doesn't cost a row per level.
 */
export function buildFileTree<File>(files: Array<File>, pathOf: (file: File) => string): Array<FileTreeNode<File>> {
  const root: FileTreeFolder<File> = { kind: "folder", name: "", path: "", children: [] };

  for (const file of files) {
    const parts = pathOf(file).split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.children.find((child): child is FileTreeFolder<File> => child.kind === "folder" && child.name === part);
      if (next === undefined) {
        next = { kind: "folder", name: part, path: folder.path === "" ? part : `${folder.path}/${part}`, children: [] };
        folder.children.push(next);
      }
      folder = next;
    }
    folder.children.push({ kind: "file", name: parts.at(-1) ?? "", path: pathOf(file), file });
  }

  return tidy(root).children;
}

function tidy<File>(folder: FileTreeFolder<File>): FileTreeFolder<File> {
  let current = folder;
  // Merge a chain of single-folder folders (but never into the root).
  while (current.name !== "" && current.children.length === 1 && current.children[0]?.kind === "folder") {
    const only: FileTreeFolder<File> = current.children[0];
    current = { kind: "folder", name: `${current.name}/${only.name}`, path: only.path, children: only.children };
  }
  const children = current.children.map((child) => (child.kind === "folder" ? tidy(child) : child));
  children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
  return { ...current, children };
}

/** The files in the order the tree shows them, top to bottom. */
export function filesInTreeOrder<File>(nodes: Array<FileTreeNode<File>>): Array<File> {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : filesInTreeOrder(node.children)));
}
