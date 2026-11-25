import dagre from "@dagrejs/dagre";
import type { AnalyzedDeclaration, AnalyzedFile } from "#/analyze-diff.server.ts";
import type { ChangesGraph, GraphDeclaration } from "#/graph.server.ts";

/**
 * A declaration whose change is only to types, comments or formatting:
 * it's only a type (an interface, a type alias, ...), or only its types,
 * comments or formatting changed. Nothing that runs is different, so the
 * views and graphs leave it out.
 */
export function nothingRuns(declaration: AnalyzedDeclaration): boolean {
  return (
    declaration.status === "types" ||
    declaration.status === "comments" ||
    declaration.status === "formatting" ||
    (declaration.typeOnly && declaration.status !== "unchanged")
  );
}

/**
 * Whether anything that runs changed in a file: a declaration (see
 * `nothingRuns`), code outside the declarations, or an import of more than
 * types. A file with only changes to types, comments or formatting doesn't
 * count: the declaration views and the graphs leave it out. A file that
 * isn't parsed counts: there's no telling.
 */
export function runsChanged(file: AnalyzedFile): boolean {
  if (file.declarations === null) return true;
  if (file.declarations.some((declaration) => declaration.status !== "unchanged" && !nothingRuns(declaration))) return true;
  if ((file.outside ?? []).some((run) => run.kind !== "comment")) return true;
  return (file.imports ?? []).some((change) => change.status !== "unchanged" && !change.typeOnly);
}

/** A changed file as the graphs need it: its analysis, and where it is on the page. */
export type GraphFile = { file: AnalyzedFile; href: string };

/** The declaration graph of the changes, found (see graph.server.ts). */
export type ScannedGraph = Extract<ChangesGraph, { status: "scanned" }>;

export type GraphNode = {
  id: string;
  label: string;
  /** A second, smaller line: "export · changed", "network", ... */
  note: string | null;
  /** How it's drawn (see the graph components' styles). */
  kind: string;
  /** The box it's drawn in: its file; null: none. */
  group: string | null;
  /** Where clicking it goes: its file on the page. */
  href: string | null;
  /** On hover. */
  title: string;
};
/** `wide`: drawn thicker; a use from one app or package into another (see `appBoxesGraph`). */
export type GraphEdge = { from: string; to: string; kind: string; title: string; wide?: boolean };
/**
 * The boxes: one per file ("group:<path>"), and around those, one per app
 * or package ("package:<dir>", see `appBoxesGraph`); or, instead of the
 * files', one per folder ("folder:<package dir>\0<folder>", see
 * `rippleInFolders`). `parent`: the box it's drawn in.
 */
export type GraphGroup = { id: string; label: string; parent?: string };
export type Graph = { nodes: Array<GraphNode>; edges: Array<GraphEdge>; groups: Array<GraphGroup> };

/**
 * A graph of declarations: each one a node, in a box per file (a package
 * or global: no box). Every edge goes between two of them.
 */
function graphOf(data: ScannedGraph, files: Array<GraphFile>, ids: Iterable<string>, edges: Array<GraphEdge>): Graph {
  const hrefOf = new Map(files.map(({ file, href }) => [file.path, href]));
  const graph: Graph = { nodes: [], edges: [], groups: [] };
  const paths = new Set<string>();
  const seen = new Set<string>();
  for (const id of ids) {
    const declaration = data.declarations[id];
    if (declaration === undefined || seen.has(id)) continue;
    seen.add(id);
    graph.nodes.push(nodeOf(data, declaration, hrefOf));
    if (declaration.path !== "") paths.add(declaration.path);
  }
  graph.groups = [...paths].sort().map((path) => ({ id: `group:${path}`, label: path }));
  graph.edges = edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to));
  return splitOutside(graph);
}

/**
 * A package or global used from several files gets a node in each file's
 * box, beside what uses it: one shared node would pull every importer's
 * arrow across the graph to it.
 */
function splitOutside(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outside = new Set(graph.nodes.filter((node) => node.kind === "external").map((node) => node.id));
  const copies = new Map<string, GraphNode>();
  /** The copy of an outside node beside `other`: in its box, or (no box) beside it alone. */
  const copyOf = (id: string, other: string): string => {
    const node = byId.get(id);
    const beside = byId.get(other);
    if (node === undefined || beside === undefined) return id;
    const copy = `${id}\0${beside.group ?? beside.id}`;
    if (!copies.has(copy)) copies.set(copy, { ...node, id: copy, group: beside.group });
    return copy;
  };
  const edges = graph.edges.map((edge) => {
    if (outside.has(edge.from) && !outside.has(edge.to)) return { ...edge, from: copyOf(edge.from, edge.to) };
    if (outside.has(edge.to) && !outside.has(edge.from)) return { ...edge, to: copyOf(edge.to, edge.from) };
    return edge;
  });
  return { nodes: [...graph.nodes.filter((node) => !outside.has(node.id)), ...copies.values()], edges, groups: graph.groups };
}

