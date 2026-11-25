import type { DeclarationGraph } from "#/declaration-graph.ts";
import { pointOfDeclaration, pointOfPackage, type Point } from "#/points.ts";

/** The target a package or global gives: a point that names the package, else its capability. Ids are "outside\0<source>\0<name>". */
export function tagOfOutside(id: string, capability: string | null, points: Array<Point>): string | null {
  const source = id.split("\0")[1] ?? "";
  const point = source === "global" ? null : pointOfPackage(points, source);
  if (point !== null) return `point:${point}`;
  return capability === null ? null : `capability:${capability}`;
}

/**
 * How a declaration reaches a target: `next`, the declaration on the
 * shortest way there (or the origin itself), and `origin`: the package or
 * global that gives it, or the declaration of the point it gets there by.
 */
export type How = { next: string; origin: string };

/**
 * What each declaration reaches, per target: "point:<name>" for one of the
 * repository's points (see points.ts), "capability:<name>" for a
 * capability. A point's declarations reach it (each is its own origin), and
 * so does what uses a package it names; a capability is reached through the
 * packages and globals that give it. A point's declarations are a wall:
 * what's past them is that point, so neither a capability nor another point
 * is reached through them.
 */
export function reachOf(graph: DeclarationGraph, points: Array<Point>): Map<string, Map<string, How>> {
  const reach = new Map<string, Map<string, How>>();
  const member = new Map<string, string>();
  for (const [id, declaration] of graph.declarations) {
    const point = pointOfDeclaration(points, declaration.path, declaration.label);
    if (point !== null) member.set(id, `point:${point}`);
  }
  // The seeds, per target.
  const seeds = new Map<string, Array<{ id: string; how: How }>>();
  const seed = (target: string, id: string, how: How) => {
    const list = seeds.get(target) ?? [];
    list.push({ id, how });
    seeds.set(target, list);
  };
  for (const [id, target] of member) seed(target, id, { next: id, origin: id });
  for (const [id, outside] of graph.outside) {
    if (member.has(id)) continue;
    for (const entry of outside.values()) {
      const target = tagOfOutside(entry.id, entry.capability, points);
      if (target !== null) seed(target, id, { next: entry.id, origin: entry.id });
    }
  }

  for (const [target, list] of seeds) {
    const queue: Array<string> = [];
    const set = (id: string, how: How) => {
      // Another point's code is a wall.
      if (member.has(id) && member.get(id) !== target) return;
      const theirs = reach.get(id) ?? new Map<string, How>();
      if (theirs.has(target)) return;
      theirs.set(target, how);
      reach.set(id, theirs);
      queue.push(id);
    };
    for (const entry of list) set(entry.id, entry.how);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index] ?? "";
      const origin = reach.get(id)?.get(target)?.origin;
      if (origin === undefined) continue;
      for (const user of graph.usedBy.get(id) ?? []) set(user, { next: id, origin });
    }
  }
  return reach;
}
