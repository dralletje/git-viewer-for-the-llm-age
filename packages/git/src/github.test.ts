import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGithubRepository } from "#/github.ts";

test("reads the ways people paste a GitHub repository", () => {
  const expected = { owner: "dralletje", name: "nux" };
  assert.deepEqual(parseGithubRepository("dralletje/nux"), expected);
  assert.deepEqual(parseGithubRepository(" https://github.com/dralletje/nux "), expected);
  assert.deepEqual(parseGithubRepository("https://github.com/dralletje/nux.git"), expected);
  assert.deepEqual(parseGithubRepository("github.com/dralletje/nux/tree/main/src"), expected);
  assert.deepEqual(parseGithubRepository("git@github.com:dralletje/nux.git"), expected);
});

test("refuses what isn't a repository", () => {
  assert.equal(parseGithubRepository("nux"), null);
  assert.equal(parseGithubRepository("https://gitlab.com/a/b"), null);
  assert.equal(parseGithubRepository("../etc/passwd"), null);
  assert.equal(parseGithubRepository("owner/.."), null);
  assert.equal(parseGithubRepository("-owner/name"), null);
});
