import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser, Query } from "web-tree-sitter";

export type LanguageName = "typescript" | "tsx" | "javascript";

/** The language of a file, by its extension; null when we can't parse it (yet). */
export function languageForPath(path: string): LanguageName | null {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  if (extension === "ts" || extension === "mts" || extension === "cts") return "typescript";
  if (extension === "tsx") return "tsx";
  if (extension === "js" || extension === "jsx" || extension === "mjs" || extension === "cjs") return "javascript";
  return null;
}

export type LoadedLanguage = {
  name: LanguageName;
  parser: Parser;
  highlights: Query;
};

const require = createRequire(import.meta.url);
// tree-sitter-typescript's highlights build on tree-sitter-javascript's: the
// version it depends on itself, not ours, so the two queries fit together.
const requireFromTypescript = createRequire(require.resolve("tree-sitter-typescript/package.json"));

/**
 * Where each grammar and its highlight queries are. The queries are written
 * for "the last pattern that captures a node wins": generic patterns first
 * (`(identifier) @variable`), specific ones after. So the base language goes
 * first and what TypeScript adds goes last, the reverse of the order the
 * grammar's tree-sitter.json lists them in.
 */
const grammars: Record<LanguageName, { wasm: string; highlights: Array<string> }> = {
  typescript: {
    wasm: require.resolve("tree-sitter-typescript/tree-sitter-typescript.wasm"),
    highlights: [
      requireFromTypescript.resolve("tree-sitter-javascript/queries/highlights.scm"),
      require.resolve("tree-sitter-typescript/queries/highlights.scm"),
    ],
  },
  tsx: {
    wasm: require.resolve("tree-sitter-typescript/tree-sitter-tsx.wasm"),
    highlights: [
      requireFromTypescript.resolve("tree-sitter-javascript/queries/highlights.scm"),
      requireFromTypescript.resolve("tree-sitter-javascript/queries/highlights-jsx.scm"),
      require.resolve("tree-sitter-typescript/queries/highlights.scm"),
    ],
  },
  javascript: {
    wasm: require.resolve("tree-sitter-javascript/tree-sitter-javascript.wasm"),
    highlights: [
      require.resolve("tree-sitter-javascript/queries/highlights.scm"),
      require.resolve("tree-sitter-javascript/queries/highlights-jsx.scm"),
      require.resolve("tree-sitter-javascript/queries/highlights-params.scm"),
    ],
  },
};

let initialized: Promise<void> | null = null;
const loaded = new Map<LanguageName, Promise<LoadedLanguage>>();

/** Loads a grammar and its queries once; every later call gets the same one. */
export function loadLanguage(name: LanguageName): Promise<LoadedLanguage> {
  const existing = loaded.get(name);
  if (existing !== undefined) return existing;

  const loading = (async () => {
    initialized ??= Parser.init();
    await initialized;
    const grammar = grammars[name];
    const language = await Language.load(grammar.wasm);
    const parser = new Parser();
    parser.setLanguage(language);
    const sources = await Promise.all(grammar.highlights.map((path) => readFile(path, "utf8")));
    const highlights = new Query(language, sources.join("\n"));
    return { name, parser, highlights };
  })();
  loaded.set(name, loading);
  return loading;
}
