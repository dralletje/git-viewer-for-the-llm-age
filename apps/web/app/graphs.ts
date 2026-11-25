import dagre from "@dagrejs/dagre";
import type { UsedChange } from "@room/syntax";
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
  /** Clicking it opens or closes this (a folded file, see `foldedGraph`), instead of following `href`. */
  toggle?: string;
};
/** `wide`: drawn thicker; a use from one app or package into another (see `appBoxesGraph`). */
export type GraphEdge = { from: string; to: string; kind: string; title: string; wide?: boolean };
/**
 * The boxes: one per file ("group:<path>"), and around those, one per app
 * or package ("package:<dir>", see `appBoxesGraph`). `parent`: the box it's
 * drawn in.
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
// 1. Ripple + import map.

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
// 1a–b. Ripple + import map, for big ripples: nothing left out, less drawn.

/** How many steps of the ripple each declaration is from a change (a change: 0). */
function rippleDistances(data: ScannedGraph): Map<string, number> {
  const distance = new Map(data.seeds.map((id) => [id, 0]));
  const queue = [...data.seeds];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index] ?? "";
    for (const edge of data.ripple.edges) {
      if (edge.from !== id || distance.has(edge.to)) continue;
      distance.set(edge.to, (distance.get(id) ?? 0) + 1);
      queue.push(edge.to);
    }
  }
  return distance;
}

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
 * Ripple + import map with the far files folded: a file whose nearest
 * declaration is 3 or more steps from a change is one node ("9
 * declarations"), its arrows kept, to and from the file. Clicking one opens
 * it (`opened`: the files' boxes, "group:<path>"), in place.
 */
export function foldedGraph(data: ScannedGraph, files: Array<GraphFile>, opened: Set<string>): Graph {
  const graph = combinedGraph(data, files);
  const distance = rippleDistances(data);
  // Each box's nearest step from a change; a declaration not on the ripple (a link's end) counts as near.
  const nearest = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.group === null || node.kind === "external" || node.kind === "point") continue;
    nearest.set(node.group, Math.min(nearest.get(node.group) ?? Infinity, distance.get(node.id) ?? 0));
  }
  const folded = new Set([...nearest].filter(([group, steps]) => steps >= 3 && !opened.has(group)).map(([group]) => group));
  if (folded.size === 0) return graph;

  const foldOf = (node: GraphNode | undefined) => (node !== undefined && node.group !== null && folded.has(node.group) ? `fold:${node.group}` : null);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: Array<GraphNode> = graph.nodes.filter((node) => foldOf(node) === null);
  for (const group of folded) {
    const inside = graph.nodes.filter((node) => node.group === group && node.kind !== "external" && node.kind !== "point");
    const path = group.slice("group:".length);
    nodes.push({
      id: `fold:${group}`,
      label: `${inside.length} ${inside.length === 1 ? "declaration" : "declarations"}`,
      note: `${Math.min(...inside.map((node) => distance.get(node.id) ?? 0))}+ steps away · click to open`,
      kind: "folded",
      group,
      href: null,
      title: `${path}: ${inside.map((node) => node.label).join(", ")}`,
      toggle: group,
    });
  }
  const edges = distinctEdges(
    graph.edges.map((edge) => ({ ...edge, from: foldOf(byId.get(edge.from)) ?? edge.from, to: foldOf(byId.get(edge.to)) ?? edge.to })),
  );
  return { nodes, edges, groups: graph.groups };
}

/**
 * Ripple + import map with one line per file: arrows from one declaration
 * into several in another file's box go as one line to a small node in
 * that box ("9"), which fans out inside it; and the same the other way,
 * from several in one box to one declaration elsewhere. Every arrow is
 * still there, the long ones bundled.
 */
