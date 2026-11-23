import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource } from "#/scan.ts";

async function globals(source: string): Promise<Array<string>> {
  const scan = await scanSource("typescript", source);
  return scan.globals.map((use) => `${use.line} ${use.kind} ${use.name}${use.property === null ? "" : `.${use.property}`}`);
}

test("calls, constructions and member reads on globals, every one", async () => {
  const source = ["fetch('/a');", "globalThis.fetch('/b');", "new WebSocket(url);", "const port = process.env.PORT;", "const mode = import.meta.env.MODE;"].join("\n");
  assert.deepEqual(await globals(source), [
    "1 call fetch",
    "2 call fetch",
    // `globalThis` is a global too: its member read is listed as well.
    "2 member globalThis.fetch",
    "3 new WebSocket",
    "4 member process.env",
    "5 member import.meta.env",
  ]);
});

test("a declared name isn't a global, in its scope only; a var in its whole function", async () => {
  const source = [
    "import { url } from './url.ts';",
    "function a(fetch: Fetch) { fetch(url); }",
    "function b() { if (x) { var process = {}; } return process.env; }",
    "function c() { { let eval = f; } eval('x'); }",
  ].join("\n");
  assert.deepEqual(await globals(source), ["4 call eval"]);
});

test("the module graph: each unit's names, what it uses, its globals, and the exports", async () => {
  const source = [
    'import { Pool } from "pg";',
    "const pool = new Pool();",
    "export function query() { return pool.query('select 1'); }",
    "export function add(a: number, b: number) { return a + b; }",
    "export const port = () => process.env.PORT;",
    "export type Row = { id: string };",
    "start();",
    "function start() { fetch('/ready'); }",
  ].join("\n");
  const { module } = await scanSource("typescript", source);
  assert.deepEqual(
    module?.units.map((unit) => ({ names: unit.names, onLoad: unit.onLoad, uses: unit.uses, globals: unit.globals.map((use) => use.name) })),
    [
      { names: ["pool"], onLoad: false, uses: ["Pool"], globals: [] },
      { names: ["query"], onLoad: false, uses: ["pool"], globals: [] },
      { names: ["add"], onLoad: false, uses: [], globals: [] },
      { names: ["port"], onLoad: false, uses: [], globals: ["process"] },
      // `start` is declared in the file (further down): not a global.
      { names: [], onLoad: true, uses: ["start"], globals: [] },
      { names: ["start"], onLoad: false, uses: [], globals: ["fetch"] },
    ],
  );
  assert.deepEqual(module?.exports, [
    { name: "query", unit: 1 },
    { name: "add", unit: 2 },
    { name: "port", unit: 3 },
  ]);
});
