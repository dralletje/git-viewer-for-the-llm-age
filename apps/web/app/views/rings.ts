import type { ScannedGraph } from "#/graphs.ts";

/**
 * Distance rings: the ripple drawn as rings around the changes. The changed
 * declarations (the seeds) in the middle, then a ring for each step out
 * along the ripple's uses. A declaration sits on the ring of its shortest
 * way from a change, so the rings say how far a change has to travel to
 * reach it.
 */

/**
 * How many steps each declaration is from a change: 0 for the seeds, then
 * breadth first along `edges` (from what's used to what uses it). A
 * declaration no edge reaches from a seed isn't in the map.
 */
export function distancesFrom(seeds: Array<string>, edges: Array<{ from: string; to: string }>): Map<string, number> {
  const users = new Map<string, Array<string>>();
  for (const edge of edges) users.set(edge.from, [...(users.get(edge.from) ?? []), edge.to]);
  const distance = new Map<string, number>(seeds.map((id) => [id, 0]));
  const queue = [...new Set(seeds)];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index] ?? "";
    for (const user of users.get(id) ?? []) {
      if (distance.has(user)) continue;
      distance.set(user, (distance.get(id) ?? 0) + 1);
      queue.push(user);
    }
  }
  return distance;
}

/**
 * What lights up when a declaration is pointed at: its ways in to the
 * changes (each use that comes from a ring nearer the middle) and its ways
 * out (each use by a ring further out). Uses within one ring, or back in,
 * aren't part of either: following those would light up most of a big
 * ripple. `edges` by index; the ones lit are returned by index.
 */
export function pathsThrough(id: string, edges: Array<{ from: string; to: string }>, ring: Map<string, number>): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set([id]);
  const lit = new Set<number>();
  for (const outward of [false, true]) {
    const queue = [id];
    const seen = new Set([id]);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index] ?? "";
      edges.forEach((edge, edgeIndex) => {
        const [here, there] = outward ? [edge.from, edge.to] : [edge.to, edge.from];
        if (here !== current) return;
        const hereRing = ring.get(here);
        const thereRing = ring.get(there);
        if (hereRing === undefined || thereRing === undefined) return;
        if (outward ? thereRing <= hereRing : thereRing >= hereRing) return;
        lit.add(edgeIndex);
        nodes.add(there);
        if (seen.has(there)) return;
        seen.add(there);
        queue.push(there);
      });
    }
  }
  return { nodes, edges: lit };
}

/** A label longer than this loses its start: the end of a name says most. */
export const maxLabel = 32;
export function shortLabel(label: string): string {
  return label.length > maxLabel ? `…${label.slice(-(maxLabel - 1))}` : label;
}

/** A declaration on its ring: a pill from `radius` outwards, `length` long, pointing at `angle` (radians, 0 is right, clockwise). */
export type RingNode = {
  id: string;
  ring: number;
  label: string;
  path: string;
  /** Its app or package's folder ("" none). */
  packageDir: string;
  status: string;
  angle: number;
  radius: number;
  length: number;
  /** The points it reaches (their names), for the fuchsia badge. */
  points: Array<string>;
};
export type RingEdge = { from: string; to: string; d: string };
export type Ring = { ring: number; radius: number; count: number };
export type RingsLayout = { size: number; center: number; rings: Array<Ring>; nodes: Array<RingNode>; edges: Array<RingEdge>; ring: Map<string, number>; unreached: number };

/** 12px monospace: 7px a character, and room around. */
const characterWidth = 7;
const pillPadding = 16;
/** Along a ring, from one pill's middle to the next: a pill is 16px high. */
const spacing = 19;
/** Between one ring's longest pill and the next ring. */
const ringGap = 70;
/** Kept free at the top of each ring for its name and count. */
const labelArc = 120;

export function pillLength(label: string): number {
  return shortLabel(label).length * characterWidth + pillPadding;
}

/**
 * Where everything goes: each ring's declarations around its circle, by
 * app or package, then file, so a file's declarations sit together; the
 * packages in the order of where what they use sits on the ring inside, so
 * the curves between rings cross less. A ring is far enough out for its
 * pills to fit side by side, and past the longest pill of the ring inside.
 * A single change sits in the middle, flat; several go on a small ring.
 */
