import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { parseDiff } from "@room/diff";
import { analyzeFileDiff } from "#/analyze-diff.server.ts";
import { inFileOrder } from "#/declaration-order.ts";

/** git's diff of two versions of a file, as the app reads a commit's (full blob ids, which the analysis reads the contents by). */
async function diffOf(before: string, after: string) {
  const folder = await mkdtemp(join(tmpdir(), "room-outside-"));
  try {
    await writeFile(join(folder, "a.ts"), before);
    await writeFile(join(folder, "b.ts"), after);
    // Exits 1 when the files differ: that's the answer, not a failure.
    const patch = await new Promise<string>((resolve, reject) =>
      execFile("git", ["diff", "--no-index", "--full-index", "--no-color", "--no-ext-diff", "a.ts", "b.ts"], { cwd: folder }, (error, stdout) =>
        error !== null && error.code !== 1 ? reject(error) : resolve(stdout),
      ),
    );
    const file = parseDiff(patch)[0];
    if (file === undefined) throw new Error("no diff");
    return file;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** What the Declarations tab shows, in its order (see outside-changes.toml). */
async function shown(input: { before: string; after: string }): Promise<Array<TomlValue>> {
  const file = await diffOf(input.before, input.after);
  const blobs = new Map([
    [file.oldBlob ?? "", input.before],
    [file.newBlob ?? "", input.after],
  ]);
  const analyzed = await analyzeFileDiff(file, "typescript", blobs, true);

  return inFileOrder(analyzed.declarations ?? [], analyzed.outside ?? []).flatMap((item) => {
    if ("declaration" in item) return item.declaration.status === "unchanged" ? [] : [`declaration ${item.declaration.label}`];
    const run = item.outside;
    const range = run.after ?? run.before;
    return [`${run.kind} ${range?.startLine}-${range?.endLine} +${run.added} −${run.removed}${run.names.length > 0 ? ` ${run.names.join(", ")}` : ""}`];
  });
}

const source = new URL("./outside-changes.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  shown,
  {
    describe,
    it,
    // The TOML parser's tables have no prototype; strict equality would count that. Compare as plain values.
    equal: (actual, expected) => assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected))),
  },
  "outside-changes.toml",
);
