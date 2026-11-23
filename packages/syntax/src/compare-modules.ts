import type { ExportKind, TopLevel, TopLevelUnit } from "#/top-level.ts";

/** What happened to one exported name between two versions of a file. */
export type ExportChange = {
  name: string;
  kind: ExportKind;
  typeOnly: boolean;
  /**
   * - changed: its own code changed (formatting aside), body and value included.
   * - affected: its own code didn't, but top-level code it uses did (see `via`).
   */
  status: "added" | "removed" | "changed" | "affected" | "unchanged";
  /** Its signature (see `Export.signature`) or kind changed: what files using it see. */
  signatureChanged: boolean;
  oldSignature: string | null;
  signature: string | null;
  /** For "affected": the top-level names from this export to what changed, that one last. */
  via: Array<string>;
};

/** A changed top-level unit, for people. */
export type ChangedUnit = { label: string; line: number; kind: TopLevelUnit["kind"] };

export type ModuleChanges = {
  exports: Array<ExportChange>;
  /**
   * Changed imports and declarations that no export and no top-level
   * statement uses, directly or through others: dead code, an unused
   * import. Only for a file that has exports; in a script everything would be.
   */
  unreachable: Array<ChangedUnit>;
  /** Changed top-level statements: code that runs when the file is imported. */
  statements: Array<ChangedUnit>;
};

export function compareModules(before: TopLevel, after: TopLevel): ModuleChanges {
  const oldUnits = new Map(before.units.map((unit) => [unit.key, unit]));
  const changed = after.units.map((unit) => oldUnits.get(unit.key)?.fingerprint !== unit.fingerprint);

  const unitByName = new Map<string, number>();
  after.units.forEach((unit, index) => {
    for (const name of unit.names) unitByName.set(name, index);
  });

  /** The shortest path of units from `start` to a changed one, `start` left out; null when none changed. */
  const pathToChange = (start: number): Array<number> | null => {
    const previous = new Map<number, number>([[start, -1]]);
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift() ?? start;
      if (current !== start && changed[current] === true) {
        const path: Array<number> = [];
        for (let step = current; step !== start; step = previous.get(step) ?? start) path.unshift(step);
        return path;
      }
      for (const name of after.units[current]?.references ?? []) {
        const next = unitByName.get(name);
        if (next !== undefined && !previous.has(next)) {
          previous.set(next, current);
          queue.push(next);
        }
      }
    }
    return null;
  };

  const oldExports = new Map(before.exports.map((entry) => [entry.name, entry]));
  const newNames = new Set(after.exports.map((entry) => entry.name));
  const exports: Array<ExportChange> = [];
  const seen = new Set<string>();

  for (const entry of after.exports) {
    // A name exported twice (`export * from` several modules): once is enough.
    if (seen.has(`${entry.name}:${entry.signature}`)) continue;
    seen.add(`${entry.name}:${entry.signature}`);

    const previous = oldExports.get(entry.name);
    if (previous === undefined) {
      exports.push({ ...base(entry), status: "added", signatureChanged: false, oldSignature: null, via: [] });
      continue;
    }

    const signatureChanged = previous.kind !== entry.kind || signatureKey(previous.signature) !== signatureKey(entry.signature) || previous.typeOnly !== entry.typeOnly;
    const ownCodeChanged = entry.unit !== null && changed[entry.unit] === true;
    if (signatureChanged || ownCodeChanged) {
      exports.push({ ...base(entry), status: "changed", signatureChanged, oldSignature: previous.signature, via: [] });
      continue;
    }

    const path = entry.unit === null ? null : pathToChange(entry.unit);
    if (path !== null) {
      exports.push({ ...base(entry), status: "affected", signatureChanged: false, oldSignature: null, via: path.map((index) => after.units[index]?.label ?? "") });
      continue;
    }

    exports.push({ ...base(entry), status: "unchanged", signatureChanged: false, oldSignature: null, via: [] });
  }

  for (const entry of before.exports) {
    if (newNames.has(entry.name) || seen.has(`removed:${entry.name}`)) continue;
    seen.add(`removed:${entry.name}`);
    exports.push({ ...base(entry), status: "removed", signatureChanged: false, oldSignature: entry.signature, signature: null, via: [] });
  }

  // What exports and top-level statements use, through any number of steps.
  const exportUnits = new Set(after.exports.map((entry) => entry.unit).filter((unit) => unit !== null));
  const reachable = new Set<number>();
  const queue = after.units.flatMap((unit, index) => (exportUnits.has(index) || unit.kind === "statement" ? [index] : []));
  for (const index of queue) reachable.add(index);
  while (queue.length > 0) {
    const current = queue.shift() ?? 0;
    for (const name of after.units[current]?.references ?? []) {
      const next = unitByName.get(name);
      if (next !== undefined && !reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const unreachable: Array<ChangedUnit> = [];
  const statements: Array<ChangedUnit> = [];
  after.units.forEach((unit, index) => {
    if (changed[index] !== true) return;
    if (unit.kind === "statement") {
      // A CommonJS export's statement shows as that export.
      if (!exportUnits.has(index)) statements.push(show(unit));
    } else if (after.exports.length > 0 && !reachable.has(index)) {
      unreachable.push(show(unit));
    }
  });

  return { exports, unreachable, statements };
}

/**
 * A signature without what formatting changes: whitespace, semicolons,
 * trailing commas. `(a: string, b: number,)` equals `(a:string, b:number)`.
 */
function signatureKey(signature: string | null): string | null {
  if (signature === null) return null;
  return signature.replace(/\s+/g, "").replace(/;/g, "").replace(/,(?=[)\]}>])/g, "");
}

function base(entry: TopLevel["exports"][number]) {
  return { name: entry.name, kind: entry.kind, typeOnly: entry.typeOnly, signature: entry.signature };
}

function show(unit: TopLevelUnit): ChangedUnit {
  return { label: unit.label, line: unit.line, kind: unit.kind };
}
