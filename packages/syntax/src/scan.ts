import { findGlobalUses, type GlobalUse } from "#/globals.ts";
import { extractImports, type Import } from "#/imports.ts";
import { loadLanguage, type LanguageName } from "#/languages.ts";
import { localExportNames, type LocalExports } from "#/local-exports.ts";
import { moduleGraph, type ModuleGraph } from "#/module-graph.ts";
import { extractTopLevel } from "#/top-level.ts";

/**
 * What a scan of a whole repository needs from one file: its imports, every
 * use of a global, the names it exports from its own code (values and
 * types apart, see `localExportNames`), and its module graph, to follow an
 * imported name to the code that has it and on through what that code
 * uses. Null `module`: the file couldn't be parsed.
 */
export type SourceScan = {
  imports: Array<Import>;
  globals: Array<GlobalUse>;
  localExports: LocalExports | null;
  module: ModuleGraph | null;
};

/** Parses a source for what a repository scan needs: no highlighting, no fingerprints kept. */
export async function scanSource(language: LanguageName, source: string): Promise<SourceScan> {
  const loaded = await loadLanguage(language);
  const tree = loaded.parser.parse(source);
  if (tree === null) return { imports: [], globals: [], localExports: null, module: null };
  try {
    const imports = extractImports(tree.rootNode);
    const globals = findGlobalUses(tree.rootNode);
    return {
      imports,
      globals,
      localExports: localExportNames(tree.rootNode),
      module: moduleGraph(extractTopLevel(tree.rootNode), imports, globals),
    };
  } finally {
    // The tree lives in WebAssembly memory, which the garbage collector doesn't see.
    tree.delete();
  }
}
