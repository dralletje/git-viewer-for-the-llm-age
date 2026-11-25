import { readBlobs, type Repository } from "@room/git";
import { analyzeSource, compareDeclarations, languageForPath } from "@room/syntax";
import { allCapabilities } from "#/capabilities.ts";
import { declarationGraph, type DeclarationGraph } from "#/declaration-graph.ts";
import { pointOfDeclaration } from "#/points.ts";
import { readPoints } from "#/points.server.ts";
import { scanRepository, type RepositoryScan } from "#/reach.server.ts";
import { ignoredBy, readIgnoreRules } from "#/rules.server.ts";
import { reachOf, tagOfOutside, type How } from "#/targets.ts";

/**
 * A declaration (or something outside the code: a package, a global) as the
 * graphs show it. `line`: where it starts in its file's new version (old,
 * for a removed one): what finds it on the page.
 * - changed, added: its own code that runs is different or new.
 * - affected: its code is the same, but uses code that is (through any number of declarations and files).
 * - removed: only in the old version.
 * - outside: a package or global.
 * `tag`: the point it's in (see points.ts), or for a package or global, the
 * point or capability it gives.
 */
export type GraphDeclaration = {
  id: string;
  path: string;
  label: string;
  line: number;
  status: "changed" | "added" | "affected" | "removed" | "unchanged" | "outside";
  tag: string | null;
  exported: boolean;
};

/**
 * What code can reach: one of the repository's points (see points.ts), or a
 * capability (network, database, ...). A point takes over: what's reached
 * through a point's code, or a package it names, is that point only, not
 * the capabilities its code uses in turn.
 */
export type Target = { key: string; label: string; kind: "point" | "capability"; about: string | null };

export type ChangesGraph =
  | {
      status: "scanned";
      declarations: Record<string, GraphDeclaration>;
      targets: Record<string, Target>;
      /** What's wrong with the repository's `.room.toml`, if anything. */
      problems: Array<string>;
      /** The declarations whose own code that runs changed, was added, or is affected within its file. */
      seeds: Array<string>;
      /** From what changed to what uses it, through the whole repository, nearest first: `from` is used by `to`. */
      ripple: { edges: Array<{ from: string; to: string }>; affected: number; shown: number };
      /** Uses across files (and of packages) that a change added or removed, and the ones between two changed declarations. */
      links: Array<{ from: string; to: string; status: "added" | "removed" | "kept" }>;
      /**
       * For each declaration in `declarations`: the points it reaches, each
       * with the next declaration on the way (null: it's the point's own,
       * or uses a package the point names) and the whole way, the origin last.
       */
      pointReach: Record<string, Array<{ target: string; next: string | null; way: Array<string> }>>;
      /** The repository's packages (each folder with a package.json, "" the root), for a box per app or package. */
      packages: Array<{ dir: string; name: string | null }>;
    }
  | { status: "too-large"; sourceFiles: number }
  | { status: "failed"; message: string };

const maxRipple = 150;

/** Each scan's declaration graph, built once: the scans are kept (see reach.server.ts), and so is this, beside them. */
const graphs = new WeakMap<object, DeclarationGraph>();
function graphOf(scan: Extract<RepositoryScan, { status: "scanned" }>): DeclarationGraph {
  const kept = graphs.get(scan);
  if (kept !== undefined) return kept;
  const graph = declarationGraph([...scan.files.values()], scan.resolve);
  graphs.set(scan, graph);
  return graph;
}

/**
 * The declarations a change touches, and how far that goes: `head` against
 * `base` (commits or trees; null: nothing before), `paths` the changed
 * files. Only what runs counts: changes to types, comments or formatting
 * aren't changes. Coarse: a declaration that uses one that changed is
 * affected, whatever it does with it. Tests and stories are left out. Never
 * throws: a scan that fails says so.
 */
