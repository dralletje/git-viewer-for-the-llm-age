import type { GraphDeclaration } from "#/graph.server.ts";
import type { Graph, GraphEdge, GraphFile, GraphGroup, GraphNode, ScannedGraph } from "#/graphs.ts";

/**
 * "Structure only": the shape of a change. Only the uses between files (and
 * of packages) that the change added or removed, their two ends, and the
 * declarations it added or removed; nothing of the unchanged ripple. With
 * `kept`, also the uses that stayed between two changed declarations.
 *
 * graphOf, splitOutside, nodeOf and the app boxes are copied from graphs.ts
 * (not exported there, and appBoxesGraph is built on the whole ripple).
 */

type Link = ScannedGraph["links"][number];

/** Something notable about a use, said beside it in the summary. */
export type StructureFlag =
  /** A use from one app or package into another, and nothing on the graph used that one from this one before. */
  | { kind: "new-dependency"; from: string; to: string }
  /** A package this app or package didn't use before, as far as the graph sees. */
  | { kind: "new-package"; package: string; app: string }
  /** A use that went away, and nothing on the graph uses what it used anymore: maybe left unused. */
  | { kind: "now-unused" }
  /** A use that went away because what it used was removed. */
  | { kind: "removed-with-it" };

export type StructureUse = {
  /** The user and what it uses (`used`), as in the data's links. */
  user: string;
  used: string;
  status: Link["status"];
  flags: Array<StructureFlag>;
};

/** One file on the user side: its uses that changed, and the declarations added or removed in it. */
export type StructureFile = {
  path: string;
  /** Its app or package's folder (see `packageOf`), null: in none. */
  app: string | null;
  uses: Array<StructureUse>;
  added: Array<string>;
  removed: Array<string>;
};

/** An app or package's folder: the nearest package.json above the file, the repository's root one aside. Null: none. */
export function packageOf(data: ScannedGraph, path: string): string | null {
  let found: string | null = null;
  for (const entry of data.packages) {
    if (entry.dir === "" || !path.startsWith(`${entry.dir}/`)) continue;
    if (found === null || entry.dir.length > found.length) found = entry.dir;
  }
  return found;
}

/** The package a use of something outside the code is a use of ("zod", "@medplum/core"); null: a global, not a package. */
export function packageOfOutside(id: string): string | null {
  const [, source = ""] = id.split("\0");
  if (!id.startsWith("outside\0") || source === "global") return null;
  return source;
}

/** Whether the structure changed at all: a use added or removed, or a declaration. */
export function structureChanged(data: ScannedGraph): boolean {
  if (data.links.some((link) => link.status !== "kept")) return true;
  return Object.values(data.declarations).some((declaration) => declaration.status === "added" || declaration.status === "removed");
}

/** The links the view shows: the added and removed ones, and with `kept` the kept ones. */
function shownLinks(data: ScannedGraph, kept: boolean): Array<Link> {
  return data.links.filter((link) => link.status !== "kept" || kept);
}

/** The declarations the change added or removed (not a package or global). */
function addedOrRemoved(data: ScannedGraph): Array<GraphDeclaration> {
  return Object.values(data.declarations).filter((declaration) => declaration.path !== "" && (declaration.status === "added" || declaration.status === "removed"));
}

/**
 * What's notable about each use, from what the graph knows: only uses that
 * touch a changed file are in it, so "before" means "anywhere on this
 * page's graph", not the whole repository.
 */
export function flagsOf(data: ScannedGraph, link: Link): Array<StructureFlag> {
  const user = data.declarations[link.from];
  const used = data.declarations[link.to];
  if (user === undefined || used === undefined) return [];
  const flags: Array<StructureFlag> = [];
  const userApp = packageOf(data, user.path);
  const appOfId = (id: string) => {
    const declaration = data.declarations[id];
    return declaration === undefined || declaration.path === "" ? undefined : packageOf(data, declaration.path);
  };

  if (link.status === "added" && used.status !== "outside") {
    const usedApp = packageOf(data, used.path);
    if (userApp !== usedApp) {
      // Used before: a kept or removed use between the two, or an unchanged use the ripple follows (it isn't an added one).
      const added = new Set(data.links.filter((other) => other.status === "added").map((other) => `${other.from}\u0001${other.to}`));
      const before =
        data.links.some((other) => other.status !== "added" && appOfId(other.from) === userApp && appOfId(other.to) === usedApp) ||
        data.ripple.edges.some((edge) => !added.has(`${edge.to}\u0001${edge.from}`) && appOfId(edge.to) === userApp && appOfId(edge.from) === usedApp);
      if (!before) flags.push({ kind: "new-dependency", from: userApp ?? "", to: usedApp ?? "" });
    }
  }

  if (link.status === "added" && used.status === "outside") {
    const name = packageOfOutside(used.id);
    if (name !== null) {
      const before = data.links.some((other) => other.status !== "added" && packageOfOutside(other.to) === name && appOfId(other.from) === userApp);
      if (!before) flags.push({ kind: "new-package", package: name, app: userApp ?? "" });
    }
  }

  if (link.status === "removed") {
    if (used.status === "removed") {
      flags.push({ kind: "removed-with-it" });
    } else if (used.status === "outside") {
      const name = packageOfOutside(used.id);
      const stillUsed = name !== null && data.links.some((other) => other.status !== "removed" && packageOfOutside(other.to) === name);
      if (name !== null && !stillUsed) flags.push({ kind: "now-unused" });
    } else {
      // Still used: a use that's new or kept, or any use the ripple follows (all of those are as the code is now).
      const stillUsed = data.links.some((other) => other.status !== "removed" && other.to === used.id) || data.ripple.edges.some((edge) => edge.from === used.id);
      if (!stillUsed) flags.push({ kind: "now-unused" });
    }
  }
  return flags;
}

