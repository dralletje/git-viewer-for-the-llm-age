import type { Target } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";

/**
 * One line of a "points first" tree: a declaration (or a package or global),
 * under what it uses on its way to the point. `use`: how the line to its
 * parent changed: a use the change added, one it removed (the declaration
 * no longer reaches the point this way), or null: there before and after.
 */
export type ReachNode = { id: string; use: "added" | "removed" | null; children: Array<ReachNode> };

/**
 * A point or capability, and the trees of how the changes reach it: its
 * roots are what is the point (its own code, a package it names, or for a
 * capability the package or global that gives it), their children what
 * uses those, down to the changed declarations. `changed`: how many changed,
 * new or removed declarations are in it; `affected`: how many with the same
 * code that use what changed.
 */
export type TargetTree = { target: Target; roots: Array<ReachNode>; changed: number; affected: number };

export type TargetTrees = { reached: Array<TargetTree>; notReached: Array<Target> };

const isChange = (status: string | undefined) => status === "changed" || status === "added" || status === "removed";
const isRelevant = (status: string | undefined) => isChange(status) || status === "affected";

/**
 * The repository's points, each with how the changes reach it, from
 * `pointReach`: each changed or affected declaration's way to the point,
 * turned around and merged into one tree (the ways are shortest ways, so
 * every declaration has one next step: they fit in a tree). A use of the
 * point that the change removed goes in too, marked, so a declaration that
 * stopped reaching a point still shows. Points with most changes first;
 * points nothing reaches apart.
 */
export function pointTrees(data: ScannedGraph): TargetTrees {
  const points = Object.values(data.targets).filter((target) => target.kind === "point");
  return treesFor(data, points, (target) => {
    const edges: Array<Edge> = [];
    for (const [id, entries] of Object.entries(data.pointReach)) {
      if (!isRelevant(data.declarations[id]?.status)) continue;
      for (const entry of entries) {
        if (entry.target !== target.key) continue;
        const chain = [id, ...entry.way];
        for (let index = 0; index < chain.length; index++) edges.push({ child: chain[index] ?? "", parent: chain[index + 1] ?? null, use: null });
      }
    }
    // A use the change removed of something that is the point (or reaches it).
    for (const link of data.links) {
      if (link.status !== "removed") continue;
      const used = data.declarations[link.to];
      const reaches = used?.tag === target.key || (data.pointReach[link.to] ?? []).some((entry) => entry.target === target.key);
      if (!reaches) continue;
      edges.push({ child: link.from, parent: link.to, use: "removed" });
      if (used?.tag === target.key) edges.push({ child: link.to, parent: null, use: null });
      for (const entry of data.pointReach[link.to] ?? []) {
        if (entry.target !== target.key) continue;
        const chain = [link.to, ...entry.way];
        for (let index = 0; index < chain.length; index++) edges.push({ child: chain[index] ?? "", parent: chain[index + 1] ?? null, use: null });
      }
    }
    return edges;
  });
}

/**
 * The capabilities (network, database, ...), each with how the changes
 * reach it. There's no way per declaration for these, so it's built from
 * what there is: the uses of a package or global that the changed files
 * added, removed or kept (see `links`), and under each declaration that
 * uses one, what uses that declaration in the ripple, and so on.
 */
export function capabilityTrees(data: ScannedGraph): TargetTrees {
  const capabilities = Object.values(data.targets).filter((target) => target.kind === "capability");
  const usersOf = new Map<string, Array<string>>();
  for (const edge of data.ripple.edges) usersOf.set(edge.from, [...(usersOf.get(edge.from) ?? []), edge.to]);
  return treesFor(data, capabilities, (target) => {
    const edges: Array<Edge> = [];
    const placed = new Set<string>();
    const queue: Array<string> = [];
    for (const link of data.links) {
      if (data.declarations[link.to]?.tag !== target.key || data.declarations[link.to]?.status !== "outside") continue;
      edges.push({ child: link.to, parent: null, use: null });
      edges.push({ child: link.from, parent: link.to, use: link.status === "kept" ? null : link.status });
      // What uses a declaration that no longer uses the capability doesn't reach it through that.
      if (link.status !== "removed" && !placed.has(link.from)) {
        placed.add(link.from);
        queue.push(link.from);
      }
    }
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index] ?? "";
      for (const user of usersOf.get(id) ?? []) {
        if (placed.has(user)) continue;
        placed.add(user);
        queue.push(user);
        edges.push({ child: user, parent: id, use: null });
      }
    }
    return edges;
  });
}