export async function changesGraph(repository: Repository, change: { head: string; base: string | null; paths: Array<string> }): Promise<ChangesGraph> {
  try {
    const [after, before, { points, problems: pointProblems }, { rules, problems: ruleProblems }] = await Promise.all([
      scanRepository(repository, change.head),
      change.base === null ? null : scanRepository(repository, change.base),
      readPoints(repository),
      readIgnoreRules(repository),
    ]);
    // What's wrong in .room.toml, once: a file that doesn't parse says so for both.
    const problems = [...new Set([...pointProblems, ...ruleProblems])];
    if (after.status === "too-large") return after;
    if (before?.status === "too-large") return before;
    const now = graphOf(after);
    const then = before === null ? null : graphOf(before);
    const setAside = (id: string) => ignoredBy([now.declarations.get(id)?.path ?? then?.declarations.get(id)?.path ?? ""], rules) !== null;

    // What changed, declaration by declaration: each changed file's versions compared.
    const status = new Map<string, "changed" | "added" | "affected">();
    const removed = new Set<string>();
    const changedPaths = change.paths.filter((path) => languageForPath(path) !== null);
    const blobIds = changedPaths.flatMap((path) => [after.blobs.get(path), before?.blobs.get(path)].filter((blob) => blob !== undefined));
    const contents = await readBlobs(repository, blobIds);
    for (const path of changedPaths) {
      const language = languageForPath(path);
      if (language === null) continue;
      const newBlob = after.blobs.get(path);
      const oldBlob = before?.blobs.get(path);
      const newSource = newBlob === undefined ? "" : (contents.get(newBlob) ?? "");
      const oldSource = oldBlob === undefined ? "" : (contents.get(oldBlob) ?? "");
      const [oldAnalysis, newAnalysis] = await Promise.all([analyzeSource(language, oldSource, { highlight: false }), analyzeSource(language, newSource, { highlight: false })]);
      const changes = compareDeclarations(oldAnalysis.topLevel, newAnalysis.topLevel, oldSource.split("\n"), newSource.split("\n"));
      const newUnits = after.files.get(path)?.module?.units ?? [];
      const oldUnits = before?.files.get(path)?.module?.units ?? [];
      for (const declaration of changes) {
        if (declaration.status === "changed" || declaration.status === "added" || declaration.status === "affected") {
          const index = newUnits.findIndex((unit) => unit.startLine === declaration.after?.startLine);
          const id = now.unitIds.get(path)?.[index];
          if (id !== undefined && status.get(id) !== "changed") status.set(id, declaration.status);
        }
        if (declaration.status === "removed" && then !== null) {
          const index = oldUnits.findIndex((unit) => unit.startLine === declaration.before?.startLine);
          const id = then.unitIds.get(path)?.[index];
          if (id !== undefined && !now.declarations.has(id)) removed.add(id);
        }
      }
    }
    const seeds = [...status.keys()].filter((id) => !setAside(id));

    // The ripple: from what changed to what uses it, nearest first.
    const distance = new Map<string, number>(seeds.map((id) => [id, 0]));
    const queue = [...seeds];
    for (let next = 0; next < queue.length; next++) {
      const id = queue[next] ?? "";
      for (const user of now.usedBy.get(id) ?? []) {
        if (distance.has(user) || setAside(user)) continue;
        distance.set(user, (distance.get(id) ?? 0) + 1);
        queue.push(user);
      }
    }
    const reached = queue.filter((id) => !status.has(id));
    const shown = new Set([...seeds, ...reached.slice(0, maxRipple)]);
    const rippleEdges: Array<{ from: string; to: string }> = [];
    for (const id of shown) {
      for (const used of now.uses.get(id) ?? []) if (shown.has(used)) rippleEdges.push({ from: used, to: id });
    }
    // Uses across files (and of packages) that the change added or removed.
    const crossing = (graph: DeclarationGraph, id: string): Array<string> => {
      const path = graph.declarations.get(id)?.path;
      return [...[...(graph.uses.get(id) ?? [])].filter((used) => graph.declarations.get(used)?.path !== path), ...(graph.outside.get(id)?.keys() ?? [])];
    };
    const touched = new Set(change.paths);
    const linksOf = (graph: DeclarationGraph | null) => {
      const links = new Set<string>();
      if (graph === null) return links;
      for (const [id, declaration] of graph.declarations) {
        if (ignoredBy([declaration.path], rules) !== null) continue;
        for (const used of crossing(graph, id)) {
          const usedPath = graph.declarations.get(used)?.path;
          if (!touched.has(declaration.path) && (usedPath === undefined || !touched.has(usedPath))) continue;
          if (usedPath !== undefined && ignoredBy([usedPath], rules) !== null) continue;
          links.add(`${id}\u0001${used}`);
        }
      }
      return links;
    };
    const linksNow = linksOf(now);
    const linksThen = linksOf(then);
    const changedOrNew = new Set(seeds);
    const links: Array<{ from: string; to: string; status: "added" | "removed" | "kept" }> = [];
    for (const link of linksNow) {
      const [from = "", to = ""] = link.split("\u0001");
      if (!linksThen.has(link)) links.push({ from, to, status: "added" });
      else if (changedOrNew.has(from) && (changedOrNew.has(to) || to.startsWith("outside\0"))) links.push({ from, to, status: "kept" });
    }
    for (const link of linksThen) {
      const [from = "", to = ""] = link.split("\u0001");
      if (!linksNow.has(link)) links.push({ from, to, status: "removed" });
    }

    // The targets: the repository's points, then the capabilities.
    const targets: Record<string, Target> = {};
    for (const point of points) targets[`point:${point.name}`] = { key: `point:${point.name}`, label: point.name, kind: "point", about: point.about };
    for (const capability of allCapabilities) targets[`capability:${capability}`] = { key: `capability:${capability}`, label: capability, kind: "capability", about: null };
    const reachNow = reachOf(now, points);

    /** From a declaration to its target's origin, the origin left out. */
    const chainOf = (id: string, target: string): Array<{ id: string; isNew: boolean }> => {
      const chain: Array<{ id: string; isNew: boolean }> = [];
      for (let step: string | null = id; step !== null; ) {
        const how: How | undefined = reachNow.get(step)?.get(target);
        if (how === undefined || step === how.origin) break;
        const isNew = how.next === how.origin && how.origin.startsWith("outside\0") ? !(then?.outside.get(step)?.has(how.origin) ?? false) : !(then?.uses.get(step)?.has(how.next) ?? false);
        chain.push({ id: step, isNew });
        step = how.next === how.origin ? null : how.next;
      }
      return chain;
    };

    // Every declaration mentioned, as the page shows it.
    const declarations: Record<string, GraphDeclaration> = {};
    const describe = (id: string) => {
      if (declarations[id] !== undefined) return;
      const outside = findOutside(now, id) ?? (then === null ? undefined : findOutside(then, id));
      if (outside !== undefined) {
        declarations[id] = { id, path: "", label: outside.label, line: 0, status: "outside", tag: tagOfOutside(outside.id, outside.capability, points), exported: false };
        return;
      }
      const current = now.declarations.get(id);
      const old = then?.declarations.get(id);
      const declaration = current ?? old;
      if (declaration === undefined) return;
      const point = pointOfDeclaration(points, declaration.path, declaration.label);
      declarations[id] = {
        id,
        path: declaration.path,
        label: declaration.label,
        line: declaration.startLine,
        status: current === undefined || removed.has(id) ? "removed" : (status.get(id) ?? (distance.has(id) ? "affected" : "unchanged")),
        tag: point === null ? null : `point:${point}`,
        exported: declaration.exported,
      };
    };
    for (const id of seeds) describe(id);
    for (const edge of rippleEdges) [edge.from, edge.to].forEach(describe);
    for (const link of links) [link.from, link.to].forEach(describe);

    // The points each one reaches, for the graphs to draw.
    const pointReach: Record<string, Array<{ target: string; next: string | null; way: Array<string> }>> = {};
    for (const id of Object.keys(declarations)) {
      const entries = [...(reachNow.get(id) ?? [])]
        .filter(([target]) => target.startsWith("point:"))
        .map(([target, how]) => ({
          target,
          next: how.next === id || how.next === how.origin ? null : how.next,
          way: how.origin === id ? [] : [...chainOf(id, target).slice(1).map((step) => step.id), how.origin],
        }));
      if (entries.length > 0) pointReach[id] = entries;
    }
    for (const entry of Object.values(pointReach)) for (const point of entry) point.way.forEach(describe);

    return {
      status: "scanned",
      declarations,
      targets,
      problems,
      seeds,
      ripple: { edges: rippleEdges, affected: reached.length, shown: Math.min(reached.length, maxRipple) },
      links,
      pointReach,
      packages: after.packages,
    };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function findOutside(graph: DeclarationGraph, id: string) {
  if (!id.startsWith("outside\0")) return undefined;
  for (const outside of graph.outside.values()) {
    const found = outside.get(id);
    if (found !== undefined) return found;
  }
  return undefined;
}

