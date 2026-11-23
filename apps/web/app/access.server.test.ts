import { test } from "node:test";
import assert from "node:assert/strict";

// Read when the module loads: set before importing it.
process.env.ROOM_REPOSITORIES = JSON.stringify([
  { kind: "local", path: "/home/me/repos/shown" },
  { kind: "github", owner: "dralletje", name: "nux" },
]);
const { isAllowed } = await import("#/access.server.ts");
const { repositoryFromParams } = await import("#/repository.server.ts");

test("a room shows exactly the repositories it was started with", () => {
  assert.equal(isAllowed({ kind: "local", path: "/home/me/repos/shown" }), true);
  assert.equal(isAllowed({ kind: "github", owner: "Dralletje", name: "NUX" }), true);

  assert.equal(isAllowed({ kind: "local", path: "/home/me/repos/other" }), false);
  assert.equal(isAllowed({ kind: "local", path: "/home/me/repos/shown/inside" }), false);
  assert.equal(isAllowed({ kind: "local", path: "/home/me/repos" }), false);
  assert.equal(isAllowed({ kind: "github", owner: "dralletje", name: "other" }), false);
  // A GitHub repository with the name of a shown local one is still another one.
  assert.equal(isAllowed({ kind: "github", owner: "local", name: "shown" }), false);
});

test("pages of a repository it doesn't show are as if it didn't exist", () => {
  assert.deepEqual(repositoryFromParams("local", "/home/me/repos/shown"), { kind: "local", path: "/home/me/repos/shown" });
  assert.equal(repositoryFromParams("local", "/home/me/repos/other"), null);
  assert.equal(repositoryFromParams("local", "/etc"), null);
  assert.equal(repositoryFromParams("someone", "else"), null);
});