export function ringsLayout(data: ScannedGraph): RingsLayout {
  const seeds = data.seeds.filter((id) => data.declarations[id] !== undefined);
  const edgeKeys = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const edge of data.ripple.edges) {
    const key = `${edge.from}\u0001${edge.to}`;
    if (edge.from === edge.to || edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
  }
  const ring = distancesFrom(seeds, edges);
  const drawnIds = new Set([...seeds, ...edges.flatMap((edge) => [edge.from, edge.to])]);
  const unreached = [...drawnIds].filter((id) => !ring.has(id)).length;

  // The deepest package first: a file is in the nearest one above it.
  const packages = data.packages.filter((entry) => entry.dir !== "").sort((a, b) => b.dir.length - a.dir.length);
  const packageOf = (path: string) => packages.find((entry) => path.startsWith(`${entry.dir}/`))?.dir ?? "";

  const byRing: Array<Array<string>> = [];
  for (const [id, distance] of ring) {
    if (data.declarations[id] === undefined) continue;
    (byRing[distance] ??= []).push(id);
  }

  const users = new Map<string, Array<string>>();
  const usedBy = new Map<string, Array<string>>();
  for (const edge of edges) {
    users.set(edge.from, [...(users.get(edge.from) ?? []), edge.to]);
    usedBy.set(edge.to, [...(usedBy.get(edge.to) ?? []), edge.from]);
  }

  const nodes = new Map<string, RingNode>();
  const rings: Array<Ring> = [];
  let outerEdge = 0;
  const top = -Math.PI / 2;
  for (let distance = 0; distance < byRing.length; distance++) {
    const ids = byRing[distance] ?? [];
    const info = ids.map((id) => {
      const declaration = data.declarations[id];
      const path = declaration?.path ?? "";
      // Where it would like to be: the middle of what it uses on the ring inside, from the top, clockwise.
      const inner = (usedBy.get(id) ?? []).flatMap((used) => {
        const node = nodes.get(used);
        return node === undefined || node.ring >= distance ? [] : [node];
      });
      const wanted = inner.length === 0 ? null : circularMean(inner.map((node) => node.angle - top));
      return { id, path, packageDir: packageOf(path), label: declaration?.label ?? id, wanted };
    });
    // Packages by where they'd like to be, then their files by path, then by where each declaration would like to be.
    const packageWanted = new Map<string, number>();
    for (const dir of new Set(info.map((entry) => entry.packageDir))) {
      const wanted = info.filter((entry) => entry.packageDir === dir && entry.wanted !== null).map((entry) => entry.wanted ?? 0);
      packageWanted.set(dir, wanted.length === 0 ? Number.POSITIVE_INFINITY : circularMean(wanted));
    }
    info.sort(
      (a, b) =>
        (packageWanted.get(a.packageDir) ?? 0) - (packageWanted.get(b.packageDir) ?? 0) ||
        a.packageDir.localeCompare(b.packageDir) ||
        a.path.localeCompare(b.path) ||
        (a.wanted ?? 0) - (b.wanted ?? 0) ||
        a.label.localeCompare(b.label),
    );

    // Slots along the ring: one per declaration, a whole one between packages, half one between files, and the top kept for the ring's name.
    const slots: Array<number> = [];
    let at = 0;
    info.forEach((entry, index) => {
      const previous = info[index - 1];
      if (previous !== undefined) at += previous.packageDir !== entry.packageDir ? 2 : previous.path !== entry.path ? 1.5 : 1;
      slots.push(at);
    });
    const longest = Math.max(0, ...info.map((entry) => pillLength(entry.label)));

    if (distance === 0 && info.length === 1) {
      // One change: in the middle, flat, readable as it is.
      const entry = info[0];
      if (entry !== undefined) nodes.set(entry.id, nodeOf(data, entry, 0, 0, 0, longest));
      rings.push({ ring: 0, radius: 0, count: 1 });
      outerEdge = longest / 2;
      continue;
    }
    const labelSlots = labelArc / spacing;
    const total = at + 1 + labelSlots;
    const fits = (total * spacing) / (2 * Math.PI);
    const radius = Math.max(distance === 0 ? 50 : outerEdge + ringGap, fits);
    const angles = anglesOnRing(
      info.map((entry) => entry.wanted),
      slots,
      radius,
      labelSlots,
    );
    info.forEach((entry, index) => {
      nodes.set(entry.id, nodeOf(data, entry, distance, top + (angles[index] ?? 0), radius, pillLength(entry.label)));
    });
    rings.push({ ring: distance, radius, count: info.length });
    outerEdge = radius + longest;
  }

  const margin = 40;
  const center = outerEdge + margin;
  const point = (angle: number, radius: number) => `${round(center + Math.cos(angle) * radius)} ${round(center + Math.sin(angle) * radius)}`;
  const drawnEdges: Array<RingEdge> = [];
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from === undefined || to === undefined) continue;
    // Out along the rings: from the outer end of what's used to the inner end of what uses it; back in, the other way round.
    const fromRadius = to.ring > from.ring ? from.radius + (from.radius === 0 ? 0 : from.length) : from.radius;
    const toRadius = to.ring > from.ring ? to.radius : to.radius + to.length;
    if (to.ring === from.ring) {
      // Within a ring: a bow towards the middle, from inner end to inner end.
      drawnEdges.push({ from: edge.from, to: edge.to, d: `M ${point(from.angle, fromRadius)} C ${point(from.angle, fromRadius * 0.7)} ${point(to.angle, toRadius * 0.7)} ${point(to.angle, toRadius)}` });
      continue;
    }
    const middle = (toRadius - fromRadius) / 2;
    // From the middle node, the curve sets off towards where it goes.
    const fromAngle = from.radius === 0 ? to.angle : from.angle;
    drawnEdges.push({
      from: edge.from,
      to: edge.to,
      d: `M ${point(fromAngle, fromRadius)} C ${point(fromAngle, fromRadius + middle)} ${point(to.angle, toRadius - middle)} ${point(to.angle, toRadius)}`,
    });
  }
  return { size: center * 2, center, rings, nodes: [...nodes.values()], edges: drawnEdges, ring, unreached };
}

