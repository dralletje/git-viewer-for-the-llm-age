import type { LocalExports, ModuleGraph } from "@room/syntax";
import { capabilityOfGlobal, capabilityOfModule, type Capability } from "#/capabilities.ts";
import type { ScannedFile } from "#/reach.ts";

/**
 * One top-level declaration or statement of a file (see @room/syntax's
 * module graph: types aren't in it, they don't run). Its id is its file and
 * label, so the same declaration has the same id in two versions of the
 * repository. A file's statements (code that runs when it loads) are one
 * declaration: "top-level code".
 */
export type Declaration = {
  id: string;
  path: string;
  label: string;
  startLine: number;
  endLine: number;
  /** More of its code further down: a `X.displayName = ...` with other declarations between. */
  parts: Array<{ startLine: number; endLine: number }>;
  exported: boolean;
};

/** Something outside the repository's code that a declaration uses: a package (a name it imports from one), or a global that gives a capability. */
export type Outside = { id: string; label: string; capability: Capability | null };

/**
 * Every declaration of a repository, and what each one's code uses when it
 * runs: other declarations, in its file and, through imports and the
 * re-exports that pass them on, in others; and what's outside. Coarse:
 * using a name counts, wherever in the code and whatever it does with it;
 * `import * as x` uses all of x's exported declarations.
 */
export type DeclarationGraph = {
  declarations: Map<string, Declaration>;
  uses: Map<string, Set<string>>;
  usedBy: Map<string, Set<string>>;
  outside: Map<string, Map<string, Outside>>;
  /** Each unit of a file's module graph (by index) to its declaration's id. */
  unitIds: Map<string, Array<string>>;
};

/** A file's code that runs when it loads: its statements, one declaration. */
export const topLevelCode = "top-level code";

type Target = { declaration: string } | { outside: Outside };

