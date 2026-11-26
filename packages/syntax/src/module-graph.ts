import type { GlobalUse } from "#/globals.ts";
import type { Import } from "#/imports.ts";
import type { TopLevel } from "#/top-level.ts";

/**
 * A file's top level as a graph of the code that runs: which code an
 * exported name is, and what that code uses. Types are left out: they
 * don't run.
 */
export type ModuleGraph = {
  /** The top-level code, imports aside. */
  units: Array<ModuleUnit>;
  /**
   * The values the file exports from its own code, each to the unit that
   * is its code, or to an imported name it passes on (`import { a } from
   * "x"; export { a }`). Re-exports (`export ... from`) are among the imports.
   */
  exports: Array<{ name: string; unit: number } | { name: string; imported: string }>;
};

export type ModuleUnit = {
  /** The top-level names it declares; none for a statement or an `export default <expression>`. */
  names: Array<string>;
  /** A top-level statement: it runs when the file is loaded, used or not. */
  onLoad: boolean;
  /** 1-based, from the comments above it to its last line. */
  startLine: number;
  endLine: number;
  /** More of its code further down (see TopLevelUnit's `parts`). */
  parts: Array<{ startLine: number; endLine: number }>;
  /** The top-level names its code uses when it runs (its own names and types aside), imported names included. */
  uses: Array<string>;
  /** The globals its code uses. */
  globals: Array<GlobalUse>;
  /** The modules it `require`s or `import()`s. */
  loads: Array<{ source: string; line: number }>;
};

/** The module graph of a file, from its top level, its imports and its uses of globals (each unit gets the ones in its own lines). */
export function moduleGraph(topLevel: TopLevel, imports: Array<Import>, globals: Array<GlobalUse>): ModuleGraph {
  /** Index in `topLevel.units` to index in the graph's units, for the units kept. */
  const kept = new Map<number, number>();
  const units: Array<ModuleUnit> = [];
  const importNames = new Set(topLevel.units.filter((unit) => unit.kind === "import").flatMap((unit) => unit.names));
  // `runtimeReferences` has every name the code mentions: keep the top-level ones.
  const declared = new Set(topLevel.units.flatMap((unit) => unit.names));

  topLevel.units.forEach((unit, index) => {
    if (unit.kind === "import" || unit.typeOnly) return;
    const inside = (line: number) => [unit, ...unit.parts].some((part) => line >= part.startLine && line <= part.endLine);
    kept.set(index, units.length);
    units.push({
      names: unit.names,
      onLoad: unit.kind === "statement",
      startLine: unit.startLine,
      endLine: unit.endLine,
      parts: unit.parts.map((part) => ({ startLine: part.startLine, endLine: part.endLine })),
      uses: [...new Set(unit.runtimeReferences)].filter((name) => declared.has(name) && !unit.names.includes(name)),
      globals: globals.filter((use) => inside(use.line)),
      loads: imports
        .filter((entry) => (entry.kind === "require" || entry.kind === "dynamic-import") && inside(entry.line))
        .map((entry) => ({ source: entry.source, line: entry.line })),
    });
  });

  const exports: ModuleGraph["exports"] = [];
  for (const entry of topLevel.exports) {
    if (entry.typeOnly || entry.kind === "re-export" || entry.unit === null) continue;
    const unit = topLevel.units[entry.unit];
    const index = kept.get(entry.unit);
    if (index !== undefined) {
      exports.push({ name: entry.name, unit: index });
    } else if (unit !== undefined && unit.kind === "import" && importNames.has(unit.names[0] ?? "")) {
      exports.push({ name: entry.name, imported: unit.names[0] ?? "" });
    }
  }
  return { units, exports };
}
