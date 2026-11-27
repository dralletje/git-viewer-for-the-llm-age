import type { GraphDeclaration } from "#/graph.server.ts";
import type { Graph, GraphEdge, GraphFile, GraphGroup, GraphNode, ScannedGraph } from "#/graphs.ts";

/**
 * "Zoom to summarise": the declaration graph opened level by level. At
 * first a node per app or package; opening one shows its folders, a folder
 * its files, a file its declarations. Every use is drawn between the most
 * opened ends there are, so a large change stays a handful of nodes until
 * the reader asks for more.
 */

/**
 * One thing that can be a node: an app or package ("package:<dir>", "package:"
 * for files in none), a folder ("folder:<package dir>\0<folder>"), a file
 * ("file:<path>"), the packages and globals the code uses ("outside:"), or a
 * declaration (its own id). `declarations`: every declaration in it.
 */
export type ZoomUnit = {
  id: string;
  kind: "package" | "folder" | "file" | "outside" | "declaration";
  label: string;
  /** On hover: the whole path or name. */
  title: string;
  parent: string | null;
  children: Array<string>;
  declarations: Array<string>;
};

export type ZoomTree = {
  units: Map<string, ZoomUnit>;
  /** The packages (and the outside), the first view. */
  roots: Array<string>;
  /** Each declaration's units, the package first, the declaration itself last. */
  chains: Map<string, Array<string>>;
};

/** The declarations the graph draws: the changes, the ripple, the ends of the added and removed uses (as `unchangedFiles`). */
function drawnDeclarations(data: ScannedGraph): Array<GraphDeclaration> {
  const ids = new Set([...data.seeds, ...data.ripple.edges.flatMap((edge) => [edge.from, edge.to]), ...data.links.flatMap((link) => [link.from, link.to])]);
  return [...ids].flatMap((id) => {
    const declaration = data.declarations[id];
    return declaration === undefined ? [] : [declaration];
  });
}

type Dir = { path: string; dirs: Map<string, Dir>; files: Set<string> };

/**
 * The units of the drawn declarations. A package is the nearest
 * package.json's folder above a file (the root one aside, as
 * `appBoxesGraph`); files in none are under "(root)". A folder that only
 * leads to one other folder is passed through ("src/domain"): opening it
 * would only show one node again. For the same reason a package whose code
 * is all in one folder shows that folder's contents when opened.
 */
export function zoomTree(data: ScannedGraph): ZoomTree {
  const units = new Map<string, ZoomUnit>();
  const chains = new Map<string, Array<string>>();
  // The deepest package first: a file is in the nearest one above it.
  const packages = data.packages.filter((entry) => entry.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (path: string) => packages.find((entry) => path.startsWith(`${entry.dir}/`)) ?? null;

  const declarations = drawnDeclarations(data);
  const outside = declarations.filter((declaration) => declaration.status === "outside" || declaration.path === "");
  const inFiles = declarations.filter((declaration) => !(declaration.status === "outside" || declaration.path === ""));

  // Per package, its folders as a tree, and each file's declarations.
  const trees = new Map<string, { name: string | null; root: Dir }>();
  const byFile = new Map<string, Array<GraphDeclaration>>();
  for (const declaration of inFiles) {
    const found = packageOf(declaration.path);
    const dir = found?.dir ?? "";
    const tree = trees.get(dir) ?? { name: found?.name ?? null, root: { path: "", dirs: new Map(), files: new Set() } };
    trees.set(dir, tree);
    const inPackage = dir === "" ? declaration.path : declaration.path.slice(dir.length + 1);
    const parts = inPackage.split("/");
    let at = tree.root;
    for (const part of parts.slice(0, -1)) {
      const path = at.path === "" ? part : `${at.path}/${part}`;
      const next = at.dirs.get(part) ?? { path, dirs: new Map(), files: new Set() };
      at.dirs.set(part, next);
      at = next;
    }
    at.files.add(declaration.path);
    byFile.set(declaration.path, [...(byFile.get(declaration.path) ?? []), declaration]);
  }

  /** Past folders that hold nothing but one other folder. */
  const through = (dir: Dir): Dir => {
    let at = dir;
    while (at.files.size === 0 && at.dirs.size === 1) at = [...at.dirs.values()][0] ?? at;
    return at;
  };
  const add = (unit: ZoomUnit) => {
    units.set(unit.id, unit);
    if (unit.parent !== null) units.get(unit.parent)?.children.push(unit.id);
  };
  const fill = (parent: string, packageDir: string, dir: Dir) => {
    const prefix = packageDir === "" ? "" : `${packageDir}/`;
    for (const sub of [...dir.dirs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const shown = through(sub);
      const id = `folder:${packageDir}\0${shown.path}`;
      // Named from the folder it's in: "domain/billing" in "src".
      const label = dir.path === "" ? shown.path : shown.path.slice(dir.path.length + 1);
      add({ id, kind: "folder", label: `${label}/`, title: `${prefix}${shown.path}/`, parent, children: [], declarations: [] });
      fill(id, packageDir, shown);
    }
    for (const path of [...dir.files].sort((a, b) => a.localeCompare(b))) {
      const id = `file:${path}`;
      add({ id, kind: "file", label: path.split("/").at(-1) ?? path, title: path, parent, children: [], declarations: [] });
      for (const declaration of (byFile.get(path) ?? []).sort((a, b) => a.line - b.line)) {
        add({ id: declaration.id, kind: "declaration", label: declaration.label, title: `${declaration.label} in ${path}`, parent: id, children: [], declarations: [] });
      }
    }
  };

  // The packages by folder, the files in none last.
  const roots: Array<string> = [];
  for (const [dir, tree] of [...trees].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))) {
    const id = `package:${dir}`;
    const label = dir === "" ? "(root)" : tree.name === null || tree.name === dir ? dir : tree.name;
    add({ id, kind: "package", label, title: dir === "" ? "Files in no app or package" : tree.name === null ? dir : `${tree.name} (${dir})`, parent: null, children: [], declarations: [] });
    roots.push(id);
    fill(id, dir, through(tree.root));
  }
  if (outside.length > 0) {
    add({ id: "outside:", kind: "outside", label: "packages and globals", title: "Packages and globals the code uses", parent: null, children: [], declarations: [] });
    roots.push("outside:");
    for (const declaration of outside.sort((a, b) => a.label.localeCompare(b.label))) {
      add({ id: declaration.id, kind: "declaration", label: declaration.label, title: declaration.label, parent: "outside:", children: [], declarations: [] });
    }
  }

  // Each declaration's way down, and every unit's declarations.
  for (const unit of units.values()) {
    if (unit.kind !== "declaration") continue;
    const chain: Array<string> = [];
    for (let at: string | null = unit.id; at !== null; at = units.get(at)?.parent ?? null) chain.unshift(at);
    chains.set(unit.id, chain);
    for (const id of chain) units.get(id)?.declarations.push(unit.id);
  }
  return { units, roots, chains };
}

