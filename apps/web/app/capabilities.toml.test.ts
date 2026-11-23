import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { scanSource } from "@room/syntax";
import { directCapabilities } from "#/capabilities.ts";

/** A TypeScript file (see capabilities.toml): what it reaches itself, as "<line> <capability> <via>". */
async function capabilities(input: string): Promise<Array<TomlValue>> {
  const { imports, globals } = await scanSource("typescript", input);
  return directCapabilities(imports, globals).map((entry) => `${entry.line} ${entry.capability} ${entry.via}`);
}

const source = new URL("./capabilities.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  capabilities,
  {
    describe,
    it,
    // The TOML parser's tables have no prototype; strict equality would count that. Compare as plain objects.
    equal: (actual, expected) => assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected))),
  },
  "capabilities.toml",
);