function nodeOf(data: ScannedGraph, declaration: GraphDeclaration, hrefOf: Map<string, string>): GraphNode {
  const tag = declaration.tag === null ? null : (data.targets[declaration.tag]?.label ?? null);
  if (declaration.status === "outside") {
    return { id: declaration.id, label: declaration.label, note: tag, kind: "external", group: null, href: null, title: declaration.label };
  }
  const word = declaration.status === "affected" ? "same code" : declaration.status === "unchanged" ? null : declaration.status;
  const note = [declaration.exported ? "export" : null, word, tag].filter((part) => part !== null).join(" · ");
  // The declaration itself in its file on the page (see DeclarationsView's ids); the page falls back to the file.
  const fileHref = hrefOf.get(declaration.path);
  return {
    id: declaration.id,
    label: declaration.label,
    note: note === "" ? null : note,
    kind: declaration.status,
    group: `group:${declaration.path}`,
    href: fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(declaration.label)}`,
    title: `${declaration.label} in ${declaration.path}${declaration.status === "unchanged" ? "" : `: ${declaration.status}`}`,
  };
}

const label = (data: ScannedGraph, id: string) => data.declarations[id]?.label ?? id;

/**
 * The repository's points (see points.ts) added to a graph: an arrow to a
 * point from each declaration on the graph that reaches it, unless the
 * next declaration on the way is on the graph and has its own arrow (the
 * chain shows the rest). Each file's box gets its own node for a point:
 * the arrows stay short, in the box, instead of all crossing the graph to
 * one node. Hovering the arrow tells the way.
 */
function withPoints(data: ScannedGraph, graph: Graph): Graph {
  const shown = new Set(graph.nodes.map((node) => node.id));
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  /** The node for a point beside `node`: in its box, or (no box) its own. */
  const pointNode = (target: string, node: GraphNode): string => {
    const id = `${target}\0${node.group ?? node.id}`;
    if (!nodes.some((existing) => existing.id === id)) {
      const point = data.targets[target];
      nodes.push({ id, label: point?.label ?? target, note: null, kind: "point", group: node.group, href: null, title: point?.about ?? point?.label ?? target });
    }
    return id;
  };
  for (const node of graph.nodes) {
    // A package a point names says so under its name (see nodeOf); what uses it has the arrow to the point.
    for (const entry of data.pointReach[node.id] ?? []) {
      const nextCarries = entry.next !== null && shown.has(entry.next) && (data.pointReach[entry.next] ?? []).some((other) => other.target === entry.target);
      if (nextCarries) continue;
      const name = data.targets[entry.target]?.label ?? entry.target;
      const way = entry.way.map((id) => label(data, id)).join(" → ");
      edges.push({
        from: node.id,
        to: pointNode(entry.target, node),
        kind: "point",
        title: entry.way.length === 0 ? `${label(data, node.id)} is part of ${name}` : `${label(data, node.id)} reaches ${name} through ${way}`,
      });
    }
  }
  return { nodes, edges, groups: graph.groups };
}

// ---------------------------------------------------------------------------
// 1. Ripple.

/**
 * The ripple: the changed declarations, every declaration that uses one, and
 * what uses those, through the whole repository (the nearest first, at most
 * 150). And the uses of a declaration in another file (or of a package) that
 * the changes added or removed, and the ones between two changed
 * declarations. In a box per file, every arrow the same way: from what's
 * used to what uses it, the way a change spreads. A use that's new is green,
 * one that went away red and dashed, whatever its ends; the rest are colored
 * by what they spread.
 */
export function combinedGraph(data: ScannedGraph, files: Array<GraphFile>): Graph {
  const edges = new Map<string, GraphEdge>();
  for (const edge of data.ripple.edges) {
    edges.set(`${edge.from}\u0001${edge.to}`, {
      from: edge.from,
      to: edge.to,
      kind: data.declarations[edge.from]?.status ?? "affected",
      title: `${label(data, edge.to)} uses ${label(data, edge.from)}`,
    });
  }
  for (const link of data.links) {
    const key = `${link.to}\u0001${link.from}`;
    // An unchanged use the ripple has already says more: what it spreads.
    if (link.status === "kept" && edges.has(key)) continue;
    edges.set(key, {
      from: link.to,
      to: link.from,
      kind: link.status,
      title: `${label(data, link.from)} ${link.status === "added" ? "now uses" : link.status === "removed" ? "no longer uses" : "uses"} ${label(data, link.to)}`,
    });
  }
  const ids = [...data.seeds, ...data.ripple.edges.flatMap((edge) => [edge.from, edge.to]), ...data.links.flatMap((link) => [link.from, link.to])];
  return withPoints(data, graphOf(data, files, ids, [...edges.values()]));
}

/**
 * Ripple + import map with a box per app or package around its files'
 * boxes: the folder of the nearest package.json above each file (the
 * repository's root one aside: it holds everything). Each app's code stays
 * together, and the lines between apps (a portal using the server's code)
 * stand out. A file in no package keeps its own box, outside.
 */
export function appBoxesGraph(data: ScannedGraph, files: Array<GraphFile>): Graph {
  const graph = combinedGraph(data, files);
  // The deepest package first: a file is in the nearest one above it.
  const packages = data.packages.filter((entry) => entry.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (path: string) => packages.find((entry) => path.startsWith(`${entry.dir}/`)) ?? null;

  const used = new Map<string, { dir: string; name: string | null }>();
  const fileGroups = graph.groups.map((group) => {
    const path = group.id.slice("group:".length);
    const found = packageOf(path);
    if (found === null) return group;
    used.set(found.dir, found);
    // Within its box, a file's path from the package's folder.
    return { ...group, label: path.slice(found.dir.length + 1), parent: `package:${found.dir}` };
  });
  const packageGroups = [...used.values()]
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map((entry) => ({ id: `package:${entry.dir}`, label: entry.name === null || entry.name === entry.dir ? entry.dir : `${entry.dir} · ${entry.name}` }));

  // A use from one app into another: drawn thicker, it's where apps share code.
  const appOfGroup = new Map(fileGroups.map((group) => [group.id, group.parent ?? null]));
  const appOf = new Map(graph.nodes.map((node) => [node.id, node.group === null ? null : (appOfGroup.get(node.group) ?? null)]));
  const edges = graph.edges.map((edge) => {
    const from = appOf.get(edge.from) ?? null;
    const to = appOf.get(edge.to) ?? null;
    return from !== null && to !== null && from !== to ? { ...edge, wide: true, title: `${edge.title} (from one app or package into another)` } : edge;
  });
  // The packages first: drawn under the files' boxes.
  return { nodes: graph.nodes, edges, groups: [...packageGroups, ...fileGroups] };
}

// ---------------------------------------------------------------------------
// 1a. Ripple without file boxes: none, or a box per folder.

/** The edges again without repeats (same ends, same kind), and none from a node to itself. */
function distinctEdges(edges: Array<GraphEdge>): Array<GraphEdge> {
  const seen = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from}\u0001${edge.to}\u0001${edge.kind}`;
    if (!seen.has(key)) seen.set(key, edge);
  }
  return [...seen.values()];
}

