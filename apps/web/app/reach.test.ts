import { test } from "node:test";
import assert from "node:assert/strict";
import { languageForPath, scanSource } from "@room/syntax";
import type { Point } from "#/points.ts";
import { computeReach, createResolver, parseJsonc, type ScannedFile } from "#/reach.ts";

/** A tree of files by path: scanned, with its package.json and tsconfig.json files as configs; `points` as a .room.toml names them. */
async function reachOf(tree: Record<string, string>, points: Array<Point> = []) {
  const configs = new Map(Object.entries(tree).filter(([path]) => /(^|\/)(package|tsconfig)\.json$/.test(path)));
  const scanned: Array<ScannedFile> = [];
  for (const [path, source] of Object.entries(tree)) {
    const language = languageForPath(path);
    if (language === null) continue;
    scanned.push({ path, ...(await scanSource(language, source)) });
  }
  const resolve = createResolver(Object.keys(tree), configs);
  return computeReach(scanned, resolve, points);
}

/** Each file's reach as "capability: path:line via → ...". */
function show(reach: Awaited<ReturnType<typeof reachOf>>, path: string): Array<string> {
  return [...(reach.get(path) ?? [])].map(([capability, chain]) => `${capability}: ${chain.map((step) => `${step.path}:${step.line} ${step.via}`).join(" → ")}`);
}

test("reach goes through imports, by the shortest chain", async () => {
  const reach = await reachOf({
    "src/db.ts": 'import { Pool } from "pg";\nexport const pool = new Pool();',
    "src/users.ts": 'import { pool } from "./db.ts";\nexport const users = () => pool.query("select 1");',
    "src/route.ts": 'import { users } from "./users.ts";\nimport { pool } from "./db.ts";\nexport const loader = users;',
    "src/math.ts": "export const add = (a: number, b: number) => a + b;",
  });
  assert.deepEqual(show(reach, "src/db.ts"), ["database: src/db.ts:1 pg"]);
  assert.deepEqual(show(reach, "src/users.ts"), ["database: src/users.ts:1 ./db.ts → src/db.ts:1 pg"]);
  // Two ways to the database: the direct import of db.ts is the shorter one.
  assert.deepEqual(show(reach, "src/route.ts"), ["database: src/route.ts:2 ./db.ts → src/db.ts:1 pg"]);
  assert.deepEqual(show(reach, "src/math.ts"), []);
});

test("type-only imports don't carry reach, and cycles end", async () => {
  const reach = await reachOf({
    "a.ts": 'import type { B } from "./b.ts";\nexport type A = B;',
    "b.ts": 'import { c } from "./c.ts";\nexport type B = string;\nexport const b = () => fetch("/b");',
    "c.ts": 'import { b } from "./b.ts";\nexport const c = 1;',
  });
  assert.deepEqual(show(reach, "a.ts"), []);
  assert.deepEqual(show(reach, "b.ts"), ["network: b.ts:3 fetch()"]);
  assert.deepEqual(show(reach, "c.ts"), ["network: c.ts:1 ./b.ts → b.ts:3 fetch()"]);
});

