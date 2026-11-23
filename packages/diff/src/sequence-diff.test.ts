import assert from "node:assert/strict";
import { test } from "node:test";
import { changedWords, changedWordsInLines, diffSequences } from "#/sequence-diff.ts";

const show = (a: Array<string>, b: Array<string>) =>
  diffSequences(a, b).map((step) => (step.kind === "same" ? ` ${a[step.a]}` : step.kind === "removed" ? `-${a[step.a]}` : `+${b[step.b]}`));

test("diffSequences keeps what both have, removed before added", () => {
  assert.deepEqual(show(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]), [" a", "-b", "+x", " c", " d", "+e"]);
  assert.deepEqual(show([], ["a"]), ["+a"]);
  assert.deepEqual(show(["a"], []), ["-a"]);
  assert.deepEqual(show(["a", "b"], ["a", "b"]), [" a", " b"]);
});

test("changedWords marks only the words that differ", () => {
  assert.deepEqual(changedWords("const timeout = 30;", "const timeout = 60;"), { before: [[16, 18]], after: [[16, 18]] });
  const marked = changedWords("call(a, b)", "call(a, b, c)");
  assert.deepEqual(marked?.before, []);
  assert.equal("call(a, b, c)".slice(...(marked?.after[0] ?? [0, 0])), ", c");
});

test("changedWords gives up on lines with little in common", () => {
  assert.equal(changedWords("return user.name;", "throw new Error('nope')"), null);
});

test("changedWordsInLines pairs removed and added runs in order", () => {
  const result = changedWordsInLines([
    { kind: "context", text: "function f() {" },
    { kind: "removed", text: "  return 1;" },
    { kind: "added", text: "  return 2;" },
    { kind: "added", text: "  // extra" },
    { kind: "context", text: "}" },
  ]);
  assert.deepEqual(result, [null, [[9, 10]], [[9, 10]], null, null]);
});