export function bundledGraph(data: ScannedGraph, files: Array<GraphFile>): Graph {
  const graph = combinedGraph(data, files);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const groupOf = (id: string) => byId.get(id)?.group ?? null;
  // A node's name: a package's copy in a box has an id of its own.
  const name = (id: string) => byId.get(id)?.label ?? id;
  const crosses = (edge: GraphEdge) => {
    const from = groupOf(edge.from);
    const to = groupOf(edge.to);
    return from !== null && to !== null && from !== to;
  };
  const hubs: Array<GraphNode> = [];
  const hub = (id: string, group: string, count: number, title: string): string => {
    hubs.push({ id, label: String(count), note: null, kind: "hub", group, href: null, title });
    return id;
  };

  // Into a box: one declaration to several in another file.
  const into = new Map<string, Array<GraphEdge>>();
  for (const edge of graph.edges) {
    if (!crosses(edge)) continue;
    const key = `${edge.from}\u0001${groupOf(edge.to)}`;
    into.set(key, [...(into.get(key) ?? []), edge]);
  }
  const bundled = new Set<GraphEdge>();
  const edges: Array<GraphEdge> = [];
  for (const [key, list] of into) {
    if (list.length < 2) continue;
    const [from = "", group = ""] = key.split("\u0001");
    const id = hub(`hub-in\u0000${key}`, group, list.length, `${name(from)} is used by ${list.length} declarations in ${group.slice("group:".length)}`);
    edges.push({ from, to: id, kind: list[0]?.kind ?? "affected", title: `${name(from)} → ${list.length} in ${group.slice("group:".length)}` });
    for (const edge of list) {
      edges.push({ ...edge, from: id });
      bundled.add(edge);
    }
  }
  // Out of a box: several declarations in one file to one elsewhere.
  const outOf = new Map<string, Array<GraphEdge>>();
  for (const edge of graph.edges) {
    if (bundled.has(edge) || !crosses(edge)) continue;
    const key = `${groupOf(edge.from)}\u0001${edge.to}`;
    outOf.set(key, [...(outOf.get(key) ?? []), edge]);
  }
  for (const [key, list] of outOf) {
    if (list.length < 2) continue;
    const [group = "", to = ""] = key.split("\u0001");
    const id = hub(`hub-out\u0000${key}`, group, list.length, `${list.length} declarations in ${group.slice("group:".length)} are used by ${name(to)}`);
    edges.push({ from: id, to, kind: list[0]?.kind ?? "affected", title: `${list.length} in ${group.slice("group:".length)} → ${name(to)}` });
    for (const edge of list) {
      edges.push({ ...edge, to: id });
      bundled.add(edge);
    }
  }
  return { nodes: [...graph.nodes, ...hubs], edges: [...graph.edges.filter((edge) => !bundled.has(edge)), ...edges], groups: graph.groups };
}

// ---------------------------------------------------------------------------
// 2. Reach flow: declarations to what they can now reach.

/**
 * Each new reach (declarations that reach a capability they didn't): the
 * chains of declarations that lead to it, then the package or global that
 * gives it, then the capability. Steps the changes added are green. At most
 * 6 chains per way, the rest counted.
 */
export function reachFlowGraph(data: ScannedGraph, files: Array<GraphFile>): Graph {
  const ids: Array<string> = [];
  const edges: Array<GraphEdge> = [];
  const extra: Array<GraphNode> = [];
  const addEdge = (edge: GraphEdge) => {
    const known = edges.find((other) => other.from === edge.from && other.to === edge.to);
    if (known === undefined) edges.push(edge);
    else if (edge.kind === "new") known.kind = "new";
  };
  for (const flow of data.reach) {
    const target = data.targets[flow.target];
    const name = target?.label ?? flow.target;
    if (!extra.some((node) => node.id === flow.target)) {
      extra.push({ id: flow.target, label: name, note: target?.about ?? null, kind: target?.kind ?? "capability", group: null, href: null, title: `Reaches ${name}` });
    }
    ids.push(flow.origin);
    addEdge({ from: flow.origin, to: flow.target, kind: "old", title: `${label(data, flow.origin)} is ${name}` });
    for (const chain of flow.chains) {
      chain.forEach((step, index) => {
        ids.push(step.id);
        const to = chain[index + 1]?.id ?? flow.origin;
        if (to !== step.id) addEdge({ from: step.id, to, kind: step.isNew ? "new" : "old", title: `${label(data, step.id)} ${step.isNew ? "newly " : ""}uses ${label(data, to)}` });
      });
    }
    if (flow.count > flow.chains.length) {
      const id = `more:${flow.target}\0${flow.origin}`;
      extra.push({ id, label: `+${flow.count - flow.chains.length} more declarations`, note: null, kind: "more", group: null, href: null, title: "Reach it the same way" });
      addEdge({ from: id, to: flow.origin, kind: "old", title: `${flow.count - flow.chains.length} more declarations reach ${name} this way` });
    }
  }
  const graph = graphOf(data, files, ids, []);
  graph.nodes.push(...extra);
  graph.edges = edges;
  return graph;
}

// ---------------------------------------------------------------------------
// 3. Neighbors: one declaration, what it uses that changed, and what uses it.

export type Neighbors = {
  /** What it uses that's new, changed, or uses what changed. */
  uses: Array<{ name: string; status: UsedChange["status"] }>;
  /** What uses it, anywhere: its label, the file when that's another, and its status. Null: not known (yet). */
  usedBy: Array<{ label: string; path: string | null; status: string }> | null;
};

export function neighborsOf(file: AnalyzedFile, declaration: AnalyzedDeclaration, data: ScannedGraph | null): Neighbors {
  const uses = [...new Map(declaration.uses.map((use) => [use.name, use])).values()].map((use) => ({ name: use.name, status: use.status }));
  const line = declaration.after?.startLine;
  const id = data === null ? undefined : data.seeds.find((seed) => data.declarations[seed]?.path === file.path && data.declarations[seed]?.line === line);
  if (data === null || id === undefined) return { uses, usedBy: data === null ? null : [] };
  const usedBy = (data.users[id] ?? []).flatMap((user) => {
    const found = data.declarations[user];
    return found === undefined ? [] : [{ label: found.label, path: found.path === file.path ? null : found.path, status: found.status }];
  });
  return { uses, usedBy };
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
