import type { Node } from "web-tree-sitter";
import { highlightLines, type Token } from "#/highlight.ts";
import { extractImports, type Import } from "#/imports.ts";
import { loadLanguage, type LanguageName } from "#/languages.ts";
import { extractOutline, type OutlineNode } from "#/outline.ts";
import { extractTopLevel, type Export, type TopLevel } from "#/top-level.ts";

export type SourceAnalysis = {
  /** Every line of the source, as highlighted tokens. */
  lines: Array<Array<Token>>;
  imports: Array<Import>;
  exports: Array<Export>;
  /** The top level as a graph of units, for following changes to exports. */
  topLevel: TopLevel;
  /** The syntax tree, for comparing two versions part by part; null without `highlight` (only shown code needs it). */
  outline: OutlineNode | null;
  /**
   * The lines (1-based) inside a string or template literal, after the line
   * it starts on: there, even a blank line is part of a value.
   */
  literalLines: Array<number>;
};

/**
 * Parses a source once and takes from the tree what the views need.
 * Without `highlight`, `lines` is empty: highlighting is the costly part,
 * and a file whose code isn't shown doesn't need it.
 */
export async function analyzeSource(language: LanguageName, source: string, options: { highlight?: boolean } = {}): Promise<SourceAnalysis> {
  const loaded = await loadLanguage(language);
  const tree = loaded.parser.parse(source);
  if (tree === null) {
    return {
      lines: source.split("\n").map((text) => [{ text, kind: null }]),
      imports: [],
      exports: [],
      topLevel: { units: [], exports: [] },
      outline: null,
      literalLines: [],
    };
  }
  try {
    const topLevel = extractTopLevel(tree.rootNode);
    return {
      lines: options.highlight === false ? [] : highlightLines(tree.rootNode, loaded.highlights, source),
      imports: extractImports(tree.rootNode),
      exports: topLevel.exports,
      topLevel,
      outline: options.highlight === false ? null : extractOutline(tree.rootNode),
      literalLines: literalLinesIn(tree.rootNode),
    };
  } finally {
    // The tree lives in WebAssembly memory, which the garbage collector doesn't see.
    tree.delete();
  }
}

/** The lines inside multi-line strings and template literals, after their first line (see `literalLines`). */
function literalLinesIn(root: Node): Array<number> {
  const lines: Array<number> = [];
  const visit = (node: Node) => {
    // Nothing in a node on one line can be on a later one.
    if (node.startPosition.row === node.endPosition.row) return;
    if (node.type === "template_string" || node.type === "string") {
      for (let row = node.startPosition.row + 1; row <= node.endPosition.row; row++) lines.push(row + 1);
      return;
    }
    for (const child of node.children) {
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return lines;
}