export function declarationGraph(files: Array<ScannedFile>, resolve: (from: string, specifier: string) => string | null): DeclarationGraph {
  const byPath = new Map(files.map((scanned) => [scanned.path, scanned]));
  const followed = (scanned: ScannedFile | undefined): scanned is ScannedFile & { module: ModuleGraph; localExports: LocalExports } =>
    scanned !== undefined && scanned.module !== null && scanned.localExports !== null;

  const graph: DeclarationGraph = { declarations: new Map(), uses: new Map(), usedBy: new Map(), outside: new Map(), unitIds: new Map() };

  // The declarations.
  for (const scanned of files) {
    if (!followed(scanned)) continue;
    const ids = scanned.module.units.map((unit, index) => {
      const exportedAs = scanned.module.exports.filter((entry) => "unit" in entry && entry.unit === index).map((entry) => entry.name);
      const label = unit.names.length > 0 ? unit.names.join(", ") : exportedAs.includes("default") ? "default" : topLevelCode;
      const id = `${scanned.path}\0${label}`;
      const known = graph.declarations.get(id);
      graph.declarations.set(id, {
        id,
        path: scanned.path,
        label,
        startLine: known?.startLine ?? unit.startLine,
        endLine: unit.endLine,
        // Units that share an id (overloads) are one range to the last one's end: parts above that are in it.
        parts: [...(known?.parts ?? []), ...unit.parts].filter((part) => part.startLine > unit.endLine),
        exported: (known?.exported ?? false) || exportedAs.length > 0,
      });
      return id;
    });
    graph.unitIds.set(scanned.path, ids);
  }

  const packageOf = (source: string, imported: string | null): Outside => {
    const name = imported === null || imported === "*" ? null : imported;
    return {
      id: `outside\0${source}\0${name ?? ""}`,
      label: name === null ? source : name === "default" ? `${source} (default)` : `${source} { ${name} }`,
      capability: capabilityOfModule(source),
    };
  };
  const exportedOf = (path: string): Array<Target> => {
    const scanned = byPath.get(path);
    if (!followed(scanned)) return [];
    return scanned.module.exports.flatMap((entry) => ("unit" in entry ? [{ declaration: graph.unitIds.get(path)?.[entry.unit] ?? "" }] : []));
  };

  /** What a name a file imports (`local`) is: the declarations, or the package. Types: nothing. */
  const importTargets = (path: string, local: string, seen: Set<string>): Array<Target> => {
    const scanned = byPath.get(path);
    if (scanned === undefined) return [];
    for (const entry of scanned.imports) {
      if (entry.kind !== "import" || entry.typeOnly) continue;
      const binding = entry.bindings.find((candidate) => candidate.local === local);
      if (binding === undefined || binding.typeOnly) continue;
      const target = resolve(path, entry.source);
      if (target === null) return [{ outside: packageOf(entry.source, binding.imported) }];
      if (target === path) return [];
      if (binding.imported === "*") return exportedOf(target);
      return definers(target, binding.imported, seen) ?? [];
    }
    return [];
  };

  /** The declarations a name exported by `path` is, past re-exports; null when it doesn't export it (as far as syntax tells). */
  const definers = (path: string, name: string, seen: Set<string>): Array<Target> | null => {
    const key = `${path}\0${name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const scanned = byPath.get(path);
    if (!followed(scanned)) return [];
    if (scanned.localExports.types.includes(name)) return [];
    const own = scanned.module.exports.find((entry) => entry.name === name);
    if (own !== undefined) return "unit" in own ? [{ declaration: graph.unitIds.get(path)?.[own.unit] ?? "" }] : importTargets(path, own.imported, seen);

    const reExports = scanned.imports.filter((entry) => entry.kind === "re-export");
    for (const entry of reExports) {
      for (const binding of entry.bindings) {
        if (binding.local !== name || (binding.imported === "*" && binding.local === "*")) continue;
        if (entry.typeOnly || binding.typeOnly) return [];
        const target = resolve(path, entry.source);
        if (target === null) return [{ outside: packageOf(entry.source, binding.imported) }];
        if (binding.imported === "*") return exportedOf(target);
        return definers(target, binding.imported, seen) ?? [];
      }
    }
    // `export * from "x"` passes on every name x has, but not its default.
    if (name === "default") return null;
    for (const entry of reExports.filter((entry) => !entry.typeOnly)) {
      if (!entry.bindings.some((binding) => binding.imported === "*" && binding.local === "*")) continue;
      const target = resolve(path, entry.source);
      if (target === null) continue;
      const found = definers(target, name, seen);
      if (found !== null) return found;
    }
    return null;
  };

  const addUse = (from: string, target: Target) => {
    if ("declaration" in target) {
      if (target.declaration === "" || target.declaration === from) return;
      const uses = graph.uses.get(from) ?? new Set<string>();
      uses.add(target.declaration);
      graph.uses.set(from, uses);
      const usedBy = graph.usedBy.get(target.declaration) ?? new Set<string>();
      usedBy.add(from);
      graph.usedBy.set(target.declaration, usedBy);
    } else {
      const outside = graph.outside.get(from) ?? new Map<string, Outside>();
      outside.set(target.outside.id, target.outside);
      graph.outside.set(from, outside);
    }
  };

  // What each one uses.
  for (const scanned of files) {
    if (!followed(scanned)) continue;
    const ids = graph.unitIds.get(scanned.path) ?? [];
    const own = new Map<string, string>();
    scanned.module.units.forEach((unit, index) => {
      for (const name of unit.names) own.set(name, ids[index] ?? "");
    });
    scanned.module.units.forEach((unit, index) => {
      const from = ids[index] ?? "";
      for (const name of unit.uses) {
        const declared = own.get(name);
        if (declared !== undefined) addUse(from, { declaration: declared });
        else for (const target of importTargets(scanned.path, name, new Set())) addUse(from, target);
      }
      for (const use of unit.globals) {
        const global = capabilityOfGlobal(use);
        if (global !== null) addUse(from, { outside: { id: `outside\0global\0${global.via}`, label: global.via, capability: global.capability } });
      }
      for (const loaded of unit.loads) {
        const target = resolve(scanned.path, loaded.source);
        if (target === null) addUse(from, { outside: packageOf(loaded.source, null) });
        else if (target !== scanned.path) for (const exported of exportedOf(target)) addUse(from, exported);
      }
    });
  }
  return graph;
}