/** A line of a tree: `child` under `parent` (null: at the top, under the point itself). */
type Edge = { child: string; parent: string | null; use: "added" | "removed" | null };

function treesFor(data: ScannedGraph, targets: Array<Target>, edgesOf: (target: Target) => Array<Edge>): TargetTrees {
  const added = new Set(data.links.filter((link) => link.status === "added").map((link) => `${link.from}\u0001${link.to}`));
  const reached: Array<TargetTree> = [];
  const notReached: Array<Target> = [];
  for (const target of targets) {
    // Each declaration under one parent (the first way found), but a removed use is its own line.
    const childrenOf = new Map<string | null, Array<{ id: string; use: "added" | "removed" | null }>>();
    const parentOf = new Map<string, string | null>();
    for (const edge of edgesOf(target)) {
      if (edge.use !== "removed") {
        if (parentOf.has(edge.child)) continue;
        parentOf.set(edge.child, edge.parent);
      }
      const use = edge.use ?? (edge.parent !== null && added.has(`${edge.child}\u0001${edge.parent}`) ? "added" : null);
      const siblings = childrenOf.get(edge.parent) ?? [];
      if (!siblings.some((sibling) => sibling.id === edge.child && sibling.use === use)) siblings.push({ id: edge.child, use });
      childrenOf.set(edge.parent, siblings);
    }
    const build = (id: string, use: ReachNode["use"], above: Set<string>): ReachNode | null => {
      // A removed use can lead back up the same branch: shown once.
      if (above.has(id)) return null;
      const inside = new Set([...above, id]);
      const children = (childrenOf.get(id) ?? []).flatMap((child) => build(child.id, child.use, inside) ?? []);
      // Only branches that end at something the change touched.
      if (children.length === 0 && !isRelevant(data.declarations[id]?.status)) return null;
      return { id, use, children: sortNodes(data, children) };
    };
    const roots = sortNodes(
      data,
      (childrenOf.get(null) ?? []).flatMap((root) => build(root.id, root.use, new Set()) ?? []),
    );
    if (roots.length === 0) {
      notReached.push(target);
      continue;
    }
    const seen = new Set<string>();
    const walk = (node: ReachNode) => {
      seen.add(node.id);
      node.children.forEach(walk);
    };
    roots.forEach(walk);
    const statuses = [...seen].map((id) => data.declarations[id]?.status);
    reached.push({ target, roots, changed: statuses.filter(isChange).length, affected: statuses.filter((status) => status === "affected").length });
  }
  // The points with the most changes reaching them first; the rest in the repository's order.
  reached.sort((a, b) => b.changed - a.changed || b.affected - a.affected);
  return { reached, notReached };
}

/** Branches with changes first, then by file and name: a tree reads the same every time. */
function sortNodes(data: ScannedGraph, nodes: Array<ReachNode>): Array<ReachNode> {
  const changes = (node: ReachNode): number => (isChange(data.declarations[node.id]?.status) ? 1 : 0) + node.children.reduce((sum, child) => sum + changes(child), 0);
  const counted = nodes.map((node) => ({ node, changes: changes(node) }));
  counted.sort((a, b) => {
    const left = data.declarations[a.node.id];
    const right = data.declarations[b.node.id];
    return b.changes - a.changes || (left?.path ?? "").localeCompare(right?.path ?? "") || (left?.label ?? a.node.id).localeCompare(right?.label ?? b.node.id);
  });
  return counted.map((entry) => entry.node);
}