/**
 * The summary over the drawing: per file on the user side (by path), what
 * its declarations now use and no longer use (new first, then gone, then
 * kept), and the declarations added and removed in it.
 */
export function structureSummary(data: ScannedGraph, options: { kept: boolean }): Array<StructureFile> {
  const files = new Map<string, StructureFile>();
  const fileOf = (path: string) => {
    const known = files.get(path);
    if (known !== undefined) return known;
    const file: StructureFile = { path, app: packageOf(data, path), uses: [], added: [], removed: [] };
    files.set(path, file);
    return file;
  };
  const order = { added: 0, removed: 1, kept: 2 };
  const links = shownLinks(data, options.kept).sort((a, b) => order[a.status] - order[b.status]);
  for (const link of links) {
    const user = data.declarations[link.from];
    if (user === undefined || user.path === "") continue;
    fileOf(user.path).uses.push({ user: link.from, used: link.to, status: link.status, flags: flagsOf(data, link) });
  }
  for (const declaration of addedOrRemoved(data).sort((a, b) => a.line - b.line)) {
    const file = fileOf(declaration.path);
    if (declaration.status === "added") file.added.push(declaration.id);
    else file.removed.push(declaration.id);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The drawing: every use the summary has, an arrow from what's used to what
 * uses it (as on Ripple: new green, gone red and dashed, kept grey), their
 * ends, and the declarations added or removed. In a box per file, in a box
 * per app or package; a use from one app into another is drawn thicker.
 */
export function structureGraph(data: ScannedGraph, files: Array<GraphFile>, options: { kept: boolean }): Graph {
  const links = shownLinks(data, options.kept);
  const edges: Array<GraphEdge> = links.map((link) => ({
    from: link.to,
    to: link.from,
    kind: link.status,
    title: `${label(data, link.from)} ${link.status === "added" ? "now uses" : link.status === "removed" ? "no longer uses" : "uses"} ${label(data, link.to)}`,
  }));
  const ids = [...links.flatMap((link) => [link.from, link.to]), ...addedOrRemoved(data).map((declaration) => declaration.id)];
  return inAppBoxes(data, graphOf(data, files, ids, edges));
}

const label = (data: ScannedGraph, id: string) => data.declarations[id]?.label ?? id;

/** Where a declaration is on the page, as the drawing links to it ("#file-3--name"); null: not on it (a package, a removed one in no file shown). */
export function hrefOfDeclaration(files: Array<GraphFile>, declaration: GraphDeclaration): string | null {
  if (declaration.path === "") return null;
  const file = files.find((candidate) => candidate.path === declaration.path);
  return file === undefined ? null : `${file.href}--${encodeURIComponent(declaration.label)}`;
}

// ---------------------------------------------------------------------------
// Copied from graphs.ts (not exported there).

function graphOf(data: ScannedGraph, files: Array<GraphFile>, ids: Iterable<string>, edges: Array<GraphEdge>): Graph {
  const hrefOf = new Map(files.map(({ path, href }) => [path, href]));
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

/** A package used from several files gets a node in each file's box: one shared node would pull every arrow across the drawing. */
function splitOutside(graph: Graph): Graph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outside = new Set(graph.nodes.filter((node) => node.kind === "external").map((node) => node.id));
  const copies = new Map<string, GraphNode>();
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

/** The file boxes in a box per app or package, as appBoxesGraph does for Ripple. */
function inAppBoxes(data: ScannedGraph, graph: Graph): Graph {
  const byDir = new Map(data.packages.map((entry) => [entry.dir, entry]));
  const used = new Map<string, { dir: string; name: string | null }>();
  const fileGroups: Array<GraphGroup> = graph.groups.map((group) => {
    const path = group.id.slice("group:".length);
    const dir = packageOf(data, path);
    const found = dir === null ? undefined : byDir.get(dir);
    if (found === undefined) return group;
    used.set(found.dir, found);
    // Within its box, a file's path from the package's folder.
    return { ...group, label: path.slice(found.dir.length + 1), parent: `package:${found.dir}` };
  });
  const packageGroups = [...used.values()]
    .sort((a, b) => a.dir.localeCompare(b.dir))
    .map((entry) => ({ id: `package:${entry.dir}`, label: entry.name === null || entry.name === entry.dir ? entry.dir : `${entry.dir} · ${entry.name}` }));
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
