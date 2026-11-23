import type { TopLevel, TopLevelUnit, Use } from "#/top-level.ts";

/** Lines of one version of a file, 1-based and inclusive. */
export type LineRange = { startLine: number; endLine: number };

/** What happened to one top-level declaration or statement (imports aside). */
export type DeclarationChange = {
  /** Its names; for a statement, the start of its code. */
  label: string;
  kind: "declaration" | "statement";
  /** Other files can use it (in the version that has it, the new one if both). */
  exported: boolean;
  /**
   * What happened to what it does when it runs: types don't count.
   * - changed: its code changed.
   * - affected: its code didn't, but top-level code it uses (at runtime) did (see `via`).
   * - types: only its types did (annotations, casts, generics; or it's only a type, see `typeOnly`).
   * - formatting: only whitespace, comments, semicolons or trailing commas did.
   */
  status: "added" | "removed" | "changed" | "affected" | "types" | "formatting" | "unchanged";
  /** It's only a type (an interface, a type alias, ...): gone after compiling. */
  typeOnly: boolean;
  before: LineRange | null;
  after: LineRange | null;
  /** For "affected": the top-level names from this one to what changed, that one last. */
  via: Array<string>;
  /** Where its new code, when it runs, uses a top-level name that was added, changed or affected (mentions in types aside). */
  uses: Array<UsedChange>;
};

/** A mention of a top-level name whose code is new or different, or uses code that is (see `Use`). */
export type UsedChange = Use & { status: "added" | "changed" | "affected" };

/**
 * Every top-level declaration and statement of a file, matched between two
 * versions by name (a statement by its code: a changed statement is one
 * removed and one added), in the new file's order; a removed one stands
 * after what stood before it in the old file.
 */
export function compareDeclarations(before: TopLevel, after: TopLevel, oldLines: Array<string>, newLines: Array<string>): Array<DeclarationChange> {
  const oldUnits = before.units.filter((unit) => unit.kind !== "import");
  const newUnits = after.units.filter((unit) => unit.kind !== "import");
  const oldByKey = new Map(oldUnits.map((unit) => [unit.key, unit]));
  const newKeys = new Set(newUnits.map((unit) => unit.key));
  const oldExported = new Set(before.exports.flatMap((entry) => (entry.unit === null ? [] : [before.units[entry.unit]?.key])));
  const newExported = new Set(after.exports.flatMap((entry) => (entry.unit === null ? [] : [after.units[entry.unit]?.key])));

  // Its text without blank lines: adding or removing one isn't a change. (One
  // inside a string is: it changes the code's tokens, so the fingerprint.)
  const text = (lines: Array<string>, unit: TopLevelUnit) =>
    lines
      .slice(unit.startLine - 1, unit.endLine)
      .filter((line) => line.trim() !== "")
      .join("\n");
  const range = (unit: TopLevelUnit): LineRange => ({ startLine: unit.startLine, endLine: unit.endLine });
  const label = (lines: Array<string>, unit: TopLevelUnit) => {
    if (unit.kind !== "statement") return unit.label;
    const code = (lines[unit.line - 1] ?? "").trim();
    return code.length > 60 ? `${code.slice(0, 59)}…` : code;
  };

  // Every unit of the new version, imports included: is what it does when it
  // runs new or different? An import is different when it imports another
  // thing; a type, or a change to types only, changes nothing that runs.
  const allOld = new Map(before.units.map((unit) => [unit.key, unit]));
  const own = after.units.map((unit): "added" | "changed" | null => {
    if (unit.typeOnly) return null;
    const previous = allOld.get(unit.key);
    if (previous === undefined) return "added";
    return previous.runtimeFingerprint !== unit.runtimeFingerprint ? "changed" : null;
  });
  const unitByName = new Map<string, number>();
  after.units.forEach((unit, index) => {
    for (const name of unit.names) unitByName.set(name, index);
  });

  /** The shortest path of units from `start` to one whose own code is new or different, `start` left out; null when there is none. */
  const pathToChange = (start: number): Array<number> | null => {
    const previous = new Map<number, number>([[start, -1]]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() ?? start;
      if (current !== start && own[current] !== null) {
        const path: Array<number> = [];
        for (let step = current; step !== start; step = previous.get(step) ?? start) path.unshift(step);
        return path;
      }
      for (const name of after.units[current]?.runtimeReferences ?? []) {
        const next = unitByName.get(name);
        if (next !== undefined && !previous.has(next)) {
          previous.set(next, current);
          queue.push(next);
        }
      }
    }
    return null;
  };
  // Only for the units whose own code is the same: the others are changed whatever they use.
  const paths = after.units.map((_, index) => (own[index] === null ? pathToChange(index) : null));

  /** Where a unit, when it runs, uses names that are new, changed, or use what is. */
  const usedChanges = (unit: TopLevelUnit): Array<UsedChange> =>
    unit.uses.flatMap((use) => {
      const index = unitByName.get(use.name);
      if (index === undefined || use.inType) return [];
      const status = own[index] ?? (paths[index] !== null ? "affected" : null);
      return status === null ? [] : [{ ...use, status }];
    });

  const indexOfUnit = new Map(after.units.map((unit, index) => [unit, index]));
  const kept: Array<DeclarationChange> = newUnits.map((unit) => {
    const previous = oldByKey.get(unit.key);
    const kind = unit.kind === "statement" ? "statement" : "declaration";
    const uses = usedChanges(unit);
    const typeOnly = unit.typeOnly;
    if (previous === undefined) {
      return { label: label(newLines, unit), kind, exported: newExported.has(unit.key), status: "added", typeOnly, before: null, after: range(unit), via: [], uses };
    }
    const path = paths[indexOfUnit.get(unit) ?? -1] ?? null;
    const status =
      previous.runtimeFingerprint !== unit.runtimeFingerprint
        ? "changed"
        : path !== null
          ? "affected"
          : previous.fingerprint !== unit.fingerprint
            ? "types"
            : text(oldLines, previous) !== text(newLines, unit)
              ? "formatting"
              : "unchanged";
    const via = status === "affected" && path !== null ? path.map((index) => after.units[index]?.label ?? "") : [];
    return { label: label(newLines, unit), kind, exported: newExported.has(unit.key), status, typeOnly, before: range(previous), after: range(unit), via, uses };
  });

  // Removed ones, each after the nearest unit before it in the old file that is still there.
  const positionOfKey = new Map(newUnits.map((unit, index) => [unit.key, index]));
  const removed: Array<{ after: number; change: DeclarationChange }> = [];
  let lastKept = -1;
  for (const unit of oldUnits) {
    if (newKeys.has(unit.key)) {
      lastKept = positionOfKey.get(unit.key) ?? lastKept;
      continue;
    }
    removed.push({
      after: lastKept,
      change: {
        label: label(oldLines, unit),
        kind: unit.kind === "statement" ? "statement" : "declaration",
        exported: oldExported.has(unit.key),
        status: "removed",
        typeOnly: unit.typeOnly,
        before: range(unit),
        after: null,
        via: [],
        uses: [],
      },
    });
  }
  const result: Array<DeclarationChange> = removed.filter((entry) => entry.after === -1).map((entry) => entry.change);
  kept.forEach((change, index) => {
    result.push(change);
    for (const entry of removed) {
      if (entry.after === index) result.push(entry.change);
    }
  });
  return result;
}
