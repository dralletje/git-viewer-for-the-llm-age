import type { AnalyzedDeclaration, OutsideChange } from "#/analyze-diff.server.ts";

/**
 * A file's declarations, with its changed lines outside them where they
 * are: each run before the first declaration (still in the new file) that
 * starts after it, the rest at the end. A removed declaration keeps its
 * place after the one it followed.
 */
export function inFileOrder(
  declarations: Array<AnalyzedDeclaration>,
  outside: Array<OutsideChange>,
): Array<{ declaration: AnalyzedDeclaration } | { outside: OutsideChange }> {
  const runs = [...outside].sort((a, b) => a.at - b.at);
  const items: Array<{ declaration: AnalyzedDeclaration } | { outside: OutsideChange }> = [];
  let next = 0;
  for (const declaration of declarations) {
    if (declaration.after !== null) {
      while (next < runs.length && (runs[next]?.at ?? 0) <= declaration.after.startLine) {
        const run = runs[next];
        if (run !== undefined) items.push({ outside: run });
        next++;
      }
    }
    items.push({ declaration });
  }
  for (const run of runs.slice(next)) items.push({ outside: run });
  return items;
}
