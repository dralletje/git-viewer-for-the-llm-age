import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { scanSource } from "@room/syntax";
import { declarationGraph } from "#/declaration-graph.ts";
import { parsePoints } from "#/points.ts";
import { createResolver, type ScannedFile } from "#/reach.ts";
import { reachOf } from "#/targets.ts";

/** What each declaration reaches, with the repository's points (see points.toml). */
async function reached(input: { toml: string; files: Record<string, string> }): Promise<Array<TomlValue>> {
  const files: Array<ScannedFile> = await Promise.all(Object.entries(input.files).map(async ([path, source]) => ({ path, ...(await scanSource("typescript", source)) })));
  const graph = declarationGraph(files, createResolver(Object.keys(input.files), new Map()));
  const { points, problems } = parsePoints(input.toml);
  assert.deepEqual(problems, []);
  const lines: Array<string> = [];
  for (const [id, targets] of reachOf(graph, points)) {
    const declaration = graph.declarations.get(id);
    const names = [...targets.keys()].sort((a, b) => Number(b.startsWith("point:")) - Number(a.startsWith("point:")) || a.localeCompare(b));
    lines.push(`${declaration?.path} ${declaration?.label}: ${names.map((name) => name.replace(/^(point|capability):/, "")).join(", ")}`);
  }
  return lines.sort();
}

const source = new URL("./points.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  reached,
  {
    describe,
    it,
    // The TOML parser's tables have no prototype; strict equality would count that. Compare as plain values.
    equal: (actual, expected) => assert.deepStrictEqual(actual, JSON.parse(JSON.stringify(expected))),
  },
  "points.toml",
);