/**
 * The graph without its files' boxes: what was in a file's box goes to
 * `boxOf` that box (null: no box), and `groups` are the boxes now. A
 * declaration says which file it's in under its name; a package's or
 * point's copy per file box becomes one per new box.
 */
function withoutFileBoxes(graph: Graph, boxOf: Map<string, string | null>, groups: Array<GraphGroup>): Graph {
  // Each node's new id: a copy per file box becomes one per new box.
  const renamed = new Map<string, string>();
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    const box = node.group === null ? null : (boxOf.get(node.group) ?? null);
    const copyOfFile = (node.kind === "external" || node.kind === "point") && node.group !== null && node.id.endsWith(`\u0000${node.group}`);
    if (copyOfFile && node.group !== null) {
      const id = `${node.id.slice(0, -(node.group.length + 1))}\u0000${box ?? node.group}`;
      renamed.set(node.id, id);
      if (!nodes.has(id)) nodes.set(id, { ...node, id, group: box });
      continue;
    }
    // Without its file's box, a declaration says which file it's in.
    const file = node.group === null ? null : (node.group.slice("group:".length).split("/").at(-1) ?? null);
    const note = file === null ? node.note : node.note === null ? file : `${file} · ${node.note}`;
    nodes.set(node.id, { ...node, note, group: box });
  }
  const edges = distinctEdges(graph.edges.map((edge) => ({ ...edge, from: renamed.get(edge.from) ?? edge.from, to: renamed.get(edge.to) ?? edge.to })));
  return { nodes: [...nodes.values()], edges, groups };
}

