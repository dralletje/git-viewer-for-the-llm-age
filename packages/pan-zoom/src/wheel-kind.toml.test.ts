import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toml_test, type TomlValue } from "@dral/toml-tests";
import { wheelKind, type WheelSample } from "#/wheel-kind.ts";

/** A wheel event (see wheel-kind.toml): what it guesses sent it. */
function kind(input: TomlValue): TomlValue {
  return wheelKind(input as WheelSample);
}

const source = new URL("./wheel-kind.toml", import.meta.url);
toml_test(
  await readFile(source, "utf-8"),
  kind,
  {
    describe,
    it,
    equal: (actual, expected) => assert.deepStrictEqual(actual, expected),
  },
  "wheel-kind.toml",
);
