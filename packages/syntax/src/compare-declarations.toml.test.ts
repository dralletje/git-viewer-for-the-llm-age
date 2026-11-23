import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { analyzeSource } from "#/analyze.ts";
import { compareDeclarations } from "#/compare-declarations.ts";

/** The file before and after (see compare-declarations.toml): what compareDeclarations makes of them, as TOML can say it. */
async function declarations(input: { before: string; after: string }): Promise<Array<TomlValue>> {
  const before = input.before.split("\n");
  const after = input.after.split("\n");
  const [old, next] = await Promise.all([analyzeSource("typescript", input.before), analyzeSource("typescript", input.after)]);
  return compareDeclarations(old.topLevel, next.topLevel, before, after).map((change) => {
    const shown: Record<string, TomlValue> = { status: change.status, label: change.label };
    if (change.typeOnly) shown.typeOnly = true;
    if (change.via.length > 0) shown.via = change.via;
    if (change.uses.length > 0) {
      shown.uses = change.uses.map((use) => {
        const line = after[use.line - 1] ?? "";
        return `${use.line}: ${line.slice(0, use.start)}«${line.slice(use.start, use.end)}»${line.slice(use.end)} (${use.status})`;
      });
    }
    return shown;
  });
}

const source = new URL("./compare-declarations.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  declarations,
  {
    describe,
    it,
    // The TOML parser's tables have no prototype; strict equality would count that. Compare as plain objects.
    equal: (actual, expected) => assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected))),
  },
  "compare-declarations.toml",
);