/** What the first view opens: a lone package (and a lone thing in it, and so on): one node says nothing. */
export function initialExpanded(tree: ZoomTree): Set<string> {
  const expanded = new Set<string>();
  let level = tree.roots;
  while (level.length === 1) {
    const only = tree.units.get(level[0] ?? "");
    if (only === undefined || only.kind === "file" || only.children.length === 0) break;
    expanded.add(only.id);
    level = only.children;
  }
  return expanded;
}

/** Everything open, down to the declarations. */
export function expandAll(tree: ZoomTree): Set<string> {
  return new Set([...tree.units.values()].filter((unit) => unit.kind !== "declaration" && unit.children.length > 0).map((unit) => unit.id));
}

/** A unit and the units opened in it closed: opening it again starts from its first level. */
export function collapse(tree: ZoomTree, expanded: Set<string>, id: string): Set<string> {
  const next = new Set(expanded);
  const queue = [id];
  for (let index = 0; index < queue.length; index++) {
    const at = queue[index] ?? "";
    next.delete(at);
    queue.push(...(tree.units.get(at)?.children ?? []));
  }
  return next;
}

/**
 * An edge as the zoom view draws it: `count` uses between declarations in
 * its two ends, `examples` the first few, for hovering. Kind: "added" or
 * "removed" (a use the change made or took away), else "changed" (some of
 * what's used changed) or "affected".
 */
export type ZoomEdge = GraphEdge & { count: number };

export type ZoomGraph = Omit<Graph, "edges"> & { edges: Array<ZoomEdge> };

const changedStatuses = new Set(["changed", "added", "removed"]);

/**
 * The graph with `expanded` open: an open unit is a box around what's in
 * it, the rest are nodes. Each use between two declarations is drawn
 * between the nodes they're in, and the uses with the same ends and kind
 * are one edge, `count` of them. A use inside one node isn't drawn.
 */