test("an imported name leads past a barrel file to the file that has it", async () => {
  const reach = await reachOf({
    "git/index.ts": 'export { parse } from "./parse.ts";\nexport { run } from "./run.ts";\nexport * from "./files.ts";',
    "git/parse.ts": "export const parse = (input: string) => input.trim();",
    "git/run.ts": 'import { spawn } from "node:child_process";\nexport const run = () => spawn("git");',
    "git/files.ts": 'import { readFile } from "node:fs/promises";\nexport const read = (path: string) => readFile(path);',
    "app/only-parse.ts": 'import { parse } from "../git/index.ts";\nexport const a = parse(" x ");',
    "app/runs.ts": 'import { parse, run } from "../git/index.ts";\nexport const b = run;',
    "app/star.ts": 'import { read } from "../git/index.ts";\nexport const c = read;',
    "app/namespace.ts": 'import * as git from "../git/index.ts";\nexport const d = git;',
  });
  assert.deepEqual(show(reach, "app/only-parse.ts"), []);
  assert.deepEqual(show(reach, "app/runs.ts"), ["process: app/runs.ts:1 ../git/index.ts → git/run.ts:1 node:child_process"]);
  // Through `export *`: found in the module that has the name.
  assert.deepEqual(show(reach, "app/star.ts"), ["filesystem: app/star.ts:1 ../git/index.ts → git/files.ts:1 node:fs/promises"]);
  // The whole module: everything it passes on.
  assert.deepEqual(show(reach, "app/namespace.ts"), [
    "filesystem: app/namespace.ts:1 ../git/index.ts → git/index.ts:3 ./files.ts → git/files.ts:1 node:fs/promises",
    "process: app/namespace.ts:1 ../git/index.ts → git/index.ts:2 ./run.ts → git/run.ts:1 node:child_process",
  ]);
  // The barrel itself shows everything it gives.
  assert.deepEqual(show(reach, "git/index.ts"), [
    "filesystem: git/index.ts:3 ./files.ts → git/files.ts:1 node:fs/promises",
    "process: git/index.ts:2 ./run.ts → git/run.ts:1 node:child_process",
  ]);
});

test("re-exported names: renamed, default, from a package, and through two barrels", async () => {
  const reach = await reachOf({
    "lib/db.ts": 'import { Pool } from "pg";\nexport default new Pool();',
    "lib/math.ts": "export function add(a: number, b: number) { return a + b; }",
    "lib/index.ts": 'export { default as db } from "./db.ts";\nexport { add as plus } from "./math.ts";\nexport { readFile } from "node:fs/promises";',
    "index.ts": 'export * from "./lib/index.ts";',
    "uses-plus.ts": 'import { plus } from "./index.ts";\nexport const a = plus(1, 2);',
    "uses-db.ts": 'import { db } from "./index.ts";\nexport const b = db;',
    "uses-fs.ts": 'import { readFile } from "./lib/index.ts";\nexport const c = readFile;',
  });
  assert.deepEqual(show(reach, "uses-plus.ts"), []);
  assert.deepEqual(show(reach, "uses-db.ts"), ["database: uses-db.ts:1 ./index.ts → lib/db.ts:1 pg"]);
  assert.deepEqual(show(reach, "uses-fs.ts"), ["filesystem: uses-fs.ts:1 ./lib/index.ts → lib/index.ts:3 node:fs/promises"]);
});

test("types lead nowhere: inline type imports, exported types, type-only re-exports", async () => {
  const reach = await reachOf({
    "git/repository.ts": 'import { readFile } from "node:fs/promises";\nexport type Repository = { dir: string };\nexport const open = () => readFile("x");',
    "git/github.ts": "export const parse = (input: string) => input;",
    "git/index.ts": 'export { parse } from "./github.ts";\nexport { open } from "./repository.ts";\nexport type { Repository } from "./repository.ts";',
    "inline.ts": 'import { parse, type Repository } from "./git/index.ts";\nexport const a = parse;',
    "only-types.ts": 'import { type Repository } from "./git/index.ts";\nexport const b = 1;',
    "exported-type.ts": 'import { Repository } from "./git/repository.ts";\nexport const c = 1;',
  });
  assert.deepEqual(show(reach, "inline.ts"), []);
  assert.deepEqual(show(reach, "only-types.ts"), []);
  // An exported type, imported without `type`: still only a type.
  assert.deepEqual(show(reach, "exported-type.ts"), []);
});

test("an imported name reaches what its own code reaches, not the rest of its file", async () => {
  const reach = await reachOf({
    "mixed.ts": [
      'import { readFile } from "node:fs/promises";',
      "export const pure = (a: number) => a * 2;",
      "const read = (path: string) => readFile(path);",
      "export const load = () => read('config.json');",
      "export const loadTwice = () => [load(), load()];",
    ].join("\n"),
    "uses-pure.ts": 'import { pure } from "./mixed.ts";\nexport const a = pure(1);',
    "uses-load.ts": 'import { load } from "./mixed.ts";\nexport const b = load;',
    "uses-twice.ts": 'import { loadTwice } from "./mixed.ts";\nexport const c = loadTwice;',
  });
  assert.deepEqual(show(reach, "uses-pure.ts"), []);
  // Through `read`, in the same file: the chain lists the imports, not the code within a file.
  assert.deepEqual(show(reach, "uses-load.ts"), ["filesystem: uses-load.ts:1 ./mixed.ts → mixed.ts:1 node:fs/promises"]);
  assert.deepEqual(show(reach, "uses-twice.ts"), ["filesystem: uses-twice.ts:1 ./mixed.ts → mixed.ts:1 node:fs/promises"]);
  // The file as a whole reaches it.
  assert.deepEqual(show(reach, "mixed.ts"), ["filesystem: mixed.ts:1 node:fs/promises"]);
});

