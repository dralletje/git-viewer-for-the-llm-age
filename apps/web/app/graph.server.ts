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

/** Declarations that newly reach a target, the same way: through `origin`. */
export type ReachFlow = {
  target: string;
  /** The package or global that gives it, or the declaration of the point. */
  origin: string;
  /**
   * Some of them, each as its chain of declarations to the origin (the
   * origin itself left out); `isNew`: the step to the next one (or to the
   * origin) wasn't there before.
   */
  chains: Array<Array<{ id: string; isNew: boolean }>>;
  count: number;
};

/** Something the changed code calls (uses): it may be called differently now. */
export type CallGroup = {
  /** A package, a global, or a declaration that didn't change itself. */
  callee: string;
  /** The targets it is or reaches (keys), points first. */
  reaches: Array<string>;
  /** The changed or affected declarations that call it, each with the declarations from the change to it (none: it changed itself). */
  callers: Array<{ id: string; through: Array<string> }>;
  count: number;
};

/** A target, and the changed or affected declarations that reach it. */
export type TargetReach = {
  target: string;
  /** Each with the declarations from it to the origin, the origin last (a point's declaration, or the package or global); none: it's one of the point's own. */
  reachedBy: Array<{ id: string; chain: Array<string> }>;
  count: number;
};

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
      reach: Array<ReachFlow>;
      calls: Array<CallGroup>;
      /** Every point, then the capabilities the changes reach: what reaches each. */
      points: Array<TargetReach>;
      /**
       * For each declaration in `declarations`: the points it reaches, each
       * with the next declaration on the way (null: it's the point's own,
       * or uses a package the point names) and the whole way, the origin last.
       */
      pointReach: Record<string, Array<{ target: string; next: string | null; way: Array<string> }>>;
      /** For each changed declaration: what uses it (at most 12). */
      users: Record<string, Array<string>>;
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
    const previous = new Map<string, string>();
    const distance = new Map<string, number>(seeds.map((id) => [id, 0]));
    const queue = [...seeds];
    for (let next = 0; next < queue.length; next++) {
      const id = queue[next] ?? "";
      for (const user of now.usedBy.get(id) ?? []) {
        if (distance.has(user) || setAside(user)) continue;
        distance.set(user, (distance.get(id) ?? 0) + 1);
        previous.set(user, id);
        queue.push(user);
      }
    }
    const reached = queue.filter((id) => !status.has(id));
    const shown = new Set([...seeds, ...reached.slice(0, maxRipple)]);
    const rippleEdges: Array<{ from: string; to: string }> = [];
    for (const id of shown) {
      for (const used of now.uses.get(id) ?? []) if (shown.has(used)) rippleEdges.push({ from: used, to: id });
    }
    /** The declarations from the change to this one, the change first, this one left out. */
    const through = (id: string): Array<string> => {
      const path: Array<string> = [];
      for (let step = previous.get(id); step !== undefined; step = previous.get(step)) path.unshift(step);
      return path;
    };

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
    const reachThen = then === null ? null : reachOf(then, points);
    const order = (key: string) => Object.keys(targets).indexOf(key);

    // New reach: declarations that reach a target now and didn't before.
    const flows = new Map<string, { target: string; origin: string; ids: Array<string> }>();
    for (const [id, theirs] of reachNow) {
      if (setAside(id)) continue;
      // A declaration that's new without being a change (moved, renamed in an unchanged file) can't gain reach.
      if (then !== null && !then.declarations.has(id) && !status.has(id)) continue;
      for (const [target, how] of theirs) {
        if (reachThen?.get(id)?.has(target) === true) continue;
        const key = `${target}\0${how.origin}`;
        const flow = flows.get(key) ?? { target, origin: how.origin, ids: [] };
        flow.ids.push(id);
        flows.set(key, flow);
      }
    }
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
    const reach: Array<ReachFlow> = [...flows.values()]
      .map((flow) => {
        // The changed declarations first, then the nearest.
        const ordered = flow.ids
          .map((id) => ({ id, chain: chainOf(id, flow.target) }))
          .sort((a, b) => Number(status.has(b.id)) - Number(status.has(a.id)) || a.chain.length - b.chain.length || a.id.localeCompare(b.id));
        return { target: flow.target, origin: flow.origin, chains: ordered.slice(0, 6).map((entry) => entry.chain), count: flow.ids.length };
      })
      .sort((a, b) => order(a.target) - order(b.target) || b.count - a.count);

    // Each target, and the changed or affected declarations that reach it.
    const reachers = new Map<string, Array<{ id: string; chain: Array<string> }>>();
    for (const id of queue) {
      for (const [target, how] of reachNow.get(id) ?? []) {
        const list = reachers.get(target) ?? [];
        // A point's own declaration: no way there, it's in it.
        list.push({ id, chain: how.origin === id ? [] : [...chainOf(id, target).slice(1).map((step) => step.id), how.origin] });
        reachers.set(target, list);
      }
    }
    const pointsReached: Array<TargetReach> = Object.keys(targets)
      .filter((key) => targets[key]?.kind === "point" || reachers.has(key))
      .map((key) => {
        const list = (reachers.get(key) ?? []).sort(
          (a, b) => Number(status.has(b.id)) - Number(status.has(a.id)) || a.chain.length - b.chain.length || a.id.localeCompare(b.id),
        );
        return { target: key, reachedBy: list.slice(0, 12), count: list.length };
      });

    // Calls: what the changed and affected code uses, which may now be called
    // differently. Outside the code: by any of them. A declaration of the
    // code that didn't change itself: by a changed or new one.
    const callers = new Set(queue);
    const groups = new Map<string, Array<{ id: string; through: Array<string> }>>();
    const addCall = (callee: string, caller: string) => {
      const list = groups.get(callee) ?? [];
      list.push({ id: caller, through: through(caller) });
      groups.set(callee, list);
    };
    for (const caller of queue) {
      for (const outside of now.outside.get(caller)?.keys() ?? []) addCall(outside, caller);
      const own = status.get(caller);
      if (own === "changed" || own === "added") {
        for (const used of now.uses.get(caller) ?? []) if (!callers.has(used) && !setAside(used)) addCall(used, caller);
      }
    }
    const outsideTag = (id: string): string | null => {
      for (const outside of now.outside.values()) {
        const found = outside.get(id);
        if (found !== undefined) return tagOfOutside(found.id, found.capability, points);
      }
      return null;
    };
    const reachesOf = (callee: string): Array<string> => {
      if (callee.startsWith("outside\0")) {
        const tag = outsideTag(callee);
        return tag === null ? [] : [tag];
      }
      return [...(reachNow.get(callee)?.keys() ?? [])].sort((a, b) => order(a) - order(b));
    };
    const rank = (group: CallGroup) => {
      const first = group.reaches[0];
      if (first !== undefined) return order(first);
      return Object.keys(targets).length + (group.callee.startsWith("outside\0") ? 0 : 1);
    };
    const calls: Array<CallGroup> = [...groups.entries()]
      .map(([callee, list]) => ({
        callee,
        reaches: reachesOf(callee),
        callers: list.sort((a, b) => a.through.length - b.through.length).slice(0, 10),
        count: list.length,
      }))
      .sort((a, b) => rank(a) - rank(b) || b.count - a.count);

    // What uses each changed declaration.
    const users: Record<string, Array<string>> = {};
    for (const id of seeds) users[id] = [...(now.usedBy.get(id) ?? [])].filter((user) => !setAside(user)).slice(0, 12);

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
    for (const flow of reach) {
      describe(flow.origin);
      for (const chain of flow.chains) for (const step of chain) describe(step.id);
    }
    for (const group of calls) {
      describe(group.callee);
      for (const caller of group.callers) [caller.id, ...caller.through].forEach(describe);
    }
    for (const entry of pointsReached) for (const reacher of entry.reachedBy) [reacher.id, ...reacher.chain].forEach(describe);
    for (const list of Object.values(users)) list.forEach(describe);

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
      reach,
      calls,
      points: pointsReached,
      pointReach,
      users,
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

