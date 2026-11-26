import type { ScannedGraph } from "#/graphs.ts";

/**
 * One change and what it alone spreads to: the declarations that use it,
 * and what uses those, through the ripple. The "Per change" tab draws one
 * of these per card.
 */
export type ChangeReach = {
  /** The changed, added or removed declaration (or, see `perChange`, an affected one no change reaches). */
  id: string;
  status: "changed" | "added" | "removed" | "affected";
  /** Every declaration it reaches, nearest first, itself left out. */
  reached: Array<string>;
  /** The ripple's edges between it and what it reaches: `from` is used by `to`. */
  edges: Array<{ from: string; to: string }>;
  /** The uses it added or removed (either end it), as `data.links` has them. */
  links: ScannedGraph["links"];
  /** The files of what it reaches, its own left out unless something else in it is reached. */
  files: Array<string>;
  /** The apps or packages (their folders, "" the root) of what it reaches. */
  packages: Array<string>;
  /** The repository's points it or what it reaches gets to (target keys, "point:<name>"). */
  points: Array<string>;
  /** Of `reached`: the ones no other change reaches. */
  unique: number;
};

export type PerChange = {
  /** Largest blast radius first, then by name. */
  changes: Array<ChangeReach>;
  /** How many changes reach each declaration: more than 1 is overlap. */
  reachedBy: Map<string, number>;
  /** Every declaration some change reaches, once. */
  total: number;
  /** The fewest changes (largest first) that together reach 80% of `total`. */
  topFor80: number;
};

/**
 * Each change's own ripple. A changed, added or removed declaration is a
 * change; a seed that's "affected" (same code, but in its file it uses what
 * changed) is part of whichever change reaches it, so it gets no card of
 * its own, unless no change reaches it (it uses code outside any
 * declaration, say): then it's shown on its own rather than lost.
 */
export function perChange(data: ScannedGraph): PerChange {
  const usersOf = new Map<string, Array<string>>();
  for (const edge of data.ripple.edges) {
    const users = usersOf.get(edge.from) ?? [];
    users.push(edge.to);
    usersOf.set(edge.from, users);
  }
  const statusOf = (id: string) => data.declarations[id]?.status;

  const changed = [...data.seeds.filter((id) => statusOf(id) === "changed" || statusOf(id) === "added"), ...Object.values(data.declarations).filter((declaration) => declaration.status === "removed").map((declaration) => declaration.id)];
  const reachedOf = new Map<string, Array<string>>();
  for (const id of changed) reachedOf.set(id, reachFrom(id, usersOf));
  // An affected seed that no change reaches would vanish: it stands for itself.
  // The one that reaches most first: what it reaches is then part of it, not a card of its own.
  const covered = new Set([...reachedOf.values()].flat());
  const orphans = data.seeds
    .filter((id) => statusOf(id) === "affected" && !covered.has(id))
    .map((id) => ({ id, reached: reachFrom(id, usersOf) }))
    .sort((a, b) => b.reached.length - a.reached.length);
  for (const orphan of orphans) {
    if (covered.has(orphan.id)) continue;
    reachedOf.set(orphan.id, orphan.reached);
    for (const id of orphan.reached) covered.add(id);
  }

  const reachedBy = new Map<string, number>();
  for (const reached of reachedOf.values()) for (const id of reached) reachedBy.set(id, (reachedBy.get(id) ?? 0) + 1);

  // The deepest package first: a file is in the nearest one above it.
  const packages = data.packages.filter((entry) => entry.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (path: string) => packages.find((entry) => path.startsWith(`${entry.dir}/`))?.dir ?? "";

  const changes: Array<ChangeReach> = [];
  for (const [id, reached] of reachedOf) {
    const inside = new Set([id, ...reached]);
    const edges = data.ripple.edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to));
    const links = data.links.filter((link) => link.status !== "kept" && (link.from === id || link.to === id));
    const declared = reached.map((other) => data.declarations[other]).filter((declaration) => declaration !== undefined && declaration.status !== "outside" && declaration.path !== "");
    const files = [...new Set(declared.map((declaration) => declaration?.path ?? ""))].sort();
    const packageDirs = [...new Set(declared.map((declaration) => packageOf(declaration?.path ?? "")))].sort();
    const points = [...new Set([id, ...reached].flatMap((other) => (data.pointReach[other] ?? []).map((entry) => entry.target)))].sort();
    const status = statusOf(id);
    changes.push({
      id,
      status: status === "added" || status === "removed" || status === "affected" ? status : "changed",
      reached,
      edges,
      links,
      files,
      packages: packageDirs,
      points,
      unique: reached.filter((other) => reachedBy.get(other) === 1).length,
    });
  }
  const labelOf = (id: string) => data.declarations[id]?.label ?? id;
  changes.sort((a, b) => b.reached.length - a.reached.length || labelOf(a.id).localeCompare(labelOf(b.id)));

  // The fewest of the largest that together reach 80% of everything reached.
  const total = reachedBy.size;
  const together = new Set<string>();
  let topFor80 = 0;
  for (const change of changes) {
    if (total === 0 || together.size >= total * 0.8) break;
    for (const id of change.reached) together.add(id);
    topFor80++;
  }
  return { changes, reachedBy, total, topFor80 };
}

/** What uses `id`, and what uses those, nearest first. */
function reachFrom(id: string, usersOf: Map<string, Array<string>>): Array<string> {
  const seen = new Set([id]);
  const queue = [id];
  for (let next = 0; next < queue.length; next++) {
    for (const user of usersOf.get(queue[next] ?? "") ?? []) {
      if (seen.has(user)) continue;
      seen.add(user);
      queue.push(user);
    }
  }
  return queue.slice(1);
}

/**
 * The graph data narrowed to one change: it, what it reaches, and its own
 * added or removed uses. The Ripple graph's model (`rippleWithoutFileBoxes`)
 * turns this into a drawing like the whole one, only smaller.
 */
export function changeData(data: ScannedGraph, change: ChangeReach): ScannedGraph {
  return {
    ...data,
    seeds: [change.id],
    ripple: { edges: change.edges, affected: change.reached.length, shown: change.reached.length },
    links: change.links,
  };
}