test("top-level statements run on load: importing any name from the file reaches what they do", async () => {
  const reach = await reachOf({
    "setup.ts": 'export const name = "app";\nawait fetch("/ready");',
    "side-effect.ts": 'import "./setup.ts";\nexport const a = 1;',
    "named.ts": 'import { name } from "./setup.ts";\nexport const b = name;',
    "deep.ts": 'import { b } from "./named.ts";\nexport const c = b;',
  });
  assert.deepEqual(show(reach, "side-effect.ts"), ["network: side-effect.ts:1 ./setup.ts → setup.ts:2 fetch()"]);
  assert.deepEqual(show(reach, "named.ts"), ["network: named.ts:1 ./setup.ts → setup.ts:2 fetch()"]);
  // Loading named.ts loads setup.ts.
  assert.deepEqual(show(reach, "deep.ts"), ["network: deep.ts:1 ./named.ts → named.ts:1 ./setup.ts → setup.ts:2 fetch()"]);
});

test("an imported name passed on with export { a } leads on to its own file", async () => {
  const reach = await reachOf({
    "db.ts": 'import { Pool } from "pg";\nexport const pool = new Pool();\nexport const two = 2;',
    "pass.ts": 'import { pool, two } from "./db.ts";\nexport { pool, two };',
    "uses-two.ts": 'import { two } from "./pass.ts";\nexport const a = two;',
    "uses-pool.ts": 'import { pool } from "./pass.ts";\nexport const b = pool;',
  });
  assert.deepEqual(show(reach, "uses-two.ts"), []);
  assert.deepEqual(show(reach, "uses-pool.ts"), ["database: uses-pool.ts:1 ./pass.ts → pass.ts:1 ./db.ts → db.ts:1 pg"]);
});

test("the chain names what each import brings in", async () => {
  const reach = await reachOf({
    "db.ts": 'import { Pool } from "pg";\nexport const pool = new Pool();',
    "app.ts": 'import { pool } from "./db.ts";\nexport const a = pool;',
  });
  assert.deepEqual(
    reach.get("app.ts")?.get("database")?.map((step) => step.name),
    ["pool", "Pool"],
  );
});

test("points: a package, a file and a declaration; each takes over what it would give, and is a wall", async () => {
  const point = (name: string, rest: Partial<Point>): Point => ({ name, about: null, packages: [], files: [], declarations: [], ...rest });
  const reach = await reachOf(
    {
      "sms/twilio.ts": 'export const send = (to: string) => fetch("https://api.twilio.com", { body: to });',
      "db.ts": 'import { Pool } from "pg";\nexport const db = new Pool();\nexport const ping = () => fetch("/ping");',
      "record.ts": 'import { MedplumClient } from "@medplum/core";\nexport const medplum = new MedplumClient();',
      "notify.ts": 'import { send } from "./sms/twilio.ts";\nexport const notify = () => send("+31");',
      "users.ts": 'import { db, ping } from "./db.ts";\nexport const users = () => db.query("select 1");\nexport const up = ping;',
      "patient.ts": 'import { medplum } from "./record.ts";\nexport const read = () => medplum.readResource("Patient", "1");',
    },
    [
      point("Medplum", { packages: ["@medplum/*"] }),
      point("App database", { declarations: ["db.ts#db"] }),
      point("Twilio", { files: ["sms/twilio*.ts"] }),
    ],
  );
  // Twilio's own code uses fetch: it only says Twilio, and so does what uses it.
  assert.deepEqual(show(reach, "sms/twilio.ts"), ["point:Twilio: sms/twilio.ts:1 send"]);
  assert.deepEqual(show(reach, "notify.ts"), ["point:Twilio: notify.ts:1 ./sms/twilio.ts → sms/twilio.ts:1 send"]);
  // The database's declaration takes over pg; ping, beside it, still reaches the network.
  assert.deepEqual(show(reach, "users.ts"), ["point:App database: users.ts:1 ./db.ts → db.ts:2 db", "network: users.ts:1 ./db.ts → db.ts:3 fetch()"]);
  // A package a point names gives the point, not its capability.
  assert.deepEqual(show(reach, "patient.ts"), ["point:Medplum: patient.ts:1 ./record.ts → record.ts:1 @medplum/core"]);
});

