import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource } from "#/scan.ts";

test("the names a file exports from its own code, not its re-exports", async () => {
  const source = [
    "export function a() {}",
    "export const b = 1, { c, d: [e] } = x;",
    "export class C {}",
    "export enum E {}",
    "const f = 1, h = 2;",
    "export { f as g, h };",
    "export default f;",
    'export { other } from "./other.ts";',
    'export * from "./all.ts";',
  ].join("\n");
  const { localExports } = await scanSource("typescript", source);
  assert.deepEqual(localExports, { values: ["a", "b", "c", "e", "C", "E", "g", "h", "default"], types: [] });
});

test("exported types apart from values", async () => {
  const source = ["export type T = 1;", "export interface I {}", "type U = 2;", "const v = 1;", "export type { U };", "export { type U as W, v };"].join("\n");
  const { localExports } = await scanSource("typescript", source);
  assert.deepEqual(localExports, { values: ["v"], types: ["T", "I", "U", "W"] });
});

test("CommonJS: the names aren't known", async () => {
  assert.equal((await scanSource("javascript", "module.exports = { a: 1 };")).localExports, null);
  assert.equal((await scanSource("javascript", "exports.a = 1;")).localExports, null);
  assert.equal((await scanSource("typescript", "const a = 1;\nexport = a;")).localExports, null);
});
