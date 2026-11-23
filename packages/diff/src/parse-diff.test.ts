import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "#/parse-diff.ts";

test("modified file with two hunks and line numbers", () => {
  const files = parseDiff(
    [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@ export function main() {",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " return a;",
      "@@ -10 +11 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
  );

  assert.equal(files.length, 1);
  const file = files[0]!;
  assert.equal(file.status, "modified");
  assert.equal(file.path, "src/app.ts");
  assert.equal(file.oldMode, "100644");
  assert.equal(file.oldBlob, "1111111");
  assert.equal(file.newBlob, "2222222");
  assert.equal(file.additions, 3);
  assert.equal(file.deletions, 2);
  assert.equal(file.hunks.length, 2);
  assert.equal(file.hunks[0]!.section, "export function main() {");
  assert.deepEqual(
    file.hunks[0]!.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    [
      ["context", 1, 1],
      ["removed", 2, null],
      ["added", null, 2],
      ["added", null, 3],
      ["context", 3, 4],
    ],
  );
  assert.equal(file.hunks[1]!.oldLines, 1);
  assert.deepEqual(file.hunks[1]!.lines.map((line) => [line.oldLine, line.newLine]), [
    [10, null],
    [null, 11],
  ]);
});

test("added, deleted and binary files", () => {
  const files = parseDiff(
    [
      "diff --git a/new file.ts b/new file.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/new file.ts",
      "@@ -0,0 +1 @@",
      "+hello",
      "\\ No newline at end of file",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100755",
      "index 4444444..0000000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "diff --git a/logo.png b/logo.png",
      "index 5555555..6666666 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n"),
  );

  assert.deepEqual(
    files.map((file) => [file.status, file.oldPath, file.newPath, file.path, file.binary]),
    [
      ["added", null, "new file.ts", "new file.ts", false],
      ["deleted", "gone.ts", null, "gone.ts", false],
      ["modified", "logo.png", "logo.png", "logo.png", true],
    ],
  );
  assert.equal(files[0]!.hunks[0]!.lines[0]!.noNewlineAtEnd, true);
  assert.deepEqual([files[0]!.oldBlob, files[0]!.newBlob], [null, "3333333"]);
  assert.deepEqual([files[1]!.oldBlob, files[1]!.newBlob], ["4444444", null]);
  assert.equal(files[1]!.oldMode, "100755");
});

test("rename with quoted, non-ASCII paths", () => {
  const files = parseDiff(
    [
      'diff --git "a/caf\\303\\251.ts" "b/tab\\there.ts"',
      "similarity index 92%",
      'rename from "caf\\303\\251.ts"',
      'rename to "tab\\there.ts"',
      "index 7777777..8888888 100644",
      "",
    ].join("\n"),
  );

  assert.equal(files[0]!.status, "renamed");
  assert.equal(files[0]!.oldPath, "café.ts");
  assert.equal(files[0]!.newPath, "tab\there.ts");
  assert.equal(files[0]!.similarity, 92);
});
