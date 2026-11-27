import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";

/**
 * One declaration in the reading order. `depth`: how many uses away from the
 * nearest changed declaration (0: changed itself, or not connected to one).
 * `usesLater`: it uses a declaration further down the list, which only
 * happens in a cycle (two declarations that use each other): the reader is
 * told, rather than shown an order that pretends otherwise.
 */
export type OrderRow = { declaration: GraphDeclaration; depth: number; seed: boolean; usesLater: boolean };

/**
 * The declarations the graph draws (the changes, the ripple, the links'
 * ends), in the order to read them: what's used before what uses it, so
 * every declaration is read after the code it builds on. Packages and
 * globals have no code to read, and removed declarations nothing that runs
 * any more: both are left out.
 *
 * Among the ones that could come next: one in the same file as the one just
 * read (a file is read in one go where the uses allow it), then a changed
 * one, then the nearest to a change, then by path and line. A cycle is
 * broken the same way: the first of what's left, by those rules, comes next.
 */
export function readingOrder(data: Pick<ScannedGraph, "declarations" | "seeds" | "ripple" | "links">): Array<OrderRow> {
  const readable = (id: string) => {
    const declaration = data.declarations[id];
    return declaration !== undefined && declaration.status !== "outside" && declaration.status !== "removed" && declaration.path !== "";
  };

  // Every use, from what's used to what uses it. A link's `from` is the one
  // that uses: the other way round from the ripple's. A use that went away
  // asks nothing of the order.
  const uses: Array<{ used: string; user: string }> = [
    ...data.ripple.edges.map((edge) => ({ used: edge.from, user: edge.to })),
    ...data.links.filter((link) => link.status !== "removed").map((link) => ({ used: link.to, user: link.from })),
  ];
  const ids = new Set<string>();
  for (const id of [...data.seeds, ...uses.flatMap((use) => [use.used, use.user])]) if (readable(id)) ids.add(id);

  const usedBy = new Map<string, Set<string>>();
  const usesOf = new Map<string, Set<string>>();
  for (const { used, user } of uses) {
    if (used === user || !ids.has(used) || !ids.has(user)) continue;
    if (!usedBy.has(used)) usedBy.set(used, new Set());
    if (!usesOf.has(user)) usesOf.set(user, new Set());
    usedBy.get(used)?.add(user);
    usesOf.get(user)?.add(used);
  }

  // How far from a change, whichever way the uses go: what a change newly
  // uses is as near to it as what uses it.
  const seeds = new Set(data.seeds.filter((id) => ids.has(id)));
  const depth = new Map<string, number>([...seeds].map((id) => [id, 0]));
  const queue = [...seeds];
  for (let next = 0; next < queue.length; next++) {
    const id = queue[next] ?? "";
    for (const neighbour of [...(usedBy.get(id) ?? []), ...(usesOf.get(id) ?? [])]) {
      if (depth.has(neighbour)) continue;
      depth.set(neighbour, (depth.get(id) ?? 0) + 1);
      queue.push(neighbour);
    }
  }

  const before = (a: string, b: string): number => {
    const first = data.declarations[a];
    const second = data.declarations[b];
    if (first === undefined || second === undefined) return 0;
    return (
      Number(seeds.has(b)) - Number(seeds.has(a)) ||
      (depth.get(a) ?? 0) - (depth.get(b) ?? 0) ||
      first.path.localeCompare(second.path) ||
      first.line - second.line ||
      first.label.localeCompare(second.label) ||
      a.localeCompare(b)
    );
  };
  const nextOf = (candidates: Array<string>, lastPath: string | null): string | undefined => {
    const sameFile = lastPath === null ? [] : candidates.filter((id) => data.declarations[id]?.path === lastPath);
    return [...(sameFile.length > 0 ? sameFile : candidates)].sort(before)[0];
  };

  const waitingOn = new Map([...ids].map((id) => [id, usesOf.get(id)?.size ?? 0]));
  const placed = new Set<string>();
  const order: Array<string> = [];
  let lastPath: string | null = null;
  while (order.length < ids.size) {
    const left = [...ids].filter((id) => !placed.has(id));
    const ready = left.filter((id) => (waitingOn.get(id) ?? 0) === 0);
    // Nothing ready: everything left is in or after a cycle. Break it.
    const id = nextOf(ready.length > 0 ? ready : left, lastPath);
    if (id === undefined) break;
    placed.add(id);
    order.push(id);
    lastPath = data.declarations[id]?.path ?? null;
    for (const user of usedBy.get(id) ?? []) waitingOn.set(user, (waitingOn.get(user) ?? 0) - 1);
  }

  const position = new Map(order.map((id, index) => [id, index]));
  return order.flatMap((id, index) => {
    const declaration = data.declarations[id];
    if (declaration === undefined) return [];
    const usesLater = [...(usesOf.get(id) ?? [])].some((used) => (position.get(used) ?? 0) > index);
    return [{ declaration, depth: depth.get(id) ?? 0, seed: seeds.has(id), usesLater }];
  });
}