/**
 * Ripple with a box per app or package, but none per file: each app's
 * declarations side by side in its box, each with its file's name under
 * it. A package or point used from several files of one app is one node in
 * its box. Fewer boxes to place: a tighter graph.
 */
export function rippleWithoutFileBoxes(data: ScannedGraph, files: Array<GraphFile>): Graph {
  const graph = appBoxesGraph(data, files);
  const boxOf = new Map(graph.groups.map((group) => [group.id, group.parent ?? null]));
  return withoutFileBoxes(graph, boxOf, graph.groups.filter((group) => group.id.startsWith("package:")));
}

/**
 * Ripple with a box per folder instead of per file, in the app's or
 * package's box. `nested` false: one box per folder that has a changed or
 * affected file, named by its path from the package ("src/domain/billing").
 * `nested` true: those folders, and the folders above them that are worth a
 * box: ones that hold two or more of them; a folder with only one, and no
 * files of its own, is left out (its name goes on its one folder's). The
 * root of a package is the package's own box.
 */
export function rippleInFolders(data: ScannedGraph, files: Array<GraphFile>, nested: boolean): Graph {
  const graph = appBoxesGraph(data, files);
  const packageGroups = graph.groups.filter((group) => group.id.startsWith("package:"));
  /** A file's box: its package's box (or none), the package's folder, and the file's folder from there ("" its root). */
  const placeOf = (group: GraphGroup) => {
    const path = group.id.slice("group:".length);
    const packageBox = group.parent ?? null;
    const packageDir = packageBox === null ? "" : packageBox.slice("package:".length);
    const inPackage = packageDir === "" ? path : path.slice(packageDir.length + 1);
    const slash = inPackage.lastIndexOf("/");
    return { packageBox, packageDir, folder: slash === -1 ? "" : inPackage.slice(0, slash) };
  };
  const folderId = (packageDir: string, folder: string) => `folder:${packageDir}\u0000${folder}`;
  const fileGroups = graph.groups.filter((group) => group.id.startsWith("group:"));
  const boxOf = new Map<string, string | null>();
  const folderGroups = new Map<string, GraphGroup>();

  if (!nested) {
    for (const group of fileGroups) {
      const place = placeOf(group);
      if (place.folder === "") {
        boxOf.set(group.id, place.packageBox);
        continue;
      }
      const id = folderId(place.packageDir, place.folder);
      boxOf.set(group.id, id);
      if (!folderGroups.has(id)) folderGroups.set(id, { id, label: place.folder, ...(place.packageBox === null ? {} : { parent: place.packageBox }) });
    }
  } else {
    // Per package: the folders with files, and every folder above them.
    const places = fileGroups.map((group) => ({ group, ...placeOf(group) }));
    for (const packageDir of new Set(places.map((place) => place.packageDir))) {
      const mine = places.filter((place) => place.packageDir === packageDir);
      const packageBox = mine[0]?.packageBox ?? null;
      const withFiles = new Set(mine.map((place) => place.folder));
      // Each folder's folders that lead to files.
      const children = new Map<string, Set<string>>();
      for (const folder of withFiles) {
        let child = folder;
        while (child !== "") {
          const slash = child.lastIndexOf("/");
          const parent = slash === -1 ? "" : child.slice(0, slash);
          children.set(parent, (children.get(parent) ?? new Set()).add(child));
          child = parent;
        }
      }
      // Worth a box: files of its own, or two or more folders that lead to files. The root is the package's box.
      const kept = (folder: string) => folder !== "" && (withFiles.has(folder) || (children.get(folder)?.size ?? 0) >= 2);
      const keptAbove = (folder: string): string => {
        let above = folder;
        while (above !== "") {
          const slash = above.lastIndexOf("/");
          above = slash === -1 ? "" : above.slice(0, slash);
          if (above === "" || kept(above)) return above;
        }
        return "";
      };
      const allFolders = new Set([...withFiles, ...children.keys(), ...[...children.values()].flatMap((set) => [...set])]);
      for (const folder of allFolders) {
        if (!kept(folder)) continue;
        const above = keptAbove(folder);
        const id = folderId(packageDir, folder);
        // Named from the box it's in: "domain/billing" in "src".
        const label = above === "" ? folder : folder.slice(above.length + 1);
        const parent = above === "" ? packageBox : folderId(packageDir, above);
        folderGroups.set(id, { id, label, ...(parent === null ? {} : { parent }) });
      }
      for (const place of mine) boxOf.set(place.group.id, place.folder === "" ? packageBox : folderId(packageDir, place.folder));
    }
  }

  // Outer boxes first: drawn under the ones in them.
  const depth = (group: GraphGroup) => group.id.split("\u0000")[1]?.split("/").length ?? 0;
  const folders = [...folderGroups.values()].sort((a, b) => depth(a) - depth(b));
  return withoutFileBoxes(graph, boxOf, [...packageGroups, ...folders]);
}

