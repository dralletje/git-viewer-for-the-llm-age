import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeSource } from "#/analyze.ts";
import { compareModules } from "#/compare-modules.ts";

const show = (entry: { name: string; kind: string; typeOnly: boolean; signature: string | null }) =>
  `${entry.kind} ${entry.name}${entry.typeOnly ? " (type)" : ""}${entry.signature === null ? "" : ` :: ${entry.signature}`}`;

test("finds every kind of ESM export in TypeScript", async () => {
  const source = [
    "export function greet<T>(name: string,",
    "  times = 1): T { return null as T; }",
    "export async function* stream() {}",
    "export class Store extends Base<State> implements Saveable {}",
    "export abstract class Shape {}",
    "export const a = 1, { b, c: renamed } = obj, [d] = list;",
    "export let typed: Map<string, number> = new Map();",
    "export interface Props { name: string }",
    "export type Id = string;",
    "export enum Color { Red }",
    "export namespace Space {}",
    "export declare function ambient(): void;",
    "export default function main() {}",
    "const local = 1, other = 2;",
    "export { local, other as alias };",
    "export type { Props as PublicProps };",
    'export { helper } from "./helpers.ts";',
    'export * from "./all.ts";',
    'export * as ns from "./ns.ts";',
  ].join("\n");

  const { exports } = await analyzeSource("typescript", source);
  assert.deepEqual(exports.map(show), [
    "function greet :: <T>(name: string, times = 1): T",
    "function stream :: ()",
    "class Store :: extends Base<State> implements Saveable",
    "class Shape",
    "variable a",
    "variable b",
    "variable renamed",
    "variable d",
    "variable typed :: : Map<string, number>",
    "interface Props (type) :: interface Props { name: string }",
    "type Id (type) :: type Id = string;",
    "enum Color :: enum Color { Red }",
    "namespace Space",
    "function ambient :: (): void",
    "function default :: ()",
    "local local",
    "local alias",
    "local PublicProps (type) :: interface Props { name: string }",
    "re-export helper :: ./helpers.ts",
    "re-export * :: ./all.ts",
    "re-export ns :: ./ns.ts",
  ]);
});

test("export default of an expression, and TypeScript's export =", async () => {
  const esm = await analyzeSource("tsx", "export default () => <div />;\n");
  assert.deepEqual(esm.exports.map(show), ["value default"]);
  const assign = await analyzeSource("typescript", "export = Thing;\n");
  assert.deepEqual(assign.exports.map(show), ["value default"]);
});

test("CommonJS exports at the top level", async () => {
  const { exports } = await analyzeSource(
    "javascript",
    ["module.exports = factory;", "module.exports.extra = 1;", "exports.helper = () => {};", "function f() { exports.inner = 1; }"].join("\n"),
  );
  assert.deepEqual(exports.map(show), ["commonjs default", "commonjs extra", "commonjs helper"]);
});


async function compare(before: Array<string>, after: Array<string>) {
  const old = await analyzeSource("typescript", before.join("\n"));
  const now = await analyzeSource("typescript", after.join("\n"));
  return compareModules(old.topLevel, now.topLevel);
}

test("an export changes when anything in its own code does: value, body, signature", async () => {
  const changes = await compare(
    [
      "export const x = 1;",
      "export const handler = (a: string) => { return a; };",
      "export function widen(a: string) {}",
      "export function same(a: string) { return a; }",
      "export type Shape = { x: number };",
      "export const gone = 1;",
    ],
    [
      "export const x = 2;",
      "export const handler = (a: string) => { return a.trim(); };",
      "export function widen(a: string | number) {}",
      "export function same(a: string) { return a; }",
      "export type Shape = { x: number; y: number };",
      "export const added = 2;",
    ],
  );

  assert.deepEqual(
    changes.exports.map((change) => [change.name, change.status, change.signatureChanged]),
    [
      ["x", "changed", false],
      ["handler", "changed", false],
      ["widen", "changed", true],
      ["same", "unchanged", false],
      ["Shape", "changed", true],
      ["added", "added", false],
      ["gone", "removed", false],
    ],
  );
});

test("formatting alone is no change: whitespace, comments, semicolons, trailing commas", async () => {
  const changes = await compare(
    ["export function f(a: string, b: number) { return call(a, b); }", "export const list = [1, 2];"],
    [
      "// A comment now.",
      "export function f(",
      "  a: string,",
      "  b: number,",
      ") {",
      "  return call(a, b)",
      "}",
      "export const list = [",
      "  1,",
      "  2,",
      "]",
    ],
  );
  assert.deepEqual(changes.exports.map((change) => [change.name, change.status]), [["f", "unchanged"], ["list", "unchanged"]]);
});

test("an export is affected through the top-level code it uses, with the path", async () => {
  const changes = await compare(
    [
      'import { round } from "./math.ts";',
      "const rate = 0.1;",
      "function applyDiscount(price: number) { return round(price * (1 - rate)); }",
      "export function checkout(price: number) { return applyDiscount(price); }",
      "export function untouched() { return 1; }",
      "export { applyDiscount as discount };",
    ],
    [
      'import { round } from "./math.ts";',
      "const rate = 0.2;",
      "function applyDiscount(price: number) { return round(price * (1 - rate)); }",
      "export function checkout(price: number) { return applyDiscount(price); }",
      "export function untouched() { return 1; }",
      "export { applyDiscount as discount };",
    ],
  );

  assert.deepEqual(
    changes.exports.map((change) => [change.name, change.status, change.via]),
    [
      ["checkout", "affected", ["applyDiscount", "rate"]],
      ["untouched", "unchanged", []],
      ["discount", "affected", ["rate"]],
    ],
  );
});

test("a changed import flows to the exports that use it", async () => {
  const changes = await compare(
    ['import { round } from "./math.ts";', "export const total = (n: number) => round(n);"],
    ['import { round } from "./rounding.ts";', "export const total = (n: number) => round(n);"],
  );
  assert.deepEqual(changes.exports.map((change) => [change.name, change.status, change.via]), [["total", "affected", ["round"]]]);
});

test("changes no export reaches, and changed top-level code", async () => {
  const changes = await compare(
    ["export function used() { return 1; }", 'console.log("start");'],
    [
      'import { unusedThing } from "./x.ts";',
      "function helperNobodyCalls() { return 2; }",
      "function setup() {}",
      "export function used() { return 1; }",
      'console.log("start");',
      "setup();",
    ],
  );
  assert.deepEqual(changes.unreachable.map((unit) => [unit.label, unit.kind]), [["unusedThing", "import"], ["helperNobodyCalls", "declaration"]]);
  // setup() runs on import, so setup itself is reachable; its call is new top-level code.
  assert.deepEqual(changes.statements.map((unit) => unit.label), ["line 6"]);
});

test("a file without exports reports no unreachable code", async () => {
  const changes = await compare(['test("a", () => {});'], ["function helper() {}", 'test("a", () => {});']);
  assert.deepEqual(changes.unreachable, []);
});
