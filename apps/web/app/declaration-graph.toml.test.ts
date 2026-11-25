import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { scanSource } from "@room/syntax";
import { declarationGraph } from "#/declaration-graph.ts";
import { createResolver, type ScannedFile } from "#/reach.ts";

/** Every use in the repository's declaration graph (see declaration-graph.toml). */
async function uses(input: Record<string, string>): Promise<Array<TomlValue>> {
  const files: Array<ScannedFile> = await Promise.all(Object.entries(input).map(async ([path, source]) => ({ path, ...(await scanSource("typescript", source)) })));
  const graph = declarationGraph(files, createResolver(Object.keys(input), new Map()));
  const name = (id: string) => {
    const declaration = graph.declarations.get(id);
    return declaration === undefined ? id : `${declaration.path} ${declaration.label}`;
  };
  const lines: Array<string> = [];
  for (const [from, used] of graph.uses) for (const to of used) lines.push(`${name(from)} -> ${name(to)}`);
  for (const [from, outside] of graph.outside) for (const entry of outside.values()) lines.push(`${name(from)} -> outside ${entry.label}`);
  return lines.sort();
}

const source = new URL("./declaration-graph.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  uses,
  {
    describe,
    it,
    // The TOML parser's tables have no prototype; strict equality would count that. Compare as plain values.
    equal: (actual, expected) => assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected))),
  },
  "declaration-graph.toml",
);
