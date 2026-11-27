import type { GraphDeclaration } from "#/graph.server.ts";
import type { ScannedGraph } from "#/graphs.ts";

/**
 * The Matrix view's numbers: a row per changed declaration, a column per
 * area (an app or package, a folder, or a file) its change reaches, and a
 * column per point. Kept apart from the markup so it can be tested.
 */

/** How big an area a column is. */
export type Granularity = "package" | "folder" | "file";

/** A column: `key` tells areas apart, `label` is what the header shows, `title` the whole of it on hover. */
export type MatrixColumn = { key: string; label: string; title: string; kind: "area" | "point"; total: number };

/** A row: the changed declaration, and per column key the declarations of that column its change reaches. */
export type MatrixRow = { declaration: GraphDeclaration; total: number; pointTotal: number; cells: Map<string, Array<GraphDeclaration>> };

export type Matrix = { rows: Array<MatrixRow>; columns: Array<MatrixColumn>; points: Array<MatrixColumn>; total: number; max: number; pointMax: number };

/**
 * Every declaration that uses `seed`, and what uses those, and so on: the
 * ripple's edges followed from what's used (`from`) to what uses it (`to`).
 * Nearest first; the seed itself is left out.
 */
export function reachedFrom(edges: Array<{ from: string; to: string }>, seed: string): Array<string> {
  const users = new Map<string, Array<string>>();
  for (const edge of edges) users.set(edge.from, [...(users.get(edge.from) ?? []), edge.to]);
  const seen = new Set([seed]);
  const reached: Array<string> = [];
  const queue = [seed];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const user of users.get(id) ?? []) {
      if (seen.has(user)) continue;
      seen.add(user);
      reached.push(user);
      queue.push(user);
    }
  }
  return reached;
}

/**
 * Which column a file is in. An app or package: the nearest folder with a
 * package.json above it (the repository's root one aside, it holds
 * everything; a file in none is in "the root"). A folder: the file's folder.
 * A file: the file.
 */
export function areaOf(path: string, granularity: Granularity, packages: Array<{ dir: string; name: string | null }>): { key: string; label: string; title: string } {
  if (granularity === "file") return { key: path, label: path.split("/").at(-1) ?? path, title: path };
  if (granularity === "folder") {
    const slash = path.lastIndexOf("/");
    const folder = slash === -1 ? "" : path.slice(0, slash);
    // The folder's last two names: enough to tell "billing/api" from "patients/api" in a narrow header.
    return { key: folder, label: folder === "" ? "(root)" : folder.split("/").slice(-2).join("/"), title: folder === "" ? "the repository's root folder" : folder };
  }
  const found = packages
    .filter((entry) => entry.dir !== "")
    .sort((a, b) => b.dir.length - a.dir.length)
    .find((entry) => path.startsWith(`${entry.dir}/`));
  if (found === undefined) return { key: "", label: "(root)", title: "in no app or package" };
  return { key: found.dir, label: found.name ?? found.dir, title: found.name === null || found.name === found.dir ? found.dir : `${found.dir} · ${found.name}` };
}

/**
 * The matrix for these changes. Rows: the declarations whose own code that
 * runs changed, was added or removed (not the ones only affected within
 * their file). A cell: the declarations in that column's area the row's
 * change reaches through the ripple. A point's cell: of the row's
 * declaration and what it reaches, the ones that reach that point. Rows and
 * columns sorted by their totals, the largest first; a column's total counts
 * each declaration once, however many rows reach it.
 */
export function changeMatrix(data: ScannedGraph, granularity: Granularity): Matrix {
  const areas = new Map<string, { key: string; label: string; title: string; reached: Set<string> }>();
  const points = new Map<string, Set<string>>();
  const everything = new Set<string>();
  const rows: Array<MatrixRow> = [];

  for (const seed of data.seeds) {
    const declaration = data.declarations[seed];
    if (declaration === undefined) continue;
    if (declaration.status !== "changed" && declaration.status !== "added" && declaration.status !== "removed") continue;

    const cells = new Map<string, Array<GraphDeclaration>>();
    let total = 0;
    const reached = reachedFrom(data.ripple.edges, seed)
      .map((id) => data.declarations[id])
      .filter((found): found is GraphDeclaration => found !== undefined && found.status !== "outside" && found.path !== "");
    for (const used of reached) {
      const area = areaOf(used.path, granularity, data.packages);
      const column = areas.get(area.key) ?? { ...area, reached: new Set<string>() };
      column.reached.add(used.id);
      areas.set(area.key, column);
      cells.set(area.key, [...(cells.get(area.key) ?? []), used]);
      everything.add(used.id);
      total += 1;
    }

    let pointTotal = 0;
    for (const one of [declaration, ...reached]) {
      for (const entry of data.pointReach[one.id] ?? []) {
        const key = `point:${entry.target}`;
        const list = cells.get(key) ?? [];
        if (list.some((other) => other.id === one.id)) continue;
        cells.set(key, [...list, one]);
        points.set(entry.target, (points.get(entry.target) ?? new Set()).add(one.id));
        pointTotal += 1;
      }
    }
    rows.push({ declaration, total, pointTotal, cells });
  }

  const columns: Array<MatrixColumn> = [...areas.values()]
    .map((area) => ({ key: area.key, label: area.label, title: area.title, kind: "area" as const, total: area.reached.size }))
    .sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
  if (granularity !== "package") lengthenAlike(columns);
  const pointColumns: Array<MatrixColumn> =[...points.entries()]
    .map(([target, ids]) => {
      const found = data.targets[target];
      return { key: `point:${target}`, label: found?.label ?? target, title: found?.about === null || found?.about === undefined ? (found?.label ?? target) : `${found.label}: ${found.about}`, kind: "point" as const, total: ids.size };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  rows.sort((a, b) => b.total - a.total || b.pointTotal - a.pointTotal || a.declaration.path.localeCompare(b.declaration.path) || a.declaration.line - b.declaration.line);

  const counts = (keys: Array<string>) => rows.flatMap((row) => keys.map((key) => row.cells.get(key)?.length ?? 0));
  return {
    rows,
    columns,
    points: pointColumns,
    total: everything.size,
    max: Math.max(0, ...counts(columns.map((column) => column.key))),
    pointMax: Math.max(0, ...counts(pointColumns.map((column) => column.key))),
  };
}

/**
 * Two headers that read the same ("pages/dashboard" in two apps) say which
 * is which: each takes one more folder from its path until it stands apart.
 */
export function lengthenAlike(columns: Array<{ key: string; label: string }>): void {
  for (;;) {
    const byLabel = new Map<string, Array<{ key: string; label: string }>>();
    for (const column of columns) byLabel.set(column.label, [...(byLabel.get(column.label) ?? []), column]);
    let lengthened = false;
    for (const alike of byLabel.values()) {
      if (alike.length < 2) continue;
      for (const column of alike) {
        const parts = column.key.split("/");
        const shown = column.label.split("/").length;
        if (shown >= parts.length) continue;
        column.label = parts.slice(-(shown + 1)).join("/");
        lengthened = true;
      }
    }
    if (!lengthened) return;
  }
}

/**
 * How dark a cell is, 0 (empty) to 5 (the most of any cell), on a log
 * scale: one big area shouldn't wash every other cell out to the lightest
 * shade.
 */
export function shadeOf(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  if (max === 1) return 3;
  return Math.max(1, Math.min(5, Math.ceil((Math.log(count + 1) / Math.log(max + 1)) * 5)));
}
