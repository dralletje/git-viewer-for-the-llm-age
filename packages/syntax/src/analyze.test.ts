import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSource } from "#/analyze.ts";
import { compareImports } from "#/compare-imports.ts";
import { languageForPath } from "#/languages.ts";

test("finds every kind of import in TypeScript", async () => {
  const source = [
    'import React, { useState, useEffect as effect } from "react";',
    'import * as path from "node:path";',
    'import type { Config } from "./config.ts";',
    'import "./polyfill.ts";',
    'import fs = require("fs");',
    'export { helper as default, other } from "./helpers.ts";',
    'export * from "./all.ts";',
    'export * as ns from "./ns.ts";',
    "function later() {",
    '  const lodash = require("lodash");',
    '  return import("./lazy.ts");',
    "}",
    "require(dynamicName);",
  ].join("\n");

  const { imports } = await analyzeSource("typescript", source);
  assert.deepEqual(
    imports.map((entry) => [entry.kind, entry.source, entry.typeOnly, entry.bindings.map((binding) => `${binding.imported}:${binding.local}`), entry.line]),
    [
      ["import", "react", false, ["default:React", "useState:useState", "useEffect:effect"], 1],
      ["import", "node:path", false, ["*:path"], 2],
      ["import", "./config.ts", true, ["Config:Config"], 3],
      ["import", "./polyfill.ts", false, [], 4],
      ["import", "fs", false, ["*:fs"], 5],
      ["re-export", "./helpers.ts", false, ["helper:default", "other:other"], 6],
      ["re-export", "./all.ts", false, ["*:*"], 7],
      ["re-export", "./ns.ts", false, ["*:ns"], 8],
      ["require", "lodash", false, [], 10],
      ["dynamic-import", "./lazy.ts", false, [], 11],
    ],
  );
});

test("JSX in .tsx and .jsx files parses", async () => {
  const tsx = await analyzeSource("tsx", 'import { Link } from "react-router";\nexport const A = () => <Link to="/">home</Link>;\n');
  assert.deepEqual(tsx.imports.map((entry) => entry.source), ["react-router"]);
  const jsx = await analyzeSource("javascript", 'const x = require("x");\nconst el = <div className="a">{x}</div>;\n');
  assert.deepEqual(jsx.imports.map((entry) => entry.source), ["x"]);
});

test("highlights lines, and keeps their text exactly", async () => {
  const source = 'const name: string = `hi ${user}`; // café 😀\nexport function greet() {}\n';
  const { lines } = await analyzeSource("typescript", source);

  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((tokens) => tokens.map((token) => token.text).join("")),
    source.split("\n"),
  );
  const kinds = new Map(lines.flat().map((token) => [token.text, token.kind]));
  assert.equal(kinds.get("const"), "keyword");
  assert.equal(kinds.get("// café 😀"), "comment");
  assert.equal(kinds.get("greet"), "function");
  // The substitution inside the template string is painted over the string.
  assert.equal(kinds.get("user"), "variable");
});

test("compares imports per module", () => {
  const before = [
    { kind: "import" as const, source: "react", typeOnly: false, bindings: [{ imported: "useState", local: "useState", typeOnly: false }], line: 1 },
    { kind: "import" as const, source: "lodash", typeOnly: false, bindings: [{ imported: "default", local: "_", typeOnly: false }], line: 2 },
    { kind: "import" as const, source: "./a.ts", typeOnly: false, bindings: [], line: 3 },
  ];
  const after = [
    { kind: "import" as const, source: "./a.ts", typeOnly: false, bindings: [], line: 1 },
    {
      kind: "import" as const,
      source: "react",
      typeOnly: false,
      bindings: [
        { imported: "useState", local: "useState", typeOnly: false },
        { imported: "useEffect", local: "useEffect", typeOnly: false },
      ],
      line: 2,
    },
    { kind: "import" as const, source: "node:fs", typeOnly: false, bindings: [{ imported: "*", local: "fs", typeOnly: false }], line: 3 },
  ];

  assert.deepEqual(
    compareImports(before, after).map((change) => [change.source, change.status, change.addedBindings, change.removedBindings]),
    [
      ["./a.ts", "unchanged", [], []],
      ["react", "changed", ["useEffect"], []],
      ["node:fs", "added", ["* as fs"], []],
      ["lodash", "removed", [], ["_"]],
    ],
  );
});

test("knows languages by extension", () => {
  assert.equal(languageForPath("src/a.ts"), "typescript");
  assert.equal(languageForPath("src/a.d.mts"), "typescript");
  assert.equal(languageForPath("app/Route.tsx"), "tsx");
  assert.equal(languageForPath("index.cjs"), "javascript");
  assert.equal(languageForPath("App.jsx"), "javascript");
  assert.equal(languageForPath("README.md"), null);
  assert.equal(languageForPath("Makefile"), null);
});
