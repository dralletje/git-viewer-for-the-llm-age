import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";

/**
 * The heat map: the code the changes touch as nested rectangles, package →
 * folder → file → declaration, each declaration as large as its lines.
 * Only what the declaration graph holds is in it (the changes, what they
 * spread to, the ends of added or removed uses): the page isn't sent the
 * rest of the repository.
 */

export type HeatStatus = "changed" | "added" | "removed" | "affected" | "unchanged";

export type HeatNode = {
  id: string;
  kind: "root" | "package" | "folder" | "file" | "declaration";
  label: string;
  /** A folder's or file's path from the repository's root; a declaration's file. A package: its folder. */
  path: string;
  /** Lines of code: a declaration's own, a box's all its declarations'. */
  size: number;
  /** A declaration's; null for a box. */
  status: HeatStatus | null;
  /** How many declarations in it have each status (a declaration: itself). */
  counts: Record<HeatStatus, number>;
  /** Hops from the nearest change over the ripple (0: a change itself); null: not on the ripple. A box: its nearest. */
  distance: number | null;
  /** The points (`targets` keys) it reaches; a box: any of its declarations. */
  points: Array<string>;
  children: Array<HeatNode>;
};

/**
 * How far each declaration is from a change: 0 for one that changed, was
 * added or removed, then one more for each use along the ripple's edges
 * (from what's used to what uses it). The nearest way counts.
 */
export function rippleDistances(data: ScannedGraph): Map<string, number> {
  const distance = new Map<string, number>();
  const queue: Array<string> = [];
  const start = (id: string) => {
    if (distance.has(id)) return;
    distance.set(id, 0);
    queue.push(id);
  };
  for (const id of data.seeds) {
    const status = data.declarations[id]?.status;
    if (status === "changed" || status === "added" || status === "removed") start(id);
  }
  for (const declaration of Object.values(data.declarations)) {
    if (declaration.status === "changed" || declaration.status === "added" || declaration.status === "removed") start(declaration.id);
  }
  // Seeds that are only affected within their file still start a ripple, one step out.
  for (const id of data.seeds) {
    if (!distance.has(id)) {
      distance.set(id, 1);
      queue.push(id);
    }
  }
  const usedBy = new Map<string, Array<string>>();
  for (const edge of data.ripple.edges) usedBy.set(edge.from, [...(usedBy.get(edge.from) ?? []), edge.to]);
  // Breadth first, but seeds at 1 must wait for the ones at 0: sorted once by where they start.
  queue.sort((a, b) => (distance.get(a) ?? 0) - (distance.get(b) ?? 0));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index] as string;
    const here = distance.get(id) ?? 0;
    for (const next of usedBy.get(id) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, here + 1);
      queue.push(next);
    }
  }
  return distance;
}

function noCounts(): Record<HeatStatus, number> {
  return { changed: 0, added: 0, removed: 0, affected: 0, unchanged: 0 };
}

/** A declaration's lines: from its start to its end, and the parts of it further down. */
export function linesOf(declaration: GraphDeclaration): number {
  const own = Math.max(1, declaration.endLine - declaration.line + 1);
  return own + declaration.parts.reduce((sum, part) => sum + Math.max(1, part.endLine - part.startLine + 1), 0);
}

/**
 * The tree to draw: a box per app or package (the nearest package.json's
 * folder; the repository's root one holds what's in none), folders in it
 * (a chain of folders with nothing else in them is one box: "src/domain"),
 * files, declarations. Packages and globals aren't the repository's code:
 * left out.
 */