test("CommonJS counts as a whole", async () => {
  const reach = await reachOf({
    "legacy.js": 'const fs = require("fs");\nmodule.exports = { pure: (a) => a, read: (p) => fs.readFileSync(p) };',
    "app.js": 'const { pure } = require("./legacy.js");\nmodule.exports = pure;',
  });
  assert.deepEqual(show(reach, "app.js"), ["filesystem: app.js:1 ./legacy.js → legacy.js:1 fs"]);
});

test("resolves extensions, .js for .ts, and index files", () => {
  const resolve = createResolver(["src/a.ts", "src/b.tsx", "src/lib/index.ts", "src/c.js"], new Map());
  assert.equal(resolve("src/x.ts", "./a"), "src/a.ts");
  assert.equal(resolve("src/x.ts", "./a.js"), "src/a.ts");
  assert.equal(resolve("src/x.ts", "./b.js"), "src/b.tsx");
  assert.equal(resolve("src/x.ts", "./lib"), "src/lib/index.ts");
  assert.equal(resolve("src/deep/x.ts", "../c.js"), "src/c.js");
  assert.equal(resolve("src/x.ts", "./missing"), null);
  assert.equal(resolve("src/x.ts", "react"), null);
  assert.equal(resolve("x.ts", "../outside.ts"), null);
});

test("resolves package.json imports, tsconfig paths and workspace packages", () => {
  const configs = new Map([
    ["apps/web/package.json", JSON.stringify({ name: "@room/web", imports: { "#/*": "./app/*" } })],
    ["apps/web/tsconfig.json", '{\n  // comments, as tsconfig allows\n  "compilerOptions": { "paths": { "@/*": ["./app/*"], }, },\n}'],
    ["packages/git/package.json", JSON.stringify({ name: "@room/git", exports: { ".": "./src/index.ts", "./tree": { types: "./src/tree.d.ts", default: "./src/tree.ts" } } })],
    ["packages/old/package.json", JSON.stringify({ name: "old", main: "lib/main.js" })],
  ]);
  const resolve = createResolver(
    ["apps/web/app/paths.ts", "packages/git/src/index.ts", "packages/git/src/tree.ts", "packages/old/lib/main.js", "packages/git/src/run.ts"],
    configs,
  );
  assert.equal(resolve("apps/web/app/routes/x.tsx", "#/paths.ts"), "apps/web/app/paths.ts");
  assert.equal(resolve("apps/web/app/routes/x.tsx", "@/paths"), "apps/web/app/paths.ts");
  assert.equal(resolve("apps/web/app/x.ts", "@room/git"), "packages/git/src/index.ts");
  assert.equal(resolve("apps/web/app/x.ts", "@room/git/tree"), "packages/git/src/tree.ts");
  assert.equal(resolve("apps/web/app/x.ts", "old"), "packages/old/lib/main.js");
  // `#` imports belong to the package they're in: packages/git has none.
  assert.equal(resolve("packages/git/src/index.ts", "#/run.ts"), null);
});

test("JSON with comments and trailing commas, but not in strings", () => {
  assert.deepEqual(parseJsonc('{ "a": "// not a comment", /* b */ "c": [1, 2,], }'), { a: "// not a comment", c: [1, 2] });
  assert.equal(parseJsonc("{ nope"), null);
});
