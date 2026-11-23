import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSource } from "#/analyze.ts";
import { compareOutlines } from "#/outline.ts";

/** The changes in the first top-level statement, as "path old-lines new-lines". */
const compare = async (before: Array<string>, after: Array<string>) => {
  const [old, next] = await Promise.all([analyzeSource("typescript", before.join("\n")), analyzeSource("typescript", after.join("\n"))]);
  const first = (outline: typeof old.outline) => outline?.children[0];
  const a = first(old.outline);
  const b = first(next.outline);
  if (a === undefined || b === undefined) throw new Error("nothing parsed");
  return compareOutlines(a, b).map(
    (change) =>
      `${change.path.join(" › ")} [${change.context.map((entry) => entry.after).join(",")}] ${change.before === null ? "-" : `${change.before.startLine}-${change.before.endLine}`} ${change.after === null ? "-" : `${change.after.startLine}-${change.after.endLine}`}`,
  );
};

test("finds the method and the statement in it that changed", async () => {
  const before = [
    "export class Store {",
    "  load() {",
    "    const a = 1;",
    "    return a;",
    "  }",
    "  save(value: string) {",
    "    this.value = value;",
    "    log(value);",
    "  }",
    "}",
  ];
  const after = [
    "export class Store {",
    "  load() {",
    "    const a = 1;",
    "    return a;",
    "  }",
    "  save(value: string) {",
    "    this.value = value.trim();",
    "    log(value);",
    "  }",
    "}",
  ];
  assert.deepEqual(await compare(before, after), ["save() [1,6] 7-7 7-7"]);
});

test("names properties, calls and JSX on the way down, and tells additions apart", async () => {
  const before = [
    "export const config = {",
    "  name: 'x',",
    "  routes: [",
    "    route('/a'),",
    "  ],",
    "};",
  ];
  const after = [
    "export const config = {",
    "  name: 'x',",
    "  routes: [",
    "    route('/a'),",
    "    route('/b'),",
    "  ],",
    "};",
  ];
  assert.deepEqual(await compare(before, after), ["routes: › route('/b') [1,3] - 5-5"]);
});

test("an added property keeps the line of what it's in, as its context", async () => {
  const before = ["export const ClientErrorCode = {", "  NOT_FOUND: 'NOT_FOUND',", "  FORBIDDEN: 'FORBIDDEN',", "} as const;"];
  const after = [
    "export const ClientErrorCode = {",
    "  NOT_FOUND: 'NOT_FOUND',",
    "  FORBIDDEN: 'FORBIDDEN',",
    "  TOO_MANY_USER_IDS: 'TOO_MANY_USER_IDS',",
    "} as const;",
  ];
  assert.deepEqual(await compare(before, after), ["TOO_MANY_USER_IDS: [1] - 4-4"]);
});

test("formatting and comments aren't changes", async () => {
  const before = ["function f() {", "  // old note", "  return g(1, 2)", "}"];
  const after = ["function f() {", "  // new note", "  return g(", "    1,", "    2,", "  );", "}"];
  assert.deepEqual(await compare(before, after), []);
});
