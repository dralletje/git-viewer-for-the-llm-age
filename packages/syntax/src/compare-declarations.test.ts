import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSource } from "#/analyze.ts";
import { compareDeclarations } from "#/compare-declarations.ts";

const compare = async (before: Array<string>, after: Array<string>) => {
  const [old, next] = await Promise.all([analyzeSource("typescript", before.join("\n")), analyzeSource("typescript", after.join("\n"))]);
  return compareDeclarations(old.topLevel, next.topLevel, before, after).map(
    (change) =>
      `${change.status} ${change.label}${change.exported ? " (exported)" : ""} ${change.before === null ? "-" : `${change.before.startLine}-${change.before.endLine}`} ${change.after === null ? "-" : `${change.after.startLine}-${change.after.endLine}`}`,
  );
};

test("compareDeclarations matches by name and tells code changes from formatting", async () => {
  const before = [
    'import { x } from "./x.ts";',
    "/** Says hi. */",
    "export function greet(name: string) {",
    "  return `hi ${name}`;",
    "}",
    "const gone = 1;",
    "const spaced = { a: 1 };",
    "",
    "// a comment far from it",
    "",
    "export const value = 1;",
  ];
  const after = [
    'import { x } from "./x.ts";',
    "/** Says hello. */",
    "export function greet(name: string) {",
    "  return `hello ${name}`;",
    "}",
    "const spaced = {a: 1};",
    "export const value = 1;",
    "export const added = 2;",
  ];
  assert.deepEqual(await compare(before, after), [
    "changed greet (exported) 2-5 2-5",
    "removed gone 6-6 -",
    "formatting spaced 7-7 6-6",
    "unchanged value (exported) 11-11 7-7",
    "added added (exported) - 8-8",
  ]);
});