export function heatTree(data: ScannedGraph): HeatNode {
  const distances = rippleDistances(data);
  const packages = data.packages.filter((entry) => entry.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  const root = box("root", "root", "", "");
  const packageNodes = new Map<string, HeatNode>();
  const folderNodes = new Map<string, HeatNode>();
  const fileNodes = new Map<string, HeatNode>();

  for (const declaration of Object.values(data.declarations)) {
    if (declaration.status === "outside" || declaration.path === "") continue;
    const found = packages.find((entry) => declaration.path.startsWith(`${entry.dir}/`)) ?? null;
    const dir = found?.dir ?? "";
    let packageNode = packageNodes.get(dir);
    if (packageNode === undefined) {
      const label = found === null ? "(repository root)" : found.name === null || found.name === found.dir ? found.dir : `${found.name}`;
      packageNode = box(`package:${dir}`, "package", label, dir);
      packageNodes.set(dir, packageNode);
      root.children.push(packageNode);
    }
    // The folders from the package's folder to the file's.
    const inPackage = dir === "" ? declaration.path : declaration.path.slice(dir.length + 1);
    const segments = inPackage.split("/");
    const fileName = segments.pop() ?? inPackage;
    let parent = packageNode;
    let folderPath = dir;
    for (const segment of segments) {
      folderPath = folderPath === "" ? segment : `${folderPath}/${segment}`;
      let folder = folderNodes.get(folderPath);
      if (folder === undefined) {
        folder = box(`folder:${folderPath}`, "folder", segment, folderPath);
        folderNodes.set(folderPath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    let file = fileNodes.get(declaration.path);
    if (file === undefined) {
      file = box(`file:${declaration.path}`, "file", fileName, declaration.path);
      fileNodes.set(declaration.path, file);
      parent.children.push(file);
    }
    const status = declaration.status;
    const counts = noCounts();
    counts[status] = 1;
    file.children.push({
      id: declaration.id,
      kind: "declaration",
      label: declaration.label,
      path: declaration.path,
      size: linesOf(declaration),
      status,
      counts,
      distance: distances.get(declaration.id) ?? null,
      points: [...new Set((data.pointReach[declaration.id] ?? []).map((entry) => entry.target))],
      children: [],
    });
  }

  for (const packageNode of packageNodes.values()) packageNode.children = packageNode.children.map(mergeChains);
  total(root);
  return root;
}

function box(id: string, kind: HeatNode["kind"], label: string, path: string): HeatNode {
  return { id, kind, label, path, size: 0, status: null, counts: noCounts(), distance: null, points: [], children: [] };
}

/** A folder whose only content is one folder: the two are one box, named "a/b". */
function mergeChains(node: HeatNode): HeatNode {
  if (node.kind !== "folder") return node;
  let merged = node;
  while (merged.children.length === 1 && merged.children[0]?.kind === "folder") {
    const only = merged.children[0];
    merged = { ...only, id: only.id, label: `${merged.label}/${only.label}` };
  }
  return { ...merged, children: merged.children.map(mergeChains) };
}

/** Each box's size, counts, nearest distance and points: from what's in it. */
function total(node: HeatNode): void {
  if (node.kind === "declaration") return;
  const points = new Set<string>();
  for (const child of node.children) {
    total(child);
    node.size += child.size;
    for (const status of Object.keys(node.counts) as Array<HeatStatus>) node.counts[status] += child.counts[status];
    if (child.distance !== null && (node.distance === null || child.distance < node.distance)) node.distance = child.distance;
    for (const point of child.points) points.add(point);
  }
  node.points = [...points];
}

/** Every node by id, and the box each is in: for zooming and the breadcrumb. */
export function indexTree(root: HeatNode): { byId: Map<string, HeatNode>; parentOf: Map<string, string> } {
  const byId = new Map<string, HeatNode>();
  const parentOf = new Map<string, string>();
  const visit = (node: HeatNode) => {
    byId.set(node.id, node);
    for (const child of node.children) {
      parentOf.set(child.id, node.id);
      visit(child);
    }
  };
  visit(root);
  return { byId, parentOf };
}

// ---------------------------------------------------------------------------
// Layout.

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): `values` as rectangles that
 * fill `rect`, each as close to a square as the row it's in allows, so a
 * small declaration stays a box rather than a sliver. The rectangles come
 * back in the order of `values`.
 */
export function squarify(values: Array<number>, rect: Rect): Array<Rect> {
  const result: Array<Rect> = values.map(() => ({ x: rect.x, y: rect.y, width: 0, height: 0 }));
  const sum = values.reduce((total, value) => total + Math.max(0, value), 0);
  if (sum <= 0 || rect.width <= 0 || rect.height <= 0) return result;
  const scale = (rect.width * rect.height) / sum;
  const order = values
    .map((value, index) => ({ index, area: Math.max(0, value) * scale }))
    .filter((item) => item.area > 0)
    .sort((a, b) => b.area - a.area);

  let free = { ...rect };
  /** The row's worst aspect ratio, laid along a side `side` long. */
  const worst = (row: Array<{ area: number }>, side: number) => {
    const rowArea = row.reduce((total, item) => total + item.area, 0);
    let ratio = 0;
    for (const item of row) ratio = Math.max(ratio, (side * side * item.area) / (rowArea * rowArea), (rowArea * rowArea) / (side * side * item.area));
    return ratio;
  };
  const place = (row: Array<{ index: number; area: number }>, last: boolean) => {
    const rowArea = row.reduce((total, item) => total + item.area, 0);
    if (free.width >= free.height) {
      // A column at the left, the length of the free height.
      const width = last ? free.width : rowArea / free.height;
      let y = free.y;
      row.forEach((item, position) => {
        const height = position === row.length - 1 ? free.y + free.height - y : item.area / width;
        result[item.index] = { x: free.x, y, width, height };
        y += height;
      });
      free = { x: free.x + width, y: free.y, width: free.width - width, height: free.height };
    } else {
      // A row along the top, the length of the free width.
      const height = last ? free.height : rowArea / free.width;
      let x = free.x;
      row.forEach((item, position) => {
        const width = position === row.length - 1 ? free.x + free.width - x : item.area / height;
        result[item.index] = { x, y: free.y, width, height };
        x += width;
      });
      free = { x: free.x, y: free.y + height, width: free.width, height: free.height - height };
    }
  };

  let row: Array<{ index: number; area: number }> = [];
  for (let index = 0; index < order.length; ) {
    const item = order[index] as { index: number; area: number };
    const side = Math.min(free.width, free.height);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) {
      row.push(item);
      index++;
      continue;
    }
    place(row, false);
    row = [];
  }
  // The last row takes what's left, so rounding never leaves a gap.
  if (row.length > 0) place(row, true);
  return result;
}

export type PlacedHeat = Rect & {
  node: HeatNode;
  depth: number;
  /** Whether its name has a strip at its top (a box large enough for one). */
  header: boolean;
};

/** A box's name strip, and the gap around what's in it. */
export const headerHeight = 16;
export const boxPadding = 2;

/**
 * The tree laid out in `rect`: `root` itself isn't drawn, its children fill
 * the whole of it. A box gets a strip for its name when it's large enough
 * for one (and its contents still have room), else only a thin border; a
 * box too small to show anything in it is drawn alone, without its
 * contents. Outer boxes come first: drawn under what's in them.
 */
export function layoutTreemap(root: HeatNode, rect: Rect): Array<PlacedHeat> {
  const placed: Array<PlacedHeat> = [];
  const fill = (node: HeatNode, inner: Rect, depth: number) => {
    const rects = squarify(
      node.children.map((child) => child.size),
      inner,
    );
    node.children.forEach((child, index) => {
      const area = rects[index];
      if (area === undefined || area.width <= 0 || area.height <= 0) return;
      if (child.kind === "declaration") {
        placed.push({ ...area, node: child, depth, header: false });
        return;
      }
      const header = area.width >= 36 && area.height >= headerHeight + 12;
      placed.push({ ...area, node: child, depth, header });
      const top = header ? headerHeight : boxPadding;
      const contents = { x: area.x + boxPadding, y: area.y + top, width: area.width - boxPadding * 2, height: area.height - top - boxPadding };
      if (contents.width < 3 || contents.height < 3) return;
      fill(child, contents, depth + 1);
    });
  };
  fill(root, rect, 0);
  return placed;
}