// ---------------------------------------------------------------------------
// Layout.

export type PlacedNode = GraphNode & { x: number; y: number; width: number; height: number };
export type PlacedGroup = GraphGroup & { x: number; y: number; width: number; height: number };
export type PlacedEdge = GraphEdge & { points: Array<{ x: number; y: number }> };
export type GraphLayout = {
  width: number;
  height: number;
  nodes: Array<PlacedNode>;
  edges: Array<PlacedEdge>;
  groups: Array<PlacedGroup>;
  /** The graph has boxes per file, but dagre couldn't place them: drawn without. */
  withoutBoxes: boolean;
};

/**
 * Where everything goes, left to right (dagre); x and y are centers. Text is
 * measured as 7px a character (12px monospace). Dagre fails on some graphs
 * with boxes (its compound layout; 1.1.4 and 3.1.2 alike): those are drawn
 * without the boxes rather than not at all.
 */
export function layoutGraph(graph: Graph): GraphLayout {
  if (graph.groups.length === 0) return placeGraph(graph, true);
  try {
    return placeGraph(graph, true);
  } catch {
    return { ...placeGraph(graph, false), withoutBoxes: true };
  }
}

function placeGraph(graph: Graph, boxes: boolean): GraphLayout {
  if (!boxes) graph = { ...graph, groups: [] };
  const layout = new dagre.graphlib.Graph({ compound: true, multigraph: false });
  layout.setGraph({ rankdir: "LR", nodesep: graph.groups.length > 0 ? 26 : 14, ranksep: 70, marginx: 16, marginy: 28 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const group of graph.groups) layout.setNode(group.id, { label: group.label });
  // A file's box in its app's box.
  for (const group of graph.groups) if (group.parent !== undefined && layout.hasNode(group.parent)) layout.setParent(group.id, group.parent);
  for (const node of graph.nodes) {
    const characters = Math.max(node.label.length, node.note?.length ?? 0);
    layout.setNode(node.id, { width: Math.min(characters, 48) * 7 + 20, height: node.note === null ? 26 : 40 });
    if (node.group !== null && graph.groups.some((group) => group.id === node.group)) layout.setParent(node.id, node.group);
  }
  for (const edge of graph.edges) {
    if (layout.hasNode(edge.from) && layout.hasNode(edge.to) && edge.from !== edge.to) layout.setEdge(edge.from, edge.to);
  }
  dagre.layout(layout);

  const nodes = graph.nodes.map((node) => {
    const placed = layout.node(node.id);
    return { ...node, x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  });
  const groups = graph.groups.flatMap((group) => {
    const placed = layout.node(group.id);
    // A box with nothing in it isn't placed.
    return placed?.width === undefined ? [] : [{ ...group, x: placed.x, y: placed.y, width: placed.width, height: placed.height }];
  });
  const edges = graph.edges.flatMap((edge) => {
    if (!layout.hasEdge(edge.from, edge.to)) return [];
    return [{ ...edge, points: layout.edge(edge.from, edge.to).points ?? [] }];
  });
  // Long edges across boxes can bend outside what dagre measures: the
  // drawing is everything's bounds, a margin around, moved to start at 0.
  const xs = [...nodes.flatMap((node) => [node.x - node.width / 2, node.x + node.width / 2]), ...groups.flatMap((group) => [group.x - group.width / 2, group.x + group.width / 2]), ...edges.flatMap((edge) => edge.points.map((point) => point.x))];
  const ys = [
    ...nodes.flatMap((node) => [node.y - node.height / 2, node.y + node.height / 2]),
    // Room for a box's name above it.
    ...groups.flatMap((group) => [group.y - group.height / 2 - 14, group.y + group.height / 2]),
    ...edges.flatMap((edge) => edge.points.map((point) => point.y)),
  ];
  const margin = 16;
  const left = Math.min(...xs) - margin;
  const top = Math.min(...ys) - margin;
  const move = <Placed extends { x: number; y: number }>(placed: Placed): Placed => ({ ...placed, x: placed.x - left, y: placed.y - top });
  return {
    width: Math.max(...xs) - left + margin,
    height: Math.max(...ys) - top + margin,
    nodes: nodes.map(move),
    groups: groups.map(move),
    edges: edges.map((edge) => ({ ...edge, points: edge.points.map(move) })),
    withoutBoxes: false,
  };
}
