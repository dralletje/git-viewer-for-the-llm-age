import type { Import } from "#/imports.ts";

/** What happened to one imported module between two versions of a file. */
export type ImportChange = {
  source: string;
  status: "added" | "removed" | "changed" | "unchanged";
  /** Only used for types, in every statement that imports it. */
  typeOnly: boolean;
  /** As shown: "React" (default), "* as path", "useState", "a as b". */
  bindings: Array<string>;
  addedBindings: Array<string>;
  removedBindings: Array<string>;
};

/**
 * Compares the imports of two versions of a file, per module: a module whose
 * statements moved around but that imports the same names is unchanged.
 * Ordered as the new file imports them, removed modules last.
 */
export function compareImports(before: Array<Import>, after: Array<Import>): Array<ImportChange> {
  const oldModules = byModule(before);
  const newModules = byModule(after);
  const changes: Array<ImportChange> = [];

  for (const [source, module] of newModules) {
    const previous = oldModules.get(source);
    if (previous === undefined) {
      changes.push({ source, status: "added", typeOnly: module.typeOnly, bindings: module.bindings, addedBindings: module.bindings, removedBindings: [] });
      continue;
    }
    const addedBindings = module.bindings.filter((binding) => !previous.bindings.includes(binding));
    const removedBindings = previous.bindings.filter((binding) => !module.bindings.includes(binding));
    const changed = addedBindings.length > 0 || removedBindings.length > 0 || previous.typeOnly !== module.typeOnly;
    changes.push({
      source,
      status: changed ? "changed" : "unchanged",
      typeOnly: module.typeOnly,
      bindings: module.bindings,
      addedBindings,
      removedBindings,
    });
  }

  for (const [source, module] of oldModules) {
    if (newModules.has(source)) continue;
    changes.push({ source, status: "removed", typeOnly: module.typeOnly, bindings: module.bindings, addedBindings: [], removedBindings: module.bindings });
  }

  return changes;
}

function byModule(imports: Array<Import>): Map<string, { typeOnly: boolean; bindings: Array<string> }> {
  const modules = new Map<string, { typeOnly: boolean; bindings: Array<string> }>();
  for (const statement of imports) {
    const module = modules.get(statement.source) ?? { typeOnly: true, bindings: [] };
    module.typeOnly = module.typeOnly && statement.typeOnly;
    for (const binding of statement.bindings) {
      const shown = showBinding(statement, binding.imported, binding.local);
      if (!module.bindings.includes(shown)) module.bindings.push(shown);
    }
    modules.set(statement.source, module);
  }
  return modules;
}

function showBinding(statement: Import, imported: string, local: string): string {
  if (statement.kind === "re-export" && imported === "*" && local === "*") return "*";
  if (imported === "*") return `* as ${local}`;
  if (imported === "default" && statement.kind === "import") return local;
  if (imported === local) return imported;
  return `${imported} as ${local}`;
}