/**
 * Each declaration's angle on its ring, from the top, clockwise. A ring with
 * room puts each one near what it uses on the ring inside (`wanted`), so the
 * curves between rings stay short, and pushes on the ones that would sit
 * closer than `slots` say (a pill apart, more between files and packages).
 * A crowded ring, or the middle (nothing to be near), goes round evenly.
 * The top, `labelSlots` wide, is kept for the ring's name.
 */
export function anglesOnRing(wanted: Array<number | null>, slots: Array<number>, radius: number, labelSlots: number): Array<number> {
  const last = slots.at(-1) ?? 0;
  const total = last + 1 + labelSlots;
  const even = slots.map((slot) => (labelSlots / 2 + 0.5 + slot) * ((2 * Math.PI) / total));
  if (wanted.every((angle) => angle === null)) return even;
  // A pill apart at least; on a roomy ring a third of the even spacing, so a bunch behind one declaration fans out and stays readable.
  const step = Math.max(spacing / radius, ((2 * Math.PI) / total) * 0.35);
  const lowest = ((labelSlots / 2) * spacing) / radius;
  const highest = 2 * Math.PI - lowest;
  if ((last + 1) * step > highest - lowest) return even;
  // Where each would like to be (one with no wish: where the one before is), then pushed apart in order.
  const angles: Array<number> = [];
  let previousWish = lowest;
  wanted.forEach((wish, index) => {
    const target = wish ?? previousWish;
    previousWish = target;
    const before = angles[index - 1];
    const gap = (slots[index] ?? 0) - (slots[index - 1] ?? 0);
    angles.push(before === undefined ? target : Math.max(target, before + gap * step));
  });
  // Pushing moved them on: back by the average, so they sit around their wishes; then inside the ring, clear of its name.
  const drift = angles.reduce((sum, angle, index) => sum + angle - (wanted[index] ?? angle), 0) / angles.length;
  let shift = -drift;
  const first = (angles[0] ?? 0) + shift;
  const end = (angles.at(-1) ?? 0) + shift;
  if (first < lowest) shift += lowest - first;
  else if (end > highest) shift -= end - highest;
  // Wishes all round the ring, pushed past its end: evenly after all.
  if ((angles[0] ?? 0) + shift < lowest - 1e-9 || (angles.at(-1) ?? 0) + shift > highest + 1e-9) return even;
  return angles.map((angle) => angle + shift);
}

function nodeOf(data: ScannedGraph, entry: { id: string; path: string; packageDir: string; label: string }, ring: number, angle: number, radius: number, length: number): RingNode {
  const points = (data.pointReach[entry.id] ?? []).map((reach) => data.targets[reach.target]?.label ?? reach.target);
  return { ...entry, ring, angle, radius, length, status: data.declarations[entry.id]?.status ?? "affected", points: [...new Set(points)] };
}

/** The mean of angles, in [0, 2π): 350° and 10° average to 0°, not 180°. */
export function circularMean(angles: Array<number>): number {
  const x = angles.reduce((sum, angle) => sum + Math.cos(angle), 0);
  const y = angles.reduce((sum, angle) => sum + Math.sin(angle), 0);
  const mean = Math.atan2(y, x);
  return mean < 0 ? mean + 2 * Math.PI : mean;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