export function zoomGraph(data: ScannedGraph, tree: ZoomTree, expanded: Set<string>, files: Array<GraphFile>): ZoomGraph {
  const hrefOf = new Map(files.map(({ path, href }) => [path, href]));
  const nodes: Array<GraphNode> = [];
  const groups: Array<GraphGroup> = [];

  const visit = (id: string) => {
    const unit = tree.units.get(id);
    if (unit === undefined) return;
    const parent = unit.parent ?? undefined;
    if (unit.kind !== "declaration" && expanded.has(id) && unit.children.length > 0) {
      groups.push({ id, label: unit.label, ...(parent === undefined ? {} : { parent }) });
      unit.children.forEach(visit);
      return;
    }
    nodes.push(nodeOfUnit(data, tree, unit, hrefOf));
  };
  tree.roots.forEach(visit);

  /** The node a declaration is drawn in: its first unit that isn't open. */
  const shownIn = (declaration: string): string | null => {
    const chain = tree.chains.get(declaration);
    if (chain === undefined) return null;
    return chain.find((id) => !expanded.has(id)) ?? declaration;
  };

  // Every use, from what's used to what uses it, as Ripple (see combinedGraph).
  const uses = new Map<string, { from: string; to: string; kind: "uses" | "added" | "removed" }>();
  for (const edge of data.ripple.edges) uses.set(`${edge.from}\u0001${edge.to}`, { from: edge.from, to: edge.to, kind: "uses" });
  for (const link of data.links) {
    const key = `${link.to}\u0001${link.from}`;
    if (link.status === "kept" && uses.has(key)) continue;
    uses.set(key, { from: link.to, to: link.from, kind: link.status === "kept" ? "uses" : link.status });
  }

  const label = (id: string) => data.declarations[id]?.label ?? id;
  const merged = new Map<string, { from: string; to: string; kind: string; count: number; examples: Array<string>; changed: boolean }>();
  for (const use of uses.values()) {
    const from = shownIn(use.from);
    const to = shownIn(use.to);
    if (from === null || to === null || from === to) continue;
    const key = `${from}\u0001${to}\u0001${use.kind}`;
    const entry = merged.get(key) ?? { from, to, kind: use.kind, count: 0, examples: [], changed: false };
    entry.count += 1;
    if (entry.examples.length < 6) entry.examples.push(`${label(use.to)} ${use.kind === "added" ? "now uses" : use.kind === "removed" ? "no longer uses" : "uses"} ${label(use.from)}`);
    if (changedStatuses.has(data.declarations[use.from]?.status ?? "")) entry.changed = true;
    merged.set(key, entry);
  }
  const unitLabel = (id: string) => tree.units.get(id)?.title ?? id;
  const edges: Array<ZoomEdge> = [...merged.values()].map((entry) => {
    const kind = entry.kind === "uses" ? (entry.changed ? "changed" : "affected") : entry.kind;
    const what = entry.kind === "added" ? "new uses" : entry.kind === "removed" ? "uses that went away" : "uses";
    const more = entry.count > entry.examples.length ? `\n… and ${entry.count - entry.examples.length} more` : "";
    return {
      from: entry.from,
      to: entry.to,
      kind,
      count: entry.count,
      title: `${entry.count} ${entry.count === 1 ? what.replace("uses", "use") : what} of ${unitLabel(entry.from)} in ${unitLabel(entry.to)}:\n${entry.examples.join("\n")}${more}`,
    };
  });
  return { nodes, edges, groups };
}

/** A unit as a node: a declaration as Ripple draws it, anything else named with what's in it. */
function nodeOfUnit(data: ScannedGraph, tree: ZoomTree, unit: ZoomUnit, hrefOf: Map<string, string>): GraphNode {
  if (unit.kind === "declaration") {
    const declaration = data.declarations[unit.id];
    const status = declaration?.status ?? "unchanged";
    const tag = declaration?.tag === null || declaration?.tag === undefined ? null : (data.targets[declaration.tag]?.label ?? null);
    const word = status === "affected" ? "same code" : status === "unchanged" || status === "outside" ? null : status;
    const note = [declaration?.exported === true ? "export" : null, word, tag].filter((part) => part !== null).join(" · ");
    // The declaration itself in its file on the page; the page falls back to the file.
    const fileHref = declaration === undefined ? undefined : hrefOf.get(declaration.path);
    return {
      id: unit.id,
      label: unit.label,
      note: note === "" ? null : note,
      kind: status === "outside" ? "external" : status,
      group: unit.parent,
      href: fileHref === undefined ? null : `${fileHref}--${encodeURIComponent(unit.label)}`,
      title: `${unit.title}${status === "unchanged" || status === "outside" ? "" : `: ${status}`}`,
    };
  }
  const counts = countsOf(data, unit);
  const files = unit.kind === "package" || unit.kind === "folder" ? new Set(unit.declarations.map((id) => data.declarations[id]?.path)).size : 0;
  const parts = [
    counts.changed > 0 ? `${counts.changed} changed` : null,
    counts.affected > 0 ? `${counts.affected} affected` : null,
    counts.other > 0 ? `${counts.other} other` : null,
    files > 1 ? `${files} files` : null,
  ].filter((part) => part !== null);
  const kind = unit.kind === "outside" ? "unit-outside" : counts.changed > 0 ? "unit-changed" : counts.affected > 0 ? "unit-affected" : "unit-unchanged";
  const fileHref = unit.kind === "file" ? hrefOf.get(unit.title) : undefined;
  return {
    id: unit.id,
    label: unit.label,
    note: parts.length === 0 ? null : parts.join(" · "),
    kind,
    group: unit.parent,
    // A file's node opens it; its code is linked from its box once open.
    href: fileHref ?? null,
    title: `${unit.title}: ${parts.join(", ")}. Click to open.`,
  };
}

/** How many of a unit's declarations changed (or are new or removed), are affected, or neither (an end of a use). */
export function countsOf(data: ScannedGraph, unit: ZoomUnit): { changed: number; affected: number; other: number } {
  const counts = { changed: 0, affected: 0, other: 0 };
  for (const id of unit.declarations) {
    const status = data.declarations[id]?.status ?? "unchanged";
    if (changedStatuses.has(status)) counts.changed += 1;
    else if (status === "affected") counts.affected += 1;
    else counts.other += 1;
  }
  return counts;
}
