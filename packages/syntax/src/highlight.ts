import type { Node, Query } from "web-tree-sitter";

/**
 * A run of text on one line and what it is: a capture name of the grammar's
 * highlight query ("keyword", "string", "function.method", ...), or null for
 * plain text.
 */
export type Token = { text: string; kind: string | null };

/** Every line of `source`, as tokens. */
export function highlightLines(root: Node, highlights: Query, source: string): Array<Array<Token>> {
  // Several patterns can capture the same node; the last listed wins.
  const chosen = new Map<number, { node: Node; name: string; pattern: number }>();
  for (const capture of highlights.captures(root)) {
    const previous = chosen.get(capture.node.id);
    if (previous === undefined || capture.patternIndex >= previous.pattern) {
      chosen.set(capture.node.id, { node: capture.node, name: capture.name, pattern: capture.patternIndex });
    }
  }

  // Paint outer nodes first, so a node inside another (an expression in a
  // template string) paints over it. Positions count UTF-16 units, as JS
  // strings do.
  const names: Array<string> = [];
  const kinds = new Int32Array(source.length).fill(-1);
  const ordered = [...chosen.values()].sort((a, b) => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex);
  for (const { node, name } of ordered) {
    let index = names.indexOf(name);
    if (index === -1) index = names.push(name) - 1;
    kinds.fill(index, node.startIndex, node.endIndex);
  }

  const lines: Array<Array<Token>> = [];
  let start = 0;
  for (const text of source.split("\n")) {
    const tokens: Array<Token> = [];
    let runStart = 0;
    for (let offset = 1; offset <= text.length; offset++) {
      if (offset === text.length || kinds[start + offset] !== kinds[start + runStart]) {
        const kind = kinds[start + runStart] ?? -1;
        tokens.push({ text: text.slice(runStart, offset), kind: kind === -1 ? null : (names[kind] ?? null) });
        runStart = offset;
      }
    }
    lines.push(tokens);
    start += text.length + 1;
  }
  return lines;
}
